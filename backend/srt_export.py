"""SRT subtitle export.

Generates a .srt file alongside FCPXML/Resolve exports. Two modes:

1. **Word-timed** (when speech was transcribed): each line is a phrase made
   up of consecutive words, broken on natural pauses or every ~7 words.
2. **Caption fallback** (no speech): one subtitle per clip showing the AI
   caption for the clip's full duration.

The resulting SRT can be drag-imported into any NLE. Resolve has a direct
"Import Subtitle" command; Premiere reads it as a captions track.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import List

from models import AnalysisJob, ClipReview, WordInfo

logger = logging.getLogger(__name__)

# Tunables
WORDS_PER_LINE = 7
PAUSE_BREAK_SEC = 0.7
MIN_LINE_DUR = 0.8
MAX_LINE_DUR = 6.0


def _fmt_ts(seconds: float) -> str:
    """SRT timestamp HH:MM:SS,mmm"""
    if seconds < 0:
        seconds = 0.0
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int(round((seconds - int(seconds)) * 1000))
    if ms == 1000:
        s += 1
        ms = 0
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _approved_in_export_order(job: AnalysisJob) -> List[ClipReview]:
    """Same ordering as the FCPXML/Resolve exporters."""
    from fcpxml_export import SEGMENT_ORDER, _approved_by_segment
    groups = _approved_by_segment(job)
    out: List[ClipReview] = []
    for seg in SEGMENT_ORDER:
        out.extend(groups.get(seg, []))
    for seg, clips in groups.items():
        if seg not in SEGMENT_ORDER:
            out.extend(clips)
    return out


def _group_words_into_lines(
    words: List[WordInfo],
    clip_offset_sec: float,
    clip_in_sec: float,
    clip_out_sec: float,
) -> List[tuple[float, float, str]]:
    """Group consecutive words into subtitle lines.

    Returns [(timeline_start, timeline_end, text), ...].
    Words outside [clip_in, clip_out] are skipped.
    Times are translated from clip-local to timeline-relative by adding
    clip_offset_sec - clip_in_sec.
    """
    lines: List[tuple[float, float, str]] = []
    bucket: List[WordInfo] = []

    def flush():
        if not bucket:
            return
        first, last = bucket[0], bucket[-1]
        text = " ".join(w.word for w in bucket).strip()
        if not text:
            return
        # Translate clip-local time to timeline time
        tl_start = clip_offset_sec + (first.start_sec - clip_in_sec)
        tl_end = clip_offset_sec + (last.end_sec - clip_in_sec)
        # Enforce min duration
        if tl_end - tl_start < MIN_LINE_DUR:
            tl_end = tl_start + MIN_LINE_DUR
        # Enforce max duration
        if tl_end - tl_start > MAX_LINE_DUR:
            tl_end = tl_start + MAX_LINE_DUR
        lines.append((tl_start, tl_end, text))

    for w in words:
        if w.end_sec <= clip_in_sec or w.start_sec >= clip_out_sec:
            continue

        if not bucket:
            bucket.append(w)
            continue

        gap = w.start_sec - bucket[-1].end_sec
        # Break on long pause OR length cap
        if gap >= PAUSE_BREAK_SEC or len(bucket) >= WORDS_PER_LINE:
            flush()
            bucket = [w]
        else:
            bucket.append(w)

    flush()
    return lines


def build_srt(job: AnalysisJob) -> str:
    """Build SRT content as a string, ready to write to disk."""
    clips = _approved_in_export_order(job)
    if not clips:
        return ""

    lines: List[tuple[float, float, str]] = []
    cursor = 0.0  # timeline cursor in seconds

    for clip in clips:
        s = clip.scores
        in_s = float(s.ai_in_sec) if s.ai_in_sec is not None else 0.0
        out_s = float(s.ai_out_sec) if s.ai_out_sec is not None else float(s.duration_sec or 0.0)
        if out_s <= in_s:
            continue
        clip_dur = out_s - in_s

        if s.words:
            word_lines = _group_words_into_lines(s.words, cursor, in_s, out_s)
            lines.extend(word_lines)
        elif s.ai_caption:
            # Fallback: one caption for the full clip slot
            lines.append((cursor, cursor + clip_dur, s.ai_caption))

        cursor += clip_dur

    if not lines:
        return ""

    out: List[str] = []
    for i, (start, end, text) in enumerate(lines, start=1):
        out.append(str(i))
        out.append(f"{_fmt_ts(start)} --> {_fmt_ts(end)}")
        out.append(text.strip())
        out.append("")
    return "\n".join(out).strip() + "\n"


def export_srt(job: AnalysisJob, output_path: str) -> str:
    """Write SRT to disk. Returns absolute path."""
    abs_path = os.path.abspath(output_path)
    os.makedirs(os.path.dirname(abs_path) or ".", exist_ok=True)
    content = build_srt(job)
    if not content:
        logger.info("No subtitle content to write (no AI/speech data)")
        # Still write empty file so caller can detect; or return empty path
        return ""
    with open(abs_path, "w", encoding="utf-8") as fh:
        fh.write(content)
    logger.info("SRT written to %s", abs_path)
    return abs_path
