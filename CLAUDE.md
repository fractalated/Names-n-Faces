# Names-n-Faces

A private flashcard/quiz tool for teachers and administrators to learn
student names and faces. Each user has their own account and their own
roster: they upload a class roster PDF (or add students one at a time), the
app extracts each student's photo and name into collections they define
themselves (by period, gender, grade level, or anything else), and they quiz
themselves per collection or across "All Collections."

## Architecture

- **Frontend**: static HTML/CSS/JS at the repo root, served by GitHub Pages
  at `https://fractalated.github.io/Names-n-Faces/`.
  - `index.html` — login + signup + home page (links to the logged-in
    user's own collections)
  - `collection.html` — flashcard quiz for one collection (`?c=<slug>` or `?c=all`)
  - `admin.html` / `admin.js` — PDF import, manual single add, manage/rename/
    delete collections, for the logged-in user's own roster only
  - `users.html` / `users.js` — admin-only: list every account and hard-delete one
  - `app.js` — shared auth/API helpers (token storage, `apiFetch`,
    `loadCollections()`/`loadMe()` — both fetched per logged-in user and
    cached in memory, cleared on login/logout)
- **Backend**: Cloudflare Worker at `worker/`, deployed to
  `https://names-n-faces-api.fractalated.workers.dev`.
  - `worker/src/index.js` — all API routes
  - `worker/schema.sql` — **dev-bootstrap reference only** (matches the
    current end-state schema, but its `DROP TABLE` header makes it unsafe to
    run against production)
  - `worker/migrations/*.sql` — the real, incremental schema history,
    applied with `wrangler d1 migrations apply names-n-faces-db [--remote]`
  - R2 bucket `names-n-faces-photos` stores photos (private — only ever
    served through the Worker's authenticated `/api/photo/:id` route, scoped
    to the requesting user, never public). D1 database `names-n-faces-db`
    stores `users`, `collections`, and `people`.
- **Collections are per-user and dynamic** — not a fixed list. Each user
  has their own `collections` rows (`slug` + display `label`), created either
  by PDF import auto-detection or manually via Manage Roster. `people.collection`
  stores the slug string (not a foreign key) so existing query paths only
  needed `user_id` scoping added, not a rewrite to joins.

## Multi-user / admin model

- Signup (`POST /api/signup`) is self-serve but restricted server- and
  client-side to `@lhsparker.org` email addresses — anyone outside that
  domain must be added manually. No admin-approval step otherwise.
- One `users.is_admin` flag marks the super-admin. Admin-only routes
  (`GET /api/admin/users`, `DELETE /api/admin/users/:id`) re-check
  `isAdmin` from the verified token server-side on every call — the
  frontend's admin-gated nav link/page (`users.html`) is UX only and is
  never the actual authorization boundary.
- Deleting a user via `users.html` is a **hard, cascading delete**: their
  R2 photos, `people` rows, and `collections` rows are all removed, then the
  `users` row. Not reversible. An admin cannot delete their own account
  (blocked server-side) to avoid self-lockout.
- Passwords are hashed with PBKDF2-SHA256 (Web Crypto `crypto.subtle`, no
  bcrypt/argon2 available in Workers) — see `hashPassword`/`verifyPassword`
  in `worker/src/index.js`. If PBKDF2 latency becomes an issue on a lower
  Workers plan, the iteration count is the one knob to turn down.

## Auth model

Every route except `POST /api/login` and `POST /api/signup` requires
`Authorization: Bearer <token>`. The token is an HMAC-SHA256-signed
`{sub: userId, admin: bool, exp}` payload, signed with the `TOKEN_SECRET`
secret (see `signToken`/`verifyToken` in `worker/src/index.js`) — **not**
`ADMIN_PASSWORD`, which is now dead config left over from the single-password
era. `requireAuth` resolves the token to `{userId, isAdmin}`, and every data
route (`people`, `photo`, `collections`) filters by that `userId` — this
matters both because the roster is student data on a public-frontend app,
and because the database now holds multiple users' rosters side by side, so
missing a `user_id` filter is a cross-user data leak, not just a hardening gap.

Secrets (`TOKEN_SECRET`, `ADMIN_PASSWORD`, `ANTHROPIC_API_KEY`) are set via
`wrangler secret put` and live only in Cloudflare — never in this repo.

## PDF import pipeline — lessons learned

A roster PDF has one page per group: a `<Label>: <Value>` header near the
top (e.g. `Period: 3`, `Grade: Freshman`, `Gender: Female` — the label word
itself is **not** hardcoded, since different users group by different
things), then a grid of student headshot photos (color, on a white
background, whitespace between cells) with the student's name printed
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
   layer doesn't contain it — the header `Label: Value` text. This is a task
   LLM vision is actually good at (clean OCR of isolated text), unlike
   bounding-box localization.
6. The header `Label: Value` pair is read via a generic regex
   (`extractLabelValue` in `admin.js`) over pdf.js's real, selectable text
   layer first — restricted to the top ~22% of the page (by PDF point
   coordinates, `page.view`/`item.transform[5]`, not canvas pixels) so an
   unrelated colon pair elsewhere on the page can't false-match now that the
   label word isn't hardcoded to a literal like `Pattern:`. Falls back to
   cropping that header region and OCR'ing it with AI only if the text
   layer doesn't have it. `toSlug`/`toDisplayLabel` turn the pair into a
   collection slug/label (e.g. `Period: 3` → slug `period-3`, label
   `"Period 3"`; `Grade: Freshman` → slug `grade-freshman`, label
   `"Freshman"`).
7. There is deliberately **no upfront wizard** asking a new user how their
   roster is organized — auto-detection runs per-PDF-page, and the one
   correction point is the import review screen: each detected group gets an
   editable label plus a dropdown of the user's existing collections
   (pre-selected on an exact slug match). Pages where no label could be
   detected at all land in an explicit "Unrecognized" bucket with Save
   disabled until the user assigns a real collection — there's no hardcoded
   fallback list to silently drop them into anymore.

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

The worker's auth/data-model logic (signup, login, collections CRUD,
per-user scoping, admin cascade delete) **can** be exercised without a
browser or a real PDF — run `wrangler dev --local` with a `.dev.vars` file
(`TOKEN_SECRET`, `ADMIN_PASSWORD`, `ANTHROPIC_API_KEY`; not committed) and a
migrated local D1 (`wrangler d1 migrations apply names-n-faces-db --local`),
then drive it with `curl`. This covers everything except the PDF-specific
pixel/blob detection and the label auto-detection's real-world accuracy,
which still need the live-app + real-PDF check above.
