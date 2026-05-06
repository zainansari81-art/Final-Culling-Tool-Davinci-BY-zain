"""Surface model-download progress through the Python `logging` system.

HuggingFace and tqdm write progress bars directly to stderr, which bypasses
the JobLogHandler installed by main.py. Result: the in-tool log pane goes
silent for several minutes during the first model download.

This module monkeypatches tqdm so every progress bar also emits
`logger.info(...)` lines at decile milestones (10/20/.../100 %). Once
installed, both huggingface_hub and open_clip downloads start showing
up in /jobs/{id}/logs.

Call download_progress.install() before triggering a download. Idempotent.
"""

from __future__ import annotations

import logging
import time
from typing import Any

logger = logging.getLogger("analyzer")

_installed = False


def install() -> None:
    global _installed
    if _installed:
        return

    # Make sure HF doesn't disable progress bars and prefer the http path
    # so tqdm is always invoked (xet path also uses tqdm but emits less
    # frequently on some networks).
    import os as _os
    _os.environ.pop("HF_HUB_DISABLE_PROGRESS_BARS", None)

    import tqdm as _tqdm
    import tqdm.auto as _tqdm_auto

    base_cls = _tqdm.tqdm

    class _LoggingTqdm(base_cls):  # type: ignore[misc, valid-type]
        STEP = 5  # log every 5%

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            kwargs.pop("name", None)  # hf_hub passes this; base tqdm rejects it
            super().__init__(*args, **kwargs)
            self._last_step: int = -1
            self._started: float = time.time()
            total = getattr(self, "total", None) or 0
            unit = getattr(self, "unit", "it") or "it"
            unit_scale = getattr(self, "unit_scale", False)
            desc = (getattr(self, "desc", "") or "download").strip(": ")
            if total > 0:
                if unit_scale and unit in ("B", "iB"):
                    logger.info(
                        "↓ start %s (%.1f MB)", desc, total / (1024 * 1024),
                    )
                else:
                    logger.info("↓ start %s (%d %s)", desc, total, unit)

        def update(self, n: int = 1) -> Any:
            res = super().update(n)
            self._maybe_log()
            return res

        def close(self) -> Any:
            res = super().close()
            try:
                total = getattr(self, "total", None) or 0
                n = getattr(self, "n", 0) or 0
                if total > 0 and n >= total and self._last_step < 100:
                    self._emit(100)
            except Exception:  # noqa: BLE001
                pass
            return res

        def _maybe_log(self) -> None:
            total = getattr(self, "total", None) or 0
            n = getattr(self, "n", 0) or 0
            if total <= 0:
                return
            pct = int((n * 100) // total)
            step = pct - (pct % self.STEP)
            if step <= self._last_step or step <= 0:
                return
            self._emit(step)

        def _emit(self, step: int) -> None:
            self._last_step = step
            n = getattr(self, "n", 0) or 0
            total = getattr(self, "total", 0) or 0
            unit = getattr(self, "unit", "it") or "it"
            unit_scale = getattr(self, "unit_scale", False)
            elapsed = max(time.time() - self._started, 0.001)
            desc = (getattr(self, "desc", "") or "download").strip(": ")
            if unit_scale and unit in ("B", "iB"):
                done_mb = n / (1024 * 1024)
                total_mb = total / (1024 * 1024)
                rate_mb = done_mb / elapsed
                logger.info(
                    "%s: %d%% (%.1f/%.1f MB @ %.1f MB/s)",
                    desc, step, done_mb, total_mb, rate_mb,
                )
            else:
                logger.info(
                    "%s: %d%% (%d/%d %s)",
                    desc, step, n, total, unit,
                )

    # Replace public exports so callers picking either path get the logger.
    _tqdm.tqdm = _LoggingTqdm  # type: ignore[assignment]
    _tqdm_auto.tqdm = _LoggingTqdm  # type: ignore[assignment]

    # huggingface_hub holds its own reference imported at module load.
    try:
        import huggingface_hub.utils.tqdm as _hf_tqdm  # type: ignore[import-not-found]
        _hf_tqdm.tqdm = _LoggingTqdm  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass
    try:
        import huggingface_hub.file_download as _hf_dl  # type: ignore[import-not-found]
        if hasattr(_hf_dl, "tqdm"):
            _hf_dl.tqdm = _LoggingTqdm  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass

    _installed = True
    logger.info("download_progress: tqdm patched, downloads will log to job log")
