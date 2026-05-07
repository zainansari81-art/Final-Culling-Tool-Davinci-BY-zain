"""AI backend dispatcher.

Selects backend via AI_BACKEND env var. Cloud (Gemini via Google AI Studio)
is the default and the only supported path for end users; local and vertex
remain as power-user / dev fallbacks.

  AI_BACKEND=cloud   (default) → Google AI Studio Gemini (free tier)
  AI_BACKEND=vertex            → Google Vertex AI (requires GCP project)
  AI_BACKEND=local             → MLX local Qwen + CLIP (Apple Silicon only)

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

BACKEND = os.getenv("AI_BACKEND", "cloud").lower().strip()


def _log_once():
    if not getattr(_log_once, "_done", False):
        logger.info("AI backend = %s", BACKEND)
        _log_once._done = True  # type: ignore[attr-defined]


def analyze_video(
    file_path: str,
    cleanup: bool = True,
    keyframe_paths: Optional[List[str]] = None,
) -> Optional[Dict[str, Any]]:
    _log_once()
    if BACKEND == "local":
        import local_video
        return local_video.analyze_local_file(
            file_path, cleanup=cleanup, keyframe_paths=keyframe_paths,
        )
    if BACKEND == "cloud":
        import local_video
        return local_video.analyze_local_file(
            file_path, cleanup=cleanup, keyframe_paths=keyframe_paths,
        )
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
    if BACKEND == "cloud":
        import cloud_gemini
        return cloud_gemini.synthesize(
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
    if BACKEND == "cloud":
        import cloud_rerank
        return cloud_rerank.rerank_job(clip_reviews)
    import vertex_rerank
    return vertex_rerank.rerank_job(clip_reviews)
