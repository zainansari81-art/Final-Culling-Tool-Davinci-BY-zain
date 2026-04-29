# models.py — Pydantic data models shared across the wedding culling tool backend.
# ClipScore holds raw analysis metrics; ClipReview wraps a clip with its scores
# and human-review state; AnalysisJob tracks a full folder-scan job.

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import List, Optional

from pydantic import BaseModel, Field


class JobStatus(str, Enum):
    queued = "queued"
    running = "running"
    done = "done"
    failed = "failed"


class ClipScore(BaseModel):
    """Raw quality metrics computed by the analysis engine for one video clip."""
    path: str
    duration_sec: float = 0.0
    shake_score: float = Field(default=0.0, ge=0.0, le=1.0,
                               description="0=stable, 1=very shaky")
    blur_score: float = Field(default=0.0, ge=0.0, le=1.0,
                              description="0=sharp, 1=very blurry")
    exposure_ok: bool = True
    duplicate_of: Optional[str] = None   # clip_id of original, or None
    scene_count: int = 1


class ClipReview(BaseModel):
    """One clip entry in the review UI — scores plus human-editable fields."""
    clip_id: str
    path: str
    filename: str
    thumbnail_path: Optional[str] = None
    scores: ClipScore
    suggested_segment: str = "Backup"   # machine suggestion
    approved: bool = False
    segment_label: str = "Backup"       # human-confirmed label


class AnalysisJob(BaseModel):
    """One folder-scan job — tracks status, progress, and the list of clips."""
    id: str
    folder_path: str
    status: JobStatus = JobStatus.queued
    progress: float = Field(default=0.0, ge=0.0, le=100.0)
    clips: List[ClipReview] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    error: Optional[str] = None


class CreateJobRequest(BaseModel):
    folder_path: str
    included_files: Optional[List[str]] = None  # absolute paths; if set, only these are analyzed


class FsEntry(BaseModel):
    name: str
    path: str
    is_dir: bool
    is_video: bool = False
    size_bytes: int = 0


class FsListResponse(BaseModel):
    path: str
    parent: Optional[str] = None
    entries: List[FsEntry] = Field(default_factory=list)
    video_count: int = 0


class UpdateClipRequest(BaseModel):
    """PATCH body for /jobs/{job_id}/clips/{clip_id}."""
    approved: Optional[bool] = None
    segment_label: Optional[str] = None


class ResolveExportRequest(BaseModel):
    project_name: str


class FcpxmlExportRequest(BaseModel):
    output_path: str
