"""Cross-platform secure credential store for the cloud AI backend.

Two providers are supported:

  - "gemini": Google AI Studio API key (one short string starting AIza...)
  - "vertex": GCP service-account JSON + project_id + region

A separate keychain entry tracks which provider is "selected" so the
dispatcher in ai_backend.py knows where to route.

Service name SERVICE = "wedding-culling-tool" so all entries live under
one heading in the user's OS keychain UI.

ensure_vertex_env_loaded() materializes the service-account JSON to a
0600 file under ~/.cache/wedding-culling-tool/ and sets the env vars
google-auth expects (GOOGLE_APPLICATION_CREDENTIALS, GCP_PROJECT,
GCP_LOCATION). Idempotent — safe to call before every Vertex API call.
"""

from __future__ import annotations

import json
import logging
import os
import stat
from pathlib import Path
from typing import Optional

import keyring

logger = logging.getLogger("analyzer")

SERVICE = "wedding-culling-tool"

# Keychain keys.
PROVIDER_KEY = "active_provider"           # "gemini" | "vertex" | absent
GEMINI_API_KEY = "gemini_api_key"
VERTEX_PROJECT_KEY = "vertex_project_id"
VERTEX_REGION_KEY = "vertex_region"
VERTEX_SA_JSON_KEY = "vertex_service_account_json"

# Where the materialized vertex SA file lives. Stays out of git.
_SA_DIR = Path.home() / ".cache" / "wedding-culling-tool"
_SA_FILE = _SA_DIR / "vertex-sa.json"


# ─────────────────────────── Provider selection ─────────────────────────────

def set_active_provider(provider: str) -> None:
    if provider not in ("gemini", "vertex"):
        raise ValueError(f"Unknown provider: {provider!r}")
    keyring.set_password(SERVICE, PROVIDER_KEY, provider)


def get_active_provider() -> Optional[str]:
    try:
        v = keyring.get_password(SERVICE, PROVIDER_KEY)
    except Exception as exc:  # noqa: BLE001
        logger.warning("keyring read failed: %s", exc)
        return None
    return v if v in ("gemini", "vertex") else None


# ─────────────────────────── Gemini AI Studio ───────────────────────────────

def save_gemini_api_key(api_key: str) -> None:
    keyring.set_password(SERVICE, GEMINI_API_KEY, api_key)


def load_gemini_api_key() -> Optional[str]:
    try:
        return keyring.get_password(SERVICE, GEMINI_API_KEY)
    except Exception as exc:  # noqa: BLE001
        logger.warning("keyring read failed: %s", exc)
        return None


def has_gemini_api_key() -> bool:
    return bool(load_gemini_api_key())


def looks_like_gemini_key(s: str) -> bool:
    s = (s or "").strip()
    return len(s) >= 30 and s.startswith("AIza")


# ─────────────────────────── Vertex (GCP) ───────────────────────────────────

def save_vertex_credentials(
    project_id: str,
    region: str,
    service_account_json: str,
) -> None:
    keyring.set_password(SERVICE, VERTEX_PROJECT_KEY, project_id.strip())
    keyring.set_password(SERVICE, VERTEX_REGION_KEY, region.strip() or "us-central1")
    keyring.set_password(SERVICE, VERTEX_SA_JSON_KEY, service_account_json)


def load_vertex_credentials() -> Optional[dict]:
    try:
        pid = keyring.get_password(SERVICE, VERTEX_PROJECT_KEY)
        region = keyring.get_password(SERVICE, VERTEX_REGION_KEY)
        sa = keyring.get_password(SERVICE, VERTEX_SA_JSON_KEY)
    except Exception as exc:  # noqa: BLE001
        logger.warning("keyring read failed: %s", exc)
        return None
    if not (pid and region and sa):
        return None
    return {"project_id": pid, "region": region, "service_account_json": sa}


def has_vertex_credentials() -> bool:
    return bool(load_vertex_credentials())


def looks_like_service_account_json(s: str) -> bool:
    """Cheap structural check before we hit the network."""
    if not s or len(s) < 100:
        return False
    try:
        d = json.loads(s)
    except Exception:  # noqa: BLE001
        return False
    if not isinstance(d, dict):
        return False
    return d.get("type") == "service_account" and bool(d.get("private_key")) and bool(d.get("client_email"))


def ensure_vertex_env_loaded() -> bool:
    """Write the SA JSON to a 0600 file and set the env vars
    google-auth + the existing vertex_gemini.py expect. Idempotent.

    Returns True when env is now configured for Vertex, False otherwise.
    """
    creds = load_vertex_credentials()
    if not creds:
        return False
    _SA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        _SA_DIR.chmod(0o700)
    except Exception:  # noqa: BLE001
        pass
    # Only rewrite if contents differ (avoids needless disk writes per call).
    sa_text = creds["service_account_json"]
    needs_write = True
    if _SA_FILE.exists():
        try:
            needs_write = _SA_FILE.read_text() != sa_text
        except Exception:  # noqa: BLE001
            needs_write = True
    if needs_write:
        # Atomic write: stage to a sibling temp then os.replace so a
        # second concurrent caller can't observe a half-written file.
        import tempfile as _tempfile
        fd, tmp_path = _tempfile.mkstemp(prefix=".sa-", dir=str(_SA_DIR))
        try:
            with os.fdopen(fd, "w") as tmp_f:
                tmp_f.write(sa_text)
            try:
                os.chmod(tmp_path, stat.S_IRUSR | stat.S_IWUSR)  # 0600
            except Exception:  # noqa: BLE001
                pass
            os.replace(tmp_path, _SA_FILE)
        except Exception:
            try:
                os.unlink(tmp_path)
            except Exception:  # noqa: BLE001
                pass
            raise
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(_SA_FILE)
    os.environ["GCP_PROJECT"] = creds["project_id"]
    os.environ["GCP_LOCATION"] = creds["region"]
    return True


# ─────────────────────────── Wipe ────────────────────────────────────────────

def clear_all() -> None:
    """Remove every entry this app stores. Logout / reset path."""
    for k in (
        PROVIDER_KEY,
        GEMINI_API_KEY,
        VERTEX_PROJECT_KEY,
        VERTEX_REGION_KEY,
        VERTEX_SA_JSON_KEY,
    ):
        try:
            keyring.delete_password(SERVICE, k)
        except keyring.errors.PasswordDeleteError:
            pass
        except Exception as exc:  # noqa: BLE001
            logger.warning("keyring delete failed for %s: %s", k, exc)
    if _SA_FILE.exists():
        try:
            _SA_FILE.unlink()
        except Exception:  # noqa: BLE001
            pass


# ─────────────────────────── Convenience ────────────────────────────────────

def has_any_credentials() -> bool:
    p = get_active_provider()
    if p == "gemini":
        return has_gemini_api_key()
    if p == "vertex":
        return has_vertex_credentials()
    return False


# Back-compat: old callers that just want "is there a Gemini key".
def delete_gemini_api_key() -> bool:
    try:
        keyring.delete_password(SERVICE, GEMINI_API_KEY)
        return True
    except keyring.errors.PasswordDeleteError:
        return False
    except Exception as exc:  # noqa: BLE001
        logger.warning("keyring delete failed: %s", exc)
        return False
