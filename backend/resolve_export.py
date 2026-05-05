# resolve_export.py — DaVinci Resolve integration via its Python scripting API.
#
# Resolve must already be running and have scripting enabled:
#   Preferences -> System -> General -> "Enable scripting API"
#
# This module imports DaVinciResolveScript at call-time (lazy) so the FastAPI
# server starts cleanly even when Resolve is not installed.

from __future__ import annotations

import logging
import sys
from datetime import date
from typing import Dict, List

from models import AnalysisJob, ClipReview

logger = logging.getLogger(__name__)

# ── Resolve scripting module search paths (Mac-only) ────────────────────────
RESOLVE_SCRIPT_PATH = (
    "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting"
)
RESOLVE_MODULE_PATH = f"{RESOLVE_SCRIPT_PATH}/Modules"

# ── Segment -> clip colour mapping (Resolve colour names) ───────────────────
# Includes both new canonical segments (from Vertex AI) and legacy regex labels.
SEGMENT_COLORS: Dict[str, str] = {
    "Groomsmen Getting Ready": "Teal",
    "Groomsmen":               "Teal",
    "Bride Getting Ready":     "Pink",
    "Drone / Aerial":          "Green",
    "Drone":                   "Green",
    "Ceremony":                "Blue",
    "First Look":              "Beige",
    "Reception / First Dance": "Violet",
    "First Dance":             "Violet",
    "Cocktail Hour":           "Tan",
    "Cocktail":                "Tan",
    "Toasts":                  "Purple",
    "Ambiance / BTS":          "Apricot",
    "Ambiance":                "Apricot",
    "Backup":                  "Sand",
}

# Wedding-day chronological ordering used for the Selects timeline
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


# ── Helpers ──────────────────────────────────────────────────────────────────

def _load_resolve():
    """Import DaVinciResolveScript and return a live Resolve handle."""
    if RESOLVE_MODULE_PATH not in sys.path:
        sys.path.insert(0, RESOLVE_MODULE_PATH)

    try:
        import DaVinciResolveScript as dvr_script  # type: ignore[import]
    except ImportError as exc:
        raise RuntimeError(
            "DaVinciResolveScript could not be imported. "
            "Ensure DaVinci Resolve is installed and scripting is enabled "
            "(Preferences -> System -> General -> Enable scripting API)."
        ) from exc

    resolve = dvr_script.scriptapp("Resolve")
    if resolve is None:
        raise RuntimeError(
            "DaVinci Resolve must be running before exporting."
        )
    return resolve


def _approved_by_segment(job: AnalysisJob) -> Dict[str, List[ClipReview]]:
    """Return {segment_label: [clip, ...]} for approved clips only,
    ordered by AI narrative sequence within each segment."""
    groups: Dict[str, List[ClipReview]] = {}
    for clip in job.clips:
        if clip.approved:
            seg = clip.segment_label or "Backup"
            groups.setdefault(seg, []).append(clip)
    for seg, clips in groups.items():
        clips.sort(key=lambda c: (
            c.scores.sequence_position if c.scores.sequence_position is not None else 1_000_000,
            c.path.lower(),
        ))
    return groups


# ── Main export ───────────────────────────────────────────────────────────────

def export_to_resolve(job: AnalysisJob, project_name: str) -> Dict[str, object]:
    """
    Export approved clips into a new DaVinci Resolve project:
      1. Connect to the running Resolve instance.
      2. Create a new project named {project_name}_{YYYY-MM-DD}.
      3. Create one bin per segment label.
      4. Import each approved clip into its bin.
      5. Apply clip colour labels from SEGMENT_COLORS.
      6. Build a "Selects" timeline with all approved clips in segment order.

    Returns a result dict or raises RuntimeError with a clear message.
    """
    resolve = _load_resolve()

    project_manager = resolve.GetProjectManager()
    if project_manager is None:
        raise RuntimeError("Could not access Resolve ProjectManager.")

    dated_name = f"{project_name}_{date.today().isoformat()}"

    project = project_manager.CreateProject(dated_name)
    if project is None:
        # Project name may already exist — try loading it instead
        logger.warning("Project '%s' already exists; loading it.", dated_name)
        project = project_manager.LoadProject(dated_name)
    if project is None:
        raise RuntimeError(f"Failed to create or load Resolve project '{dated_name}'.")

    media_pool = project.GetMediaPool()
    if media_pool is None:
        raise RuntimeError("Could not access MediaPool for project.")

    root_bin = media_pool.GetRootFolder()
    groups = _approved_by_segment(job)

    if not groups:
        return {
            "success": True,
            "project_name": dated_name,
            "message": "No approved clips to export.",
        }

    # ── Create bins and import ─────────────────────────────────────────────
    imported: Dict[str, list] = {}

    for segment in SEGMENT_ORDER:
        if segment not in groups:
            continue

        bin_folder = media_pool.AddSubFolder(root_bin, segment)
        if bin_folder is None:
            logger.warning("Could not create bin '%s'; importing to root.", segment)
            bin_folder = root_bin

        media_pool.SetCurrentFolder(bin_folder)

        file_paths = [c.path for c in groups[segment]]
        resolve_clips = media_pool.ImportMedia(file_paths) or []
        imported[segment] = resolve_clips

        colour = SEGMENT_COLORS.get(segment, "Sand")
        for rc in resolve_clips:
            try:
                rc.SetClipColor(colour)
            except Exception as exc:  # noqa: BLE001
                logger.warning("SetClipColor failed: %s", exc)

    # ── Selects timeline ───────────────────────────────────────────────────
    # Uses AI-suggested in/out points when available (subclip on append) so
    # the editor sees only the keep-portion of each clip. Falls back to full
    # clips when AI didn't run.
    media_pool.SetCurrentFolder(root_bin)
    timeline = media_pool.CreateEmptyTimeline("Selects")

    # Pair every imported MediaPoolItem with the originating ClipReview so we
    # can pull AI in/out and the per-clip note when appending.
    pairs_by_segment: Dict[str, list] = {}
    for segment, clips in groups.items():
        items = imported.get(segment, [])
        # Resolve doesn't guarantee order, but ImportMedia returns in input
        # order in current versions. Best-effort align by position.
        pairs_by_segment[segment] = list(zip(clips, items))

    if timeline is None:
        logger.warning("Could not create 'Selects' timeline.")
    else:
        timeline_cursor_frames = 0
        timeline_fps = _timeline_fps(timeline)

        for segment in (
            [s for s in SEGMENT_ORDER if s in pairs_by_segment]
            + [s for s in pairs_by_segment if s not in SEGMENT_ORDER]
        ):
            seg_color = SEGMENT_COLORS.get(segment, "Sand")
            for clip_review, mp_item in pairs_by_segment.get(segment, []):
                if mp_item is None:
                    continue
                try:
                    fps = _clip_fps(mp_item)
                    s = clip_review.scores
                    if s.ai_in_sec is not None and s.ai_out_sec is not None:
                        in_frame = max(0, int(round(s.ai_in_sec * fps)))
                        out_frame = max(
                            in_frame + 1, int(round(s.ai_out_sec * fps)),
                        )
                        clip_dur_sec = max(0.04, s.ai_out_sec - s.ai_in_sec)
                        media_pool.AppendToTimeline([{
                            "mediaPoolItem": mp_item,
                            "startFrame": in_frame,
                            "endFrame": out_frame,
                        }])
                    else:
                        clip_dur_sec = max(0.04, s.duration_sec or 0.0)
                        media_pool.AppendToTimeline([mp_item])

                    # Drop a marker on the timeline at this clip's start so
                    # the editor sees segment + caption inline.
                    caption = (
                        s.ai_caption
                        or s.ai_moment
                        or clip_review.filename
                    )
                    label = f"{segment} · {caption}"[:120]
                    note = caption
                    try:
                        timeline.AddMarker(
                            timeline_cursor_frames,
                            seg_color,
                            label,
                            note,
                            1,
                            "",  # customColor (empty = use named)
                        )
                    except Exception as exc:  # noqa: BLE001
                        logger.debug("AddMarker failed: %s", exc)

                    timeline_cursor_frames += int(round(clip_dur_sec * timeline_fps))
                except Exception as exc:  # noqa: BLE001
                    logger.warning("AppendToTimeline failed: %s", exc)

    total_imported = sum(len(v) for v in imported.values())
    return {
        "success": True,
        "project_name": dated_name,
        "clips_imported": total_imported,
        "segments": list(groups.keys()),
    }


def _clip_fps(mp_item) -> float:
    """Best-effort frame-rate read from a Resolve MediaPoolItem."""
    try:
        fps_raw = mp_item.GetClipProperty("FPS")
        if fps_raw:
            return float(fps_raw)
    except Exception:  # noqa: BLE001
        pass
    return 24.0  # safe default


def _timeline_fps(timeline) -> float:
    """Best-effort frame-rate read from a Resolve Timeline."""
    try:
        setting = timeline.GetSetting("timelineFrameRate")
        if setting:
            return float(setting)
    except Exception:  # noqa: BLE001
        pass
    return 24.0
