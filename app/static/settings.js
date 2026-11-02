"use strict";

const form = document.getElementById("form");
const $ = (id) => document.getElementById(id);
let saved = null; // last loaded/saved values, to spot unsaved changes

function field(name) { return form.elements[name]; }

function setResult(id, ok, text) {
  const el = $(id);
  el.textContent = text;
  el.className = "test-result " + (ok ? "ok" : "bad");
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  if (res.status === 401) { location.href = "/login"; throw new Error("Sign in required"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || res.statusText);
  return data;
}

function showAuthPanels() {
  const mode = form.elements.auth_mode.value;
  $("auth-plex").hidden = mode !== "plex";
  $("auth-oidc").hidden = mode !== "oidc";
  $("auth-lists").hidden = mode === "none";
}

// Wikipedia sections and goof kinds are chips; the server stores the ones switched off.
function renderChips(boxId, groups, hiddenCsv, field) {
  const hidden = new Set(hiddenCsv.split(",").map((s) => s.trim()).filter(Boolean));
  $(boxId).replaceChildren(...groups.map(([key, label]) => {
    const chip = document.createElement("label");
    chip.className = "chip";
    const input = Object.assign(document.createElement("input"), { type: "checkbox", checked: !hidden.has(key) });
    input.dataset.hiddenField = field;
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
  const dirty = saved !== null && JSON.stringify(collect()) !== saved;
  document.body.classList.toggle("dirty", dirty);
  if (dirty) setResult("save-result", true, "Unsaved changes");
  else if ($("save-result").textContent === "Unsaved changes") $("save-result").textContent = "";
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
      el.placeholder = s[el.name + "_set"] ? "Saved — leave blank to keep" : el.placeholder;
    } else el.value = s[el.name] ?? "";
  }
  renderChips("wiki-chips", data.groups.wiki, s.hidden_wiki_sections, "hidden_wiki_sections");
  renderChips("goof-chips", data.groups.goofs, s.hidden_goof_kinds, "hidden_goof_kinds");
  $("oidc-callback").textContent = data.callback_urls.oidc;
  $("auth-env-warning").hidden = !data.auth_disabled_by_env;
  showAuthPanels();
  saved = JSON.stringify(collect());
  refreshState();
}

function collect() {
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
  return out;
}

form.addEventListener("change", (e) => {
  if (e.target.name === "auth_mode") showAuthPanels();
  refreshState();
});
form.addEventListener("input", refreshState);

document.querySelectorAll("[data-test]").forEach((btn) => {
  btn.onclick = async () => {
    const source = btn.dataset.test;
    const keyName = { plex: "plex_token", jellyfin: "jellyfin_api_key", omdb: "omdb_api_key" }[source];
    setResult("test-" + source, true, "Testing…");
    const badge = $("status-" + source);
    try {
      const r = await api("/api/settings/test/" + source, {
        method: "POST",
        body: JSON.stringify({
          url: source === "omdb" ? "" : field(source + "_url").value.trim(),
          key: field(keyName).value.trim(),
          verify_ssl: field("verify_ssl").checked,
        }),
      });
      setResult("test-" + source, true, (source === "omdb" ? "✓ " : "✓ Connected to ") + r.server);
      if (badge) Object.assign(badge, { textContent: "Connected", className: "status ok" }).dataset.tested = "1";
    } catch (e) {
      setResult("test-" + source, false, "✗ " + e.message);
      if (badge) Object.assign(badge, { textContent: "Can't connect", className: "status bad" }).dataset.tested = "1";
    }
  };
});

$("oidc-callback").onclick = () => navigator.clipboard && navigator.clipboard.writeText($("oidc-callback").textContent);

window.addEventListener("beforeunload", (e) => {
  if (document.body.classList.contains("dirty")) e.preventDefault();
});

form.onsubmit = async (e) => {
  e.preventDefault();
  const values = collect();
  const before = (await api("/api/auth/status")).mode;
  setResult("save-result", true, "Saving…");
  try {
    await api("/api/settings", { method: "POST", body: JSON.stringify(values) });
    saved = JSON.stringify(values);
    document.body.classList.remove("dirty");
    setResult("save-result", true, "✓ Saved");
    // Turning sign-in on (or switching provider) means signing in with it now.
    if (values.auth_mode !== "none" && values.auth_mode !== before) {
      setTimeout(() => { location.href = "/login"; }, 600);
    } else {
      await load();
      setResult("save-result", true, "✓ Saved");
    }
  } catch (err) {
    setResult("save-result", false, "✗ " + err.message);
  }
};

load().catch((e) => setResult("save-result", false, "Couldn't load settings: " + e.message));
