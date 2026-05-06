"""Local equivalent of vertex_gemini.synthesize.

Runs Qwen2-VL 2B (4-bit) via mlx-vlm on Apple Silicon. Returns the same
dict shape Gemini emits so analyzer.py is unchanged:

  {"segment","moment","caption","quality","subjects",
   "skip","skip_reason","in_sec","out_sec"}

Lazy-loads the model on first call. Falls back to a heuristic decision
if mlx-vlm is unavailable or inference fails.
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("analyzer")

LOCAL_VLM_MODEL = os.environ.get(
    "LOCAL_VLM_MODEL",
    "mlx-community/Qwen2-VL-2B-Instruct-4bit",
)
MAX_TOKENS = int(os.environ.get("LOCAL_VLM_MAX_TOKENS", "512"))
MAX_KEYFRAMES = int(os.environ.get("LOCAL_VLM_MAX_KEYFRAMES", "4"))

CANONICAL_SEGMENTS = [
    "Groomsmen Getting Ready",
    "Bride Getting Ready",
    "First Look",
    "Ceremony",
    "Cocktail Hour",
    "Reception / First Dance",
    "Toasts",
    "Drone / Aerial",
    "Ambiance / BTS",
    "Backup",
]

_PROMPT = """You are a wedding videography editor reviewing one raw clip.

You see {n_frames} keyframes from the clip in chronological order.

Decide:
1. Which canonical segment this clip belongs to (exact string from list).
2. A 3-7 word "moment" description.
3. A one-sentence caption a human editor would skim.
4. Cinematic quality 0-10 (composition, focus, light, motion).
5. Subjects visible (e.g. "bride", "groom", "officiant", "guests").
6. Whether to skip this clip entirely (corrupted, mic check, lens cap).
7. Suggested in/out seconds inside the clip for the keep portion.

Canonical segments: {segments}

Heuristic scores: shake={shake_score}, blur={blur_score}, exposure_ok={exposure_ok}
Clip duration: {duration_sec} seconds
Transcript: {transcript}

Respond with ONLY valid JSON, no prose, no markdown:
{{"segment":"<one of canonical>","moment":"<3-7 words>","caption":"<one sentence>","quality":<0-10>,"subjects":["..."],"skip":<true|false>,"skip_reason":"<reason or null>","in_sec":<number or null>,"out_sec":<number or null>}}
"""

_model = None
_processor = None
_config = None


def _load_model():
    global _model, _processor, _config
    if _model is not None:
        return _model, _processor, _config
    import download_progress
    download_progress.install()
    from mlx_vlm import load
    from mlx_vlm.utils import load_config
    logger.info("local_vlm: loading %s (first call, may download ~1.5 GB)", LOCAL_VLM_MODEL)
    _model, _processor = load(LOCAL_VLM_MODEL)
    _config = load_config(LOCAL_VLM_MODEL)
    logger.info("local_vlm: model loaded")
    return _model, _processor, _config


def synthesize(
    keyframe_jpeg_paths: List[str],
    duration_sec: float,
    shake_score: float,
    blur_score: float,
    exposure_ok: bool,
    video_intel: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    transcript = ((video_intel or {}).get("transcript") or "")[:1500]
    images = [p for p in keyframe_jpeg_paths[:MAX_KEYFRAMES] if Path(p).exists()]
    if not images:
        logger.warning("local_vlm: no keyframes, returning heuristic decision")
        return _heuristic_decision(duration_sec, shake_score, blur_score, exposure_ok, video_intel)

    prompt = _PROMPT.format(
        n_frames=len(images),
        segments=", ".join(CANONICAL_SEGMENTS),
        shake_score=round(shake_score, 3),
        blur_score=round(blur_score, 3),
        exposure_ok="true" if exposure_ok else "false",
        duration_sec=round(duration_sec, 1),
        transcript=transcript or "(no speech detected)",
    )

    try:
        from mlx_vlm import generate
        from mlx_vlm.prompt_utils import apply_chat_template
        model, processor, config = _load_model()
        formatted = apply_chat_template(processor, config, prompt, num_images=len(images))
        result = generate(
            model, processor, formatted,
            image=images,
            max_tokens=MAX_TOKENS,
            temperature=0.2,
            verbose=False,
        )
        text = getattr(result, "text", str(result)).strip()
    except Exception as exc:  # noqa: BLE001
        logger.exception("local_vlm: inference failed: %s", exc)
        return _heuristic_decision(duration_sec, shake_score, blur_score, exposure_ok, video_intel)

    parsed = _parse_json(text)
    if not parsed:
        logger.warning("local_vlm: could not parse JSON from VLM output: %s", text[:200])
        return _heuristic_decision(duration_sec, shake_score, blur_score, exposure_ok, video_intel)
    return _normalize(parsed)


_SEG_LOOKUP = {s.lower(): s for s in CANONICAL_SEGMENTS}


def _coerce_segment(raw: Any) -> str:
    if not isinstance(raw, str):
        return "Backup"
    s = raw.strip()
    if s in CANONICAL_SEGMENTS:
        return s
    hit = _SEG_LOOKUP.get(s.lower())
    if hit:
        return hit
    # fuzzy: substring match against canonical
    sl = s.lower()
    for canon in CANONICAL_SEGMENTS:
        if canon.lower() in sl or sl in canon.lower():
            return canon
    return "Backup"


def _coerce_quality(raw: Any) -> float:
    try:
        q = float(raw)
    except (TypeError, ValueError):
        return 5.0
    return max(0.0, min(10.0, q))


def _coerce_optional_float(raw: Any) -> Optional[float]:
    if raw is None:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _coerce_str_list(raw: Any) -> List[str]:
    if not isinstance(raw, list):
        return []
    return [str(x).strip() for x in raw if isinstance(x, (str, int, float)) and str(x).strip()]


def _normalize(d: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "segment": _coerce_segment(d.get("segment")),
        "moment": (str(d["moment"]).strip() if d.get("moment") else None),
        "caption": (str(d["caption"]).strip() if d.get("caption") else None),
        "quality": _coerce_quality(d.get("quality")),
        "subjects": _coerce_str_list(d.get("subjects")),
        "skip": bool(d.get("skip", False)),
        "skip_reason": (str(d["skip_reason"]).strip() if d.get("skip_reason") else None),
        "in_sec": _coerce_optional_float(d.get("in_sec")),
        "out_sec": _coerce_optional_float(d.get("out_sec")),
    }


def _parse_json(text: str) -> Optional[Dict[str, Any]]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.MULTILINE)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                return None
        return None


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
    q = 5.0 + (1.0 if exposure_ok else 0.0) - min(shake_score * 5.0, 3.0) - min(blur_score * 3.0, 2.0)
    if has_speech:
        q += 1.0
    q = max(0.0, min(10.0, q))
    skip = (not exposure_ok) and (shake_score > 0.6 or blur_score > 0.6)
    return {
        "segment": "Backup" if not has_speech else "Toasts",
        "moment": None,
        "caption": (transcript[:120] or None),
        "quality": round(q, 2),
        "subjects": [],
        "skip": skip,
        "skip_reason": "low quality (heuristic)" if skip else None,
        "in_sec": None,
        "out_sec": None,
    }
