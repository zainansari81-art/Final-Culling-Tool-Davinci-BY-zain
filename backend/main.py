# main.py — FastAPI application for the wedding video culling tool.
#
# Exposes a REST API consumed by the Vite frontend.  All video analysis runs
# in a background ThreadPoolExecutor so routes stay responsive.
#
# Run with:
#   uvicorn main:app --host 127.0.0.1 --port 8000

from __future__ import annotations

import logging
import uuid
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any, Deque, Dict, List

import re

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

from analyzer import SUPPORTED_EXTENSIONS, analyze_folder, apply_cull
from fcpxml_export import export_to_fcpxml
from models import (
    AnalysisJob,
    ClipReview,
    CreateJobRequest,
    CullPolicy,
    CullStats,
    FcpxmlExportRequest,
    FsEntry,
    FsListResponse,
    JobStatus,
    RecullRequest,
    ResolveExportRequest,
    UpdateClipRequest,
)

# ─────────────────────────── Logging ────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ─────────────────────────── App setup ──────────────────────────────────────

app = FastAPI(
    title="Wedding Culling Tool",
    description="Local Mac app for analysing and culling wedding video footage.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────── In-memory job store ─────────────────────────────

jobs: Dict[str, AnalysisJob] = {}

# Per-job log ring buffers so the frontend can stream activity live.
JOB_LOG_LIMIT = 2000
job_logs: Dict[str, Deque[str]] = defaultdict(lambda: deque(maxlen=JOB_LOG_LIMIT))


class JobLogHandler(logging.Handler):
    """Forwards logger output to a job-specific deque."""
    def __init__(self, job_id: str) -> None:
        super().__init__()
        self.job_id = job_id

    def emit(self, record: logging.LogRecord) -> None:  # noqa: D401
        ts = datetime.now().strftime("%H:%M:%S")
        line = f"{ts} {record.levelname[0]} {record.getMessage()}"
        job_logs[self.job_id].append(line)


def _run_job(
    job_id: str,
    folder_path: str,
    included_files: List[str] | None,
    cull_policy: CullPolicy | None = None,
) -> None:
    """Wrapper that attaches a per-job log handler before running analysis."""
    handler = JobLogHandler(job_id)
    handler.setLevel(logging.INFO)
    analyzer_logger = logging.getLogger("analyzer")
    analyzer_logger.addHandler(handler)
    job_logs[job_id].append(
        f"{datetime.now().strftime('%H:%M:%S')} I Job started for {folder_path}"
    )
    try:
        analyze_folder(job_id, folder_path, jobs, included_files, cull_policy)
    finally:
        analyzer_logger.removeHandler(handler)
        job_logs[job_id].append(
            f"{datetime.now().strftime('%H:%M:%S')} I Job finished"
        )


# Thread pool for background analysis (2 concurrent jobs max on a single Mac)
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="culling")


# ─────────────────────────── Health check ───────────────────────────────────

@app.get("/", summary="Health check")
def health_check() -> Dict[str, str]:
    return {"status": "ok", "service": "wedding-culling-tool"}


# ─────────────────────────── Jobs ────────────────────────────────────────────

@app.get(
    "/jobs",
    response_model=list[AnalysisJob],
    summary="List all jobs, newest first",
)
def list_jobs() -> list[AnalysisJob]:
    return sorted(jobs.values(), key=lambda j: j.created_at, reverse=True)


@app.post(
    "/jobs",
    response_model=AnalysisJob,
    status_code=status.HTTP_201_CREATED,
    summary="Create an analysis job and start processing in the background",
)
def create_job(body: CreateJobRequest) -> AnalysisJob:
    folder = Path(body.folder_path)
    if not folder.exists():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Folder not found: {body.folder_path}",
        )
    if not folder.is_dir():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Path is not a directory: {body.folder_path}",
        )

    policy = body.cull_policy or CullPolicy()
    job = AnalysisJob(
        id=str(uuid.uuid4()),
        folder_path=str(folder.resolve()),
        cull_policy=policy,
        created_at=datetime.utcnow(),
    )
    jobs[job.id] = job

    _executor.submit(
        _run_job, job.id, job.folder_path, body.included_files, policy,
    )
    logger.info(
        "Created job %s for %s (included_files=%s, cull=%s)",
        job.id, job.folder_path,
        len(body.included_files) if body.included_files else "all",
        "on" if policy.enabled else "off",
    )
    return job


# ─────────────────────────── Filesystem browser ──────────────────────────────

@app.get(
    "/fs/list",
    response_model=FsListResponse,
    summary="List directories and video files at a given path (defaults to /Volumes)",
)
def fs_list(path: str | None = None) -> FsListResponse:
    target = Path(path).expanduser() if path else Path("/Volumes")
    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Path not found: {target}")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {target}")

    entries: list[FsEntry] = []
    video_count = 0
    try:
        for child in sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
            if child.name.startswith("."):
                continue
            try:
                is_dir = child.is_dir()
                ext = child.suffix.lower()
                is_video = (not is_dir) and ext in SUPPORTED_EXTENSIONS
                size = 0 if is_dir else child.stat().st_size
                if is_video:
                    video_count += 1
                if not is_dir and not is_video:
                    continue  # hide non-video files for clarity
                entries.append(FsEntry(
                    name=child.name,
                    path=str(child.resolve()),
                    is_dir=is_dir,
                    is_video=is_video,
                    size_bytes=size,
                ))
            except (PermissionError, OSError):
                continue
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    parent = str(target.parent.resolve()) if target.parent != target else None
    return FsListResponse(
        path=str(target.resolve()),
        parent=parent,
        entries=entries,
        video_count=video_count,
    )


@app.get(
    "/jobs/{job_id}",
    response_model=AnalysisJob,
    summary="Get full job state including clips once analysis is done",
)
def get_job(job_id: str) -> AnalysisJob:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@app.get(
    "/jobs/{job_id}/progress",
    summary="Lightweight progress poll — returns progress and status only",
)
def get_progress(job_id: str) -> Dict[str, Any]:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"progress": job.progress, "status": job.status}


@app.get(
    "/jobs/{job_id}/logs",
    summary="Stream-style log poll — returns lines past `since` index",
)
def get_logs(job_id: str, since: int = 0) -> Dict[str, Any]:
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    buf = job_logs.get(job_id)
    lines = list(buf) if buf else []
    total = len(lines)
    new_lines = lines[since:] if since < total else []
    return {"lines": new_lines, "total": total}


# ─────────────────────────── Clip updates ────────────────────────────────────

@app.patch(
    "/jobs/{job_id}/clips/{clip_id}",
    response_model=ClipReview,
    summary="Update clip approval or segment label",
)
def update_clip(
    job_id: str,
    clip_id: str,
    body: UpdateClipRequest,
) -> ClipReview:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    clip = next((c for c in job.clips if c.clip_id == clip_id), None)
    if clip is None:
        raise HTTPException(status_code=404, detail="Clip not found")

    if body.approved is not None:
        clip.approved = body.approved
    if body.segment_label is not None:
        clip.segment_label = body.segment_label

    jobs[job_id] = job
    return clip


# ─────────────────────────── Re-cull (tune thresholds live) ─────────────────

@app.post(
    "/jobs/{job_id}/cull",
    response_model=CullStats,
    summary="Re-run the auto-cull pass with new thresholds (no re-analysis)",
)
def recull(job_id: str, body: RecullRequest) -> CullStats:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if not job.clips:
        raise HTTPException(status_code=400, detail="Job has no clips yet")
    stats = apply_cull(job.clips, body.cull_policy)
    job.cull_policy = body.cull_policy
    job.cull_stats = stats
    jobs[job_id] = job
    logger.info(
        "Re-cull job=%s approved=%d rejected: short=%d shaky=%d blurry=%d exp=%d dup=%d",
        job_id, stats.approved, stats.rejected_short, stats.rejected_shaky,
        stats.rejected_blurry, stats.rejected_exposure, stats.rejected_duplicate,
    )
    return stats


# ─────────────────────────── Bulk approve / reject ──────────────────────────

@app.post(
    "/jobs/{job_id}/approve-all",
    summary="Approve every clip in the job (hard override). Use /jobs/{id}/cull "
            "with a CullPolicy if you want threshold-driven behavior.",
)
def approve_all(job_id: str) -> Dict[str, Any]:
    """
    Hard approve — sets every clip to approved=True regardless of scores.

    Replaces the previous behavior that silently dropped any clip with
    shake_score>=0.4 or blur_score>=0.4. Those thresholds were way too
    tight for handheld wedding footage (where 0.3-0.5 is normal),
    causing 'approve all' to actually reject most clips. The button
    should literally approve all when the user clicks it; threshold-
    driven behavior is now /jobs/{id}/cull with an explicit policy.
    """
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    for clip in job.clips:
        clip.approved = True
        clip.cull_reason = "approved"
    jobs[job_id] = job
    logger.info("approve-all job=%s → %d clips set to approved", job_id, len(job.clips))
    return {"approved": len(job.clips), "rejected": 0, "total": len(job.clips)}


@app.post(
    "/jobs/{job_id}/reject-all",
    summary="Reject every clip in the job (clean slate before manual selection)",
)
def reject_all(job_id: str) -> Dict[str, Any]:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    for clip in job.clips:
        clip.approved = False
        clip.cull_reason = None
    jobs[job_id] = job
    return {"approved": 0, "rejected": len(job.clips), "total": len(job.clips)}


# ─────────────────────────── Export — Resolve ────────────────────────────────

@app.post(
    "/jobs/{job_id}/export/resolve",
    summary="Export approved clips into a new DaVinci Resolve project",
)
def export_resolve(job_id: str, body: ResolveExportRequest) -> Dict[str, Any]:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != JobStatus.done:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Job must be in 'done' status before exporting.",
        )

    approved = [c for c in job.clips if c.approved]
    if not approved:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No approved clips to export.",
        )

    try:
        from resolve_export import export_to_resolve  # lazy import — Resolve may not be installed
        result = export_to_resolve(job=job, project_name=body.project_name)
        return {**result, "export_type": "resolve"}
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("Resolve export failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Resolve export failed: {exc}",
        ) from exc


# ─────────────────────────── Export — FCPXML ─────────────────────────────────

@app.post(
    "/jobs/{job_id}/export/fcpxml",
    summary="Export approved clips to a FCPXML 1.10 file",
)
def export_fcpxml(job_id: str, body: FcpxmlExportRequest) -> Dict[str, Any]:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != JobStatus.done:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Job must be in 'done' status before exporting.",
        )

    approved = [c for c in job.clips if c.approved]
    if not approved:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No approved clips to export.",
        )

    try:
        written_path = export_to_fcpxml(job=job, output_path=body.output_path)
        return {
            "success": True,
            "export_type": "fcpxml",
            "output_path": written_path,
            "clips_exported": len(approved),
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("FCPXML export failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"FCPXML export failed: {exc}",
        ) from exc


# ─────────────────────────── Thumbnails ──────────────────────────────────────

@app.get(
    "/thumbnails/{job_id}/{clip_id}",
    summary="Serve a clip thumbnail JPEG",
    response_class=FileResponse,
)
def get_thumbnail(job_id: str, clip_id: str) -> FileResponse:
    thumb_path = Path(f"/tmp/culling-thumbs/{job_id}/{clip_id}.jpg")
    if not thumb_path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    return FileResponse(str(thumb_path), media_type="image/jpeg")


# ─────────────────────────── Video streaming ─────────────────────────────────

_VIDEO_MIME = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".mts": "video/mp2t",
    ".m2ts": "video/mp2t",
    ".mxf": "application/mxf",
    ".avi": "video/x-msvideo",
}


def _mime_for(suffix: str) -> str:
    return _VIDEO_MIME.get(suffix.lower(), "application/octet-stream")


@app.get(
    "/clips/{job_id}/{clip_id}",
    summary="Stream a clip's source file with HTTP Range support",
)
def stream_clip(job_id: str, clip_id: str, request: Request):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    clip = next((c for c in job.clips if c.clip_id == clip_id), None)
    if clip is None:
        raise HTTPException(status_code=404, detail="Clip not found")

    path = Path(clip.path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Source file missing")

    file_size = path.stat().st_size
    media_type = _mime_for(path.suffix)
    range_header = request.headers.get("range") or request.headers.get("Range")

    if range_header:
        m = re.match(r"bytes=(\d+)-(\d*)", range_header)
        if m:
            start = int(m.group(1))
            end = int(m.group(2)) if m.group(2) else file_size - 1
            end = min(end, file_size - 1)
            if start > end:
                raise HTTPException(
                    status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
                )
            length = end - start + 1

            def iterfile():
                with open(path, "rb") as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = f.read(min(256 * 1024, remaining))
                        if not chunk:
                            break
                        remaining -= len(chunk)
                        yield chunk

            return StreamingResponse(
                iterfile(),
                status_code=206,
                media_type=media_type,
                headers={
                    "Content-Range": f"bytes {start}-{end}/{file_size}",
                    "Accept-Ranges": "bytes",
                    "Content-Length": str(length),
                },
            )

    return FileResponse(
        str(path),
        media_type=media_type,
        headers={"Accept-Ranges": "bytes"},
    )
