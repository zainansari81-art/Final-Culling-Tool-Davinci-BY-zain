"""CullingTool — DaVinci Resolve Workspace > Scripts > Edit > CullingTool

Single-click launcher: spawns the backend if not running, scans the active
project's Media Pool for video clips, posts them to /jobs/from-paths, then
opens the resulting job page in a chrome-less window. Falls back to the
HomePage when no project / no clips are available.

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
import urllib.request
import webbrowser
from pathlib import Path
from typing import List, Optional, Tuple

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
    # Resolve runs scripts via exec() in a context WITHOUT __file__, so
    # this lookup is wrapped to never raise.
    try:
        here = Path(__file__).resolve().parent
        cands.append(here.parent.parent.parent)
    except NameError:
        pass
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


# ─────────────────────────── Error dialog (graceful fallback) ───────────────

def _err_dialog(msg: str) -> None:
    """Show a Tk dialog when tkinter is available, otherwise log to
    stderr (visible in Resolve's Console pane) AND open a fallback
    HTML page in the browser so the user actually sees the message."""
    print(f"\n[CullingTool ERROR]\n{msg}\n", file=sys.stderr)
    try:
        import tkinter as _tk
        from tkinter import messagebox as _mb
        root = _tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        _mb.showerror("CullingTool", msg)
        root.destroy()
    except Exception:  # noqa: BLE001
        # tkinter not bundled with this Python (e.g. brew Python 3.12).
        # Write the message to a temp HTML file and open it so the user
        # sees something even when no GUI toolkit is available.
        try:
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            err_file = CACHE_DIR / "last_error.html"
            err_file.write_text(
                "<!doctype html><meta charset='utf-8'>"
                "<title>CullingTool error</title>"
                "<body style='font:14px -apple-system,sans-serif;"
                "padding:32px;background:#111;color:#eee'>"
                "<h2 style='color:#ff6e00'>CullingTool error</h2>"
                f"<pre style='white-space:pre-wrap'>{msg}</pre>"
                "</body>"
            )
            webbrowser.open(err_file.as_uri())
        except Exception:  # noqa: BLE001
            pass


# ─────────────────────────── Media Pool scan ────────────────────────────────

def _scan_media_pool() -> Tuple[Optional[str], List[str]]:
    """Returns (project_name, video_clip_paths). project_name=None when
    Resolve isn't running / no open project — then we degrade to opening
    the regular UI without auto-creating a job."""
    try:
        import DaVinciResolveScript as dvr  # type: ignore
    except Exception:  # noqa: BLE001
        return None, []
    try:
        resolve = dvr.scriptapp("Resolve")
    except Exception:  # noqa: BLE001
        return None, []
    if not resolve:
        return None, []
    pm = resolve.GetProjectManager()
    if not pm:
        return None, []
    project = pm.GetCurrentProject()
    if not project:
        return None, []
    mp = project.GetMediaPool()
    if not mp:
        return None, []
    paths: List[str] = []

    def walk(folder) -> None:
        if not folder:
            return
        clips = folder.GetClipList() or []
        for c in clips:
            try:
                t = c.GetClipProperty("Type") or ""
                if "Video" not in t and t not in ("Movie", "Sequence"):
                    continue
                p = c.GetClipProperty("File Path") or c.GetClipProperty("Filename")
                if p:
                    paths.append(p)
            except Exception:  # noqa: BLE001
                continue
        for sub in folder.GetSubFolderList() or []:
            walk(sub)

    try:
        walk(mp.GetRootFolder())
    except Exception:  # noqa: BLE001
        pass

    seen = set()
    uniq: List[str] = []
    for p in paths:
        if p not in seen:
            seen.add(p)
            uniq.append(p)
    try:
        name = project.GetName()
    except Exception:  # noqa: BLE001
        name = None
    return name, uniq


# ─────────────────────────── HTTP POST helper ───────────────────────────────

def _post_json(path: str, body: dict, timeout: int = 30) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        BACKEND_URL + path,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ─────────────────────────── Chrome --app launcher ──────────────────────────

def _open_app_window(url: str) -> None:
    """Try Chrome / Chromium / Brave / Edge in --app mode for a chrome-less
    window. Fall back to the OS default browser."""
    chrome_candidates_mac = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Arc.app/Contents/MacOS/Arc",
    ]
    chrome_candidates_win = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
    ]
    chrome_candidates_linux = [
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/microsoft-edge",
        "/usr/bin/brave-browser",
    ]
    sysname = platform.system()
    cands = (
        chrome_candidates_win if sysname == "Windows"
        else chrome_candidates_linux if sysname == "Linux"
        else chrome_candidates_mac
    )
    for c in cands:
        if Path(c).exists():
            args = [
                c,
                f"--app={url}",
                "--window-size=1340,840",
                "--disable-features=TranslateUI",
            ]
            kwargs = {
                "stdin": subprocess.DEVNULL,
                "stdout": subprocess.DEVNULL,
                "stderr": subprocess.DEVNULL,
            }
            if sysname == "Windows":
                kwargs["creationflags"] = 0x00000008  # DETACHED_PROCESS
            else:
                kwargs["start_new_session"] = True
            try:
                subprocess.Popen(args, close_fds=True, **kwargs)
                return
            except Exception:  # noqa: BLE001
                continue
    webbrowser.open(url)


# ─────────────────────────── Backend ensure ─────────────────────────────────

def _ensure_backend() -> bool:
    """Return True when the backend is reachable (already up or successfully
    spawned). Shows _err_dialog and returns False on hard failures."""
    if _backend_up():
        return True

    repo = _find_repo_root()
    if repo is None:
        _err_dialog(
            "Wedding Culling Tool isn't installed in a place I can find.\n\n"
            "Set CULL_REPO_ROOT to your repo path, or write the path to:\n"
            f"{REPO_HINT_FILE}\n\n"
            "Then re-run Workspace > Scripts > Edit > CullingTool."
        )
        return False

    cmd = _resolve_backend_cmd(repo)
    if cmd is None:
        _err_dialog(
            f"Found the repo at:\n  {repo}\n\n"
            "But couldn't locate either the bundled binary at\n"
            "installer/culling-backend/culling-backend or the dev launcher\n"
            "installer/run_backend.py. Reinstall the tool."
        )
        return False

    try:
        _spawn_detached(cmd, cwd=repo)
    except Exception as exc:  # noqa: BLE001
        _err_dialog(f"Couldn't spawn the backend:\n\n{type(exc).__name__}: {exc}")
        return False

    deadline = time.monotonic() + SPAWN_WAIT_S
    while time.monotonic() < deadline:
        if _backend_up():
            return True
        time.sleep(0.7)

    _err_dialog(
        "Backend failed to start within 30 s.\n\n"
        f"Check the log at:\n  {BACKEND_LOG}\n\n"
        "Common causes: another process on port 8000, missing venv, broken "
        "credentials in keychain. Run `bash start.sh` once in a terminal to "
        "see the real error."
    )
    return False


# ─────────────────────────── Main ───────────────────────────────────────────

def main() -> int:
    if not _ensure_backend():
        return 1

    project_name, paths = _scan_media_pool()

    if not paths:
        _open_app_window(BACKEND_URL + "/")
        return 0

    try:
        body = {"paths": paths, "source_name": project_name or "DaVinci Project"}
        resp = _post_json("/jobs/from-paths", body)
        job_id = resp.get("job_id") or resp.get("id")
        if not job_id:
            raise RuntimeError(f"backend response missing job_id: {resp!r}")
        _open_app_window(BACKEND_URL + f"/jobs/{job_id}")
        return 0
    except Exception as exc:  # noqa: BLE001
        _err_dialog(
            "Couldn't create a job from the active project's Media Pool.\n\n"
            f"{type(exc).__name__}: {exc}\n\n"
            "Opening the home page so you can pick a folder manually."
        )
        _open_app_window(BACKEND_URL + "/")
        return 1


if __name__ == "__main__":
    sys.exit(main())
