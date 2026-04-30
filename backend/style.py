# style.py — Learn an editor's style from fully-edited reference wedding videos.
#
# Each reference video is already cut by a human editor — every detected scene
# boundary is a "shot the editor chose to use." We compute per-shot metrics
# (shake, sharpness, brightness, saturation, contrast, face presence) and
# aggregate across all shots in all references into a StyleProfile.
#
# The profile then shifts thresholds at job start so the analyzer culls in a
# style that matches the reference work.

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from pathlib import Path
from typing import Iterable, List, Optional, Tuple

import av
import cv2
import numpy as np

from analyzer import (
    BLUR_NORM_DIVISOR,
    SHAKE_NORM_DIVISOR,
    EXPOSURE_LOW,
    EXPOSURE_HIGH,
    _detect_faces,
    _frame_blur,
    _frame_brightness,
    _frame_richness,
    _flow_mag,
    _highlight_quality,
)
from models import CullPolicy, StyleProfile

logger = logging.getLogger(__name__)


def _detect_shots_with_scenedetect(file_path: str) -> List[Tuple[float, float]]:
    """
    Use PySceneDetect's AdaptiveDetector to find scene boundaries in an
    EDITED reference video. Returns list of (start_sec, end_sec) tuples.
    Falls back to a single (0, duration) shot on failure.
    """
    try:
        from scenedetect import open_video, SceneManager
        from scenedetect.detectors import AdaptiveDetector

        video = open_video(file_path)
        sm = SceneManager()
        sm.add_detector(AdaptiveDetector())
        sm.detect_scenes(video, show_progress=False)
        scenes = sm.get_scene_list()
        out: List[Tuple[float, float]] = []
        for scene in scenes:
            start = scene[0].get_seconds()
            end = scene[1].get_seconds()
            if end - start >= 0.4:  # ignore micro-cuts
                out.append((float(start), float(end)))
        return out
    except Exception as exc:  # noqa: BLE001
        logger.warning("Scene detect failed for %s: %s", file_path, exc)
        return []


def _sample_frames_for_shot(
    file_path: str,
    start_sec: float,
    end_sec: float,
    max_samples: int = 6,
) -> List[np.ndarray]:
    """
    Sample up to max_samples evenly-spaced frames from [start_sec, end_sec].
    Uses PyAV's seek for efficiency on long edited videos. Returns BGR ndarrays.
    """
    frames: List[np.ndarray] = []
    duration = max(end_sec - start_sec, 0.0)
    if duration <= 0:
        return frames

    n = max(1, min(max_samples, int(duration / 0.5)))
    targets = [start_sec + (i + 0.5) * duration / n for i in range(n)]

    try:
        container = av.open(file_path)
        video_stream = next((s for s in container.streams if s.type == "video"), None)
        if video_stream is None:
            return frames
        # Decode and pick frames whose ts is closest to each target.
        # On edited videos this is short enough that we can afford full decode
        # without skip_frame — accuracy matters here.
        time_base = video_stream.time_base
        next_target = 0
        for packet in container.demux(video_stream):
            if next_target >= len(targets):
                break
            for frame in packet.decode():
                if next_target >= len(targets):
                    break
                if frame.pts is None:
                    continue
                pts_sec = float(frame.pts * time_base)
                if pts_sec >= targets[next_target]:
                    frames.append(frame.to_ndarray(format="bgr24"))
                    next_target += 1
        container.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Frame sampling failed for %s [%.1f-%.1f]: %s",
                       file_path, start_sec, end_sec, exc)
    return frames


def _shot_metrics(file_path: str, start_sec: float, end_sec: float) -> Optional[dict]:
    """
    Returns per-shot metrics dict, or None if the shot couldn't be sampled.
    """
    frames = _sample_frames_for_shot(file_path, start_sec, end_sec)
    if not frames:
        return None

    grays = [cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in frames]
    blurs = [_frame_blur(g) for g in grays]
    brights = [_frame_brightness(g) for g in grays]
    sats: List[float] = []
    contrasts: List[float] = []
    for f in frames:
        sat, ctr = _frame_richness(f)
        sats.append(sat)
        contrasts.append(ctr)

    flows: List[float] = []
    for i in range(1, len(grays)):
        flows.append(_flow_mag(grays[i - 1], grays[i]))
    avg_flow = float(np.mean(flows)) if flows else 0.0
    shake_score = round(min(avg_flow / SHAKE_NORM_DIVISOR, 1.0), 4)

    avg_blur_var = float(np.mean(blurs))
    avg_bright = float(np.mean(brights))
    avg_sat = float(np.mean(sats))
    avg_contrast = float(np.mean(contrasts))

    face_frames = sum(1 for g in grays if _detect_faces(g) > 0)
    face_present = face_frames > 0

    # Reuse the same highlight scorer the analyzer uses, with default policy
    # face bonus so the profile reflects what the analyzer would compute.
    policy_default = CullPolicy()
    hl_quality = _highlight_quality(
        avg_blur_var=avg_blur_var,
        avg_flow=avg_flow,
        avg_bright=avg_bright,
        avg_saturation=avg_sat,
        avg_contrast=avg_contrast,
        face_present=face_present,
        policy=policy_default,
    )

    return {
        "duration_sec": end_sec - start_sec,
        "sharpness": avg_blur_var,
        "shake_score": shake_score,
        "brightness": avg_bright,
        "saturation": avg_sat,
        "contrast": avg_contrast,
        "face_frames": face_frames,
        "frames_sampled": len(frames),
        "face_present": face_present,
        "highlight_quality": hl_quality,
    }


def _percentile(values: List[float], p: float) -> float:
    if not values:
        return 0.0
    arr = sorted(values)
    idx = min(int(round(p * (len(arr) - 1))), len(arr) - 1)
    return float(arr[idx])


def extract_style_profile(name: str, reference_paths: List[str]) -> StyleProfile:
    """
    Build a StyleProfile from one or more reference videos. Each reference is
    cut into shots via PySceneDetect; each shot is sampled and scored. We
    aggregate into the profile.
    """
    all_shots: List[dict] = []
    for ref_path in reference_paths:
        if not Path(ref_path).is_file():
            logger.warning("Reference not found: %s", ref_path)
            continue
        logger.info("Reference: detecting shots in %s", ref_path)
        shots = _detect_shots_with_scenedetect(ref_path)
        logger.info("Reference: %d shots in %s", len(shots), Path(ref_path).name)
        for (s, e) in shots:
            m = _shot_metrics(ref_path, s, e)
            if m is not None:
                all_shots.append(m)

    profile = StyleProfile(
        id=str(uuid.uuid4()),
        name=name,
        reference_paths=reference_paths,
        reference_count=len(reference_paths),
        total_shots_analyzed=len(all_shots),
        created_at=datetime.utcnow(),
    )

    if not all_shots:
        logger.warning("No shots analyzed; returning default profile.")
        return profile

    durations = [s["duration_sec"] for s in all_shots]
    sharps = [s["sharpness"] for s in all_shots]
    sats = [s["saturation"] for s in all_shots]
    contrasts = [s["contrast"] for s in all_shots]
    brights = [s["brightness"] for s in all_shots]
    shakes = [s["shake_score"] for s in all_shots]
    hl_qs = [s["highlight_quality"] for s in all_shots]
    face_count = sum(1 for s in all_shots if s["face_present"])

    profile.shot_length_p25_sec = round(_percentile(durations, 0.25), 2)
    profile.shot_length_median_sec = round(_percentile(durations, 0.50), 2)
    profile.shot_length_p75_sec = round(_percentile(durations, 0.75), 2)
    profile.shot_length_mean_sec = round(float(np.mean(durations)), 2)

    profile.sharpness_p25 = round(_percentile(sharps, 0.25), 2)
    profile.sharpness_median = round(_percentile(sharps, 0.50), 2)
    profile.saturation_mean = round(float(np.mean(sats)), 4)
    profile.contrast_mean = round(float(np.mean(contrasts)), 4)
    profile.brightness_mean = round(float(np.mean(brights)), 2)
    profile.shake_p75 = round(_percentile(shakes, 0.75), 4)

    profile.face_ratio = round(face_count / len(all_shots), 4)

    profile.highlight_quality_p50 = round(_percentile(hl_qs, 0.50), 4)
    profile.highlight_quality_p75 = round(_percentile(hl_qs, 0.75), 4)

    logger.info(
        "Style profile '%s': %d shots, mean shot=%.1fs, sharpness_p25=%.0f, "
        "shake_p75=%.2f, face_ratio=%.0f%%, highlight_q_p50=%.2f",
        name, len(all_shots), profile.shot_length_mean_sec, profile.sharpness_p25,
        profile.shake_p75, 100 * profile.face_ratio, profile.highlight_quality_p50,
    )
    return profile


def apply_style_to_policy(policy: CullPolicy, profile: StyleProfile) -> CullPolicy:
    """
    Return a new CullPolicy whose thresholds shift toward the editor's style.

    Logic:
      - Raise sharpness bar if reference is sharper than baseline (lower blur_threshold)
      - Adjust shake_threshold to match the editor's tolerance (shake_p75 + buffer)
      - Match minimum sub-segment length to editor's shortest typical shots
      - Use the editor's highlight quality p50 as the highlight threshold so we
        match their "ship-or-cut" bar
      - Keep duplicate/coverage logic unchanged (those are universal)
    """
    updates = {}

    # Shake tolerance: editor's 75th-percentile shake plus a small buffer,
    # clamped to the original threshold ceiling.
    if profile.shake_p75 > 0:
        new_shake = round(min(max(profile.shake_p75 + 0.10, 0.40), 0.85), 2)
        updates["shake_threshold"] = new_shake

    # Blur threshold: tighter when reference is sharp.
    # Reference sharpness 100 → blur_score baseline ~0; tighten threshold to 0.50.
    # Reference sharpness 50  → reference is softer; relax to 0.75.
    if profile.sharpness_p25 > 0:
        # Map sharpness_p25 of [40..160] to blur_threshold [0.75..0.50]
        s = max(40.0, min(160.0, profile.sharpness_p25))
        new_blur = round(0.75 - (s - 40.0) / 120.0 * 0.25, 2)
        updates["blur_threshold"] = new_blur

    # Minimum segment length to match editor's shortest typical shot.
    if profile.shot_length_p25_sec > 0:
        updates["sub_min_segment_sec"] = round(max(1.0, min(profile.shot_length_p25_sec, 4.0)), 2)

    # Highlight threshold: meet or slightly exceed the editor's median quality.
    if profile.highlight_quality_p50 > 0:
        updates["highlight_quality_threshold"] = round(
            max(0.50, min(profile.highlight_quality_p50, 0.85)), 2,
        )

    return policy.model_copy(update=updates)
