"use strict";

const POLL_MS = 15000;
const SPOTLIGHT_MS = 20000;

const $ = (id) => document.getElementById(id);

const state = {
  sessions: [],
  selectedKey: store("selectedKey"),
  manual: null,          // movie looked up by hand: {title}
  movie: null,           // movie currently shown
  triviaFor: null,       // cache key of loaded trivia
  trivia: null,
  polledAt: 0,
  tab: store("tab") || "spotlight",
  showSpoilers: store("spoilers") === "1",
  deck: [], deckPos: 0, autoplay: store("autoplay") !== "0", spotStarted: 0,
};

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem("mt:" + key);
    localStorage.setItem("mt:" + key, value);
  } catch { return null; }
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  Object.assign(node, attrs);
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---- Now playing -----------------------------------------------------------

async function poll() {
  try {
    const res = await fetch("/api/now-playing");
    if (res.status === 401) { location.href = "/login"; return; }
    const data = await res.json();
    state.sessions = data.sessions;
    state.polledAt = Date.now();
    state.serverInfo = data;
  } catch (e) {
    state.serverInfo = { errors: { app: "Can't reach the Triviarr server" }, configured: {} };
  }
  render();
}

function currentSession() {
  const found = state.sessions.find((s) => s.key === state.selectedKey);
  if (found || !state.sessions.length) return found || null;
  // Stick with the first pick, so pausing (which re-sorts the list) doesn't jump to another movie.
  state.selectedKey = state.sessions[0].key;
  return state.sessions[0];
}

function render() {
  renderSessionChips();
  const session = state.manual ? null : currentSession();
  const movie = state.manual || session;

  $("empty").hidden = !!movie;
  $("movie").hidden = !movie;
  $("back-to-playing").hidden = !state.manual;

  if (!movie) {
    setBackdrop(null);
    state.movie = null;
    $("empty-detail").textContent = emptyMessage();
    const c = (state.serverInfo && state.serverInfo.configured) || {};
    $("setup-link").hidden = !!(c.plex || c.jellyfin) || !state.isAdmin;
    return;
  }

  state.movie = movie;
  renderHero(movie, session);
  const key = movie.imdb_id || movie.tmdb_id || `${movie.title}|${movie.year || ""}`;
  if (key !== state.triviaFor) loadTrivia(movie, key);
}

function emptyMessage() {
  const info = state.serverInfo || {};
  const errors = Object.entries(info.errors || {});
  if (errors.length) return "Couldn't reach " + errors.map(([k, v]) => `${k} (${v})`).join(", ");
  const c = info.configured || {};
  if (!c.plex && !c.jellyfin) return "No media server set up yet. Add your Plex or Jellyfin server in Settings.";
  const names = [c.plex && "Plex", c.jellyfin && "Jellyfin"].filter(Boolean).join(" or ");
  return `Start a movie on ${names} and its trivia will appear here.`;
}

function renderSessionChips() {
  const nav = $("sessions");
  const show = state.sessions.length > 1 && !state.manual;
  nav.hidden = !show;
  if (!show) return;
  const active = currentSession();
  nav.replaceChildren(...state.sessions.map((s) => {
    const b = el("button", { className: s.key === active.key ? "active" : "" },
      `${s.state === "paused" ? "⏸" : "▶"} ${s.title}${s.user ? " · " + s.user : ""}`);
    b.onclick = () => { state.selectedKey = s.key; store("selectedKey", s.key); render(); };
    return b;
  }));
}

function renderHero(movie, session) {
  $("title").textContent = movie.title + (movie.year ? ` (${movie.year})` : "");
  $("tagline").textContent = movie.tagline || "";

  const poster = $("poster");
  if (session) {
    const src = `/api/image/${session.source}/${session.item_id}/poster`;
    poster.onerror = () => { poster.dataset.failed = src; poster.hidden = true; };
    if (poster.getAttribute("src") !== src) poster.src = src;
    poster.hidden = poster.dataset.failed === src;
    setBackdrop(`/api/image/${session.source}/${session.item_id}/backdrop`);
    const source = session.source === "plex" ? "Plex" : "Jellyfin";
    $("meta").textContent = [session.state === "paused" ? "Paused" : "Now playing", source, session.user, session.device]
      .filter(Boolean).join(" · ");
  } else {
    poster.hidden = true;
    poster.removeAttribute("src");
    setBackdrop(null);
    $("meta").textContent = "Looked up manually";
  }
  updateProgress();
}

const ICON_PAUSE = "M6 5h4v14H6zM14 5h4v14h-4z";
const ICON_PLAY = "M8 5v14l11-7z";

function currentPosition(s) {
  let pos = s.position_ms;
  if (s.state === "playing") pos += Date.now() - state.polledAt;
  return Math.min(pos, s.duration_ms || pos);
}

function updateProgress() {
  const s = state.manual ? null : currentSession();
  $("playback").hidden = !s;
  if (!s) return;

  const btn = $("play-toggle");
  const playing = s.state === "playing";
  $("play-icon").setAttribute("d", playing ? ICON_PAUSE : ICON_PLAY);
  btn.disabled = !s.controllable;
  btn.setAttribute("aria-label", (playing ? "Pause" : "Resume") + " the movie");
  btn.title = s.controllable ? `${playing ? "Pause" : "Resume"} on ${s.device || "the player"}` : "This player can't be controlled remotely";

  $("progress").hidden = !s.duration_ms;
  $("progress-text").textContent = "";
  if (!s.duration_ms) return;
  const pos = currentPosition(s);
  $("progress-bar").style.width = (100 * pos / s.duration_ms).toFixed(2) + "%";
  $("progress-text").textContent = `${fmtTime(pos)} / ${fmtTime(s.duration_ms)} · ${fmtTime(s.duration_ms - pos)} left`;
}

let playbackErrorTimer;
function showPlaybackError(message) {
  const el = $("playback-error");
  el.textContent = message;
  el.hidden = !message;
  clearTimeout(playbackErrorTimer);
  if (message) playbackErrorTimer = setTimeout(() => { el.hidden = true; }, 8000);
}

async function togglePlayback() {
  const s = currentSession();
  if (!s || !s.controllable) return;
  const action = s.state === "playing" ? "pause" : "play";
  const btn = $("play-toggle");
  btn.classList.add("busy");
  showPlaybackError("");
  // Update the screen right away; the next poll confirms what the player really did.
  const previous = { state: s.state, position_ms: s.position_ms, polledAt: state.polledAt };
  s.position_ms = currentPosition(s);
  state.polledAt = Date.now();
  s.state = action === "pause" ? "paused" : "playing";
  updateProgress();
  try {
    const res = await fetch("/api/playback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: s.key, action }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
    setTimeout(poll, 1500);
  } catch (e) {
    Object.assign(s, { state: previous.state, position_ms: previous.position_ms });
    state.polledAt = previous.polledAt;
    showPlaybackError(e.message);
    updateProgress();
  } finally {
    btn.classList.remove("busy");
  }
}

function setBackdrop(url) {
  const bd = $("backdrop");
  if (!url) { bd.classList.remove("on"); bd.dataset.url = ""; return; }
  if (bd.dataset.url === url) return;
  bd.dataset.url = url;
  const img = new Image();
  img.onload = () => { bd.style.backgroundImage = `url("${url}")`; bd.classList.add("on"); };
  img.src = url;
}

// ---- Trivia ----------------------------------------------------------------

async function loadTrivia(movie, key) {
  state.triviaFor = key;
  state.trivia = null;
  $("loading").hidden = false;
  $("error").hidden = true;
  renderTrivia();

  const params = new URLSearchParams();
  if (movie.imdb_id) params.set("imdb", movie.imdb_id);
  if (movie.tmdb_id) params.set("tmdb", movie.tmdb_id);
  if (movie.title) params.set("title", movie.title);
  if (movie.year) params.set("year", movie.year);

  try {
    const res = await fetch("/api/trivia?" + params);
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    const data = await res.json();
    if (state.triviaFor !== key) return; // movie changed while loading
    state.trivia = data;
    if (state.manual && data.wikipedia) {
      $("title").textContent = data.wikipedia.title;
    }
  } catch (e) {
    if (state.triviaFor !== key) return;
    $("error").textContent = "Couldn't load trivia: " + e.message;
    $("error").hidden = false;
    state.triviaFor = null; // retry on next poll
  }
  $("loading").hidden = true;
  buildDeck();
  renderTrivia();
}

// kind is "imdb" (trivia) or "goofs", matching the API's field names.
function imdbItems(kind = "imdb") {
  return (state.trivia && state.trivia[kind]) || [];
}

function wikiParagraphs() {
  const w = state.trivia && state.trivia.wikipedia;
  if (!w) return [];
  return w.sections.flatMap((s) => s.paragraphs.map((p) => ({ section: s.title, text: p })));
}

// Long Wikipedia paragraphs read badly on a card; keep the first few sentences.
function trimSentences(text, max = 420) {
  if (text.length <= max) return text;
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)/g) || [text];
  let out = "";
  for (const s of sentences) {
    if (out && (out + s).length > max) break;
    out += s;
  }
  return out.trim() || text.slice(0, max) + "…";
}

function imdbCards(kind, label) {
  return imdbItems(kind)
    .filter((t) => state.showSpoilers || !t.spoiler)
    .map((t) => {
      const category = kind === "goofs" && t.category ? " · " + t.category : "";
      return { source: label + category + (t.spoiler ? " · spoiler" : ""), text: t.text };
    });
}

function buildDeck() {
  // Interleave so every source shows up: two trivia facts, then a goof, then Wikipedia.
  const trivia = shuffle(imdbCards("imdb", "IMDb trivia"));
  const goofs = shuffle(imdbCards("goofs", "IMDb goof"));
  const wiki = shuffle(wikiParagraphs().map((p) => ({ source: "Wikipedia · " + p.section, text: trimSentences(p.text) })));
  const deck = [];
  while (trivia.length || goofs.length || wiki.length) {
    if (trivia.length) deck.push(trivia.shift());
    if (trivia.length) deck.push(trivia.shift());
    if (goofs.length) deck.push(goofs.shift());
    if (wiki.length) deck.push(wiki.shift());
  }
  state.deck = deck;
  state.deckPos = 0;
  state.spotStarted = Date.now();
}

function renderTrivia() {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
  ["spotlight", "imdb", "goofs", "wiki"].forEach((t) => { $("tab-" + t).hidden = t !== state.tab; });
  for (const kind of ["imdb", "goofs"]) {
    const n = imdbItems(kind).length;
    $(kind + "-count").textContent = n ? `(${n})` : "";
  }
  renderSpotlight();
  renderImdbList("imdb", "IMDb trivia");
  renderImdbList("goofs", "IMDb goofs");
  renderWiki();
}

function renderSpotlight() {
  const item = state.deck[state.deckPos];
  if (!item) {
    $("spot-source").textContent = "";
    $("spot-text").textContent = state.trivia ? "No trivia found for this movie." : "";
    return;
  }
  $("spot-source").textContent = `${item.source} · ${state.deckPos + 1}/${state.deck.length}`;
  $("spot-text").textContent = item.text;
}

function renderAutoToggle() {
  const btn = $("spot-auto");
  btn.textContent = "Auto-advance: " + (state.autoplay ? "On" : "Off");
  btn.setAttribute("aria-pressed", String(state.autoplay));
}

function stepSpotlight(delta) {
  if (!state.deck.length) return;
  state.deckPos = (state.deckPos + delta + state.deck.length) % state.deck.length;
  state.spotStarted = Date.now();
  renderSpotlight();
}

function renderImdbList(kind, label) {
  const list = $(kind + "-list");
  const items = imdbItems(kind);
  if (!state.trivia) { list.replaceChildren(); return; }
  if (!items.length) {
    const why = state.trivia.errors[kind] ? "IMDb didn't respond." : `No ${label} for this movie.`;
    list.replaceChildren(el("li", {}, why));
    return;
  }
  list.replaceChildren(...items.map((t) => {
    const li = el("li");
    const label = [t.spoiler && "Spoiler", t.category && t.category !== "Uncategorized" && t.category].filter(Boolean).join(" · ");
    if (label) li.append(el("div", { className: "badge" + (t.spoiler ? " spoiler" : "") }, label));
    const p = el("div", {}, t.text);
    if (t.spoiler && !state.showSpoilers) {
      p.className = "spoiler-hidden";
      p.title = "Tap to reveal spoiler";
      p.onclick = () => { p.className = ""; p.title = ""; };
    }
    li.append(p);
    return li;
  }));
}

function renderWiki() {
  const box = $("wiki-content");
  if (!state.trivia) { box.replaceChildren(); return; }
  const w = state.trivia.wikipedia;
  if (!w) {
    const why = state.trivia.errors.wikipedia ? "Wikipedia didn't respond." : "No Wikipedia article found.";
    box.replaceChildren(el("p", { className: "loading" }, why));
    return;
  }
  const parts = [];
  if (w.intro.length) {
    const sec = el("div", { className: "wiki-section" });
    sec.append(el("h2", {}, "Overview"), ...w.intro.map((p) => el("p", {}, p)));
    parts.push(sec);
  }
  for (const s of w.sections) {
    const sec = el("div", { className: "wiki-section" });
    sec.append(el("h2", {}, s.title), ...s.paragraphs.map((p) => el("p", {}, p)));
    parts.push(sec);
  }
  parts.push(el("a", { className: "wiki-link", href: w.url, target: "_blank", rel: "noopener" }, "Read the full article on Wikipedia →"));
  box.replaceChildren(...parts);
}

// ---- Wiring ----------------------------------------------------------------

document.querySelectorAll(".tabs button").forEach((b) => {
  b.onclick = () => { state.tab = b.dataset.tab; store("tab", state.tab); renderTrivia(); };
});

$("spoilers").checked = state.showSpoilers;
$("spoilers").onchange = (e) => {
  state.showSpoilers = e.target.checked;
  store("spoilers", state.showSpoilers ? "1" : "0");
  buildDeck();
  renderTrivia();
};

$("spot-next").onclick = () => stepSpotlight(1);
$("spot-prev").onclick = () => stepSpotlight(-1);
$("spot-card").onclick = () => stepSpotlight(1);
$("spot-auto").onclick = () => {
  state.autoplay = !state.autoplay;
  store("autoplay", state.autoplay ? "1" : "0");
  state.spotStarted = Date.now();
  renderAutoToggle();
};
renderAutoToggle();

$("play-toggle").onclick = togglePlayback;

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || state.tab !== "spotlight") return;
  if (e.key === "ArrowRight") stepSpotlight(1);
  if (e.key === "ArrowLeft") stepSpotlight(-1);
});

$("search").onsubmit = (e) => {
  e.preventDefault();
  const q = $("search-input").value.trim();
  if (!q) return;
  state.manual = { title: q };
  state.triviaFor = null;
  render();
};

$("back-to-playing").onclick = () => {
  state.manual = null;
  state.triviaFor = null;
  render();
};

// One-second tick: progress bar and spotlight auto-advance.
setInterval(() => {
  if (state.movie) updateProgress();
  const bar = $("spot-timer").firstElementChild;
  if (state.autoplay && state.deck.length > 1 && state.tab === "spotlight") {
    const elapsed = Date.now() - state.spotStarted;
    if (elapsed >= SPOTLIGHT_MS) stepSpotlight(1);
    bar.style.width = Math.min(100, 100 * (Date.now() - state.spotStarted) / SPOTLIGHT_MS) + "%";
  } else {
    bar.style.width = "0";
  }
}, 1000);

async function loadAuth() {
  try {
    const s = await (await fetch("/api/auth/status")).json();
    state.isAdmin = s.admin;
    $("settings-link").hidden = !s.admin;
    $("signout").hidden = !s.user;
    if (s.user) $("signout").title = "Signed in as " + s.user;
  } catch { /* the poll will surface connection problems */ }
}

$("signout").onclick = async () => {
  await fetch("/auth/logout", { method: "POST" });
  location.href = "/login";
};

loadAuth().then(poll);
setInterval(poll, POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
