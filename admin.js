requireLogin();
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const NEW_COLLECTION_VALUE = "__new__";

(async () => {
  const me = await loadMe();
  document.getElementById("manage-users-link").classList.toggle("hidden", !me.isAdmin);
})();

// ---------- Tabs ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.remove("hidden");
    if (btn.dataset.tab === "add") await fillAddCollectionSelect();
    if (btn.dataset.tab === "manage") { await fillManageCollectionSelect(); await loadManageList(); }
  });
});

// ---------- Collection selects ----------
// Every user has their own independent, dynamic set of collections now (no
// more fixed Period 1-9/Chapel list) — selects are populated from
// GET /api/collections and refreshed whenever a collection may have changed.

async function fillAddCollectionSelect() {
  const select = document.getElementById("add-collection");
  const collections = await loadCollections();
  select.innerHTML =
    collections.map((c) => `<option value="${c.id}">${c.label}</option>`).join("") +
    `<option value="${NEW_COLLECTION_VALUE}">+ New collection...</option>`;
}

async function fillManageCollectionSelect() {
  const select = document.getElementById("manage-collection");
  const collections = await loadCollections();
  select.innerHTML =
    `<option value="all">All Collections</option>` +
    collections.map((c) => `<option value="${c.slug}">${c.label}</option>`).join("");
}

// ---------- Add Student ----------
document.getElementById("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("add-error");
  errorEl.textContent = "";
  const select = document.getElementById("add-collection");

  const form = new FormData();
  form.append("name", document.getElementById("add-name").value);
  if (select.value === NEW_COLLECTION_VALUE) {
    const label = prompt('Name this new collection (e.g. "Period 3", "Freshman", "Female"):');
    if (!label || !label.trim()) return;
    form.append("newCollectionLabel", label.trim());
  } else {
    form.append("collectionId", select.value);
  }
  form.append("photo", document.getElementById("add-photo").files[0]);

  const res = await apiFetch("/api/people", { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) {
    errorEl.textContent = data.error || "Could not add student";
    return;
  }
  document.getElementById("add-form").reset();
  await loadCollections(true);
  await fillAddCollectionSelect();
});

// ---------- Manage Existing ----------
const manageSelect = document.getElementById("manage-collection");
manageSelect.addEventListener("change", loadManageList);

async function loadManageList() {
  const list = document.getElementById("manage-list");
  list.innerHTML = "<p>Loading…</p>";
  const res = await apiFetch(`/api/people?collection=${encodeURIComponent(manageSelect.value)}`);
  const data = await res.json();
  if (data.people.length === 0) {
    list.innerHTML = "<p>No students in this collection.</p>";
    return;
  }
  list.innerHTML = "";
  for (const person of data.people) {
    const item = document.createElement("div");
    item.className = "roster-item";
    item.innerHTML = `<img alt="${person.name}"><div class="name">${person.name}</div><button class="danger">Delete</button>`;
    fetchPhotoObjectUrl(person.photoUrl).then((url) => { item.querySelector("img").src = url; });
    item.querySelector("button").addEventListener("click", async () => {
      if (!confirm(`Delete ${person.name}?`)) return;
      await apiFetch(`/api/people/${person.id}`, { method: "DELETE" });
      loadManageList();
    });
    list.appendChild(item);
  }
}

document.getElementById("rename-collection-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("manage-collection-error");
  errorEl.textContent = "";
  if (manageSelect.value === "all") {
    errorEl.textContent = "Pick a specific collection to rename.";
    return;
  }
  const collections = await loadCollections();
  const current = collections.find((c) => c.slug === manageSelect.value);
  if (!current) return;
  const label = prompt("New name for this collection:", current.label);
  if (!label || !label.trim() || label.trim() === current.label) return;
  const res = await apiFetch(`/api/collections/${current.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: label.trim() }),
  });
  const data = await res.json();
  if (!res.ok) {
    errorEl.textContent = data.error || "Could not rename collection";
    return;
  }
  await loadCollections(true);
  await fillManageCollectionSelect();
  manageSelect.value = current.slug;
  await fillAddCollectionSelect();
});

document.getElementById("delete-collection-btn").addEventListener("click", async () => {
  const errorEl = document.getElementById("manage-collection-error");
  errorEl.textContent = "";
  if (manageSelect.value === "all") {
    errorEl.textContent = "Pick a specific collection to delete.";
    return;
  }
  const collections = await loadCollections();
  const current = collections.find((c) => c.slug === manageSelect.value);
  if (!current) return;
  if (!confirm(`Delete the "${current.label}" collection? This only works if it has no students in it.`)) return;
  const res = await apiFetch(`/api/collections/${current.id}`, { method: "DELETE" });
  const data = await res.json();
  if (!res.ok) {
    errorEl.textContent = data.error || "Could not delete collection";
    return;
  }
  await loadCollections(true);
  await fillManageCollectionSelect();
  await fillAddCollectionSelect();
  loadManageList();
});

(async () => {
  await fillAddCollectionSelect();
  await fillManageCollectionSelect();
  await loadManageList();
})();

// ---------- PDF Import ----------
// Strategy: detect photo/name regions deterministically from pixel data (color
// photos on a white background, separated by whitespace), then only use AI to
// read the small, already-cropped name snippets and (as a last resort) a
// header region with no real text layer. AI is never used to locate anything.
//
// Header field detection is a two-pass, user-confirmed process:
//   1. Scan every page's header text (real text layer; OCR only as a
//      fallback) for every "Label: Value" pair AND every distinct bare text
//      chunk, each kept isolated to its own visual line/column position.
//      This deliberately surfaces MULTIPLE candidate fields per page (e.g.
//      both "Room: 110" and "Pattern: 3") instead of guessing one — an
//      earlier version joined the whole header into one string and ran a
//      single regex over it, which let the match bridge across unrelated
//      columns (e.g. pairing "Room" with the neighboring column's value) and
//      silently merged distinct classes that happened to share a room.
//   2. Show the user every candidate field found, ranked by how well it
//      discriminates between pages, and let them pick which one identifies
//      a group and what to call it. This is the one deliberate prompt in
//      the pipeline — everything else stays automatic.

function slugifyWord(s) {
  return (s || "").toString().toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
}

function toSlug(fieldName, value) {
  return `${slugifyWord(fieldName)}-${slugifyWord(value)}`;
}

function toDisplayLabel(fieldName, value) {
  const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
  if (/^\d+$/.test(value)) {
    return `${titleCase(fieldName)} ${value}`; // "Period" + "3" -> "Period 3"
  }
  return titleCase(value); // "Grade" + "Freshman" -> "Freshman"
}

const LABEL_VALUE_RE = /^([A-Za-z][A-Za-z ]{0,20}):\s*(.+)$/;

// Groups a page's top-of-header text items into visual lines (top to
// bottom) and, within each line, into chunks (left to right) — merging
// items only when they're on the same line and close together horizontally.
// Header fields that share a horizontal band (e.g. class name / room /
// teacher name, all on one row) stay isolated to their own chunk instead of
// bridging into one string, since the gap between columns (~100pt on a
// typical roster) is far larger than the gap between pieces of one field.
async function getHeaderLines(page) {
  const content = await page.getTextContent();
  const viewBox = page.view; // [x0, y0, x1, y1] in PDF points
  const pageHeight = viewBox[3] - viewBox[1];
  const topThreshold = viewBox[1] + pageHeight * 0.78;
  const items = content.items
    .filter((item) => item.transform[5] >= topThreshold && item.str.trim())
    .map((item) => ({ text: item.str, x0: item.transform[4], x1: item.transform[4] + (item.width || 0), y: item.transform[5] }));

  const LINE_TOLERANCE = 3;
  const lines = [];
  for (const item of items) {
    let line = lines.find((l) => Math.abs(l.y - item.y) <= LINE_TOLERANCE);
    if (!line) { line = { y: item.y, items: [] }; lines.push(line); }
    line.items.push(item);
  }
  lines.sort((a, b) => b.y - a.y);

  const GAP_MERGE_THRESHOLD = 20;
  return lines.map((line) => {
    const sorted = [...line.items].sort((a, b) => a.x0 - b.x0);
    const chunks = [];
    for (const item of sorted) {
      const last = chunks[chunks.length - 1];
      if (last && (item.x0 - last.x1) <= GAP_MERGE_THRESHOLD) {
        last.text = (last.text + " " + item.text).replace(/\s+/g, " ").trim();
        last.x1 = item.x1;
      } else {
        chunks.push({ text: item.text.trim(), x0: item.x0, x1: item.x1 });
      }
    }
    return chunks;
  });
}

// Every chunk becomes a candidate field. "Label: Value" chunks are keyed by
// the label text, so the same field aggregates across pages even if its
// exact pixel position drifts slightly. Chunks with no colon (e.g. a class
// name printed with no explicit label) are keyed by line/column position —
// a relative position within THIS page, not an absolute pixel coordinate,
// so small rendering jitter between pages can't split one field into two.
function extractCandidatesFromLines(lines) {
  const candidates = [];
  lines.forEach((lineChunks, lineIndex) => {
    lineChunks.forEach((chunk, colIndex) => {
      if (!chunk.text) return;
      const m = LABEL_VALUE_RE.exec(chunk.text);
      if (m) {
        candidates.push({ kind: "labeled", key: `label:${m[1].trim().toLowerCase()}`, label: m[1].trim(), value: m[2].trim() });
      } else {
        candidates.push({ kind: "bare", key: `pos:${lineIndex}:${colIndex}`, label: null, value: chunk.text });
      }
    });
  });
  return candidates;
}

async function ocrHeaderFallback(canvas) {
  const headerBlob = await cropPixelRect(canvas, { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height * 0.22 });
  const texts = await ocrBatch(
    [{ blob: headerBlob, mediaType: "image/jpeg" }],
    "Read the short classification label printed near the top of this school class roster page — it identifies what group these students belong to (for example a period number, a grade level, or a gender). Respond with the label word and its value separated by a colon, e.g. 'Period: 3' or 'Grade: Freshman'. If no such label is visible, respond with 'NONE'."
  );
  const text = (texts[0] || "").trim();
  if (!text || text.toUpperCase() === "NONE") return [];
  const m = LABEL_VALUE_RE.exec(text);
  return m
    ? [{ kind: "labeled", key: `label:${m[1].trim().toLowerCase()}`, label: m[1].trim(), value: m[2].trim() }]
    : [{ kind: "bare", key: "pos:ocr:0", label: null, value: text }];
}

// Scans every page's header and returns each page's candidate fields.
// Cheap (real text layer) for every page except ones with no text layer at
// all, which fall back to a render + OCR read of the cropped header region.
async function scanHeaderCandidates(pdf, statusEl) {
  const perPage = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const row = document.createElement("div");
    row.className = "import-page-status";
    row.innerHTML = `<span class="spinner"></span> Scanning header on page ${pageNum} of ${pdf.numPages}…`;
    statusEl.appendChild(row);

    const page = await pdf.getPage(pageNum);
    const lines = await getHeaderLines(page);
    let candidates = extractCandidatesFromLines(lines);
    if (candidates.length === 0) {
      const canvas = await renderPageToCanvas(page);
      candidates = await ocrHeaderFallback(canvas);
    }
    perPage.push({ pageNum, candidates });
    row.innerHTML = candidates.length
      ? `✅ Page ${pageNum}: found ${candidates.length} header field(s)`
      : `⚠️ Page ${pageNum}: no header fields detected`;
  }
  return perPage;
}

// Ranks candidate fields by how well they discriminate between pages —
// favoring a different value on nearly every page (like a period number)
// over one that repeats across several pages (like a shared room number),
// which is exactly the distinction that was getting lost before.
function rankCandidates(perPageCandidates, totalPages) {
  const byKey = new Map();
  for (const { pageNum, candidates } of perPageCandidates) {
    for (const c of candidates) {
      if (!byKey.has(c.key)) byKey.set(c.key, { key: c.key, kind: c.kind, label: c.label, valuesByPage: new Map() });
      byKey.get(c.key).valuesByPage.set(pageNum, c.value);
    }
  }
  return [...byKey.values()]
    .map((c) => {
      const distinctValues = new Set(c.valuesByPage.values());
      return { ...c, pagesCovered: c.valuesByPage.size, distinctCount: distinctValues.size, exampleValues: [...distinctValues] };
    })
    .filter((c) => c.pagesCovered >= Math.min(2, totalPages) && (totalPages === 1 || c.distinctCount >= 2))
    .sort((a, b) => {
      if (b.pagesCovered !== a.pagesCovered) return b.pagesCovered - a.pagesCovered;
      const ratioA = a.distinctCount / a.pagesCovered, ratioB = b.distinctCount / b.pagesCovered;
      if (ratioB !== ratioA) return ratioB - ratioA;
      if (a.kind !== b.kind) return a.kind === "labeled" ? -1 : 1;
      return 0;
    });
}

async function renderPageToCanvas(page, targetWidth = 1600) {
  const viewport1 = page.getViewport({ scale: 1 });
  const scale = targetWidth / viewport1.width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas;
}

function cropPixelRect(sourceCanvas, rect) {
  const sw = Math.max(1, rect.x1 - rect.x0);
  const sh = Math.max(1, rect.y1 - rect.y0);
  const out = document.createElement("canvas");
  out.width = Math.round(sw);
  out.height = Math.round(sh);
  out.getContext("2d").drawImage(sourceCanvas, rect.x0, rect.y0, sw, sh, 0, 0, out.width, out.height);
  return new Promise((resolve) => out.toBlob(resolve, "image/jpeg", 0.92));
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function ocrBatch(items, instruction) {
  const images = await Promise.all(
    items.map(async (it) => ({ data: await blobToBase64(it.blob), mediaType: it.mediaType }))
  );
  const res = await apiFetch("/api/import/ocr-batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ images, instruction }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "OCR failed");
  return data.texts;
}

// Connected-component blob detection on non-white pixels. Runs on a
// downscaled copy for speed; returned boxes are scaled back to full-res.
function detectBlobs(canvas) {
  const analysisWidth = 900;
  const scale = Math.min(1, analysisWidth / canvas.width);
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const octx = off.getContext("2d");
  octx.drawImage(canvas, 0, 0, w, h);
  const { data } = octx.getImageData(0, 0, w, h);

  const ink = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    ink[i] = (255 - r) + (255 - g) + (255 - b) > 45 ? 1 : 0;
  }

  // Dilate mostly horizontally so glyphs merge into words/lines and photo
  // noise merges into one blob. Vertical reach is kept to 1px (anti-alias
  // slack only) so the gap between grid rows never bridges — a wider
  // vertical reach was merging whole columns into one tall blob per column.
  const RX = 3;
  const RY = 1;
  const dilated = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let found = 0;
      for (let dy = -RY; dy <= RY && !found; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        const rowBase = yy * w;
        for (let dx = -RX; dx <= RX; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (ink[rowBase + xx]) { found = 1; break; }
        }
      }
      dilated[y * w + x] = found;
    }
  }

  const labels = new Int32Array(w * h).fill(-1);
  const blobs = [];
  const stack = [];
  for (let start = 0; start < w * h; start++) {
    if (!dilated[start] || labels[start] !== -1) continue;
    let minX = w, minY = h, maxX = 0, maxY = 0;
    let sumR = 0, sumG = 0, sumB = 0, inkCount = 0;
    const label = blobs.length;
    labels[start] = label;
    stack.length = 0;
    stack.push(start);
    while (stack.length) {
      const idx = stack.pop();
      const x = idx % w, y = (idx / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (ink[idx]) { sumR += data[idx * 4]; sumG += data[idx * 4 + 1]; sumB += data[idx * 4 + 2]; inkCount++; }
      if (x > 0 && dilated[idx - 1] && labels[idx - 1] === -1) { labels[idx - 1] = label; stack.push(idx - 1); }
      if (x < w - 1 && dilated[idx + 1] && labels[idx + 1] === -1) { labels[idx + 1] = label; stack.push(idx + 1); }
      if (idx - w >= 0 && dilated[idx - w] && labels[idx - w] === -1) { labels[idx - w] = label; stack.push(idx - w); }
      if (idx + w < w * h && dilated[idx + w] && labels[idx + w] === -1) { labels[idx + w] = label; stack.push(idx + w); }
    }
    const avgSat = inkCount ? (Math.max(sumR, sumG, sumB) - Math.min(sumR, sumG, sumB)) / inkCount : 0;
    blobs.push({ minX, minY, maxX, maxY, avgSat });
  }

  const outScale = 1 / scale;
  return blobs
    .map((b) => ({
      x0: b.minX * outScale,
      y0: b.minY * outScale,
      x1: (b.maxX + 1) * outScale,
      y1: (b.maxY + 1) * outScale,
      width: (b.maxX - b.minX + 1) * outScale,
      height: (b.maxY - b.minY + 1) * outScale,
      avgSat: b.avgSat,
    }))
    .filter((b) => b.width >= 6 && b.height >= 6);
}

// Split blobs into "photo" (tall) vs "text line" (short) by finding the
// biggest gap in the sorted height distribution, rather than a fixed pixel
// threshold, so it adapts to whatever render resolution is used.
function classifyBlobs(blobs, pageWidth) {
  const candidates = blobs.filter((b) => b.width < pageWidth * 0.5);
  const heights = candidates.map((b) => b.height).sort((a, b) => b - a);
  let splitIdx = Math.max(1, Math.floor(heights.length / 2));
  let maxGap = -1;
  for (let i = 1; i < heights.length; i++) {
    const gap = heights[i - 1] - heights[i];
    if (gap > maxGap) { maxGap = gap; splitIdx = i; }
  }
  const threshold = heights.length > 1 ? (heights[splitIdx - 1] + heights[splitIdx]) / 2 : (heights[0] || 40) / 2;
  return {
    photos: candidates.filter((b) => b.height >= threshold),
    texts: candidates.filter((b) => b.height < threshold),
  };
}

function pairPhotosWithNames(photos, texts) {
  const usedTexts = new Set();
  return photos.map((photo) => {
    const centerX = (photo.x0 + photo.x1) / 2;
    let best = null, bestGap = Infinity;
    for (const t of texts) {
      if (usedTexts.has(t)) continue;
      const overlap = Math.min(photo.x1, t.x1) - Math.max(photo.x0, t.x0);
      const centered = Math.abs((t.x0 + t.x1) / 2 - centerX) < photo.width * 0.6;
      const gap = t.y0 - photo.y1;
      if ((overlap > 0 || centered) && gap >= -8 && gap < photo.height * 0.6 && gap < bestGap) {
        bestGap = gap;
        best = t;
      }
    }
    if (best) usedTexts.add(best);
    return { photo, name: best };
  });
}

document.getElementById("pdf-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById("import-review").innerHTML = "";
  const statusEl = document.getElementById("page-status");
  statusEl.innerHTML = "";

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const perPageCandidates = await scanHeaderCandidates(pdf, statusEl);
  const ranked = rankCandidates(perPageCandidates, pdf.numPages);

  renderFieldPicker(pdf, perPageCandidates, ranked);
});

function renderFieldPicker(pdf, perPageCandidates, ranked) {
  const container = document.getElementById("import-review");
  container.innerHTML = "";

  const section = document.createElement("div");
  section.className = "card";

  if (ranked.length === 0) {
    section.innerHTML = `
      <h3>Choose what identifies each group</h3>
      <p class="warn">Couldn't automatically detect a repeating header field on these pages. You can still import — every student will need to be assigned to a collection manually afterward from the "Add Student" tab.</p>
      <button id="field-picker-continue">Continue Without Grouping</button>
    `;
    container.appendChild(section);
    document.getElementById("field-picker-continue").addEventListener("click", () => {
      runFullImport(pdf, perPageCandidates, null, null);
    });
    return;
  }

  const optionsHtml = ranked.map((c, i) => {
    const exampleText = c.exampleValues.slice(0, 6).join(", ") + (c.exampleValues.length > 6 ? ", …" : "");
    const coverageNote = c.pagesCovered < pdf.numPages ? ` — found on ${c.pagesCovered} of ${pdf.numPages} pages` : "";
    return `
      <label class="field-picker-option">
        <input type="radio" name="field-picker" value="${i}" ${i === 0 ? "checked" : ""}>
        <span><strong>${c.label || "Unlabeled text"}</strong>${coverageNote}: ${exampleText}</span>
      </label>
    `;
  }).join("");

  section.innerHTML = `
    <h3>Choose what identifies each group</h3>
    <p>These fields were found near the top of your PDF's pages. Pick the one that should split students into collections, then say what to call it.</p>
    <div class="field-picker-options">${optionsHtml}</div>
    <div style="height:10px;"></div>
    <label>Call this field:</label>
    <input type="text" id="field-picker-name" value="${ranked[0].label || ""}" placeholder="e.g. Period, Grade, Gender">
    <div class="error-msg" id="field-picker-error"></div>
    <button id="field-picker-continue" style="margin-top:10px;">Continue Import</button>
  `;
  container.appendChild(section);

  const nameInput = section.querySelector("#field-picker-name");
  section.querySelectorAll('input[name="field-picker"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      const chosen = ranked[Number(radio.value)];
      nameInput.value = chosen.label || "";
    });
  });

  document.getElementById("field-picker-continue").addEventListener("click", () => {
    const selectedIndex = Number(section.querySelector('input[name="field-picker"]:checked').value);
    const fieldName = nameInput.value.trim();
    const errorEl = document.getElementById("field-picker-error");
    if (!fieldName) {
      errorEl.textContent = "Give this field a name before continuing.";
      return;
    }
    runFullImport(pdf, perPageCandidates, ranked[selectedIndex].key, fieldName);
  });
}

async function runFullImport(pdf, perPageCandidates, chosenKey, fieldName) {
  const statusEl = document.getElementById("page-status");
  statusEl.innerHTML = "";
  document.getElementById("import-review").innerHTML = "";

  const candidatesByPage = new Map(perPageCandidates.map((p) => [p.pageNum, p.candidates]));
  const groups = {}; // key (slug, or "__unrecognized__") -> {slug, label, students: [{name, blob}]}
  const missing = []; // {page} — photo detected but name couldn't be read

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const row = document.createElement("div");
    row.className = "import-page-status";
    row.innerHTML = `<span class="spinner"></span> Reading page ${pageNum} of ${pdf.numPages}…`;
    statusEl.appendChild(row);

    try {
      const page = await pdf.getPage(pageNum);
      const canvas = await renderPageToCanvas(page);

      let slug = null, displayLabel = "Unrecognized";
      if (chosenKey) {
        const match = (candidatesByPage.get(pageNum) || []).find((c) => c.key === chosenKey);
        if (match) {
          slug = toSlug(fieldName, match.value);
          displayLabel = toDisplayLabel(fieldName, match.value);
        }
      }
      const key = slug || "__unrecognized__";

      const blobs = detectBlobs(canvas);
      const { photos, texts } = classifyBlobs(blobs, canvas.width);
      const pairs = pairPhotosWithNames(photos, texts)
        .sort((a, b) => (a.photo.y0 - b.photo.y0) || (a.photo.x0 - b.photo.x0));

      if (photos.length === 0) {
        row.innerHTML = `⚠️ Page ${pageNum}: no photos detected — skipped`;
        continue;
      }

      const photoBlobs = await Promise.all(pairs.map((p) => cropPixelRect(canvas, p.photo)));
      const nameCrops = await Promise.all(
        pairs.map((p) => (p.name ? cropPixelRect(canvas, p.name).then((blob) => ({ blob, mediaType: "image/jpeg" })) : null))
      );

      const names = new Array(pairs.length).fill("");
      const toOcr = nameCrops.filter(Boolean);
      if (toOcr.length) {
        const results = await ocrBatch(
          toOcr,
          "Each image contains exactly one student's name printed below a photo on a school class roster, in 'Last, First' format. Read and return the exact printed text of each image, in order."
        );
        let oi = 0;
        for (let i = 0; i < nameCrops.length; i++) {
          if (nameCrops[i]) { names[i] = (results[oi] || "").trim(); oi++; }
        }
      }

      groups[key] = groups[key] || { slug, label: displayLabel, students: [] };
      let found = 0;
      for (let i = 0; i < pairs.length; i++) {
        if (names[i]) {
          groups[key].students.push({ name: names[i], blob: photoBlobs[i] });
          found++;
        } else {
          missing.push({ page: pageNum });
        }
      }
      row.innerHTML = slug
        ? `✅ Page ${pageNum}: ${displayLabel} — ${found} of ${pairs.length} student(s) matched`
        : `⚠️ Page ${pageNum}: no value found for the chosen field — ${found} of ${pairs.length} student(s) matched, added to "Unrecognized"`;
    } catch (err) {
      row.innerHTML = `❌ Page ${pageNum}: ${err.message}`;
    }
  }

  await renderImportReview(groups, missing);
}

async function renderImportReview(groups, missing) {
  const container = document.getElementById("import-review");
  container.innerHTML = "";

  const collections = await loadCollections(true);

  for (const group of Object.values(groups)) {
    const section = document.createElement("div");
    section.className = "import-group card";

    const exactMatch = group.slug ? collections.find((c) => c.slug === group.slug) : null;
    const isUnrecognized = !group.slug;

    const optionsHtml =
      `<option value="${NEW_COLLECTION_VALUE}">+ Create new collection</option>` +
      collections.map((c) =>
        `<option value="${c.id}" ${exactMatch && exactMatch.id === c.id ? "selected" : ""}>${c.label}</option>`
      ).join("");

    const thumbs = group.students.map((s) => {
      const url = URL.createObjectURL(s.blob);
      return `<div class="roster-item"><img src="${url}" alt="${s.name}"><div class="name">${s.name}</div></div>`;
    }).join("");

    section.innerHTML = `
      <div class="import-group-header">
        <input type="text" class="import-group-label" placeholder="Name this collection"
          value="${isUnrecognized ? "" : group.label}" ${exactMatch ? "disabled" : ""}>
        <select class="import-group-select">${optionsHtml}</select>
      </div>
      <p class="warn">${isUnrecognized
        ? `${group.students.length} student(s) found but no grouping label could be detected for their page(s). Pick an existing collection above, or name a new one, before saving.`
        : `Saving will replace the entire "${group.label}" collection with these ${group.students.length} students. Check the crops below before saving.`
      }</p>
      <div class="roster-list">${thumbs}</div>
      <button class="save-group-btn" style="margin-top:14px;">Save &amp; Replace</button>
      <span class="save-status" style="margin-left:10px;"></span>
    `;

    const labelInput = section.querySelector(".import-group-label");
    const select = section.querySelector(".import-group-select");
    const saveBtn = section.querySelector(".save-group-btn");
    if (!exactMatch) select.value = NEW_COLLECTION_VALUE;

    function syncEnabled() {
      const usingNew = select.value === NEW_COLLECTION_VALUE;
      labelInput.disabled = !usingNew;
      saveBtn.disabled = usingNew && !labelInput.value.trim();
    }
    select.addEventListener("change", syncEnabled);
    labelInput.addEventListener("input", syncEnabled);
    syncEnabled();

    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      const statusSpan = section.querySelector(".save-status");
      statusSpan.textContent = "Saving…";
      const form = new FormData();
      if (select.value === NEW_COLLECTION_VALUE) {
        form.append("newCollectionLabel", labelInput.value.trim());
      } else {
        form.append("collectionId", select.value);
      }
      for (const s of group.students) {
        form.append("name", s.name);
        form.append("photo", s.blob, "photo.jpg");
      }
      const res = await apiFetch("/api/import/replace-collection", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        statusSpan.textContent = data.error || "Failed to save";
        saveBtn.disabled = false;
        return;
      }
      statusSpan.textContent = `Saved ${data.count} students.`;
      await loadCollections(true);
    });

    container.appendChild(section);
  }

  if (missing.length) {
    const div = document.createElement("div");
    div.className = "card";
    div.innerHTML = `<h3>Photos found without a readable name</h3><p class="warn">${missing.length} photo(s) across page(s) ${[...new Set(missing.map((m) => m.page))].join(", ")} couldn't be paired with a name automatically. Add those students manually from the "Add Student" tab.</p>`;
    container.appendChild(div);
  }
}
