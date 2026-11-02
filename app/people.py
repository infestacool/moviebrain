"""The cast of what's playing, and where else they turn up in your own library."""
from __future__ import annotations

import asyncio
import logging
import re

import httpx

from . import config, trivia

log = logging.getLogger(__name__)

SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
NAME_ID = re.compile(r"^nm\d{5,10}$")
MAX_CAST = 30
LIBRARY_MINUTES = 10  # libraries change slowly; keep lookups for a little while


def _plex_headers() -> dict:
    return {"X-Plex-Token": config.S.plex_token, "Accept": "application/json"}


def _jellyfin_headers() -> dict:
    return {"Authorization": f'MediaBrowser Token="{config.S.jellyfin_api_key}"'}


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=10, verify=config.S.verify_ssl)


# --- Cast -------------------------------------------------------------------

async def _plex_roles(client: httpx.AsyncClient, item_id: str) -> list[dict]:
    r = await client.get(f"{config.S.plex_url}/library/metadata/{item_id}", headers=_plex_headers())
    r.raise_for_status()
    meta = (r.json().get("MediaContainer", {}).get("Metadata") or [{}])[0]
    people = []
    for role in meta.get("Role") or []:
        thumb = role.get("thumb") or ""
        people.append({
            "id": str(role.get("id") or ""),
            "name": role.get("tag"),
            "role": role.get("role"),
            # Plex's people photos live on its public image service.
            "photo": thumb if thumb.startswith("https://") else None,
        })
    return [p for p in people if p["name"]]


async def _jellyfin_people(client: httpx.AsyncClient, item_id: str) -> list[dict]:
    r = await client.get(f"{config.S.jellyfin_url}/Items", headers=_jellyfin_headers(),
                         params={"ids": item_id, "Fields": "People"})
    r.raise_for_status()
    item = (r.json().get("Items") or [{}])[0]
    return [{
        "id": p.get("Id"),
        "name": p.get("Name"),
        "role": p.get("Role"),
        "photo": f"/api/image/jellyfin/{p['Id']}/poster" if p.get("PrimaryImageTag") else None,
        "guest": p.get("Type") == "GuestStar",
    } for p in item.get("People") or [] if p.get("Type") in ("Actor", "GuestStar") and p.get("Name")]


async def cast(source: str, item_id: str, show_id: str | None = None) -> list[dict]:
    """Actors in the movie or episode. For episodes, the show's regulars come first, then guest stars."""
    ids = [i for i in (show_id, item_id) if i]
    if not ids or not all(SAFE_ID.match(i) for i in ids):
        return []
    key = f"cast:{source}:{item_id}:{show_id}"
    if (hit := trivia._cached(key)) is not None:
        return hit

    fetch = {"plex": _plex_roles, "jellyfin": _jellyfin_people}.get(source)
    if not fetch:
        return []
    async with _client() as client:
        lists = await asyncio.gather(*(fetch(client, i) for i in ids), return_exceptions=True)

    people, seen = [], set()
    for i, result in zip(ids, lists):
        if isinstance(result, Exception):
            log.warning("Cast lookup failed for %s %s: %s", source, i, result)
            continue
        is_episode_list = show_id and i == item_id
        for p in result:
            if p["name"] in seen:
                continue
            seen.add(p["name"])
            p["guest"] = bool(p.get("guest") or is_episode_list)
            people.append(p)
    return trivia._store(key, people[:MAX_CAST], ttl=LIBRARY_MINUTES * 60)


# --- Where else they appear in your library ---------------------------------

async def _plex_sections(client: httpx.AsyncClient) -> list[dict]:
    key = "plex:sections"
    if (hit := trivia._cached(key)) is not None:
        return hit
    r = await client.get(f"{config.S.plex_url}/library/sections", headers=_plex_headers())
    r.raise_for_status()
    sections = [{"key": d["key"], "type": d.get("type")} for d in r.json().get("MediaContainer", {}).get("Directory") or []
                if d.get("type") in ("movie", "show")]
    return trivia._store(key, sections, ttl=LIBRARY_MINUTES * 60)


def _episode_detail(season, number, title) -> str:
    code = f"S{int(season):02d}E{int(number):02d}" if season is not None and number is not None else ""
    return " · ".join(x for x in (code, title) if x)


async def _plex_library(client: httpx.AsyncClient, person_id: str) -> list[dict]:
    # Plex type numbers: 1 movie, 2 show, 4 episode.
    queries = []
    for section in await _plex_sections(client):
        types = (1,) if section["type"] == "movie" else (2, 4)
        queries += [(section["key"], t) for t in types]

    async def one(section_key, plex_type):
        try:
            r = await client.get(f"{config.S.plex_url}/library/sections/{section_key}/all", headers=_plex_headers(),
                                 params={"type": plex_type, "actor": person_id})
            r.raise_for_status()
            return plex_type, r.json().get("MediaContainer", {}).get("Metadata") or []
        except httpx.HTTPError as e:
            log.warning("Plex library search failed: %s", e)
            return plex_type, []

    titles: dict[str, dict] = {}
    for plex_type, items in await asyncio.gather(*(one(*q) for q in queries)):
        for m in items:
            if plex_type == 4:  # an episode: group under its show
                show = titles.setdefault(str(m.get("grandparentRatingKey")), {
                    "item_id": str(m.get("grandparentRatingKey")), "title": m.get("grandparentTitle"),
                    "year": None, "kind": "show", "episodes": [],
                })
                show.setdefault("episodes", []).append(_episode_detail(m.get("parentIndex"), m.get("index"), m.get("title")))
            else:
                entry = titles.setdefault(str(m.get("ratingKey")), {"episodes": []})
                entry.update({"item_id": str(m.get("ratingKey")), "title": m.get("title"), "year": m.get("year"),
                              "kind": "movie" if plex_type == 1 else "show"})
    return list(titles.values())


async def _jellyfin_library(client: httpx.AsyncClient, person_id: str) -> list[dict]:
    r = await client.get(f"{config.S.jellyfin_url}/Items", headers=_jellyfin_headers(), params={
        "PersonIds": person_id, "Recursive": "true", "IncludeItemTypes": "Movie,Series,Episode",
        "Fields": "ProductionYear", "Limit": 200,
    })
    r.raise_for_status()
    titles: dict[str, dict] = {}
    for item in r.json().get("Items") or []:
        if item.get("Type") == "Episode":
            show = titles.setdefault(item.get("SeriesId") or item["Id"], {
                "item_id": item.get("SeriesId") or item["Id"], "title": item.get("SeriesName"),
                "year": None, "kind": "show", "episodes": [],
            })
            show["episodes"].append(_episode_detail(item.get("ParentIndexNumber"), item.get("IndexNumber"), item.get("Name")))
        else:
            entry = titles.setdefault(item["Id"], {"episodes": []})
            entry.update({"item_id": item["Id"], "title": item.get("Name"), "year": item.get("ProductionYear"),
                          "kind": "movie" if item.get("Type") == "Movie" else "show"})
    return list(titles.values())


async def _jellyfin_imdb_id(client: httpx.AsyncClient, person_id: str) -> str | None:
    r = await client.get(f"{config.S.jellyfin_url}/Items", headers=_jellyfin_headers(),
                         params={"ids": person_id, "Fields": "ProviderIds"})
    r.raise_for_status()
    ids = ((r.json().get("Items") or [{}])[0].get("ProviderIds") or {})
    return next((v for k, v in ids.items() if k.lower() == "imdb"), None)


async def library_titles(source: str, person_id: str) -> list[dict]:
    key = f"library:{source}:{person_id}"
    if (hit := trivia._cached(key)) is not None:
        return hit
    search = {"plex": _plex_library, "jellyfin": _jellyfin_library}[source]
    async with _client() as client:
        titles = await search(client, person_id)
    titles.sort(key=lambda t: (-(t.get("year") or 0), t.get("title") or ""))
    return trivia._store(key, titles, ttl=LIBRARY_MINUTES * 60)


# --- About the person, from IMDb --------------------------------------------

PERSON_QUERY = """
query Person($id: ID!) {
  name(id: $id) {
    nameText { text }
    birthDate { displayableProperty { value { plainText } } }
    deathDate { displayableProperty { value { plainText } } }
    bio { text { plainText } }
    trivia(first: 25) { edges { node { text { plainText } } } }
  }
}
"""


async def _imdb_name_id(name: str) -> str | None:
    slug = re.sub(r"[^a-z0-9 ]", "", name.lower()).strip()
    if not slug:
        return None
    async with trivia._client() as client:
        r = await client.get(f"https://v3.sg.media-imdb.com/suggestion/x/{slug}.json")
        r.raise_for_status()
    for d in r.json().get("d", []):
        if NAME_ID.match(d.get("id", "")) and (d.get("l") or "").lower() == name.lower():
            return d["id"]
    return None


def _short_bio(text: str, max_chars: int = 700) -> str:
    """The start of IMDb's (often very long) biography, cut at the end of a sentence."""
    out = ""
    for para in (p.strip() for p in text.split("\n") if p.strip()):
        if len(out) + len(para) <= max_chars:
            out = f"{out}\n\n{para}" if out else para
            continue
        # Fill up with whole sentences from the paragraph that doesn't fit.
        room = max_chars - len(out)
        sentences = re.findall(r"[^.!?]+[.!?]+[\"')]*\s*", para)
        taken = ""
        for sentence in sentences:
            if len(taken) + len(sentence) > room:
                break
            taken += sentence
        if taken.strip():
            out = f"{out}\n\n{taken.strip()}" if out else taken.strip()
        break
    return out


async def imdb_person(name_id: str) -> dict | None:
    key = f"imdb:name:{name_id}"
    if (hit := trivia._cached(key)) is not None:
        return hit or None
    async with trivia._client() as client:
        r = await client.post(
            trivia.IMDB_GRAPHQL, json={"query": PERSON_QUERY, "variables": {"id": name_id}},
            headers={"x-imdb-client-name": "imdb-web-next", "content-type": "application/json"},
        )
        r.raise_for_status()
    n = trivia.graphql_data(r).get("name") or {}
    date = lambda d: (((d or {}).get("displayableProperty") or {}).get("value") or {}).get("plainText")  # noqa: E731
    info = {
        "imdb_id": name_id,
        "url": f"https://www.imdb.com/name/{name_id}/",
        "born": date(n.get("birthDate")),
        "died": date(n.get("deathDate")),
        "bio": _short_bio(((n.get("bio") or {}).get("text") or {}).get("plainText") or ""),
        "trivia": [e["node"]["text"]["plainText"] for e in ((n.get("trivia") or {}).get("edges") or [])
                   if ((e.get("node") or {}).get("text") or {}).get("plainText")],
    } if n else {}
    trivia._store(key, info)
    return info or None


async def person(source: str, person_id: str, name: str) -> dict:
    """Everything the person view shows: your library's titles with them in, and IMDb's bio and trivia."""
    if source not in ("plex", "jellyfin") or not SAFE_ID.match(person_id or ""):
        raise ValueError("Unknown person")

    async def imdb():
        name_id = None
        if source == "jellyfin":
            async with _client() as client:
                name_id = await _jellyfin_imdb_id(client, person_id)
        if not (name_id and NAME_ID.match(name_id)):
            name_id = await _imdb_name_id(name)
        return await imdb_person(name_id) if name_id and config.S.include_imdb else None

    library, about = await asyncio.gather(library_titles(source, person_id), imdb(), return_exceptions=True)
    errors = {}
    if isinstance(library, Exception):
        log.warning("Library search for %s failed: %s", name, library)
        errors["library"] = str(library) or library.__class__.__name__
        library = []
    if isinstance(about, Exception):
        log.warning("IMDb lookup for %s failed: %s", name, about)
        errors["imdb"] = str(about) or about.__class__.__name__
        about = None
    return {"name": name, "library": library, "imdb": about, "errors": errors}
