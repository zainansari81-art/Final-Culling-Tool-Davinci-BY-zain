"""faster-whisper local transcription fallback.

Used when Vertex Video Intelligence returns no words for a clip that
clearly has dialogue (different audio codec, non-English speech, music
background, etc.). Whisper is far more robust on real-world wedding audio.

Runs on CPU with int8 quantization — ~real-time on M1, no GPU needed.
The model is loaded lazily and cached at module level.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Tunables (env-overridable)
WHISPER_MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")  # tiny|base|small|medium|large-v3
WHISPER_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
WHISPER_LANG = os.environ.get("WHISPER_LANG") or None  # None = auto-detect

# Lazy-init model (large download on first use, cached after)
_model = None


def _model_handle():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        logger.info(
            "Loading faster-whisper %s (%s/%s)",
            WHISPER_MODEL_NAME, WHISPER_DEVICE, WHISPER_COMPUTE_TYPE,
        )
        _model = WhisperModel(
            WHISPER_MODEL_NAME,
            device=WHISPER_DEVICE,
            compute_type=WHISPER_COMPUTE_TYPE,
        )
    return _model


def transcribe(video_path: str) -> Optional[Dict[str, Any]]:
    """Transcribe a video file via faster-whisper.

    Returns {"transcript": str, "words": [{word, start_sec, end_sec}]}
    or None on error.
    """
    if not os.path.exists(video_path):
        logger.warning("Whisper: file not found %s", video_path)
        return None

    try:
        model = _model_handle()
        segments, info = model.transcribe(
            video_path,
            language=WHISPER_LANG,
            word_timestamps=True,
            vad_filter=True,  # cuts long silences automatically
            vad_parameters={"min_silence_duration_ms": 500},
            beam_size=1,  # fast & accurate enough for wedding speech
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Whisper transcription failed for %s: %s", video_path, exc)
        return None

    transcript_parts: List[str] = []
    words: List[Dict[str, Any]] = []
    try:
        for seg in segments:
            if seg.text:
                transcript_parts.append(seg.text.strip())
            for w in (seg.words or []):
                token = (w.word or "").strip()
                if not token:
                    continue
                words.append({
                    "word": token,
                    "start_sec": float(w.start or 0.0),
                    "end_sec": float(w.end or 0.0),
                })
    except Exception as exc:  # noqa: BLE001
        logger.warning("Whisper iteration failed: %s", exc)

    transcript = " ".join(transcript_parts).strip()
    if not words and not transcript:
        return None

    logger.info(
        "Whisper [%s, p=%.2f]: %d words from %s",
        info.language if info else "?",
        info.language_probability if info else 0,
        len(words),
        os.path.basename(video_path),
    )
    return {"transcript": transcript, "words": words}
