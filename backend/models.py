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


class SubClipSegment(BaseModel):
    """
    A usable segment inside a longer clip, identified by deep analysis.
    Scores are local to this segment — averages within the window range.
    """
    start_sec: float = Field(ge=0.0)
    end_sec: float = Field(ge=0.0)
    duration_sec: float = Field(ge=0.0)
    shake_score: float = Field(ge=0.0, le=1.0)
    blur_score: float = Field(ge=0.0, le=1.0)
    exposure_ok: bool = True
    # Highlight-grade scoring — 0=unusable, 1=hero shot
    highlight_quality: float = Field(default=0.0, ge=0.0, le=1.0)
    # Whether this segment passes the highlight threshold (eligible for highlight reel)
    is_highlight: bool = False
    # Number of frames in this segment where a face was detected (rough indicator of subject presence)
    face_frames: int = 0


class ClipScore(BaseModel):
    """Raw quality metrics computed by the analysis engine for one video clip."""
    path: str
    duration_sec: float = 0.0
    shake_score: float = Field(default=0.0, ge=0.0, le=1.0,
                               description="0=stable, 1=very shaky (clip average)")
    blur_score: float = Field(default=0.0, ge=0.0, le=1.0,
                              description="0=sharp, 1=very blurry (clip average)")
    exposure_ok: bool = True
    duplicate_of: Optional[str] = None   # clip_id of original, or None
    scene_count: int = 1
    # Deep-mode fields — None when shallow analysis was used
    sub_segments: Optional[List[SubClipSegment]] = None
    coverage_cluster_id: Optional[str] = None  # clips sharing this id are the same moment from different angles


class ClipReview(BaseModel):
    """One clip entry in the review UI — scores plus human-editable fields."""
    clip_id: str
    path: str
    filename: str
    thumbnail_path: Optional[str] = None
    scores: ClipScore
    suggested_segment: str = "Backup"   # machine suggestion
    approved: bool = False
    cull_reason: Optional[str] = None    # populated by the auto-cull pass; None = approved
    segment_label: str = "Backup"       # human-confirmed label


class CullPolicy(BaseModel):
    """Thresholds that drive the auto-cull pass after analysis."""
    enabled: bool = True
    shake_threshold: float = 0.70   # shake_score above this → reject
    blur_threshold: float = 0.70    # blur_score above this → reject
    min_duration_sec: float = 1.5   # clips shorter → reject (accidental hits)
    require_exposure_ok: bool = True
    reject_duplicates: bool = True  # keep only the best in each duplicate group

    # Deep analysis (sliding-window sub-clip scoring + coverage clustering).
    # Slower (~2-3× analysis time on average) but actually looks at the whole
    # footage — a 5-minute clip with 30 great seconds + 4 bad minutes will
    # produce a 30-second sub-clip on the timeline instead of all-or-nothing.
    deep_analysis: bool = False
    sub_window_sec: float = 5.0      # rolling window for sub-clip scoring
    sub_step_sec: float = 1.0        # advance window by this per step (denser = slower)
    sub_min_segment_sec: float = 2.0 # don't surface sub-segments shorter than this
    coverage_hash_interval_sec: float = 5.0  # one perceptual hash per N seconds across all clips
    coverage_match_distance: int = 12        # hamming distance for "same shot" pair
    coverage_min_overlap: float = 0.35       # ratio of matching hashes for two clips to cluster

    # Highlight-grade detection (a stricter bar on top of usable sub-segments,
    # for building a highlight reel from the best-of-the-best moments).
    detect_highlights: bool = True
    highlight_quality_threshold: float = 0.65  # 0=any segment qualifies, 1=only perfect shots
    highlight_min_duration_sec: float = 2.0    # don't include very short bursts in highlights
    highlight_require_face: bool = False       # if True, segments without faces don't qualify
    highlight_face_bonus: float = 0.15         # added to quality score when faces are present
    highlight_max_total_minutes: float = 5.0   # cap for the highlight reel (prevents bloat)


class CullReason(str, Enum):
    """Why a clip was auto-rejected. None = approved."""
    approved = "approved"
    too_short = "too_short"
    too_shaky = "too_shaky"
    too_blurry = "too_blurry"
    bad_exposure = "bad_exposure"
    duplicate = "duplicate"


class CullStats(BaseModel):
    """Summary of the auto-cull pass."""
    total: int = 0
    approved: int = 0
    rejected_short: int = 0
    rejected_shaky: int = 0
    rejected_blurry: int = 0
    rejected_exposure: int = 0
    rejected_duplicate: int = 0


class AnalysisJob(BaseModel):
    """One folder-scan job — tracks status, progress, and the list of clips."""
    id: str
    folder_path: str
    status: JobStatus = JobStatus.queued
    progress: float = Field(default=0.0, ge=0.0, le=100.0)
    clips: List[ClipReview] = Field(default_factory=list)
    cull_policy: CullPolicy = Field(default_factory=CullPolicy)
    cull_stats: Optional[CullStats] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    error: Optional[str] = None


class CreateJobRequest(BaseModel):
    folder_path: str
    included_files: Optional[List[str]] = None  # absolute paths; if set, only these are analyzed
    cull_policy: Optional[CullPolicy] = None    # if None, server defaults are used
    deep_analysis: Optional[bool] = None        # convenience: forces cull_policy.deep_analysis=True
    style_profile_id: Optional[str] = None      # apply a learned editor's style to thresholds


class RecullRequest(BaseModel):
    """POST /jobs/{id}/cull — re-run the cull pass with new thresholds."""
    cull_policy: CullPolicy


class StyleProfile(BaseModel):
    """
    Learned editing style derived from one or more fully-edited reference
    wedding videos. The profile captures the editor's pacing, quality
    standards, and aesthetic so a new analysis pass can match it.

    All metrics are aggregates across every detected shot in every reference.
    """
    id: str
    name: str
    reference_paths: List[str]
    reference_count: int = 0
    total_shots_analyzed: int = 0

    # Pacing
    shot_length_p25_sec: float = 2.0
    shot_length_median_sec: float = 4.0
    shot_length_p75_sec: float = 7.0
    shot_length_mean_sec: float = 5.0

    # Quality baseline (editor's ship bar)
    sharpness_p25: float = 80.0       # raw Laplacian variance — editor's lowest sharpness
    sharpness_median: float = 140.0
    saturation_mean: float = 0.45     # 0..1
    contrast_mean: float = 0.50       # 0..1
    brightness_mean: float = 130.0
    shake_p75: float = 0.30           # 75th percentile shake_score across reference shots

    # Subject mix
    face_ratio: float = 0.40          # fraction of shots that contain faces

    # Highlight grade — what the editor's average shot scores
    highlight_quality_p50: float = 0.60
    highlight_quality_p75: float = 0.75

    created_at: datetime = Field(default_factory=datetime.utcnow)
    notes: Optional[str] = None


class StyleProfileRequest(BaseModel):
    """POST /style-profiles — extract a profile from reference videos."""
    name: str
    reference_paths: List[str]


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
