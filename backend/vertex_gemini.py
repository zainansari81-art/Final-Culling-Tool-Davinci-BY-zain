"""Gemini 2.5 Pro on Vertex — synthesizes Video Intel output + keyframes
into a structured editorial decision per clip.

One call returns: segment, moment, caption, quality 0-10, subjects,
suggested in/out, skip recommendation.
"""
from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

GCP_PROJECT = os.environ.get("GCP_PROJECT", "culling")
GCP_LOCATION = os.environ.get("GCP_LOCATION", "us-central1")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

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

Below you have:
- 4-8 keyframes from the clip (in chronological order)
- Detected labels and their time ranges (from Video Intelligence)
- Speech transcript (may be empty)
- Heuristic quality scores (shake, blur, exposure)

Decide:
1. Which canonical segment this clip belongs to.
2. A 3-7 word "moment" description.
3. A one-sentence caption a human editor would skim.
4. Cinematic quality 0-10 (composition, focus, light, motion).
5. Subjects visible (e.g. "bride", "groom", "officiant", "guests").
6. Whether to skip this clip entirely (corrupted, mic check, lens cap).
7. Suggested in/out seconds inside the clip for the keep portion.

Canonical segments (use one exactly, no other strings):
{segments}

Heuristic scores (already computed): shake={shake_score}, blur={blur_score}, exposure_ok={exposure_ok}
Clip duration: {duration_sec} seconds

Detected labels (top by confidence): {labels}
Transcript: {transcript}

Respond with ONLY valid JSON, no prose, no markdown fences:
{{
  "segment": "<one of the canonical segments>",
  "moment": "<3-7 words>",
  "caption": "<one sentence>",
  "quality": <0-10 number>,
  "subjects": ["<subject>", ...],
  "skip": <true|false>,
  "skip_reason": "<short reason if skip=true, else null>",
  "in_sec": <number or null>,
  "out_sec": <number or null>
}}
"""


_genai_client = None


def _client():
    global _genai_client
    if _genai_client is None:
        from google import genai
        _genai_client = genai.Client(
            vertexai=True,
            project=GCP_PROJECT,
            location=GCP_LOCATION,
        )
    return _genai_client


def synthesize(
    keyframe_jpeg_paths: List[str],
    duration_sec: float,
    shake_score: float,
    blur_score: float,
    exposure_ok: bool,
    video_intel: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Call Gemini with keyframes + Video Intel labels. Returns parsed JSON."""
    from google.genai import types

    labels_payload = []
    transcript = ""
    if video_intel:
        for lb in (video_intel.get("labels") or [])[:15]:
            labels_payload.append({
                "label": lb["label"],
                "conf": round(lb["confidence"], 2),
                "from": round(lb["start_sec"], 1),
                "to": round(lb["end_sec"], 1),
            })
        transcript = (video_intel.get("transcript") or "")[:1500]

    prompt = _PROMPT.format(
        segments=", ".join(CANONICAL_SEGMENTS),
        shake_score=round(shake_score, 3),
        blur_score=round(blur_score, 3),
        exposure_ok="true" if exposure_ok else "false",
        duration_sec=round(duration_sec, 1),
        labels=json.dumps(labels_payload, separators=(",", ":")),
        transcript=transcript or "(no speech detected)",
    )

    parts: List[types.Part] = [types.Part.from_text(text=prompt)]
    for fp in keyframe_jpeg_paths[:8]:
        try:
            data = Path(fp).read_bytes()
            parts.append(types.Part.from_bytes(data=data, mime_type="image/jpeg"))
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not attach keyframe %s: %s", fp, exc)

    contents = [types.Content(role="user", parts=parts)]

    try:
        resp = _client().models.generate_content(
            model=GEMINI_MODEL,
            contents=contents,
            config=types.GenerateContentConfig(
                temperature=0.2,
                response_mime_type="application/json",
                max_output_tokens=4096,
                # Disable thinking to avoid burning the output budget on it.
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Gemini call failed: %s", exc)
        return None

    text = (resp.text or "").strip()
    if not text:
        return None
    return _parse_json(text)


def _parse_json(text: str) -> Optional[Dict[str, Any]]:
    """Robust JSON extraction (Gemini occasionally wraps in markdown)."""
    text = text.strip()
    # strip code fences if present
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.MULTILINE)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # last-ditch: find first {...}
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
    logger.warning("Could not parse Gemini JSON: %s", text[:200])
    return None


# ─── Cross-clip ranking ────────────────────────────────────────────────────

_RERANK_PROMPT = """You are a senior wedding videography editor.
The clips below all belong to the same wedding moment / segment.
Rank them best-to-worst for the final cut, weighing:
- Cinematic quality (composition, focus, light, motion)
- Emotional content (faces, reactions, key beats)
- Cleanliness (no mid-take cuts, no obvious flaws)
- Distinctness (avoid keeping visually-redundant takes)

Segment: {segment}

Clips:
{clips_text}

Respond with ONLY this JSON, nothing else:
{{ "order": ["<clip_id_best>", ..., "<clip_id_worst>"] }}
"""


def _format_clip_for_rank(c: Dict[str, Any]) -> str:
    parts = [f'- id: "{c["clip_id"]}"', f"  filename: {c.get('filename', '')}"]
    if c.get("duration_sec"):
        parts.append(f"  duration: {c['duration_sec']}s")
    if c.get("ai_quality") is not None:
        parts.append(f"  ai_quality: {c['ai_quality']}/10")
    if c.get("ai_caption"):
        parts.append(f"  caption: {c['ai_caption'][:200]}")
    if c.get("transcript"):
        parts.append(f"  transcript: {c['transcript'][:200]}")
    if c.get("subjects"):
        parts.append(f"  subjects: {', '.join(c['subjects'])}")
    parts.append(f"  shake: {c.get('shake_score', 0):.2f}")
    parts.append(f"  blur: {c.get('blur_score', 0):.2f}")
    return "\n".join(parts)


def rerank_segment(segment: str, clips: List[Dict[str, Any]]) -> Optional[List[str]]:
    """Ask Gemini to rank clips within one segment. Returns ordered clip_ids."""
    from google.genai import types

    if len(clips) < 2:
        return [c["clip_id"] for c in clips] if clips else None

    prompt = _RERANK_PROMPT.format(
        segment=segment,
        clips_text="\n\n".join(_format_clip_for_rank(c) for c in clips),
    )

    try:
        resp = _client().models.generate_content(
            model=GEMINI_MODEL,
            contents=[types.Content(role="user", parts=[types.Part.from_text(text=prompt)])],
            config=types.GenerateContentConfig(
                temperature=0.2,
                response_mime_type="application/json",
                max_output_tokens=2048,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Gemini rerank failed for %s: %s", segment, exc)
        return None

    text = (resp.text or "").strip()
    parsed = _parse_json(text)
    if not parsed:
        return None
    order_raw = parsed.get("order") if isinstance(parsed, dict) else parsed
    if not isinstance(order_raw, list):
        return None

    valid_ids = {c["clip_id"] for c in clips}
    seen: set[str] = set()
    out: List[str] = []
    for cid in order_raw:
        if isinstance(cid, str) and cid in valid_ids and cid not in seen:
            out.append(cid)
            seen.add(cid)
    return out or None
