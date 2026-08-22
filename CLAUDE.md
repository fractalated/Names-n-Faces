# Names-n-Faces

A private flashcard/quiz tool for teachers and administrators to learn
student names and faces. There is **one shared, admin-owned student
database** for the whole school (name + photo), built once a year from a
single whole-school roster PDF and touched up incrementally as students
enroll. Teachers never upload their own photos — they build "decks" (named
flashcard sets) by uploading a plain list of names, which the app matches
against the shared database. A deck always shows whatever the database
currently has for each matched student, falling back to a generic
silhouette if that student's record is gone (e.g. after an annual refresh)
— so decks age out gracefully and a teacher just discards a stale one,
rather than the app needing any change-notification machinery.

## Architecture

- **Frontend**: static HTML/CSS/JS at the repo root, served by GitHub Pages
  at `https://fractalated.github.io/Names-n-Faces/`.
  - `index.html` — login + signup + home page (grid of the logged-in user's
    own decks, plus "+ Create New Deck")
  - `deck.html` — flashcard quiz for one deck (`?d=<deckId>`)
  - `deck-builder.html` / `deck-builder.js` — upload a name list, name the
    deck; matches names against the master database (all users)
  - `admin.html` / `admin.js` — **admin-only**: import/replace the whole
    master database from a roster PDF, add a single student, browse/edit/
    delete master students
  - `users.html` / `users.js` — admin-only: list every account, hard-delete
    one (deletes their decks only — never touches the shared master database)
  - `app.js` — shared auth/API helpers (token storage, `apiFetch`,
    `loadDecks()`/`loadMe()` — fetched per logged-in user and cached in
    memory, cleared on login/logout — plus the placeholder-silhouette SVG
    and `loadCardImage()`)
- **Backend**: Cloudflare Worker at `worker/`, deployed to
  `https://names-n-faces-api.fractalated.workers.dev`.
  - `worker/src/index.js` — all API routes
  - `worker/schema.sql` — **dev-bootstrap reference only** (matches the
    current end-state schema, but its `DROP TABLE` header makes it unsafe to
    run against production)
  - `worker/migrations/*.sql` — the real, incremental schema history,
    applied with `wrangler d1 migrations apply names-n-faces-db [--remote]`
  - R2 bucket `names-n-faces-photos` stores photos (private — only ever
    served through the Worker's authenticated `/api/master/photo/:id`
    route, never public). D1 database `names-n-faces-db` stores `users`,
    `master_students`, `decks`, and `deck_entries`.

## Data model

- **`master_students`** — one shared table, admin-writable only, readable
  by any authenticated user. `name_key` (via `normalizeNameKey`: trim,
  lowercase, collapse whitespace) is computed at write time and is the
  single source of truth for exact-match name lookups — it must be
  computed identically everywhere a name is written or looked up, server
  and client alike (the deck-builder's client-side copy is commented to
  say so). `disambiguator` is a nullable admin-entered nickname/initial,
  set only when two distinct students share a `name_key` (see Duplicate
  names below). `photo_key` is nullable — `NULL` means "no photo, render
  the placeholder silhouette," not an error state.
- **`decks`** (per-user) / **`deck_entries`** — a deck is just a named list
  of entries. Each entry stores `raw_name_text` (what was actually in the
  uploaded list) and a **soft reference** `master_student_id` (nullable, no
  FK/cascade). `GET /api/decks/:id/cards` LEFT JOINs entries to
  `master_students`, so a null or since-deleted reference just resolves to
  `hasPhoto:false` + the raw text — never an error, never a sync step. This
  is the entire mechanism behind "decks always reflect the current
  database": nothing needs to notice a change happened, because every read
  is already live.
- Binding a deck entry to a **student id** rather than re-matching name text
  on every read matters for two reasons: a later admin correction to a
  misread name (`PATCH /api/master/students/:id`) is picked up by every
  deck automatically with zero deck-side changes, and duplicate-name
  ambiguity (see below) only ever needs to be resolved once, at deck-build
  time, not on every use.
- An **annual wholesale master-database replace** (`POST /api/master/import`
  with `mode:"replace"`) deletes every row and reissues fresh ids to
  everyone — even students who are unchanged. This means every deck across
  every teacher goes stale simultaneously after a replace, **by design**:
  that's what makes "discard this deck" (an ordinary, unconditional delete,
  available any time) the right and sufficient tool, rather than needing
  any staleness-detection or login-time change prompt.

## Duplicate names

Two students can share an exact name (rare, but it happens). This is
resolved **once, centrally, by the admin**, at master-import/add time —
never left for a teacher to improvise:
- Bulk import (`admin.js`'s `findDuplicateGroups`/`resolveDuplicates`):
  every name repeated within the freshly-extracted batch gets a resolver
  before anything saves — "same person" (pick which photo to keep) or
  "different people" (a required, mutually-distinct nickname/initial per
  person, stored as `disambiguator`).
- Single add (`POST /api/master/students`): a name that already exists
  returns `409 {candidates}`; the admin either cancels or supplies a
  `disambiguator` and retries with `forceDistinct=true`.
- A teacher building a deck only ever sees the *admin's own* resolution:
  if their uploaded list's name matches more than one `master_students` row
  under the same `name_key`, `deck-builder.js` shows those specific
  candidates (photo + disambiguator) as a pick-one choice. They cannot
  invent a new resolution — only choose among what the admin already set up.
- No fuzzy matching, anywhere, by design. A name that doesn't match at all
  (typo, different format, not yet enrolled) is an expected "not found"
  case surfaced to the teacher, not a bug to later "fix" with fuzzy logic —
  that would silently violate the exact-match design duplicate resolution
  depends on.

## Auth model

Every route except `POST /api/login` and `POST /api/signup` requires
`Authorization: Bearer <token>`. The token is an HMAC-SHA256-signed
`{sub: userId, admin: bool, exp}` payload, signed with the `TOKEN_SECRET`
secret (see `signToken`/`verifyToken`). `requireAuth` resolves the token to
`{userId, isAdmin}`. Admin-only routes (`/api/master/import`,
`/api/master/students` POST/PATCH/DELETE, `/api/admin/users`) re-check
`isAdmin` server-side on every call — `admin.html`'s client-side redirect
for non-admins is UX only, never the real authorization boundary. Routes
reading `master_students`/`master/photo` require auth but are **not**
scoped by `user_id` — that data is intentionally shared. `decks`/
`deck_entries` routes **are** scoped by `user_id`.

Passwords are hashed with PBKDF2-SHA256 (Web Crypto `crypto.subtle`, no
bcrypt/argon2 available in Workers). Secrets (`TOKEN_SECRET`,
`ANTHROPIC_API_KEY`) are set via `wrangler secret put` and live only in
Cloudflare — never in this repo.

## Master-import pipeline — lessons learned

The whole-school roster PDF is the same RenWeb "Class Roster" export as an
individual class roster: a plain-white-background 5-column grid of student
headshot photos with each name printed directly below, header block (if
any) appearing once at the very top of page 1 only — continuation pages
are pure grid, no repeated header. Unlike a single class's roster, there is
nothing to group by, so master import skips straight to "detect every
photo+name pair on every page" with no header/field-picker step at all.

**Do not use AI vision to locate photos or draw bounding boxes** — LLM
vision is not a precise multi-object detector; an early version tried this
and produced poorly-aligned crops and names paired with the wrong photo.

**What works** (`admin.js`, reused verbatim from the per-class import that
came before this rebuild — do not rewrite):
1. `renderPageToCanvas` — pdf.js renders a page to canvas.
2. `detectBlobs` — connected-component analysis on non-white pixels, with
   **anisotropic** dilation (`RX=3` horizontal, `RY=1` vertical). This
   exact asymmetry is load-bearing: equal horizontal/vertical dilation
   bridges the whitespace gap *between grid rows* and merges an entire
   column into one blob (symptom: every page reports exactly N students,
   where N is the column count). Fixed once already — check `RX`/`RY`
   first if that symptom ever reappears.
3. `classifyBlobs` — splits blobs into "photo" (tall) vs "name text" (short)
   by the biggest gap in the sorted height distribution, not a fixed
   threshold.
4. `pairPhotosWithNames` — pairs each photo with the name-text directly
   below it, by position.
5. `ocrBatch` (`/api/import/ocr-batch`) — Claude OCRs small, already-cropped
   snippets (name captions). AI is never used to locate anything.

**Extensions made for the whole-school import specifically**
(`extractAllStudents`):
- **Orphan text blobs.** `pairPhotosWithNames` only walks the `photos`
  array — a name-text blob that never got claimed by a photo pairing (a
  grid cell where photo-detection failed but the name is still legible,
  like the real "Avot, Louis Marie" case: a broken-image icon instead of a
  headshot) was previously silently dropped. `extractAllStudents`
  explicitly collects these unclaimed texts, OCRs them too, and creates a
  no-photo student record instead of losing the row.
- **Header/footer false positives on that orphan-text path.** The first
  version of this counted *every* unclaimed text blob as a potential
  no-photo student, which meant the page-1 header block (title, class/room/
  pattern fields, the teacher's own "Last, First"-shaped signature line)
  got miscounted as fake students. Fixed with two filters:
  (a) exclude the top ~22% of **page 1 only** (continuation pages have no
  header at all on this report style) before ever treating a text blob as
  an orphan candidate, and (b) require the OCR'd result to actually look
  like `"Something, Something"` (`NAME_SHAPE_RE`) before accepting it —
  catches any other stray footer/URL/timestamp text that might slip
  through position-based filtering alone.
- **Broken-image-icon photos that** ***do*** **get photo-classified.** The
  deterministic pipeline has no signal to distinguish a broken-image icon
  from a real headshot without AI vision (which this app deliberately never
  uses for detection). The reliable fix is human-in-the-loop: every
  thumbnail in the review grid gets a "No real photo — remove" toggle.
- **Deck-list name matching is deliberately not regex-based.**
  `deck-builder.js` matches each line of an uploaded name list against the
  **known** `master_students` list (substring search on `name_key`) rather
  than regex-extracting an unknown name's boundaries. A real sample list
  (`Create a Report.pdf`) confirmed why: wide report columns collapse to
  single spaces once text items are joined, making a genuine two-word
  first name (the real "Bahr, Hunter Shockley") indistinguishable from a
  name plus an accidentally-absorbed trailing "Status"/"Grade Level"
  column word, under any regex that allows an optional extra name-word.
  Searching for names already known to exist sidesteps that ambiguity
  entirely; a generic name-shaped regex is used only as a last-resort,
  purely informational fallback for lines matching nothing (so the "not
  found" list has *something* readable to show), never for real matching.

## Import scale / chunking

A whole-school import (~1000+ students, ~30 pages) is far bigger than any
per-class import ever was. `admin.js`'s `saveImport` splits the save into
~150-student chunks against `POST /api/master/import` (`mode:"replace"` on
the first chunk only, `"append"` after) rather than one giant request,
both because a single Worker invocation is capped at 1000 subrequests (R2
`.put()` calls count against that) and to give real progress feedback.
`env.DB.batch(...)` is used for bulk inserts, not per-row `.run()` calls.

## Testing notes

There's no PDF rasterization tooling installed by default (no
`pdftoppm`/`pdftotext`), and the actual roster PDFs are student data, not
committed to the repo — but Homebrew's `poppler` package (`brew install
poppler`) provides both and is safe to install locally for structural
inspection/debugging (page text, page counts) without needing a browser.
Full pipeline verification (pixel/blob detection, real OCR accuracy) still
needs the live app in a browser with a real roster PDF.

The worker's auth/data-model logic (signup, login, master CRUD, decks CRUD,
duplicate handling, admin cascade delete) **can** be exercised without a
browser or a real PDF — run `wrangler dev --local` with a `.dev.vars` file
(`TOKEN_SECRET`, `ANTHROPIC_API_KEY`; not committed) and a migrated local
D1, then drive it with `curl`. For a *fresh* local D1, apply
`worker/schema.sql` directly (`wrangler d1 execute --local --file=schema.sql`)
rather than the migration chain — early migrations assume a pre-existing
`people` table that only ever existed in production from before migrations
were introduced, and won't apply cleanly to a truly empty local database.

## Deck editing (delete deck, add/remove students)

Every deck tile on the home screen (`index.html`) has "Edit" and "Delete"
actions — available to whichever user owns that deck, admin or not, since
decks are always per-user (`DELETE /api/decks/:id` is already scoped by
`user_id`, so this needed no new auth logic, only UI). "Edit" opens
`deck-edit.html`/`deck-edit.js`, which shows the whole deck as a checkbox
grid ("select students, Remove Selected" — bulk client-side loop over
`DELETE /api/decks/:id/entries/:entryId`, not a bespoke bulk-delete route)
plus a "type a name, confirm the match" add flow.

**`POST /api/decks/:id/entries`** (add one entry) and **`DELETE
/api/decks/:id/entries/:entryId`** (remove one entry) are the two routes
this added. Both re-verify deck ownership (`WHERE id = ? AND user_id = ?`)
before touching anything, same pattern as every other per-user deck route.

**Deliberate exception to "no fuzzy matching":** the top-level "Duplicate
names" section of this doc says no fuzzy matching, anywhere, by design —
that rule is about `deck-builder.js`'s bulk import, where exact `name_key`
matching is what makes duplicate-name resolution well-defined (see that
section). Typing one name by hand to add to an existing deck is a
different situation: there's no batch to reason about consistently, and
the user explicitly asked for "closest match, then I confirm." So
`deck-edit.js` has its own `similarity()` (substring bonus, else
normalized Levenshtein distance) purely for ranking candidates to show the
user — it never auto-assigns a match. The user always clicks "This is
them" (sends that student's exact id) or "Add anyway" (sends
`masterStudentId: null`, same unmatched/placeholder-photo path bulk import
already uses). If this exception ever needs to spread to another flow,
extract `similarity()`/`levenshtein()` into a shared file rather than
copy-pasting a third time.
