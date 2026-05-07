"""Cloud-backend video analysis: keyframes + scenes + speech only.

Used when AI_BACKEND=cloud. Skips every local AI model (CLIP, segment
classifier) so the host never downloads model weights or burns GPU.
Gemini in cloud_gemini does all visual reasoning from the keyframes
analyzer.py already extracted.

Returned dict shape matches local_video.analyze_local_file so
ai_backend / analyzer / cloud_gemini all consume it identically:

  {
    "shots":       [{"start_sec","end_sec"}, ...],   # PySceneDetect
    "labels":      [],                                # always empty (no CLIP)
    "transcript":  str | None,                       # faster-whisper
    "words":       [{"word","start_sec","end_sec","speaker_tag"}, ...],
    "persons":     [],
    "clip_segment": None,                             # CLIP override disabled
  }
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("analyzer")


def analyze_local_file(
    local_path: str,
    cleanup: bool = True,
    keyframe_paths: Optional[List[str]] = None,
) -> Optional[Dict[str, Any]]:
    out: Dict[str, Any] = {
        "shots": _detect_shots(local_path),
        "labels": [],
        "transcript": None,
        "words": [],
        "persons": [],
        "clip_segment": None,
    }
    try:
        import whisper_transcribe
        wh = whisper_transcribe.transcribe(local_path)
        if wh:
            out["transcript"] = wh.get("transcript")
            out["words"] = wh.get("words") or []
    except Exception as exc:  # noqa: BLE001
        logger.warning("cloud_video: whisper failed for %s: %s", local_path, exc)
    return out


def _detect_shots(local_path: str) -> List[Dict[str, float]]:
    try:
        from scenedetect import detect, ContentDetector
        scene_list = detect(local_path, ContentDetector())
        return [
            {"start_sec": s.get_seconds(), "end_sec": e.get_seconds()}
            for s, e in scene_list
        ]
    except Exception as exc:  # noqa: BLE001
        logger.warning("cloud_video: scene detect failed for %s: %s", local_path, exc)
        return []
