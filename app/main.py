"""Moviebrain web server."""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from fastapi import Body, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
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
    if config.auth_mode() != "none" and not path.startswith(PUBLIC_PATHS):
        if not auth.current_user(request):
            if path.startswith("/api/"):
                return JSONResponse({"detail": "Sign in required"}, status_code=401)
            return RedirectResponse("/login", status_code=303)
        if path.startswith(ADMIN_PATHS) and not auth.is_admin(request):
            if path.startswith("/api/"):
                return JSONResponse({"detail": "Only admins can change settings"}, status_code=403)
            return RedirectResponse("/", status_code=303)
    return await call_next(request)


# Added after the auth middleware so it wraps it and request.session is available there.
app.add_middleware(
    SessionMiddleware,
    secret_key=config.session_secret(),
    session_cookie="moviebrain",
    max_age=auth.SESSION_DAYS * 86400,
    same_site="lax",
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
    return Response(content, media_type=content_type, headers={"Cache-Control": "private, max-age=86400"})


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


def _merged(changes: dict, name: str):
    """Value a field will have after saving (blank secrets keep the stored value)."""
    value = changes.get(name)
    if value is None or (name in config.SECRET_FIELDS and not str(value).strip()):
        return getattr(config.S, name)
    return str(value).strip() if isinstance(value, str) else value


@app.post("/api/settings")
async def save_settings(changes: dict = Body(...)):
    get = lambda name: _merged(changes, name)  # noqa: E731
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
    if mode == "oidc" and not (get("oidc_issuer") and get("oidc_client_id") and get("oidc_client_secret")):
        raise HTTPException(400, "Pocket ID / OIDC sign-in needs the issuer URL, client ID and client secret.")

    config.update(changes)
    return {"ok": True, "settings": config.public_view()}


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

@app.get("/healthz")
async def health():
    return {"ok": True}


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


@app.get("/settings")
async def settings_page():
    return FileResponse(STATIC / "settings.html")


@app.get("/login")
async def login_page(request: Request):
    if config.auth_mode() == "none" or auth.current_user(request):
        return RedirectResponse("/", status_code=303)
    return FileResponse(STATIC / "login.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
