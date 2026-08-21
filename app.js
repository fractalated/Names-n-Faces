const API_BASE = "https://names-n-faces-api.fractalated.workers.dev";
const TOKEN_KEY = "nnf_token";

let cachedDecks = null;
let cachedUser = null;

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
  cachedDecks = null;
  cachedUser = null;
}
function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  cachedDecks = null;
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

// Fetches (and caches in memory) the logged-in user's own decks.
async function loadDecks(force = false) {
  if (cachedDecks && !force) return cachedDecks;
  const res = await apiFetch("/api/decks");
  const data = await res.json();
  cachedDecks = data.decks;
  return cachedDecks;
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

// Generic grey silhouette shown whenever a card has no photo — either the
// matched master student never had one, or the match itself is missing
// (never matched, or the master record was since removed/replaced). Inline
// SVG so there's no extra request and it themes with the existing palette.
const PLACEHOLDER_SILHOUETTE_SVG =
  "data:image/svg+xml;utf8," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'>" +
    "<rect width='100' height='100' fill='#e1e4ea'/>" +
    "<circle cx='50' cy='38' r='18' fill='#98a2b3'/>" +
    "<path d='M14 92 C14 66 30 56 50 56 C70 56 86 66 86 92 Z' fill='#98a2b3'/>" +
    "</svg>"
  );

// Sets imgEl.src from a card's photo, falling back to the placeholder
// silhouette when the card has no photo, or if fetching it fails.
async function loadCardImage(imgEl, card) {
  if (!card.hasPhoto || !card.photoUrl) {
    imgEl.src = PLACEHOLDER_SILHOUETTE_SVG;
    return;
  }
  try {
    imgEl.src = await fetchPhotoObjectUrl(card.photoUrl);
  } catch {
    imgEl.src = PLACEHOLDER_SILHOUETTE_SVG;
  }
}
