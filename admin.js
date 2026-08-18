requireLogin();
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ---------- Tabs ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.remove("hidden");
  });
});

function fillCollectionSelect(select, includeAll) {
  select.innerHTML =
    (includeAll ? `<option value="all">All Collections</option>` : "") +
    COLLECTIONS.map((c) => `<option value="${c.id}">${c.label}</option>`).join("");
}
fillCollectionSelect(document.getElementById("add-collection"), false);
fillCollectionSelect(document.getElementById("manage-collection"), true);

// ---------- Add Student ----------
document.getElementById("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("add-error");
  errorEl.textContent = "";
  const form = new FormData();
  form.append("name", document.getElementById("add-name").value);
  form.append("collection", document.getElementById("add-collection").value);
  form.append("photo", document.getElementById("add-photo").files[0]);
  const res = await apiFetch("/api/people", { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) {
    errorEl.textContent = data.error || "Could not add student";
    return;
  }
  document.getElementById("add-form").reset();
  fillCollectionSelect(document.getElementById("add-collection"), false);
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
loadManageList();

// ---------- PDF Import ----------
// Strategy: detect photo/name regions deterministically from pixel data (color
// photos on a white background, separated by whitespace), then only use AI to
// read the small, already-cropped name snippets and the "Pattern:" header if
// it isn't present as real PDF text. AI is never used to locate anything.

function patternToCollection(pattern) {
  if (!pattern) return null;
  const p = pattern.toString().trim().toLowerCase();
  if (p === "chapel") return "chapel";
  const n = parseInt(p, 10);
  if (n >= 1 && n <= 9) return `period-${n}`;
  return null;
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

async function extractPattern(page, canvas) {
  const content = await page.getTextContent();
  const fullText = content.items.map((i) => i.str).join(" ");
  const match = fullText.match(/Pattern:\s*([A-Za-z0-9]+)/i);
  if (match) return match[1];

  const headerBlob = await cropPixelRect(canvas, { x0: 0, y0: 0, x1: canvas.width, y1: canvas.height * 0.22 });
  const texts = await ocrBatch(
    [{ blob: headerBlob, mediaType: "image/jpeg" }],
    "This is the header area of a school class roster page. Find the label 'Pattern:' and return only the short value printed after it (a single digit 1-9, or the word 'chapel'). Return an empty string if you cannot find it."
  );
  return (texts[0] || "").trim() || null;
}

document.getElementById("pdf-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById("import-review").innerHTML = "";
  const statusEl = document.getElementById("page-status");
  statusEl.innerHTML = "";

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const groups = {}; // collection -> [{name, blob}]
  const missing = []; // {page} — photo detected but name couldn't be read
  const unmapped = []; // {page, pattern}

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const row = document.createElement("div");
    row.className = "import-page-status";
    row.innerHTML = `<span class="spinner"></span> Reading page ${pageNum} of ${pdf.numPages}…`;
    statusEl.appendChild(row);

    try {
      const page = await pdf.getPage(pageNum);
      const canvas = await renderPageToCanvas(page);

      const pattern = await extractPattern(page, canvas);
      const collection = patternToCollection(pattern);

      const blobs = detectBlobs(canvas);
      const { photos, texts } = classifyBlobs(blobs, canvas.width);
      const pairs = pairPhotosWithNames(photos, texts)
        .sort((a, b) => (a.photo.y0 - b.photo.y0) || (a.photo.x0 - b.photo.x0));

      if (photos.length === 0) {
        row.innerHTML = `⚠️ Page ${pageNum}: no photos detected — skipped`;
        continue;
      }
      if (!collection) {
        unmapped.push({ page: pageNum, pattern });
        row.innerHTML = `⚠️ Page ${pageNum}: could not determine period/chapel (found "${pattern || ""}") — skipped`;
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

      groups[collection] = groups[collection] || [];
      let found = 0;
      for (let i = 0; i < pairs.length; i++) {
        if (names[i]) {
          groups[collection].push({ name: names[i], blob: photoBlobs[i] });
          found++;
        } else {
          missing.push({ page: pageNum });
        }
      }
      row.innerHTML = `✅ Page ${pageNum}: ${collectionLabel(collection)} — ${found} of ${pairs.length} student(s) matched`;
    } catch (err) {
      row.innerHTML = `❌ Page ${pageNum}: ${err.message}`;
    }
  }

  renderImportReview(groups, missing, unmapped);
});

function renderImportReview(groups, missing, unmapped) {
  const container = document.getElementById("import-review");
  container.innerHTML = "";

  if (unmapped.length) {
    const div = document.createElement("div");
    div.className = "card";
    div.innerHTML = `<p class="warn">Some pages couldn't be matched to a period/chapel and were skipped: ${unmapped.map((u) => `page ${u.page}`).join(", ")}.</p>`;
    container.appendChild(div);
  }

  for (const [collection, students] of Object.entries(groups)) {
    const section = document.createElement("div");
    section.className = "import-group card";
    const thumbs = students.map((s) => {
      const url = URL.createObjectURL(s.blob);
      return `<div class="roster-item"><img src="${url}" alt="${s.name}"><div class="name">${s.name}</div></div>`;
    }).join("");
    section.innerHTML = `
      <h3>${collectionLabel(collection)} — ${students.length} student(s) found</h3>
      <p class="warn">Saving will replace the entire "${collectionLabel(collection)}" collection with these ${students.length} students. Check the crops below before saving.</p>
      <div class="roster-list">${thumbs}</div>
      <button class="save-group-btn" style="margin-top:14px;">Save &amp; Replace ${collectionLabel(collection)}</button>
      <span class="save-status" style="margin-left:10px;"></span>
    `;
    section.querySelector(".save-group-btn").addEventListener("click", async (e) => {
      e.target.disabled = true;
      const statusSpan = section.querySelector(".save-status");
      statusSpan.textContent = "Saving…";
      const form = new FormData();
      form.append("collection", collection);
      for (const s of students) {
        form.append("name", s.name);
        form.append("photo", s.blob, "photo.jpg");
      }
      const res = await apiFetch("/api/import/replace-collection", { method: "POST", body: form });
      const data = await res.json();
      statusSpan.textContent = res.ok ? `Saved ${data.count} students.` : (data.error || "Failed to save");
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
