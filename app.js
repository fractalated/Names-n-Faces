const API_BASE = "https://names-n-faces-api.fractalated.workers.dev";
const TOKEN_KEY = "nnf_token";

let cachedCollections = null;
let cachedUser = null;

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
  cachedCollections = null;
  cachedUser = null;
}
function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  cachedCollections = null;
  cachedUser = null;
}
function requireLogin() {
  if (!getToken()) {
    location.href = "index.html";
  }
}
function logout() {
  clearToken();
  location.href = "index.html";
}

async function apiFetch(path, opts = {}) {
  const token = getToken();
  const headers = { ...(opts.headers || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(API_BASE + path, { ...opts, headers });
  if (res.status === 401) {
    clearToken();
    location.href = "index.html";
    throw new Error("Unauthorized");
  }
  return res;
}

async function fetchPhotoObjectUrl(photoUrl) {
  const res = await apiFetch(photoUrl);
  if (!res.ok) throw new Error("Photo not found");
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// Fetches (and caches in memory) the logged-in user's own collections. Every
// user has their own independent set — there is no global fixed list anymore.
async function loadCollections(force = false) {
  if (cachedCollections && !force) return cachedCollections;
  const res = await apiFetch("/api/collections");
  const data = await res.json();
  cachedCollections = data.collections;
  return cachedCollections;
}

// Fetches (and caches in memory) the logged-in user's identity/role. This is
// the only source of truth for admin-gating UI — the server independently
// re-checks admin status on every admin-only route regardless of this.
async function loadMe(force = false) {
  if (cachedUser && !force) return cachedUser;
  const res = await apiFetch("/api/me");
  cachedUser = await res.json();
  return cachedUser;
}

function collectionLabel(slug, collections) {
  if (slug === "all") return "All Collections";
  const list = collections || cachedCollections || [];
  const match = list.find((c) => c.slug === slug);
  return match ? match.label : slug;
}
