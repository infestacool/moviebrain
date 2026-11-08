"use strict";

// Settings save themselves: switches and choices straight away, text a moment after typing stops.
// Turning sign-in on is the exception: it waits for the "Turn on sign-in" button.

const form = document.getElementById("form");
const $ = (id) => document.getElementById(id);
const TYPING_DELAY = 1000;

let lastSaved = null;      // JSON of the values the server has
let savedAuthMode = "none"; // the sign-in mode actually in effect
let saveTimer = null;
let saving = false;
let saveAgain = false;
let statusTimer = null;

function field(name) { return form.elements[name]; }

function setResult(id, ok, text) {
  const el = $(id);
  el.textContent = text;
  el.className = "test-result " + (ok ? "ok" : "bad");
}

function showStatus(text, kind = "") {
  const el = $("save-result");
  clearTimeout(statusTimer);
  el.textContent = text;
  el.className = "save-status show " + kind;
  if (kind === "ok") statusTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  if (res.status === 401) { location.href = "/login"; throw new Error("Sign in required"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

function chosenAuthMode() {
  return form.elements.auth_mode.value;
}

function showAuthPanels() {
  const mode = chosenAuthMode();
  $("auth-plex").hidden = mode !== "plex";
  const authentik = mode === "authentik";
  $("auth-oidc").hidden = !(mode === "oidc" || authentik);
  $("oidc-name-field").hidden = authentik;
  field("oidc_issuer").placeholder = authentik ? "https://auth.example.com/application/o/moviebrain/" : "https://id.example.com";
  $("oidc-hint").textContent = authentik
    ? "In Authentik: Applications → Create with provider → OAuth2/OpenID, confidential client. Copy its OpenID Configuration Issuer here. Use this redirect URI (tap to copy):"
    : "In Pocket ID: Administration → OIDC Clients → Add. Use this callback URL (tap to copy):";
  $("auth-lists").hidden = mode === "none";
  // Switching sign-in on needs a deliberate click; switching it off just saves.
  $("auth-confirm").hidden = mode === "none" || mode === savedAuthMode;
  $("auth-confirm-btn").textContent = mode === "plex" ? "Turn on Plex sign-in" : `Turn on ${authentik ? "Authentik" : field("oidc_name").value || "Pocket ID"} sign-in`;
}

// Wikipedia sections and goof kinds are chips; the server stores the ones switched off.
function renderChips(boxId, groups, hiddenCsv, hiddenField) {
  const hidden = new Set(hiddenCsv.split(",").map((s) => s.trim()).filter(Boolean));
  $(boxId).replaceChildren(...groups.map(([key, label]) => {
    const chip = document.createElement("label");
    chip.className = "chip";
    const input = Object.assign(document.createElement("input"), { type: "checkbox", checked: !hidden.has(key) });
    input.dataset.hiddenField = hiddenField;
    input.dataset.key = key;
    const text = document.createElement("span");
    text.textContent = label;
    chip.append(input, text);
    return chip;
  }));
}

// Dim a source's options while it's switched off, and show which servers are set up.
function refreshState() {
  document.querySelectorAll(".tile.source").forEach((tile) => {
    tile.classList.toggle("off", !field(tile.dataset.source).checked);
  });
  for (const [source, key] of [["plex", "plex_token"], ["jellyfin", "jellyfin_api_key"]]) {
    const badge = $("status-" + source);
    if (badge.dataset.tested) continue;
    const hasKey = field(key).value.trim() || field(key).dataset.isSet === "1";
    const ready = field(source + "_url").value.trim() && hasKey;
    badge.textContent = ready ? "Set up" : "Not set up";
    badge.className = "status " + (ready ? "ready" : "");
  }
}

async function load() {
  const data = await api("/api/settings");
  const s = data.settings;
  for (const el of form.elements) {
    if (!el.name || !(el.name in s)) continue;
    if (el.type === "checkbox") el.checked = !!s[el.name];
    else if (el.type === "radio") el.checked = el.value === s[el.name];
    else if (el.dataset.secret !== undefined) {
      el.value = "";
      el.dataset.isSet = s[el.name + "_set"] ? "1" : "";
      if (s[el.name + "_set"]) el.placeholder = "Saved — leave blank to keep";
    } else el.value = s[el.name] ?? "";
  }
  const tvDefault = s.tv_series_facts && !s.tv_episode_facts ? "series" : "episode";
  form.querySelector(`input[name=tv_default][value=${tvDefault}]`).checked = true;
  renderChips("wiki-chips", data.groups.wiki, s.hidden_wiki_sections, "hidden_wiki_sections");
  renderChips("goof-chips", data.groups.goofs, s.hidden_goof_kinds, "hidden_goof_kinds");
  defaultTopics = data.default_warning_topics || [];
  renderTopics();
  $("oidc-callback").textContent = data.callback_urls.oidc;
  $("auth-env-warning").hidden = !data.auth_disabled_by_env;
  savedAuthMode = s.auth_mode;
  showAuthPanels();
  lastSaved = JSON.stringify(collect());
  refreshState();
}

// The values to save. Sign-in only changes when it's being turned off, or via the confirm button.
function collect(authMode = chosenAuthMode() === "none" ? "none" : savedAuthMode) {
  const out = { hidden_wiki_sections: [], hidden_goof_kinds: [] };
  for (const el of form.elements) {
    if (el.dataset.hiddenField) {
      if (!el.checked) out[el.dataset.hiddenField].push(el.dataset.key);
      continue;
    }
    if (!el.name) continue;
    if (el.type === "checkbox") out[el.name] = el.checked;
    else if (el.type === "radio") { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value.trim();
  }
  out.hidden_wiki_sections = out.hidden_wiki_sections.join(",");
  out.hidden_goof_kinds = out.hidden_goof_kinds.join(",");
  out.tv_episode_facts = out.tv_default === "episode";
  out.tv_series_facts = out.tv_default === "series";
  delete out.tv_default;
  out.auth_mode = authMode;
  return out;
}

// ---- Content warning topics: chips you can remove, plus a box to add your own ----
let defaultTopics = [];
const topicList = () => field("warning_topics").value.split(",").map((t) => t.trim()).filter(Boolean);

function setTopics(list) {
  const seen = new Set();
  const unique = list.filter((t) => t.length <= 40 && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  field("warning_topics").value = unique.slice(0, 30).join(", ");
  renderTopics();
  scheduleSave(0);
}

function renderTopics() {
  const box = $("topic-tags");
  const list = topicList();
  box.replaceChildren(...list.map((t) => {
    const chip = document.createElement("span");
    chip.className = "tag";
    chip.textContent = t;
    const x = document.createElement("button");
    Object.assign(x, { type: "button", textContent: "×", title: `Remove ${t}` });
    x.setAttribute("aria-label", `Remove ${t}`);
    x.onclick = () => setTopics(topicList().filter((v) => v !== t));
    chip.append(x);
    return chip;
  }));
  if (!list.length) box.textContent = "No topics: nothing will be flagged.";
  const isDefault = list.join(",").toLowerCase() === defaultTopics.join(",").toLowerCase();
  $("topic-reset").hidden = isDefault;
}

function addTopic() {
  const typed = $("topic-new").value.split(",").map((t) => t.trim()).filter(Boolean);
  if (!typed.length) return;
  setTopics([...topicList(), ...typed]);
  $("topic-new").value = "";
  $("topic-new").focus();
}
$("topic-add").onclick = addTopic;
$("topic-new").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); addTopic(); }
});
$("topic-reset").onclick = () => setTopics([...defaultTopics]);

function scheduleSave(delay) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save({ quiet: delay > 0 }), delay);
}

// quiet: saving mid-typing, so a half-entered value shows as "not saved yet" rather than an error.
async function save({ quiet = false, authMode } = {}) {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (saving) { saveAgain = true; return; }
  const values = collect(authMode);
  const json = JSON.stringify(values);
  if (json === lastSaved) {
    // Back to what's saved (e.g. a bad value undone), so any earlier error no longer applies.
    if (!$("save-result").classList.contains("ok")) $("save-result").classList.remove("show");
    return;
  }

  saving = true;
  showStatus("Saving…");
  try {
    const result = await api("/api/settings", { method: "POST", body: json });
    lastSaved = json;
    for (const el of form.querySelectorAll("[data-secret]")) {
      if (el.value.trim()) el.dataset.isSet = "1";
    }
    // A new server address drops the old key: ask for it again.
    for (const name of result.cleared || []) {
      Object.assign(field(name), { placeholder: "Enter it again for the new address" }).dataset.isSet = "";
    }
    const turnedOn = values.auth_mode !== "none" && values.auth_mode !== savedAuthMode;
    savedAuthMode = values.auth_mode;
    showAuthPanels();
    if (turnedOn) {
      showStatus("✓ Sign-in is on. Taking you to sign in…", "ok");
      setTimeout(() => { location.href = "/login"; }, 1500);
    } else {
      showStatus("✓ Saved", "ok");
    }
  } catch (err) {
    showStatus((quiet ? "Not saved yet: " : "✗ Not saved: ") + err.message, quiet ? "" : "bad");
  } finally {
    saving = false;
    if (saveAgain) { saveAgain = false; save(); }
  }
}

const isText = (el) => el.matches("input:not([type=checkbox]):not([type=radio])");

form.addEventListener("input", (e) => {
  refreshState();
  // Addresses save when you leave the field, so a half-typed one never gets used.
  if (isText(e.target) && e.target.type !== "url") scheduleSave(TYPING_DELAY);
});
form.addEventListener("change", (e) => {
  if (e.target.name === "auth_mode") showAuthPanels();
  refreshState();
  scheduleSave(0);
});
form.addEventListener("submit", (e) => { e.preventDefault(); save(); });

$("auth-confirm-btn").onclick = () => save({ authMode: chosenAuthMode() });
field("oidc_name").addEventListener("input", showAuthPanels);

document.querySelectorAll("[data-test]").forEach((btn) => {
  btn.onclick = async () => {
    const source = btn.dataset.test;
    const keyName = { plex: "plex_token", jellyfin: "jellyfin_api_key", omdb: "omdb_api_key", dtdd: "dtdd_api_key" }[source];
    setResult("test-" + source, true, "Testing…");
    const badge = $("status-" + source);
    try {
      const r = await api("/api/settings/test/" + source, {
        method: "POST",
        body: JSON.stringify({
          url: source === "omdb" || source === "dtdd" ? "" : field(source + "_url").value.trim(),
          key: field(keyName).value.trim(),
          verify_ssl: field("verify_ssl").checked,
        }),
      });
      setResult("test-" + source, true, (source === "omdb" || source === "dtdd" ? "✓ " : "✓ Connected to ") + r.server);
      if (badge) Object.assign(badge, { textContent: "Connected", className: "status ok" }).dataset.tested = "1";
    } catch (e) {
      setResult("test-" + source, false, "✗ " + e.message);
      if (badge) Object.assign(badge, { textContent: "Can't connect", className: "status bad" }).dataset.tested = "1";
    }
  };
});

$("oidc-callback").onclick = () => navigator.clipboard && navigator.clipboard.writeText($("oidc-callback").textContent);

// Leaving mid-typing: send what's there without waiting for the timer.
window.addEventListener("pagehide", () => {
  if (lastSaved === null || !saveTimer) return;
  const json = JSON.stringify(collect());
  if (json !== lastSaved) {
    fetch("/api/settings", { method: "POST", body: json, keepalive: true, headers: { "content-type": "application/json" } });
  }
});

function formatSize(bytes) {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

async function showCache(promise = api("/api/settings/cache")) {
  try {
    const c = await promise;
    $("cache-size").textContent = `${c.entries} item${c.entries === 1 ? "" : "s"}, ${formatSize(c.bytes)}`;
  } catch {
    $("cache-size").textContent = "unknown";
  }
}

$("cache-clear").onclick = () => showCache(api("/api/settings/cache/clear", { method: "POST" }));
showCache();

load().catch((e) => showStatus("Couldn't load settings: " + e.message, "bad"));
