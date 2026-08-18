const API_BASE = "https://names-n-faces-api.fractalated.workers.dev";
const TOKEN_KEY = "nnf_token";

const COLLECTIONS = [
  { id: "period-1", label: "Period 1" },
  { id: "period-2", label: "Period 2" },
  { id: "period-3", label: "Period 3" },
  { id: "period-4", label: "Period 4" },
  { id: "period-5", label: "Period 5" },
  { id: "period-6", label: "Period 6" },
  { id: "period-7", label: "Period 7" },
  { id: "period-8", label: "Period 8" },
  { id: "period-9", label: "Period 9" },
  { id: "chapel", label: "Chapel" },
];

function collectionLabel(id) {
  if (id === "all") return "All Collections";
  const c = COLLECTIONS.find((c) => c.id === id);
  return c ? c.label : id;
}

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}
function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
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
