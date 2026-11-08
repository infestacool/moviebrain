"use strict";

const POLL_MS = 15000;
const SPOTLIGHT_MS = 20000;

const $ = (id) => document.getElementById(id);

// Preferences used to be saved under "mt:"; move them to "mb:" once.
try {
  for (const k of Object.keys(localStorage).filter((k) => k.startsWith("mt:"))) {
    if (localStorage.getItem("mb:" + k.slice(3)) === null) localStorage.setItem("mb:" + k.slice(3), localStorage.getItem(k));
    localStorage.removeItem(k);
  }
} catch { /* storage unavailable */ }

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
  interval: Number(store("interval")) || SPOTLIGHT_MS, // time per fact, ms
  screen: false, // second-screen mode
  showRead: false, // trivia and goofs you've marked as read
};

// Facts marked as read, by IMDb item ID. Kept on this device only.
const readFacts = new Set((() => { try { return JSON.parse(store("read") || "[]"); } catch { return []; } })());
const isRead = (t) => readFacts.has(t.id);
function setRead(t, read) {
  if (read) readFacts.add(t.id); else readFacts.delete(t.id);
  store("read", JSON.stringify([...readFacts].slice(-5000)));
}

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem("mb:" + key);
    localStorage.setItem("mb:" + key, value);
  } catch { return null; }
}

// Artwork comes through the server so tokens stay private. The demo site supplies its own images.
function imageUrl(source, id, kind) {
  const demo = window.moviebrainDemo;
  return demo ? demo.image(source, id, kind) : `/api/image/${source}/${id}/${kind}`;
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
    state.serverInfo = { errors: { app: "Can't reach the Moviebrain server" }, configured: {} };
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
    renderTvView();
    $("empty-detail").textContent = emptyMessage();
    const c = (state.serverInfo && state.serverInfo.configured) || {};
    $("setup-link").hidden = !!(c.plex || c.jellyfin) || !state.isAdmin;
    loadRecent();
    loadPick();
    renderScreen();
    return;
  }

  state.movie = movie;
  renderHero(movie, session);
  const ep = movie.episode;
  const key = (movie.imdb_id || movie.tmdb_id || `${movie.title}|${movie.year || ""}`) +
    (ep ? `|${ep.imdb_id || `s${ep.season}e${ep.number}`}` : "");
  if (key !== state.triviaFor) loadTrivia(movie, key);
  const lib = libraryItem();
  const castKey = lib ? `${lib.source}:${lib.media_id}:${lib.item_id}` : null;
  if (castKey !== state.castFor) loadCast(lib, castKey, movie);
  renderScreen();
}

// The title whose cast and artwork can come from your server: what's playing, or a library pick.
function libraryItem() {
  if (state.manual) return state.manual.source ? state.manual : null;
  return currentSession();
}

// "Plex", "Jellyfin" or "Plex or Jellyfin", depending on what's set up.
function serverNames() {
  const c = (state.serverInfo && state.serverInfo.configured) || {};
  return [c.plex && "Plex", c.jellyfin && "Jellyfin"].filter(Boolean).join(" or ") || "your media server";
}

function lookUp(movie) {
  if ($("find").open) $("find").close();
  state.manual = movie;
  state.triviaFor = null;
  hideSuggestions();
  window.scrollTo(0, 0);
  render();
}

function emptyMessage() {
  const info = state.serverInfo || {};
  const errors = Object.entries(info.errors || {});
  if (errors.length) return "Couldn't reach " + errors.map(([k, v]) => `${k} (${v})`).join(", ");
  const c = info.configured || {};
  if (!c.plex && !c.jellyfin) return "No media server set up yet. Add your Plex or Jellyfin server in Settings.";
  return `Start a movie or TV show on ${serverNames()} and its trivia will appear here.`;
}

function renderSessionChips() {
  const nav = $("sessions");
  const show = state.sessions.length > 1 && !state.manual;
  nav.hidden = !show;
  if (!show) return;
  const active = currentSession();
  nav.replaceChildren(...state.sessions.map((s) => {
    const b = el("button", { className: s.key === active.key ? "active" : "" },
      `${s.state === "paused" ? "⏸" : "▶"} ${s.title}${s.episode ? " " + episodeCode(s.episode) : ""}${s.user ? " · " + s.user : ""}`);
    b.onclick = () => { state.selectedKey = s.key; store("selectedKey", s.key); render(); };
    return b;
  }));
  if (nav.dataset.shown !== active.key) {
    nav.dataset.shown = active.key;
    const chip = nav.querySelector(".active");
    if (chip) nav.scrollLeft = chip.offsetLeft - (nav.clientWidth - chip.offsetWidth) / 2;
  }
}

function episodeCode(ep) {
  const pad = (n) => String(n).padStart(2, "0");
  return ep.season != null && ep.number != null ? `S${pad(ep.season)}E${pad(ep.number)}` : "";
}

function renderHero(movie, session) {
  const ep = movie.episode;
  // Episode years are when that episode aired, so only movies show a year.
  $("title").textContent = movie.title + (movie.year && !ep ? ` (${movie.year})` : "");
  $("episode-line").hidden = !ep;
  if (ep) $("episode-line").textContent = [episodeCode(ep), ep.title].filter(Boolean).join(" · ");
  $("tagline").textContent = ep ? "" : movie.tagline || "";

  const poster = $("poster");
  const art = session || (movie.source ? movie : null); // playing, or picked from your library
  if (art) {
    const src = imageUrl(art.source, art.item_id, "poster");
    poster.onerror = () => { poster.dataset.failed = src; poster.hidden = true; };
    if (poster.getAttribute("src") !== src) poster.src = src;
    poster.hidden = poster.dataset.failed === src;
    setBackdrop(imageUrl(art.source, art.item_id, "backdrop"));
    const source = art.source === "plex" ? "Plex" : "Jellyfin";
    $("meta").textContent = !session ? `From your ${source} library`
      : [session.state === "paused" ? "Paused" : "Now playing", source, session.user, session.device].filter(Boolean).join(" · ");
  } else {
    poster.hidden = true;
    poster.removeAttribute("src");
    setBackdrop(null);
    $("meta").textContent = "Looked up manually";
  }
  updateProgress();
}

function currentPosition(s) {
  let pos = s.position_ms;
  if (s.state === "playing") pos += Date.now() - state.polledAt;
  return Math.min(pos, s.duration_ms || pos);
}

function updateProgress() {
  const s = state.manual ? null : currentSession();
  $("playback").hidden = !(s && s.duration_ms);
  if (!s || !s.duration_ms) return;
  const pos = currentPosition(s);
  $("progress-bar").style.width = (100 * pos / s.duration_ms).toFixed(2) + "%";
  $("progress-text").textContent = `${fmtTime(pos)} / ${fmtTime(s.duration_ms)} · ${fmtTime(s.duration_ms - pos)} left`;
}

function setBackdrop(url) {
  const bd = $("backdrop");
  if (!url) { bd.classList.remove("on"); bd.dataset.url = ""; return; }
  if (bd.dataset.url === url) return;
  bd.dataset.url = url;
  bd.classList.remove("on"); // don't leave the previous title's artwork up if this one has none
  const img = new Image();
  img.onload = () => {
    if (bd.dataset.url !== url) return; // switched again while loading
    bd.style.backgroundImage = `url("${url}")`;
    bd.classList.add("on");
  };
  img.src = url;
}

// ---- Trivia ----------------------------------------------------------------

async function loadTrivia(movie, key) {
  state.triviaFor = key;
  state.trivia = null;
  $("loading").hidden = false;
  $("error").hidden = true;
  renderTrivia();

  const params = titleParams(movie);
  try {
    const res = await fetch("/api/trivia?" + params);
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    const data = await res.json();
    if (state.triviaFor !== key) return; // movie changed while loading
    state.trivia = data;
    // A typed search shows what was typed; use the matched article's name, minus "(1963 film)".
    if (state.manual && !state.manual.imdb_id && !state.manual.source && data.wikipedia) {
      $("title").textContent = data.wikipedia.title.replace(/\s*\([^)]*\)$/, "");
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

// ---- Sources and sections (chosen on the Settings page) ----------------------

const SOURCES = [["imdb", "IMDb trivia"], ["goofs", "IMDb goofs"], ["wiki", "Wikipedia"], ["omdb", "Ratings & awards"]];
const SCOPES = [["episode", "This episode"], ["series", "The series"]];
// Wikipedia headings vary by article, so sections are grouped by keywords in their top-level heading.
const WIKI_GROUPS = [
  ["overview", "Overview", null],
  ["production", "Production", /produc|develop|writ|cast|film|shoot|design|effect|cinematograph|concept|animation|make-?up|costume|stunt|inspir/],
  ["music", "Music", /music|soundtrack|score|song/],
  ["release", "Release", /release|marketing|distribut|home media|broadcast|premiere|promot|airing|syndicat|stream/],
  ["reception", "Reception", /recept|box office|critic|review|rating|viewer|audience|response/],
  ["awards", "Awards", /accolade|award|nominat|honou?r/],
  ["themes", "Themes & analysis", /theme|analys|interpret|style|symbol|motif/],
  ["legacy", "Legacy", /legacy|cultur|impact|sequel|prequel|remake|adapt|franchise|spin|future|reboot|influence/],
  ["other", "Other", null],
];
const GOOF_GROUPS = [
  ["continuity", "Continuity", /continuity/],
  ["factual", "Factual errors", /factual|anachronism|geograph/],
  ["revealing", "Revealing mistakes", /revealing/],
  ["crew", "Crew or equipment visible", /crew|equipment/],
  ["plot", "Plot holes", /plot hole/],
  ["character", "Character errors", /character/],
  ["notgoofs", "Not really goofs", /incorrectly regarded/],
  ["other", "Other", null],
];

function groupOf(groups, text) {
  const t = (text || "").toLowerCase();
  const hit = groups.find(([, , re]) => re && re.test(t));
  return hit ? hit[0] : "other";
}

// Everything shows until /api/display says otherwise (set on the Settings page).
const showAll = (list) => Object.fromEntries(list.map(([k]) => [k, true]));
state.filters = {
  sources: { ...showAll(SOURCES), omdb: false },
  scopes: showAll(SCOPES),
  wiki: showAll(WIKI_GROUPS),
  goofs: showAll(GOOF_GROUPS),
};

// For TV, each device toggles between episode and series facts on the main screen;
// Settings sets the default.
const TV_VIEWS = {
  episode: { episode: true, series: false },
  series: { episode: false, series: true },
};
state.tvView = TV_VIEWS[store("tvView")] ? store("tvView") : null;

function applyTvView() {
  state.filters.scopes = { ...TV_VIEWS[state.tvView || "episode"] };
}

async function loadDisplayChoices() {
  try {
    const res = await fetch("/api/display");
    if (res.ok) state.filters = await res.json();
  } catch { /* keep showing everything */ }
  if (!state.tvView) {
    const { episode, series } = state.filters.scopes;
    state.tvView = series && !episode ? "series" : "episode";
  }
  applyTvView();
}

// kind is "imdb" (trivia) or "goofs", matching the API's field names.
function imdbItems(kind = "imdb") {
  return (state.trivia && state.trivia[kind]) || [];
}

// The items this device has chosen to see.
function shownItems(kind) {
  const f = state.filters;
  if (!f.sources[kind]) return [];
  return imdbItems(kind).filter((t) =>
    (!t.scope || f.scopes[t.scope]) && (kind !== "goofs" || f.goofs[groupOf(GOOF_GROUPS, t.category)]));
}

// which is "wikipedia" (the movie or show) or "episode_wikipedia".
function shownArticle(which) {
  const f = state.filters;
  const w = state.trivia && state.trivia[which];
  if (!w || !f.sources.wiki) return null;
  if (isTv() && !f.scopes[which === "episode_wikipedia" ? "episode" : "series"]) return null;
  return {
    ...w,
    intro: f.wiki.overview ? w.intro : [],
    sections: w.sections.filter((s) => f.wiki[groupOf(WIKI_GROUPS, s.title.split(" › ")[0])]),
  };
}

function wikiParagraphs(which = "wikipedia") {
  const w = shownArticle(which);
  if (!w) return [];
  return w.sections.flatMap((s) => s.paragraphs.map((p) => ({ section: s.title, text: p })));
}

function isTv() {
  return !!(state.movie && state.movie.episode);
}

// What to call the title on screen in "nothing found" messages.
function subject() {
  return isTv() ? (state.filters.scopes.series ? "show" : "episode") : "movie";
}

const SERIES_HINT = " Tap Series at the top for trivia about the whole show.";

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

// scope is "episode", "series", or undefined for movies.
function imdbCards(kind, label, scope) {
  return shownItems(kind)
    .filter((t) => t.scope === scope && (state.showSpoilers || !t.spoiler) && !isRead(t))
    .map((t) => {
      const category = kind === "goofs" && t.category ? " · " + t.category : "";
      return { source: label + category + (t.spoiler ? " · spoiler" : ""), text: t.text };
    });
}

// OMDb summaries (only when the server has an OMDb key), for a scope like shownItems().
function omdbFor(scope) {
  const f = state.filters;
  if (!f.sources.omdb || (scope && !f.scopes[scope])) return null;
  // Movies have no scope (the server sends null).
  return ((state.trivia && state.trivia.omdb) || []).find((o) => (o.scope || undefined) === scope) || null;
}

function omdbCards(scope) {
  const o = omdbFor(scope);
  return o ? o.facts.map((text) => ({ source: "OMDb", text })) : [];
}

function wikiCards(which) {
  return wikiParagraphs(which).map((p) => ({ source: `Wikipedia · ${p.section}`, text: trimSentences(p.text) }));
}

// Two trivia facts, then a goof, then Wikipedia, then an OMDb fact, so every source shows up.
function interleave(trivia, goofs, wiki, extra = []) {
  [trivia, goofs, wiki, extra].forEach(shuffle);
  const out = [];
  while (trivia.length || goofs.length || wiki.length || extra.length) {
    if (trivia.length) out.push(trivia.shift());
    if (trivia.length) out.push(trivia.shift());
    if (goofs.length) out.push(goofs.shift());
    if (wiki.length) out.push(wiki.shift());
    if (extra.length) out.push(extra.shift());
  }
  return out;
}

function buildDeck() {
  // For TV, the facts for the chosen view: the episode on screen or the whole series.
  const scope = isTv() ? state.tvView : undefined;
  const deck = interleave(imdbCards("imdb", "IMDb trivia", scope), imdbCards("goofs", "IMDb goof", scope),
    wikiCards(scope === "episode" ? "episode_wikipedia" : "wikipedia"), omdbCards(scope));
  state.deck = deck;
  state.deckPos = 0;
  state.spotStarted = Date.now();
}

function renderTvView() {
  const box = $("tv-view");
  box.hidden = !isTv();
  box.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.view === state.tvView)));
}

function renderTrivia() {
  renderTvView();
  const f = state.filters;
  const tabSource = { imdb: "imdb", goofs: "goofs", wiki: "wiki" };
  // The cast comes from the media server, so it isn't there for titles looked up by hand.
  const tabShown = (tab) => (tab === "cast" ? !!libraryItem() : !tabSource[tab] || f.sources[tabSource[tab]]);
  if (!tabShown(state.tab)) state.tab = "spotlight";
  document.querySelectorAll(".tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === state.tab);
    b.hidden = !tabShown(b.dataset.tab);
  });
  ["spotlight", "imdb", "goofs", "wiki", "cast"].forEach((t) => { $("tab-" + t).hidden = t !== state.tab; });
  for (const kind of ["imdb", "goofs"]) {
    renderCount(kind);
  }
  renderGlance();
  renderSourceLinks();
  renderSpotlight();
  renderImdbList("imdb", "IMDb trivia");
  renderImdbList("goofs", "IMDb goofs");
  renderWiki();
}

// Credit and link every source the page is showing for this title.
function sourceLine(label, parts) {
  const line = el("div");
  line.append(label + ": ");
  parts.forEach((p, i) => {
    if (i) line.append(el("span", { className: "sep" }, "·"));
    line.append(p.href ? el("a", { href: p.href, target: "_blank", rel: "noopener" }, p.text) : p.text);
  });
  return line;
}

function renderSourceLinks() {
  const box = $("source-links");
  const t = state.trivia;
  if (!t) { box.hidden = true; return; }
  const scope = isTv() ? state.tvView : undefined;
  const imdbId = scope === "episode" ? t.episode_imdb_id : t.imdb_id;
  const lines = [];

  const imdb = [];
  if (imdbId && shownItems("imdb").some((i) => i.scope === scope)) imdb.push({ text: "Trivia", href: `https://www.imdb.com/title/${imdbId}/trivia/` });
  if (imdbId && shownItems("goofs").some((i) => i.scope === scope)) imdb.push({ text: "Goofs", href: `https://www.imdb.com/title/${imdbId}/goofs/` });
  if (imdb.length) lines.push(sourceLine("IMDb", imdb));

  const article = shownArticle(scope === "episode" ? "episode_wikipedia" : "wikipedia");
  if (article && (article.intro.length || article.sections.length)) {
    lines.push(sourceLine("Wikipedia", [
      { text: article.title, href: article.url },
      { text: "CC BY-SA 4.0", href: "https://creativecommons.org/licenses/by-sa/4.0/" },
    ]));
  }
  if (omdbFor(scope)) lines.push(sourceLine("Ratings & awards", [{ text: "OMDb", href: "https://www.omdbapi.com/" }]));

  const lib = libraryItem();
  if (lib) lines.push(sourceLine("Cast & artwork", [{ text: `your ${lib.source === "plex" ? "Plex" : "Jellyfin"} server` }]));

  box.replaceChildren(el("div", { className: "sub" }, "Sources"), ...lines);
  box.hidden = !lines.length;
}

const RATING_SHORT = { IMDb: "IMDb", "Rotten Tomatoes": "RT", Metacritic: "MC" };

// A row of quick stats under the title: ratings, awards and box office from OMDb.
function renderGlance() {
  const list = $("glance");
  const main = omdbFor(isTv() ? "series" : undefined), ep = isTv() ? omdbFor("episode") : null;
  const items = [];
  const stat = (label, value, title) => {
    const li = el("li", { title: title || "" });
    li.append(el("b", {}, label + " "), value);
    items.push(li);
  };
  const epImdb = ep && ep.ratings.find((r) => r.source === "IMDb");
  const score = (v) => v.replace(/\/100?$/, ""); // "8.7/10" -> "8.7", "73/100" -> "73"
  if (epImdb) stat("Episode", score(epImdb.value), "This episode's IMDb rating");
  for (const r of (main && main.ratings) || []) {
    stat(RATING_SHORT[r.source] || r.source, score(r.value), r.source);
  }
  if (main && main.awards) {
    const first = main.awards.split(".")[0];
    items.push(el("li", { title: main.awards }, "🏆 " + first));
  }
  if (main && main.box_office) {
    const n = Number(main.box_office.replace(/[^0-9]/g, ""));
    const short = n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${Math.round(n / 1e6)}M` : main.box_office;
    stat("Box office", short, `${main.box_office} at the US box office`);
  }
  list.replaceChildren(...items);
  list.hidden = !items.length;
}

function renderSpotlight() {
  const item = state.deck[state.deckPos];
  if (!item) {
    $("spot-source").textContent = "";
    $("spot-text").textContent = !state.trivia ? ""
      : `No trivia found for this ${subject()}.` + (subject() === "episode" ? SERIES_HINT : "");
    renderScreen();
    return;
  }
  $("spot-source").textContent = `${item.source} · ${state.deckPos + 1}/${state.deck.length}`;
  $("spot-text").textContent = item.text;
  renderScreen();
}

function renderAutoToggle() {
  const btn = $("spot-auto");
  btn.title = "Auto-advance: " + (state.autoplay ? "on" : "off");
  btn.setAttribute("aria-pressed", String(state.autoplay));
}

function stepSpotlight(delta) {
  if (!state.deck.length) return;
  state.deckPos = (state.deckPos + delta + state.deck.length) % state.deck.length;
  state.spotStarted = Date.now();
  renderSpotlight();
}

for (const kind of ["imdb", "goofs"]) {
  $(kind + "-read-toggle").onclick = () => {
    state.showRead = !state.showRead;
    renderImdbList("imdb", "IMDb trivia");
    renderImdbList("goofs", "IMDb goofs");
  };
}

function renderCount(kind) {
  const n = shownItems(kind).filter((t) => !isRead(t)).length;
  $(kind + "-count").textContent = n ? `(${n})` : "";
}

function renderImdbList(kind, label) {
  const list = $(kind + "-list");
  const items = shownItems(kind);
  const toggle = $(kind + "-read-toggle");
  toggle.hidden = true;
  if (!state.trivia) { list.replaceChildren(); return; }
  if (!items.length) {
    const why = state.trivia.errors[kind] ? "IMDb didn't respond."
      : imdbItems(kind).some((t) => !t.scope || state.filters.scopes[t.scope]) ? "Everything here is switched off in Settings."
      : `No ${label} for this ${subject()}.` + (subject() === "episode" ? SERIES_HINT : "");
    list.replaceChildren(el("li", {}, why));
    return;
  }
  const readCount = items.filter(isRead).length;
  toggle.hidden = !readCount;
  toggle.textContent = state.showRead ? "Hide read" : `Show ${readCount} read`;
  const visible = state.showRead ? items : items.filter((t) => !isRead(t));
  if (!visible.length) {
    list.replaceChildren(el("li", { className: "all-read" }, `You've read all ${items.length}.`));
    return;
  }
  const rerender = () => { renderImdbList(kind, label); renderCount(kind); };
  list.replaceChildren(...visible.map((t) => {
    const li = el("li", { className: isRead(t) ? "read" : "" });
    const mark = el("button", { className: "read-btn", type: "button" }, isRead(t) ? "↺" : "✓");
    mark.title = mark.ariaLabel = isRead(t) ? "Mark as unread" : "Mark as read";
    mark.onclick = () => {
      setRead(t, !isRead(t));
      if (state.showRead) { rerender(); return; }
      li.classList.add("leaving");
      setTimeout(rerender, 200);
    };
    li.append(mark);
    const label = [t.spoiler && "Spoiler", t.category && t.category !== "Uncategorized" && t.category]
      .filter(Boolean).join(" · ");
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

function wikiArticle(w, heading) {
  const parts = [];
  if (heading) parts.push(el("h2", { className: "wiki-article" }, heading));
  if (w.intro.length) {
    const sec = el("div", { className: "wiki-section" });
    sec.append(el("h3", {}, "Overview"), ...w.intro.map((p) => el("p", {}, p)));
    parts.push(sec);
  }
  for (const s of w.sections) {
    const sec = el("div", { className: "wiki-section" });
    sec.append(el("h3", {}, s.title), ...s.paragraphs.map((p) => el("p", {}, p)));
    parts.push(sec);
  }
  parts.push(el("a", { className: "wiki-link", href: w.url, target: "_blank", rel: "noopener" }, `Read “${w.title}” on Wikipedia →`));
  return parts;
}

function renderWiki() {
  const box = $("wiki-content");
  if (!state.trivia) { box.replaceChildren(); return; }
  const w = shownArticle("wikipedia"), ep = shownArticle("episode_wikipedia");
  const empty = (a) => !a || (!a.intro.length && !a.sections.length);
  if (empty(w) && empty(ep)) {
    const why = state.trivia.errors.wikipedia ? "Wikipedia didn't respond."
      : (state.trivia.wikipedia && (!isTv() || state.filters.scopes.series)) ||
        (state.trivia.episode_wikipedia && state.filters.scopes.episode) ? "Everything here is switched off in Settings."
      : subject() === "episode" ? "This episode doesn't have its own Wikipedia article." + SERIES_HINT
      : "No Wikipedia article found.";
    box.replaceChildren(el("p", { className: "loading" }, why));
    return;
  }
  // Episode plots are skipped like movie plots, so this stays spoiler-light.
  box.replaceChildren(
    ...(!empty(ep) ? wikiArticle(ep, "This episode") : []),
    ...(!empty(w) ? wikiArticle(w, !empty(ep) ? "The series" : null) : []),
  );
}

// ---- Cast -------------------------------------------------------------------

function initials(name) {
  return name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

function avatar(person, className = "avatar") {
  const box = el("div", { className: className + (person.died ? " deceased" : "") });
  if (person.photo) {
    const img = el("img", { src: person.photo, alt: "", loading: "lazy" });
    img.onerror = () => box.replaceChildren(initials(person.name));
    box.append(img);
  } else {
    box.textContent = initials(person.name);
  }
  return box;
}

// What the server needs to find a title: its IDs, name and year, and the episode.
function titleParams(movie, params = new URLSearchParams()) {
  if (movie.imdb_id) params.set("imdb", movie.imdb_id);
  if (movie.tmdb_id) params.set("tmdb", movie.tmdb_id);
  if (movie.title) params.set("title", movie.title);
  if (movie.year) params.set("year", movie.year);
  if (movie.kind === "tv" && !movie.episode) params.set("kind", "tv"); // a show looked up on its own
  if (movie.episode) {
    params.set("kind", "tv");
    if (movie.episode.imdb_id) params.set("ep_imdb", movie.episode.imdb_id);
    if (movie.episode.season != null) params.set("season", movie.episode.season);
    if (movie.episode.number != null) params.set("episode", movie.episode.number);
  }
  return params;
}

async function loadCast(session, key, movie) {
  state.castFor = key;
  state.cast = null;
  renderCast();
  if (!session) return;
  const params = new URLSearchParams({ source: session.source, item: session.media_id });
  if (session.kind === "episode") params.set("show", session.item_id);
  if (movie) titleParams(movie, params);
  try {
    const res = await fetch("/api/cast?" + params);
    const data = await res.json();
    if (state.castFor === key) state.cast = data.cast || [];
  } catch {
    if (state.castFor === key) state.cast = [];
  }
  renderCast();
}

// A small icon with a tooltip that shows straight away (title= tooltips take a second or two).
function badge(icon, className, tip) {
  const b = el("span", { className: `${className} tip`, role: "img", ariaLabel: tip, tabIndex: 0 }, icon);
  b.dataset.tip = tip;
  return b;
}
const grave = (died) => el("span", { className: "grave", role: "img", ariaLabel: `died ${died}` }, "🪦");
// The trophy's tooltip lists what each EGOT award was for: "Oscar · Roman Holiday (1954)".
function trophy(p) {
  const MAX = 8;
  const lines = (p.egot_wins || []).map((w) => `${w.award} · ${w.for || "Award"}${w.year ? ` (${w.year})` : ""}`);
  if (lines.length > MAX) lines.splice(MAX - 1, lines.length, `+${lines.length - MAX + 1} more`);
  return badge("🏆", p.egot.length === 4 ? "trophy egot" : "trophy", lines.join("\n") || awardsNote(p.egot));
}
// "EGOT winner", "Oscar winner", "Oscar & Tony winner"…
function awardsNote(egot) {
  if (!egot || !egot.length) return null;
  if (egot.length === 4) return "EGOT winner";
  return (egot.length > 1 ? egot.slice(0, -1).join(", ") + " & " + egot.at(-1) : egot[0]) + " winner";
}

// Trophy then gravestone, for whoever has either.
function personBadges(p) {
  return [p.egot && p.egot.length && trophy(p), p.died && grave(p.died)].filter(Boolean);
}

function renderCast() {
  const grid = $("cast-grid");
  if (!state.cast) { grid.replaceChildren(el("p", { className: "loading" }, "Finding the cast…")); return; }
  if (!state.cast.length) { grid.replaceChildren(el("p", { className: "loading" }, "Your media server doesn't list a cast for this.")); return; }
  grid.replaceChildren(...state.cast.map((p) => {
    const card = el("button", { className: "cast-card" });
    const who = el("span", { className: "who" });
    who.append(el("span", { className: "name" }, p.name));
    if (p.role) who.append(el("span", { className: "role" }, p.role));
    for (const note of [awardsNote(p.egot), p.died && `Died ${p.died}`].filter(Boolean)) {
      who.append(el("span", { className: "notes" }, note));
    }
    if (p.guest) who.append(el("span", { className: "tag" }, "Guest star"));
    card.append(avatar(p), who);
    const badges = personBadges(p);
    if (badges.length) {
      const box = el("span", { className: "badges" });
      box.append(...badges);
      card.append(box);
    }
    card.onclick = () => openPerson(p);
    return card;
  }));
}

async function openPerson(p) {
  const session = libraryItem();
  if (!session) return;
  const dialog = $("person");
  $("person-photo").replaceWith(Object.assign(avatar(p, "avatar large"), { id: "person-photo" }));
  $("person-name").textContent = p.name;
  $("person-name").dataset.who = p.name;
  $("person-name").append(...personBadges(p));
  $("person-meta").textContent = p.role ? `${p.role} in ${session.title}` : "";
  $("person-body").replaceChildren(el("p", { className: "loading" }, "Looking them up…"));
  if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open", "");

  const params = new URLSearchParams({ source: session.source, id: p.id, name: p.name });
  try {
    const res = await fetch("/api/person?" + params);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText);
    const data = await res.json();
    if ($("person-name").dataset.who === p.name) renderPerson(p, data, session);
  } catch (e) {
    $("person-body").replaceChildren(el("p", { className: "error" }, "Couldn't look them up: " + e.message));
  }
}

function renderPerson(p, data, session) {
  const parts = [];
  const about = data.imdb;
  if (about && about.died && !p.died) {
    $("person-name").append(grave(about.died));
    $("person-photo").classList.add("deceased");
  }

  // Other titles in your library, not counting the one on screen.
  const elsewhere = data.library.filter((t) => t.item_id !== session.item_id);
  parts.push(el("h3", {}, "In your library"));
  if (elsewhere.length) {
    const shelf = el("div", { className: "shelf" });
    for (const t of elsewhere) {
      const item = el("div", { className: "shelf-item" });
      const cover = el("div", { className: "cover" });
      cover.append(el("span", {}, t.title));
      const img = el("img", { src: imageUrl(session.source, t.item_id, "poster"), alt: "", loading: "lazy" });
      img.onerror = () => img.remove();
      cover.append(img);
      item.append(cover, el("div", { className: "title" }, t.title));
      const sub = t.episodes && t.episodes.length
        ? t.episodes.slice(0, 2).join(", ") + (t.episodes.length > 2 ? ` +${t.episodes.length - 2} more` : "")
        : t.year ? String(t.year) : "";
      if (sub) item.append(el("div", { className: "sub" }, sub));
      shelf.append(item);
    }
    parts.push(shelf);
  } else {
    parts.push(el("p", { className: "empty-note" },
      data.errors.library ? "Couldn't search your library." : "Nothing else in your library."));
  }

  if (about) {
    const at = (date, place) => [date, place && `in ${place}`].filter(Boolean).join(" ");
    const rows = [
      ["Born", at(about.born, about.birthplace)],
      ["Died", at(about.died, about.death_place)],
      ["Cause of death", about.death_cause && about.death_cause[0].toUpperCase() + about.death_cause.slice(1)],
      ["Height", about.height],
      ["Known for", (about.known_for || []).map((t) => t.title + (t.year ? ` (${t.year})` : "")).join(", ")],
    ].filter(([, v]) => v);
    if (rows.length) {
      const dl = el("dl", { className: "person-facts" });
      for (const [k, v] of rows) dl.append(el("dt", {}, k), el("dd", {}, v));
      parts.push(dl);
    }
  }
  const awards = about && about.awards;
  if (awards) {
    parts.push(el("h3", {}, "Awards"));
    const box = el("div", { className: "awards" });
    if (awards.summary) box.append(el("p", { className: "awards-top" }, "🏆 " + awards.summary));
    if (awards.wins || awards.nominations) {
      box.append(el("p", { className: "awards-total" },
        `${awards.wins} ${awards.wins === 1 ? "win" : "wins"} and ${awards.nominations} nominations in total`));
    }
    if (awards.highlights.length) {
      box.append(el("ul", { className: "person-trivia" }, undefined));
      box.lastChild.append(...awards.highlights.map((a) => el("li", {},
        `${a.year ? a.year + " " : ""}${a.event}: ${a.category || a.award}${a.title ? ` (${a.title})` : ""}`)));
    }
    box.append(el("a", { className: "wiki-link", href: about.url + "awards/", target: "_blank", rel: "noopener" }, "All awards on IMDb →"));
    parts.push(box);
  }

  if (about && about.bio) {
    parts.push(el("h3", {}, "About"));
    const bio = el("div", { className: "bio" });
    about.bio.split("\n\n").forEach((para) => bio.append(el("p", {}, para)));
    bio.append(el("a", { className: "wiki-link", href: about.url, target: "_blank", rel: "noopener" }, "Full biography on IMDb →"));
    parts.push(bio);
  }
  if (about && about.trivia.length) {
    parts.push(el("h3", {}, "Trivia"));
    const list = el("ul", { className: "person-trivia" });
    const show = (n) => list.replaceChildren(...about.trivia.slice(0, n).map((t) => el("li", {}, t)));
    show(5);
    parts.push(list);
    if (about.trivia.length > 5) {
      const more = el("button", { className: "more-link" }, `Show all ${about.trivia.length}`);
      more.onclick = () => { show(about.trivia.length); more.remove(); };
      parts.push(more);
    }
  }
  if (!about && !data.errors.imdb) parts.push(el("p", { className: "empty-note" }, "IMDb doesn't have more about them."));
  const credits = [{ text: `your ${session.source === "plex" ? "Plex" : "Jellyfin"} library` }];
  if (about) credits.push({ text: "IMDb", href: about.url });
  const footer = el("footer", { className: "source-links" });
  footer.append(sourceLine("Sources", credits));
  parts.push(footer);
  $("person-body").replaceChildren(...parts);
}

// ---- Wiring ----------------------------------------------------------------

document.querySelectorAll(".tabs button").forEach((b) => {
  b.onclick = () => { state.tab = b.dataset.tab; store("tab", state.tab); renderTrivia(); };
});

const EYE_OPEN = "M12 5C6.5 5 2.7 9.4 1.5 12c1.2 2.6 5 7 10.5 7s9.3-4.4 10.5-7C21.3 9.4 17.5 5 12 5zm0 11.5a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zm0-7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z";
const EYE_SHUT = "M2.3 3.7 3.7 2.3l18 18-1.4 1.4-3.4-3.4A11 11 0 0 1 12 19C6.5 19 2.7 14.6 1.5 12a13 13 0 0 1 3.9-4.9zM12 5c5.5 0 9.3 4.4 10.5 7a13 13 0 0 1-2.9 4L16.4 12.8A4.5 4.5 0 0 0 11.2 7.6L8.9 5.3A11 11 0 0 1 12 5zm-4.4 5.2 6.2 6.2A4.5 4.5 0 0 1 7.6 10.2z";

function renderSpoilerToggle() {
  const btn = $("spoilers");
  btn.setAttribute("aria-pressed", String(state.showSpoilers));
  $("spoiler-icon").setAttribute("d", state.showSpoilers ? EYE_OPEN : EYE_SHUT);
  btn.title = state.showSpoilers ? "Spoilers shown: tap to hide them" : "Spoilers hidden: tap a blurred fact to reveal it";
}

$("spoilers").onclick = () => {
  state.showSpoilers = !state.showSpoilers;
  store("spoilers", state.showSpoilers ? "1" : "0");
  renderSpoilerToggle();
  // Keep the current Spotlight fact and the reader's place in the lists.
  const current = state.deck[state.deckPos];
  buildDeck();
  const kept = current ? state.deck.findIndex((c) => c.text === current.text) : -1;
  if (kept >= 0) state.deckPos = kept;
  renderTrivia();
};
renderSpoilerToggle();

$("spot-next").onclick = () => stepSpotlight(1);
$("spot-prev").onclick = () => stepSpotlight(-1);
$("spot-card").onclick = () => stepSpotlight(1);
let noteTimer;
$("spot-auto").onclick = () => {
  state.autoplay = !state.autoplay;
  store("autoplay", state.autoplay ? "1" : "0");
  state.spotStarted = Date.now();
  renderAutoToggle();
  const note = $("spot-note");
  note.textContent = state.autoplay ? "Auto-advance on: new fact every 20 seconds" : "Auto-advance off";
  note.classList.remove("fade");
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => note.classList.add("fade"), 2000);
};
renderAutoToggle();


document.addEventListener("keydown", (e) => {
  if (state.screen) {
    if (e.key === "Escape") exitScreen();
    if (e.key === " ") { e.preventDefault(); toggleScreenPlay(); }
  }
  if (e.target.tagName === "INPUT" || (state.tab !== "spotlight" && !state.screen)) return;
  if (e.key === "ArrowRight") stepSpotlight(1);
  if (e.key === "ArrowLeft") stepSpotlight(-1);
});

// ---- Search: suggestions as you type, and recently added titles -------------

let suggestTimer = null;
let suggestions = [];
let suggestPos = -1;

function hideSuggestions() {
  $("search-suggestions").hidden = true;
  $("search-input").setAttribute("aria-expanded", "false");
  suggestPos = -1;
}

function renderSuggestions() {
  const list = $("search-suggestions");
  if (!suggestions.length) { hideSuggestions(); return; }
  list.replaceChildren(...suggestions.map((r, i) => {
    const li = el("li", { role: "option", id: `suggestion-${i}` });
    li.setAttribute("aria-selected", String(i === suggestPos));
    li.append(el("span", { className: "s-title" }, r.title + (r.year ? ` (${r.year})` : "")));
    li.append(el("span", { className: "s-meta" }, [r.kind === "tv" ? "TV series" : "Movie", r.stars].filter(Boolean).join(" · ")));
    li.onmousedown = (e) => { e.preventDefault(); pickSuggestion(r); }; // before the input loses focus
    return li;
  }));
  list.hidden = false;
  $("search-input").setAttribute("aria-expanded", "true");
}

function pickSuggestion(r) {
  $("search-input").value = r.title;
  lookUp({ title: r.title, year: r.year, imdb_id: r.imdb_id, kind: r.kind });
}

$("search-input").addEventListener("input", () => {
  clearTimeout(suggestTimer);
  const q = $("search-input").value.trim();
  if (q.length < 2) { suggestions = []; hideSuggestions(); return; }
  suggestTimer = setTimeout(async () => {
    try {
      const res = await fetch("/api/suggest?" + new URLSearchParams({ q }));
      const data = await res.json();
      if ($("search-input").value.trim() !== q) return; // typed on since
      suggestions = data.results || [];
      suggestPos = -1;
      renderSuggestions();
    } catch { /* suggestions are optional */ }
  }, 250);
});

$("search-input").addEventListener("keydown", (e) => {
  if ($("search-suggestions").hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    // -1 means "nothing selected": the typed text is searched as is.
    const last = suggestions.length - 1;
    if (e.key === "ArrowDown") suggestPos = suggestPos >= last ? -1 : suggestPos + 1;
    else suggestPos = suggestPos <= -1 ? last : suggestPos - 1;
    renderSuggestions();
  } else if (e.key === "Escape") {
    hideSuggestions();
  }
});
$("search-input").addEventListener("blur", () => setTimeout(hideSuggestions, 100));

$("search").onsubmit = (e) => {
  e.preventDefault();
  if (suggestPos >= 0 && suggestions[suggestPos]) { pickSuggestion(suggestions[suggestPos]); return; }
  const q = $("search-input").value.trim();
  if (q) lookUp({ title: q });
};

let recentLoadedAt = 0;
async function loadRecent() {
  if (Date.now() - recentLoadedAt < 5 * 60 * 1000) return; // refreshed every few minutes at most
  recentLoadedAt = Date.now();
  try {
    const movies = (await (await fetch("/api/recent")).json()).movies || [];
    const sources = new Set(movies.map((m) => m.source));
    $("recent-title").textContent = sources.size === 1
      ? `Recently added on ${[...sources][0] === "plex" ? "Plex" : "Jellyfin"}` : "Recently added";
    $("recent-shelf").replaceChildren(...movies.map((m) => {
      const item = el("button", { className: "shelf-item" });
      const cover = el("div", { className: "cover" });
      cover.append(el("span", {}, m.title));
      const img = el("img", { src: imageUrl(m.source, m.item_id, "poster"), alt: "", loading: "lazy" });
      img.onerror = () => img.remove();
      cover.append(img);
      item.append(cover, el("div", { className: "title" }, m.title));
      if (m.year) item.append(el("div", { className: "sub" }, String(m.year)));
      item.onclick = () => lookUp({ ...m, kind: "movie" });
      return item;
    }));
    $("recent").hidden = !movies.length;
  } catch {
    $("recent").hidden = true;
  }
}

let pickLoadedAt = 0;
async function loadPick(another = false) {
  if (!another && Date.now() - pickLoadedAt < 5 * 60 * 1000) return;
  pickLoadedAt = Date.now();
  const btn = $("pick-another");
  btn.disabled = true;
  try {
    const m = (await (await fetch("/api/pick" + (another ? "?another=1" : ""))).json()).movie;
    $("pick").hidden = !m;
    if (!m) return;
    $("pick-title").textContent = m.title + (m.year ? ` (${m.year})` : "");
    $("pick-cover-title").textContent = m.title;
    $("pick-teaser").textContent = m.teaser || m.tagline || "";
    $("pick-teaser").hidden = !(m.teaser || m.tagline);
    $("pick-sub").textContent = `Unwatched on ${m.source === "plex" ? "Plex" : "Jellyfin"} · tap for trivia`;
    const img = $("pick-poster");
    img.hidden = false;
    img.onerror = () => { img.hidden = true; };
    img.src = imageUrl(m.source, m.item_id, "poster");
    $("pick-open").onclick = () => lookUp({ ...m, kind: "movie" });
  } catch {
    $("pick").hidden = true;
  } finally {
    btn.disabled = false;
  }
}
$("pick-another").onclick = () => loadPick(true);

$("back-to-playing").onclick = () => {
  state.manual = null;
  state.triviaFor = null;
  render();
};

$("tv-view").querySelectorAll("button").forEach((b) => {
  b.onclick = () => {
    if (state.tvView === b.dataset.view) return;
    state.tvView = b.dataset.view;
    store("tvView", state.tvView);
    applyTvView();
    buildDeck();
    renderTrivia();
  };
});

$("person-close").onclick = () => $("person").close();

// The header name opens search from anywhere. The search box and recently added shelf move
// into the sheet while it's open, and back to the "Nothing playing" page after.
function openFind() {
  $("find-body").append($("search"), $("recent"));
  $("search-input").value = "";
  $("find").showModal();
  $("search-input").focus();
  loadRecent();
}
$("brand").onclick = openFind;
$("find-close").onclick = () => $("find").close();
$("find").addEventListener("close", () => {
  hideSuggestions();
  $("empty").append($("search"), $("recent"));
});
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !state.screen && !document.querySelector("dialog[open]") && !/INPUT|TEXTAREA/.test(e.target.tagName)) {
    e.preventDefault();
    openFind();
  }
});
$("person").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.close(); // tap outside the sheet closes it
});

// ---- Second screen ----------------------------------------------------------
// A full-screen, hands-free view for a tablet or old phone near the TV: big facts that
// advance on their own, the screen kept awake, controls that appear on tap.

const SPEEDS = [10000, 20000, 40000, 60000];
let wakeLock = null;
let controlsTimer = null;

async function keepAwake() {
  if (!state.screen || !("wakeLock" in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch { /* not allowed right now */ }
}

function enterScreen() {
  state.screen = true;
  document.body.classList.add("screen-mode");
  $("screen").hidden = false;
  history.replaceState(null, "", "?screen");
  // Full screen needs a tap, so this quietly does nothing when opened from a bookmark.
  if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
  keepAwake();
  $("screen-note").hidden = "wakeLock" in navigator;
  $("screen-note").textContent = "This browser can't keep the screen on. Set the device's auto-lock to Never.";
  state.spotStarted = Date.now();
  renderScreen();
  showControls();
}

function exitScreen() {
  state.screen = false;
  document.body.classList.remove("screen-mode", "screen-controls-on", "idle");
  $("screen").hidden = true;
  history.replaceState(null, "", location.pathname);
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function showControls() {
  document.body.classList.add("screen-controls-on");
  document.body.classList.remove("idle");
  clearTimeout(controlsTimer);
  controlsTimer = setTimeout(() => document.body.classList.remove("screen-controls-on"), 4000);
  setTimeout(() => { if (!document.body.classList.contains("screen-controls-on")) document.body.classList.add("idle"); }, 4100);
}

function toggleScreenPlay() {
  state.autoplay = !state.autoplay;
  store("autoplay", state.autoplay ? "1" : "0");
  state.spotStarted = Date.now();
  renderAutoToggle();
  renderScreen();
}

function renderScreen() {
  if (!state.screen) return;
  const movie = state.movie, session = state.manual ? null : currentSession();
  const ep = movie && movie.episode;
  $("screen-title").textContent = !movie ? "Nothing playing"
    : movie.title + (movie.year && !ep ? ` (${movie.year})` : "");
  $("screen-sub").textContent = ep ? [episodeCode(ep), ep.title].filter(Boolean).join(" · ")
    : session ? [session.state === "paused" ? "Paused" : "Now playing", session.device].filter(Boolean).join(" · ") : "";

  const item = movie && state.deck[state.deckPos];
  const text = item ? item.text
    : !movie ? `Facts appear here when something starts playing on ${serverNames()}.`
    : state.trivia ? `No trivia found for this ${subject()}.` : "Finding trivia…";
  const textEl = $("screen-text");
  if (textEl.dataset.text !== text) {
    textEl.dataset.text = text;
    // Fade between facts so the change is easy on the eyes from across the room.
    textEl.classList.add("fading");
    setTimeout(() => {
      textEl.textContent = text;
      textEl.classList.toggle("long", text.length > 220);
      textEl.classList.remove("fading");
    }, textEl.textContent ? 300 : 0);
  }
  $("screen-source").textContent = item ? item.source : "Moviebrain";
  $("screen-play").textContent = state.autoplay ? "❚❚" : "▶";
  $("screen-play").setAttribute("aria-label", state.autoplay ? "Pause" : "Play");
  $("screen-speed").textContent = `${state.interval / 1000}s per fact`;
  tickScreen();
}

function tickScreen() {
  $("screen-clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const s = state.manual ? null : currentSession();
  $("screen-progress").style.width = s && s.duration_ms ? (100 * currentPosition(s) / s.duration_ms).toFixed(2) + "%" : "0";
}

$("spot-screen").onclick = enterScreen;
$("empty-screen").onclick = enterScreen;
$("screen-exit").onclick = (e) => { e.stopPropagation(); exitScreen(); };
$("screen-prev").onclick = (e) => { e.stopPropagation(); stepSpotlight(-1); showControls(); };
$("screen-next").onclick = (e) => { e.stopPropagation(); stepSpotlight(1); showControls(); };
$("screen-play").onclick = (e) => { e.stopPropagation(); toggleScreenPlay(); showControls(); };
$("screen-speed").onclick = (e) => {
  e.stopPropagation();
  state.interval = SPEEDS[(SPEEDS.indexOf(state.interval) + 1) % SPEEDS.length] || SPOTLIGHT_MS;
  store("interval", String(state.interval));
  state.spotStarted = Date.now();
  renderScreen();
  showControls();
};
// Tap shows the controls; swipe left or right changes fact.
let touchX = null;
$("screen").addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; }, { passive: true });
$("screen").addEventListener("touchend", (e) => {
  const dx = touchX === null ? 0 : e.changedTouches[0].clientX - touchX;
  touchX = null;
  if (Math.abs(dx) > 50) { stepSpotlight(dx < 0 ? 1 : -1); showControls(); }
});
$("screen").addEventListener("click", showControls);
document.addEventListener("mousemove", () => { if (state.screen) showControls(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) keepAwake(); });

// One-second tick: progress bar and spotlight auto-advance.
setInterval(() => {
  if (state.movie) updateProgress();
  const bar = $("spot-timer").firstElementChild;
  const advancing = state.autoplay && state.deck.length > 1 && (state.tab === "spotlight" || state.screen);
  if (advancing && Date.now() - state.spotStarted >= state.interval) stepSpotlight(1);
  const done = advancing ? Math.min(100, 100 * (Date.now() - state.spotStarted) / state.interval) + "%" : "0";
  bar.style.width = done;
  if (state.screen) {
    $("screen-timer").style.width = done;
    tickScreen();
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

Promise.all([loadAuth(), loadDisplayChoices()]).then(poll).then(() => {
  if (new URLSearchParams(location.search).has("screen")) enterScreen();
});
setInterval(poll, POLL_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
