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
SEGMENT_COLORS: Dict[str, str] = {
    "Groomsmen":            "Teal",
    "Bride Getting Ready":  "Pink",
    "Drone":                "Green",
    "Ceremony":             "Blue",
    "First Look":           "Beige",
    "First Dance":          "Violet",
    "Cocktail":             "Tan",
    "Toasts":               "Purple",
    "Ambiance":             "Apricot",
    "Backup":               "Sand",
}

# Wedding-day chronological ordering used for the Selects timeline
SEGMENT_ORDER = [
    "Bride Getting Ready",
    "Groomsmen",
    "First Look",
    "Ceremony",
    "Cocktail",
    "First Dance",
    "Toasts",
    "Drone",
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
    """Return {segment_label: [clip, ...]} for approved clips only."""
    groups: Dict[str, List[ClipReview]] = {}
    for clip in job.clips:
        if clip.approved:
            seg = clip.segment_label or "Backup"
            groups.setdefault(seg, []).append(clip)
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
    media_pool.SetCurrentFolder(root_bin)
    timeline = media_pool.CreateEmptyTimeline("Selects")

    if timeline is None:
        logger.warning("Could not create 'Selects' timeline.")
    else:
        for segment in SEGMENT_ORDER:
            for rc in imported.get(segment, []):
                try:
                    media_pool.AppendToTimeline([rc])
                except Exception as exc:  # noqa: BLE001
                    logger.warning("AppendToTimeline failed: %s", exc)

    total_imported = sum(len(v) for v in imported.values())
    return {
        "success": True,
        "project_name": dated_name,
        "clips_imported": total_imported,
        "segments": list(groups.keys()),
    }
