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
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("analyzer")

def _resolve_default_vlm() -> str:
    """Use hardware_detect when LOCAL_VLM_MODEL isn't set explicitly."""
    explicit = os.environ.get("LOCAL_VLM_MODEL", "").strip()
    if explicit:
        return explicit
    try:
        import hardware_detect
        profile = hardware_detect.detect()
        logger.info(
            "local_vlm: hardware tier=%s chip=%s ram=%dGB → %s",
            profile.tier, profile.chip, profile.ram_gb, profile.recommended_vlm,
        )
        return profile.recommended_vlm
    except Exception as exc:  # noqa: BLE001
        logger.warning("hardware_detect failed (%s); using safe default", exc)
        return "mlx-community/Qwen2.5-VL-3B-Instruct-4bit"


LOCAL_VLM_MODEL = _resolve_default_vlm()
MAX_TOKENS = int(os.environ.get("LOCAL_VLM_MAX_TOKENS", "512"))
MAX_KEYFRAMES = int(os.environ.get("LOCAL_VLM_MAX_KEYFRAMES", "4"))
AUDIT_PASS = os.environ.get("LOCAL_VLM_AUDIT", "1") == "1"
# Trust CLIP segment classification when its top score is at least this far
# above the runner-up. Qwen2-VL 2B confuses bride/groom prep too often;
# CLIP zero-shot is the more reliable signal for visual category.
CLIP_SEGMENT_MARGIN = float(os.environ.get("LOCAL_CLIP_SEG_MARGIN", "0.05"))

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

_AUDIT_PROMPT = """You are an SENIOR wedding video editor reviewing a JUNIOR editor's
initial decision on the keyframes you also see.

INITIAL DECISION (JSON):
{initial}

CLIP CONTEXT:
- CLIP zero-shot labels: {clip_labels}
- Transcript (may be unrelated background, ignore for visual decisions):
  {transcript}
- Clip duration: {duration_sec} seconds
- {n_frames} keyframes attached.

CANONICAL SEGMENTS (use one EXACTLY):
{segments}

Audit the decision. Be strict:
1. Does the segment match what is actually visible in the keyframes?
   White gown on hanger / no people = "Bride Getting Ready". Suit /
   ties / cufflinks = "Groomsmen Getting Ready". Etc.
2. Is the caption literal? Reject any invented actions. If only an
   object is visible, the caption must describe the object — never
   "the bride is putting on" if no bride is visible.
3. Subjects: do they list only people actually visible?
4. Quality: a clean, well-composed static product/object shot is 7+,
   not 3. Penalize only for genuinely bad framing/focus/exposure.
5. skip = true ONLY for: lens cap, color chart, mic check, totally
   black/garbled frames. A short clip is not a reason to skip.
6. If the initial decision is correct, return it unchanged.

Return ONLY the corrected JSON, same schema:
{{"segment":"<one of canonical>","moment":"<3-7 words>","caption":"<one literal sentence>","quality":<0-10>,"subjects":["..."],"skip":<true|false>,"skip_reason":"<reason or null>","in_sec":<number or null>,"out_sec":<number or null>,"rationale":"<2-3 sentence editor's note. Same rules as the initial prompt — describe the shot editorially, no technical jargon. If the initial rationale already does this, return it unchanged.>"}}
"""


_PROMPT = """You are a wedding videographer's editor. Look at the keyframes and choose the best canonical segment.

CANONICAL SEGMENTS (use one EXACTLY):
{segments}

Hints:
- A wedding DRESS hanging on a hook, hanger, door, tree, or stand (no people) → "Bride Getting Ready" (NOT Groomsmen).
- A SUIT on a hanger, ties, cufflinks, dress shoes laid out → "Groomsmen Getting Ready".
- People at altar with officiant → "Ceremony".
- Couple seeing each other for the first time → "First Look".
- Drone / aerial shot of venue from clearly above (rooftops, treetops) → "Drone / Aerial".
- GROUND-LEVEL outdoor venue shots (trees, lawn, fence, exterior, empty ceremony chairs) → "Ambiance / BTS", NOT "Drone / Aerial" and NOT "Ceremony".
- Indoor decor, table settings, candles, empty venue, BTS crew, ring/bouquet detail → "Ambiance / BTS".
- Test footage, lens cap, color chart, mic check, totally unusable frames only → "Backup". Do NOT use "Backup" as a fallback for content you can't otherwise classify; pick the closest real segment instead.
- When in doubt between Getting Ready variants, look at the GARMENT. White gown = bride. Tuxedo/suit = groomsmen.

CAPTION RULES (strict):
- Describe ONLY what is visibly present in the keyframes.
- Never invent actions or people. If the frame shows only a dress on a hanger, write
  "A wedding dress on a hanger" — NOT "the bride is putting on her dress".
- If no humans are visible, do NOT use the words "bride", "groom", or any other person.
- Use present tense, max one sentence, ≤15 words.

SUBJECTS RULE: Only list people you can actually see in the keyframes. Empty list is fine.

Visual evidence from CLIP zero-shot: {clip_labels}
Transcript (may be unrelated background audio, ignore for visual decisions):
{transcript}
Clip duration: {duration_sec} seconds, {n_frames} keyframes shown.

Quality (0-10) should reflect what an editor would see in the keyframes:
composition, focus, lighting, presence of subjects. Do NOT auto-zero a
clip just because of camera shake — handheld wedding footage is normal.
A clean static shot of a beautiful object is 7+, not 3.

RATIONALE RULES:
- 2-3 short sentences, conversational, present tense.
- Talk about WHAT IS HAPPENING in the shot and WHY this clip works (or doesn't) editorially.
- Mention concrete visual cues: composition, light, motion, subjects, mood.
- Never use technical jargon ("keyframes", "VLM", "stability score", "Farneback").
- Example for a clean outdoor first-look: "The groom waits in soft outdoor light, the camera holds steady on his back. The framing is clean and cinematic with the white fence behind. This is a usable wide that leads into the reveal."
- Example for a fumbled shot: "Camera is shaky and tilts mid-pan. The subject leaves frame at the end. Skip."

Respond with ONLY valid JSON, no prose, no markdown:
{{"segment":"<one of canonical>","moment":"<3-7 words>","caption":"<one literal sentence>","quality":<0-10>,"subjects":["..."],"skip":<true|false>,"skip_reason":"<reason or null>","in_sec":<number or null>,"out_sec":<number or null>,"rationale":"<2-3 sentence editor's note: what's happening, what works visually, why this clip is worth keeping or not. Speak like a senior wedding editor explaining the cull to a junior. Do NOT mention 'frames' / 'keyframes' / technical metrics — talk about the SHOT.>"}}
"""

_model = None
_processor = None
_config = None
_load_lock = threading.Lock()

# MLX streams are thread-bound. Run ALL VLM work — load + every inference —
# on a single dedicated thread so the stream stays valid. analyzer worker
# threads submit a Future and block on the result.
_vlm_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx-vlm")


def _load_model_inthread():
    global _model, _processor, _config
    if _model is not None:
        return
    import download_progress
    download_progress.install()
    from mlx_vlm import load
    from mlx_vlm.utils import load_config
    logger.info("local_vlm: loading %s (first call, may download ~1.5 GB)", LOCAL_VLM_MODEL)
    _model, _processor = load(LOCAL_VLM_MODEL)
    _config = load_config(LOCAL_VLM_MODEL)
    logger.info("local_vlm: model loaded")


def _load_model():
    """Public helper used by the warmup endpoint. Runs the load on the
    dedicated MLX thread so the model lives on the same thread that will
    later perform inference."""
    with _load_lock:
        _vlm_executor.submit(_load_model_inthread).result()


def _run_inference(prompt: str, images: List[str]) -> str:
    """Runs on the single MLX worker thread. Loads model on first call."""
    _load_model_inthread()
    from mlx_vlm import generate
    from mlx_vlm.prompt_utils import apply_chat_template
    formatted = apply_chat_template(_processor, _config, prompt, num_images=len(images))
    result = generate(
        _model, _processor, formatted,
        image=images,
        max_tokens=MAX_TOKENS,
        temperature=0.2,
        verbose=False,
    )
    return getattr(result, "text", str(result)).strip()


def synthesize(
    keyframe_jpeg_paths: List[str],
    duration_sec: float,
    shake_score: float,
    blur_score: float,
    exposure_ok: bool,
    video_intel: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    transcript = ((video_intel or {}).get("transcript") or "")[:1500]
    labels = (video_intel or {}).get("labels") or []
    clip_labels = ", ".join(
        f"{l['label']}({l['confidence']:.2f})" for l in labels[:5]
    ) or "(no high-confidence visual labels)"
    images = [p for p in keyframe_jpeg_paths[:MAX_KEYFRAMES] if Path(p).exists()]
    if not images:
        logger.warning("local_vlm: no keyframes, returning heuristic decision")
        d = _heuristic_decision(duration_sec, shake_score, blur_score, exposure_ok, video_intel)
        d["_reasoning"] = ["VLM skipped: no keyframes available; heuristic fallback used."]
        return d

    prompt = _PROMPT.format(
        clip_labels=clip_labels,
        n_frames=len(images),
        segments="\n".join(f"- {s}" for s in CANONICAL_SEGMENTS),
        duration_sec=round(duration_sec, 1),
        transcript=transcript or "(no speech detected)",
    )

    try:
        # Run load + inference on the single dedicated MLX thread so the
        # stream stays valid for the lifetime of the process.
        text = _vlm_executor.submit(_run_inference, prompt, images).result()
    except Exception as exc:  # noqa: BLE001
        logger.exception("local_vlm: inference failed: %s", exc)
        d = _heuristic_decision(duration_sec, shake_score, blur_score, exposure_ok, video_intel)
        d["_reasoning"] = [f"VLM inference failed ({exc}); heuristic fallback used."]
        return d

    parsed = _parse_json(text)
    if not parsed:
        logger.warning("local_vlm: could not parse JSON from VLM output: %s", text[:200])
        d = _heuristic_decision(duration_sec, shake_score, blur_score, exposure_ok, video_intel)
        d["_reasoning"] = ["VLM emitted unparseable JSON; heuristic fallback used."]
        return d
    initial = _normalize(parsed)
    reasoning: List[str] = [
        f"VLM initial: segment={initial.get('segment')!r}, "
        f"quality={initial.get('quality')}, skip={initial.get('skip')}."
    ]

    if AUDIT_PASS:
        audited = _run_audit(
            initial=initial,
            images=images,
            clip_labels=clip_labels,
            transcript=transcript or "(no speech detected)",
            duration_sec=duration_sec,
        )
        if audited:
            if audited.get("segment") != initial.get("segment"):
                logger.info(
                    "local_vlm: audit corrected segment %r → %r",
                    initial.get("segment"), audited.get("segment"),
                )
                reasoning.append(
                    f"Audit corrected segment: {initial.get('segment')!r} → "
                    f"{audited.get('segment')!r}."
                )
            else:
                reasoning.append("Audit confirmed initial decision.")
            initial = audited
        else:
            reasoning.append("Audit pass returned no result; kept initial decision.")

    # CLIP-based segment override. Trust CLIP when its top score is ahead
    # of runner-up by CLIP_SEGMENT_MARGIN — Qwen2-VL 2B otherwise confuses
    # bride/groom prep, drone/aerial vs ambient, etc.
    clip_seg = (video_intel or {}).get("clip_segment")
    if clip_seg and isinstance(clip_seg.get("ranked"), list) and len(clip_seg["ranked"]) >= 2:
        top_seg, top_score = clip_seg["ranked"][0]
        _, runner_score = clip_seg["ranked"][1]
        margin = top_score - runner_score
        effective_margin = (
            0.0 if initial.get("segment") == "Backup" else CLIP_SEGMENT_MARGIN
        )
        if margin >= effective_margin and top_seg != initial.get("segment"):
            logger.info(
                "local_vlm: CLIP override segment %r → %r (score=%.3f, margin=%.3f, effective=%.3f)",
                initial.get("segment"), top_seg, top_score, margin, effective_margin,
            )
            reasoning.append(
                f"CLIP override fired: {initial.get('segment')!r} → {top_seg!r} "
                f"(top score {top_score:.3f}, margin {margin:.3f} ≥ {effective_margin:.3f})."
            )
            initial["segment"] = top_seg
        else:
            reasoning.append(
                f"CLIP top {top_seg!r} ({top_score:.3f}) did not override "
                f"{initial.get('segment')!r} (margin {margin:.3f} < {effective_margin:.3f})."
            )

    initial["_reasoning"] = reasoning
    return initial


def _run_audit(
    initial: Dict[str, Any],
    images: List[str],
    clip_labels: str,
    transcript: str,
    duration_sec: float,
) -> Optional[Dict[str, Any]]:
    prompt = _AUDIT_PROMPT.format(
        initial=json.dumps(initial, separators=(",", ":")),
        clip_labels=clip_labels,
        transcript=transcript,
        duration_sec=round(duration_sec, 1),
        n_frames=len(images),
        segments="\n".join(f"- {s}" for s in CANONICAL_SEGMENTS),
    )
    try:
        text = _vlm_executor.submit(_run_inference, prompt, images).result()
    except Exception as exc:  # noqa: BLE001
        logger.warning("local_vlm: audit pass failed, keeping initial: %s", exc)
        return None
    parsed = _parse_json(text)
    if not parsed:
        logger.warning("local_vlm: audit JSON unparseable, keeping initial")
        return None
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
        "rationale": (str(d["rationale"]).strip() if d.get("rationale") else None),
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
        "caption": (transcript[:120] if transcript else "Heuristic fallback — no AI caption available."),
        "quality": round(q, 2),
        "subjects": [],
        "skip": skip,
        "skip_reason": "low quality (heuristic)" if skip else None,
        "in_sec": None,
        "out_sec": None,
        "rationale": "Heuristic fallback — VLM did not produce a usable response.",
    }
