"""Find the movies and TV episodes currently playing on Plex and/or Jellyfin."""
from __future__ import annotations

import asyncio
import logging
import random
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


_id_cache: dict[str, dict] = {}  # external IDs per library item; they don't change while playing


async def _plex_ids(client: httpx.AsyncClient, headers: dict, rating_key: str | None) -> dict:
    """IMDb/TMDb/TVDB IDs for a Plex library item (movie, show or episode)."""
    if not rating_key:
        return {}
    cache_key = f"plex:{rating_key}"
    if cache_key not in _id_cache:
        try:
            r = await client.get(
                f"{config.S.plex_url}/library/metadata/{rating_key}", headers=headers, params={"includeGuids": 1},
            )
            r.raise_for_status()
            md = (r.json().get("MediaContainer", {}).get("Metadata") or [{}])[0]
            _id_cache[cache_key] = _parse_guids(md.get("Guid"))
        except httpx.HTTPError as e:
            log.warning("Plex metadata lookup failed: %s", e)
            return {}
    return _id_cache[cache_key]


async def plex_sessions(client: httpx.AsyncClient) -> list[dict]:
    if not config.plex_configured():
        return []
    headers = {"X-Plex-Token": config.S.plex_token, "Accept": "application/json"}
    r = await client.get(f"{config.S.plex_url}/status/sessions", headers=headers)
    r.raise_for_status()
    items = r.json().get("MediaContainer", {}).get("Metadata", []) or []

    results = []
    for m in items:
        if m.get("type") not in ("movie", "episode"):
            continue
        user = (m.get("User") or {}).get("title")
        if not _user_allowed(user):
            continue
        rating_key = str(m.get("ratingKey", ""))
        own_ids = _parse_guids(m.get("Guid")) or await _plex_ids(client, headers, rating_key)
        if m["type"] == "episode":
            # Trivia and artwork come from the show; the episode adds its own on top.
            show_key = str(m.get("grandparentRatingKey") or "")
            ids = await _plex_ids(client, headers, show_key)
            info = {
                "kind": "episode",
                "item_id": show_key or rating_key,  # the show: artwork and series cast
                "media_id": rating_key,             # the episode itself
                "title": m.get("grandparentTitle"),
                "year": m.get("parentYear") or m.get("year"),
                "episode": {
                    "title": m.get("title"),
                    "season": m.get("parentIndex"),
                    "number": m.get("index"),
                    "imdb_id": own_ids.get("imdb"),
                },
            }
        else:
            ids = own_ids
            info = {"kind": "movie", "item_id": rating_key, "media_id": rating_key, "title": m.get("title"),
                    "year": m.get("year"), "episode": None}

        player = m.get("Player") or {}
        results.append({
            "key": f"plex:{rating_key}:{user or ''}",
            "source": "plex",
            **info,
            "tagline": m.get("tagline"),
            "imdb_id": ids.get("imdb"),
            "tmdb_id": ids.get("tmdb"),
            "user": user,
            "device": player.get("title") or player.get("product"),
            "state": player.get("state", "playing"),
            "position_ms": m.get("viewOffset") or 0,
            "duration_ms": m.get("duration") or 0,
        })
    return results


def _provider_ids(item: dict) -> dict:
    return {k.lower(): v for k, v in (item.get("ProviderIds") or {}).items()}


async def _jellyfin_series_ids(client: httpx.AsyncClient, headers: dict, series_id: str | None) -> dict:
    if not series_id:
        return {}
    cache_key = f"jellyfin:{series_id}"
    if cache_key not in _id_cache:
        try:
            r = await client.get(
                f"{config.S.jellyfin_url}/Items", headers=headers,
                params={"ids": series_id, "Fields": "ProviderIds,ProductionYear"},
            )
            r.raise_for_status()
            series = (r.json().get("Items") or [{}])[0]
            _id_cache[cache_key] = {**_provider_ids(series), "year": series.get("ProductionYear")}
        except httpx.HTTPError as e:
            log.warning("Jellyfin series lookup failed: %s", e)
            return {}
    return _id_cache[cache_key]


async def jellyfin_sessions(client: httpx.AsyncClient) -> list[dict]:
    if not config.jellyfin_configured():
        return []
    headers = {"Authorization": f'MediaBrowser Token="{config.S.jellyfin_api_key}"'}
    r = await client.get(f"{config.S.jellyfin_url}/Sessions", headers=headers)
    r.raise_for_status()

    results = []
    for s in r.json() or []:
        item = s.get("NowPlayingItem")
        if not item or item.get("Type") not in ("Movie", "Episode"):
            continue
        user = s.get("UserName")
        if not _user_allowed(user):
            continue
        if item["Type"] == "Episode":
            ids = await _jellyfin_series_ids(client, headers, item.get("SeriesId"))
            info = {
                "kind": "episode",
                "item_id": item.get("SeriesId") or item.get("Id"),
                "media_id": item.get("Id"),
                "title": item.get("SeriesName"),
                "year": ids.get("year") or item.get("ProductionYear"),
                "episode": {
                    "title": item.get("Name"),
                    "season": item.get("ParentIndexNumber"),
                    "number": item.get("IndexNumber"),
                    "imdb_id": _provider_ids(item).get("imdb"),
                },
            }
        else:
            ids = _provider_ids(item)
            info = {
                "kind": "movie", "item_id": item.get("Id"), "media_id": item.get("Id"), "title": item.get("Name"),
                "year": item.get("ProductionYear"), "episode": None,
            }
        play = s.get("PlayState") or {}
        results.append({
            "key": f"jellyfin:{item.get('Id')}:{user or ''}",
            "source": "jellyfin",
            **info,
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


async def recently_added(limit: int = 12) -> list[dict]:
    """Newest movies on the configured servers, for suggestions when nothing is playing."""
    async def plex(client):
        if not config.plex_configured():
            return []
        r = await client.get(f"{config.S.plex_url}/library/recentlyAdded", headers={
            "X-Plex-Token": config.S.plex_token, "Accept": "application/json",
            "X-Plex-Container-Start": "0", "X-Plex-Container-Size": str(limit * 3),
        }, params={"type": 1, "includeGuids": 1})
        r.raise_for_status()
        items = [m for m in r.json().get("MediaContainer", {}).get("Metadata") or [] if m.get("type") == "movie"]
        return [{"source": "plex", "item_id": str(m["ratingKey"]), "media_id": str(m["ratingKey"]),
                 "title": m.get("title"), "year": m.get("year"),
                 "imdb_id": _parse_guids(m.get("Guid")).get("imdb"), "tmdb_id": _parse_guids(m.get("Guid")).get("tmdb")}
                for m in items[:limit]]

    async def jellyfin(client):
        if not config.jellyfin_configured():
            return []
        r = await client.get(f"{config.S.jellyfin_url}/Items", headers={"Authorization": f'MediaBrowser Token="{config.S.jellyfin_api_key}"'},
                             params={"IncludeItemTypes": "Movie", "Recursive": "true", "SortBy": "DateCreated",
                                     "SortOrder": "Descending", "Limit": limit, "Fields": "ProviderIds,ProductionYear"})
        r.raise_for_status()
        return [{"source": "jellyfin", "item_id": i["Id"], "media_id": i["Id"], "title": i.get("Name"),
                 "year": i.get("ProductionYear"),
                 "imdb_id": _provider_ids(i).get("imdb"), "tmdb_id": _provider_ids(i).get("tmdb")}
                for i in r.json().get("Items") or [] if i.get("Name")]

    async with httpx.AsyncClient(timeout=8, verify=config.S.verify_ssl) as client:
        results = await asyncio.gather(plex(client), jellyfin(client), return_exceptions=True)
    movies = []
    for result in results:
        if isinstance(result, Exception):
            log.warning("Recently added lookup failed: %s", result)
        else:
            movies.extend(result)
    return movies[:limit]


async def unwatched_movie() -> dict | None:
    """A random movie nobody has watched yet, from one of the configured servers."""
    async def plex(client):
        headers = {"X-Plex-Token": config.S.plex_token, "Accept": "application/json"}
        r = await client.get(f"{config.S.plex_url}/library/sections", headers=headers)
        r.raise_for_status()
        sections = [d["key"] for d in r.json().get("MediaContainer", {}).get("Directory") or [] if d.get("type") == "movie"]
        random.shuffle(sections)
        for key in sections:
            url = f"{config.S.plex_url}/library/sections/{key}/all"
            params = {"type": 1, "unwatched": 1, "includeGuids": 1}
            r = await client.get(url, params=params, headers={**headers, "X-Plex-Container-Start": "0", "X-Plex-Container-Size": "0"})
            r.raise_for_status()
            total = int(r.json().get("MediaContainer", {}).get("totalSize") or 0)
            if not total:
                continue
            r = await client.get(url, params=params, headers={
                **headers, "X-Plex-Container-Start": str(random.randrange(total)), "X-Plex-Container-Size": "1"})
            r.raise_for_status()
            for m in r.json().get("MediaContainer", {}).get("Metadata") or []:
                ids = _parse_guids(m.get("Guid"))
                return {"source": "plex", "item_id": str(m["ratingKey"]), "media_id": str(m["ratingKey"]),
                        "title": m.get("title"), "year": m.get("year"), "tagline": m.get("tagline"),
                        "imdb_id": ids.get("imdb"), "tmdb_id": ids.get("tmdb")}
        return None

    async def jellyfin(client):
        # "Watched" is per user in Jellyfin: use the first user in USERS, else the first admin.
        headers = {"Authorization": f'MediaBrowser Token="{config.S.jellyfin_api_key}"'}
        r = await client.get(f"{config.S.jellyfin_url}/Users", headers=headers)
        r.raise_for_status()
        users = r.json() or []
        wanted = config.csv(config.S.users)
        user = next((u for u in users if (u.get("Name") or "").lower() in wanted), None) if wanted else None
        user = user or next((u for u in users if (u.get("Policy") or {}).get("IsAdministrator")), None) or (users or [None])[0]
        if not user or not SAFE_ID.match(user.get("Id", "")):
            return None
        r = await client.get(f"{config.S.jellyfin_url}/Users/{user['Id']}/Items", headers=headers, params={
            "IncludeItemTypes": "Movie", "Recursive": "true", "IsPlayed": "false", "SortBy": "Random",
            "Limit": 1, "Fields": "ProviderIds,ProductionYear,Taglines"})
        r.raise_for_status()
        for i in r.json().get("Items") or []:
            return {"source": "jellyfin", "item_id": i["Id"], "media_id": i["Id"], "title": i.get("Name"),
                    "year": i.get("ProductionYear"), "tagline": (i.get("Taglines") or [None])[0],
                    "imdb_id": _provider_ids(i).get("imdb"), "tmdb_id": _provider_ids(i).get("tmdb")}
        return None

    servers = [f for ok, f in ((config.plex_configured(), plex), (config.jellyfin_configured(), jellyfin)) if ok]
    random.shuffle(servers)
    async with httpx.AsyncClient(timeout=8, verify=config.S.verify_ssl) as client:
        for server in servers:
            try:
                movie = await server(client)
            except (httpx.HTTPError, ValueError, KeyError) as e:
                log.warning("Unwatched movie lookup failed: %s", e)
                continue
            if movie and movie.get("title"):
                return movie
    return None


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
    async with httpx.AsyncClient(timeout=10, verify=config.S.verify_ssl) as client:
        r = await client.get(url, headers=headers)
        # Plex redirects to the current artwork. Follow that, but never to another host with the token.
        for _ in range(3):
            if not r.is_redirect:
                break
            target = r.next_request.url if r.next_request else None
            if not target or target.host != httpx.URL(url).host:
                return None
            r = await client.get(target, headers=headers)
    content_type = r.headers.get("content-type", "")
    if r.status_code != 200 or not content_type.startswith("image/"):
        return None
    return r.content, content_type


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
