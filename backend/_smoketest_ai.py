"""Smoke-test the Vertex AI pipeline end-to-end on a single clip.

Run from backend/ with the venv active:
    ENABLE_AI=1 python _smoketest_ai.py "/path/to/clip.MP4"
"""
from __future__ import annotations

import logging
import sys
import uuid

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python _smoketest_ai.py <video-path>")
        return 1
    path = sys.argv[1]

    print(f"\n=== Vertex Video Intelligence on {path} ===")
    import vertex_video

    uri = vertex_video.upload_to_gcs(path)
    print(f"Uploaded: {uri}")
    vi = vertex_video.analyze_video(uri)
    vertex_video.delete_gcs(uri)
    print(f"  shots:        {len(vi['shots'])}")
    print(f"  labels:       {len(vi['labels'])}")
    print(f"  transcript:   {(vi['transcript'] or '')[:160]}…")
    print(f"  person_tracks:{vi['person_tracks']}")
    if vi["labels"]:
        print("  top labels:")
        for lb in vi["labels"][:8]:
            print(f"    - {lb['label']:30} {lb['confidence']:.2f}")

    print(f"\n=== Saving keyframes for Gemini ===")
    import analyzer

    job_id = "smoke-" + uuid.uuid4().hex[:8]
    clip_id = "test"
    duration = analyzer.get_duration_sec(path)
    frames = analyzer.extract_keyframes(path)
    print(f"  duration: {duration:.1f}s, keyframes: {len(frames)}")
    keyframes = analyzer.save_ai_keyframes(frames, job_id, clip_id, max_frames=8)
    print(f"  saved {len(keyframes)} keyframes for Gemini")

    print(f"\n=== Gemini synthesis ===")
    import vertex_gemini

    blur = analyzer.compute_blur_score(frames)
    shake = analyzer.compute_shake_score(frames)
    expo_ok = analyzer.compute_exposure_ok(frames)
    print(f"  heuristics: shake={shake:.3f}, blur={blur:.3f}, expo_ok={expo_ok}")

    decision = vertex_gemini.synthesize(
        keyframe_jpeg_paths=keyframes,
        duration_sec=duration,
        shake_score=shake,
        blur_score=blur,
        exposure_ok=expo_ok,
        video_intel=vi,
    )
    print(f"\n=== Gemini decision ===")
    if decision is None:
        print("  (none — call failed)")
        return 2
    import json
    print(json.dumps(decision, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
