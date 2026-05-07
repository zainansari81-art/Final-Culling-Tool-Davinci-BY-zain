"""CullingTool — DaVinci Resolve Workspace > Scripts entry point.

Install:
    macOS:   ~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Edit/
    Windows: %APPDATA%/Blackmagic Design/DaVinci Resolve/Support/Fusion/Scripts/Edit/
    Linux:   ~/.local/share/DaVinciResolve/Fusion/Scripts/Edit/

Run:
    DaVinci Resolve → Workspace → Scripts → Edit → CullingTool

Talks to the Wedding Culling Tool backend at http://127.0.0.1:8000. Backend
must already be running (start.sh). Free-tier Resolve also needs
Preferences > System > General > External scripting using = Local.
"""

from __future__ import annotations

import json
import sys
import tkinter as tk
import urllib.error
import urllib.request
from tkinter import messagebox, ttk
from typing import Any, Dict, List, Optional

BACKEND = "http://127.0.0.1:8000"
TIMEOUT_SEC = 8


# ─────────────────────────── HTTP helpers (stdlib only) ─────────────────────

def _http_get(path: str) -> Any:
    req = urllib.request.Request(BACKEND + path, method="GET")
    with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _http_post(path: str, body: Dict[str, Any]) -> Any:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        BACKEND + path,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ─────────────────────────── Tk dialogs ─────────────────────────────────────

def _root_window() -> tk.Tk:
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    return root


def _err(msg: str) -> None:
    root = _root_window()
    messagebox.showerror("CullingTool", msg)
    root.destroy()


def _info(title: str, msg: str) -> None:
    root = _root_window()
    messagebox.showinfo(title, msg)
    root.destroy()


def _confirm_push_dialog(job: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Returns {include_near_miss, include_rejected, mode} or None on cancel."""
    clips = job.get("clips", [])
    approved = sum(1 for c in clips if c.get("approved") is True)
    near_miss = sum(1 for c in clips if c.get("near_miss"))
    rejected = sum(1 for c in clips if c.get("approved") is False)
    folder = (job.get("folder_path") or "").rstrip("/").split("/")[-1] or "(folder)"

    root = tk.Tk()
    root.title("CullingTool — Push to Resolve")
    root.attributes("-topmost", True)
    root.geometry("420x260")

    pad = {"padx": 16, "pady": 6}

    ttk.Label(
        root,
        text=f"Push  {folder}  to current Resolve project?",
        font=("Helvetica", 13, "bold"),
    ).pack(anchor="w", **pad)

    ttk.Label(
        root,
        text=(
            f"approved {approved}    near-miss {near_miss}    rejected {rejected}"
        ),
        foreground="#666",
    ).pack(anchor="w", **pad)

    near_var = tk.IntVar(value=1)
    reject_var = tk.IntVar(value=0)
    new_tl_var = tk.IntVar(value=1)

    ttk.Checkbutton(
        root, text=f"Include near-miss clips ({near_miss})", variable=near_var
    ).pack(anchor="w", **pad)
    ttk.Checkbutton(
        root, text=f"Include rejected clips ({rejected})", variable=reject_var
    ).pack(anchor="w", **pad)
    ttk.Checkbutton(
        root,
        text="Create new timeline (off = append to active timeline)",
        variable=new_tl_var,
    ).pack(anchor="w", **pad)

    chosen: Dict[str, Any] = {}

    def _on_push() -> None:
        chosen.update({
            "include_near_miss": bool(near_var.get()),
            "include_rejected": bool(reject_var.get()),
            "mode": "new_timeline" if new_tl_var.get() else "append",
        })
        root.destroy()

    def _on_cancel() -> None:
        root.destroy()

    btn_row = ttk.Frame(root)
    btn_row.pack(fill="x", side="bottom", padx=16, pady=12)
    ttk.Button(btn_row, text="Cancel", command=_on_cancel).pack(side="right")
    ttk.Button(btn_row, text="Push", command=_on_push).pack(side="right", padx=6)

    root.mainloop()
    return chosen if chosen else None


# ─────────────────────────── Main ───────────────────────────────────────────

def _pick_latest_done_job() -> Optional[Dict[str, Any]]:
    try:
        jobs: List[Dict[str, Any]] = _http_get("/jobs")
    except Exception as exc:  # noqa: BLE001
        _err(
            "Couldn't reach the Wedding Culling backend.\n\n"
            "Start the backend first:\n  bash start.sh\n\n"
            f"({type(exc).__name__}: {exc})"
        )
        return None
    done = [j for j in jobs if j.get("status") == "done"]
    if not done:
        _info(
            "CullingTool",
            "No completed jobs yet.\n\nOpen the browser tool, run an analysis "
            "to completion, then re-run this script.",
        )
        return None
    # /jobs returns newest first per the backend route, but resort defensively.
    done.sort(key=lambda j: j.get("created_at") or "", reverse=True)
    return done[0]


def main() -> int:
    job = _pick_latest_done_job()
    if not job:
        return 1
    chosen = _confirm_push_dialog(job)
    if not chosen:
        return 0  # user cancelled
    job_id = job["id"]
    try:
        result = _http_post(f"/jobs/{job_id}/resolve/push", chosen)
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8"))
            detail = payload.get("detail") or str(exc)
        except Exception:  # noqa: BLE001
            detail = str(exc)
        _err(f"Backend rejected push:\n\n{detail}")
        return 2
    except Exception as exc:  # noqa: BLE001
        _err(f"Push failed:\n\n{type(exc).__name__}: {exc}")
        return 2

    if not result.get("ok"):
        _err(result.get("error") or "Push reported failure (no detail).")
        return 2

    msg = (
        f"Added {result.get('clips_added', 0)} clips to timeline "
        f"'{result.get('timeline_name')}' in project "
        f"'{result.get('project_name')}'.\n\n"
        f"Skipped {result.get('clips_skipped', 0)} clips."
    )
    errs = result.get("errors") or []
    if errs:
        msg += "\n\nErrors:\n  " + "\n  ".join(errs[:10])
        if len(errs) > 10:
            msg += f"\n  ... and {len(errs) - 10} more"
    _info("CullingTool — done", msg)
    return 0


if __name__ == "__main__":
    sys.exit(main())
