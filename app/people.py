"""The cast of what's playing, and where else they turn up in your own library."""
from __future__ import annotations

import asyncio
import logging
import re
import unicodedata

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


# --- Who has died, and who has won an EGOT award ---------------------------

# IMDb events for the Oscars, Primetime Emmys and Grammys. IMDb doesn't list the Tonys; Wikidata does.
EGOT_EVENTS = {"ev0000223": "Emmy", "ev0000301": "Grammy", "ev0000003": "Oscar"}
EGOT_ORDER = ("Emmy", "Grammy", "Oscar", "Tony")

CREDITS_QUERY = """
query Credits($id: ID!) {
  title(id: $id) {
    credits(first: 250, filter: {categories: ["actor", "actress"]}) {
      edges { node { name {
        id
        nameText { text }
        deathDate { displayableProperty { value { plainText } } }
        awardNominations(first: 20, filter: {wins: WINS_ONLY, events: ["ev0000223", "ev0000301", "ev0000003"]}) {
          edges { node {
            award { text year event { id } category { text } }
            awardedEntities { ... on AwardedNames { secondaryAwardTitles { title { titleText { text } } } } }
          } }
        }
      } } }
    }
  }
}
"""

TONY_QUERY = """
SELECT ?imdb ?label ?year ?workLabel WHERE {
  VALUES ?imdb { %s }
  ?person wdt:P345 ?imdb; p:P166 ?st.
  ?st ps:P166 ?award.
  ?award rdfs:label ?label. FILTER(LANG(?label) = "en" && CONTAINS(?label, "Tony Award"))
  OPTIONAL { ?st pq:P585 ?t. BIND(YEAR(?t) AS ?year) }
  OPTIONAL { ?st pq:P1686 ?work. ?work rdfs:label ?workLabel. FILTER(LANG(?workLabel) = "en") }
}
"""


def _name_key(name: str) -> str:
    plain = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", plain.lower())


async def _tony_wins(name_ids: list[str]) -> list[tuple[str, dict]]:
    """[(IMDb name ID, win)] for the Tonys these people won."""
    ids = [i for i in name_ids if NAME_ID.match(i)]
    if not ids:
        return []
    async with trivia._client() as client:
        r = await trivia._get(client, "https://query.wikidata.org/sparql",
                              params={"query": TONY_QUERY % " ".join(f'"{i}"' for i in ids)},
                              headers={"Accept": "application/sparql-results+json"})
    wins = []
    for b in r.json()["results"]["bindings"]:
        value = lambda k: (b.get(k) or {}).get("value")  # noqa: E731
        what = value("workLabel") or re.sub(r"^Tony Award for ", "", value("label") or "")
        wins.append((value("imdb"), {"award": "Tony", "for": what, "year": int(value("year")) if value("year") else None}))
    return wins


async def _cast_facts(imdb_id: str) -> dict[str, dict]:
    """{name key: {"died", "egot"}} for a title's cast, for those with something to show."""
    key = f"imdb:castfacts2:{imdb_id}"
    if (hit := trivia._cached(key)) is not None:
        return hit
    async with trivia._client() as client:
        r = await client.post(
            trivia.IMDB_GRAPHQL, json={"query": CREDITS_QUERY, "variables": {"id": imdb_id}},
            headers={"x-imdb-client-name": "imdb-web-next", "content-type": "application/json"},
        )
        r.raise_for_status()
    people = {}
    for edge in ((trivia.graphql_data(r).get("title") or {}).get("credits") or {}).get("edges") or []:
        name = (edge.get("node") or {}).get("name") or {}
        died = (((name.get("deathDate") or {}).get("displayableProperty") or {}).get("value") or {}).get("plainText")
        wins = []
        for e in (name.get("awardNominations") or {}).get("edges") or []:
            node = e.get("node") or {}
            award = node.get("award") or {}
            kind = EGOT_EVENTS.get((award.get("event") or {}).get("id"))
            titles = (node.get("awardedEntities") or {}).get("secondaryAwardTitles") or []
            title = (((titles[0] if titles else {}).get("title") or {}).get("titleText") or {}).get("text")
            if kind:
                wins.append({"award": kind, "year": award.get("year"),
                             "for": title or (award.get("category") or {}).get("text") or award.get("text")})
        people[_name_key((name.get("nameText") or {}).get("text"))] = {"id": name.get("id"), "died": died, "wins": wins}
    try:
        by_id = {p["id"]: p for p in people.values() if p["id"]}
        for nm, win in await _tony_wins(list(by_id)):
            if nm in by_id:
                by_id[nm]["wins"].append(win)
    except Exception as e:  # Wikidata is a nicety here
        log.warning("Wikidata Tony lookup failed: %s", e)
    facts = {}
    for k, p in people.items():
        if p["died"] or p["wins"]:
            wins = sorted(p["wins"], key=lambda w: (EGOT_ORDER.index(w["award"]), w["year"] or 0))
            facts[k] = {"died": p["died"], "egot": [a for a in EGOT_ORDER if any(w["award"] == a for w in wins)],
                        "egot_wins": wins}
    return trivia._store(key, facts)


async def mark_cast(people: list[dict], imdb_ids: list[str]) -> list[dict]:
    """Add "died" and "egot" (EGOT awards won) to each cast member, from the titles' IMDb credits."""
    ids = [i for i in imdb_ids if i and trivia.IMDB_ID.match(i)]
    if not (people and ids and config.S.include_imdb):
        return people
    facts: dict[str, dict] = {}
    for result in await asyncio.gather(*(_cast_facts(i) for i in ids), return_exceptions=True):
        if isinstance(result, Exception):
            log.warning("IMDb credits lookup failed: %s", result)
        else:
            facts.update(result)
    return [{**p, **facts.get(_name_key(p["name"]), {})} for p in people]


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
    birthLocation { text }
    deathLocation { text }
    deathCause { text }
    height { displayableProperty { value { plainText } } }
    knownFor(first: 4) { edges { node { title { titleText { text } releaseYear { year } } } } }
    prestigiousAwardSummary { nominations wins award { text } }
    totalWins: awardNominations(first: 1, filter: {wins: WINS_ONLY}) { total }
    totalNominations: awardNominations(first: 1) { total }
    wins: awardNominations(first: 100, filter: {wins: WINS_ONLY}) {
      edges { node { award { text year event { text } category { text } }
        awardedEntities { ... on AwardedNames { secondaryAwardTitles { title { titleText { text } } } } } } }
    }
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


# Wins worth listing by name; everything else is in the totals.
MAJOR_AWARDS = ("Academy Awards", "Golden Globes", "BAFTA", "Primetime Emmy", "Screen Actors Guild",
                "Tony Awards", "Cannes Film Festival", "Venice Film Festival", "Berlin International Film Festival",
                "Grammy Awards", "Independent Spirit")
MAX_AWARDS = 6


def _awards(n: dict) -> dict | None:
    total = lambda k: ((n.get(k) or {}).get("total")) or 0  # noqa: E731
    wins, noms = total("totalWins"), total("totalNominations")
    top = n.get("prestigiousAwardSummary") or {}
    name = (top.get("award") or {}).get("text")
    summary = None
    if name and top.get("wins"):
        summary = f"Won {top['wins']} {name}" + ("s" if top["wins"] > 1 else "")
        if top.get("nominations", 0) > top["wins"]:
            summary += f" from {top['nominations']} nominations"
    elif name and top.get("nominations"):
        summary = f"Nominated for {top['nominations']} {name}" + ("s" if top["nominations"] > 1 else "")
    highlights = []
    for edge in (n.get("wins") or {}).get("edges") or []:
        node = edge.get("node") or {}
        award = node.get("award") or {}
        event = ((award.get("event") or {}).get("text") or "").split(",")[0]
        if not any(event.startswith(m) for m in MAJOR_AWARDS):
            continue
        titles = ((node.get("awardedEntities") or {}).get("secondaryAwardTitles") or [])
        highlights.append({
            "event": event, "award": award.get("text"), "year": award.get("year"),
            "category": (award.get("category") or {}).get("text"),
            "title": (((titles[0] if titles else {}).get("title") or {}).get("titleText") or {}).get("text"),
        })
    highlights.sort(key=lambda a: (MAJOR_AWARDS.index(next(m for m in MAJOR_AWARDS if a["event"].startswith(m))), a["year"] or 0))
    if not (summary or wins or noms):
        return None
    return {"summary": summary, "wins": wins, "nominations": noms, "highlights": highlights[:MAX_AWARDS]}


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
    key = f"imdb:name2:{name_id}"
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
        "birthplace": (n.get("birthLocation") or {}).get("text"),
        "death_place": (n.get("deathLocation") or {}).get("text"),
        "death_cause": (n.get("deathCause") or {}).get("text"),
        "height": date(n.get("height")),
        "known_for": [{"title": t["titleText"]["text"], "year": (t.get("releaseYear") or {}).get("year")}
                      for e in ((n.get("knownFor") or {}).get("edges") or [])
                      if (t := (e.get("node") or {}).get("title") or {}).get("titleText")],
        "awards": _awards(n),
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
