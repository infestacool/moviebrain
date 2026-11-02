"""Gather trivia for a movie from IMDb and Wikipedia.

Movies are resolved through Wikidata, which links IMDb IDs, TMDb IDs and
Wikipedia articles, so whichever ID the media server gives us is enough.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time

import httpx

from . import config

log = logging.getLogger(__name__)

WIKIDATA_API = "https://www.wikidata.org/w/api.php"
IMDB_GRAPHQL = "https://caching.graphql.imdb.com/"
IMDB_ID = re.compile(r"^tt\d{5,10}$")

# Wikipedia sections that are not trivia (plot recaps, cast lists, citations).
SKIP_SECTIONS = {
    "plot", "synopsis", "plot summary", "premise", "cast", "cast and characters",
    "see also", "notes", "references", "bibliography", "external links",
    "further reading", "footnotes", "citations", "sources", "works cited",
}

_cache: dict[str, tuple[float, object]] = {}


def _cached(key: str):
    hit = _cache.get(key)
    if hit and hit[0] > time.time():
        return hit[1]
    return None


def _store(key: str, value):
    _cache[key] = (time.time() + config.CACHE_HOURS * 3600, value)
    return value


def _client() -> httpx.AsyncClient:
    # Wikimedia throttles Python's HTTP/1.1 clients and rejects httpx's default
    # Accept-Encoding (br/zstd); HTTP/2 with plain gzip is treated like curl.
    return httpx.AsyncClient(timeout=15, follow_redirects=True, http2=True, headers={
        "User-Agent": config.USER_AGENT, "Accept": "*/*", "Accept-Encoding": "gzip",
    })


async def _get(client: httpx.AsyncClient, url: str, **kwargs) -> httpx.Response:
    """GET that waits out Wikimedia's short rate limits instead of failing."""
    for attempt in range(3):
        r = await client.get(url, **kwargs)
        if r.status_code != 429 or attempt == 2:
            break
        await asyncio.sleep(min(float(r.headers.get("retry-after") or 5), 15))
    r.raise_for_status()
    return r


# --- Wikidata ---------------------------------------------------------------

async def _wikidata_search(client: httpx.AsyncClient, prop: str, value: str) -> str | None:
    r = await _get(client, WIKIDATA_API, params={
        "action": "query", "list": "search", "format": "json", "srlimit": 1,
        "srsearch": f"haswbstatement:{prop}={value}",
    })
    hits = r.json().get("query", {}).get("search", [])
    return hits[0]["title"] if hits else None


async def _wikipedia_search(client: httpx.AsyncClient, title: str, year: int | None) -> str | None:
    """Fallback when the server has no IDs: search Wikipedia for the film's article."""
    query = f"{title} {year or ''} film".strip()
    r = await _get(client, f"https://{config.S.wiki_lang}.wikipedia.org/w/api.php", params={
        "action": "query", "format": "json", "formatversion": 2,
        "generator": "search", "gsrsearch": query, "gsrlimit": 1, "prop": "pageprops",
    })
    pages = r.json().get("query", {}).get("pages", [])
    return pages[0].get("pageprops", {}).get("wikibase_item") if pages else None


async def resolve(imdb_id: str | None, tmdb_id: str | None, title: str | None, year: int | None) -> dict:
    """Return {'imdb_id', 'wiki_title'} using whatever identifiers we have."""
    key = f"resolve:{imdb_id}:{tmdb_id}:{title}:{year}"
    if (hit := _cached(key)) is not None:
        return hit

    result = {"imdb_id": imdb_id, "wiki_title": None}
    async with _client() as client:
        try:
            qid = None
            if imdb_id:
                qid = await _wikidata_search(client, "P345", imdb_id)
            if not qid and tmdb_id:
                qid = await _wikidata_search(client, "P4947", tmdb_id)
            if not qid and title:
                qid = await _wikipedia_search(client, title, year)
            if qid:
                r = await _get(client, WIKIDATA_API, params={
                    "action": "wbgetentities", "ids": qid, "format": "json",
                    "props": "sitelinks|claims", "sitefilter": f"{config.S.wiki_lang}wiki",
                })
                entity = r.json().get("entities", {}).get(qid, {})
                link = entity.get("sitelinks", {}).get(f"{config.S.wiki_lang}wiki")
                result["wiki_title"] = link["title"] if link else None
                if not result["imdb_id"]:
                    for claim in entity.get("claims", {}).get("P345", []):
                        value = claim.get("mainsnak", {}).get("datavalue", {}).get("value", "")
                        if IMDB_ID.match(value):
                            result["imdb_id"] = value
                            break
        except httpx.HTTPError as e:
            # Wikidata is a nicety; IMDb trivia can still be found by title.
            log.warning("Wikidata lookup failed: %s", e)
        if not result["imdb_id"] and title:
            result["imdb_id"] = await _imdb_suggest(client, title, year)
    return _store(key, result)


async def _imdb_suggest(client: httpx.AsyncClient, title: str, year: int | None) -> str | None:
    """Find an IMDb ID by title using IMDb's search-box suggestion feed."""
    slug = re.sub(r"[^a-z0-9 ]", "", title.lower()).strip() or "x"
    try:
        r = await client.get(f"https://v3.sg.media-imdb.com/suggestion/x/{slug}.json")
        r.raise_for_status()
    except httpx.HTTPError as e:
        log.warning("IMDb suggestion lookup failed: %s", e)
        return None
    movies = [d for d in r.json().get("d", []) if d.get("qid") in ("movie", "tvMovie")]
    for d in movies:
        if not year or abs((d.get("y") or 0) - year) <= 1:
            return d["id"]
    return None


# --- IMDb -------------------------------------------------------------------

IMDB_QUERY = """
query Trivia($id: ID!, $after: ID) {
  title(id: $id) {
    trivia(first: 250, after: $after) {
      total
      pageInfo { hasNextPage endCursor }
      edges { node {
        id
        isSpoiler
        text { plainText }
        category { text }
        interestScore { usersVoted usersInterested }
      } }
    }
  }
}
"""


async def imdb_trivia(imdb_id: str) -> list[dict]:
    """IMDb trivia via the GraphQL endpoint IMDb's own website uses.

    IMDb only permits limited, personal, non-commercial use of this data.
    """
    if not IMDB_ID.match(imdb_id):
        return []
    key = f"imdb:{imdb_id}"
    if (hit := _cached(key)) is not None:
        return hit

    items, after = [], None
    async with _client() as client:
        for _ in range(4):  # 1000 items is more than any film has
            r = await client.post(
                IMDB_GRAPHQL,
                json={"query": IMDB_QUERY, "variables": {"id": imdb_id, "after": after}},
                headers={"x-imdb-client-name": "imdb-web-next", "content-type": "application/json"},
            )
            r.raise_for_status()
            trivia = ((r.json().get("data") or {}).get("title") or {}).get("trivia") or {}
            for edge in trivia.get("edges", []):
                node = edge["node"]
                text = (node.get("text") or {}).get("plainText", "").strip()
                if not text:
                    continue
                score = node.get("interestScore") or {}
                items.append({
                    "id": node["id"],
                    "text": text,
                    "spoiler": bool(node.get("isSpoiler")),
                    "category": (node.get("category") or {}).get("text"),
                    "interested": score.get("usersInterested", 0),
                    "voted": score.get("usersVoted", 0),
                })
            page = trivia.get("pageInfo") or {}
            if not page.get("hasNextPage"):
                break
            after = page.get("endCursor")
    return _store(key, items)


# --- Wikipedia --------------------------------------------------------------

HEADING = re.compile(r"^(={2,6})\s*(.+?)\s*\1\s*$")


async def wikipedia(wiki_title: str) -> dict:
    key = f"wiki:{config.S.wiki_lang}:{wiki_title}"
    if (hit := _cached(key)) is not None:
        return hit

    base = f"https://{config.S.wiki_lang}.wikipedia.org"
    async with _client() as client:
        r = await _get(client, f"{base}/w/api.php", params={
            "action": "query", "format": "json", "formatversion": 2, "redirects": 1,
            "prop": "extracts", "explaintext": 1, "titles": wiki_title,
        })
    page = (r.json().get("query", {}).get("pages") or [{}])[0]
    text = page.get("extract", "")

    intro, sections = [], []
    path: list[str] = []  # heading trail, e.g. ["Production", "Filming"]
    current = None
    for line in text.splitlines():
        line = line.strip()
        m = HEADING.match(line)
        if m:
            level = len(m.group(1)) - 2
            path = path[:level] + [m.group(2)]
            current = None
            if path[0].lower() not in SKIP_SECTIONS:
                current = {"title": " › ".join(path), "paragraphs": []}
                sections.append(current)
            continue
        if len(line) < 60:  # skip stubs, captions, table fragments
            continue
        if not path:
            intro.append(line)
        elif current is not None:
            current["paragraphs"].append(line)

    title = page.get("title", wiki_title)
    return _store(key, {
        "title": title,
        "url": f"{base}/wiki/{title.replace(' ', '_')}",
        "intro": intro,
        "sections": [s for s in sections if s["paragraphs"]],
    })


# --- Combined ---------------------------------------------------------------

async def get_trivia(imdb_id: str | None, tmdb_id: str | None, title: str | None, year: int | None) -> dict:
    ids = await resolve(imdb_id, tmdb_id, title, year)
    out: dict = {"imdb_id": ids["imdb_id"], "imdb": None, "wikipedia": None, "errors": {}}

    tasks = {}
    if ids["imdb_id"] and config.S.include_imdb:
        tasks["imdb"] = imdb_trivia(ids["imdb_id"])
    if ids["wiki_title"]:
        tasks["wikipedia"] = wikipedia(ids["wiki_title"])
    results = await asyncio.gather(*tasks.values(), return_exceptions=True)
    for name, res in zip(tasks, results):
        if isinstance(res, Exception):
            log.warning("%s trivia failed: %s", name, res)
            out["errors"][name] = str(res) or res.__class__.__name__
        else:
            out[name] = res
    return out
