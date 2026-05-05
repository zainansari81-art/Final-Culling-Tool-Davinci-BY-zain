"""Cross-clip ranking via Gemini on Vertex.

After all clips are analyzed, group them by ai_segment and ask Gemini to
rank takes within each group. Marks each clip's `scores.rank_in_group`
(1 = best) so the UI/export can prefer winners.

Reuses the same Vertex Gemini client as vertex_gemini.py — no extra auth,
no extra vendor.
"""
from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

MIN_GROUP_SIZE = 2  # only rank when there's something to compare


# When more than this fraction of clips in a segment have detected speech,
# we treat the whole segment as "dialogue-driven" and order by filename
# (capture order ≈ dialogue order) instead of asking Gemini to reorder.
DIALOGUE_THRESHOLD = 0.5


def _filename_sort_key(c: Any) -> tuple:
    """Stable, natural-ish sort by file path so C0001 < C0010."""
    import re as _re
    name = c.filename or c.path or ""
    # Pad numeric runs to allow natural sort (C0001 vs C0010)
    parts = _re.split(r"(\d+)", name.lower())
    return tuple(int(p) if p.isdigit() else p for p in parts)


def rerank_job(clip_reviews: List[Any]) -> int:
    """Group clips by ai_segment, then within each group:
        1) Rank takes by quality → scores.rank_in_group (1 = best take)
        2) Order clips for the timeline → scores.sequence_position

    For dialogue-heavy segments (>50% clips have detected speech) the
    sequence is filename order (capture order ≈ conversation order).
    For visually-narrative segments (drone, BTS, ceremony cutaways) we
    ask Gemini to order by narrative flow.

    Returns the number of groups processed.
    """
    import vertex_gemini

    by_seg: Dict[str, List[Any]] = defaultdict(list)
    for c in clip_reviews:
        seg = c.scores.ai_segment or c.segment_label or "Backup"
        by_seg[seg].append(c)

    processed_groups = 0
    for segment, group in by_seg.items():
        if len(group) < MIN_GROUP_SIZE:
            for c in group:
                c.scores.rank_in_group = 1
                c.scores.sequence_position = 1
            continue

        # Decide ordering strategy up front
        with_dialogue = sum(1 for c in group if c.scores.words)
        dialogue_ratio = with_dialogue / len(group)
        use_filename_order = dialogue_ratio >= DIALOGUE_THRESHOLD

        payload = [
            {
                "clip_id": c.clip_id,
                "filename": c.filename,
                "duration_sec": round(c.scores.duration_sec, 1),
                "ai_quality": c.scores.ai_quality,
                "ai_caption": c.scores.ai_caption,
                "ai_moment": c.scores.ai_moment,
                "transcript": (c.scores.transcript or "")[:400],
                "subjects": c.scores.ai_subjects,
                "shake_score": c.scores.shake_score,
                "blur_score": c.scores.blur_score,
                "has_dialogue": bool(c.scores.words),
            }
            for c in group
        ]

        # 1) Rank by quality (always via Gemini — nothing else to use)
        logger.info("Gemini rank: %s (%d clips)", segment, len(group))
        rank_order = vertex_gemini.rerank_segment(segment, payload)
        if rank_order:
            rank_by_id = {cid: i + 1 for i, cid in enumerate(rank_order)}
            last = len(rank_order) + 1
            for c in group:
                c.scores.rank_in_group = rank_by_id.get(c.clip_id, last)
        else:
            logger.warning("Gemini ranking failed for %s", segment)

        # 2) Sequence ordering for the timeline
        if use_filename_order:
            logger.info(
                "Filename order for %s (%d/%d have dialogue)",
                segment, with_dialogue, len(group),
            )
            ordered = sorted(group, key=_filename_sort_key)
            for i, c in enumerate(ordered, start=1):
                c.scores.sequence_position = i
        else:
            logger.info(
                "Gemini sequence: %s (%d/%d have dialogue)",
                segment, with_dialogue, len(group),
            )
            seq_order = vertex_gemini.order_segment(segment, payload)
            if seq_order:
                seq_by_id = {cid: i + 1 for i, cid in enumerate(seq_order)}
                last = len(seq_order) + 1
                for c in group:
                    c.scores.sequence_position = seq_by_id.get(c.clip_id, last)
            else:
                logger.warning(
                    "Gemini sequence failed for %s — falling back to filename order",
                    segment,
                )
                ordered = sorted(group, key=_filename_sort_key)
                for i, c in enumerate(ordered, start=1):
                    c.scores.sequence_position = i

        processed_groups += 1

    return processed_groups
