"""Settings, editable from the web UI and saved to /config/settings.json.

Environment variables (set in Unraid's container template) provide the
initial values; anything saved from the settings page takes precedence.
"""
from __future__ import annotations

import json
import logging
import os
import secrets
from pathlib import Path
from types import SimpleNamespace

log = logging.getLogger(__name__)

CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", "/config"))
SETTINGS_FILE = CONFIG_DIR / "settings.json"
USER_AGENT = "Triviarr/1.0 (self-hosted home media server tool)"

# Escape hatch if SSO locks you out: set AUTH_DISABLE=true on the container.
AUTH_DISABLE = os.environ.get("AUTH_DISABLE", "").lower() in ("1", "true", "yes")

# name -> (env var, default)
FIELDS = {
    "plex_url": ("PLEX_URL", ""),
    "plex_token": ("PLEX_TOKEN", ""),
    "jellyfin_url": ("JELLYFIN_URL", ""),
    "jellyfin_api_key": ("JELLYFIN_API_KEY", ""),
    "users": ("USERS", ""),                     # only show these users' sessions
    "include_imdb": ("INCLUDE_IMDB", True),
    "include_goofs": ("INCLUDE_GOOFS", True),
    "wiki_lang": ("WIKI_LANG", "en"),
    "verify_ssl": ("VERIFY_SSL", True),
    "auth_mode": ("AUTH_MODE", "none"),         # none | plex | oidc
    "allowed_users": ("ALLOWED_USERS", ""),     # usernames/emails/groups allowed to sign in
    "admin_users": ("ADMIN_USERS", ""),         # who may change settings when SSO is on
    "oidc_issuer": ("OIDC_ISSUER", ""),         # e.g. https://id.example.com (Pocket ID)
    "oidc_client_id": ("OIDC_CLIENT_ID", ""),
    "oidc_client_secret": ("OIDC_CLIENT_SECRET", ""),
    "oidc_name": ("OIDC_NAME", "Pocket ID"),
    "public_url": ("PUBLIC_URL", ""),           # only needed if redirects come out wrong behind a proxy
}
SECRET_FIELDS = {"plex_token", "jellyfin_api_key", "oidc_client_secret"}
AUTH_MODES = ("none", "plex", "oidc")
CACHE_HOURS = float(os.environ.get("CACHE_HOURS", "24"))

S = SimpleNamespace()  # live settings; read as config.S.plex_url etc.
_internal: dict = {}   # generated values (session secret, Plex client id)


def _coerce(name: str, value):
    default = FIELDS[name][1]
    if isinstance(default, bool):
        return value if isinstance(value, bool) else str(value).strip().lower() not in ("0", "false", "no", "")
    value = str(value or "").strip()
    if name.endswith("_url") or name == "oidc_issuer":
        value = value.rstrip("/")
    return value


def load() -> None:
    saved = {}
    if SETTINGS_FILE.exists():
        try:
            saved = json.loads(SETTINGS_FILE.read_text())
        except (OSError, ValueError) as e:
            log.error("Could not read %s: %s", SETTINGS_FILE, e)
    for name, (env, default) in FIELDS.items():
        value = saved.get(name, os.environ.get(env, default))
        setattr(S, name, _coerce(name, value))
    if S.auth_mode not in AUTH_MODES:
        S.auth_mode = "none"
    _internal.update(saved.get("_internal", {}))
    if "session_secret" not in _internal or "plex_client_id" not in _internal:
        _internal.setdefault("session_secret", secrets.token_urlsafe(32))
        _internal.setdefault("plex_client_id", "triviarr-" + secrets.token_hex(8))
        _save()


def _save() -> None:
    data = {name: getattr(S, name) for name in FIELDS}
    data["_internal"] = _internal
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        tmp = SETTINGS_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2))
        os.chmod(tmp, 0o600)
        tmp.replace(SETTINGS_FILE)
    except OSError as e:
        log.error("Could not save settings to %s: %s", SETTINGS_FILE, e)
        raise


def update(changes: dict) -> None:
    for name, value in changes.items():
        if name not in FIELDS:
            continue
        # Secrets come back masked from the UI; an empty value means "keep the current one".
        if name in SECRET_FIELDS and not str(value or "").strip():
            continue
        setattr(S, name, _coerce(name, value))
    if S.auth_mode not in AUTH_MODES:
        S.auth_mode = "none"
    _save()


def public_view() -> dict:
    """Settings for the UI, with secrets replaced by a has-value flag."""
    out = {}
    for name in FIELDS:
        value = getattr(S, name)
        out[name] = "" if name in SECRET_FIELDS else value
        if name in SECRET_FIELDS:
            out[name + "_set"] = bool(value)
    return out


def auth_mode() -> str:
    return "none" if AUTH_DISABLE else S.auth_mode


def session_secret() -> str:
    return _internal["session_secret"]


def plex_client_id() -> str:
    return _internal["plex_client_id"]


def csv(value: str) -> set[str]:
    return {v.strip().lower() for v in value.split(",") if v.strip()}


def plex_configured() -> bool:
    return bool(S.plex_url and S.plex_token)


def jellyfin_configured() -> bool:
    return bool(S.jellyfin_url and S.jellyfin_api_key)


load()
