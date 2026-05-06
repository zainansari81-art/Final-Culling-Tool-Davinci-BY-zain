"""Local equivalent of vertex_video.analyze_local_file.

Returns the same dict shape Vertex Video Intelligence produces so
downstream code in analyzer.py is unchanged:

  {
    "shots":     [{"start_sec","end_sec"}, ...],   # PySceneDetect
    "labels":    [{"label","confidence","start_sec","end_sec"}, ...],  # CLIP zero-shot (TODO)
    "transcript": str | None,                       # faster-whisper
    "words":     [{"word","start_sec","end_sec","speaker_tag"}, ...],  # faster-whisper word ts
    "persons":   [],                                # not implemented locally
  }

Stub. Wires PySceneDetect + whisper now; CLIP labels TODO.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger("uvicorn.error")


def analyze_local_file(local_path: str, cleanup: bool = True) -> Optional[Dict[str, Any]]:
    out: Dict[str, Any] = {
        "shots": _detect_shots(local_path),
        "labels": [],  # TODO: CLIP zero-shot top-K against wedding label vocab
        "transcript": None,
        "words": [],
        "persons": [],
    }

    try:
        import whisper_transcribe
        wh = whisper_transcribe.transcribe(local_path)
        if wh:
            out["transcript"] = wh.get("transcript")
            out["words"] = wh.get("words") or []
    except Exception as exc:  # noqa: BLE001
        logger.warning("local_video: whisper failed for %s: %s", local_path, exc)

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
        logger.warning("local_video: scene detect failed for %s: %s", local_path, exc)
        return []
