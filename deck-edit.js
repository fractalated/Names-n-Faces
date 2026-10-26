requireLogin();

const params = new URLSearchParams(location.search);
const deckId = params.get("d");

let currentCards = [];
let currentLabel = "";
const selected = new Set();
// entryId -> {item, selectLabel} — lets "Check Database for Updates" attach
// a suggestion box to the right roster cell without a full re-render (which
// would wipe out any other suggestion boxes still awaiting review).
let itemElsById = new Map();

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
  itemElsById = new Map();
  document.getElementById("check-updates-results").innerHTML = "";
  document.getElementById("check-updates-status").textContent = "";
  if (currentCards.length === 0) {
    list.innerHTML = "<p>No students in this deck yet.</p>";
    return;
  }
  list.innerHTML = "";
  for (const card of currentCards) {
    // A plain wrapper div, not a <label>, so it stays one grid cell in the
    // roster-list grid: the checkbox/select behavior lives on an inner
    // <label>, leaving room to append the Add Photo control (a button +
    // file input) as a sibling inside the same cell without it either
    // triggering the checkbox or landing in its own misaligned grid cell.
    const item = document.createElement("div");
    item.className = "roster-item";
    const selectLabel = document.createElement("label");
    selectLabel.className = "roster-item-selectable";
    selectLabel.innerHTML = `
      <input type="checkbox">
      <img alt="${escapeHtml(card.name)}">
      <div class="name">${escapeHtml(studentDisplayName(card))}</div>
    `;
    item.appendChild(selectLabel);
    loadCardImage(selectLabel.querySelector("img"), card);
    selectLabel.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) selected.add(card.id);
      else selected.delete(card.id);
      updateRemoveButton();
    });
    // Deck editing is a natural place to notice a gap while scanning the
    // whole roster — same masterStudentId-gated Add Photo control as
    // deck.html/deck-view.html/missing-photos.html.
    if (!card.hasPhoto && card.masterStudentId) {
      renderAddPhotoControl(item, card.masterStudentId, () => {
        card.hasPhoto = true;
        loadCardImage(selectLabel.querySelector("img"), { hasPhoto: true, photoUrl: `/api/master/photo/${card.masterStudentId}` });
      });
    }
    itemElsById.set(card.id, { item, selectLabel });
    list.appendChild(item);
  }
}

// A deck entry's master_student_id is set once, at deck-build time, and
// never touched again — so it goes stale in two ways that never self-heal:
// a line the deck-builder's matching missed back then, or a master row that
// was later deleted/replaced (an annual re-import reissues fresh ids to
// everyone). Either way the card shows here with no masterStudentId and no
// Add Photo control, and it won't show up on missing-photos.html either,
// since that page only lists rows that currently exist in master_students.
// This re-runs the same "did you mean" fuzzy check the deck-builder itself
// uses (fuzzyMatchLine in app.js) against the CURRENT roster, for every
// entry still missing a masterStudentId — never auto-binding, exactly like
// every other fuzzy-match surface in this app; the teacher always confirms.
document.getElementById("check-updates-btn").addEventListener("click", async () => {
  const btn = document.getElementById("check-updates-btn");
  const statusEl = document.getElementById("check-updates-status");
  btn.disabled = true;
  statusEl.textContent = "Checking against the database…";
  const students = await loadMasterStudents();
  let suggested = 0, stillUnmatched = 0;
  for (const card of currentCards) {
    if (card.masterStudentId) continue;
    const candidates = fuzzyMatchLine(card.name, students);
    if (candidates.length === 0) {
      stillUnmatched++;
      continue;
    }
    suggested++;
    renderSuggestion(card, candidates);
  }
  statusEl.textContent = suggested
    ? `Found ${suggested} possible match${suggested === 1 ? "" : "es"} to review below. ${stillUnmatched} student(s) still not found in the database.`
    : `No updates found. ${stillUnmatched} student(s) still not found in the database.`;
  btn.disabled = false;
});

// Rendered into #check-updates-results (a normal-width card area above the
// narrow roster-item photo grid), not inline inside the roster cell itself
// — a roster-item is only ~130px wide (see .roster-list in style.css), and
// a full match-row (photo + name + button) doesn't fit: an earlier version
// appended it there directly and it overflowed under the next grid cell,
// which silently swallowed clicks on the button sitting underneath it.
function renderSuggestion(card, candidates) {
  const results = document.getElementById("check-updates-results");
  const old = results.querySelector(`[data-entry-id="${card.id}"]`);
  if (old) old.remove();

  const box = document.createElement("div");
  box.className = "card";
  box.dataset.entryId = card.id;
  const label = document.createElement("p");
  label.style.margin = "0 0 8px";
  label.innerHTML = `Possible match for <strong>${escapeHtml(card.name)}</strong> — is this the same student?`;
  box.appendChild(label);

  for (const student of candidates) {
    const row = document.createElement("div");
    row.className = "match-row";
    row.innerHTML = `<img alt="${escapeHtml(student.name)}"><span>${escapeHtml(studentDisplayName(student))}</span>`;
    const img = row.querySelector("img");
    if (student.hasPhoto) fetchPhotoObjectUrl(student.photoUrl).then((url) => { img.src = url; });
    else img.src = PLACEHOLDER_SILHOUETTE_SVG;
    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "This is them";
    confirmBtn.addEventListener("click", () => bindEntry(card, student, box));
    row.appendChild(confirmBtn);
    box.appendChild(row);
  }

  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "secondary";
  dismissBtn.textContent = "Not a match";
  dismissBtn.addEventListener("click", () => box.remove());
  box.appendChild(dismissBtn);

  results.appendChild(box);
}

async function bindEntry(card, student, box) {
  const res = await apiFetch(`/api/decks/${encodeURIComponent(deckId)}/entries/${encodeURIComponent(card.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ masterStudentId: student.id }),
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || "Could not update this student");
    return;
  }
  card.name = data.name;
  card.disambiguator = data.disambiguator;
  card.grade = data.grade;
  card.hasPhoto = data.hasPhoto;
  card.photoUrl = data.photoUrl;
  card.masterStudentId = data.masterStudentId;
  box.remove();

  const entry = itemElsById.get(card.id);
  if (!entry) return;
  const img = entry.selectLabel.querySelector("img");
  img.alt = card.name;
  loadCardImage(img, card);
  entry.selectLabel.querySelector(".name").textContent = studentDisplayName(card);
  if (!card.hasPhoto && card.masterStudentId) {
    renderAddPhotoControl(entry.item, card.masterStudentId, () => {
      card.hasPhoto = true;
      loadCardImage(img, { hasPhoto: true, photoUrl: `/api/master/photo/${card.masterStudentId}` });
    });
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
  const firstQuery = document.getElementById("add-first-name").value.trim();
  const lastQuery = document.getElementById("add-last-name").value.trim();
  const errorEl = document.getElementById("add-search-error");
  errorEl.textContent = "";
  if (!firstQuery && !lastQuery) {
    errorEl.textContent = "Enter a first or last name to search.";
    return;
  }

  const resultsEl = document.getElementById("match-results");
  resultsEl.innerHTML = "<p>Searching…</p>";
  const students = await loadMasterStudents();
  // matchStudentsByName (app.js) scores first/last independently — order-
  // independent, tight on last name, broad on first (nicknames/typos).
  const scored = matchStudentsByName(students, { firstQuery, lastQuery });
  const queryLabel = [firstQuery, lastQuery].filter(Boolean).join(" ");

  renderMatchResults(queryLabel, scored);
});

// Shows results a page at a time with a "Show More" button rather than a
// hard cap — a broad first-name search can legitimately match many
// students (nicknames especially), and silently truncating risks hiding
// the one the user actually wanted.
const MATCH_PAGE_SIZE = 10;

function renderMatchResults(query, scored) {
  const resultsEl = document.getElementById("match-results");
  resultsEl.innerHTML = "";

  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = scored.length
    ? `<p>${scored.length} possible match${scored.length === 1 ? "" : "es"} for "${escapeHtml(query)}" — confirm the right one:</p>`
    : `<p>No close matches found for "${escapeHtml(query)}" in the database.</p>`;
  resultsEl.appendChild(card);

  const rows = document.createElement("div");
  card.appendChild(rows);

  const showMoreBtn = document.createElement("button");
  showMoreBtn.type = "button";
  showMoreBtn.className = "secondary hidden";
  showMoreBtn.style.marginTop = "6px";
  card.appendChild(showMoreBtn);

  let shown = 0;
  function showNextPage() {
    for (const { student } of scored.slice(shown, shown + MATCH_PAGE_SIZE)) {
      const row = document.createElement("div");
      row.className = "match-row";
      row.innerHTML = `<img alt="${escapeHtml(student.name)}"><span>${escapeHtml(studentDisplayName(student))}</span>`;
      const img = row.querySelector("img");
      if (student.hasPhoto) fetchPhotoObjectUrl(student.photoUrl).then((url) => { img.src = url; });
      else img.src = PLACEHOLDER_SILHOUETTE_SVG;

      const confirmBtn = document.createElement("button");
      confirmBtn.textContent = "This is them";
      confirmBtn.addEventListener("click", () => addEntry(student.name, student.id));
      row.appendChild(confirmBtn);
      rows.appendChild(row);
    }
    shown = Math.min(shown + MATCH_PAGE_SIZE, scored.length);
    const remaining = scored.length - shown;
    showMoreBtn.textContent = `Show More (${remaining} more)`;
    showMoreBtn.classList.toggle("hidden", remaining <= 0);
  }
  showMoreBtn.addEventListener("click", showNextPage);
  showNextPage();

  const addAnywayBtn = document.createElement("button");
  addAnywayBtn.className = "secondary";
  addAnywayBtn.textContent = `Add "${query}" anyway (no match / no photo)`;
  addAnywayBtn.style.marginTop = "6px";
  addAnywayBtn.addEventListener("click", () => addEntry(query, null));
  card.appendChild(addAnywayBtn);
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
  document.getElementById("add-first-name").value = "";
  document.getElementById("add-last-name").value = "";
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
