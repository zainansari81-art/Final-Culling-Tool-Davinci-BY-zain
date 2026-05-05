"""Vertex AI Video Intelligence wrapper.

Uploads a clip to GCS and runs shot detection + label detection + speech
transcription + person detection in a single API call. Returns a flat dict
designed to be folded back into ClipScore.

Auth uses Application Default Credentials (ADC). Run:
    bash <(curl -sSL https://storage.googleapis.com/cloud-samples-data/adc/setup_adc.sh)

Bucket and project are read from environment variables, with sensible defaults
matching the dev setup.
"""
from __future__ import annotations

import logging
import os
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# ─── Config ────────────────────────────────────────────────────────────────
GCP_PROJECT = os.environ.get("GCP_PROJECT", "culling")
GCP_LOCATION = os.environ.get("GCP_LOCATION", "us-central1")
GCS_BUCKET = os.environ.get("GCS_BUCKET", "wedding-culling-culling")

# Cap on how big a clip we'll send (large clips blow up cost + processing time)
MAX_UPLOAD_BYTES = int(os.environ.get("AI_MAX_UPLOAD_BYTES", 2 * 1024 * 1024 * 1024))


# ─── Lazy-init clients (so import doesn't fail without ADC) ────────────────
_storage_client = None
_video_client = None


def _storage():
    global _storage_client
    if _storage_client is None:
        from google.cloud import storage
        _storage_client = storage.Client(project=GCP_PROJECT)
    return _storage_client


def _video():
    global _video_client
    if _video_client is None:
        from google.cloud import videointelligence_v1 as vi
        _video_client = vi.VideoIntelligenceServiceClient()
    return _video_client


# ─── Upload ────────────────────────────────────────────────────────────────
def upload_to_gcs(local_path: str, prefix: str = "clips") -> str:
    """Upload a local file to GCS, return its gs:// URI."""
    p = Path(local_path)
    if not p.exists():
        raise FileNotFoundError(local_path)
    if p.stat().st_size > MAX_UPLOAD_BYTES:
        raise ValueError(
            f"Clip {p.name} is {p.stat().st_size/1e9:.1f} GB — exceeds AI_MAX_UPLOAD_BYTES",
        )

    bucket = _storage().bucket(GCS_BUCKET)
    blob_name = f"{prefix}/{uuid.uuid4().hex}-{p.name}"
    blob = bucket.blob(blob_name)
    blob.chunk_size = 8 * 1024 * 1024  # 8 MB chunks for resumable upload
    size_mb = p.stat().st_size / (1024 * 1024)
    logger.info("Uploading %s (%.1f MB) → gs://%s/%s", p.name, size_mb, GCS_BUCKET, blob_name)
    blob.upload_from_filename(str(p), timeout=900)
    return f"gs://{GCS_BUCKET}/{blob_name}"


def delete_gcs(uri: str) -> None:
    """Delete an uploaded clip after analysis to save storage cost."""
    if not uri.startswith(f"gs://{GCS_BUCKET}/"):
        return
    name = uri[len(f"gs://{GCS_BUCKET}/"):]
    try:
        _storage().bucket(GCS_BUCKET).blob(name).delete()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to delete %s: %s", uri, exc)


# ─── Analyze ───────────────────────────────────────────────────────────────
def analyze_video(gcs_uri: str, timeout_sec: int = 600) -> Dict[str, Any]:
    """Run Video Intelligence with our standard feature bundle.

    Returns a dict with keys: shots, labels, transcript, person_tracks.
    """
    from google.cloud import videointelligence_v1 as vi

    features = [
        vi.Feature.SHOT_CHANGE_DETECTION,
        vi.Feature.LABEL_DETECTION,
        vi.Feature.SPEECH_TRANSCRIPTION,
        vi.Feature.PERSON_DETECTION,
    ]
    config = vi.VideoContext(
        speech_transcription_config=vi.SpeechTranscriptionConfig(
            language_code="en-US",
            enable_automatic_punctuation=True,
        ),
        label_detection_config=vi.LabelDetectionConfig(
            label_detection_mode=vi.LabelDetectionMode.SHOT_AND_FRAME_MODE,
        ),
        person_detection_config=vi.PersonDetectionConfig(
            include_bounding_boxes=False,
            include_attributes=False,
        ),
    )

    logger.info("Vertex Video Intel: %s", gcs_uri)
    operation = _video().annotate_video(
        request={
            "features": features,
            "input_uri": gcs_uri,
            "video_context": config,
        }
    )
    response = operation.result(timeout=timeout_sec)
    return _flatten_response(response)


def _ts(t) -> float:
    """Convert a protobuf duration to seconds (float)."""
    if t is None:
        return 0.0
    return t.seconds + t.microseconds / 1e6


def _flatten_response(response) -> Dict[str, Any]:
    """Pull just what we care about out of the verbose proto response."""
    if not response.annotation_results:
        return {"shots": [], "labels": [], "transcript": "", "person_tracks": 0}
    result = response.annotation_results[0]

    # Shots
    shots: List[Dict[str, Any]] = []
    for shot in (result.shot_annotations or []):
        shots.append({
            "start_sec": _ts(shot.start_time_offset),
            "end_sec": _ts(shot.end_time_offset),
        })

    # Labels — combine shot + segment labels
    labels: List[Dict[str, Any]] = []
    seen: set[str] = set()

    for ann in list(result.shot_label_annotations) + list(result.segment_label_annotations):
        name = ann.entity.description if ann.entity else None
        if not name or name in seen:
            continue
        seen.add(name)
        for seg in (ann.segments or []):
            labels.append({
                "label": name,
                "confidence": float(seg.confidence or 0.0),
                "start_sec": _ts(seg.segment.start_time_offset),
                "end_sec": _ts(seg.segment.end_time_offset),
            })

    # Sort labels: highest confidence first, cap to top 25
    labels.sort(key=lambda x: x["confidence"], reverse=True)
    labels = labels[:25]

    # Transcript — concatenate all alternatives
    transcript_parts: List[str] = []
    for tr in (result.speech_transcriptions or []):
        for alt in (tr.alternatives or []):
            if alt.transcript:
                transcript_parts.append(alt.transcript.strip())
    transcript = " ".join(transcript_parts).strip()

    # Person tracks count (cheap proxy for "how many people in the shot")
    person_tracks = len(result.person_detection_annotations or [])

    return {
        "shots": shots,
        "labels": labels,
        "transcript": transcript,
        "person_tracks": person_tracks,
    }


# ─── Convenience: full pipeline for one clip ───────────────────────────────
def analyze_local_file(local_path: str, cleanup: bool = True) -> Optional[Dict[str, Any]]:
    """Upload → analyze → optionally delete. Returns None on failure."""
    uri = None
    try:
        uri = upload_to_gcs(local_path)
        return analyze_video(uri)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Vertex Video Intel failed for %s: %s", local_path, exc)
        return None
    finally:
        if uri and cleanup:
            delete_gcs(uri)
