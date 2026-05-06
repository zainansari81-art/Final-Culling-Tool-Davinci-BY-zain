"""Local equivalent of vertex_video.analyze_local_file.

Returns the same dict shape Vertex Video Intelligence produces so
downstream code in analyzer.py is unchanged:

  {
    "shots":      [{"start_sec","end_sec"}, ...],   # PySceneDetect
    "labels":     [{"label","confidence","start_sec","end_sec"}, ...],  # CLIP zero-shot
    "transcript": str | None,                       # faster-whisper
    "words":      [{"word","start_sec","end_sec","speaker_tag"}, ...],  # whisper word ts
    "persons":    [],                               # not implemented locally
  }

CLIP labels are computed against a curated wedding vocabulary by scoring
each provided keyframe and aggregating top labels.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("analyzer")

CLIP_MODEL = os.environ.get("LOCAL_CLIP_MODEL", "ViT-B-32")
CLIP_PRETRAINED = os.environ.get("LOCAL_CLIP_PRETRAINED", "openai")
CLIP_TOP_K = int(os.environ.get("LOCAL_CLIP_TOP_K", "8"))
CLIP_SCORE_THRESHOLD = float(os.environ.get("LOCAL_CLIP_THRESHOLD", "0.18"))

# Curated wedding-domain vocabulary for zero-shot labeling.
WEDDING_VOCAB = [
    "bride in wedding dress", "groom in suit", "bride and groom kissing",
    "bride and groom embracing", "wedding ceremony aisle", "wedding altar",
    "exchange of wedding rings", "bride walking down the aisle",
    "officiant performing ceremony", "wedding vows being read",
    "first dance at reception", "wedding cake", "champagne toast",
    "wedding speech being given", "guests dancing at reception",
    "bouquet of flowers", "bridesmaids posing", "groomsmen posing",
    "father of the bride", "mother of the bride", "flower girl",
    "ring bearer", "wedding rehearsal", "getting ready hair and makeup",
    "putting on wedding dress", "groom getting dressed",
    "first look between bride and groom", "outdoor wedding venue",
    "indoor wedding venue", "candid laughter", "tears of joy",
    "drone aerial view of venue", "decor and table setting",
    "behind the scenes preparation", "empty room or test footage",
]

_clip = None  # (model, preprocess, tokenizer, text_features, device)


def analyze_local_file(
    local_path: str,
    cleanup: bool = True,
    keyframe_paths: Optional[List[str]] = None,
) -> Optional[Dict[str, Any]]:
    out: Dict[str, Any] = {
        "shots": _detect_shots(local_path),
        "labels": _clip_labels(keyframe_paths or []),
        "transcript": None,
        "words": [],
        "persons": [],
    }

    try:
        import whisper_transcribe
        wh = whisper_transcribe.transcribe(local_path)
        if wh:
            out["transcript"] = wh.get("transcript")
            out["words"] = wh.get("words") or []
    except Exception as exc:  # noqa: BLE001
        logger.warning("local_video: whisper failed for %s: %s", local_path, exc)

    return out


def _detect_shots(local_path: str) -> List[Dict[str, float]]:
    try:
        from scenedetect import detect, ContentDetector
        scene_list = detect(local_path, ContentDetector())
        return [
            {"start_sec": s.get_seconds(), "end_sec": e.get_seconds()}
            for s, e in scene_list
        ]
    except Exception as exc:  # noqa: BLE001
        logger.warning("local_video: scene detect failed for %s: %s", local_path, exc)
        return []


def _load_clip():
    global _clip
    if _clip is not None:
        return _clip
    import download_progress
    download_progress.install()
    import torch
    import open_clip
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    logger.info("local_video: loading CLIP %s/%s on %s (first call may download ~600 MB)", CLIP_MODEL, CLIP_PRETRAINED, device)
    model, _, preprocess = open_clip.create_model_and_transforms(
        CLIP_MODEL, pretrained=CLIP_PRETRAINED,
    )
    model = model.to(device).eval()
    tokenizer = open_clip.get_tokenizer(CLIP_MODEL)
    with torch.no_grad():
        text_tokens = tokenizer(WEDDING_VOCAB).to(device)
        text_features = model.encode_text(text_tokens)
        text_features /= text_features.norm(dim=-1, keepdim=True)
    _clip = (model, preprocess, tokenizer, text_features, device)
    logger.info("local_video: CLIP ready")
    return _clip


def _clip_labels(keyframe_paths: List[str]) -> List[Dict[str, Any]]:
    paths = [p for p in keyframe_paths if p and Path(p).exists()]
    if not paths:
        return []
    try:
        import torch
        from PIL import Image
        model, preprocess, _tok, text_features, device = _load_clip()
        with torch.no_grad():
            imgs = [preprocess(Image.open(p).convert("RGB")) for p in paths]
            batch = torch.stack(imgs).to(device)
            img_features = model.encode_image(batch)
            img_features /= img_features.norm(dim=-1, keepdim=True)
            # mean-pool image embeddings → one similarity vector
            mean_img = img_features.mean(dim=0, keepdim=True)
            sims = (mean_img @ text_features.T).squeeze(0)  # [vocab]
            scores = sims.float().cpu().tolist()
    except Exception as exc:  # noqa: BLE001
        logger.exception("local_video: CLIP labeling failed: %s", exc)
        return []

    indexed = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)
    out: List[Dict[str, Any]] = []
    for idx, score in indexed[:CLIP_TOP_K]:
        if score < CLIP_SCORE_THRESHOLD:
            break
        out.append({
            "label": WEDDING_VOCAB[idx],
            "confidence": round(float(score), 3),
            "start_sec": 0.0,
            "end_sec": 0.0,  # CLIP labels are clip-level, not time-localized
        })
    return out
