requireLogin();

const params = new URLSearchParams(location.search);
const deckId = params.get("d");

let currentCards = [];
let currentLabel = "";
const selected = new Set();

// normalizeNameKey/levenshtein/similarity and loadMasterStudents() now live
// in app.js, shared with deck-builder.js and the home-page search.

async function loadDeck() {
  const res = await apiFetch(`/api/decks/${encodeURIComponent(deckId)}/cards`);
  if (!res.ok) {
    document.getElementById("title").textContent = "Deck not found";
    return;
  }
  const data = await res.json();
  currentLabel = data.label;
  document.getElementById("title").textContent = `Edit "${data.label}"`;
  document.getElementById("rename-input").value = data.label;
  currentCards = data.cards;
  renderCurrentList();
}

document.getElementById("rename-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("rename-error");
  errorEl.textContent = "";
  const newLabel = document.getElementById("rename-input").value.trim();
  if (!newLabel || newLabel === currentLabel) return;
  const res = await apiFetch(`/api/decks/${encodeURIComponent(deckId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: newLabel }),
  });
  const data = await res.json();
  if (!res.ok) {
    errorEl.textContent = data.error || "Could not rename deck";
    return;
  }
  currentLabel = newLabel;
  document.getElementById("title").textContent = `Edit "${newLabel}"`;
});

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
  const students = await loadMasterStudents();
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
