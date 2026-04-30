# probe_ai.py — Single-clip AI grading probe.
#
# Pulls one representative frame from a wedding clip (or accepts a still image
# directly), sends it to Claude with a wedding-editor prompt, and prints the
# returned grade. This is the "is the qualitative judgment any good?" test
# before we build the full hybrid pipeline.
#
# Usage:
#   cd backend
#   python3 probe_ai.py /path/to/clip.mp4
#   python3 probe_ai.py /path/to/still.jpg

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional

import cv2

CLAUDE_BIN = os.environ.get(
    "CLAUDE_BIN",
    "/Users/zain/Library/Application Support/Claude/claude-code/2.1.121/claude.app/Contents/MacOS/claude",
)

PROMPT = """You are a senior wedding video editor reviewing a single still frame from raw wedding footage. Decide whether this shot belongs in a 3-minute highlight reel.

Rate on these dimensions and return ONLY a JSON object — no preamble, no code fences, no commentary outside the JSON.

JSON schema:
{
  "highlight_score": <integer 1-10>,            // 10 = hero shot, 1 = unusable
  "shot_type": <one of: face_closeup | face_medium | wide_group | wide_venue | b_roll_detail | drone_aerial | macro_detail | establishing | reaction | other>,
  "issues": [<zero or more of: shaky | blurry | awkward_subject | harsh_light | underexposed | overexposed | cluttered_background | bad_composition | obstructed | none>],
  "subject": <one short phrase describing what is in the frame, e.g. "bride laughing", "rings on velvet pillow", "dancefloor lights">,
  "why": <one short sentence: why this score?>
}

Be honest — if the shot is mid, score it 5. If it's a workhorse-not-hero, score 6-7. Hero shots are 8+. The score should reflect highlight-reel worthiness, not just technical quality."""


def extract_keyframe(file_path: str, out_path: Path) -> bool:
    """Extract a representative frame from middle of a video file."""
    try:
        cap = cv2.VideoCapture(file_path)
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        if total <= 0:
            print(f"[probe] could not read frame count from {file_path}")
            cap.release()
            return False
        cap.set(cv2.CAP_PROP_POS_FRAMES, total // 2)
        ok, frame = cap.read()
        cap.release()
        if not ok or frame is None:
            print(f"[probe] could not read middle frame")
            return False
        cv2.imwrite(str(out_path), frame, [cv2.IMWRITE_JPEG_QUALITY, 90])
        return True
    except Exception as e:
        print(f"[probe] keyframe extraction failed: {e}")
        return False


def grade_frame_with_claude(frame_path: Path) -> Optional[dict]:
    """
    Spawn `claude -p` with a Read instruction. Claude reads the JPEG and
    returns a structured grade. Returns parsed JSON or None on failure.
    """
    user_prompt = f"{PROMPT}\n\nThe frame is at: {frame_path}\n\nRead the image and respond with ONLY the JSON object."

    proc = subprocess.run(
        [
            CLAUDE_BIN,
            "-p",
            "--permission-mode", "bypassPermissions",
            "--output-format", "text",
            user_prompt,
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    if proc.returncode != 0:
        print(f"[probe] claude exited {proc.returncode}")
        if proc.stderr:
            print(f"[probe] stderr: {proc.stderr[:500]}")
        return None

    out = proc.stdout.strip()
    # Strip code fences if Claude added them despite instructions
    out = re.sub(r"^```(?:json)?\s*", "", out)
    out = re.sub(r"\s*```$", "", out)
    # Find the JSON object even if wrapped in prose
    start = out.find("{")
    end = out.rfind("}")
    if start < 0 or end < 0:
        print("[probe] no JSON found in response. Raw output:")
        print(out)
        return None
    candidate = out[start : end + 1]
    try:
        return json.loads(candidate)
    except json.JSONDecodeError as e:
        print(f"[probe] JSON parse failed: {e}")
        print(f"[probe] raw candidate: {candidate}")
        return None


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python3 probe_ai.py <clip_or_image_path>")
        return 2
    src = Path(sys.argv[1]).expanduser()
    if not src.is_file():
        print(f"not a file: {src}")
        return 2

    is_image = src.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
    with tempfile.TemporaryDirectory() as tmp:
        if is_image:
            frame_path = src
            print(f"[probe] using image as-is: {frame_path}")
        else:
            frame_path = Path(tmp) / "frame.jpg"
            print(f"[probe] extracting middle keyframe from {src.name} → {frame_path}")
            if not extract_keyframe(str(src), frame_path):
                return 1
            print(f"[probe] frame saved ({frame_path.stat().st_size} bytes)")

        print("[probe] sending to Claude vision (this takes ~5-15s)...")
        grade = grade_frame_with_claude(frame_path)

    if grade is None:
        print("[probe] failed to get a grade")
        return 1

    print()
    print("=" * 60)
    print("CLAUDE'S GRADE")
    print("=" * 60)
    print(json.dumps(grade, indent=2))
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
