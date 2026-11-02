"use strict";

const form = document.getElementById("form");
const $ = (id) => document.getElementById(id);

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

async function load() {
  const data = await api("/api/settings");
  const s = data.settings;
  for (const el of form.elements) {
    if (!el.name || !(el.name in s)) continue;
    if (el.type === "checkbox") el.checked = !!s[el.name];
    else if (el.type === "radio") el.checked = el.value === s[el.name];
    else if (el.dataset.secret !== undefined) {
      el.value = "";
      el.placeholder = s[el.name + "_set"] ? "Saved — leave blank to keep" : "";
    } else el.value = s[el.name] ?? "";
  }
  $("oidc-callback").textContent = data.callback_urls.oidc;
  $("auth-env-warning").hidden = !data.auth_disabled_by_env;
  showAuthPanels();
}

function collect() {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === "checkbox") out[el.name] = el.checked;
    else if (el.type === "radio") { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value.trim();
  }
  return out;
}

form.addEventListener("change", (e) => { if (e.target.name === "auth_mode") showAuthPanels(); });

document.querySelectorAll("[data-test]").forEach((btn) => {
  btn.onclick = async () => {
    const source = btn.dataset.test;
    const keyName = { plex: "plex_token", jellyfin: "jellyfin_api_key", omdb: "omdb_api_key" }[source];
    setResult("test-" + source, true, "Testing…");
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
    } catch (e) {
      setResult("test-" + source, false, "✗ " + e.message);
    }
  };
});

$("oidc-callback").onclick = () => navigator.clipboard && navigator.clipboard.writeText($("oidc-callback").textContent);

form.onsubmit = async (e) => {
  e.preventDefault();
  const values = collect();
  const before = (await api("/api/auth/status")).mode;
  setResult("save-result", true, "Saving…");
  try {
    await api("/api/settings", { method: "POST", body: JSON.stringify(values) });
    setResult("save-result", true, "✓ Saved");
    // Turning sign-in on (or switching provider) means signing in with it now.
    if (values.auth_mode !== "none" && values.auth_mode !== before) {
      setTimeout(() => { location.href = "/login"; }, 600);
    } else {
      load();
    }
  } catch (err) {
    setResult("save-result", false, "✗ " + err.message);
  }
};

load().catch((e) => setResult("save-result", false, "Couldn't load settings: " + e.message));
