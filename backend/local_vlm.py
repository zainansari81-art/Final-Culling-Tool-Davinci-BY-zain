"""Local equivalent of vertex_gemini.synthesize.

Target: Qwen2-VL 2B via mlx-vlm on Apple Silicon. Returns same dict shape
Gemini emits:

  {
    "segment":      str | None,
    "moment":       str | None,
    "caption":      str | None,
    "quality":      float (0-10),
    "subjects":     [str, ...],
    "skip":         bool,
    "skip_reason":  str | None,
    "in_sec":       float | None,
    "out_sec":      float | None,
  }

Stub. v1 returns a deterministic best-effort decision derived from the
local heuristic signals so the rest of the pipeline still produces clips
without the VLM. Replace _vlm_decide with mlx-vlm Qwen2-VL inference.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger("uvicorn.error")

CANONICAL_SEGMENTS = [
    "ceremony", "vows", "rings", "first_kiss", "recessional",
    "reception", "speeches", "first_dance", "cake", "party",
    "preparation", "portraits", "broll",
]


def synthesize(
    keyframe_jpeg_paths: List[str],
    duration_sec: float,
    shake_score: float,
    blur_score: float,
    exposure_ok: bool,
    video_intel: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    # TODO: load Qwen2-VL via mlx-vlm, build prompt with CANONICAL_SEGMENTS
    # plus the keyframes and ask for the same JSON schema vertex_gemini uses.
    return _heuristic_decision(
        duration_sec=duration_sec,
        shake_score=shake_score,
        blur_score=blur_score,
        exposure_ok=exposure_ok,
        video_intel=video_intel,
    )


def _heuristic_decision(
    duration_sec: float,
    shake_score: float,
    blur_score: float,
    exposure_ok: bool,
    video_intel: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    transcript = (video_intel or {}).get("transcript") or ""
    words = (video_intel or {}).get("words") or []
    has_speech = len(words) >= 3

    # quality 0-10 from local metrics (placeholder until VLM lands)
    q = 5.0
    if exposure_ok:
        q += 1.0
    q -= min(shake_score * 5.0, 3.0)
    q -= min(blur_score * 3.0, 2.0)
    if has_speech:
        q += 1.0
    q = max(0.0, min(10.0, q))

    skip = (not exposure_ok) and (shake_score > 0.6 or blur_score > 0.6)

    return {
        "segment": "broll" if not has_speech else None,
        "moment": None,
        "caption": (transcript[:120] or None),
        "quality": round(q, 2),
        "subjects": [],
        "skip": skip,
        "skip_reason": "low quality (heuristic)" if skip else None,
        "in_sec": None,
        "out_sec": None,
    }
