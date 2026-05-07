"""Cross-platform secure credential store for the cloud AI backend.

Exposes save / load / delete / has for one provider key at a time.
Kept tiny — the wizard endpoints in main.py wrap these in REST.

Service name SERVICE = "wedding-culling-tool" so all keys end up
grouped under one entry in the user's keychain UI.

Currently supports the Google AI Studio API key for Gemini, since
that's the path the onboarding wizard uses (4 clicks, no billing).
Vertex via service-account JSON could plug in the same way later.
"""

from __future__ import annotations

import logging
from typing import Optional

import keyring

logger = logging.getLogger("analyzer")

SERVICE = "wedding-culling-tool"
GEMINI_KEY = "gemini_api_key"


def save_gemini_api_key(api_key: str) -> None:
    keyring.set_password(SERVICE, GEMINI_KEY, api_key)


def load_gemini_api_key() -> Optional[str]:
    try:
        return keyring.get_password(SERVICE, GEMINI_KEY)
    except Exception as exc:  # noqa: BLE001
        logger.warning("keyring read failed: %s", exc)
        return None


def delete_gemini_api_key() -> bool:
    try:
        keyring.delete_password(SERVICE, GEMINI_KEY)
        return True
    except keyring.errors.PasswordDeleteError:
        return False
    except Exception as exc:  # noqa: BLE001
        logger.warning("keyring delete failed: %s", exc)
        return False


def has_gemini_api_key() -> bool:
    return bool(load_gemini_api_key())


def looks_like_gemini_key(s: str) -> bool:
    """Cheap shape check before we even hit the network."""
    s = (s or "").strip()
    return len(s) >= 30 and s.startswith("AIza")
