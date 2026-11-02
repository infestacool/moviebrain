"""Optional single sign-on: Plex accounts or any OIDC provider (e.g. Pocket ID).

Auth is off by default. When on, a signed session cookie remembers the user.
"""
from __future__ import annotations

import base64
import hashlib
import logging
import secrets
import time
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse

from . import config, media

log = logging.getLogger(__name__)
router = APIRouter()

PLEX_PRODUCT = "Moviebrain"
SESSION_DAYS = 30


class AuthError(Exception):
    pass


def base_url(request: Request) -> str:
    return config.S.public_url or str(request.base_url).rstrip("/")


def _matches(entries: set[str], ids: set[str], groups: set[str]) -> bool:
    """Allowed/admin lists hold usernames or emails, and groups written as "group:name"."""
    return bool(ids & entries) or any(e[6:] in groups for e in entries if e.startswith("group:"))


def _allowed(user: dict) -> bool:
    entries = config.csv(config.S.allowed_users)
    ids, groups = set(user.get("ids", [])), set(user.get("groups", []))
    if user.get("via_server"):  # Plex users who share the server
        return True
    if user["mode"] == "plex":
        return _matches(entries, ids, groups)
    return not entries or _matches(entries, ids, groups)  # OIDC: empty list trusts the provider


def _admin(user: dict) -> bool:
    entries = config.csv(config.S.admin_users)
    return bool(user.get("owner")) or _matches(entries, set(user.get("ids", [])), set(user.get("groups", [])))


def current_user(request: Request) -> dict | None:
    """The signed-in user, re-checked against the current lists so removing someone takes effect at once."""
    user = request.session.get("user")
    if not user or user.get("mode") != config.auth_mode() or user.get("exp", 0) < time.time():
        return None
    if not _allowed(user):
        return None
    return {**user, "admin": _admin(user)}


def is_admin(request: Request) -> bool:
    if config.auth_mode() == "none":
        return True
    user = current_user(request)
    return bool(user and user["admin"])


def _sign_in(request: Request, name: str, primary: str, ids: set[str], groups: set[str] = frozenset(),
             owner: bool = False, via_server: bool = False) -> str | None:
    """Start a session; returns an error message if the user isn't allowed in."""
    user = {
        "name": name,
        "mode": config.auth_mode(),
        "ids": sorted(ids),
        "groups": sorted(groups),
        "owner": owner,
        "via_server": via_server,
        "exp": time.time() + SESSION_DAYS * 86400,
    }
    if not _allowed(user):
        return f"{name} isn't allowed to use Moviebrain."
    # Nobody is admin yet (and there's no Plex server owner): the first person to sign in becomes admin.
    if not config.csv(config.S.admin_users) and not (owner or (user["mode"] == "plex" and config.plex_configured())):
        config.update({"admin_users": primary})
        log.info("%s is the first to sign in and is now the admin", name)
    request.session.clear()
    request.session["user"] = user
    return None


def _fail(message: str) -> RedirectResponse:
    log.warning("Sign-in refused: %s", message)
    return RedirectResponse("/login?" + urlencode({"error": message}), status_code=303)


@router.get("/api/auth/status")
async def status(request: Request):
    user = current_user(request)
    return {
        "mode": config.auth_mode(),
        "user": user and user["name"],
        "admin": is_admin(request),
        "oidc_name": config.oidc_provider_name(),
    }


@router.post("/auth/logout")
async def logout(request: Request):
    request.session.clear()
    return JSONResponse({"ok": True})


# --- Plex -------------------------------------------------------------------

def _plex_headers(token: str | None = None) -> dict:
    h = {
        "Accept": "application/json",
        "X-Plex-Product": PLEX_PRODUCT,
        "X-Plex-Client-Identifier": config.plex_client_id(),
    }
    if token:
        h["X-Plex-Token"] = token
    return h


@router.get("/auth/plex/start")
async def plex_start(request: Request):
    if config.auth_mode() != "plex":
        return RedirectResponse("/", status_code=303)
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post("https://plex.tv/api/v2/pins", params={"strong": "true"}, headers=_plex_headers())
        r.raise_for_status()
        pin = r.json()
    request.session["plex_pin"] = pin["id"]
    params = {
        "clientID": config.plex_client_id(),
        "code": pin["code"],
        "forwardUrl": f"{base_url(request)}/auth/plex/callback",
        "context[device][product]": PLEX_PRODUCT,
    }
    return RedirectResponse("https://app.plex.tv/auth#?" + urlencode(params), status_code=303)


@router.get("/auth/plex/callback")
async def plex_callback(request: Request):
    pin_id = request.session.pop("plex_pin", None)
    if not pin_id or config.auth_mode() != "plex":
        return _fail("Sign-in expired, please try again.")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"https://plex.tv/api/v2/pins/{pin_id}", headers=_plex_headers())
            r.raise_for_status()
            token = r.json().get("authToken")
            if not token:
                raise AuthError("Plex didn't confirm the sign-in.")
            r = await client.get("https://plex.tv/api/v2/user", headers=_plex_headers(token))
            r.raise_for_status()
            account = r.json()
            ident = {v.lower() for v in (account.get("username"), account.get("email")) if v}
            name = account.get("friendlyName") or account.get("username") or account.get("email")

            owner = via_server = False
            machine_id = await media.plex_machine_id() if config.plex_configured() else None
            if machine_id:
                r = await client.get("https://plex.tv/api/v2/resources", headers=_plex_headers(token))
                r.raise_for_status()
                for res in r.json():
                    if res.get("clientIdentifier") == machine_id:
                        via_server = True
                        owner = bool(res.get("owned"))
    except AuthError as e:
        return _fail(str(e))
    except httpx.HTTPError as e:
        return _fail(f"Couldn't reach Plex: {e}")

    primary = (account.get("username") or account.get("email") or "").lower()
    if error := _sign_in(request, name, primary, ident, owner=owner, via_server=via_server):
        return _fail(error if not machine_id else f"{name} doesn't have access to this Plex server.")
    return RedirectResponse("/", status_code=303)


# --- OIDC (Pocket ID, Authelia, Authentik, Keycloak…) ------------------------

async def _discovery() -> dict:
    async with httpx.AsyncClient(timeout=10, verify=config.S.verify_ssl) as client:
        r = await client.get(f"{config.S.oidc_issuer}/.well-known/openid-configuration")
        r.raise_for_status()
        return r.json()


@router.get("/auth/oidc/start")
async def oidc_start(request: Request):
    if config.auth_mode() not in config.OIDC_MODES:
        return RedirectResponse("/", status_code=303)
    try:
        meta = await _discovery()
    except httpx.HTTPError as e:
        return _fail(f"Couldn't reach {config.oidc_provider_name()}: {e}")
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(24)
    request.session["oidc"] = {"state": state, "verifier": verifier}
    params = {
        "response_type": "code",
        "client_id": config.S.oidc_client_id,
        "redirect_uri": f"{base_url(request)}/auth/oidc/callback",
        # Authentik puts groups in "profile" and rejects scopes it doesn't know; Pocket ID needs "groups".
        "scope": "openid profile email" if config.auth_mode() == "authentik" else "openid profile email groups",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    return RedirectResponse(f"{meta['authorization_endpoint']}?{urlencode(params)}", status_code=303)


@router.get("/auth/oidc/callback")
async def oidc_callback(request: Request, code: str = "", state: str = "", error: str = ""):
    pending = request.session.pop("oidc", None)
    if config.auth_mode() not in config.OIDC_MODES:
        return RedirectResponse("/", status_code=303)
    if error:
        return _fail(f"{config.oidc_provider_name()} said: {error}")
    if not pending or not code or not secrets.compare_digest(state, pending["state"]):
        return _fail("Sign-in expired, please try again.")
    try:
        meta = await _discovery()
        async with httpx.AsyncClient(timeout=10, verify=config.S.verify_ssl) as client:
            r = await client.post(meta["token_endpoint"], data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": f"{base_url(request)}/auth/oidc/callback",
                "client_id": config.S.oidc_client_id,
                "client_secret": config.S.oidc_client_secret,
                "code_verifier": pending["verifier"],
            })
            if r.status_code >= 400:
                raise AuthError(f"Token exchange failed ({r.status_code}). Check the client ID and secret.")
            access_token = r.json()["access_token"]
            # Userinfo comes straight from the provider over TLS, so no ID token verification is needed.
            r = await client.get(meta["userinfo_endpoint"], headers={"Authorization": f"Bearer {access_token}"})
            r.raise_for_status()
            info = r.json()
    except AuthError as e:
        return _fail(str(e))
    except (httpx.HTTPError, KeyError) as e:
        return _fail(f"Couldn't complete sign-in with {config.oidc_provider_name()}: {e}")

    # Only trust an email address the provider says is verified.
    email = info.get("email") if info.get("email_verified") is True else None
    ids = {str(v).lower() for v in (info.get("preferred_username"), email, info.get("sub")) if v}
    groups = {str(g).lower() for g in info.get("groups") or []}
    name = info.get("name") or info.get("preferred_username") or email or "User"

    primary = str(info.get("preferred_username") or email or info.get("sub")).lower()
    if error := _sign_in(request, name, primary, ids, groups):
        return _fail(error)
    return RedirectResponse("/", status_code=303)
