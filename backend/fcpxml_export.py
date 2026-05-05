# fcpxml_export.py — FCPXML 1.10 fallback export for Premiere / Final Cut Pro.
#
# Generates valid FCPXML 1.10 with:
#   - One event per unique segment label (approved clips only)
#   - One project with a primary storyline containing approved clips in segment order
#   - Clip colour roles mapped by segment via marker attributes
#
# Usage:
#   export_to_fcpxml(job, output_path="/path/to/output.fcpxml")

from __future__ import annotations

import logging
import os
import re
import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path
from typing import Dict, List

from models import AnalysisJob, ClipReview

logger = logging.getLogger(__name__)

# FCPXML rational timebase — 90000 ticks/s is universally safe
TIMEBASE = 90000

# Segment ordering for the primary storyline (wedding-day chronology).
# Includes both new canonical names (from Vertex AI) and legacy regex labels.
SEGMENT_ORDER = [
    "Bride Getting Ready",
    "Groomsmen Getting Ready",
    "Groomsmen",
    "First Look",
    "Ceremony",
    "Cocktail Hour",
    "Cocktail",
    "Reception / First Dance",
    "First Dance",
    "Toasts",
    "Drone / Aerial",
    "Drone",
    "Ambiance / BTS",
    "Ambiance",
    "Backup",
]

# Marker colour hints per segment (FCP ignores unknown attrs)
SEGMENT_MARKER_COLORS: Dict[str, str] = {
    "Groomsmen Getting Ready": "blue",
    "Groomsmen":               "blue",
    "Bride Getting Ready":     "red",
    "First Look":              "yellow",
    "Ceremony":                "green",
    "Cocktail Hour":           "orange",
    "Cocktail":                "orange",
    "Reception / First Dance": "purple",
    "First Dance":             "purple",
    "Toasts":                  "red",
    "Drone / Aerial":          "green",
    "Drone":                   "green",
    "Ambiance / BTS":          "blue",
    "Ambiance":                "blue",
    "Backup":                  "white",
}


# ── Helpers ──────────────────────────────────────────────────────────────────

def _ticks(seconds: float) -> str:
    """Convert seconds to FCPXML rational string e.g. '900000/90000s'."""
    return f"{int(round(seconds * TIMEBASE))}/{TIMEBASE}s"


def _safe_id(text: str) -> str:
    """Make a string safe for use as an XML id attribute."""
    return re.sub(r"[^a-zA-Z0-9_-]", "_", text)[:64]


def _text_style(caption: str) -> ET.Element:
    """Build a <text-style> element wrapping the caption (FCPXML title body)."""
    style = ET.Element("text-style", ref="ts_caption")
    style.text = caption
    return style


def _approved_by_segment(job: AnalysisJob) -> Dict[str, List[ClipReview]]:
    groups: Dict[str, List[ClipReview]] = {}
    for clip in job.clips:
        if clip.approved:
            seg = clip.segment_label or "Backup"
            groups.setdefault(seg, []).append(clip)
    # Within each segment, prefer AI-determined narrative order; clips
    # without sequence_position go last in path-sorted order.
    for seg, clips in groups.items():
        clips.sort(key=lambda c: (
            c.scores.sequence_position if c.scores.sequence_position is not None else 1_000_000,
            c.path.lower(),
        ))
    return groups


def _trim_window(clip: ClipReview) -> tuple[float, float]:
    """Return (in_sec, out_sec) honoring AI suggestion when present.

    Falls back to the full clip if AI didn't run or values are out of bounds.
    """
    s = clip.scores
    total = max(0.0, float(s.duration_sec or 0.0))
    in_s = float(s.ai_in_sec) if s.ai_in_sec is not None else 0.0
    out_s = float(s.ai_out_sec) if s.ai_out_sec is not None else total

    in_s = max(0.0, min(in_s, total))
    out_s = max(in_s + 0.1, min(out_s, total)) if total > 0 else 0.0
    return in_s, out_s


# ── FCPXML builder ────────────────────────────────────────────────────────────

def _build_fcpxml(job: AnalysisJob, project_name: str) -> str:
    """
    Build and return a complete FCPXML 1.10 document as a UTF-8 string.

    Structure:
      fcpxml
        resources
          format r0  (1080p/24fps default)
          asset r_{clip_id} per approved clip
        library
          event "{segment_label}"  — one per unique segment
            project "Selects"
              sequence
                spine
                  clip ... (clips in SEGMENT_ORDER)
    """
    groups = _approved_by_segment(job)
    approved_ordered: List[ClipReview] = []
    for seg in SEGMENT_ORDER:
        approved_ordered.extend(groups.get(seg, []))
    # Any segments not in the ordered list get appended at the end
    for seg, clips in groups.items():
        if seg not in SEGMENT_ORDER:
            approved_ordered.extend(clips)

    root = ET.Element("fcpxml", version="1.10")

    # ── Resources ──────────────────────────────────────────────────────────
    resources = ET.SubElement(root, "resources")
    ET.SubElement(
        resources, "format",
        id="r0",
        name="FFVideoFormat1080p24",
        frameDuration="100/2400s",
        width="1920",
        height="1080",
        colorSpace="1-1-1 (Rec. 709)",
    )

    asset_id_map: Dict[str, str] = {}
    for clip in approved_ordered:
        asset_id = f"r_{_safe_id(clip.clip_id)}"
        asset_id_map[clip.clip_id] = asset_id
        file_url = Path(clip.path).as_uri()
        dur_str = _ticks(clip.scores.duration_sec) if clip.scores.duration_sec else "0s"

        asset = ET.SubElement(
            resources, "asset",
            id=asset_id,
            name=clip.filename,
            src=file_url,
            start="0s",
            duration=dur_str,
            hasVideo="1",
            hasAudio="1",
            format="r0",
        )
        ET.SubElement(asset, "media-rep",
                      kind="original-media", src=file_url)

    # Title generator effect (Basic Title) — used for caption overlays.
    # Premiere/FCP both ship with a "Basic Title" generator at this UID.
    ET.SubElement(
        resources, "effect",
        id="r_title",
        name="Basic Title",
        uid=".../Titles.localized/Basic Text.localized/Basic Title.localized/Basic Title.moti",
    )

    # ── Library → one event per segment ───────────────────────────────────
    dated_name = f"{project_name}_{date.today().isoformat()}"
    library = ET.SubElement(root, "library")

    # Also build the master "Selects" project under the first event
    # (most NLEs treat the first project as the entry point)
    first_event = None

    for seg in ([s for s in SEGMENT_ORDER if s in groups] +
                [s for s in groups if s not in SEGMENT_ORDER]):
        event = ET.SubElement(library, "event", name=seg)
        if first_event is None:
            first_event = event

    # If nothing was approved, emit an empty library and bail
    if first_event is None:
        logger.warning("No approved clips — FCPXML will be empty.")
        ET.indent(root, space="  ")
        return '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(
            root, encoding="unicode", xml_declaration=False
        )

    # ── Selects project lives inside the first event ───────────────────────
    project = ET.SubElement(first_event, "project", name=dated_name)
    total_sec = sum(c.scores.duration_sec for c in approved_ordered)
    sequence = ET.SubElement(
        project, "sequence",
        duration=_ticks(total_sec),
        format="r0",
        tcStart="0s",
        tcFormat="NDF",
        audioLayout="stereo",
        audioRate="48k",
    )
    spine = ET.SubElement(sequence, "spine")

    current_offset = 0.0
    for clip in approved_ordered:
        asset_id = asset_id_map.get(clip.clip_id)
        if not asset_id:
            continue

        seg = clip.segment_label or "Backup"
        in_s, out_s = _trim_window(clip)
        dur = max(0.04, out_s - in_s)  # at least one frame at 24fps

        clip_elem = ET.SubElement(
            spine, "clip",
            name=clip.filename,
            offset=_ticks(current_offset),
            duration=_ticks(dur),
            start="0s",
            format="r0",
        )
        # asset-clip 'start' = source-media in-point; outer 'duration' = trim length
        ET.SubElement(
            clip_elem, "asset-clip",
            ref=asset_id,
            offset="0s",
            duration=_ticks(dur),
            start=_ticks(in_s),
            audioRole="dialogue",
        )
        # Segment marker (colour is a non-standard extension hint)
        marker = ET.SubElement(
            clip_elem, "marker",
            start="0s",
            duration="1/24s",
            value=seg,
            note=f"Segment: {seg}" + (
                f" · AI quality {clip.scores.ai_quality:.1f}/10"
                if clip.scores.ai_quality is not None else ""
            ),
        )
        marker.set("color", SEGMENT_MARKER_COLORS.get(seg, "white"))

        # Caption as a connected title (visible text overlay on timeline)
        caption_text = clip.scores.ai_caption or clip.scores.ai_moment
        if caption_text:
            title = ET.SubElement(
                clip_elem, "title",
                ref="r_title",
                offset="0s",
                start="0s",
                duration=_ticks(dur),
                lane="1",
                name=(clip.scores.ai_moment or "Caption")[:60],
            )
            ET.SubElement(title, "text").append(_text_style(caption_text[:200]))
            # Marker echo so the caption is also visible without rendering titles
            note_marker = ET.SubElement(
                clip_elem, "marker",
                start=_ticks(min(0.5, dur / 2)),
                duration="1/24s",
                value=(clip.scores.ai_moment or "Caption")[:60],
                note=caption_text[:200],
            )
            note_marker.set("color", "blue")

        current_offset += dur

    # ── Serialise ──────────────────────────────────────────────────────────
    ET.indent(root, space="  ")
    body = ET.tostring(root, encoding="unicode", xml_declaration=False)
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + body


# ── Public API ────────────────────────────────────────────────────────────────

def export_to_fcpxml(job: AnalysisJob, output_path: str) -> str:
    """
    Write FCPXML 1.10 to output_path.
    Creates parent directories as needed.
    Returns the absolute path of the written file.
    """
    if not output_path:
        raise ValueError("output_path must be a non-empty string.")

    abs_path = os.path.abspath(output_path)
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)

    project_name = Path(abs_path).stem  # use filename (without ext) as project name
    xml_content = _build_fcpxml(job, project_name)

    with open(abs_path, "w", encoding="utf-8") as fh:
        fh.write(xml_content)

    logger.info("FCPXML written to %s", abs_path)
    return abs_path
