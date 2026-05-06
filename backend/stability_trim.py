"""Stability + jerk based in/out point detection.

Replaces speech-driven trim as the default. Find the longest contiguous
window where the camera is either:
  - STABLE  (low motion variance — locked-off / tripod / sustained framing)
  - SMOOTH  (high motion magnitude but low jerk — gimbal push, pan, dolly)
Reject UNSTABLE (high motion AND high jerk — handheld shake).

Per the locked v1 spec: 1.0 s lead-in / 1.0 s tail-out handles, min keep
1.5 s, single global threshold (no per-camera tuning yet).

Public API:
    compute_stability_trim(frames, duration_sec, interval_sec) -> StabilityResult
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

import cv2
import numpy as np

# Tunables — single global, normalized per-clip later if needed.
THRESH_VAR  = 1.5    # motion-magnitude variance below this = STABLE
THRESH_MAG  = 2.0    # mean magnitude above this counts as "moving"
THRESH_JERK = 1.2    # jerk (Δ-magnitude) above this = shaky
MIN_KEEP_SEC    = 1.5
LEAD_IN_SEC     = 1.0
TAIL_OUT_SEC    = 1.0
NEEDS_STAB_SEC  = 1.5  # if longest stable+smooth run < this, flag


@dataclass
class StabilityResult:
    in_sec: Optional[float]
    out_sec: Optional[float]
    needs_stabilization: bool
    longest_stable_sec: float
    states: List[str]  # per-window labels for debugging


def _per_frame_motion(frames: List[np.ndarray]) -> List[float]:
    """Mean optical-flow magnitude between consecutive frames."""
    if len(frames) < 2:
        return []
    mags: List[float] = []
    prev = cv2.cvtColor(frames[0], cv2.COLOR_BGR2GRAY)
    for f in frames[1:]:
        cur = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
        flow = cv2.calcOpticalFlowFarneback(
            prev, cur, None,
            pyr_scale=0.5, levels=3, winsize=15,
            iterations=3, poly_n=5, poly_sigma=1.2, flags=0,
        )
        mag, _ = cv2.cartToPolar(flow[..., 0], flow[..., 1])
        mags.append(float(mag.mean()))
        prev = cur
    return mags


def _classify_windows(magnitudes: List[float]) -> List[str]:
    """For each motion sample assign STABLE / SMOOTH / UNSTABLE."""
    if not magnitudes:
        return []
    states: List[str] = []
    # Variance over a tiny rolling window of 3 samples.
    for i in range(len(magnitudes)):
        lo = max(0, i - 1)
        hi = min(len(magnitudes), i + 2)
        window = magnitudes[lo:hi]
        var = float(np.var(window)) if len(window) > 1 else 0.0
        mag = magnitudes[i]
        # Jerk = |Δ-magnitude| from previous sample.
        jerk = abs(magnitudes[i] - magnitudes[i - 1]) if i > 0 else 0.0
        if var < THRESH_VAR:
            states.append("STABLE")
        elif mag > THRESH_MAG and jerk < THRESH_JERK:
            states.append("SMOOTH")
        else:
            states.append("UNSTABLE")
    return states


def _longest_keep_run(states: List[str]) -> tuple[int, int]:
    """Return (start_idx, end_idx_exclusive) of longest STABLE/SMOOTH run."""
    best = (0, 0)
    cur_start = None
    for i, s in enumerate(states):
        keep = s in ("STABLE", "SMOOTH")
        if keep and cur_start is None:
            cur_start = i
        elif not keep and cur_start is not None:
            if (i - cur_start) > (best[1] - best[0]):
                best = (cur_start, i)
            cur_start = None
    if cur_start is not None:
        if (len(states) - cur_start) > (best[1] - best[0]):
            best = (cur_start, len(states))
    return best


def compute_stability_trim(
    frames: List[np.ndarray],
    duration_sec: float,
    interval_sec: float = 2.0,
) -> StabilityResult:
    """Phase 1a entry point.

    `frames` are the keyframes already extracted by analyzer.extract_keyframes.
    `interval_sec` is the spacing between those keyframes (KEYFRAME_INTERVAL_SEC).

    Each magnitude sample covers `interval_sec` of footage. Returns clip-relative
    in/out seconds + the needs_stabilization flag.
    """
    mags = _per_frame_motion(frames)
    states = _classify_windows(mags)

    if not states:
        # < 2 keyframes: trust the whole clip, can't judge.
        return StabilityResult(
            in_sec=0.0, out_sec=duration_sec,
            needs_stabilization=False,
            longest_stable_sec=duration_sec,
            states=states,
        )

    start_idx, end_idx = _longest_keep_run(states)
    longest_sec = (end_idx - start_idx) * interval_sec

    if longest_sec < NEEDS_STAB_SEC:
        # Not enough sustained framing; flag and let the user decide.
        return StabilityResult(
            in_sec=None, out_sec=None,
            needs_stabilization=True,
            longest_stable_sec=longest_sec,
            states=states,
        )

    # Convert window indices to seconds. Each magnitude sample is the gap
    # between frame i and frame i+1, so window i covers seconds
    # [i * interval_sec, (i + 1) * interval_sec].
    raw_in  = start_idx * interval_sec
    raw_out = end_idx * interval_sec
    in_sec  = max(0.0, raw_in - LEAD_IN_SEC)
    out_sec = min(duration_sec, raw_out + TAIL_OUT_SEC)
    if (out_sec - in_sec) < MIN_KEEP_SEC:
        # Window collapsed (very short clip); fall back to whole clip.
        in_sec, out_sec = 0.0, duration_sec
    return StabilityResult(
        in_sec=in_sec,
        out_sec=out_sec,
        needs_stabilization=False,
        longest_stable_sec=longest_sec,
        states=states,
    )


def compute_stability_trim_from_motion(
    motion: List[float],
    duration_sec: float,
    interval_sec: float = 1.0,
) -> StabilityResult:
    """Phase 1b entrypoint: dense per-second motion array (no frame decode).

    Same algorithm as compute_stability_trim but consumes a precomputed
    magnitude array. interval_sec defaults to 1.0 because dense_features
    samples at 1 Hz; pass another value if upstream sampling differs.
    """
    if not motion:
        return StabilityResult(
            in_sec=0.0, out_sec=duration_sec,
            needs_stabilization=False,
            longest_stable_sec=duration_sec,
            states=[],
        )
    states = _classify_windows(motion)
    start_idx, end_idx = _longest_keep_run(states)
    longest_sec = (end_idx - start_idx) * interval_sec
    if longest_sec < NEEDS_STAB_SEC:
        return StabilityResult(
            in_sec=None, out_sec=None,
            needs_stabilization=True,
            longest_stable_sec=longest_sec,
            states=states,
        )
    raw_in = start_idx * interval_sec
    raw_out = end_idx * interval_sec
    in_sec = max(0.0, raw_in - LEAD_IN_SEC)
    out_sec = min(duration_sec, raw_out + TAIL_OUT_SEC)
    if (out_sec - in_sec) < MIN_KEEP_SEC:
        in_sec, out_sec = 0.0, duration_sec
    return StabilityResult(
        in_sec=in_sec,
        out_sec=out_sec,
        needs_stabilization=False,
        longest_stable_sec=longest_sec,
        states=states,
    )
