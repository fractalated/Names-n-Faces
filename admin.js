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
document.getElementById("pdf-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  document.getElementById("import-review").innerHTML = "";
  const statusEl = document.getElementById("page-status");
  statusEl.innerHTML = "";

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const groups = {}; // collection -> [{name, blob}]
  const missing = []; // {name, page}
  const unmapped = []; // {page, pattern}

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const row = document.createElement("div");
    row.className = "import-page-status";
    row.innerHTML = `<span class="spinner"></span> Reading page ${pageNum} of ${pdf.numPages}…`;
    statusEl.appendChild(row);

    try {
      const canvas = await renderPageToCanvas(pdf, pageNum);
      const base64 = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
      const res = await apiFetch("/api/import/extract-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: base64, mediaType: "image/jpeg" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Extraction failed");

      if (!data.collection) {
        unmapped.push({ page: pageNum, pattern: data.pattern });
        row.innerHTML = `⚠️ Page ${pageNum}: could not determine period/chapel (found pattern "${data.pattern || ""}") — skipped`;
        continue;
      }

      groups[data.collection] = groups[data.collection] || [];
      let found = 0;
      for (const student of data.students) {
        if (student.hasPhoto && student.bbox && student.bbox.length === 4) {
          const blob = await cropFromCanvas(canvas, student.bbox);
          groups[data.collection].push({ name: student.name, blob });
          found++;
        } else {
          missing.push({ name: student.name, page: pageNum });
        }
      }
      row.innerHTML = `✅ Page ${pageNum}: ${collectionLabel(data.collection)} — ${found} student photo(s) found`;
    } catch (err) {
      row.innerHTML = `❌ Page ${pageNum}: ${err.message}`;
    }
  }

  renderImportReview(groups, missing, unmapped);
});

async function renderPageToCanvas(pdf, pageNum, targetWidth = 1600) {
  const page = await pdf.getPage(pageNum);
  const viewport1 = page.getViewport({ scale: 1 });
  const scale = targetWidth / viewport1.width;
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas;
}

function cropFromCanvas(sourceCanvas, bbox) {
  const [x0, y0, x1, y1] = bbox;
  const sx = Math.max(0, x0 * sourceCanvas.width);
  const sy = Math.max(0, y0 * sourceCanvas.height);
  const sw = Math.max(1, (x1 - x0) * sourceCanvas.width);
  const sh = Math.max(1, (y1 - y0) * sourceCanvas.height);
  const out = document.createElement("canvas");
  out.width = Math.round(sw);
  out.height = Math.round(sh);
  out.getContext("2d").drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return new Promise((resolve) => out.toBlob(resolve, "image/jpeg", 0.9));
}

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
    const thumbs = students.map((s, i) => {
      const url = URL.createObjectURL(s.blob);
      return `<div class="roster-item"><img src="${url}" alt="${s.name}"><div class="name">${s.name}</div></div>`;
    }).join("");
    section.innerHTML = `
      <h3>${collectionLabel(collection)} — ${students.length} student(s) found</h3>
      <p class="warn">Saving will replace the entire "${collectionLabel(collection)}" collection with these ${students.length} students.</p>
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
    div.innerHTML = `<h3>No photo found (not imported)</h3><p class="warn">${missing.map((m) => `${m.name} (page ${m.page})`).join(", ")}</p><p>Add these manually from the "Add Student" tab once you have a photo.</p>`;
    container.appendChild(div);
  }
}
