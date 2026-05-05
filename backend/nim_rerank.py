"""NVIDIA NIM cross-clip ranking.

After all clips are analyzed, group them by ai_segment and ask Llama 3.1
Nemotron to rank takes within each group. Marks each clip's
`scores.rank_in_group` (1 = best) so the UI/export can prefer winners.

Optional — runs only when NIM_API_KEY is set. Free credits at build.nvidia.com.
"""
from __future__ import annotations

import json
import logging
import os
import re
from collections import defaultdict
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

NIM_API_KEY = os.environ.get("NIM_API_KEY")
NIM_BASE_URL = os.environ.get("NIM_BASE_URL", "https://integrate.api.nvidia.com/v1")
NIM_MODEL = os.environ.get("NIM_MODEL", "nvidia/llama-3.1-nemotron-70b-instruct")
NIM_TIMEOUT = int(os.environ.get("NIM_TIMEOUT", "60"))
MIN_GROUP_SIZE = 2  # only rank when there's something to compare


def is_enabled() -> bool:
    return bool(NIM_API_KEY)


_PROMPT_HEADER = """You are a senior wedding videography editor.
Below are several clips that all belong to the same wedding moment / segment.
Rank them from best to worst for inclusion in the final cut, considering:
- Cinematic quality (composition, focus, lighting, motion)
- Emotional content (faces, reactions, key beats)
- Cleanliness (no mid-take cuts, no obvious flaws)
- Distinctness vs. the others (don't keep visually-redundant takes)

Return ONLY a JSON array of clip_ids in best-to-worst order, no prose:
["<clip_id_best>", ..., "<clip_id_worst>"]
"""


def _format_clip(c: Dict[str, Any]) -> str:
    parts = [f'- id: "{c["clip_id"]}"']
    parts.append(f"  filename: {c.get('filename', '')}")
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


def _rank_group(segment: str, clips: List[Dict[str, Any]]) -> Optional[List[str]]:
    """Send one group to NIM and return the ordered list of clip_ids.

    Imports `requests` lazily so the rest of the app works without it.
    """
    import requests  # noqa: WPS433  — lazy intentionally

    body = {
        "model": NIM_MODEL,
        "messages": [
            {
                "role": "system",
                "content": "You are a precise wedding-video selects assistant. "
                           "Always respond with valid JSON only.",
            },
            {
                "role": "user",
                "content": _PROMPT_HEADER
                           + f"\nSegment: {segment}\n\nClips:\n"
                           + "\n\n".join(_format_clip(c) for c in clips),
            },
        ],
        "temperature": 0.2,
        "max_tokens": 800,
        "response_format": {"type": "json_object"},
    }

    try:
        resp = requests.post(
            f"{NIM_BASE_URL}/chat/completions",
            headers={
                "Authorization": f"Bearer {NIM_API_KEY}",
                "Content-Type": "application/json",
            },
            json=body,
            timeout=NIM_TIMEOUT,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("NIM request failed for segment %s: %s", segment, exc)
        return None

    if resp.status_code != 200:
        logger.warning(
            "NIM HTTP %s for segment %s: %s",
            resp.status_code, segment, resp.text[:200],
        )
        return None

    try:
        data = resp.json()
        text = data["choices"][0]["message"]["content"].strip()
    except Exception as exc:  # noqa: BLE001
        logger.warning("NIM response shape unexpected: %s", exc)
        return None

    return _parse_order(text, valid_ids={c["clip_id"] for c in clips})


def _parse_order(text: str, valid_ids: set[str]) -> Optional[List[str]]:
    """Extract an ordered clip_id list from the model output."""
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.MULTILINE)

    # Try direct parse, accepting either a bare array or {"order": [...]}
    parsed: Any = None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\[.*?\]", text, re.DOTALL)
        if m:
            try:
                parsed = json.loads(m.group(0))
            except json.JSONDecodeError:
                pass

    if isinstance(parsed, dict):
        for key in ("order", "ranked", "clips", "result"):
            if key in parsed and isinstance(parsed[key], list):
                parsed = parsed[key]
                break

    if not isinstance(parsed, list):
        return None

    # Filter to valid ids, preserve order, dedupe
    seen: set[str] = set()
    out: List[str] = []
    for cid in parsed:
        if isinstance(cid, str) and cid in valid_ids and cid not in seen:
            out.append(cid)
            seen.add(cid)
    if not out:
        return None
    return out


def rerank_job(clip_reviews: List[Any]) -> int:
    """Group clips by ai_segment and rank each group via NIM.

    Mutates each ClipReview in place by setting `scores.rank_in_group`
    (1 = best, 2 = next, etc.). Returns the number of groups ranked.
    """
    if not is_enabled():
        logger.info("NIM_API_KEY not set; skipping cross-clip ranking.")
        return 0

    by_seg: Dict[str, List[Any]] = defaultdict(list)
    for c in clip_reviews:
        seg = c.scores.ai_segment or c.segment_label or "Backup"
        by_seg[seg].append(c)

    ranked_groups = 0
    for segment, group in by_seg.items():
        if len(group) < MIN_GROUP_SIZE:
            # Single-clip group: trivially rank 1
            for c in group:
                c.scores.rank_in_group = 1
            continue

        payload = [
            {
                "clip_id": c.clip_id,
                "filename": c.filename,
                "duration_sec": round(c.scores.duration_sec, 1),
                "ai_quality": c.scores.ai_quality,
                "ai_caption": c.scores.ai_caption,
                "transcript": c.scores.transcript,
                "subjects": c.scores.ai_subjects,
                "shake_score": c.scores.shake_score,
                "blur_score": c.scores.blur_score,
            }
            for c in group
        ]

        logger.info("NIM rank: %s (%d clips)", segment, len(group))
        order = _rank_group(segment, payload)
        if not order:
            logger.warning("NIM ranking failed for %s; leaving unranked", segment)
            continue

        rank_by_id = {cid: i + 1 for i, cid in enumerate(order)}
        # Any clip the model omitted gets last-place rank
        last_rank = len(order) + 1
        for c in group:
            c.scores.rank_in_group = rank_by_id.get(c.clip_id, last_rank)

        ranked_groups += 1

    return ranked_groups
