# analyzer.py — Video analysis engine for the wedding culling tool.
#
# Processes video files entirely in-place (no copying).
# Uses PyAV for fast keyframe-only extraction, OpenCV for quality metrics,
# PySceneDetect for scene counting, and imagehash for duplicate detection.
# Heavy CPU work runs in a thread-pool executor so FastAPI stays responsive.

from __future__ import annotations

import logging
import os
import re
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import av
import cv2
import imagehash
import numpy as np
from PIL import Image

from models import (
    AnalysisJob,
    ClipReview,
    ClipScore,
    CullPolicy,
    CullReason,
    CullStats,
    JobStatus,
)

logger = logging.getLogger(__name__)

# ─────────────────────────── Constants ──────────────────────────────────────

# All extensions the engine will pick up recursively
SUPPORTED_EXTENSIONS = {
    ".mp4", ".mov", ".mts", ".m2ts", ".mxf", ".avi", ".r3d", ".braw",
}

# Extract one keyframe every N seconds (never decode full stream)
KEYFRAME_INTERVAL_SEC = 2.0

# Normalisation denominators (per spec)
BLUR_NORM_DIVISOR = 100.0         # Laplacian variance at which blur_score hits 0
SHAKE_NORM_DIVISOR = 15.0         # mean optical-flow magnitude that maps to score=1

# Exposure thresholds (mean pixel brightness)
EXPOSURE_LOW = 30
EXPOSURE_HIGH = 220

# Duplicate hamming distance cutoff
DUPLICATE_HASH_DISTANCE = 8

# Thumbnail output root (per-job sub-dirs created on demand)
THUMBNAILS_ROOT = Path("/tmp/culling-thumbs")

# Parallelism — keep modest so HDD I/O doesn't thrash and 8GB Macs don't swap
MAX_WORKERS = 2

# Toggle the heavy second-pass scene detection. Off by default — saves ~30–40%
# wall time on M1 Air / 8GB; scene_count isn't used to drive any decision.
ENABLE_SCENE_DETECTION = False


# ─────────────────────────── Segment classification ─────────────────────────

# (pattern, segment_name) — patterns are compiled from the spec's regex hints
_SEGMENT_RULES: List[Tuple[re.Pattern, str]] = [
    (re.compile(r"first.?look",      re.I), "First Look"),
    (re.compile(r"first.?dance",     re.I), "First Dance"),
    (re.compile(r"groom(?:s?men)?",  re.I), "Groomsmen"),
    (re.compile(r"groomsman",        re.I), "Groomsmen"),
    (re.compile(r"bride|bridesmaid", re.I), "Bride Getting Ready"),
    (re.compile(r"ceremony|vow|ring|kiss", re.I), "Ceremony"),
    (re.compile(r"drone|aerial|dji", re.I), "Drone"),
    (re.compile(r"reception|cocktail|dinner", re.I), "Cocktail"),
    (re.compile(r"toast|speech",     re.I), "Toasts"),
]

def classify_segment(file_path: str) -> str:
    """
    Rule-based segment label derived from the file's full path (filename +
    parent folder names).  Returns a human-readable segment string.
    """
    # Combine all path components into one searchable string
    searchable = " ".join(Path(file_path).parts)

    for pattern, label in _SEGMENT_RULES:
        if pattern.search(searchable):
            return label

    return "Backup"


# ─────────────────────────── Keyframe extraction ────────────────────────────

def extract_keyframes(
    file_path: str,
    interval_sec: float = KEYFRAME_INTERVAL_SEC,
) -> List[np.ndarray]:
    """
    Extract one keyframe per `interval_sec` using PyAV with skip_frame=NONREF.
    Returns BGR numpy arrays.  Never decodes the full stream.
    """
    frames: List[np.ndarray] = []
    try:
        container = av.open(file_path)
        video_stream = next(
            (s for s in container.streams if s.type == "video"), None
        )
        if video_stream is None:
            logger.warning("No video stream in %s", file_path)
            return frames

        video_stream.codec_context.skip_frame = "NONREF"
        last_pts_sec: float = -interval_sec  # ensure first frame is captured

        for packet in container.demux(video_stream):
            for frame in packet.decode():
                if frame.pts is None:
                    continue
                pts_sec = float(frame.pts * video_stream.time_base)
                if pts_sec - last_pts_sec >= interval_sec:
                    frames.append(frame.to_ndarray(format="bgr24"))
                    last_pts_sec = pts_sec

        container.close()
    except Exception as exc:  # noqa: BLE001
        logger.error("Keyframe extraction failed for %s: %s", file_path, exc)

    return frames


def get_duration_sec(file_path: str) -> float:
    """Return clip duration in seconds without decoding frames."""
    try:
        container = av.open(file_path)
        duration = (
            float(container.duration) / av.time_base
            if container.duration
            else 0.0
        )
        container.close()
        return duration
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not read duration for %s: %s", file_path, exc)
        return 0.0


# ─────────────────────────── Quality metrics ────────────────────────────────

def compute_blur_score(frames: List[np.ndarray]) -> float:
    """
    Laplacian variance per frame, averaged.
    score = max(0, 1 - (lap_var / 100))  — per spec.
    Returns 0 (sharp) to 1 (blurry).
    """
    if not frames:
        return 0.0

    variances: List[float] = []
    for frame in frames:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        variances.append(float(cv2.Laplacian(gray, cv2.CV_64F).var()))

    mean_var = float(np.mean(variances))
    score = max(0.0, 1.0 - (mean_var / BLUR_NORM_DIVISOR))
    return round(min(score, 1.0), 4)


def compute_shake_score(frames: List[np.ndarray]) -> float:
    """
    Farneback optical flow between consecutive keyframes.
    score = min(1, mean_magnitude / 15)  — per spec.
    Returns 0 (stable) to 1 (very shaky).
    """
    if len(frames) < 2:
        return 0.0

    magnitudes: List[float] = []
    prev_gray = cv2.cvtColor(frames[0], cv2.COLOR_BGR2GRAY)

    for frame in frames[1:]:
        curr_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        flow = cv2.calcOpticalFlowFarneback(
            prev_gray, curr_gray,
            None,
            pyr_scale=0.5, levels=3, winsize=15,
            iterations=3, poly_n=5, poly_sigma=1.2, flags=0,
        )
        mag, _ = cv2.cartToPolar(flow[..., 0], flow[..., 1])
        magnitudes.append(float(mag.mean()))
        prev_gray = curr_gray

    if not magnitudes:
        return 0.0

    mean_mag = float(np.mean(magnitudes))
    return round(min(mean_mag / SHAKE_NORM_DIVISOR, 1.0), 4)


def compute_exposure_ok(frames: List[np.ndarray]) -> bool:
    """
    Returns True when mean pixel brightness is within [30, 220].
    Outside that range = underexposed or overexposed.
    """
    if not frames:
        return True

    brightnesses: List[float] = []
    for frame in frames:
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        brightnesses.append(float(gray.mean()))

    mean_b = float(np.mean(brightnesses))
    return EXPOSURE_LOW <= mean_b <= EXPOSURE_HIGH


# ─────────────────────────── Scene detection ────────────────────────────────

def count_scenes(file_path: str) -> int:
    """
    Use PySceneDetect AdaptiveDetector to count scene boundaries.
    Returns the number of detected scenes (minimum 1).
    Falls back to 1 on any error.
    """
    try:
        from scenedetect import open_video, SceneManager
        from scenedetect.detectors import AdaptiveDetector

        video = open_video(file_path)
        scene_manager = SceneManager()
        scene_manager.add_detector(AdaptiveDetector())
        scene_manager.detect_scenes(video, show_progress=False)
        scenes = scene_manager.get_scene_list()
        return max(1, len(scenes))
    except Exception as exc:  # noqa: BLE001
        logger.warning("Scene detection failed for %s: %s", file_path, exc)
        return 1


# ─────────────────────────── Duplicate detection ────────────────────────────

def compute_dhash(frame: np.ndarray) -> imagehash.ImageHash:
    """dHash from a BGR numpy frame."""
    pil_img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
    return imagehash.dhash(pil_img)


# ─────────────────────────── Auto-cull pass ────────────────────────────────
#
# This is the actual culling. Without this, every clip starts at approved=False
# and the user has to click through 500+ items by hand. With it, the analyzer
# decides — clips above quality thresholds approve automatically, clearly bad
# ones get rejected with a reason, and within each group of duplicates only
# the best take survives.
#
# Reasons (highest priority first):
#   too_short      → duration < min_duration_sec (likely accidental hits)
#   bad_exposure   → exposure_ok == False
#   too_shaky      → shake_score > shake_threshold
#   too_blurry     → blur_score > blur_threshold
#   duplicate      → another clip is the "best take" in its dedup group

def _quality_score(clip: ClipReview) -> float:
    """
    Lower = better. Used to pick the best take inside a duplicate group.
    Combines shake + blur + a small penalty for short clips.
    """
    s = clip.scores.shake_score + clip.scores.blur_score
    if clip.scores.duration_sec < 3.0:
        s += 0.1  # mild penalty for very short clips
    return s


def apply_cull(clips: List[ClipReview], policy: CullPolicy) -> CullStats:
    """
    Mutate `clips` in place: set `approved` and `cull_reason` per the policy.
    Returns aggregate stats for the run.

    Order of decisions per clip (first-match wins):
      1. duration < min_duration_sec → too_short
      2. exposure not ok (when require_exposure_ok) → bad_exposure
      3. shake_score > threshold → too_shaky
      4. blur_score > threshold → too_blurry
      5. duplicate of another clip's best-take winner → duplicate
      6. otherwise → approved
    """
    stats = CullStats(total=len(clips))

    if not policy.enabled:
        # Caller wants us to skip — leave whatever was there.
        for clip in clips:
            if clip.cull_reason is None:
                clip.cull_reason = CullReason.approved.value
            if clip.cull_reason == CullReason.approved.value:
                clip.approved = True
                stats.approved += 1
        return stats

    # ── Pass 1: per-clip quality gates ────────────────────────────────────
    for clip in clips:
        reason: Optional[CullReason] = None

        if clip.scores.duration_sec < policy.min_duration_sec:
            reason = CullReason.too_short
        elif policy.require_exposure_ok and not clip.scores.exposure_ok:
            reason = CullReason.bad_exposure
        elif clip.scores.shake_score > policy.shake_threshold:
            reason = CullReason.too_shaky
        elif clip.scores.blur_score > policy.blur_threshold:
            reason = CullReason.too_blurry

        if reason is not None:
            clip.approved = False
            clip.cull_reason = reason.value
        else:
            # Tentatively approve; duplicate pass below may revoke.
            clip.approved = True
            clip.cull_reason = CullReason.approved.value

    # ── Pass 2: duplicate groups — keep best take only ────────────────────
    if policy.reject_duplicates:
        # A duplicate group is the original (None duplicate_of) plus all
        # clips whose duplicate_of points at the same original.
        groups: Dict[str, List[ClipReview]] = {}
        approved_by_id = {c.clip_id: c for c in clips if c.approved}
        for clip in clips:
            if not clip.approved:
                continue
            head_id = clip.scores.duplicate_of or clip.clip_id
            groups.setdefault(head_id, []).append(clip)

        for head_id, group in groups.items():
            if len(group) <= 1:
                continue
            # Best = lowest quality_score (lowest combined shake+blur).
            best = min(group, key=_quality_score)
            for clip in group:
                if clip is best:
                    continue
                clip.approved = False
                clip.cull_reason = CullReason.duplicate.value

    # ── Tally stats ────────────────────────────────────────────────────────
    for clip in clips:
        r = clip.cull_reason
        if r == CullReason.approved.value:
            stats.approved += 1
        elif r == CullReason.too_short.value:
            stats.rejected_short += 1
        elif r == CullReason.too_shaky.value:
            stats.rejected_shaky += 1
        elif r == CullReason.too_blurry.value:
            stats.rejected_blurry += 1
        elif r == CullReason.bad_exposure.value:
            stats.rejected_exposure += 1
        elif r == CullReason.duplicate.value:
            stats.rejected_duplicate += 1

    return stats


def find_duplicates(
    clip_ids: List[str],
    hashes: Dict[str, imagehash.ImageHash],
) -> Dict[str, Optional[str]]:
    """
    Compare all hashes pairwise.
    Returns {clip_id: original_clip_id_or_None}.
    First occurrence in the list is considered the original.
    """
    duplicate_of: Dict[str, Optional[str]] = {cid: None for cid in clip_ids}
    seen: List[Tuple[str, imagehash.ImageHash]] = []

    for cid in clip_ids:
        h = hashes.get(cid)
        if h is None:
            continue
        matched = False
        for seen_id, seen_hash in seen:
            if (h - seen_hash) < DUPLICATE_HASH_DISTANCE:
                duplicate_of[cid] = seen_id
                matched = True
                break
        if not matched:
            seen.append((cid, h))

    return duplicate_of


# ─────────────────────────── Thumbnail ──────────────────────────────────────

def save_thumbnail(frame: np.ndarray, job_id: str, clip_id: str) -> str:
    """Save a 320×180 JPEG thumbnail. Returns the absolute file path."""
    out_dir = THUMBNAILS_ROOT / job_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{clip_id}.jpg"
    thumb = cv2.resize(frame, (320, 180), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(out_path), thumb, [cv2.IMWRITE_JPEG_QUALITY, 80])
    return str(out_path)


# ─────────────────────────── Per-clip pipeline ──────────────────────────────

def analyze_single_clip(file_path: str, job_id: str) -> ClipReview:
    """
    Full analysis pipeline for one video file.
    Designed to be called inside a thread-pool worker.
    """
    clip_id = str(uuid.uuid4())
    filename = Path(file_path).name

    logger.info("Analyzing: %s", filename)

    duration = get_duration_sec(file_path)
    frames = extract_keyframes(file_path, KEYFRAME_INTERVAL_SEC)

    blur_score = compute_blur_score(frames)
    shake_score = compute_shake_score(frames)
    exposure_ok = compute_exposure_ok(frames)
    scene_count = count_scenes(file_path) if ENABLE_SCENE_DETECTION else 1
    suggested_segment = classify_segment(file_path)

    # Middle keyframe → thumbnail
    thumbnail_path: Optional[str] = None
    if frames:
        mid_frame = frames[len(frames) // 2]
        thumbnail_path = save_thumbnail(mid_frame, job_id, clip_id)

    scores = ClipScore(
        path=file_path,
        duration_sec=round(duration, 2),
        shake_score=shake_score,
        blur_score=blur_score,
        exposure_ok=exposure_ok,
        duplicate_of=None,   # filled in after all clips are analyzed
        scene_count=scene_count,
    )

    return ClipReview(
        clip_id=clip_id,
        path=file_path,
        filename=filename,
        thumbnail_path=thumbnail_path,
        scores=scores,
        suggested_segment=suggested_segment,
        approved=False,
        segment_label=suggested_segment,
    )


# ─────────────────────────── Job runner ─────────────────────────────────────

def collect_video_files(folder_path: str) -> List[str]:
    """Recursively collect all supported video files under folder_path."""
    results: List[str] = []
    for root, _dirs, files in os.walk(folder_path):
        for fname in sorted(files):
            if Path(fname).suffix.lower() in SUPPORTED_EXTENSIONS:
                results.append(os.path.join(root, fname))
    return results


def analyze_folder(
    job_id: str,
    folder_path: str,
    jobs_store: Dict[str, AnalysisJob],
    included_files: Optional[List[str]] = None,
    cull_policy: Optional[CullPolicy] = None,
) -> None:
    """
    Entry point called from the FastAPI background thread.
    Mutates the AnalysisJob in jobs_store throughout processing.

    If `included_files` is provided, only those absolute paths are analyzed
    (filtered to ones living under `folder_path` and matching supported types).
    """
    job = jobs_store[job_id]
    job.status = JobStatus.running
    jobs_store[job_id] = job

    try:
        if included_files:
            folder_resolved = str(Path(folder_path).resolve())
            video_files = [
                fp for fp in included_files
                if Path(fp).suffix.lower() in SUPPORTED_EXTENSIONS
                and str(Path(fp).resolve()).startswith(folder_resolved)
                and Path(fp).is_file()
            ]
        else:
            video_files = collect_video_files(folder_path)
        total = len(video_files)

        if total == 0:
            logger.warning("No video files found in %s", folder_path)
            job.status = JobStatus.done
            job.progress = 100.0
            jobs_store[job_id] = job
            return

        logger.info("Found %d video files in %s", total, folder_path)

        clip_results: List[ClipReview] = []

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            future_to_path = {
                executor.submit(analyze_single_clip, fp, job_id): fp
                for fp in video_files
            }
            completed = 0
            for future in as_completed(future_to_path):
                fp = future_to_path[future]
                try:
                    result = future.result()
                    clip_results.append(result)
                except Exception as exc:  # noqa: BLE001
                    logger.error("Failed to analyze %s: %s", fp, exc)
                    # Stub entry so the clip still appears in the review UI
                    stub_id = str(uuid.uuid4())
                    clip_results.append(
                        ClipReview(
                            clip_id=stub_id,
                            path=fp,
                            filename=Path(fp).name,
                            scores=ClipScore(path=fp),
                            suggested_segment="Backup",
                            segment_label="Backup",
                        )
                    )
                finally:
                    completed += 1
                    pct = round((completed / total) * 95.0, 1)  # leave 5% for dup pass
                    job.progress = pct
                    jobs_store[job_id] = job
                    logger.info(
                        "Done %d/%d (%.1f%%) — %s",
                        completed, total, pct, Path(fp).name,
                    )

        # ── Duplicate detection pass ──────────────────────────────────────
        logger.info("Running duplicate detection across %d clips…", len(clip_results))
        job.progress = 96.0
        jobs_store[job_id] = job
        representative_hashes: Dict[str, imagehash.ImageHash] = {}
        for clip in clip_results:
            try:
                frames = extract_keyframes(clip.path, interval_sec=5.0)
                if frames:
                    representative_hashes[clip.clip_id] = compute_dhash(
                        frames[len(frames) // 2]
                    )
            except Exception as exc:  # noqa: BLE001
                logger.warning("Hash failed for %s: %s", clip.path, exc)

        dup_map = find_duplicates(
            [c.clip_id for c in clip_results],
            representative_hashes,
        )
        dup_count = 0
        for clip in clip_results:
            dup_target = dup_map.get(clip.clip_id)
            if dup_target is not None:
                clip.scores.duplicate_of = dup_target
                dup_count += 1
        logger.info("Found %d duplicate(s)", dup_count)

        # ── Auto-cull pass ────────────────────────────────────────────────
        # This is what turns "I have scores" into "I have a curated edit".
        # Apply the policy now and persist stats so the UI can show what
        # got rejected and why.
        policy = cull_policy or job.cull_policy or CullPolicy()
        logger.info(
            "Auto-culling: shake>%.2f, blur>%.2f, dur<%.1fs, dups=%s",
            policy.shake_threshold, policy.blur_threshold,
            policy.min_duration_sec, policy.reject_duplicates,
        )
        stats = apply_cull(clip_results, policy)
        logger.info(
            "Cull result — total=%d approved=%d rejected: short=%d shaky=%d "
            "blurry=%d exposure=%d dup=%d",
            stats.total, stats.approved, stats.rejected_short,
            stats.rejected_shaky, stats.rejected_blurry,
            stats.rejected_exposure, stats.rejected_duplicate,
        )

        job.clips = clip_results
        job.cull_policy = policy
        job.cull_stats = stats
        job.status = JobStatus.done
        job.progress = 100.0
        jobs_store[job_id] = job
        logger.info(
            "Done — %d clip(s) processed; %d approved, %d rejected",
            len(clip_results), stats.approved, stats.total - stats.approved,
        )

    except Exception as exc:  # noqa: BLE001
        logger.exception("Job %s failed: %s", job_id, exc)
        job.status = JobStatus.failed
        job.error = str(exc)
        jobs_store[job_id] = job
