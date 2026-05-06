"""AI backend dispatcher.

Selects between Vertex (cloud) and local MLX backends via AI_BACKEND env var.

  AI_BACKEND=vertex  (default) → Google Vertex AI: Video Intelligence + Gemini
  AI_BACKEND=local            → MLX: Qwen2-VL + CLIP + weighted scoring

Both backends expose the same three surface functions used by analyzer.py:
  analyze_video(file_path, cleanup) -> Optional[dict]
  synthesize(...)                    -> Optional[dict]
  rerank_job(clip_reviews)           -> int
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

logger = logging.getLogger("uvicorn.error")

BACKEND = os.getenv("AI_BACKEND", "vertex").lower().strip()


def _log_once():
    if not getattr(_log_once, "_done", False):
        logger.info("AI backend = %s", BACKEND)
        _log_once._done = True  # type: ignore[attr-defined]


def analyze_video(file_path: str, cleanup: bool = True) -> Optional[Dict[str, Any]]:
    _log_once()
    if BACKEND == "local":
        import local_video
        return local_video.analyze_local_file(file_path, cleanup=cleanup)
    import vertex_video
    return vertex_video.analyze_local_file(file_path, cleanup=cleanup)


def synthesize(
    keyframe_jpeg_paths: List[str],
    duration_sec: float,
    shake_score: float,
    blur_score: float,
    exposure_ok: bool,
    video_intel: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    _log_once()
    if BACKEND == "local":
        import local_vlm
        return local_vlm.synthesize(
            keyframe_jpeg_paths=keyframe_jpeg_paths,
            duration_sec=duration_sec,
            shake_score=shake_score,
            blur_score=blur_score,
            exposure_ok=exposure_ok,
            video_intel=video_intel,
        )
    import vertex_gemini
    return vertex_gemini.synthesize(
        keyframe_jpeg_paths=keyframe_jpeg_paths,
        duration_sec=duration_sec,
        shake_score=shake_score,
        blur_score=blur_score,
        exposure_ok=exposure_ok,
        video_intel=video_intel,
    )


def rerank_job(clip_reviews: List[Any]) -> int:
    _log_once()
    if BACKEND == "local":
        import local_rerank
        return local_rerank.rerank_job(clip_reviews)
    import vertex_rerank
    return vertex_rerank.rerank_job(clip_reviews)
