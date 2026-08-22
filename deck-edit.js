requireLogin();

const params = new URLSearchParams(location.search);
const deckId = params.get("d");

let currentCards = [];
let masterStudents = null; // fetched once, lazily, on first search
const selected = new Set();

// Must match normalizeNameKey in worker/src/index.js (trim, lowercase,
// collapse whitespace) — same convention as deck-builder.js.
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

// Deliberate, scoped exception to the "no fuzzy matching" rule used
// elsewhere (deck-builder.js's bulk import): here the user is typing ONE
// name by hand and explicitly wants a "closest match, please confirm" flow,
// which fuzzy scoring is exactly suited for. Substring matches (typo-free
// partial names) score highest; everything else falls back to normalized
// edit-distance similarity.
function similarity(query, candidateName) {
  const q = normalizeNameKey(query), c = normalizeNameKey(candidateName);
  if (!q || !c) return 0;
  if (q === c) return 1;
  if (c.includes(q) || q.includes(c)) return 0.92 - Math.min(0.3, Math.abs(c.length - q.length) * 0.01);
  const dist = levenshtein(q, c);
  return Math.max(0, 1 - dist / Math.max(q.length, c.length));
}

async function ensureMasterStudents() {
  if (masterStudents) return masterStudents;
  const res = await apiFetch("/api/master/students");
  const data = await res.json();
  masterStudents = data.students;
  return masterStudents;
}

async function loadDeck() {
  const res = await apiFetch(`/api/decks/${encodeURIComponent(deckId)}/cards`);
  if (!res.ok) {
    document.getElementById("title").textContent = "Deck not found";
    return;
  }
  const data = await res.json();
  document.getElementById("title").textContent = `Edit "${data.label}"`;
  currentCards = data.cards;
  renderCurrentList();
}

function renderCurrentList() {
  const list = document.getElementById("current-list");
  selected.clear();
  updateRemoveButton();
  if (currentCards.length === 0) {
    list.innerHTML = "<p>No students in this deck yet.</p>";
    return;
  }
  list.innerHTML = "";
  for (const card of currentCards) {
    const item = document.createElement("label");
    item.className = "roster-item roster-item-selectable";
    item.innerHTML = `
      <input type="checkbox">
      <img alt="${card.name}">
      <div class="name">${card.name}${card.disambiguator ? ` (${card.disambiguator})` : ""}</div>
    `;
    loadCardImage(item.querySelector("img"), card);
    item.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) selected.add(card.id);
      else selected.delete(card.id);
      updateRemoveButton();
    });
    list.appendChild(item);
  }
}

function updateRemoveButton() {
  const btn = document.getElementById("remove-selected-btn");
  btn.disabled = selected.size === 0;
  btn.textContent = selected.size ? `Remove Selected (${selected.size})` : "Remove Selected";
}

document.getElementById("remove-selected-btn").addEventListener("click", async () => {
  if (!confirm(`Remove ${selected.size} student(s) from this deck?`)) return;
  const ids = [...selected];
  await Promise.all(ids.map((id) =>
    apiFetch(`/api/decks/${encodeURIComponent(deckId)}/entries/${id}`, { method: "DELETE" })
  ));
  currentCards = currentCards.filter((c) => !ids.includes(c.id));
  renderCurrentList();
});

document.getElementById("add-search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("add-name-input");
  const query = input.value.trim();
  if (!query) return;

  const resultsEl = document.getElementById("match-results");
  resultsEl.innerHTML = "<p>Searching…</p>";
  const students = await ensureMasterStudents();
  const scored = students
    .map((s) => ({ student: s, score: similarity(query, s.name) }))
    .filter((r) => r.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  renderMatchResults(query, scored);
});

function renderMatchResults(query, scored) {
  const resultsEl = document.getElementById("match-results");
  resultsEl.innerHTML = "";

  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = scored.length
    ? `<p>Closest match${scored.length > 1 ? "es" : ""} for "${query}" — confirm the right one:</p>`
    : `<p>No close matches found for "${query}" in the database.</p>`;

  for (const { student } of scored) {
    const row = document.createElement("div");
    row.className = "match-row";
    row.innerHTML = `<img alt="${student.name}"><span>${student.name}${student.disambiguator ? ` (${student.disambiguator})` : ""}</span>`;
    const img = row.querySelector("img");
    if (student.hasPhoto) fetchPhotoObjectUrl(student.photoUrl).then((url) => { img.src = url; });
    else img.src = PLACEHOLDER_SILHOUETTE_SVG;

    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "This is them";
    confirmBtn.addEventListener("click", () => addEntry(student.name, student.id));
    row.appendChild(confirmBtn);
    card.appendChild(row);
  }

  const addAnywayBtn = document.createElement("button");
  addAnywayBtn.className = "secondary";
  addAnywayBtn.textContent = `Add "${query}" anyway (no match / no photo)`;
  addAnywayBtn.style.marginTop = "6px";
  addAnywayBtn.addEventListener("click", () => addEntry(query, null));
  card.appendChild(addAnywayBtn);

  resultsEl.appendChild(card);
}

async function addEntry(rawName, masterStudentId) {
  const res = await apiFetch(`/api/decks/${encodeURIComponent(deckId)}/entries`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rawName, masterStudentId }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "Could not add student");
    return;
  }
  currentCards.push(data);
  renderCurrentList();
  document.getElementById("add-name-input").value = "";
  document.getElementById("match-results").innerHTML = "";
}

document.getElementById("delete-deck-btn").addEventListener("click", async () => {
  if (!confirm("Delete this entire deck? This cannot be undone.")) return;
  await apiFetch(`/api/decks/${encodeURIComponent(deckId)}`, { method: "DELETE" });
  location.href = "index.html";
});

if (!deckId) {
  document.getElementById("title").textContent = "Deck not found";
} else {
  loadDeck();
}
