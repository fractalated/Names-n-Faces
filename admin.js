requireLogin();
pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

(async () => {
  const me = await loadMe();
  if (!me.isAdmin) {
    location.href = "index.html";
  }
})();

// ---------- Tabs ----------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.remove("hidden");
    if (btn.dataset.tab === "manage") await loadManageList();
  });
});

// normalizeNameKey and cropToSquare now live in app.js (shared with
// deck-edit.js, deck-builder.js, and the home-page search) — do not
// redefine them here.

// ---------- Add Student ----------

async function showAddDuplicatePrompt(candidates, name) {
  return new Promise((resolve) => {
    const container = document.getElementById("add-duplicate-resolver");
    container.innerHTML = "";
    const card = document.createElement("div");
    card.className = "card";
    const thumbs = candidates.map((c, i) => `
      <div class="roster-item">
        <img alt="${c.name}" data-idx="${i}">
        <div class="name">${c.name}${c.disambiguator ? ` (${c.disambiguator})` : ""}</div>
      </div>
    `).join("");
    card.innerHTML = `
      <p class="warn">"${name}" already exists in the database:</p>
      <div class="roster-list">${thumbs}</div>
      <p>If this is a different person, give them a nickname or initial so they can be told apart:</p>
      <input type="text" id="add-dup-disambig" placeholder='e.g. J.R., or "Johnny"'>
      <div style="height:10px;"></div>
      <div style="display:flex; gap:8px;">
        <button type="button" id="add-dup-confirm" class="secondary">Add as a Different Person</button>
        <button type="button" id="add-dup-cancel" class="secondary">Cancel</button>
      </div>
    `;
    container.appendChild(card);

    card.querySelectorAll(".roster-item img").forEach((img, i) => {
      if (candidates[i].hasPhoto) fetchPhotoObjectUrl(candidates[i].photoUrl).then((url) => { img.src = url; });
      else img.src = PLACEHOLDER_SILHOUETTE_SVG;
    });

    document.getElementById("add-dup-cancel").addEventListener("click", () => {
      container.innerHTML = "";
      resolve(null);
    });
    document.getElementById("add-dup-confirm").addEventListener("click", () => {
      const disambiguator = document.getElementById("add-dup-disambig").value.trim();
      if (!disambiguator) {
        alert("A nickname or initial is required to add a different person with the same name.");
        return;
      }
      container.innerHTML = "";
      resolve(disambiguator);
    });
  });
}

document.getElementById("add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("add-error");
  errorEl.textContent = "";
  document.getElementById("add-duplicate-resolver").innerHTML = "";

  const name = document.getElementById("add-name").value.trim();
  const photoFile = document.getElementById("add-photo").files[0] || null;

  async function submit(disambiguator, forceDistinct) {
    const form = new FormData();
    form.append("name", name);
    if (disambiguator) form.append("disambiguator", disambiguator);
    if (forceDistinct) form.append("forceDistinct", "true");
    if (photoFile) form.append("photo", await cropToSquare(photoFile), "photo.jpg");
    const res = await apiFetch("/api/master/students", { method: "POST", body: form });
    const data = await res.json();
    if (res.status === 409) {
      const chosen = await showAddDuplicatePrompt(data.candidates, name);
      if (chosen) await submit(chosen, true);
      return;
    }
    if (!res.ok) {
      errorEl.textContent = data.error || "Could not add student";
      return;
    }
    document.getElementById("add-form").reset();
  }
  await submit(null, false);
});

// ---------- Manage Students ----------

let allMasterStudents = [];

async function loadManageList() {
  const res = await apiFetch("/api/master/students");
  const data = await res.json();
  allMasterStudents = data.students;
  renderManageList();
}

function renderManageList() {
  const query = document.getElementById("manage-search").value.trim().toLowerCase();
  const list = document.getElementById("manage-list");
  const filtered = query
    ? allMasterStudents.filter((s) => s.name.toLowerCase().includes(query))
    : allMasterStudents;
  if (filtered.length === 0) {
    list.innerHTML = "<p>No students found.</p>";
    return;
  }
  list.innerHTML = "";
  for (const s of filtered) {
    const item = document.createElement("div");
    item.className = "roster-item";
    item.innerHTML = `
      <img alt="${s.name}">
      <div class="name">${s.name}${s.disambiguator ? ` (${s.disambiguator})` : ""}</div>
      <input type="file" accept="image/*" class="photo-input hidden">
      <div style="display:flex; gap:6px; justify-content:center; margin-top:4px; flex-wrap:wrap;">
        <button type="button" class="secondary photo-btn">${s.hasPhoto ? "Replace Photo" : "Add Photo"}</button>
        ${s.hasPhoto ? '<button type="button" class="secondary remove-photo-btn">Remove Photo</button>' : ""}
      </div>
      <div style="display:flex; gap:6px; justify-content:center; margin-top:6px; flex-wrap:wrap;">
        <button type="button" class="secondary edit-btn">Edit Name</button>
        <button type="button" class="danger delete-btn">Delete</button>
      </div>
    `;
    const img = item.querySelector("img");
    if (s.hasPhoto) fetchPhotoObjectUrl(s.photoUrl).then((url) => { img.src = url; });
    else img.src = PLACEHOLDER_SILHOUETTE_SVG;

    item.querySelector(".photo-btn").addEventListener("click", () => {
      item.querySelector(".photo-input").click();
    });
    item.querySelector(".photo-input").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const form = new FormData();
      form.append("photo", await cropToSquare(file), "photo.jpg");
      const res = await apiFetch(`/api/master/students/${s.id}`, { method: "PATCH", body: form });
      if (!res.ok) {
        alert((await res.json()).error || "Could not update photo");
        return;
      }
      await loadManageList();
    });

    const removeBtn = item.querySelector(".remove-photo-btn");
    if (removeBtn) {
      removeBtn.addEventListener("click", async () => {
        if (!confirm(`Remove ${s.name}'s photo? They'll show a placeholder until a new one is added.`)) return;
        const form = new FormData();
        form.append("removePhoto", "true");
        const res = await apiFetch(`/api/master/students/${s.id}`, { method: "PATCH", body: form });
        if (!res.ok) {
          alert((await res.json()).error || "Could not remove photo");
          return;
        }
        await loadManageList();
      });
    }

    item.querySelector(".edit-btn").addEventListener("click", async () => {
      const newName = prompt("Name:", s.name);
      if (newName === null || !newName.trim()) return;
      const newDisambig = prompt("Nickname/initial (leave blank for none):", s.disambiguator || "");
      if (newDisambig === null) return;
      const form = new FormData();
      form.append("name", newName.trim());
      form.append("disambiguator", newDisambig.trim());
      const res = await apiFetch(`/api/master/students/${s.id}`, { method: "PATCH", body: form });
      if (!res.ok) {
        alert((await res.json()).error || "Could not update student");
        return;
      }
      await loadManageList();
    });

    item.querySelector(".delete-btn").addEventListener("click", async () => {
      if (!confirm(`Delete ${s.name}? Any decks referencing them will show a placeholder photo instead.`)) return;
      await apiFetch(`/api/master/students/${s.id}`, { method: "DELETE" });
      await loadManageList();
    });

    list.appendChild(item);
  }
}

document.getElementById("manage-search").addEventListener("input", renderManageList);

// ---------- PDF Import ----------
// Strategy: detect photo/name regions deterministically from pixel data (color
// photos on a white background, separated by whitespace), then only use AI to
// read the small, already-cropped name snippets. AI is never used to locate
// anything. This whole-school roster has no grouping to detect (unlike the
// old per-class imports) — every page is scanned the same way and every
// student found goes straight into one flat database.

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

// Scans every page: detects photo/name pairs as usual, but also surfaces any
// name-text blob that never got claimed by a photo pairing (a grid cell
// where photo-detection failed but the name is still legible) as a student
// with no photo — pairPhotosWithNames only walks the photos array, so an
// unclaimed text would otherwise be silently dropped instead of becoming a
// (photo-less) student record.
async function extractAllStudents(pdf, statusEl) {
  const students = []; // {name, blob: Blob|null}
  const unreadableNamePhotos = []; // {page} — photo found, name unreadable
  const noPhotoNames = []; // {name} — name found, no photo blob paired

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const row = document.createElement("div");
    row.className = "import-page-status";
    row.innerHTML = `<span class="spinner"></span> Reading page ${pageNum} of ${pdf.numPages}…`;
    statusEl.appendChild(row);

    try {
      const page = await pdf.getPage(pageNum);
      const canvas = await renderPageToCanvas(page);
      const blobs = detectBlobs(canvas);
      const { photos, texts } = classifyBlobs(blobs, canvas.width);
      const pairs = pairPhotosWithNames(photos, texts)
        .sort((a, b) => (a.photo.y0 - b.photo.y0) || (a.photo.x0 - b.photo.x0));

      // Header/margin text never pairs with a photo and would otherwise be
      // mistaken for orphan "no-photo" students below. Two bands, confirmed
      // against the real production PDF: page 1 has a substantial header
      // block (title, class/room/pattern fields, teacher name+date) running
      // to roughly the top 22%; the browser's print margin (a small
      // date/time + "Untitled Document" line) turned out to repeat on
      // EVERY page, not just page 1 as first assumed from a visual check —
      // it showed up as a fake "student" duplicated 28 times across the
      // real 29-page import before this fix. This only affects orphan
      // (unpaired) text — real photo+name pairs are never filtered by
      // position — so a generous margin band on continuation pages carries
      // no risk of losing an actual student's row.
      const headerBandBottomPx = canvas.height * (pageNum === 1 ? 0.22 : 0.08);
      const usedTexts = new Set(pairs.filter((p) => p.name).map((p) => p.name));
      const orphanTexts = texts.filter((t) => !usedTexts.has(t) && t.y0 >= headerBandBottomPx);

      const photoBlobs = await Promise.all(pairs.map((p) => cropPixelRect(canvas, p.photo)));
      const pairNameRegions = pairs.map((p) => p.name);
      const allNameRegions = [...pairNameRegions, ...orphanTexts];
      const crops = await Promise.all(
        allNameRegions.map((t) => (t ? cropPixelRect(canvas, t).then((blob) => ({ blob, mediaType: "image/jpeg" })) : null))
      );
      const toOcr = crops.filter(Boolean);
      const names = new Array(allNameRegions.length).fill("");
      if (toOcr.length) {
        const results = await ocrBatch(
          toOcr,
          "Each image contains exactly one student's name printed on a school roster, in 'Last, First' format. Read and return the exact printed text of each image, in order."
        );
        let oi = 0;
        for (let i = 0; i < allNameRegions.length; i++) {
          if (allNameRegions[i]) names[i] = (results[oi++] || "").trim();
        }
      }

      let withPhoto = 0;
      for (let i = 0; i < pairs.length; i++) {
        if (names[i]) { students.push({ name: names[i], blob: photoBlobs[i] }); withPhoto++; }
        else unreadableNamePhotos.push({ page: pageNum });
      }
      // Safety net beyond the header-band exclusion above: only accept an
      // orphan-text OCR result that actually looks like "Last, First" —
      // discards stray non-name artifacts (page-footer URLs, print
      // timestamps) that might otherwise slip through as fake students.
      // The date/time check exists because a real production run showed a
      // print-margin timestamp like "8/21/26, 9:07 AM" otherwise satisfies
      // the plain comma-shape check (a date and a time, joined by a comma,
      // looks exactly like "Last, First" to a naive regex).
      const NAME_SHAPE_RE = /^[^,]+,\s*\S+/;
      const LOOKS_LIKE_DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{2,4}\s*,/;
      let withoutPhoto = 0;
      for (let i = 0; i < orphanTexts.length; i++) {
        const name = names[pairs.length + i];
        if (name && NAME_SHAPE_RE.test(name) && !LOOKS_LIKE_DATE_RE.test(name)) {
          students.push({ name, blob: null });
          noPhotoNames.push({ name });
          withoutPhoto++;
        }
      }
      row.innerHTML = `✅ Page ${pageNum}: ${withPhoto} student(s) with photos` +
        (withoutPhoto ? `, ${withoutPhoto} with no photo` : "");
    } catch (err) {
      row.innerHTML = `❌ Page ${pageNum}: ${err.message}`;
    }
  }
  return { students, unreadableNamePhotos, noPhotoNames };
}

function findDuplicateGroups(students) {
  const byKey = new Map();
  students.forEach((s, i) => {
    const key = normalizeNameKey(s.name);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(i);
  });
  return [...byKey.values()].filter((idxs) => idxs.length > 1);
}

// Shows a resolver for every duplicate name found in this import batch —
// same person (pick which photo to keep) or different people (a required,
// mutually-distinct nickname/initial per person) — and resolves to the
// final, de-duplicated/disambiguated student list once every group has been
// decided. This only ever needs to check the freshly-extracted batch against
// itself, since a wholesale replace has nothing pre-existing to compare to.
async function resolveDuplicates(groups, students) {
  if (groups.length === 0) return students;
  return new Promise((resolve) => {
    const container = document.getElementById("duplicate-resolver");
    container.innerHTML = "";

    const header = document.createElement("div");
    header.className = "card";
    header.innerHTML = `<h3>Resolve ${groups.length} duplicate name${groups.length === 1 ? "" : "s"}</h3>
      <p class="warn">The same name was found more than once in this PDF. For each, say whether it's the same person or two different people.</p>`;
    container.appendChild(header);

    const state = groups.map(() => ({ mode: null, keepIndex: null, disambigs: {} }));
    const continueBtn = document.createElement("button");
    continueBtn.textContent = "Continue Import";
    continueBtn.disabled = true;
    continueBtn.style.marginTop = "10px";

    function checkReady() {
      continueBtn.disabled = !state.every((s, gi) => {
        if (s.mode === "same") return s.keepIndex != null;
        if (s.mode === "distinct") {
          const vals = groups[gi].map((idx) => (s.disambigs[idx] || "").trim());
          if (vals.some((v) => !v)) return false;
          return new Set(vals).size === vals.length;
        }
        return false;
      });
    }

    groups.forEach((idxs, gi) => {
      const groupCard = document.createElement("div");
      groupCard.className = "card duplicate-group";
      const thumbs = idxs.map((idx) => {
        const s = students[idx];
        const url = s.blob ? URL.createObjectURL(s.blob) : PLACEHOLDER_SILHOUETTE_SVG;
        return `
          <div class="duplicate-candidate" data-idx="${idx}">
            <img src="${url}" alt="${s.name}">
            <div class="name">${s.name}</div>
            <label class="hidden"><input type="radio" name="keep-${gi}" class="keep-radio" value="${idx}"> Keep this photo</label>
            <input type="text" class="disambig-input hidden" placeholder='Nickname or initial (e.g. J.R.)'>
          </div>
        `;
      }).join("");
      groupCard.innerHTML = `
        <h4>${students[idxs[0]].name} — found ${idxs.length} times</h4>
        <div class="mode-choice">
          <label><input type="radio" name="mode-${gi}" value="same"> Same person (pick which photo to keep)</label>
          <label><input type="radio" name="mode-${gi}" value="distinct"> Different people (name each one so they can be told apart)</label>
        </div>
        <div class="duplicate-candidates">${thumbs}</div>
      `;
      container.appendChild(groupCard);

      const candidateEls = [...groupCard.querySelectorAll(".duplicate-candidate")];
      groupCard.querySelectorAll(`input[name="mode-${gi}"]`).forEach((r) => {
        r.addEventListener("change", () => {
          state[gi].mode = r.value;
          candidateEls.forEach((el) => {
            el.querySelector(".keep-radio").closest("label").classList.toggle("hidden", r.value !== "same");
            el.querySelector(".disambig-input").classList.toggle("hidden", r.value !== "distinct");
          });
          checkReady();
        });
      });
      candidateEls.forEach((el) => {
        const idx = Number(el.dataset.idx);
        el.querySelector(".keep-radio").addEventListener("change", (e) => {
          if (e.target.checked) state[gi].keepIndex = idx;
          checkReady();
        });
        el.querySelector(".disambig-input").addEventListener("input", (e) => {
          state[gi].disambigs[idx] = e.target.value;
          checkReady();
        });
      });
    });

    container.appendChild(continueBtn);
    continueBtn.addEventListener("click", () => {
      const toRemove = new Set();
      groups.forEach((idxs, gi) => {
        const s = state[gi];
        if (s.mode === "same") {
          idxs.forEach((idx) => { if (idx !== s.keepIndex) toRemove.add(idx); });
        } else {
          idxs.forEach((idx) => { students[idx].disambiguator = (s.disambigs[idx] || "").trim(); });
        }
      });
      container.innerHTML = "";
      resolve(students.filter((_, idx) => !toRemove.has(idx)));
    });
  });
}

function renderReviewGrid(students, unreadableNamePhotos, noPhotoNames) {
  const container = document.getElementById("import-review");
  container.innerHTML = "";

  const section = document.createElement("div");
  section.className = "card";
  section.innerHTML = `
    <h3>Review ${students.length} student(s)</h3>
    <p class="warn">Check the photos below. If one is broken or wrong (e.g. a missing-image icon instead of a real headshot), click "No real photo" so that student is saved without one instead.</p>
    <div class="roster-list" id="review-grid"></div>
    <button id="confirm-import-btn" style="margin-top:14px;">Save &amp; Replace Entire Database</button>
    <span class="save-status" id="import-save-status" style="margin-left:10px;"></span>
  `;
  container.appendChild(section);

  const grid = section.querySelector("#review-grid");
  students.forEach((s) => {
    const item = document.createElement("div");
    item.className = "roster-item";
    const url = s.blob ? URL.createObjectURL(s.blob) : PLACEHOLDER_SILHOUETTE_SVG;
    item.innerHTML = `
      <img src="${url}" alt="${s.name}">
      <div class="name">${s.name}</div>
      <button type="button" class="secondary remove-photo-btn" ${s.blob ? "" : "disabled"}>${s.blob ? "No real photo" : "No photo"}</button>
    `;
    if (s.blob) {
      item.querySelector(".remove-photo-btn").addEventListener("click", () => {
        s.blob = null;
        item.querySelector("img").src = PLACEHOLDER_SILHOUETTE_SVG;
        const btn = item.querySelector(".remove-photo-btn");
        btn.disabled = true;
        btn.textContent = "No photo";
      });
    }
    grid.appendChild(item);
  });

  if (unreadableNamePhotos.length || noPhotoNames.length) {
    const summary = document.createElement("div");
    summary.className = "card";
    let html = "<h3>Heads up</h3>";
    if (unreadableNamePhotos.length) {
      const pages = [...new Set(unreadableNamePhotos.map((m) => m.page))].join(", ");
      html += `<p class="warn">${unreadableNamePhotos.length} photo(s) across page(s) ${pages} couldn't be paired with a readable name and were not imported. Add those students manually from the "Add Student" tab.</p>`;
    }
    if (noPhotoNames.length) {
      html += `<p class="warn">${noPhotoNames.length} student(s) were saved with no photo on file — worth adding real photos for them eventually: ${noPhotoNames.map((n) => n.name).join(", ")}.</p>`;
    }
    summary.innerHTML = html;
    container.appendChild(summary);
  }

  section.querySelector("#confirm-import-btn").addEventListener("click", async (e) => {
    e.target.disabled = true;
    await saveImport(students, section.querySelector("#import-save-status"));
  });
}

// Splits the save into chunks: a single Worker invocation is capped at 1000
// subrequests (R2 uploads count against that), and chunking also gives real
// progress feedback across ~1000+ students — a far bigger job than any
// per-class import. "replace" wipes the whole database on the first chunk
// only; every later chunk of the same import uses "append" so it doesn't
// wipe what the previous chunk just saved.
async function saveImport(students, statusEl) {
  const CHUNK_SIZE = 150;
  const chunks = [];
  for (let i = 0; i < students.length; i += CHUNK_SIZE) chunks.push(students.slice(i, i + CHUNK_SIZE));
  for (let c = 0; c < chunks.length; c++) {
    statusEl.textContent = `Preparing photos for chunk ${c + 1} of ${chunks.length}…`;
    // Crop every photo in this chunk concurrently rather than one at a time
    // — sequential createImageBitmap/canvas/toBlob round trips are slow
    // enough (~1s+ each) that awaiting them one by one made a ~1000-student
    // import take tens of minutes before the first byte was even uploaded.
    const croppedPhotos = await Promise.all(
      chunks[c].map((s) => (s.blob ? cropToSquare(s.blob) : Promise.resolve(null)))
    );
    statusEl.textContent = `Saving ${c + 1} of ${chunks.length}…`;
    const form = new FormData();
    form.append("mode", c === 0 ? "replace" : "append");
    chunks[c].forEach((s, i) => {
      form.append("name", s.name);
      form.append("disambiguator", s.disambiguator || "");
      if (croppedPhotos[i]) form.append("photo", croppedPhotos[i], "photo.jpg");
      else form.append("photo", "");
    });
    const res = await apiFetch("/api/master/import", { method: "POST", body: form });
    if (!res.ok) {
      statusEl.textContent = (await res.json().catch(() => ({}))).error || "Import failed";
      return;
    }
  }
  statusEl.textContent = `Saved ${students.length} students.`;
}

document.getElementById("pdf-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById("duplicate-resolver").innerHTML = "";
  document.getElementById("import-review").innerHTML = "";
  const statusEl = document.getElementById("page-status");
  statusEl.innerHTML = "";

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const { students, unreadableNamePhotos, noPhotoNames } = await extractAllStudents(pdf, statusEl);
  const groups = findDuplicateGroups(students);
  const resolvedStudents = await resolveDuplicates(groups, students);
  renderReviewGrid(resolvedStudents, unreadableNamePhotos, noPhotoNames);
});
