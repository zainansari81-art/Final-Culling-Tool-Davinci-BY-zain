"""Archetype-aware trim refinement (Phase 1c).

Each archetype here corresponds to one canonical segment. Given a
candidate window inside a clip plus the dense per-second signals
(motion + audio RMS) and Whisper word timestamps, the archetype's
score_window fn returns a number — higher = better match for that
archetype's "real moment".

The refiner picks the highest-scoring stable+smooth window of at
least MIN_KEEP_SEC seconds, applies handles, and returns it as the
new trim suggestion.

This complements stability_trim: stability says WHERE the camera is
steady; archetypes say WHICH steady run actually contains the moment.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Tuple

# A "window" is an (inclusive_start_sec, exclusive_end_sec) pair.
Window = Tuple[float, float]


@dataclass
class DenseSignal:
    motion: List[float]        # per-second mean optical-flow magnitude
    audio_rms: List[float]     # per-second audio RMS
    words: List[Dict]          # [{word, start_sec, end_sec, speaker_tag}]
    duration_sec: float
    sample_hz: float = 1.0


# ─────────────────────────── Helper metrics ─────────────────────────────────

def _mean(xs: List[float]) -> float:
    return float(sum(xs) / len(xs)) if xs else 0.0


def _slice(signal: List[float], start_sec: float, end_sec: float, hz: float) -> List[float]:
    s = max(0, int(start_sec * hz))
    e = min(len(signal), int(end_sec * hz))
    return signal[s:e] if e > s else []


def _word_density(words: List[Dict], start_sec: float, end_sec: float) -> float:
    """Words spoken per second inside the window."""
    if end_sec <= start_sec:
        return 0.0
    n = sum(1 for w in words if start_sec <= w.get("start_sec", -1) < end_sec)
    return n / (end_sec - start_sec)


def _audio_peak_inside(window: Window, signal: DenseSignal) -> float:
    """Max audio RMS inside the window — proxy for moment intensity."""
    seg = _slice(signal.audio_rms, window[0], window[1], signal.sample_hz)
    return max(seg) if seg else 0.0


def _motion_variance(window: Window, signal: DenseSignal) -> float:
    seg = _slice(signal.motion, window[0], window[1], signal.sample_hz)
    if not seg:
        return 0.0
    m = _mean(seg)
    return sum((x - m) ** 2 for x in seg) / len(seg)


# ─────────────────────────── Per-archetype scorers ──────────────────────────
# Each returns a scalar where higher = stronger match. Composed of cheap
# signals only — no VLM, no pose detection (Phase 2b adds those).

def _score_bride_prep(w: Window, s: DenseSignal) -> float:
    # Calm preparation. Prefer LOW motion + LOW audio (no chaos).
    audio_seg = _slice(s.audio_rms, w[0], w[1], s.sample_hz)
    motion_seg = _slice(s.motion, w[0], w[1], s.sample_hz)
    # Center bias: middle of clip is more likely to be the actual gown moment.
    center = 0.5 * (s.duration_sec)
    win_center = 0.5 * (w[0] + w[1])
    centerness = 1.0 - min(abs(win_center - center) / max(center, 1.0), 1.0)
    return (
        1.0 - _mean(audio_seg)        # quieter is better
        - 0.3 * _mean(motion_seg)     # stiller is better
        + 0.3 * centerness
    )


def _score_groom_prep(w: Window, s: DenseSignal) -> float:
    return _score_bride_prep(w, s)  # same shape


def _score_first_look(w: Window, s: DenseSignal) -> float:
    # Strong audio peak (gasp/laugh) inside a steady window.
    return _audio_peak_inside(w, s) - 0.2 * _motion_variance(w, s)


def _score_ceremony(w: Window, s: DenseSignal) -> float:
    # Want speech (officiant + couple) AND stability.
    density = _word_density(s.words, w[0], w[1])
    return 1.5 * density + 0.3 * _audio_peak_inside(w, s)


def _score_cocktail(w: Window, s: DenseSignal) -> float:
    # Mixed crowd energy — moderate motion variance, moderate audio.
    audio_seg = _slice(s.audio_rms, w[0], w[1], s.sample_hz)
    return _mean(audio_seg) + 0.5 * _motion_variance(w, s)


def _score_first_dance(w: Window, s: DenseSignal) -> float:
    # Steady camera, music energy, low speech.
    audio_mean = _mean(_slice(s.audio_rms, w[0], w[1], s.sample_hz))
    density = _word_density(s.words, w[0], w[1])
    return audio_mean - 0.5 * density - 0.2 * _motion_variance(w, s)


def _score_toasts(w: Window, s: DenseSignal) -> float:
    # Single dominant speaker = high word density + high audio peak.
    density = _word_density(s.words, w[0], w[1])
    return 1.2 * density + 0.4 * _audio_peak_inside(w, s)


def _score_drone(w: Window, s: DenseSignal) -> float:
    # Smooth motion, low audio (often muted / re-scored).
    audio_mean = _mean(_slice(s.audio_rms, w[0], w[1], s.sample_hz))
    motion_mean = _mean(_slice(s.motion, w[0], w[1], s.sample_hz))
    return motion_mean - audio_mean - 0.2 * _motion_variance(w, s)


def _score_ambiance(w: Window, s: DenseSignal) -> float:
    # B-roll detail. Prefer the steadiest, quietest section.
    motion_seg = _slice(s.motion, w[0], w[1], s.sample_hz)
    return -_mean(motion_seg) - 0.5 * _motion_variance(w, s)


def _score_backup(w: Window, s: DenseSignal) -> float:
    # No useful preference — return 0 so refiner falls back to the
    # generic "interestingness" picker below.
    return 0.0


@dataclass
class Archetype:
    canonical: str
    description: str
    score_window: Callable[[Window, DenseSignal], float]


ARCHETYPES: Dict[str, Archetype] = {
    "Bride Getting Ready": Archetype(
        canonical="Bride Getting Ready",
        description="Calm preparation; quiet, still, mid-clip.",
        score_window=_score_bride_prep,
    ),
    "Groomsmen Getting Ready": Archetype(
        canonical="Groomsmen Getting Ready",
        description="Calm preparation.",
        score_window=_score_groom_prep,
    ),
    "First Look": Archetype(
        canonical="First Look",
        description="Audio peak inside a steady window.",
        score_window=_score_first_look,
    ),
    "Ceremony": Archetype(
        canonical="Ceremony",
        description="Sustained speech + stability.",
        score_window=_score_ceremony,
    ),
    "Cocktail Hour": Archetype(
        canonical="Cocktail Hour",
        description="Crowd energy; moderate motion + audio.",
        score_window=_score_cocktail,
    ),
    "Reception / First Dance": Archetype(
        canonical="Reception / First Dance",
        description="Music energy, low speech, steady.",
        score_window=_score_first_dance,
    ),
    "Toasts": Archetype(
        canonical="Toasts",
        description="Single dominant speaker, high word density.",
        score_window=_score_toasts,
    ),
    "Drone / Aerial": Archetype(
        canonical="Drone / Aerial",
        description="Smooth motion; ignore audio.",
        score_window=_score_drone,
    ),
    "Ambiance / BTS": Archetype(
        canonical="Ambiance / BTS",
        description="Steadiest, quietest section.",
        score_window=_score_ambiance,
    ),
    "Backup": Archetype(
        canonical="Backup",
        description="No preference — defer to default trim.",
        score_window=_score_backup,
    ),
}


def _generic_interestingness(w: Window, s: DenseSignal) -> float:
    """Fallback when no archetype provided. Audio + speech > stillness."""
    return (
        _mean(_slice(s.audio_rms, w[0], w[1], s.sample_hz))
        + 0.5 * _word_density(s.words, w[0], w[1])
    )


def refine_trim(
    segment: Optional[str],
    candidate_windows: List[Window],
    signal: DenseSignal,
    lead_in_sec: float = 1.0,
    tail_out_sec: float = 1.0,
) -> Optional[Tuple[float, float, float]]:
    """Pick the best window from candidates and apply handles.

    Returns (in_sec, out_sec, score) or None if candidate_windows is empty.
    """
    if not candidate_windows:
        return None
    arch = ARCHETYPES.get(segment or "")
    scorer = arch.score_window if arch and segment != "Backup" else _generic_interestingness
    scored = [(scorer(w, signal), w) for w in candidate_windows]
    scored.sort(reverse=True, key=lambda sw: sw[0])
    best_score, (raw_in, raw_out) = scored[0]
    in_sec = max(0.0, raw_in - lead_in_sec)
    out_sec = min(signal.duration_sec, raw_out + tail_out_sec)
    return in_sec, out_sec, best_score
