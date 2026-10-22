requireLogin();
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// normalizeNameKey now lives in app.js (shared with deck-edit.js, admin.js,
// and the home-page search) — do not redefine it here.

// Groups a page's text items into visual lines (top to bottom, left to
// right within a line) — the same idea as the header line-grouping used
// during master import, just applied across the whole page instead of just
// the top band, since a name list has no "header region" to restrict to.
async function extractLinesFromPage(page) {
  const content = await page.getTextContent();
  const items = content.items.filter((i) => i.str.trim())
    .map((i) => ({ text: i.str, x: i.transform[4], y: i.transform[5] }));
  const LINE_TOLERANCE = 3;
  const lines = [];
  for (const item of items) {
    let line = lines.find((l) => Math.abs(l.y - item.y) <= LINE_TOLERANCE);
    if (!line) { line = { y: item.y, items: [] }; lines.push(line); }
    line.items.push(item);
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map((l) =>
    l.items.sort((a, b) => a.x - b.x).map((i) => i.text).join(" ").replace(/\s+/g, " ").trim()
  );
}

async function extractAllLines(pdf) {
  const allLines = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    allLines.push(...(await extractLinesFromPage(page)));
  }
  return allLines.filter(Boolean);
}

function buildNameIndex(masterStudents) {
  const byKey = new Map();
  for (const s of masterStudents) {
    const key = normalizeNameKey(s.name);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(s);
  }
  // Longest keys first, so a longer name is matched before a shorter one
  // that happens to be a substring of it.
  const sortedKeys = [...byKey.keys()].sort((a, b) => b.length - a.length);
  return { byKey, sortedKeys };
}

// A line that isn't a known name at all still gets a best-effort name-shaped
// extraction purely so the "not found" list has something readable to show
// — never used for matching. Report-header words are excluded since a line
// like "Student ID (System) LastName, FirstName Status Grade Level" would
// otherwise spuriously "extract" the literal column headers as a name.
const FALLBACK_NAME_RE = /([A-Z][A-Za-z'’.-]{1,30}),\s*([A-Z][A-Za-z'’.-]{1,30})/;
const HEADER_WORDS = new Set(["lastname", "firstname", "name", "status", "grade", "level", "student"]);

// Matches a line against the KNOWN master name list by substring, rather
// than trying to regex-extract an unknown name's boundaries — deliberately,
// since a real sample list showed wide report columns collapsing to single
// spaces once text items are joined, making a genuine two-word first name
// (e.g. "Bahr, Hunter Shockley") indistinguishable from a name plus an
// accidentally-absorbed trailing "Status"/"Grade" column word under any
// regex that allows an optional extra word. Searching for names we already
// know sidesteps that ambiguity entirely.
function matchLine(line, index) {
  const normalized = normalizeNameKey(line);
  for (const key of index.sortedKeys) {
    if (key.length < 3) continue;
    if (normalized.includes(key)) {
      return { rawLine: line, candidates: index.byKey.get(key) };
    }
  }
  const fallback = FALLBACK_NAME_RE.exec(line);
  if (fallback) {
    const w1 = fallback[1].toLowerCase(), w2 = fallback[2].toLowerCase();
    if (!HEADER_WORDS.has(w1) && !HEADER_WORDS.has(w2)) {
      return { rawLine: line, candidates: [], fallbackName: `${fallback[1]}, ${fallback[2]}` };
    }
  }
  return { rawLine: line, candidates: [], fallbackName: null };
}

// fuzzyMatchLine (a "did you mean" check for a line that didn't exactly
// match any known master name) now lives in app.js, shared with
// deck-edit.js's "Check Database for Updates". This catches a real case the
// exact-substring match above can't: a master record with MORE text than
// the teacher's list has (e.g. a stored "Thomas, Noah Daniel" vs a list
// entry of just "Thomas, Noah" — the roster line doesn't contain the master
// name as a substring, so matchLine reports no match, even though it's
// almost certainly the same student already in the database).

document.getElementById("list-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const errorEl = document.getElementById("build-error");
  errorEl.textContent = "";
  const label = document.getElementById("deck-label").value.trim();
  if (!label) {
    errorEl.textContent = "Give this deck a name first.";
    e.target.value = "";
    return;
  }

  const statusEl = document.getElementById("build-status");
  statusEl.textContent = "Reading list…";
  document.getElementById("match-review").innerHTML = "";

  const [studentsRes, arrayBuffer] = await Promise.all([
    apiFetch("/api/master/students"),
    file.arrayBuffer(),
  ]);
  const { students: masterStudents } = await studentsRes.json();
  const index = buildNameIndex(masterStudents);

  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const lines = await extractAllLines(pdf);

  const matches = lines
    .map((line) => matchLine(line, index))
    .filter((m) => m.candidates.length > 0 || m.fallbackName)
    .map((m) => m.candidates.length === 0
      ? { ...m, fuzzyCandidates: fuzzyMatchLine(m.fallbackName, masterStudents) }
      : m);

  statusEl.textContent = `Found ${matches.length} name(s) in the list.`;
  renderMatchReview(matches, label);
});

function renderMatchReview(matches, label) {
  const container = document.getElementById("match-review");
  container.innerHTML = "";

  const resolved = matches.map((m) => ({
    rawName: m.candidates.length > 0 ? m.candidates[0].name : (m.fallbackName || m.rawLine),
    candidates: m.candidates,
    fuzzyCandidates: m.fuzzyCandidates || [],
    chosenId: m.candidates.length === 1 ? m.candidates[0].id : null,
  }));

  const autoCount = resolved.filter((r) => r.candidates.length === 1).length;
  const ambiguous = resolved.filter((r) => r.candidates.length > 1);
  const notFound = resolved.filter((r) => r.candidates.length === 0);
  // Split "not found" into ones with a plausible existing student to check
  // against vs. ones with genuinely nothing similar — only the former get
  // the "did you mean" picker; the rest fall straight to the plain list.
  const notFoundWithSuggestions = notFound.filter((r) => r.fuzzyCandidates.length > 0);
  const notFoundNoSuggestions = notFound.filter((r) => r.fuzzyCandidates.length === 0);

  const summary = document.createElement("div");
  summary.className = "card";
  summary.innerHTML = `<h3>Review before creating "${label}"</h3>
    <p>${autoCount} student(s) matched automatically.` +
    (ambiguous.length ? ` ${ambiguous.length} need you to pick which student they mean.` : "") +
    (notFoundWithSuggestions.length ? ` ${notFoundWithSuggestions.length} weren't matched automatically but may already be in the database under a slightly different name — check these before creating new entries for them.` : "") +
    (notFoundNoSuggestions.length ? ` ${notFoundNoSuggestions.length} weren't found in the database at all.` : "") +
    `</p>`;
  container.appendChild(summary);

  const confirmBtn = document.createElement("button");
  confirmBtn.textContent = `Create "${label}"`;
  confirmBtn.style.marginTop = "10px";

  function checkReady() {
    confirmBtn.disabled = ambiguous.some((r) => !r.chosenId);
  }

  if (ambiguous.length) {
    const ambiguousCard = document.createElement("div");
    ambiguousCard.className = "card";
    ambiguousCard.innerHTML = "<h3>Pick who these are</h3><p>This name matches more than one student in the database — pick the right one for each.</p>";
    ambiguous.forEach((r, ri) => {
      const block = document.createElement("div");
      block.className = "duplicate-group";
      const options = r.candidates.map((c) => `
        <label class="match-option">
          <input type="radio" name="pick-${ri}" value="${c.id}">
          <img data-photo="${c.hasPhoto ? c.photoUrl : ""}" alt="${c.name}">
          <span>${studentDisplayName(c)}</span>
        </label>
      `).join("");
      block.innerHTML = `<h4>${r.candidates[0].name}</h4><div class="match-options">${options}</div>`;
      ambiguousCard.appendChild(block);

      block.querySelectorAll("img").forEach((img) => {
        const photoUrl = img.dataset.photo;
        if (photoUrl) fetchPhotoObjectUrl(photoUrl).then((url) => { img.src = url; });
        else img.src = PLACEHOLDER_SILHOUETTE_SVG;
      });
      block.querySelectorAll('input[type="radio"]').forEach((radio) => {
        radio.addEventListener("change", () => {
          r.chosenId = radio.value;
          checkReady();
        });
      });
    });
    container.appendChild(ambiguousCard);
  }

  if (notFoundWithSuggestions.length) {
    const suggestCard = document.createElement("div");
    suggestCard.className = "card";
    suggestCard.innerHTML = "<h3>Check these before adding as new</h3><p>Not matched automatically, but the database has student(s) with a similar name — confirm if one of these is actually the same person before it gets added as an unmatched entry.</p>";
    notFoundWithSuggestions.forEach((r, ri) => {
      const block = document.createElement("div");
      block.className = "duplicate-group";
      const options = r.fuzzyCandidates.map((c) => `
        <label class="match-option">
          <input type="radio" name="fuzzy-${ri}" value="${c.id}">
          <img data-photo="${c.hasPhoto ? c.photoUrl : ""}" alt="${c.name}">
          <span>${studentDisplayName(c)}</span>
        </label>
      `).join("") + `
        <label class="match-option">
          <input type="radio" name="fuzzy-${ri}" value="" checked>
          <span>None of these — add "${r.rawName}" as a new, unmatched entry</span>
        </label>
      `;
      block.innerHTML = `<h4>${r.rawName}</h4><div class="match-options">${options}</div>`;
      suggestCard.appendChild(block);

      block.querySelectorAll("img").forEach((img) => {
        const photoUrl = img.dataset.photo;
        if (photoUrl) fetchPhotoObjectUrl(photoUrl).then((url) => { img.src = url; });
        else img.src = PLACEHOLDER_SILHOUETTE_SVG;
      });
      block.querySelectorAll('input[type="radio"]').forEach((radio) => {
        radio.addEventListener("change", () => {
          r.chosenId = radio.value || null;
        });
      });
    });
    container.appendChild(suggestCard);
  }

  if (notFoundNoSuggestions.length) {
    const notFoundCard = document.createElement("div");
    notFoundCard.className = "card";
    notFoundCard.innerHTML = `<h3>Not found in the database</h3>
      <p class="warn">These will still be added to the deck (shown with a placeholder photo) — double check the spelling, or ask the admin to add them.</p>
      <ul>${notFoundNoSuggestions.map((r) => `<li>${r.rawName}</li>`).join("")}</ul>`;
    container.appendChild(notFoundCard);
  }

  checkReady();
  confirmBtn.addEventListener("click", async () => {
    confirmBtn.disabled = true;
    const entries = resolved.map((r) => ({
      rawName: r.rawName,
      masterStudentId: r.candidates.length === 1 ? r.candidates[0].id : (r.chosenId || null),
    }));
    const res = await apiFetch("/api/decks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, entries }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Could not create deck");
      confirmBtn.disabled = false;
      return;
    }
    location.href = `deck.html?d=${data.id}`;
  });
  container.appendChild(confirmBtn);
}
