"""Detect host hardware tier and recommend matching MLX VLM model.

Phase 2a (locked spec): auto-pick the best Qwen-family model that fits
the user's RAM. macOS-only detection for now; Linux/Windows fall back
to the safe default. Users can always force a model with LOCAL_VLM_MODEL.

Tiers:
  T0  M1/M2 base (≤8 GB unified) → Qwen2.5-VL 3B-4bit  (~2.0 GB)
  T1  M1/M2/M3 16 GB              → Qwen2.5-VL 7B-4bit (~4.5 GB)
  T2  M2/M3 Pro 32 GB             → Qwen2.5-VL 7B-4bit (more headroom)
  T3  M3/M4 Max 64 GB+            → Qwen2.5-VL 7B-bf16 (~14 GB)

Future: T4/T5 = CUDA / ROCm dispatch.
"""

from __future__ import annotations

import logging
import platform
import subprocess
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger("analyzer")


@dataclass
class HardwareProfile:
    tier: str                    # "T0" | "T1" | "T2" | "T3" | "UNKNOWN"
    chip: str                    # e.g. "Apple M1", "Apple M3 Max", "x86_64"
    ram_gb: int
    recommended_vlm: str         # MLX model id (or empty if no rec)
    notes: str = ""


_DEFAULT_VLM = "mlx-community/Qwen2.5-VL-3B-Instruct-4bit"


def _macos_chip_and_ram() -> tuple[str, int]:
    chip = "unknown"
    ram_gb = 0
    try:
        chip = subprocess.check_output(
            ["sysctl", "-n", "machdep.cpu.brand_string"], text=True,
        ).strip()
    except Exception:  # noqa: BLE001
        pass
    try:
        mem_bytes = int(subprocess.check_output(
            ["sysctl", "-n", "hw.memsize"], text=True,
        ).strip())
        ram_gb = mem_bytes // (1024 ** 3)
    except Exception:  # noqa: BLE001
        pass
    return chip, ram_gb


def detect() -> HardwareProfile:
    sysname = platform.system()
    if sysname != "Darwin":
        return HardwareProfile(
            tier="UNKNOWN",
            chip=platform.machine() or "unknown",
            ram_gb=0,
            recommended_vlm=_DEFAULT_VLM,
            notes="Non-macOS host; auto-detect not implemented yet.",
        )

    chip, ram_gb = _macos_chip_and_ram()

    # Map by RAM only — chip generation matters less than memory ceiling
    # for VLM weights.
    if ram_gb >= 64:
        tier = "T3"
        rec = "mlx-community/Qwen2.5-VL-7B-Instruct-bf16"
    elif ram_gb >= 32:
        tier = "T2"
        rec = "mlx-community/Qwen2.5-VL-7B-Instruct-4bit"
    elif ram_gb >= 16:
        tier = "T1"
        rec = "mlx-community/Qwen2.5-VL-7B-Instruct-4bit"
    else:
        tier = "T0"
        rec = _DEFAULT_VLM

    return HardwareProfile(
        tier=tier,
        chip=chip,
        ram_gb=ram_gb,
        recommended_vlm=rec,
        notes=f"Apple Silicon detected ({ram_gb} GB unified memory).",
    )
