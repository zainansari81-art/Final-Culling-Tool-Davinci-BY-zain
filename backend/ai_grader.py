# ai_grader.py — Claude-vision grading for sub-clip frames.
#
# Sends one representative frame per sub-segment to Claude, parses the
# returned JSON grade, and persists it. The metric pipeline already filtered
# obvious failures, so we only spend calls on candidates worth a creative
# read.
#
# Cache: keyed by SHA256 of the JPEG bytes. Living at
# ~/.wedding-culling/ai_cache.json so re-running on the same footage is free.
#
# Concurrency: ThreadPoolExecutor with max_concurrent workers. Each call is a
# subprocess to `claude -p` with the frame written to a temp file (claude
# reads it via the Read tool).

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import cv2
import numpy as np

from models import CullPolicy, SubClipSegment

logger = logging.getLogger(__name__)

CLAUDE_BIN = os.environ.get(
    "CLAUDE_BIN",
    "/Users/zain/Library/Application Support/Claude/claude-code/2.1.121/claude.app/Contents/MacOS/claude",
)

CACHE_DIR = Path.home() / ".wedding-culling"
CACHE_FILE = CACHE_DIR / "ai_cache.json"
_cache_lock = threading.Lock()
_cache: Optional[Dict[str, dict]] = None


PROMPT = """You are a senior wedding video editor reviewing a single still frame from raw wedding footage. Decide whether this shot belongs in a 3-minute highlight reel.

Return ONLY a JSON object — no preamble, no code fences, no commentary outside the JSON.

JSON schema:
{
  "highlight_score": <integer 1-10>,
  "shot_type": <one of: face_closeup | face_medium | wide_group | wide_venue | b_roll_detail | drone_aerial | macro_detail | establishing | reaction | other>,
  "issues": [<zero or more of: shaky | blurry | awkward_subject | harsh_light | underexposed | overexposed | cluttered_background | bad_composition | obstructed | none>],
  "subject": <one short phrase describing what is in the frame>,
  "why": <one short sentence: why this score?>
}

Be honest — mid shots score 5; workhorses 6-7; hero moments 8+. The score should reflect highlight-reel worthiness, not just technical quality."""


def _load_cache() -> Dict[str, dict]:
    global _cache
    with _cache_lock:
        if _cache is None:
            if CACHE_FILE.exists():
                try:
                    with CACHE_FILE.open() as f:
                        _cache = json.load(f)
                except Exception as e:  # noqa: BLE001
                    logger.warning("AI cache read failed: %s; starting fresh", e)
                    _cache = {}
            else:
                _cache = {}
        return _cache


def _save_cache() -> None:
    with _cache_lock:
        if _cache is None:
            return
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with CACHE_FILE.open("w") as f:
            json.dump(_cache, f, indent=2)


def _frame_to_jpeg_bytes(frame_bgr: np.ndarray, max_width: int = 1280) -> bytes:
    """Encode a BGR frame as a JPEG byte string. Downscales to keep tokens reasonable."""
    h, w = frame_bgr.shape[:2]
    if w > max_width:
        scale = max_width / w
        frame_bgr = cv2.resize(frame_bgr, (max_width, int(h * scale)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, 88])
    if not ok:
        raise RuntimeError("JPEG encode failed")
    return buf.tobytes()


def _hash_jpeg(jpeg_bytes: bytes) -> str:
    return hashlib.sha256(jpeg_bytes).hexdigest()


def _claude_grade_jpeg(jpeg_bytes: bytes, timeout_sec: float) -> Optional[dict]:
    """
    Run claude -p with the frame as a temp file. Returns parsed JSON or None.
    Uses the same env-cleaning trick as the daemon (no parent CLAUDE_CODE_*
    leak that breaks subprocess auth).
    """
    env = {k: v for k, v in os.environ.items() if not (
        (k.startswith("CLAUDE_CODE_") and k != "CLAUDE_CODE_OAUTH_TOKEN")
        or k.startswith("CLAUDE_AGENT_SDK_")
        or k in ("CLAUDECODE", "AI_AGENT", "BAGGAGE")
    )}

    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        tmp.write(jpeg_bytes)
        tmp_path = tmp.name

    try:
        prompt = f"{PROMPT}\n\nThe frame is at: {tmp_path}\n\nRead the image and respond with ONLY the JSON object."
        proc = subprocess.run(
            [
                CLAUDE_BIN,
                "-p",
                "--permission-mode", "bypassPermissions",
                "--output-format", "text",
                prompt,
            ],
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            env=env,
        )
    except subprocess.TimeoutExpired:
        logger.warning("AI grade: claude timed out after %.0fs", timeout_sec)
        return None
    except Exception as e:  # noqa: BLE001
        logger.warning("AI grade: spawn failed: %s", e)
        return None
    finally:
        try: os.unlink(tmp_path)
        except Exception: pass

    if proc.returncode != 0:
        logger.warning("AI grade: claude exit %d. stderr: %s", proc.returncode, proc.stderr[:200])
        return None

    out = proc.stdout.strip()
    out = re.sub(r"^```(?:json)?\s*", "", out)
    out = re.sub(r"\s*```$", "", out)
    start, end = out.find("{"), out.rfind("}")
    if start < 0 or end < 0:
        logger.warning("AI grade: no JSON in response: %s", out[:200])
        return None
    try:
        return json.loads(out[start : end + 1])
    except json.JSONDecodeError as e:
        logger.warning("AI grade: JSON parse failed: %s; raw=%s", e, out[start:end+1][:200])
        return None


def grade_one_frame(frame_bgr: np.ndarray, policy: CullPolicy) -> Optional[dict]:
    """
    Grade a single frame, with on-disk cache by JPEG hash. Returns the parsed
    JSON dict (with normalized fields) or None if grading failed.
    """
    try:
        jpeg = _frame_to_jpeg_bytes(frame_bgr)
    except Exception as e:  # noqa: BLE001
        logger.warning("AI grade: encoding failed: %s", e)
        return None

    key = _hash_jpeg(jpeg)
    cache = _load_cache()
    if key in cache:
        return cache[key]

    grade = _claude_grade_jpeg(jpeg, policy.ai_timeout_sec)
    if grade is None:
        return None

    # Normalize the response so downstream code can rely on shapes.
    normalized = {
        "highlight_score": int(grade.get("highlight_score", 5)),
        "shot_type": str(grade.get("shot_type", "other")),
        "issues": list(grade.get("issues", [])) if isinstance(grade.get("issues"), list) else [],
        "subject": str(grade.get("subject", "")),
        "why": str(grade.get("why", "")),
    }
    # Clamp score to 1..10
    normalized["highlight_score"] = max(1, min(10, normalized["highlight_score"]))

    with _cache_lock:
        cache[key] = normalized
    _save_cache()
    return normalized


def _representative_frame_for_segment(
    file_path: str, start_sec: float, end_sec: float,
) -> Optional[np.ndarray]:
    """Read a frame from the middle of [start_sec, end_sec] for grading."""
    try:
        cap = cv2.VideoCapture(file_path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        target_sec = start_sec + (end_sec - start_sec) / 2
        target_frame = int(round(target_sec * fps))
        cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
        ok, frame = cap.read()
        cap.release()
        if not ok or frame is None:
            return None
        return frame
    except Exception:
        return None


def grade_segments_in_clip(
    clip_path: str,
    sub_segments: List[SubClipSegment],
    policy: CullPolicy,
) -> int:
    """
    For each sub-segment in a single clip, pull a representative frame and
    grade it. Mutates sub_segments in place. Returns the count successfully
    graded. Skips segments that already have ai_score set.
    """
    if not sub_segments or not policy.ai_grading:
        return 0

    graded = 0
    for seg in sub_segments:
        if seg.ai_score is not None:
            continue  # already graded
        frame = _representative_frame_for_segment(clip_path, seg.start_sec, seg.end_sec)
        if frame is None:
            continue
        result = grade_one_frame(frame, policy)
        if result is None:
            continue
        seg.ai_score = result["highlight_score"]
        seg.ai_shot_type = result["shot_type"]
        seg.ai_issues = result["issues"]
        seg.ai_subject = result["subject"]
        seg.ai_why = result["why"]
        graded += 1
    return graded


def grade_all_clips_parallel(
    clips_with_paths: List[Tuple[str, List[SubClipSegment]]],
    policy: CullPolicy,
) -> int:
    """
    Parallel grading across all clips. Each thread handles ONE clip's segments
    sequentially (so cv2.VideoCapture isn't bouncing between threads on the
    same file). Returns total segments graded.
    """
    if not policy.ai_grading:
        return 0

    total_graded = 0
    workers = max(1, min(int(policy.ai_max_concurrent), 8))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [
            ex.submit(grade_segments_in_clip, path, segs, policy)
            for (path, segs) in clips_with_paths
            if segs
        ]
        for fut in as_completed(futures):
            try:
                total_graded += fut.result()
            except Exception as e:  # noqa: BLE001
                logger.warning("AI grade worker failed: %s", e)
    return total_graded
