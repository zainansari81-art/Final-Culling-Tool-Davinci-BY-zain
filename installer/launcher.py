"""Menu-bar / system-tray launcher for the Wedding Culling Tool.

End users double-click this and forget the terminal exists. Owns the
backend process lifecycle so an unclean quit doesn't orphan uvicorn.

Cross-platform via pystray (macOS menu bar, Windows tray, Linux tray).
"""

from __future__ import annotations

import os
import platform
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path
from typing import Optional

import pystray
from PIL import Image, ImageDraw, ImageFont

BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = int(os.environ.get("CULL_PORT", "8000"))
BACKEND_URL = f"http://{BACKEND_HOST}:{BACKEND_PORT}"
FRONTEND_URL = os.environ.get("CULL_FRONTEND_URL", "http://127.0.0.1:5173")
HEALTH_PATH = "/ai/info"
HEALTH_TIMEOUT = 1.5

_state = {
    "proc": None,            # subprocess.Popen | None
    "healthy": False,
}


# ─────────────────────────── Backend lifecycle ──────────────────────────────

def _resolve_backend_command() -> list[str]:
    override = os.environ.get("CULL_BACKEND_BIN")
    if override:
        return [override]
    here = Path(__file__).resolve().parent
    bundled_mac_lin = here / "culling-backend" / "culling-backend"
    bundled_win = here / "culling-backend" / "culling-backend.exe"
    if bundled_win.exists():
        return [str(bundled_win)]
    if bundled_mac_lin.exists():
        return [str(bundled_mac_lin)]
    # Dev fallback: run_backend.py via the same Python that launched us.
    dev = here / "run_backend.py"
    if dev.exists():
        return [sys.executable, str(dev)]
    raise FileNotFoundError(
        "Could not locate the backend binary. Set CULL_BACKEND_BIN or run "
        "PyInstaller against installer/culling-backend.spec first."
    )


def _spawn_backend() -> subprocess.Popen:
    cmd = _resolve_backend_command()
    env = os.environ.copy()
    env.setdefault("AI_BACKEND", "cloud")
    env["CULL_HOST"] = BACKEND_HOST
    env["CULL_PORT"] = str(BACKEND_PORT)
    creation_flags = 0
    if platform.system() == "Windows":
        creation_flags = subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
    proc = subprocess.Popen(
        cmd,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creation_flags,
    )
    return proc


def _health_check() -> bool:
    try:
        req = urllib.request.Request(BACKEND_URL + HEALTH_PATH)
        with urllib.request.urlopen(req, timeout=HEALTH_TIMEOUT):
            return True
    except Exception:  # noqa: BLE001
        return False


def _watch_health(icon: pystray.Icon) -> None:
    """Background polling loop that updates the tray title/icon."""
    while True:
        ok = _health_check()
        if ok != _state["healthy"]:
            _state["healthy"] = ok
            try:
                icon.update_menu()
            except Exception:  # noqa: BLE001
                pass
        time.sleep(2.5)


def _restart_backend(icon: pystray.Icon, _item: object) -> None:
    proc: Optional[subprocess.Popen] = _state.get("proc")
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    _state["proc"] = _spawn_backend()


def _quit(icon: pystray.Icon, _item: object) -> None:
    proc: Optional[subprocess.Popen] = _state.get("proc")
    if proc and proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
    icon.stop()


def _open_web_ui(_icon: pystray.Icon, _item: object) -> None:
    webbrowser.open(FRONTEND_URL)


def _open_api(_icon: pystray.Icon, _item: object) -> None:
    webbrowser.open(BACKEND_URL + "/docs")


# ─────────────────────────── Tray icon ──────────────────────────────────────

def _make_icon_image(healthy: bool) -> Image.Image:
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    body = (255, 110, 0) if healthy else (130, 130, 130)
    draw.rounded_rectangle((6, 14, 58, 50), radius=6, fill=body)
    draw.polygon([(24, 22), (24, 42), (44, 32)], fill=(255, 255, 255))
    return img


def _build_menu() -> pystray.Menu:
    def status_label(_item: object) -> str:
        return "Backend up ✓" if _state["healthy"] else "Backend starting…"

    return pystray.Menu(
        pystray.MenuItem(status_label, None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Open Web UI", _open_web_ui, default=True),
        pystray.MenuItem("Open API docs", _open_api),
        pystray.MenuItem("Restart backend", _restart_backend),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", _quit),
    )


def main() -> int:
    _state["proc"] = _spawn_backend()
    icon = pystray.Icon(
        "CullingTool",
        _make_icon_image(False),
        "Wedding Culling Tool",
        menu=_build_menu(),
    )

    def _on_healthy_change(self_icon: pystray.Icon) -> None:
        # Swap the icon image when health flips so the user sees the change.
        self_icon.icon = _make_icon_image(_state["healthy"])

    # Background health watcher updates state + menu label every 2.5 s.
    t = threading.Thread(target=_watch_health, args=(icon,), daemon=True)
    t.start()

    # pystray drives the OS event loop on the main thread.
    icon.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
