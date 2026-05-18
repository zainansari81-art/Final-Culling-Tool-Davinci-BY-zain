"""Local equivalent of vertex_rerank.rerank_job.

Uses the weighted-sum scoring formula from the local-AI spec:

  score = 0.30*motion + 0.25*face + 0.20*audio
        + 0.15*semantic + 0.10*sharpness

Ranks within each ai_segment by composite score. Sequence order:
filename order if ≥50% clips have dialogue, otherwise composite-score order.

No cloud calls. No VLM. Pure deterministic from per-clip metrics.
"""

from __future__ import annotations

import logging
import re
from collections import defaultdict
from typing import Any, Dict, List

logger = logging.getLogger("analyzer")

MIN_GROUP_SIZE = 2
DIALOGUE_THRESHOLD = 0.5

W_MOTION = 0.30
W_FACE = 0.25
W_AUDIO = 0.20
W_SEMANTIC = 0.15
W_SHARP = 0.10


def _filename_sort_key(c: Any) -> tuple:
    name = c.filename or c.path or ""
    parts = re.split(r"(\d+)", name.lower())
    return tuple(int(p) if p.isdigit() else p for p in parts)


def _norm(x: float, lo: float, hi: float) -> float:
    if hi <= lo:
        return 0.0
    return max(0.0, min(1.0, (x - lo) / (hi - lo)))


def _composite_score(c: Any) -> float:
    s = c.scores
    # motion: prefer some movement but penalize shake; invert shake_score
    motion = 1.0 - _norm(s.shake_score or 0.0, 0.0, 1.0)
    # face: 1 if any subjects detected, else 0 (proxy until face detector lands)
    face = 1.0 if (s.ai_subjects and len(s.ai_subjects) > 0) else 0.0
    # audio: word count proxy
    audio = _norm(float(len(s.words or [])), 0.0, 30.0)
    # semantic: caption length proxy
    semantic = _norm(float(len(s.ai_caption or "")), 0.0, 120.0)
    # sharpness: inverse of blur
    sharp = 1.0 - _norm(s.blur_score or 0.0, 0.0, 1.0)
    return (
        W_MOTION * motion
        + W_FACE * face
        + W_AUDIO * audio
        + W_SEMANTIC * semantic
        + W_SHARP * sharp
    )


def rerank_job(clip_reviews: List[Any]) -> int:
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

        # 1) Quality rank by composite score (descending)
        scored = sorted(group, key=_composite_score, reverse=True)
        for i, c in enumerate(scored, start=1):
            c.scores.rank_in_group = i

        # 2) Sequence ordering
        with_dialogue = sum(1 for c in group if c.scores.words)
        use_filename_order = (with_dialogue / len(group)) >= DIALOGUE_THRESHOLD

        if use_filename_order:
            ordered = sorted(group, key=_filename_sort_key)
            confidence = 90.0
        else:
            ordered = scored  # fall back to quality-rank order on the timeline
            confidence = 50.0

        for i, c in enumerate(ordered, start=1):
            c.scores.sequence_position = i
            c.scores.placement_confidence = confidence

        processed_groups += 1

    return processed_groups
