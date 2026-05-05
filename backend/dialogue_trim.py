"""Dialogue-aware in/out point computation.

Given word-level timestamps from speech transcription, return clean cut
points that:
- Trim long pre-roll silence before the first word
- Trim long tail silence after the last word
- Never cut mid-utterance (keep short pauses inside)
- Pad with a small lead-in/out so the cut doesn't feel clipped

If there are no words (silent footage / no speech detected), returns the
clip's full range — the caller should fall back to AI/heuristic in/out.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import List, Optional, Tuple

logger = logging.getLogger(__name__)

# Tunables — overridable by env if you ever want to expose them
LEAD_IN_SEC = 0.4         # padding before first word
LEAD_OUT_SEC = 0.6        # padding after last word
MAX_INTERNAL_PAUSE = 2.0  # gaps longer than this would split the clip
MIN_KEEP_SEC = 1.0        # don't return absurdly short trims


@dataclass
class Word:
    word: str
    start: float
    end: float


def _to_words(words_in: List[dict]) -> List[Word]:
    out: List[Word] = []
    for w in words_in:
        try:
            out.append(Word(
                word=str(w["word"]).strip(),
                start=float(w["start_sec"]),
                end=float(w["end_sec"]),
            ))
        except (KeyError, TypeError, ValueError):
            continue
    out.sort(key=lambda x: x.start)
    return out


def trim_to_dialogue(
    words: List[dict],
    duration_sec: float,
    lead_in: float = LEAD_IN_SEC,
    lead_out: float = LEAD_OUT_SEC,
) -> Optional[Tuple[float, float]]:
    """Return (in_sec, out_sec) honoring dialogue, or None if not applicable.

    Returns None when:
    - No words at all (caller should keep AI/full-clip in/out)
    - Resulting trim would be shorter than MIN_KEEP_SEC
    """
    if duration_sec <= 0:
        return None
    ws = _to_words(words)
    if not ws:
        return None

    first = ws[0].start
    last = ws[-1].end

    in_s = max(0.0, first - lead_in)
    out_s = min(duration_sec, last + lead_out)

    if out_s - in_s < MIN_KEEP_SEC:
        return None

    return (round(in_s, 2), round(out_s, 2))


def find_internal_splits(
    words: List[dict],
    max_pause: float = MAX_INTERNAL_PAUSE,
) -> List[Tuple[float, float]]:
    """Identify long internal silences that could be split out.

    Returns a list of (gap_start, gap_end) for pauses longer than max_pause.
    Useful for future feature: cut a single clip into multiple sub-clips at
    natural sentence breaks. Currently exposed for inspection / logging only.
    """
    ws = _to_words(words)
    if len(ws) < 2:
        return []
    gaps: List[Tuple[float, float]] = []
    for i in range(1, len(ws)):
        gap = ws[i].start - ws[i - 1].end
        if gap >= max_pause:
            gaps.append((ws[i - 1].end, ws[i].start))
    return gaps
