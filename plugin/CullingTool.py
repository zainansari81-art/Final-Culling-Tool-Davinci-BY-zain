"""CullingTool — DaVinci Resolve Workspace > Scripts > Edit > CullingTool

Single-click launcher: spawns the backend if not running, then opens the
React UI in the user's default browser. The backend is detached so it
keeps serving when Resolve quits.

Install via:
    python3 plugin/install.py

Stdlib only — runs in Resolve's bundled Python.
"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import time
import tkinter as tk
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from tkinter import messagebox
from typing import List, Optional

BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 8000
BACKEND_URL = f"http://{BACKEND_HOST}:{BACKEND_PORT}"
HEALTH_PATH = "/ai/info"
HEALTH_TIMEOUT_S = 1.5
SPAWN_WAIT_S = 30

CACHE_DIR = Path.home() / ".cache" / "wedding-culling-tool"
REPO_HINT_FILE = CACHE_DIR / "repo_root.txt"
BACKEND_LOG = CACHE_DIR / "backend.log"


# ─────────────────────────── Probes ─────────────────────────────────────────

def _backend_up() -> bool:
    try:
        with urllib.request.urlopen(BACKEND_URL + HEALTH_PATH, timeout=HEALTH_TIMEOUT_S):
            return True
    except Exception:  # noqa: BLE001
        return False


# ─────────────────────────── Repo discovery ─────────────────────────────────

def _candidate_repo_roots() -> List[Path]:
    cands: List[Path] = []
    env_root = os.environ.get("CULL_REPO_ROOT")
    if env_root:
        cands.append(Path(env_root))
    if REPO_HINT_FILE.exists():
        try:
            txt = REPO_HINT_FILE.read_text().strip()
            if txt:
                cands.append(Path(txt))
        except Exception:  # noqa: BLE001
            pass
    # Three levels up from this script's install location (best effort).
    here = Path(__file__).resolve().parent
    cands.append(here.parent.parent.parent)
    # Dev fallback.
    cands.append(Path("/Users/Shared/Final-Culling-Tool-Davinci-BY-zain"))
    return cands


def _find_repo_root() -> Optional[Path]:
    for c in _candidate_repo_roots():
        if (c / "backend" / "main.py").exists() or (
            c / "installer" / "run_backend.py"
        ).exists():
            return c
    return None


# ─────────────────────────── Backend spawn ──────────────────────────────────

def _resolve_backend_cmd(repo: Path) -> Optional[List[str]]:
    bundled_unix = repo / "installer" / "culling-backend" / "culling-backend"
    bundled_win = repo / "installer" / "culling-backend" / "culling-backend.exe"
    if platform.system() == "Windows" and bundled_win.exists():
        return [str(bundled_win)]
    if bundled_unix.exists():
        return [str(bundled_unix)]
    venv_py_unix = repo / "backend" / "venv" / "bin" / "python"
    venv_py_win = repo / "backend" / "venv" / "Scripts" / "python.exe"
    run_backend = repo / "installer" / "run_backend.py"
    if not run_backend.exists():
        return None
    if platform.system() == "Windows" and venv_py_win.exists():
        return [str(venv_py_win), str(run_backend)]
    if venv_py_unix.exists():
        return [str(venv_py_unix), str(run_backend)]
    return ["python3", str(run_backend)]


def _spawn_detached(cmd: List[str], cwd: Path) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    log_f = open(BACKEND_LOG, "a", buffering=1)  # line-buffered
    log_f.write(
        f"\n--- spawn {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n"
        f"cmd: {cmd}\ncwd: {cwd}\n"
    )
    env = os.environ.copy()
    env.setdefault("AI_BACKEND", "cloud")
    env["CULL_HOST"] = BACKEND_HOST
    env["CULL_PORT"] = str(BACKEND_PORT)
    if platform.system() == "Windows":
        DETACHED_PROCESS = 0x00000008
        CREATE_NEW_PROCESS_GROUP = 0x00000200
        subprocess.Popen(
            cmd,
            cwd=str(cwd),
            env=env,
            stdout=log_f,
            stderr=log_f,
            stdin=subprocess.DEVNULL,
            creationflags=DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
            close_fds=True,
        )
    else:
        subprocess.Popen(
            cmd,
            cwd=str(cwd),
            env=env,
            stdout=log_f,
            stderr=log_f,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
            close_fds=True,
        )


# ─────────────────────────── Tk error dialog ────────────────────────────────

def _err_dialog(msg: str) -> None:
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    messagebox.showerror("CullingTool", msg)
    root.destroy()


# ─────────────────────────── Main ───────────────────────────────────────────

def main() -> int:
    if _backend_up():
        webbrowser.open(BACKEND_URL + "/")
        return 0

    repo = _find_repo_root()
    if repo is None:
        _err_dialog(
            "Wedding Culling Tool isn't installed in a place I can find.\n\n"
            "Set CULL_REPO_ROOT to your repo path, or write the path to:\n"
            f"{REPO_HINT_FILE}\n\n"
            "Then re-run Workspace > Scripts > Edit > CullingTool."
        )
        return 1

    cmd = _resolve_backend_cmd(repo)
    if cmd is None:
        _err_dialog(
            f"Found the repo at:\n  {repo}\n\n"
            "But couldn't locate either the bundled binary at\n"
            "installer/culling-backend/culling-backend or the dev launcher\n"
            "installer/run_backend.py. Reinstall the tool."
        )
        return 1

    try:
        _spawn_detached(cmd, cwd=repo)
    except Exception as exc:  # noqa: BLE001
        _err_dialog(f"Couldn't spawn the backend:\n\n{type(exc).__name__}: {exc}")
        return 1

    deadline = time.monotonic() + SPAWN_WAIT_S
    while time.monotonic() < deadline:
        if _backend_up():
            webbrowser.open(BACKEND_URL + "/")
            return 0
        time.sleep(0.7)

    _err_dialog(
        "Backend failed to start within 30 s.\n\n"
        f"Check the log at:\n  {BACKEND_LOG}\n\n"
        "Common causes: another process on port 8000, missing venv, broken "
        "credentials in keychain. Run `bash start.sh` once in a terminal to "
        "see the real error."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
