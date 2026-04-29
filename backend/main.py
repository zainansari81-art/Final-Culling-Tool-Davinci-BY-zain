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
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any, Dict

from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from analyzer import analyze_folder
from fcpxml_export import export_to_fcpxml
from models import (
    AnalysisJob,
    ClipReview,
    CreateJobRequest,
    FcpxmlExportRequest,
    JobStatus,
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

    job = AnalysisJob(
        id=str(uuid.uuid4()),
        folder_path=str(folder.resolve()),
        created_at=datetime.utcnow(),
    )
    jobs[job.id] = job

    _executor.submit(analyze_folder, job.id, job.folder_path, jobs)
    logger.info("Created job %s for %s", job.id, job.folder_path)
    return job


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


# ─────────────────────────── Bulk auto-approve ───────────────────────────────

@app.post(
    "/jobs/{job_id}/approve-all",
    summary="Auto-approve good clips, reject shaky/blurry ones",
)
def approve_all(job_id: str) -> Dict[str, Any]:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    approved = rejected = 0
    for clip in job.clips:
        good = clip.scores.shake_score < 0.4 and clip.scores.blur_score < 0.4 and clip.scores.exposure_ok
        clip.approved = good
        if good:
            approved += 1
        else:
            rejected += 1
    jobs[job_id] = job
    return {"approved": approved, "rejected": rejected, "total": len(job.clips)}


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
