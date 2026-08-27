# Names-n-Faces

A private flashcard/quiz tool for teachers and administrators to learn
student names and faces. There is **one shared, admin-owned student
database** for the whole school (name + photo), built once a year from a
single whole-school roster PDF and touched up incrementally as students
enroll. Teachers never upload their own photos in bulk — they build "decks"
(named flashcard sets) by uploading a plain list of names, which the app
matches against the shared database. A deck always shows whatever the
database currently has for each matched student, falling back to a generic
silhouette if that student's record is gone (e.g. after an annual refresh)
— so decks age out gracefully and a teacher just discards a stale one,
rather than the app needing any change-notification machinery. Any teacher
*can* fill in a missing photo one-off for a student they recognize (see
"Non-admin missing-photo uploads" below) — the one deliberate, narrow
exception to "teachers never write to the shared database."

## Architecture

- **Frontend**: static HTML/CSS/JS at the repo root, served by GitHub Pages
  at `https://fractalated.github.io/Names-n-Faces/`.
  - `index.html` — login + signup + home page (grid of the logged-in user's
    own decks, a "Find a Student" search box, plus "+ Create New Deck")
  - `missing-photos.html` — browses **every** master student currently
    missing a photo (not scoped to any one deck) with an "Add Photo"
    control on each; linked prominently, unconditionally (not admin-gated),
    from the home page nav — the main discovery surface for the non-admin
    photo-upload capability (see below). An item removes itself from the
    list the moment its photo is added.
  - `deck.html` — flashcard quiz for one deck (`?d=<deckId>`); also offers
    "Add Photo" inline under a card that has none, since this is the
    highest-traffic page in the app and the most natural moment to notice
    a gap
  - `deck-view.html` — read-only "View All" study sheet for one deck (every
    card in a grid at once, no shuffle/reveal) — linked from each deck tile
    and from `deck.html`; also offers "Add Photo" per missing-photo card
  - `deck-edit.html` / `deck-edit.js` — rename a deck, add a student by
    fuzzy name search (own "Add a Student" flow — see Duplicate names/
    matching below), multi-select removal of current students, delete the
    whole deck
  - `deck-builder.html` / `deck-builder.js` — upload a name list, name the
    deck; matches names against the master database (all users)
  - `admin.html` / `admin.js` — **admin-only**: import/replace the whole
    master database from a roster PDF, add a single student, browse/edit/
    delete master students (including replacing or removing any student's
    photo — the *unrestricted* version of photo management; contrast with
    the narrow non-admin version below)
  - `users.html` / `users.js` — admin-only: list every account, hard-delete
    one (deletes their decks only — never touches the shared master database)
  - `app.js` — shared helpers loaded on every page before the page-specific
    script: auth (`apiFetch`, `getToken`/`setToken`/`clearToken`,
    `requireLogin`), cached loaders (`loadDecks()`, `loadMe()`,
    `loadMasterStudents()` — all in-memory, cleared on login/logout), the
    placeholder-silhouette SVG + `loadCardImage()`, photo prep
    (`cropToSquare()`), the shared fuzzy-matching trio
    (`normalizeNameKey()`/`levenshtein()`/`similarity()` — see Duplicate
    names below), and the non-admin missing-photo flow
    (`uploadMissingPhoto()`/`renderAddPhotoControl()`). Any function used by
    more than one page lives here — don't reintroduce a second copy in a
    page-specific file (this happened once already with the matching trio;
    see the git history around the home-page search feature).
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
- **Branding**: the whole app uses LuHi (Lutheran High School) brand colors/
  type (`style.css`'s `:root` custom properties, cited from the LuHi Brand
  Standards doc kept in `assets/` — not tracked in git, see below). Every
  page's `.topbar` includes a `<picture>` logo (`assets/logo-purple.png`
  light / `assets/logo-white.png` dark, swapped via
  `prefers-color-scheme`) inside a `.topbar-title` wrapper. `assets/` also
  holds print-resolution source art and brand-standard PDFs that are
  `.gitignore`d on purpose (only the small optimized `logo-*.png` files are
  tracked/served) — don't `git add -f` those back in.

## Data model

- **`master_students`** — one shared table, admin-writable for most fields,
  readable by any authenticated user, and narrowly writable by any user for
  one specific case (see "Non-admin missing-photo uploads"). `name_key` (via
  `normalizeNameKey`: trim, lowercase, collapse whitespace) is computed at
  write time and is the single source of truth for exact-match name lookups
  — it must be computed identically everywhere a name is written or looked
  up, server and every client copy alike. `disambiguator` is a nullable
  admin-entered nickname/initial, set only when two distinct students share
  a `name_key` (see Duplicate names below). `photo_key` is nullable —
  `NULL` means "no photo, render the placeholder silhouette," not an error
  state.
- **`decks`** (per-user) / **`deck_entries`** — a deck is just a named list
  of entries. Each entry stores `raw_name_text` (what was actually in the
  uploaded list) and a **soft reference** `master_student_id` (nullable, no
  FK/cascade). `GET /api/decks/:id/cards` LEFT JOINs entries to
  `master_students` and returns both the resolved photo/name info *and* the
  raw `masterStudentId` itself (needed client-side to know whether a
  no-photo card is attachable — see below) — a null or since-deleted
  reference just resolves to `hasPhoto:false` + the raw text, never an
  error, never a sync step. This is the entire mechanism behind "decks
  always reflect the current database": nothing needs to notice a change
  happened, because every read is already live.
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
  available any time via `deck-edit.html`) the right and sufficient tool,
  rather than needing any staleness-detection or login-time change prompt.

## Duplicate names and fuzzy matching

Two students can share an exact name (rare, but it happens). This is
resolved **once, centrally, by the admin**, at master-import/add time —
never left for a teacher to improvise, with one deliberate, scoped
exception for hand-typing a single name (see below):
- Bulk import (`admin.js`'s `findDuplicateGroups`/`resolveDuplicates`):
  every name repeated within the freshly-extracted batch gets a resolver
  before anything saves — "same person" (pick which photo to keep) or
  "different people" (a required, mutually-distinct nickname/initial per
  person, stored as `disambiguator`).
- Single add (`POST /api/master/students`): a name that already exists
  returns `409 {candidates}`; the admin either cancels or supplies a
  `disambiguator` and retries with `forceDistinct=true`.
- Bulk deck-building (`deck-builder.js`): matches each line of an uploaded
  name list against the **known** `master_students` list (substring search
  on `name_key`) rather than regex-extracting an unknown name's boundaries.
  A real sample list (`Create a Report.pdf`) confirmed why: wide report
  columns collapse to single spaces once text items are joined, making a
  genuine two-word first name (the real "Bahr, Hunter Shockley")
  indistinguishable from a name plus an accidentally-absorbed trailing
  "Status"/"Grade Level" column word, under any regex that allows an
  optional extra name-word. Searching for names already known to exist
  sidesteps that ambiguity entirely; a generic name-shaped regex is used
  only as a last-resort, purely informational fallback for lines matching
  nothing, never for real matching. If their list's name matches more than
  one `master_students` row under the same `name_key`, the teacher sees
  those specific candidates (photo + disambiguator) as a pick-one choice —
  they cannot invent a new resolution, only choose among what the admin
  already set up.
- **Deliberate, scoped exception — hand-typing a name**: `deck-edit.js`'s
  "Add a Student" search and the home-page "Find a Student" search
  (`index.html`) both use fuzzy matching (`matchStudentsByName()` in
  `app.js`) to rank candidates for a human-typed query — unlike the bulk
  paths above, there's no batch to reason about consistently, and the user
  explicitly wants "closest match, confirm it" rather than "exact or
  nothing."
  - Both pages take **separate First Name / Last Name fields**, either
    optional but at least one required — not one combined text box.
    `matchStudentsByName` scores each query against its own name component
    (`splitStoredName` splits the stored "Last, First" on the comma), so
    matching is order-independent by construction. This replaced an earlier
    single-field version that scored one query against the whole "Last,
    First" string at once — a real bug report showed that typing "John
    Stamison" (natural first-last order) scored badly against the stored
    "Stamison, John" purely from word-order mismatch, even though "John" or
    "Stamison" alone matched fine. Splitting the input removes the ambiguity
    entirely instead of trying to guess word order.
  - **Tight on last name, broad on first name, deliberately asymmetric** —
    last names don't change, so `LAST_NAME_MATCH_THRESHOLD` (0.7) only
    tolerates a small typo; first names get nicknamed/shortened/spelled
    differently, so `FIRST_NAME_MATCH_THRESHOLD` (0.45) is more forgiving,
    plus a small `NICKNAME_MAP` of common non-substring nickname pairs
    (e.g. "Bob"/"Robert", "Jack"/"John" — most common nicknames, like
    "Liz"/"Elizabeth", are already caught by `similarity()`'s substring
    check and don't need the map). 0.45 rather than something looser: a
    lower bar let short first names match near-unrelated ones purely from
    edit-distance coincidence (e.g. "Bob" scoring against "Jon" by chance)
    — tune this value with real short-name pairs in mind, not just typo
    tolerance. When both fields are given, a student must satisfy *both*
    (AND) — filling in more fields narrows results, never broadens them.
  - `deck-edit.js` never auto-assigns: every result requires a click ("This
    is them" or "Add anyway" with no match).
  - The home-page search (`index.html`) *does* auto-pick when a result is
    clearly the best one — score ≥0.95, or a ≥0.15 gap over the next-best
    candidate (see `CLEAR_MATCH_SCORE`/`CLEAR_MATCH_GAP` in `index.html`) —
    and only falls back to a picker when genuinely ambiguous (e.g.
    searching last name "Smith" against several Smiths). This search is
    read-only (look someone up, no deck/database mutation from the search
    itself), so an auto-pick that's occasionally wrong just means
    re-searching more specifically — much lower stakes than auto-assigning
    inside a deck. **A high top score alone must never short-circuit past a
    close/tied second candidate** — the real database has two students both
    named exactly "Stamison", so searching that last name alone produces two
    genuine 1.0 ties; the auto-pick check requires either no second
    candidate, a real score gap, or the top being clearly stronger than a
    meaningfully weaker runner-up, never "top score is high" in isolation.
  - **A nickname match must never outrank or tie a literal exact match** —
    `matchStudentsByName`'s first-name scoring takes `Math.max(directScore,
    0.8)` for a nickname-equivalent pair, not an unconditional `1`. Found via
    a real report: searching first name "John" alone matched every "Jack"/
    "Jonathan" (nicknames of John) at the same flat 1.0 as every actual
    "John", and with a fixed 5-result cap, alphabetically-early nickname
    matches crowded a real "Stamison, John" out of view entirely.
  - **Results are paginated with a "Show More" button, never hard-capped**
    (`CANDIDATE_PAGE_SIZE`/`MATCH_PAGE_SIZE`, 10 per page in both
    `index.html` and `deck-edit.js`) — a broad first-name search can
    legitimately match many students, and silently truncating the list risks
    hiding the one the user actually wanted, which is exactly what the fixed
    5-cap did before this.
- No fuzzy matching for anything *automated/bulk*, by design. A name that
  doesn't match at all in a bulk path (typo, different format, not yet
  enrolled) is an expected "not found" case surfaced to the teacher, not a
  bug to later "fix" with fuzzy logic — that would silently violate the
  exact-match design duplicate resolution depends on.
- `normalizeNameKey`/`levenshtein`/`similarity`/`splitStoredName`/
  `matchStudentsByName`/`cropToSquare` all live in `app.js` now, shared by
  every page that needs them (`admin.js`, `deck-builder.js`, `deck-edit.js`,
  `index.html`) — don't add a second copy to a page-specific file; this
  list used to have three independent copies of `normalizeNameKey` before
  they were consolidated.

## Non-admin missing-photo uploads

Any authenticated user — not just the admin — can fill in a photo for a
master student who doesn't have one yet, via `POST
/api/master/students/:id/photo`. This is a deliberate, narrow carve-out in
an otherwise admin-only-write table, made safe by three hard constraints
enforced **server-side**:
1. It only ever sets `photo_key` when it is currently `NULL` — the route
   returns `409` if the student already has a photo. A non-admin can never
   overwrite or remove an existing photo (that stays admin-only, via
   `PATCH .../students/:id` with `removePhoto=true` or a new `photo`).
2. It can only touch `photo_key` — no `name`/`disambiguator` field is
   accepted by this route at all.
3. The client-side entry points only ever offer this button when a card
   already resolves to a real `master_student_id` with `hasPhoto:false`
   (a "not found" home-page search result, or a deck entry that never
   matched anyone, has no id to attach to and correctly gets no button) —
   but the *real* guarantee is server-side constraint #1, not the UI
   gating, same as every other admin-boundary check in this app.

Uses the same `cropToSquare`/upload pattern as admin's own photo tools
(`uploadMissingPhoto()`/`renderAddPhotoControl()` in `app.js`), and the
same placeholder-silhouette fallback everywhere else if the upload never
happens.

**Discoverability matters as much as the capability itself** — the feature
originally shipped surfaced only in `deck-view.html` and the home-page
search, both of which require already knowing which specific student to
look for or which deck they're in. In practice this meant a teacher had no
way to find it at all unless they stumbled into exactly the right context,
which defeats the point of making it available to everyone. Fixed by
adding two more surfaces: `missing-photos.html` (browse the *entire*
missing-photo list, no prior knowledge needed) and `deck.html`'s quiz view
(the highest-traffic page, and the moment a gap is most naturally noticed).
When adding a new capability meant for casual/incidental use, plan its
entry points as deliberately as the capability itself — a correct feature
nobody can find is equivalent to no feature.

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
scoped by `user_id` — that data is intentionally shared, and (per the
missing-photo carve-out above) not even fully admin-write-locked. `decks`/
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
- **Header/footer false positives on that orphan-text path.** The naive
  first version counted *every* unclaimed text blob as a potential
  no-photo student. Two things slipped through before the current filters:
  the page-1 header block (title, class/room/pattern fields, the teacher's
  own "Last, First"-shaped signature line), and — found only once tested
  against the real, full 29-page production PDF — the *browser's own print
  margin* (a small date/time + "Untitled Document" line), which turned out
  to repeat on **every** page, not just page 1 as a visual spot-check had
  suggested, and got miscounted as the same fake "student" dozens of times.
  Fixed with: (a) excluding a top margin band on every page — a small ~8%
  band on continuation pages (just enough for the recurring print-margin
  line) and a much larger ~22% band on page 1 only (the substantial header
  block) — safe to be generous here since this only filters *orphan*
  (unpaired) text, never a real photo+name pair; (b) requiring the OCR'd
  result to actually look like `"Something, Something"` (`NAME_SHAPE_RE`);
  and (c) explicitly rejecting anything date-shaped (`LOOKS_LIKE_DATE_RE`)
  even though a date+time joined by a comma otherwise satisfies the
  comma-shape check just as well as a real name does.
- **Broken-image-icon photos that** ***do*** **get photo-classified.** The
  deterministic pipeline has no signal to distinguish a broken-image icon
  from a real headshot without AI vision (which this app deliberately never
  uses for detection). The reliable fix is human-in-the-loop: every
  thumbnail in the review grid gets a "No real photo — remove" toggle. Even
  so, a handful slipped through one real production import (an automated
  test run skipped that manual step) — found afterward by scanning photo
  file sizes (a broken-icon crop compresses far smaller than a real
  headshot) and confirmed by actually viewing each flagged image before
  correcting it. Don't assume a photo is "real" just because `hasPhoto` is
  true.

## Import scale / chunking

A whole-school import (~1000+ students, ~30 pages) is far bigger than any
per-class import ever was. `admin.js`'s `saveImport` splits the save into
~150-student chunks against `POST /api/master/import` (`mode:"replace"` on
the first chunk only, `"append"` after) rather than one giant request, both
because a single Worker invocation is capped at 1000 subrequests (R2
`.put()` calls count against that) and to give real progress feedback.
`env.DB.batch(...)` is used for bulk inserts, not per-row `.run()` calls.
Within each chunk, every photo is passed through `cropToSquare` **in
parallel** (`Promise.all`, not a sequential loop) — cropping is a real
per-image cost (~1s+ each for `createImageBitmap`/canvas/`toBlob`), and
awaiting them one at a time made a ~1000-student import take tens of
minutes before the first byte was even uploaded.

## Testing notes

There's no PDF rasterization tooling installed by default (no
`pdftoppm`/`pdftotext`), and the actual roster PDFs are student data, not
committed to the repo — but Homebrew's `poppler` package (`brew install
poppler`) provides both and is safe to install locally for structural
inspection/debugging (page text, page counts) without needing a browser.
Full pipeline verification (pixel/blob detection, real OCR accuracy) still
needs the live app in a browser with a real roster PDF — this project has
repeatedly found real bugs (the print-margin duplicate, the broken-icon
photos, a client-side name-matching edge case) that only showed up against
actual production data, not synthetic tests. Validate accordingly before
calling an import-pipeline change done.

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

Every deck tile on the home screen (`index.html`) has "Practice" (quiz),
"View All" (`deck-view.html`), "Edit" (`deck-edit.html`), and "Delete"
actions — available to whichever user owns that deck, admin or not, since
decks are always per-user (`DELETE /api/decks/:id` is already scoped by
`user_id`, so this needed no new auth logic, only UI). `deck-edit.html`
shows the whole deck as a checkbox grid ("select students, Remove Selected"
— bulk client-side loop over `DELETE /api/decks/:id/entries/:entryId`, not
a bespoke bulk-delete route), a "type a name, confirm the match" add flow
(see the fuzzy-matching exception above), a rename form
(`PATCH /api/decks/:id`), and a delete-whole-deck danger zone.

`POST /api/decks/:id/entries` (add one entry) and
`DELETE /api/decks/:id/entries/:entryId` (remove one entry) both re-verify
deck ownership (`WHERE id = ? AND user_id = ?`) before touching anything,
same pattern as every other per-user deck route.

## Nav styling

Topbar nav links (`.topbar-nav a` in `style.css`) are styled as small
bordered button-pills, not plain colored text — plain links tested as too
easy to miss. Every topbar-bearing page wraps its nav links in
`<div class="topbar-nav">` (replacing the old bare `<div>` +
`&nbsp;&middot;&nbsp;` separator pattern — don't reintroduce the middot
separators, the button borders provide the visual separation now). Keep
new nav links inside that wrapper so they pick up the pill styling
automatically; a link left in a bare `<div>` will fall back to the older,
harder-to-see plain-text `.topbar a` style.
