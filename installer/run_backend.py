"""PyInstaller entry point for the Wedding Culling Tool backend.

Adds the bundled `backend/` directory to sys.path so the imports
inside main.py ("from analyzer import ...", "from models import ...")
resolve correctly when running from the dist/ folder.

Default port 8000, default host 127.0.0.1. Override with CULL_HOST /
CULL_PORT env vars if the menu-bar launcher needs to dodge a port
conflict.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def _setup_sys_path() -> None:
    here = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    candidates = [here / "backend", here.parent / "backend", here]
    for c in candidates:
        if (c / "main.py").exists():
            if str(c) not in sys.path:
                sys.path.insert(0, str(c))
            return
    # Final fallback: the dir we live in.
    sys.path.insert(0, str(here))


def main() -> int:
    _setup_sys_path()
    import uvicorn  # noqa: WPS433
    host = os.environ.get("CULL_HOST", "127.0.0.1")
    port = int(os.environ.get("CULL_PORT", "8000"))
    # Default to "cloud" so a fresh install runs against the onboarding
    # wizard path; the wizard fills credentials on first launch.
    os.environ.setdefault("AI_BACKEND", "cloud")
    uvicorn.run("main:app", host=host, port=port, reload=False, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
