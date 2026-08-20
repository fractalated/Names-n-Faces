# Names-n-Faces

A private flashcard/quiz tool for a teacher to learn student names and faces.
Admin (the teacher) uploads a class roster PDF; the app extracts each
student's photo and name and lets anyone with the password quiz themselves
by collection (Period 1–9, Chapel, or All Collections combined).

## Architecture

- **Frontend**: static HTML/CSS/JS at the repo root, served by GitHub Pages
  at `https://fractalated.github.io/Names-n-Faces/`.
  - `index.html` — password login + home page (links to the 10 collections)
  - `collection.html` — flashcard quiz for one collection (`?c=period-3` or `?c=all`)
  - `admin.html` / `admin.js` — PDF import, manual single add, manage/delete
  - `app.js` — shared auth/API helpers (token storage, `apiFetch`, `COLLECTIONS` list)
- **Backend**: Cloudflare Worker at `worker/`, deployed to
  `https://names-n-faces-api.fractalated.workers.dev`.
  - `worker/src/index.js` — all API routes
  - `worker/schema.sql` — D1 schema (`people` table: id, name, photo_key, collection, created_at)
  - R2 bucket `names-n-faces-photos` stores photos (private — only ever
    served through the Worker's authenticated `/api/photo/:id` route, never
    public). D1 database `names-n-faces-db` stores the name/collection metadata.
- **Collections**: fixed set — `period-1` … `period-9`, `chapel`.

## Auth model

Every route except `POST /api/login` requires `Authorization: Bearer <token>`.
The token is an HMAC-SHA256-signed `{exp}` payload, signed with the
`ADMIN_PASSWORD` secret (see `signToken`/`verifyToken` in `worker/src/index.js`).
Student names and photos are never reachable without a valid token — this
matters because the roster is student data and the frontend is on public
GitHub Pages.

Secrets (`ADMIN_PASSWORD`, `ANTHROPIC_API_KEY`) are set via
`wrangler secret put` and live only in Cloudflare — never in this repo.

## PDF import pipeline — lessons learned

The roster PDF has one page per period/chapel: a `Pattern: <N or "chapel">`
label near the top, then a grid of student headshot photos (color, on a
white background, whitespace between cells) with the student's name printed
directly below each photo.

**Do not use AI vision to locate photos or draw bounding boxes.** The first
version asked Claude to look at the whole page and return bounding boxes for
each photo plus the matching name — it was unreliable: crops were poorly
aligned and names got paired with the wrong photo. LLM vision is not a
precise multi-object detector.

**What works instead** (current implementation, in `admin.js`):
1. Render the PDF page to a canvas (`renderPageToCanvas`).
2. Find photo and name-caption regions **deterministically** via
   connected-component ("blob") analysis on non-white pixels
   (`detectBlobs`) — this works because photos are color blocks on a plain
   white background, separated by real whitespace gutters.
3. Classify blobs into "photo" (tall) vs "name text line" (short) by
   splitting on the biggest gap in the sorted height distribution
   (`classifyBlobs`) — adaptive, not a fixed pixel threshold.
4. Pair each photo blob with the name-text blob directly below it by
   position (`pairPhotosWithNames`) — not by AI guessing.
5. AI (Claude, via the Worker's `/api/import/ocr-batch` endpoint) is used
   **only** to read text out of small, already-cropped snippets: each
   isolated name caption, and — only as a fallback when pdf.js's real text
   layer doesn't contain it — the `Pattern:` header value. This is a task
   LLM vision is actually good at (clean OCR of isolated text), unlike
   bounding-box localization.
6. The period/chapel value is read from the literal string `Pattern:` in
   the PDF's real, selectable text layer first (`extractPattern` via
   `page.getTextContent()`), which is fast and 100% reliable when present;
   only falls back to cropping the header and OCR'ing it with AI if that
   text isn't found.

**Known gotcha (fixed once already — don't reintroduce it):** the blob
"dilation" step (used to merge individual glyphs into one word/line, and to
merge internal photo noise into one solid blob) must be **anisotropic** —
a few pixels of horizontal reach, only ~1px vertical reach. An earlier
version used equal horizontal/vertical dilation, which bridged the
whitespace gap *between grid rows* and merged each entire column into one
tall blob — every page reported exactly 5 students found (the column
count), not the true per-page total. If someone reports "it's only finding
N students where N looks like the column count," check `detectBlobs`'s
`RX`/`RY` dilation radii first.

## Testing notes

There's no local PDF rasterization tooling available in this environment
(no `pdftoppm`/`imagemagick`), and the actual roster PDFs are teacher/student
data, not committed to the repo. The only real way to test the import
pipeline is through the live app in a browser with a real roster PDF —
verify visually via the review screen (thumbnails + names) before trusting
a code change to the extraction logic.
