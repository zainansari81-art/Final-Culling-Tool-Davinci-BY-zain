"""Per-second dense feature extractor for one clip (Phase 1b).

Single PyAV pass. Samples one video frame per second, computes Farneback
optical-flow magnitude between consecutive 1-Hz frames, and computes
audio RMS per 1-second bucket. Output feeds:
  - stability_trim (finer granularity than the 2 s keyframe sampler)
  - future archetype scorers (Phase 1c+)

Designed to add ~3-5 s per clip on M1 8 GB. CPU-bound; runs in parallel
with the MLX VLM inference thread.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

import av
import cv2
import numpy as np

logger = logging.getLogger("analyzer")

SAMPLE_HZ = 1.0  # one motion + one audio sample per second


@dataclass
class DenseFeatures:
    duration_sec: float
    sample_hz: float
    motion: List[float] = field(default_factory=list)     # one per second
    audio_rms: List[float] = field(default_factory=list)  # one per second

    def to_dict(self) -> dict:
        return {
            "duration_sec": round(self.duration_sec, 3),
            "sample_hz": self.sample_hz,
            "motion": [round(m, 4) for m in self.motion],
            "audio_rms": [round(a, 6) for a in self.audio_rms],
        }


def _resize_for_flow(frame: np.ndarray, max_side: int = 480) -> np.ndarray:
    h, w = frame.shape[:2]
    side = max(h, w)
    if side <= max_side:
        return frame
    scale = max_side / side
    return cv2.resize(frame, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)


def _extract_video_motion(container: "av.container.InputContainer", duration_sec: float) -> List[float]:
    """Decode one frame per second, return mean Farneback magnitude per gap."""
    motion: List[float] = []
    video_stream = next((s for s in container.streams if s.type == "video"), None)
    if video_stream is None:
        return motion
    # Skip non-reference frames for speed; we'll resample to 1 Hz ourselves.
    video_stream.codec_context.skip_frame = "NONREF"
    next_target = 0.0
    prev_gray: Optional[np.ndarray] = None
    for frame in container.decode(video=0):
        ts = float(frame.pts * frame.time_base) if frame.pts is not None else None
        if ts is None or ts < next_target:
            continue
        next_target = ts + 1.0 / SAMPLE_HZ
        bgr = frame.to_ndarray(format="bgr24")
        bgr = _resize_for_flow(bgr)
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        if prev_gray is not None:
            flow = cv2.calcOpticalFlowFarneback(
                prev_gray, gray, None,
                pyr_scale=0.5, levels=3, winsize=15,
                iterations=3, poly_n=5, poly_sigma=1.2, flags=0,
            )
            mag, _ = cv2.cartToPolar(flow[..., 0], flow[..., 1])
            motion.append(float(mag.mean()))
        prev_gray = gray
        if next_target > duration_sec:
            break
    return motion


def _extract_audio_rms(container: "av.container.InputContainer", duration_sec: float) -> List[float]:
    """Decode the audio stream, bucket samples by integer second, return RMS."""
    audio_stream = next((s for s in container.streams if s.type == "audio"), None)
    if audio_stream is None:
        return []
    sr = audio_stream.rate or 48000
    n_buckets = max(1, int(duration_sec) + 1)
    sums = np.zeros(n_buckets, dtype=np.float64)
    counts = np.zeros(n_buckets, dtype=np.int64)
    for frame in container.decode(audio=0):
        ts = float(frame.pts * frame.time_base) if frame.pts is not None else 0.0
        bucket = int(ts)
        if bucket < 0 or bucket >= n_buckets:
            continue
        # Convert to mono float32 in [-1, 1]. Branch on the ORIGINAL dtype:
        # float ≈ already in unit range, integer needs /32768 scaling.
        pcm = frame.to_ndarray()
        if pcm.ndim == 2:
            pcm = pcm.mean(axis=0)
        if np.issubdtype(pcm.dtype, np.integer):
            pcm = pcm.astype(np.float32) / 32768.0
        else:
            pcm = pcm.astype(np.float32)
        sums[bucket] += float(np.square(pcm).sum())
        counts[bucket] += int(pcm.size)
    rms = np.zeros(n_buckets, dtype=np.float64)
    nonzero = counts > 0
    rms[nonzero] = np.sqrt(sums[nonzero] / counts[nonzero])
    return rms.tolist()


def extract_dense(file_path: str) -> Optional[DenseFeatures]:
    """One PyAV pass per clip. Returns None on failure."""
    p = Path(file_path)
    if not p.exists():
        return None
    try:
        with av.open(str(p)) as container:
            duration_sec = float(container.duration / 1_000_000) if container.duration else 0.0
            motion = _extract_video_motion(container, duration_sec)
        # Audio needs a fresh container — PyAV doesn't rewind streams cleanly.
        with av.open(str(p)) as container:
            audio = _extract_audio_rms(container, duration_sec)
    except Exception as exc:  # noqa: BLE001
        logger.warning("dense_features: extract failed for %s: %s", file_path, exc)
        return None
    return DenseFeatures(
        duration_sec=duration_sec,
        sample_hz=SAMPLE_HZ,
        motion=motion,
        audio_rms=audio,
    )
