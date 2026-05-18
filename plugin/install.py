"""Install / uninstall the Wedding Culling Tool plugin into DaVinci Resolve.

Usage:
    python3 plugin/install.py            # install
    python3 plugin/install.py --uninstall

Resolve must be closed for first install to pick up the new menu entry
(Workspace > Scripts > Edit > CullingTool).
"""

from __future__ import annotations

import argparse
import platform
import shutil
import sys
from pathlib import Path

PLUGIN_FILENAME = "CullingTool.py"
HERE = Path(__file__).resolve().parent
SOURCE = HERE / PLUGIN_FILENAME


def _install_dir() -> Path:
    sysname = platform.system()
    home = Path.home()
    if sysname == "Darwin":
        return (
            home
            / "Library"
            / "Application Support"
            / "Blackmagic Design"
            / "DaVinci Resolve"
            / "Fusion"
            / "Scripts"
            / "Edit"
        )
    if sysname == "Windows":
        import os
        appdata = Path(os.environ.get("APPDATA", str(home / "AppData" / "Roaming")))
        return (
            appdata
            / "Blackmagic Design"
            / "DaVinci Resolve"
            / "Support"
            / "Fusion"
            / "Scripts"
            / "Edit"
        )
    # Linux + everything else
    return home / ".local" / "share" / "DaVinciResolve" / "Fusion" / "Scripts" / "Edit"


def install() -> int:
    if not SOURCE.exists():
        print(f"ERROR: source not found: {SOURCE}", file=sys.stderr)
        return 1
    target_dir = _install_dir()
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        print(f"ERROR: could not create {target_dir}: {exc}", file=sys.stderr)
        return 1
    target = target_dir / PLUGIN_FILENAME
    try:
        shutil.copy2(SOURCE, target)
    except Exception as exc:
        print(f"ERROR: could not copy plugin: {exc}", file=sys.stderr)
        return 1

    # Write the repo root hint so CullingTool.py can locate the backend
    # without the user setting any env vars. The script is installed in
    # Resolve's Scripts dir; the repo lives wherever this installer ran
    # from. Two levels up from `plugin/install.py` = repo root.
    repo_root = (HERE.parent).resolve()
    cache_dir = Path.home() / ".cache" / "wedding-culling-tool"
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
        (cache_dir / "repo_root.txt").write_text(str(repo_root) + "\n")
    except Exception as exc:
        print(f"WARN: could not write repo hint: {exc}", file=sys.stderr)

    print(f"Installed plugin → {target}")
    print(f"Repo root hint   → {cache_dir / 'repo_root.txt'}  ({repo_root})")
    print()
    print("Next steps in DaVinci Resolve:")
    print("  1. Quit and reopen Resolve so the menu re-scans.")
    print("  2. Preferences > System > General > External scripting using = Local")
    print("  3. Workspace > Scripts > Edit > CullingTool")
    print()
    print("That single click spawns the backend if it isn't running and opens")
    print("the tool in your default browser. No terminal needed.")
    return 0


def uninstall() -> int:
    target = _install_dir() / PLUGIN_FILENAME
    if not target.exists():
        print(f"Nothing to remove (no file at {target}).")
        return 0
    try:
        target.unlink()
    except Exception as exc:
        print(f"ERROR: could not remove {target}: {exc}", file=sys.stderr)
        return 1
    print(f"Removed {target}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Install CullingTool into DaVinci Resolve")
    p.add_argument("--uninstall", action="store_true", help="Remove the plugin")
    args = p.parse_args()
    return uninstall() if args.uninstall else install()


if __name__ == "__main__":
    sys.exit(main())
