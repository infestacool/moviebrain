"""Gather trivia for a movie from IMDb and Wikipedia.

Movies are resolved through Wikidata, which links IMDb IDs, TMDb IDs and
Wikipedia articles, so whichever ID the media server gives us is enough.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import time

import httpx

from . import config

log = logging.getLogger(__name__)

WIKIDATA_API = "https://www.wikidata.org/w/api.php"
IMDB_GRAPHQL = "https://caching.graphql.imdb.com/"
OMDB_API = os.environ.get("OMDB_URL", "https://www.omdbapi.com/")  # overridable for testing
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


def _store(key: str, value, ttl: float | None = None):
    _cache[key] = (time.time() + (ttl if ttl is not None else config.CACHE_HOURS * 3600), value)
    return value


_inflight: dict[str, asyncio.Future] = {}


async def _once(key: str, make):
    """Run make() once per key at a time; concurrent callers share the result."""
    if key in _inflight:
        return await asyncio.shield(_inflight[key])
    future = asyncio.ensure_future(make())
    _inflight[key] = future
    try:
        return await future
    finally:
        _inflight.pop(key, None)


def _client() -> httpx.AsyncClient:
    # Wikimedia throttles Python's HTTP/1.1 clients and rejects httpx's default
    # Accept-Encoding (br/zstd); HTTP/2 with plain gzip is treated like curl.
    return httpx.AsyncClient(timeout=15, follow_redirects=True, http2=True, headers={
        "User-Agent": config.USER_AGENT, "Accept": "*/*", "Accept-Encoding": "gzip",
    })


async def _get(client: httpx.AsyncClient, url: str, **kwargs) -> httpx.Response:
    """GET that rides out one short Wikimedia rate limit instead of failing."""
    for attempt in range(2):
        r = await client.get(url, **kwargs)
        if r.status_code != 429 or attempt == 1:
            break
        await asyncio.sleep(min(float(r.headers.get("retry-after") or 3), 5))
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


# What differs between looking up a film and a TV show.
KINDS = {
    # kind: (Wikidata TMDb property, Wikipedia search hint, IMDb title types)
    "movie": ("P4947", "film", ("movie", "tvMovie")),
    "tv": ("P4983", "TV series", ("tvSeries", "tvMiniSeries")),
}


async def _wikipedia_search(client: httpx.AsyncClient, title: str, year: int | None, kind: str = "movie") -> tuple[str | None, str | None]:
    """Search Wikipedia for the title's article; returns (Wikidata ID, article title)."""
    # Shows span many years and Plex reports the episode's, so only films search by year.
    query = " ".join(str(p) for p in (title, year if kind == "movie" else None, KINDS[kind][1]) if p)
    r = await _get(client, f"https://{config.S.wiki_lang}.wikipedia.org/w/api.php", params={
        "action": "query", "format": "json", "formatversion": 2,
        "generator": "search", "gsrsearch": query, "gsrlimit": 1, "prop": "pageprops",
    })
    pages = r.json().get("query", {}).get("pages", [])
    if not pages:
        return None, None
    return pages[0].get("pageprops", {}).get("wikibase_item"), pages[0].get("title")


async def resolve(imdb_id: str | None, tmdb_id: str | None, title: str | None, year: int | None,
                  kind: str = "movie") -> dict:
    """Return {'imdb_id', 'wiki_title'} using whatever identifiers we have.

    kind is "movie" or "tv" (a show), or "episode", which only uses the IMDb ID
    because few episodes have their own Wikipedia article.
    """
    if kind not in KINDS and kind != "episode":
        kind = "movie"
    # Key on the most precise ID, so the same title looked up different ways shares a cache entry.
    key = f"resolve:{kind}:" + (imdb_id or (tmdb_id and f"tmdb{tmdb_id}") or f"{title}|{year}")
    if (hit := _cached(key)) is not None:
        return hit
    if kind == "episode":
        title = tmdb_id = None
    return await _once(key, lambda: _resolve(key, imdb_id, tmdb_id, title, year, kind))


async def _resolve(key: str, imdb_id, tmdb_id, title, year, kind) -> dict:
    tmdb_prop = KINDS.get(kind, KINDS["movie"])[0]
    search_kind = kind if kind in KINDS else "movie"
    result = {"imdb_id": imdb_id, "wiki_title": None}
    complete = True
    async with _client() as client:
        try:
            qid = None
            if imdb_id:
                qid = await _wikidata_search(client, "P345", imdb_id)
            if not qid and tmdb_id:
                qid = await _wikidata_search(client, tmdb_prop, tmdb_id)
            if not qid and title:
                qid, result["wiki_title"] = await _wikipedia_search(client, title, year, search_kind)
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
            # Wikidata is a nicety: fall back to searching Wikipedia and IMDb by title.
            log.warning("Wikidata lookup failed: %s", e)
            complete = False
            if title and not result["wiki_title"]:
                try:
                    _, result["wiki_title"] = await _wikipedia_search(client, title, year, search_kind)
                except httpx.HTTPError as e2:
                    log.warning("Wikipedia search failed: %s", e2)
        if not result["imdb_id"] and title:
            result["imdb_id"] = await _imdb_suggest(client, title, year, search_kind)
    # A partial answer is retried after 10 minutes instead of being kept for a day.
    return _store(key, result, ttl=None if complete else 600)


async def _imdb_suggest(client: httpx.AsyncClient, title: str, year: int | None, kind: str = "movie") -> str | None:
    """Find an IMDb ID by title using IMDb's search-box suggestion feed."""
    slug = re.sub(r"[^a-z0-9 ]", "", title.lower()).strip() or "x"
    try:
        r = await client.get(f"https://v3.sg.media-imdb.com/suggestion/x/{slug}.json")
        r.raise_for_status()
    except httpx.HTTPError as e:
        log.warning("IMDb suggestion lookup failed: %s", e)
        return None
    matches = [d for d in r.json().get("d", []) if d.get("qid") in KINDS[kind][2]]
    for d in matches:
        # A show's year is when it started, which an episode's year won't match.
        if kind == "tv" or not year or abs((d.get("y") or 0) - year) <= 1:
            return d["id"]
    return None


EPISODES_QUERY = """
query Episodes($id: ID!, $season: String!) {
  title(id: $id) {
    episodes { episodes(first: 250, filter: {includeSeasons: [$season]}) {
      edges { node { id series { episodeNumber { seasonNumber episodeNumber } } } }
    } }
  }
}
"""


async def imdb_episode_id(series_id: str, season, number) -> str | None:
    """Find an episode's IMDb ID from its show's ID and season/episode number."""
    if not (IMDB_ID.match(series_id or "") and season is not None and number is not None):
        return None
    key = f"imdb:episodes:{series_id}:{season}"
    episodes = _cached(key)
    if episodes is None:
        async with _client() as client:
            r = await client.post(
                IMDB_GRAPHQL,
                json={"query": EPISODES_QUERY, "variables": {"id": series_id, "season": str(season)}},
                headers={"x-imdb-client-name": "imdb-web-next", "content-type": "application/json"},
            )
            r.raise_for_status()
        edges = (((((r.json().get("data") or {}).get("title") or {}).get("episodes") or {})
                  .get("episodes") or {}).get("edges") or [])
        episodes = {
            str(e["node"]["series"]["episodeNumber"]["episodeNumber"]): e["node"]["id"]
            for e in edges if ((e["node"].get("series") or {}).get("episodeNumber") or {}).get("episodeNumber") is not None
        }
        _store(key, episodes)
    return episodes.get(str(number))


# --- IMDb -------------------------------------------------------------------

# Trivia and goofs share the same shape in IMDb's API.
IMDB_LISTS = ("trivia", "goofs")
IMDB_QUERY = """
query Items($id: ID!, $after: ID) {
  title(id: $id) {
    %s(first: 250, after: $after) {
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


async def imdb_items(imdb_id: str, kind: str = "trivia") -> list[dict]:
    """IMDb trivia or goofs via the GraphQL endpoint IMDb's own website uses.

    IMDb only permits limited, personal, non-commercial use of this data.
    """
    if not IMDB_ID.match(imdb_id) or kind not in IMDB_LISTS:
        return []
    key = f"imdb:{kind}:{imdb_id}"
    if (hit := _cached(key)) is not None:
        return hit
    return await _once(key, lambda: _imdb_items(key, imdb_id, kind))


async def _imdb_items(key: str, imdb_id: str, kind: str) -> list[dict]:
    items, after = [], None
    async with _client() as client:
        for _ in range(4):  # 1000 items is more than any film has
            r = await client.post(
                IMDB_GRAPHQL,
                json={"query": IMDB_QUERY % kind, "variables": {"id": imdb_id, "after": after}},
                headers={"x-imdb-client-name": "imdb-web-next", "content-type": "application/json"},
            )
            r.raise_for_status()
            listing = ((r.json().get("data") or {}).get("title") or {}).get(kind) or {}
            for edge in listing.get("edges", []):
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
            page = listing.get("pageInfo") or {}
            if not page.get("hasNextPage"):
                break
            after = page.get("endCursor")
    return _store(key, items)


# --- OMDb (optional, needs a free API key) ---------------------------------

class OmdbError(Exception):
    pass


RATING_NAMES = {"Internet Movie Database": "IMDb", "Rotten Tomatoes": "Rotten Tomatoes", "Metacritic": "Metacritic"}


def _na(value):
    return None if not value or value == "N/A" else value


async def _omdb_get(client: httpx.AsyncClient, imdb_id: str, key: str) -> dict | None:
    r = await client.get(OMDB_API, params={"i": imdb_id, "apikey": key})
    if r.status_code == 401:
        raise OmdbError(r.json().get("Error", "Invalid API key"))
    r.raise_for_status()
    data = r.json()
    if data.get("Response") == "False":
        error = data.get("Error") or "Unknown error"
        if "not found" in error.lower() or "incorrect imdb" in error.lower():
            return None
        raise OmdbError(error)
    return data


async def test_omdb_key(key: str) -> str:
    async with _client() as client:
        data = await _omdb_get(client, "tt0133093", key)
    return (data or {}).get("Title", "a title")


async def omdb(imdb_id: str) -> dict | None:
    """Ratings, awards, box office and credits from OMDb, plus ready-to-show facts."""
    if not config.S.omdb_api_key or not IMDB_ID.match(imdb_id or ""):
        return None
    key = f"omdb:{imdb_id}"
    if (hit := _cached(key)) is not None:
        return hit or None
    return await _once(key, lambda: _omdb(key, imdb_id))


async def _omdb(key: str, imdb_id: str) -> dict | None:
    async with _client() as client:
        data = await _omdb_get(client, imdb_id, config.S.omdb_api_key)
    if not data:
        _store(key, {})
        return None
    return _store(key, omdb_summary(data))


def omdb_summary(d: dict) -> dict:
    is_episode = d.get("Type") == "episode"
    ratings = []
    for r in d.get("Ratings") or []:
        name = RATING_NAMES.get(r.get("Source"))
        if name and _na(r.get("Value")):
            ratings.append({"source": name, "value": r["Value"]})
    votes = _na(d.get("imdbVotes"))
    awards = _na(d.get("Awards"))
    box_office = _na(d.get("BoxOffice"))

    facts = []
    if ratings:
        parts = []
        for r in ratings:
            part = f"{r['value']} on {r['source']}"
            if r["source"] == "IMDb" and votes:
                part += f" from {votes} votes"
            parts.append(part)
        joined = parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1]
        facts.append(f"{'This episode is' if is_episode else 'It is'} rated {joined}.")
    if awards:
        facts.append(f"Awards: {awards.rstrip('.')}.")
    if box_office:
        facts.append(f"It took {box_office} at the US box office.")
    when = _na(d.get("Released"))
    rated = _na(d.get("Rated"))
    details = [f"Rated {rated}" if rated and rated not in ("Not Rated", "Unrated") else None, _na(d.get("Runtime"))]
    details = [x for x in details if x]
    if when:
        verb = "First aired" if d.get("Type") in ("episode", "series") else "Released"
        facts.append(" · ".join([f"{verb} {when}", *details]) + ".")
    if _na(d.get("totalSeasons")):
        n = d["totalSeasons"]
        facts.append(f"The series has {n} season{'s' if n != '1' else ''}.")
    credits = [f"Directed by {d['Director']}" if _na(d.get("Director")) else None,
               f"{'created' if d.get('Type') == 'series' else 'written'} by {d['Writer']}" if _na(d.get("Writer")) else None]
    credits = [c for c in credits if c]
    if credits:
        text = "; ".join(credits)
        facts.append(text[0].upper() + text[1:] + ".")

    return {
        "type": d.get("Type"),
        "ratings": ratings,
        "imdb_votes": votes,
        "awards": awards,
        "box_office": box_office,
        "facts": facts,
    }


# --- Wikipedia --------------------------------------------------------------

HEADING = re.compile(r"^(={2,6})\s*(.+?)\s*\1\s*$")


async def wikipedia(wiki_title: str) -> dict:
    key = f"wiki:{config.S.wiki_lang}:{wiki_title}"
    if (hit := _cached(key)) is not None:
        return hit
    return await _once(key, lambda: _wikipedia(key, wiki_title))


async def _wikipedia(key: str, wiki_title: str) -> dict:
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

async def get_trivia(imdb_id: str | None, tmdb_id: str | None, title: str | None, year: int | None,
                     kind: str = "movie", episode: dict | None = None) -> dict:
    """Trivia, goofs and Wikipedia for a movie, or for a TV show plus the episode playing.

    For episodes, each IMDb item gets scope "episode" or "series", episode items first.
    """
    is_tv = kind == "tv"
    ids = await resolve(imdb_id, tmdb_id, title, year, "tv" if is_tv else "movie")
    out: dict = {
        "imdb_id": ids["imdb_id"], "imdb": None, "goofs": None, "wikipedia": None,
        "episode_wikipedia": None, "omdb": None, "errors": {},
    }

    episode_imdb = None
    if is_tv and episode:
        episode_imdb = episode.get("imdb_id")
        if not (episode_imdb and IMDB_ID.match(episode_imdb)) and ids["imdb_id"]:
            try:
                episode_imdb = await imdb_episode_id(ids["imdb_id"], episode.get("season"), episode.get("number"))
            except httpx.HTTPError as e:
                log.warning("IMDb episode lookup failed: %s", e)
    out["episode_imdb_id"] = episode_imdb

    # (name, scope, coroutine); results with the same name are merged, episode first.
    tasks: list[tuple[str, str | None, object]] = []
    for name, imdb_kind, enabled in (("imdb", "trivia", config.S.include_imdb), ("goofs", "goofs", config.S.include_goofs)):
        if not enabled:
            continue
        if episode_imdb:
            tasks.append((name, "episode", imdb_items(episode_imdb, imdb_kind)))
        if ids["imdb_id"]:
            tasks.append((name, "series" if is_tv else None, imdb_items(ids["imdb_id"], imdb_kind)))
    if config.S.omdb_api_key and config.S.include_omdb:
        if episode_imdb:
            tasks.append(("omdb", "episode", omdb(episode_imdb)))
        if ids["imdb_id"]:
            tasks.append(("omdb", "series" if is_tv else None, omdb(ids["imdb_id"])))
    if ids["wiki_title"] and config.S.include_wikipedia:
        tasks.append(("wikipedia", None, wikipedia(ids["wiki_title"])))
    if episode_imdb and config.S.include_wikipedia:
        tasks.append(("episode_wikipedia", None, _episode_wikipedia(episode_imdb)))

    results = await asyncio.gather(*(t[2] for t in tasks), return_exceptions=True)
    for (name, scope, _), res in zip(tasks, results):
        if isinstance(res, Exception):
            log.warning("%s trivia failed: %s", name, res)
            out["errors"][name] = str(res) or res.__class__.__name__
        elif name in ("imdb", "goofs"):
            items = [{**item, "scope": scope} for item in res] if scope else res
            out[name] = (out[name] or []) + items
        elif name == "omdb":
            if res:
                out["omdb"] = (out.get("omdb") or []) + [{**res, "scope": scope}]
        else:
            out[name] = res
    return out


async def _episode_wikipedia(episode_imdb: str) -> dict | None:
    """The episode's own Wikipedia article, if it has one."""
    ids = await resolve(episode_imdb, None, None, None, "episode")
    return await wikipedia(ids["wiki_title"]) if ids["wiki_title"] else None
