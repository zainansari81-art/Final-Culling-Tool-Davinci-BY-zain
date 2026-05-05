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


def rerank_job(clip_reviews: List[Any]) -> int:
    """Group clips by ai_segment, rank each group via Gemini.

    Mutates each ClipReview in place by setting `scores.rank_in_group`
    (1 = best, 2 = next, etc.). Returns the number of groups ranked.
    """
    import vertex_gemini

    by_seg: Dict[str, List[Any]] = defaultdict(list)
    for c in clip_reviews:
        seg = c.scores.ai_segment or c.segment_label or "Backup"
        by_seg[seg].append(c)

    ranked_groups = 0
    for segment, group in by_seg.items():
        if len(group) < MIN_GROUP_SIZE:
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

        logger.info("Gemini rank: %s (%d clips)", segment, len(group))
        order = vertex_gemini.rerank_segment(segment, payload)
        if not order:
            logger.warning("Gemini ranking failed for %s; leaving unranked", segment)
            continue

        rank_by_id = {cid: i + 1 for i, cid in enumerate(order)}
        last_rank = len(order) + 1
        for c in group:
            c.scores.rank_in_group = rank_by_id.get(c.clip_id, last_rank)

        ranked_groups += 1

    return ranked_groups
