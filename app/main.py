"""Moviebrain web server."""
from __future__ import annotations

import hashlib
import logging
import re
from pathlib import Path
from urllib.parse import urlparse
from typing import Optional

from fastapi import Body, FastAPI, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from . import auth, config, media, people, trivia

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger(__name__)

STATIC = Path(__file__).parent / "static"
PUBLIC_PATHS = ("/login", "/auth/", "/static/", "/healthz", "/api/auth/status")
ADMIN_PATHS = ("/settings", "/api/settings")

app = FastAPI(title="Moviebrain")
app.include_router(auth.router)


@app.middleware("http")
async def require_sign_in(request: Request, call_next):
    path = request.url.path
    # Refuse changes sent from other websites (a browser always sends Origin on cross-site POSTs).
    if request.method == "POST":
        origin = request.headers.get("origin")
        if origin and urlparse(origin).netloc != request.headers.get("host"):
            return JSONResponse({"detail": "Cross-site request refused"}, status_code=403)
    if config.auth_mode() != "none" and not path.startswith(PUBLIC_PATHS):
        if not auth.current_user(request):
            if path.startswith("/api/"):
                return JSONResponse({"detail": "Sign in required"}, status_code=401)
            return RedirectResponse("/login", status_code=303)
        if path.startswith(ADMIN_PATHS) and not auth.is_admin(request):
            if path.startswith("/api/"):
                return JSONResponse({"detail": "Only admins can change settings"}, status_code=403)
            return RedirectResponse("/", status_code=303)
    response = await call_next(request)
    if path.startswith("/static/") or path in ("/", "/settings", "/login"):
        # Revalidate on every load (cheap, thanks to ETags) so an updated container's pages take effect at once.
        response.headers["Cache-Control"] = "no-cache"
    return response


# Added after the auth middleware so it wraps it and request.session is available there.
app.add_middleware(
    SessionMiddleware,
    secret_key=config.session_secret(),
    session_cookie="moviebrain",
    max_age=auth.SESSION_DAYS * 86400,
    same_site="lax",
    https_only=config.S.public_url.startswith("https://"),
)


@app.get("/api/now-playing")
async def now_playing():
    return await media.now_playing()


@app.get("/api/trivia")
async def get_trivia(
    imdb: Optional[str] = None,
    tmdb: Optional[str] = None,
    title: Optional[str] = None,
    year: Optional[int] = None,
    kind: str = "movie",
    ep_imdb: Optional[str] = None,
    season: Optional[int] = None,
    episode: Optional[int] = None,
):
    if not (imdb or tmdb or title):
        raise HTTPException(400, "Provide imdb, tmdb or title")
    ep = {"imdb_id": ep_imdb, "season": season, "number": episode} if kind == "tv" else None
    try:
        return await trivia.get_trivia(imdb, tmdb, title, year, "tv" if kind == "tv" else "movie", ep)
    except Exception as e:  # network trouble resolving the film
        log.exception("Trivia lookup failed")
        raise HTTPException(502, f"Trivia lookup failed: {e}")


@app.get("/api/cast")
async def get_cast(source: str, item: str, show: Optional[str] = None):
    return {"cast": await people.cast(source, item, show)}


@app.get("/api/person")
async def get_person(source: str, id: str, name: str):
    try:
        return await people.person(source, id, name)
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.get("/api/display")
async def display():
    return config.display_choices()


@app.get("/api/image/{source}/{item_id}/{kind}")
async def image(source: str, item_id: str, kind: str):
    result = await media.fetch_image(source, item_id, kind)
    if not result:
        raise HTTPException(404)
    content, content_type = result
    return Response(content, media_type=content_type,
                    headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"})


# --- Settings ---------------------------------------------------------------

@app.get("/api/settings")
async def get_settings(request: Request):
    return {
        "settings": config.public_view(),
        "groups": {"wiki": config.WIKI_SECTIONS, "goofs": config.GOOF_KINDS},
        "auth_disabled_by_env": config.AUTH_DISABLE,
        "callback_urls": {
            "plex": f"{auth.base_url(request)}/auth/plex/callback",
            "oidc": f"{auth.base_url(request)}/auth/oidc/callback",
        },
    }


# A saved key is only ever sent to the address it was saved with.
KEY_FOR_URL = {"plex_url": "plex_token", "jellyfin_url": "jellyfin_api_key", "oidc_issuer": "oidc_client_secret"}


def _merged(changes: dict, name: str):
    """Value a field will have after saving (blank secrets keep the stored value)."""
    value = changes.get(name)
    if value is None or (name in config.SECRET_FIELDS and not str(value).strip()):
        return getattr(config.S, name)
    return str(value).strip() if isinstance(value, str) else value


@app.post("/api/settings")
async def save_settings(changes: dict = Body(...)):
    # Changing a server's address drops its saved key unless a new one is given,
    # so the key can't be redirected to another host.
    cleared = []
    for url_field, key_field in KEY_FOR_URL.items():
        new_url = str(_merged(changes, url_field) or "").rstrip("/")
        if new_url != getattr(config.S, url_field) and not str(changes.get(key_field) or "").strip():
            cleared.append(key_field)
    get = lambda name: "" if name in cleared else _merged(changes, name)  # noqa: E731
    if not re.fullmatch(r"[a-z]{2,3}(-[a-z]+)*", str(get("wiki_lang") or "en")):
        raise HTTPException(400, "Wikipedia language should be a code like en, de or pt-br.")
    has_plex = bool(get("plex_url") and get("plex_token"))
    has_jellyfin = bool(get("jellyfin_url") and get("jellyfin_api_key"))
    if not (has_plex or has_jellyfin):
        raise HTTPException(400, "Set up at least one server: Plex (URL + token) or Jellyfin (URL + API key).")
    for name, label in (("plex_url", "Plex URL"), ("jellyfin_url", "Jellyfin URL"),
                        ("oidc_issuer", "Issuer URL"), ("public_url", "Public URL")):
        if get(name) and not str(get(name)).startswith(("http://", "https://")):
            raise HTTPException(400, f"{label} must start with http:// or https://")

    mode = get("auth_mode")
    if mode == "plex" and not (has_plex or get("allowed_users")):
        raise HTTPException(400, "Plex sign-in needs a Plex server (to check who has access) or a list of allowed users.")
    if mode in config.OIDC_MODES and not (get("oidc_issuer") and get("oidc_client_id") and get("oidc_client_secret")):
        raise HTTPException(400, "OpenID Connect sign-in needs the issuer URL, client ID and client secret.")

    config.update(changes, clear=cleared)
    return {"ok": True, "settings": config.public_view(), "cleared": cleared}


@app.post("/api/settings/test/{source}")
async def test_server(source: str, body: dict = Body(...)):
    if source == "omdb":
        key = (body.get("key") or config.S.omdb_api_key).strip()
        if not key:
            raise HTTPException(400, "Enter a key first.")
        try:
            title = await trivia.test_omdb_key(key)
        except Exception as e:
            raise HTTPException(400, f"OMDb said: {e}")
        return {"ok": True, "server": f"Key works (looked up {title})"}
    if source not in ("plex", "jellyfin"):
        raise HTTPException(404)
    key_field = "plex_token" if source == "plex" else "jellyfin_api_key"
    saved_url = getattr(config.S, f"{source}_url")
    url = (body.get("url") or saved_url).strip().rstrip("/")
    # Only reuse the saved key against the saved URL, so it can't be sent to some other host.
    key = body.get("key") or (getattr(config.S, key_field) if url == saved_url else "")
    if not (url and key):
        raise HTTPException(400, "Enter the URL and key first.")
    try:
        name = await media.test_connection(source, url, key, bool(body.get("verify_ssl", config.S.verify_ssl)))
    except Exception as e:
        raise HTTPException(400, f"Couldn't connect: {e}")
    return {"ok": True, "server": name}


# --- Pages ------------------------------------------------------------------

def _static_version() -> str:
    digest = hashlib.sha256()
    for f in sorted(STATIC.glob("*.[cj]s*")):
        digest.update(f.read_bytes())
    return digest.hexdigest()[:10]


STATIC_VERSION = _static_version()


def _page(name: str) -> HTMLResponse:
    """Serve a page with versioned script/style links, so browsers fetch new ones after an update."""
    html = (STATIC / name).read_text()
    html = re.sub(r'(/static/[\w.-]+\.(?:js|css))"', rf'\1?v={STATIC_VERSION}"', html)
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


@app.get("/healthz")
async def health():
    return {"ok": True}


@app.get("/")
async def index():
    return _page("index.html")


@app.get("/settings")
async def settings_page():
    return _page("settings.html")


@app.get("/login")
async def login_page(request: Request):
    if config.auth_mode() == "none" or auth.current_user(request):
        return RedirectResponse("/", status_code=303)
    return _page("login.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
