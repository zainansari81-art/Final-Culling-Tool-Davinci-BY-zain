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
    # When deep analysis produced sub_segments for a clip, place ONLY those
    # segments on the timeline (not the whole clip). The Resolve scripting
    # API accepts either a raw MediaPoolItem or a dict with mediaPoolItem,
    # startFrame, endFrame (frame numbers, computed from the clip's fps).
    media_pool.SetCurrentFolder(root_bin)
    timeline = media_pool.CreateEmptyTimeline("Selects")

    # Build lookup: file_path -> ClipReview, file_path -> MediaPoolItem
    review_by_path: Dict[str, ClipReview] = {c.path: c for c in job.clips}
    imported_by_path: Dict[str, object] = {}
    for segment, clips in imported.items():
        for rc in clips:
            try:
                p = rc.GetClipProperty("File Path")
                if p:
                    imported_by_path[p] = rc
            except Exception:  # noqa: BLE001
                pass

    appended_segments = 0
    if timeline is None:
        logger.warning("Could not create 'Selects' timeline.")
    else:
        for segment in SEGMENT_ORDER:
            for rc in imported.get(segment, []):
                try:
                    file_path = rc.GetClipProperty("File Path")
                except Exception:  # noqa: BLE001
                    file_path = None
                review = review_by_path.get(file_path) if file_path else None
                sub_segments = review.scores.sub_segments if review and review.scores.sub_segments else None

                if sub_segments and len(sub_segments) > 0:
                    # Use frame-accurate in/out points per sub-segment
                    try:
                        fps_str = rc.GetClipProperty("FPS") or "24"
                        fps = float(fps_str) if fps_str else 24.0
                    except Exception:  # noqa: BLE001
                        fps = 24.0
                    for seg in sub_segments:
                        try:
                            start_frame = max(0, int(round(seg.start_sec * fps)))
                            end_frame = max(start_frame + 1, int(round(seg.end_sec * fps)))
                            media_pool.AppendToTimeline([{
                                "mediaPoolItem": rc,
                                "startFrame": start_frame,
                                "endFrame": end_frame,
                            }])
                            appended_segments += 1
                        except Exception as exc:  # noqa: BLE001
                            logger.warning(
                                "AppendToTimeline (sub-segment %.1f-%.1fs) failed: %s",
                                seg.start_sec, seg.end_sec, exc,
                            )
                else:
                    # No sub-segments — fall back to the whole clip
                    try:
                        media_pool.AppendToTimeline([rc])
                        appended_segments += 1
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("AppendToTimeline failed: %s", exc)

    # ── Highlights timeline (best-of-the-best segments only) ─────────────
    # Built from sub-segments where is_highlight=True. Skipped if no
    # segments qualify or no clip has sub_segments at all (shallow mode).
    highlight_items_appended = 0
    media_pool.SetCurrentFolder(root_bin)
    highlight_timeline = media_pool.CreateEmptyTimeline("Highlights")
    if highlight_timeline is not None:
        # Collect highlight-eligible segments in segment order, but ranked
        # by quality within each segment so the strongest moments lead.
        for segment in SEGMENT_ORDER:
            seg_picks: list = []
            for rc in imported.get(segment, []):
                try:
                    file_path = rc.GetClipProperty("File Path")
                    fps_str = rc.GetClipProperty("FPS") or "24"
                    fps = float(fps_str) if fps_str else 24.0
                except Exception:  # noqa: BLE001
                    file_path, fps = None, 24.0
                review = review_by_path.get(file_path) if file_path else None
                if not review or not review.scores.sub_segments:
                    continue
                for sub in review.scores.sub_segments:
                    if not sub.is_highlight:
                        continue
                    # Rank by AI score when available (it's the editorial call);
                    # fall back to metric-derived highlight_quality.
                    rank = sub.ai_score / 10.0 if sub.ai_score is not None else sub.highlight_quality
                    seg_picks.append((rank, rc, sub, fps))
            # Best moments first within each wedding segment
            seg_picks.sort(key=lambda x: -x[0])
            for _q, rc, sub, fps in seg_picks:
                try:
                    start_frame = max(0, int(round(sub.start_sec * fps)))
                    end_frame = max(start_frame + 1, int(round(sub.end_sec * fps)))
                    media_pool.AppendToTimeline([{
                        "mediaPoolItem": rc,
                        "startFrame": start_frame,
                        "endFrame": end_frame,
                    }])
                    highlight_items_appended += 1
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "Highlights AppendToTimeline (%.1f-%.1fs) failed: %s",
                        sub.start_sec, sub.end_sec, exc,
                    )

    total_imported = sum(len(v) for v in imported.values())
    return {
        "success": True,
        "project_name": dated_name,
        "clips_imported": total_imported,
        "selects_timeline_items": appended_segments,
        "highlights_timeline_items": highlight_items_appended,
        "segments": list(groups.keys()),
    }
