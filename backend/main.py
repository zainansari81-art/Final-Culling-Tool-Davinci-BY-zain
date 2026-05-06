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

from analyzer import SUPPORTED_EXTENSIONS, analyze_folder
from fcpxml_export import export_to_fcpxml
from models import (
    AnalysisJob,
    ClipReview,
    CreateJobRequest,
    FcpxmlExportRequest,
    FsEntry,
    FsListResponse,
    JobStatus,
    ResolveExportRequest,
    UpdateClipRequest,
    UpdateSpeakerNamesRequest,
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
    enable_ai: bool = False,
) -> None:
    """Wrapper that attaches a per-job log handler before running analysis."""
    handler = JobLogHandler(job_id)
    handler.setLevel(logging.INFO)
    analyzer_logger = logging.getLogger("analyzer")
    analyzer_logger.addHandler(handler)
    job_logs[job_id].append(
        f"{datetime.now().strftime('%H:%M:%S')} I Job started for {folder_path}"
        f"{' (AI on)' if enable_ai else ''}"
    )
    # Set ENABLE_AI for this thread tree via env so analyzer.py picks it up.
    import os as _os
    prev = _os.environ.get("ENABLE_AI")
    if enable_ai:
        _os.environ["ENABLE_AI"] = "1"
    try:
        analyze_folder(job_id, folder_path, jobs, included_files)
    finally:
        if enable_ai:
            if prev is None:
                _os.environ.pop("ENABLE_AI", None)
            else:
                _os.environ["ENABLE_AI"] = prev
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

    job = AnalysisJob(
        id=str(uuid.uuid4()),
        folder_path=str(folder.resolve()),
        created_at=datetime.utcnow(),
    )
    jobs[job.id] = job

    _executor.submit(
        _run_job, job.id, job.folder_path, body.included_files, body.enable_ai,
    )
    logger.info(
        "Created job %s for %s (included_files=%s)",
        job.id, job.folder_path,
        len(body.included_files) if body.included_files else "all",
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


@app.get(
    "/jobs/{job_id}/ai-debug",
    summary="What did AI extract for this job? Quick visibility into pipeline output.",
)
def ai_debug(job_id: str) -> Dict[str, Any]:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    clips = []
    n_with_words = 0
    n_with_seq = 0
    n_dialogue_trimmed = 0
    for c in job.clips:
        s = c.scores
        word_count = len(s.words or [])
        if word_count > 0:
            n_with_words += 1
        if s.sequence_position is not None:
            n_with_seq += 1
        if s.dialogue_trimmed:
            n_dialogue_trimmed += 1
        clips.append({
            "clip_id": c.clip_id,
            "filename": c.filename,
            "duration_sec": s.duration_sec,
            "ai_segment": s.ai_segment,
            "ai_quality": s.ai_quality,
            "ai_caption": s.ai_caption,
            "ai_in_sec": s.ai_in_sec,
            "ai_out_sec": s.ai_out_sec,
            "dialogue_trimmed": s.dialogue_trimmed,
            "word_count": word_count,
            "transcript_chars": len(s.transcript or ""),
            "rank_in_group": s.rank_in_group,
            "sequence_position": s.sequence_position,
            "approved": c.approved,
        })

    return {
        "job_id": job_id,
        "ai_ran": any(c["ai_quality"] is not None for c in clips),
        "summary": {
            "total_clips": len(clips),
            "clips_with_words": n_with_words,
            "clips_dialogue_trimmed": n_dialogue_trimmed,
            "clips_with_sequence_pos": n_with_seq,
        },
        "clips": clips,
    }


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
    if body.sequence_position is not None:
        clip.scores.sequence_position = max(1, int(body.sequence_position))
    if body.ai_in_sec is not None:
        clip.scores.ai_in_sec = max(0.0, float(body.ai_in_sec))
    if body.ai_out_sec is not None:
        clip.scores.ai_out_sec = max(
            (clip.scores.ai_in_sec or 0.0) + 0.1,
            float(body.ai_out_sec),
        )

    jobs[job_id] = job
    return clip


# ─────────────────────────── Speaker names ───────────────────────────────────

@app.get(
    "/jobs/{job_id}/speakers",
    summary="Read speaker name mapping for this job",
)
def get_speakers(job_id: str) -> Dict[str, str]:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.speaker_names


@app.put(
    "/jobs/{job_id}/speakers",
    summary="Replace speaker name mapping (e.g. 'speaker_1' -> 'John')",
)
def put_speakers(
    job_id: str, body: UpdateSpeakerNamesRequest,
) -> Dict[str, str]:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    job.speaker_names = body.speaker_names
    jobs[job_id] = job
    return job.speaker_names


# ─────────────────────────── Sequence transcript ─────────────────────────────

@app.get(
    "/jobs/{job_id}/sequence",
    summary="Whole-job sequence: clips in timeline order with transcripts",
)
def get_sequence(job_id: str) -> Dict[str, Any]:
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    items: list[Dict[str, Any]] = []
    detected_speakers: set[int] = set()

    # Order: by segment chronology, then sequence_position within
    from fcpxml_export import SEGMENT_ORDER as _SEG_ORDER

    def seg_index(seg: str) -> int:
        try:
            return _SEG_ORDER.index(seg)
        except ValueError:
            return len(_SEG_ORDER)

    sorted_clips = sorted(
        job.clips,
        key=lambda c: (
            seg_index(c.segment_label or "Backup"),
            c.scores.sequence_position if c.scores.sequence_position is not None else 1_000_000,
            c.path.lower(),
        ),
    )

    for i, c in enumerate(sorted_clips, start=1):
        s = c.scores
        words_payload = []
        for w in (s.words or []):
            if w.speaker_tag:
                detected_speakers.add(w.speaker_tag)
            words_payload.append({
                "word": w.word,
                "start_sec": w.start_sec,
                "end_sec": w.end_sec,
                "speaker_tag": w.speaker_tag,
            })
        items.append({
            "clip_id": c.clip_id,
            "filename": c.filename,
            "segment": c.segment_label,
            "clip_type": s.clip_type,
            "duration_sec": s.duration_sec,
            "ai_in_sec": s.ai_in_sec,
            "ai_out_sec": s.ai_out_sec,
            "ai_quality": s.ai_quality,
            "ai_caption": s.ai_caption,
            "transcript": s.transcript,
            "words": words_payload,
            "sequence_position": s.sequence_position,
            "placement_confidence": s.placement_confidence,
            "approved": c.approved,
            "rank_in_group": s.rank_in_group,
            "thumbnail_url": f"/thumbnails/{job.id}/{c.clip_id}",
            "stream_url": f"/clips/{job.id}/{c.clip_id}",
            "timeline_position": i,
        })

    return {
        "job_id": job.id,
        "speaker_tags": sorted(detected_speakers),
        "speaker_names": job.speaker_names,
        "items": items,
    }


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
        s = clip.scores
        # AI is authoritative when it ran. Heuristics often misjudge cinematic
        # footage (gimbal moves register as "shaky", shallow DoF as "blurry"),
        # so we trust Gemini's quality + skip when present.
        if s.ai_quality is not None:
            good = (not s.ai_skip) and (s.ai_quality >= 5.0)
        else:
            # Looser fallback thresholds when AI didn't run
            good = (
                s.shake_score < 0.5
                and s.blur_score < 0.85
                and s.exposure_ok
            )
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
        # Side-write an SRT subtitle file for any NLE
        srt_path = ""
        try:
            from srt_export import export_srt
            srt_target = str(Path(written_path).with_suffix(".srt"))
            srt_path = export_srt(job=job, output_path=srt_target)
        except Exception as exc:  # noqa: BLE001
            logger.warning("SRT export failed (non-fatal): %s", exc)
        return {
            "success": True,
            "export_type": "fcpxml",
            "output_path": written_path,
            "subtitle_path": srt_path or None,
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
