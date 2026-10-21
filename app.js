const API_BASE = "https://names-n-faces-api.fractalated.workers.dev";
const TOKEN_KEY = "nnf_token";

let cachedDecks = null;
let cachedUser = null;
let cachedMasterStudents = null;

function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
  cachedDecks = null;
  cachedUser = null;
  cachedMasterStudents = null;
}
function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  cachedDecks = null;
  cachedUser = null;
  cachedMasterStudents = null;
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

// Fetches (and caches in memory) the full shared master student list. Used
// by any page that needs to search/match against it (deck-builder, deck-edit,
// the home-page student search) — a single shared cache means switching
// pages doesn't re-fetch ~1000+ rows redundantly.
async function loadMasterStudents(force = false) {
  if (cachedMasterStudents && !force) return cachedMasterStudents;
  const res = await apiFetch("/api/master/students");
  const data = await res.json();
  cachedMasterStudents = data.students;
  return cachedMasterStudents;
}

// Must match normalizeNameKey in worker/src/index.js exactly (trim,
// lowercase, collapse whitespace) — the single source of truth for name
// matching, shared by every page that does it (deck-builder, deck-edit,
// admin's master-import duplicate detection, home-page search).
function normalizeNameKey(name) {
  return (name || "").toString().trim().toLowerCase().replace(/\s+/g, " ");
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = temp;
    }
  }
  return dp[n];
}

// Deliberate, scoped exception to the "no fuzzy matching" rule used for bulk
// operations (deck-builder.js's list import, admin.js's master-DB duplicate
// detection): here a human is typing ONE name by hand and explicitly wants a
// "closest match, please confirm" flow, which fuzzy scoring suits well.
// Substring matches (typo-free partial names) score highest; everything else
// falls back to normalized edit-distance similarity. Shared by deck-edit.js's
// "Add a Student" search and the home-page "Find a Student" search.
function similarity(query, candidateName) {
  const q = normalizeNameKey(query), c = normalizeNameKey(candidateName);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.includes(q) || q.includes(c)) return 0.92 - Math.min(0.3, Math.abs(c.length - q.length) * 0.01);
  const dist = levenshtein(q, c);
  return Math.max(0, 1 - dist / Math.max(q.length, c.length));
}

// "Stamison, John" -> {last: "stamison", first: "john"}. Every stored
// master_students.name is written in this "Last, First" order (see
// admin.js's import/add flows) — splitting on the comma is reliable.
function splitStoredName(name) {
  const idx = (name || "").indexOf(",");
  if (idx === -1) return { last: normalizeNameKey(name), first: "" };
  return {
    last: normalizeNameKey(name.slice(0, idx)),
    first: normalizeNameKey(name.slice(idx + 1)),
  };
}

// Common nickname/formal-name equivalence groups, used only for broad
// first-name matching (see matchStudentsByName below) — last names don't
// get nicknamed, so this never applies there. Deliberately not exhaustive;
// most common nicknames are already caught by similarity()'s substring
// check (e.g. "Liz" ⊂ "Elizabeth"), so this list exists for the pairs that
// AREN'T textual substrings of each other (e.g. "Bob"/"Robert",
// "Jack"/"John") — extend it as real cases come up.
const NICKNAME_GROUPS = [
  ["robert", "rob", "bob", "bobby", "robbie"],
  ["william", "will", "bill", "billy", "liam"],
  ["james", "jim", "jimmy", "jamie"],
  ["john", "jack", "johnny", "jon", "jonathan"],
  ["richard", "rick", "ricky", "dick"],
  ["charles", "charlie", "chuck", "chaz"],
  ["michael", "mike", "mikey", "mick"],
  ["margaret", "peggy", "maggie", "meg", "margie"],
  ["patricia", "pat", "patty", "trish"],
  ["dorothy", "dot", "dottie"],
  ["katherine", "kate", "katie", "kathy", "kat", "kit"],
  ["elizabeth", "beth", "eliza", "betty", "liz", "lizzy"],
  ["alexander", "alex", "xander", "sasha"],
  ["alexandra", "alex", "sandy", "lexi", "sasha"],
  ["theodore", "ted", "teddy", "theo"],
  ["edward", "ed", "eddie", "ted", "teddy"],
  ["henry", "hank", "harry"],
  ["francis", "frank", "frankie"],
  ["francesca", "frankie", "fran"],
  ["gerald", "jerry"],
  ["lawrence", "larry"],
  ["walter", "walt"],
  ["harold", "harry", "hal"],
  ["raymond", "ray"],
  ["russell", "russ"],
  ["nathaniel", "nathan", "nate"],
];
const NICKNAME_MAP = (() => {
  const map = new Map();
  for (const group of NICKNAME_GROUPS) {
    for (const name of group) {
      if (!map.has(name)) map.set(name, new Set());
      for (const other of group) if (other !== name) map.get(name).add(other);
    }
  }
  return map;
})();

function areNicknameEquivalent(a, b) {
  const na = normalizeNameKey(a), nb = normalizeNameKey(b);
  return NICKNAME_MAP.has(na) && NICKNAME_MAP.get(na).has(nb);
}

// Tight on last names (they don't change) — essentially exact, allowing
// only a small typo. Broad on first names (nicknames, shortened forms,
// spelling variants are common) — a much lower bar, plus the nickname
// lookup above.
const LAST_NAME_MATCH_THRESHOLD = 0.7;
// 0.45, not lower — a looser bar let short, unrelated first names (e.g.
// "Bob" vs "Jon") clear it purely from edit-distance coincidence. Real
// nickname/shortened-name cases are already caught by similarity()'s
// substring check or the NICKNAME_MAP above; this threshold mainly exists
// to still tolerate a genuine typo (e.g. "Micheal" for "Michael").
const FIRST_NAME_MATCH_THRESHOLD = 0.45;

// Matches students by separate, optional first/last name queries — order-
// independent by construction, since each query targets its own name
// component instead of the whole "Last, First" string at once (a single
// combined query like "John Stamison" used to score poorly against the
// stored "Stamison, John" purely because of word order). At least one of
// firstQuery/lastQuery must be given. A student must satisfy every
// constraint actually provided (AND, not OR) — searching both fields
// narrows the results, it doesn't broaden them. Returns
// [{student, score}] sorted by score descending.
function matchStudentsByName(students, { firstQuery, lastQuery } = {}) {
  const fq = (firstQuery || "").trim();
  const lq = (lastQuery || "").trim();
  if (!fq && !lq) return [];
  const results = [];
  for (const student of students) {
    const parts = splitStoredName(student.name);
    let lastScore = null, firstScore = null;
    if (lq) {
      lastScore = similarity(lq, parts.last);
      if (lastScore < LAST_NAME_MATCH_THRESHOLD) continue;
    }
    if (fq) {
      // A nickname match must never outrank (or tie) a literal exact match
      // — otherwise every nickname-equivalent name (e.g. every "Jack" and
      // "Jonathan" for a search of "John") ties with the real "John"s at a
      // flat 1.0 and can crowd them out of a short results list purely by
      // alphabetical luck. max(), not an unconditional override, so a
      // decent existing similarity() score (e.g. "Jon" as a substring of
      // "Jonathan") isn't needlessly capped down to the flat nickname bonus.
      const direct = similarity(fq, parts.first);
      firstScore = areNicknameEquivalent(fq, parts.first) ? Math.max(direct, 0.8) : direct;
      if (firstScore < FIRST_NAME_MATCH_THRESHOLD) continue;
    }
    const scores = [lastScore, firstScore].filter((s) => s !== null);
    const combined = scores.reduce((a, b) => a + b, 0) / scores.length;
    results.push({ student, score: combined });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

// For a name that didn't exactly match any known master name, offer the same
// fuzzy first/last matching deck-edit.js's "Add a Student" search uses as a
// "did you mean" check — never auto-assigned, always requires a human click.
// Shared by deck-builder.js (an unmatched list line) and deck-edit.js (an
// existing deck entry whose master_student_id is missing or stale — see
// "Check Database for Updates").
const FUZZY_SUGGESTION_LIMIT = 5;

function fuzzyMatchLine(fallbackName, masterStudents) {
  if (!fallbackName) return [];
  const { last, first } = splitStoredName(fallbackName);
  return matchStudentsByName(masterStudents, { firstQuery: first, lastQuery: last })
    .slice(0, FUZZY_SUGGESTION_LIMIT)
    .map((s) => s.student);
}

// Center-crop the largest square out of the source image, then scale to a
// fixed, phone-friendly size. Applied to every photo before it's uploaded —
// PDF extraction, an admin's manual add, or a teacher filling in a missing
// photo — so storage stays small and every card looks consistent regardless
// of the source photo's shape.
async function cropToSquare(blob, targetSize = 320) {
  const img = await createImageBitmap(blob);
  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2;
  const sy = (img.height - side) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = targetSize;
  canvas.height = targetSize;
  canvas.getContext("2d").drawImage(img, sx, sy, side, side, 0, 0, targetSize, targetSize);
  img.close?.();
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
}

// Any authenticated user (not just admin) may fill in a photo for a master
// student who doesn't have one yet — the server enforces "only when missing"
// server-side, so this is safe to expose broadly. Returns {ok, data} rather
// than throwing, so callers can show an inline error — including if
// cropToSquare itself fails (e.g. a corrupted or unsupported image file),
// which would otherwise reject unhandled and leave a caller's "Uploading…"
// button stuck forever with no feedback.
async function uploadMissingPhoto(studentId, file) {
  let croppedBlob;
  try {
    croppedBlob = await cropToSquare(file);
  } catch {
    return { ok: false, data: { error: "Could not read that image file. Try a different photo." } };
  }
  const form = new FormData();
  form.append("photo", croppedBlob, "photo.jpg");
  const res = await apiFetch(`/api/master/students/${studentId}/photo`, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

// Renders a small "Add Photo" button + hidden file input into `container`
// (appended, so the caller controls placement), wired to uploadMissingPhoto.
// Calls onSuccess(data) and removes the control once the upload succeeds —
// shared by deck-view.html's study grid and the home-page student search.
function renderAddPhotoControl(container, studentId, onSuccess) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "secondary";
  btn.textContent = "Add Photo";
  btn.style.marginTop = "6px";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.className = "hidden";
  btn.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    btn.disabled = true;
    btn.textContent = "Uploading…";
    const { ok, data } = await uploadMissingPhoto(studentId, file);
    if (!ok) {
      alert(data.error || "Could not add photo");
      btn.disabled = false;
      btn.textContent = "Add Photo";
      return;
    }
    onSuccess(data);
    input.remove();
    btn.remove();
  });
  container.appendChild(input);
  container.appendChild(btn);
}
