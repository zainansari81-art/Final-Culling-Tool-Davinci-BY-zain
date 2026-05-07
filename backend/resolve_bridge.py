"""DaVinci Resolve bridge — push a job's selects into the user's active project.

Used by the Workspace > Scripts plugin entry point. Unlike
backend/resolve_export.py (which creates a brand-new project), this
module attaches to whatever project Resolve currently has open and
adds a new timeline named after the job.

Cross-platform DaVinciResolveScript discovery:
  macOS    /Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting
  Windows  %PROGRAMDATA%/Blackmagic Design/DaVinci Resolve/Support/Developer/Scripting
  Linux    /opt/resolve/Developer/Scripting

Marker color convention:
  Green   approved
  Yellow  near_miss
  Red     rejected (only used when include_rejected=True)

Public API:
    push_job(job, mode="new_timeline", include_near_miss=True,
             include_rejected=False) -> Dict[str, Any]

`job` is the AnalysisJob pydantic model populated in main.py jobs dict.
Returns a dict the REST route can serialize:
  {ok, project_name, timeline_name, clips_added, clips_skipped, errors:[...]}
"""

from __future__ import annotations

import logging
import os
import platform
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("analyzer")


# ───────────────────────── DaVinciResolveScript discovery ───────────────────

def _resolve_script_paths() -> List[Path]:
    sysname = platform.system()
    if sysname == "Darwin":
        return [
            Path("/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting"),
        ]
    if sysname == "Windows":
        program_data = os.environ.get("PROGRAMDATA", r"C:\ProgramData")
        return [
            Path(program_data) / "Blackmagic Design" / "DaVinci Resolve" / "Support" / "Developer" / "Scripting",
        ]
    return [Path("/opt/resolve/Developer/Scripting")]


def _ensure_script_modules_on_path() -> None:
    for base in _resolve_script_paths():
        if not base.exists():
            continue
        modules = base / "Modules"
        if modules.exists() and str(modules) not in sys.path:
            sys.path.insert(0, str(modules))


def _load_resolve():
    """Returns the live Resolve instance or raises with a clear error."""
    _ensure_script_modules_on_path()
    try:
        import DaVinciResolveScript as dvr  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "DaVinciResolveScript module not found. Install DaVinci Resolve "
            "(free or Studio) and ensure the Scripting folder is present at "
            f"{_resolve_script_paths()[0]}"
        ) from exc
    resolve = dvr.scriptapp("Resolve")
    if resolve is None:
        raise RuntimeError(
            "Resolve isn't running. Open DaVinci Resolve, set Preferences > "
            "System > General > External scripting using = Local, then retry."
        )
    return resolve


# ─────────────────────────── Helpers ────────────────────────────────────────

_MARKER_COLOR_APPROVED = "Green"
_MARKER_COLOR_NEAR_MISS = "Yellow"
_MARKER_COLOR_REJECTED = "Red"


def _safe_get_attr(obj: Any, *names: str, default: Any = None) -> Any:
    for n in names:
        v = getattr(obj, n, None)
        if v is not None:
            return v
    return default


def _selectable_clips(
    job: Any,
    include_near_miss: bool,
    include_rejected: bool,
) -> Tuple[List[Any], List[Any]]:
    """Return (clips_to_push, clips_skipped). Order: by sequence_position
    inside each segment, then by filename."""
    if not getattr(job, "clips", None):
        return [], []
    keep: List[Any] = []
    skip: List[Any] = []
    for c in job.clips:
        is_near_miss = bool(getattr(c, "near_miss", False))
        approved = getattr(c, "approved", None)
        if approved is True:
            keep.append(c)
        elif is_near_miss and include_near_miss:
            keep.append(c)
        elif approved is False and include_rejected:
            keep.append(c)
        else:
            skip.append(c)

    def _key(c: Any) -> Tuple[Any, ...]:
        scores = getattr(c, "scores", None)
        seg = getattr(c, "segment_label", "") or ""
        seq = getattr(scores, "sequence_position", None) if scores else None
        seq_key = seq if isinstance(seq, int) else 9999
        fname = getattr(c, "filename", "") or ""
        return (seg, seq_key, fname)

    keep.sort(key=_key)
    return keep, skip


def _trim_frames(clip: Any, fps: float) -> Tuple[Optional[int], Optional[int]]:
    scores = getattr(clip, "scores", None)
    if not scores:
        return None, None
    in_sec = getattr(scores, "ai_in_sec", None)
    out_sec = getattr(scores, "ai_out_sec", None)
    duration = getattr(scores, "duration_sec", None) or 0.0
    if not (isinstance(in_sec, (int, float)) and isinstance(out_sec, (int, float))):
        return None, None
    in_sec = max(0.0, float(in_sec))
    out_sec = min(float(duration) if duration else float(out_sec), float(out_sec))
    if out_sec <= in_sec:
        return None, None
    return int(round(in_sec * fps)), int(round(out_sec * fps))


def _marker_for(clip: Any) -> Tuple[str, str, str]:
    """Returns (color, name, note) for a clip's marker."""
    scores = getattr(clip, "scores", None)
    seg = getattr(clip, "segment_label", None) or "Unsorted"
    caption = getattr(scores, "ai_caption", None) if scores else None
    rationale = getattr(scores, "ai_rationale", None) if scores else None
    name = f"[{seg}]"
    note_parts: List[str] = []
    if caption:
        note_parts.append(caption)
    if rationale:
        note_parts.append(rationale)
    note = "\n".join(note_parts) or seg
    if getattr(clip, "near_miss", False):
        return _MARKER_COLOR_NEAR_MISS, name + " near miss", note
    if getattr(clip, "approved", None) is False:
        return _MARKER_COLOR_REJECTED, name + " rejected", note
    return _MARKER_COLOR_APPROVED, name, note


# ─────────────────────────── Push entry point ───────────────────────────────

def push_job(
    job: Any,
    mode: str = "new_timeline",
    include_near_miss: bool = True,
    include_rejected: bool = False,
) -> Dict[str, Any]:
    if mode not in ("new_timeline", "append"):
        raise ValueError("mode must be 'new_timeline' or 'append'")

    resolve = _load_resolve()
    project_manager = resolve.GetProjectManager()
    project = project_manager.GetCurrentProject()
    if project is None:
        raise RuntimeError(
            "No project is open in Resolve. Open or create a project, then retry."
        )

    media_pool = project.GetMediaPool()
    root_folder = media_pool.GetRootFolder()

    keep, skip = _selectable_clips(job, include_near_miss, include_rejected)
    if not keep:
        return {
            "ok": False,
            "error": "No clips to push (none approved, no near-miss).",
            "project_name": project.GetName(),
            "timeline_name": None,
            "clips_added": 0,
            "clips_skipped": len(skip),
            "errors": [],
        }

    # Resolve only knows the project's framerate — read it once.
    settings = project.GetSetting("timelineFrameRate")
    try:
        fps = float(settings) if settings else 24.0
    except (TypeError, ValueError):
        fps = 24.0

    # Derive a unique-ish timeline name from the job.
    job_id = getattr(job, "id", "job")
    folder_path = getattr(job, "folder_path", "")
    folder_tag = Path(folder_path).name if folder_path else "cull"
    timeline_name = f"{folder_tag} · cull {job_id[:6]}"

    if mode == "new_timeline":
        timeline = media_pool.CreateEmptyTimeline(timeline_name)
        if timeline is None:
            raise RuntimeError(f"Resolve refused to create timeline '{timeline_name}'.")
        project.SetCurrentTimeline(timeline)
    else:
        timeline = project.GetCurrentTimeline()
        if timeline is None:
            timeline = media_pool.CreateEmptyTimeline(timeline_name)
            if timeline is None:
                raise RuntimeError("No active timeline and CreateEmptyTimeline failed.")
            project.SetCurrentTimeline(timeline)
        timeline_name = timeline.GetName()

    errors: List[str] = []
    added = 0

    # Bring every source clip into the project's root media pool folder.
    media_pool.SetCurrentFolder(root_folder)
    paths_to_import = list({getattr(c, "path", "") for c in keep if getattr(c, "path", "")})
    imported = media_pool.ImportMedia(paths_to_import) if paths_to_import else []
    by_path: Dict[str, Any] = {}
    for item in imported or []:
        try:
            p = item.GetClipProperty("File Path") or item.GetClipProperty("Filename")
        except Exception:  # noqa: BLE001
            p = None
        if p:
            by_path[p] = item

    timeline_seconds_offset = 0.0  # for marker placement

    for clip in keep:
        path = getattr(clip, "path", "") or ""
        item = by_path.get(path)
        if item is None:
            errors.append(f"Could not import {path}")
            continue
        in_f, out_f = _trim_frames(clip, fps)
        seg = {"mediaPoolItem": item}
        if in_f is not None and out_f is not None and out_f > in_f:
            seg["startFrame"] = in_f
            seg["endFrame"] = out_f
        result = media_pool.AppendToTimeline([seg])
        if not result:
            errors.append(f"AppendToTimeline failed for {path}")
            continue
        added += 1

        # Marker on the timeline at the clip's start.
        try:
            color, name, note = _marker_for(clip)
            duration_sec = (
                ((out_f - in_f) / fps) if (in_f is not None and out_f is not None and fps)
                else getattr(clip.scores, "duration_sec", 0.0) if getattr(clip, "scores", None) else 0.0
            )
            marker_frame = int(round(timeline_seconds_offset * fps))
            timeline.AddMarker(marker_frame, color, name, note, 1)
            timeline_seconds_offset += float(duration_sec or 0.0)
        except Exception as exc:  # noqa: BLE001
            logger.debug("Marker add failed (non-fatal): %s", exc)

    return {
        "ok": True,
        "project_name": project.GetName(),
        "timeline_name": timeline_name,
        "clips_added": added,
        "clips_skipped": len(skip),
        "errors": errors,
    }
