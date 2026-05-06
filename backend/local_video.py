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

# Each canonical segment maps to a list of CLIP prompts. classify_segment()
# averages similarity per group and picks the strongest. Lets us override
# a small VLM that confuses bride/groom prep.
CANONICAL_SEGMENT_PROMPTS: Dict[str, List[str]] = {
    "Bride Getting Ready": [
        "a white wedding dress hanging on a hanger",
        "a bride having her hair and makeup done",
        "a bride putting on her wedding dress",
        "wedding shoes and jewelry laid out on a table",
        "a bridal bouquet on a vanity",
    ],
    "Groomsmen Getting Ready": [
        "a tuxedo or dark suit hanging on a hanger",
        "a groom putting on a tie or bowtie",
        "men in matching suits posing together",
        "cufflinks and pocket squares on a table",
        "a groom getting his boutonniere pinned",
    ],
    "First Look": [
        "a couple seeing each other for the first time before the wedding",
        "groom turning around to see bride",
    ],
    "Ceremony": [
        "wedding ceremony at the altar with officiant",
        "exchange of wedding vows",
        "exchange of wedding rings",
        "the bride walking down the aisle",
    ],
    "Cocktail Hour": [
        "guests drinking cocktails and chatting",
        "outdoor cocktail bar at a wedding",
    ],
    "Reception / First Dance": [
        "couple's first dance at wedding reception",
        "guests dancing on the dance floor",
        "wedding cake on display",
    ],
    "Toasts": [
        "wedding speech being given with microphone",
        "champagne toast at wedding reception",
    ],
    "Drone / Aerial": [
        "outdoor aerial drone shot of a wedding venue from high above",
        "bird's eye view of a building and surrounding landscape from a drone",
        "aerial overhead shot of trees and grounds from a drone in flight",
    ],
    "Ambiance / BTS": [
        "decor and table setting at a wedding reception",
        "behind the scenes wedding crew on set",
        "candles and floral arrangements close up",
        "empty indoor wedding venue before guests arrive",
        "close up detail shot of wedding accessories like sunglasses or favors",
        "indoor wide shot of guests sitting around a table",
    ],
    "Backup": [
        "lens cap or color chart test footage",
        "blurry or unusable video frame",
        "completely black or garbled image",
    ],
}

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
_seg_text_features = None  # (segment_name, prompt_count, mean_features) per row


def analyze_local_file(
    local_path: str,
    cleanup: bool = True,
    keyframe_paths: Optional[List[str]] = None,
) -> Optional[Dict[str, Any]]:
    kfs = keyframe_paths or []
    seg_pred = classify_segment(kfs)
    out: Dict[str, Any] = {
        "shots": _detect_shots(local_path),
        "labels": _clip_labels(kfs),
        "transcript": None,
        "words": [],
        "persons": [],
        "clip_segment": seg_pred,  # {"segment": str, "score": float, "ranked": [...]}
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


def _load_segment_features():
    """Build per-segment mean text embeddings once."""
    global _seg_text_features
    if _seg_text_features is not None:
        return _seg_text_features
    import torch
    model, _, tokenizer, _vocab_features, device = _load_clip()
    rows: List[tuple] = []
    with torch.no_grad():
        for seg_name, prompts in CANONICAL_SEGMENT_PROMPTS.items():
            tokens = tokenizer(prompts).to(device)
            feats = model.encode_text(tokens)
            feats /= feats.norm(dim=-1, keepdim=True)
            mean = feats.mean(dim=0, keepdim=True)
            mean /= mean.norm(dim=-1, keepdim=True)
            rows.append((seg_name, mean))
    _seg_text_features = rows
    return _seg_text_features


def classify_segment(keyframe_paths: List[str]) -> Optional[Dict[str, Any]]:
    """Return CLIP-based canonical-segment prediction.

    {"segment": str, "score": float, "ranked": [(segment, score), ...]}
    or None when no usable keyframes / CLIP load fails.
    """
    paths = [p for p in keyframe_paths if p and Path(p).exists()]
    if not paths:
        return None
    try:
        import torch
        from PIL import Image
        model, preprocess, _tok, _vocab_features, device = _load_clip()
        seg_features = _load_segment_features()
        with torch.no_grad():
            imgs = [preprocess(Image.open(p).convert("RGB")) for p in paths]
            batch = torch.stack(imgs).to(device)
            img_features = model.encode_image(batch)
            img_features /= img_features.norm(dim=-1, keepdim=True)
            mean_img = img_features.mean(dim=0, keepdim=True)
            mean_img /= mean_img.norm(dim=-1, keepdim=True)
            ranked = []
            for seg_name, seg_mean in seg_features:
                sim = float((mean_img @ seg_mean.T).squeeze().item())
                ranked.append((seg_name, sim))
            ranked.sort(key=lambda x: x[1], reverse=True)
    except Exception as exc:  # noqa: BLE001
        logger.warning("local_video: classify_segment failed: %s", exc)
        return None

    top_seg, top_score = ranked[0]
    return {
        "segment": top_seg,
        "score": round(top_score, 3),
        "ranked": [(s, round(v, 3)) for s, v in ranked[:5]],
    }
