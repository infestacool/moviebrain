"""Find the movies currently playing on Plex and/or Jellyfin."""
from __future__ import annotations

import asyncio
import logging
import re

import httpx

from . import config

log = logging.getLogger(__name__)

SAFE_ID = re.compile(r"^[A-Za-z0-9_-]+$")


def _user_allowed(name: str | None) -> bool:
    users = config.csv(config.S.users)
    return not users or (name or "").lower() in users


def _parse_guids(guids: list[dict] | None) -> dict:
    ids = {}
    for g in guids or []:
        value = g.get("id", "")
        if "://" in value:
            scheme, ident = value.split("://", 1)
            ids[scheme] = ident
    return ids


async def plex_sessions(client: httpx.AsyncClient) -> list[dict]:
    if not config.plex_configured():
        return []
    headers = {"X-Plex-Token": config.S.plex_token, "Accept": "application/json"}
    r = await client.get(f"{config.S.plex_url}/status/sessions", headers=headers)
    r.raise_for_status()
    items = r.json().get("MediaContainer", {}).get("Metadata", []) or []

    results = []
    for m in items:
        if m.get("type") != "movie":
            continue
        user = (m.get("User") or {}).get("title")
        if not _user_allowed(user):
            continue
        rating_key = str(m.get("ratingKey", ""))
        ids = _parse_guids(m.get("Guid"))
        if not ids and rating_key:
            # Session payloads don't always carry external IDs; the library item does.
            try:
                meta = await client.get(
                    f"{config.S.plex_url}/library/metadata/{rating_key}",
                    headers=headers,
                    params={"includeGuids": 1},
                )
                meta.raise_for_status()
                md = (meta.json().get("MediaContainer", {}).get("Metadata") or [{}])[0]
                ids = _parse_guids(md.get("Guid"))
            except httpx.HTTPError as e:
                log.warning("Plex metadata lookup failed: %s", e)
        player = m.get("Player") or {}
        duration = m.get("duration") or 0
        results.append({
            "key": f"plex:{rating_key}:{user or ''}",
            "source": "plex",
            "item_id": rating_key,
            "title": m.get("title"),
            "year": m.get("year"),
            "tagline": m.get("tagline"),
            "imdb_id": ids.get("imdb"),
            "tmdb_id": ids.get("tmdb"),
            "user": user,
            "device": player.get("title") or player.get("product"),
            "state": player.get("state", "playing"),
            "position_ms": m.get("viewOffset") or 0,
            "duration_ms": duration,
        })
    return results


async def jellyfin_sessions(client: httpx.AsyncClient) -> list[dict]:
    if not config.jellyfin_configured():
        return []
    headers = {"Authorization": f'MediaBrowser Token="{config.S.jellyfin_api_key}"'}
    r = await client.get(f"{config.S.jellyfin_url}/Sessions", headers=headers)
    r.raise_for_status()

    results = []
    for s in r.json() or []:
        item = s.get("NowPlayingItem")
        if not item or item.get("Type") != "Movie":
            continue
        user = s.get("UserName")
        if not _user_allowed(user):
            continue
        ids = {k.lower(): v for k, v in (item.get("ProviderIds") or {}).items()}
        play = s.get("PlayState") or {}
        results.append({
            "key": f"jellyfin:{item.get('Id')}:{user or ''}",
            "source": "jellyfin",
            "item_id": item.get("Id"),
            "title": item.get("Name"),
            "year": item.get("ProductionYear"),
            "tagline": (item.get("Taglines") or [None])[0],
            "imdb_id": ids.get("imdb"),
            "tmdb_id": ids.get("tmdb"),
            "user": user,
            "device": s.get("DeviceName") or s.get("Client"),
            "state": "paused" if play.get("IsPaused") else "playing",
            # Jellyfin uses 100-nanosecond ticks.
            "position_ms": (play.get("PositionTicks") or 0) // 10_000,
            "duration_ms": (item.get("RunTimeTicks") or 0) // 10_000,
        })
    return results


async def now_playing() -> dict:
    async with httpx.AsyncClient(timeout=8, verify=config.S.verify_ssl) as client:
        sources = {"plex": plex_sessions(client), "jellyfin": jellyfin_sessions(client)}
        outcomes = await asyncio.gather(*sources.values(), return_exceptions=True)

    sessions, errors = [], {}
    for name, outcome in zip(sources, outcomes):
        if isinstance(outcome, Exception):
            log.warning("%s session lookup failed: %s", name, outcome)
            errors[name] = str(outcome) or outcome.__class__.__name__
        else:
            sessions.extend(outcome)
    # Playing before paused, so the default selection is the movie actually running.
    sessions.sort(key=lambda s: s["state"] != "playing")
    return {
        "sessions": sessions,
        "errors": errors,
        "configured": {
            "plex": config.plex_configured(),
            "jellyfin": config.jellyfin_configured(),
        },
    }


async def fetch_image(source: str, item_id: str, kind: str) -> tuple[bytes, str] | None:
    """Proxy artwork so the browser never sees server tokens."""
    if not SAFE_ID.match(item_id) or kind not in ("poster", "backdrop"):
        return None
    if source == "plex" and config.S.plex_url:
        path = "thumb" if kind == "poster" else "art"
        url = f"{config.S.plex_url}/library/metadata/{item_id}/{path}"
        headers = {"X-Plex-Token": config.S.plex_token}
    elif source == "jellyfin" and config.S.jellyfin_url:
        path = "Primary" if kind == "poster" else "Backdrop"
        url = f"{config.S.jellyfin_url}/Items/{item_id}/Images/{path}?maxWidth=1280"
        headers = {"Authorization": f'MediaBrowser Token="{config.S.jellyfin_api_key}"'}
    else:
        return None
    async with httpx.AsyncClient(timeout=10, verify=config.S.verify_ssl, follow_redirects=True) as client:
        r = await client.get(url, headers=headers)
    if r.status_code != 200:
        return None
    return r.content, r.headers.get("content-type", "image/jpeg")


async def test_connection(source: str, url: str, key: str, verify: bool) -> str:
    """Check a server's URL and key from the settings page; returns its name or raises."""
    url = url.strip().rstrip("/")
    if not url.startswith(("http://", "https://")):
        raise ValueError("URL must start with http:// or https://")
    async with httpx.AsyncClient(timeout=8, verify=verify) as client:
        if source == "plex":
            r = await client.get(f"{url}/", headers={"X-Plex-Token": key, "Accept": "application/json"})
            if r.status_code == 401:
                raise ValueError("Plex rejected the token")
            r.raise_for_status()
            mc = r.json().get("MediaContainer", {})
            return f"{mc.get('friendlyName', 'Plex')} (v{mc.get('version', '?')})"
        r = await client.get(f"{url}/System/Info", headers={"Authorization": f'MediaBrowser Token="{key}"'})
        if r.status_code == 401:
            raise ValueError("Jellyfin rejected the API key")
        r.raise_for_status()
        info = r.json()
        return f"{info.get('ServerName', 'Jellyfin')} (v{info.get('Version', '?')})"


async def plex_machine_id() -> str | None:
    """The configured Plex server's ID, used to check SSO users have access to it."""
    if not config.plex_configured():
        return None
    async with httpx.AsyncClient(timeout=8, verify=config.S.verify_ssl) as client:
        r = await client.get(f"{config.S.plex_url}/identity", headers={"Accept": "application/json"})
        r.raise_for_status()
        return r.json().get("MediaContainer", {}).get("machineIdentifier")
