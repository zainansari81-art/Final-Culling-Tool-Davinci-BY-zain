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
    SubClipSegment,
)
# Lazy import to avoid circular dependency on cold start
try:
    from ai_grader import grade_all_clips_parallel
except Exception:  # noqa: BLE001
    grade_all_clips_parallel = None  # type: ignore

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


def extract_keyframes_with_ts(
    file_path: str,
    interval_sec: float,
) -> List[Tuple[float, np.ndarray]]:
    """
    Like extract_keyframes, but returns (timestamp_sec, frame) tuples so we
    can do windowed analysis. Still keyframe-only via skip_frame=NONREF.
    """
    out: List[Tuple[float, np.ndarray]] = []
    try:
        container = av.open(file_path)
        video_stream = next((s for s in container.streams if s.type == "video"), None)
        if video_stream is None:
            return out
        video_stream.codec_context.skip_frame = "NONREF"
        last_pts_sec = -interval_sec
        for packet in container.demux(video_stream):
            for frame in packet.decode():
                if frame.pts is None:
                    continue
                pts_sec = float(frame.pts * video_stream.time_base)
                if pts_sec - last_pts_sec >= interval_sec:
                    out.append((pts_sec, frame.to_ndarray(format="bgr24")))
                    last_pts_sec = pts_sec
        container.close()
    except Exception as exc:  # noqa: BLE001
        logger.error("Dense keyframe extraction failed for %s: %s", file_path, exc)
    return out


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


# ─────────────────────────── Deep per-clip analysis ────────────────────────
#
# Instead of one score per clip (the average across keyframes), score every
# rolling window inside the clip — typically 5-second windows advancing by
# 1 second. Then merge consecutive passing windows into "usable segments"
# so a 5-minute clip with 30 great seconds + 4 bad minutes can yield ONE
# 30-second sub-clip on the timeline instead of all-or-nothing.

def _frame_blur(gray: np.ndarray) -> float:
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())

def _frame_brightness(gray: np.ndarray) -> float:
    return float(gray.mean())


# ─────────────────────────── Face detection ────────────────────────────────
# OpenCV ships a Haar cascade for frontal faces. Loaded lazily and cached.
# Fast enough to run on every sampled frame in deep mode (~1-3ms per frame
# on M1). Used to flag segments containing recognizable subjects, which
# distinguishes a hero shot from filler footage of decor or floors.

_face_cascade = None

def _get_face_cascade() -> Optional["cv2.CascadeClassifier"]:
    global _face_cascade
    if _face_cascade is None:
        try:
            cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
            _face_cascade = cv2.CascadeClassifier(cascade_path)
            if _face_cascade.empty():
                logger.warning("Face cascade loaded empty — face detection disabled")
                _face_cascade = None
        except Exception as exc:  # noqa: BLE001
            logger.warning("Face cascade unavailable: %s", exc)
            _face_cascade = None
    return _face_cascade


def _detect_faces(gray: np.ndarray) -> int:
    """Returns the number of faces detected. 0 if none or cascade unavailable."""
    cascade = _get_face_cascade()
    if cascade is None:
        return 0
    try:
        # Downsample to ~640px wide for speed; faces still detect reliably
        h, w = gray.shape
        if w > 640:
            scale = 640.0 / w
            gray = cv2.resize(gray, (640, int(h * scale)))
        faces = cascade.detectMultiScale(gray, scaleFactor=1.2, minNeighbors=4, minSize=(40, 40))
        return len(faces)
    except Exception:  # noqa: BLE001
        return 0


def _frame_richness(frame_bgr: np.ndarray) -> Tuple[float, float]:
    """
    Returns (saturation_mean_norm, contrast_norm) for a BGR frame.
    Used to recognize quality B-roll (decor, rings, drone, lighting) where
    a face cascade returns nothing but the shot is visually rich.

    saturation: HSV S channel mean / 255 (0=grey, 1=very saturated)
    contrast:   grayscale stddev / 64 (clamped) — more spread = more interesting
    """
    hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
    sat_mean = float(hsv[..., 1].mean()) / 255.0
    gray = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2GRAY)
    contrast = min(float(gray.std()) / 64.0, 1.0)
    return sat_mean, contrast


def _highlight_quality(
    avg_blur_var: float,        # raw Laplacian variance (higher = sharper)
    avg_flow: float,            # raw mean optical-flow magnitude (lower = stabler)
    avg_bright: float,          # raw mean brightness (130 ideal)
    avg_saturation: float,      # 0..1, higher = more colorful (b-roll signal)
    avg_contrast: float,        # 0..1, higher = more visual interest
    face_present: bool,
    policy: CullPolicy,
) -> float:
    """
    Compose a 0..1 highlight quality score that rewards BOTH:
      - hero people-shots (sharpness + stability + exposure + face)
      - b-roll (sharpness + stability + exposure + visual richness)

    No face? That's fine — a steady, sharp, well-exposed, color-rich shot
    of rings/decor/drone aerials still scores highly.

    Weights:
      stability   30%  — handheld must not jitter
      sharpness   28%  — has to be in focus
      exposure    14%  — well-lit, not blown out
      richness    18%  — saturation + contrast (b-roll lifeline)
      face bonus  +highlight_face_bonus on top
    """
    shake_score = min(avg_flow / SHAKE_NORM_DIVISOR, 1.0)
    stability = 1.0 - shake_score

    # Sharpness: variance of 100+ is clearly sharp; ramp from ~25 to ~150
    sharpness = min(max((avg_blur_var - 25.0) / 125.0, 0.0), 1.0)

    # Exposure: peak at 130, drop toward 0/255 (40..220 inclusive = tolerance zone)
    ideal = 130.0
    half_range = 90.0
    exposure_q = max(0.0, 1.0 - abs(avg_bright - ideal) / half_range)

    # Visual richness — average of saturation + contrast.
    # A grey concrete wall = 0, a sunset over flowers = ~0.85.
    richness = max(0.0, min(1.0, 0.55 * avg_saturation + 0.45 * avg_contrast))

    base = (
        0.30 * stability
        + 0.28 * sharpness
        + 0.14 * exposure_q
        + 0.18 * richness
        # remaining 10% lives in the face bonus when present
    )

    if face_present:
        base = min(1.0, base + policy.highlight_face_bonus)

    return round(min(max(base, 0.0), 1.0), 4)


def _flow_mag(prev_gray: np.ndarray, curr_gray: np.ndarray) -> float:
    flow = cv2.calcOpticalFlowFarneback(
        prev_gray, curr_gray, None,
        pyr_scale=0.5, levels=3, winsize=15,
        iterations=3, poly_n=5, poly_sigma=1.2, flags=0,
    )
    mag, _ = cv2.cartToPolar(flow[..., 0], flow[..., 1])
    return float(mag.mean())


def analyze_clip_deep(
    file_path: str,
    policy: CullPolicy,
) -> Tuple[ClipScore, List[SubClipSegment], Optional[np.ndarray], List[Tuple[float, "imagehash.ImageHash"]]]:
    """
    Deep per-clip analysis. Returns:
      - clip_score: aggregate scores across the whole clip
      - sub_segments: usable windows (after thresholding + merging)
      - middle_frame: middle keyframe for the thumbnail (BGR ndarray) or None
      - coverage_hashes: list of (timestamp_sec, dhash) for cross-clip clustering

    We extract frames at sub_step_sec density (denser than the shallow path),
    compute per-frame blur/brightness, and per-pair optical flow magnitude.
    Then we slide a sub_window_sec window and produce window-level scores.
    """
    duration = get_duration_sec(file_path)
    frames_ts = extract_keyframes_with_ts(file_path, interval_sec=policy.sub_step_sec)

    if not frames_ts:
        return (
            ClipScore(path=file_path, duration_sec=round(duration, 2)),
            [],
            None,
            [],
        )

    # Per-frame metrics + grayscale cache
    grays: List[np.ndarray] = [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for _, f in frames_ts]
    blurs_var: List[float] = [_frame_blur(g) for g in grays]
    brights: List[float] = [_frame_brightness(g) for g in grays]

    # Per-frame face count + visual richness (only when highlight detection is on,
    # since these add cost). Richness = saturation + contrast — recognizes great
    # b-roll (rings, decor, drone aerials, dance lights) without faces.
    face_counts: List[int] = [0] * len(grays)
    sat_norms: List[float] = [0.0] * len(grays)
    contrast_norms: List[float] = [0.0] * len(grays)
    if policy.detect_highlights:
        for i, g in enumerate(grays):
            face_counts[i] = _detect_faces(g)
            sat, ctr = _frame_richness(frames_ts[i][1])
            sat_norms[i] = sat
            contrast_norms[i] = ctr

    # Per-pair flow magnitudes (between consecutive sampled frames)
    flow_mags: List[float] = [0.0]
    for i in range(1, len(grays)):
        flow_mags.append(_flow_mag(grays[i - 1], grays[i]))

    # Coverage hashes — sub-sample to coverage_hash_interval_sec.
    coverage_hashes: List[Tuple[float, "imagehash.ImageHash"]] = []
    last_hash_ts = -policy.coverage_hash_interval_sec
    for (ts, frame) in frames_ts:
        if ts - last_hash_ts >= policy.coverage_hash_interval_sec:
            try:
                pil = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
                coverage_hashes.append((ts, imagehash.dhash(pil)))
                last_hash_ts = ts
            except Exception:
                pass

    # ── Sliding window scoring ───────────────────────────────────────────
    # Window covers [t, t + sub_window_sec). Frames inside contribute their
    # blur, brightness, and (between consecutive frames) flow magnitude.
    sub_segments: List[SubClipSegment] = []
    if duration < 0.5:
        # Too short for windowing; produce a single segment for the whole clip
        avg_blur = float(np.mean(blurs_var)) if blurs_var else 0.0
        avg_flow = float(np.mean([m for m in flow_mags[1:]])) if len(flow_mags) > 1 else 0.0
        avg_bright = float(np.mean(brights)) if brights else 0.0
        sub_segments.append(SubClipSegment(
            start_sec=0.0,
            end_sec=duration,
            duration_sec=duration,
            shake_score=round(min(avg_flow / SHAKE_NORM_DIVISOR, 1.0), 4),
            blur_score=round(max(0.0, 1.0 - avg_blur / BLUR_NORM_DIVISOR), 4),
            exposure_ok=EXPOSURE_LOW <= avg_bright <= EXPOSURE_HIGH,
        ))
    else:
        # Walk windows
        clip_end = max(frames_ts[-1][0], duration)
        t = 0.0
        passing_windows: List[SubClipSegment] = []
        while t < clip_end:
            t_end = t + policy.sub_window_sec
            # Indices of frames inside [t, t_end)
            idxs = [i for i, (ts, _) in enumerate(frames_ts) if t <= ts < t_end]
            if len(idxs) >= 2:
                ws_blur = float(np.mean([blurs_var[i] for i in idxs]))
                ws_bright = float(np.mean([brights[i] for i in idxs]))
                # Flow between frames inside the window — skip the first index (no prior frame)
                window_flows = [flow_mags[i] for i in idxs if i > 0 and (i - 1) in idxs]
                ws_flow = float(np.mean(window_flows)) if window_flows else 0.0
                shake = round(min(ws_flow / SHAKE_NORM_DIVISOR, 1.0), 4)
                blur = round(max(0.0, 1.0 - ws_blur / BLUR_NORM_DIVISOR), 4)
                exp_ok = EXPOSURE_LOW <= ws_bright <= EXPOSURE_HIGH
                passes = (
                    shake <= policy.shake_threshold
                    and blur <= policy.blur_threshold
                    and (exp_ok or not policy.require_exposure_ok)
                )
                if passes:
                    # Highlight metrics for this window
                    window_face_frames = sum(1 for i in idxs if face_counts[i] > 0)
                    face_present = window_face_frames > 0
                    ws_sat = float(np.mean([sat_norms[i] for i in idxs])) if policy.detect_highlights else 0.0
                    ws_contrast = float(np.mean([contrast_norms[i] for i in idxs])) if policy.detect_highlights else 0.0
                    hl_quality = _highlight_quality(
                        avg_blur_var=ws_blur,
                        avg_flow=ws_flow,
                        avg_bright=ws_bright,
                        avg_saturation=ws_sat,
                        avg_contrast=ws_contrast,
                        face_present=face_present,
                        policy=policy,
                    )
                    passing_windows.append(SubClipSegment(
                        start_sec=round(t, 2),
                        end_sec=round(min(t_end, clip_end), 2),
                        duration_sec=round(min(t_end, clip_end) - t, 2),
                        shake_score=shake,
                        blur_score=blur,
                        exposure_ok=exp_ok,
                        highlight_quality=hl_quality,
                        face_frames=window_face_frames,
                    ))
            t += policy.sub_step_sec

        # Merge overlapping/contiguous passing windows into longer segments,
        # then drop ones shorter than sub_min_segment_sec.
        if passing_windows:
            merged: List[SubClipSegment] = [passing_windows[0]]
            for w in passing_windows[1:]:
                last = merged[-1]
                if w.start_sec <= last.end_sec + policy.sub_step_sec * 0.5:
                    new_end = max(last.end_sec, w.end_sec)
                    merged[-1] = SubClipSegment(
                        start_sec=last.start_sec,
                        end_sec=new_end,
                        duration_sec=round(new_end - last.start_sec, 2),
                        shake_score=round((last.shake_score + w.shake_score) / 2, 4),
                        blur_score=round((last.blur_score + w.blur_score) / 2, 4),
                        exposure_ok=last.exposure_ok and w.exposure_ok,
                        # Highlight quality of merged window = max of its parts
                        # (we want the BEST moment in there to drive the highlight grade)
                        highlight_quality=round(max(last.highlight_quality, w.highlight_quality), 4),
                        face_frames=last.face_frames + w.face_frames,
                    )
                else:
                    merged.append(w)
            sub_segments = [s for s in merged if s.duration_sec >= policy.sub_min_segment_sec]

        # ── Highlight gating ────────────────────────────────────────────
        # Mark which segments qualify for the highlight reel.
        if policy.detect_highlights:
            for seg in sub_segments:
                qualifies = (
                    seg.highlight_quality >= policy.highlight_quality_threshold
                    and seg.duration_sec >= policy.highlight_min_duration_sec
                )
                if policy.highlight_require_face and seg.face_frames == 0:
                    qualifies = False
                seg.is_highlight = qualifies

    # Aggregate clip-level scores (still useful for fallback / display)
    avg_blur_var = float(np.mean(blurs_var)) if blurs_var else 0.0
    avg_flow = float(np.mean(flow_mags[1:])) if len(flow_mags) > 1 else 0.0
    mean_bright = float(np.mean(brights)) if brights else 128.0
    clip_score = ClipScore(
        path=file_path,
        duration_sec=round(duration, 2),
        shake_score=round(min(avg_flow / SHAKE_NORM_DIVISOR, 1.0), 4),
        blur_score=round(max(0.0, 1.0 - avg_blur_var / BLUR_NORM_DIVISOR), 4),
        exposure_ok=EXPOSURE_LOW <= mean_bright <= EXPOSURE_HIGH,
        scene_count=1,
        sub_segments=sub_segments,
    )

    middle_frame = frames_ts[len(frames_ts) // 2][1] if frames_ts else None
    return clip_score, sub_segments, middle_frame, coverage_hashes


# ─────────────────────────── Coverage clustering ────────────────────────────
#
# Spingle's secret sauce: identify when multiple clips are different angles of
# the same moment, and pick the best take. We collect a perceptual hash every
# coverage_hash_interval_sec for every clip, then for each pair compute what
# fraction of hashes have a near-match in the other clip. Pairs above the
# overlap threshold are linked; connected components form clusters.

def cluster_by_coverage(
    per_clip_hashes: Dict[str, List[Tuple[float, "imagehash.ImageHash"]]],
    match_distance: int,
    min_overlap: float,
) -> Dict[str, str]:
    """
    Returns {clip_id: cluster_id}. Clips with no overlap get their own cluster id.
    """
    clip_ids = list(per_clip_hashes.keys())
    if not clip_ids:
        return {}

    # Union-find
    parent: Dict[str, str] = {cid: cid for cid in clip_ids}
    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    # Pairwise comparison — for each pair of clips, count matching hashes.
    # A "match" = there exists a hash in B within match_distance of the hash in A.
    for i in range(len(clip_ids)):
        a_id = clip_ids[i]
        a_hashes = per_clip_hashes[a_id]
        if not a_hashes:
            continue
        for j in range(i + 1, len(clip_ids)):
            b_id = clip_ids[j]
            b_hashes = per_clip_hashes[b_id]
            if not b_hashes:
                continue
            # Already in same component? Skip pairwise compute.
            if find(a_id) == find(b_id):
                continue
            matches = 0
            for _, ha in a_hashes:
                for _, hb in b_hashes:
                    if (ha - hb) <= match_distance:
                        matches += 1
                        break
            ratio = matches / max(len(a_hashes), 1)
            if ratio >= min_overlap:
                union(a_id, b_id)

    return {cid: find(cid) for cid in clip_ids}


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
    # Deep mode: a clip approves if it has ANY usable sub-segment passing
    # thresholds. The clip-level average might fail while a 30-second window
    # inside it passes — that 30-second sub-clip is the deliverable.
    for clip in clips:
        reason: Optional[CullReason] = None

        # Hard rejects that apply regardless of mode
        if clip.scores.duration_sec < policy.min_duration_sec:
            reason = CullReason.too_short

        # Deep clips: trust sub_segments if present
        elif clip.scores.sub_segments is not None and len(clip.scores.sub_segments) > 0:
            # At least one usable segment ≥ min_duration → approve
            best_segment_quality = min(
                (s.shake_score + s.blur_score for s in clip.scores.sub_segments),
                default=2.0,
            )
            if best_segment_quality >= 2.0:
                # No segment fits; fall back to the clip's worst-fail reason
                if policy.require_exposure_ok and not clip.scores.exposure_ok:
                    reason = CullReason.bad_exposure
                elif clip.scores.shake_score > policy.shake_threshold:
                    reason = CullReason.too_shaky
                elif clip.scores.blur_score > policy.blur_threshold:
                    reason = CullReason.too_blurry
                else:
                    reason = CullReason.too_blurry  # safety net
        elif clip.scores.sub_segments is not None and len(clip.scores.sub_segments) == 0:
            # Deep mode ran but produced ZERO usable sub-segments → reject
            # using the dominant per-clip failure reason
            if policy.require_exposure_ok and not clip.scores.exposure_ok:
                reason = CullReason.bad_exposure
            elif clip.scores.shake_score > clip.scores.blur_score:
                reason = CullReason.too_shaky
            else:
                reason = CullReason.too_blurry
        else:
            # Shallow mode: clip-level averages drive the decision
            if policy.require_exposure_ok and not clip.scores.exposure_ok:
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

def analyze_single_clip_deep(
    file_path: str,
    job_id: str,
    policy: CullPolicy,
) -> Tuple[ClipReview, List[Tuple[float, "imagehash.ImageHash"]]]:
    """
    Deep version: sliding-window scoring + returns coverage hashes for
    cross-clip clustering (handled later in analyze_folder).
    """
    clip_id = str(uuid.uuid4())
    filename = Path(file_path).name
    logger.info("Deep analyzing: %s", filename)

    score, sub_segments, middle_frame, coverage_hashes = analyze_clip_deep(file_path, policy)

    thumbnail_path: Optional[str] = None
    if middle_frame is not None:
        thumbnail_path = save_thumbnail(middle_frame, job_id, clip_id)

    suggested_segment = classify_segment(file_path)

    review = ClipReview(
        clip_id=clip_id,
        path=file_path,
        filename=filename,
        thumbnail_path=thumbnail_path,
        scores=score,
        suggested_segment=suggested_segment,
        approved=False,
        segment_label=suggested_segment,
    )
    return review, coverage_hashes


def analyze_single_clip(file_path: str, job_id: str) -> ClipReview:
    """
    Shallow per-clip pipeline (one score per clip, fast).
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

        policy_for_run = cull_policy or job.cull_policy or CullPolicy()
        deep = bool(policy_for_run.deep_analysis)
        logger.info(
            "Found %d video files in %s (mode: %s)",
            total, folder_path, "DEEP (sliding window + coverage clustering)" if deep else "shallow",
        )

        clip_results: List[ClipReview] = []
        # In deep mode we collect coverage hashes per clip during the worker pass
        # so we can cluster after all clips finish.
        coverage_hashes_by_clip: Dict[str, List[Tuple[float, "imagehash.ImageHash"]]] = {}

        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
            if deep:
                future_to_path = {
                    executor.submit(analyze_single_clip_deep, fp, job_id, policy_for_run): fp
                    for fp in video_files
                }
            else:
                future_to_path = {
                    executor.submit(analyze_single_clip, fp, job_id): fp
                    for fp in video_files
                }
            completed = 0
            for future in as_completed(future_to_path):
                fp = future_to_path[future]
                try:
                    result = future.result()
                    if deep:
                        review, hashes = result
                        clip_results.append(review)
                        coverage_hashes_by_clip[review.clip_id] = hashes
                    else:
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
                    pct = round((completed / total) * 90.0, 1)  # leave 10% for clustering passes
                    job.progress = pct
                    jobs_store[job_id] = job
                    logger.info(
                        "Done %d/%d (%.1f%%) — %s",
                        completed, total, pct, Path(fp).name,
                    )

        # ── Duplicate / coverage detection pass ──────────────────────────
        if deep and coverage_hashes_by_clip:
            logger.info(
                "Coverage clustering across %d clips (interval=%.1fs, dist≤%d, overlap≥%.0f%%)…",
                len(coverage_hashes_by_clip),
                policy_for_run.coverage_hash_interval_sec,
                policy_for_run.coverage_match_distance,
                100 * policy_for_run.coverage_min_overlap,
            )
            job.progress = 92.0
            jobs_store[job_id] = job
            cluster_map = cluster_by_coverage(
                coverage_hashes_by_clip,
                match_distance=policy_for_run.coverage_match_distance,
                min_overlap=policy_for_run.coverage_min_overlap,
            )
            # Annotate clips with cluster_id; treat clips in same cluster as
            # mutual duplicates for the auto-cull dedup pass (best-take wins).
            cluster_sizes: Dict[str, int] = {}
            for cid, cluster_id in cluster_map.items():
                cluster_sizes[cluster_id] = cluster_sizes.get(cluster_id, 0) + 1
            multi_clusters = {cid: cl for cid, cl in cluster_map.items() if cluster_sizes[cl] > 1}
            for clip in clip_results:
                cl = cluster_map.get(clip.clip_id)
                if cl is None:
                    continue
                clip.scores.coverage_cluster_id = cl
                # Wire cluster into duplicate_of so apply_cull keeps the best take.
                # Pick the cluster's first-seen clip as the "head" for dedup logic.
                if cluster_sizes[cl] > 1:
                    head = sorted([c for c, x in cluster_map.items() if x == cl])[0]
                    if clip.clip_id != head:
                        clip.scores.duplicate_of = head
            multi_count = sum(1 for s in cluster_sizes.values() if s > 1)
            in_multi = sum(s for s in cluster_sizes.values() if s > 1)
            logger.info(
                "Coverage clusters: %d multi-clip clusters covering %d clips",
                multi_count, in_multi,
            )

        # Always also run filename/single-frame dedup as a backup pass — it's cheap
        # and catches exact duplicates that hashing differently might miss.
        logger.info("Running fast duplicate detection across %d clips…", len(clip_results))
        job.progress = 96.0
        jobs_store[job_id] = job
        representative_hashes: Dict[str, imagehash.ImageHash] = {}
        for clip in clip_results:
            if clip.scores.duplicate_of is not None:
                continue  # already linked by coverage clustering
            try:
                frames = extract_keyframes(clip.path, interval_sec=5.0)
                if frames:
                    representative_hashes[clip.clip_id] = compute_dhash(
                        frames[len(frames) // 2]
                    )
            except Exception as exc:  # noqa: BLE001
                logger.warning("Hash failed for %s: %s", clip.path, exc)

        dup_map = find_duplicates(
            [c.clip_id for c in clip_results if c.scores.duplicate_of is None],
            representative_hashes,
        )
        dup_count = 0
        for clip in clip_results:
            dup_target = dup_map.get(clip.clip_id)
            if dup_target is not None and clip.scores.duplicate_of is None:
                clip.scores.duplicate_of = dup_target
                dup_count += 1
        logger.info("Found %d additional fast-dup match(es)", dup_count)

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

        # ── AI grading pass ───────────────────────────────────────────────
        # Only graded segments that survived the metric cull, so we don't burn
        # budget on already-rejected clips. AI score blends into highlight_quality
        # via ai_blend_weight, and updates is_highlight accordingly.
        if policy.ai_grading and policy.deep_analysis and grade_all_clips_parallel is not None:
            graded_inputs: List[Tuple[str, List[SubClipSegment]]] = []
            for c in clip_results:
                if not c.approved:
                    continue
                if c.scores.sub_segments:
                    graded_inputs.append((c.path, c.scores.sub_segments))
            seg_total = sum(len(s) for _, s in graded_inputs)
            if seg_total > 0:
                logger.info(
                    "AI grading: %d sub-segments across %d approved clips "
                    "(parallel=%d, est. cost ~$%.2f)",
                    seg_total, len(graded_inputs), policy.ai_max_concurrent,
                    seg_total * 0.05,
                )
                job.progress = 97.0
                jobs_store[job_id] = job
                graded = grade_all_clips_parallel(graded_inputs, policy)
                logger.info("AI grading: %d/%d segments graded", graded, seg_total)

                # Blend AI score into highlight_quality and re-evaluate is_highlight
                w = max(0.0, min(1.0, policy.ai_blend_weight))
                for clip in clip_results:
                    if not clip.scores.sub_segments:
                        continue
                    for seg in clip.scores.sub_segments:
                        if seg.ai_score is not None:
                            ai_norm = seg.ai_score / 10.0
                            blended = (1.0 - w) * seg.highlight_quality + w * ai_norm
                            seg.highlight_quality = round(blended, 4)
                            # Re-evaluate is_highlight after blend
                            qualifies = (
                                seg.highlight_quality >= policy.highlight_quality_threshold
                                and seg.duration_sec >= policy.highlight_min_duration_sec
                                and seg.ai_score >= policy.ai_min_score_to_keep
                            )
                            if policy.highlight_require_face and seg.face_frames == 0:
                                qualifies = False
                            seg.is_highlight = qualifies

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
