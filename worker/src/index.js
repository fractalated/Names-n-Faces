// Sessions (see "Sessions" below): a plain sign-in lasts 12 hours from
// login; "Keep me signed in on this device" lasts 30 days from last use.
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const REMEMBERED_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// A remembered session's expiry is pushed back on use, but at most this
// often — so a busy page doesn't turn every request into a D1 write.
const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 100000;
const EMAIL_DOMAIN_RE = /^[^\s@]+@lhsparker\.org$/i;

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
}

function forbidden(env) {
  return json({ error: "Forbidden" }, 403, env);
}

// ---------- base64url ----------

function base64UrlEncode(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Constant-time string comparison (both inputs expected to be same-alphabet
// base64url-ish strings) to avoid timing side channels on hash checks.
function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- Sessions ----------
//
// A login hands the client a random 256-bit token; D1 keeps only its
// SHA-256 hash (sessions.id), so a leaked database can't be replayed as
// logins. Because every request looks its session up, a session can be
// ended server-side at any time — logout, "log out of all devices", or the
// admin deleting the account — unlike the stateless signed tokens this
// replaced, which stayed valid until they expired. is_admin is read fresh
// from `users` on every request for the same reason.

async function hashSessionToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return base64UrlEncode(String.fromCharCode(...new Uint8Array(digest)));
}

async function createSession(env, userId, remember) {
  const token = base64UrlEncode(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const now = Date.now();
  const expiresAt = now + (remember ? REMEMBERED_SESSION_TTL_MS : SESSION_TTL_MS);
  await env.DB.batch([
    // Opportunistic cleanup, so expired rows don't pile up.
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare(
      "INSERT INTO sessions (id, user_id, remember, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(await hashSessionToken(token), userId, remember ? 1 : 0, now, now, expiresAt),
  ]);
  return token;
}

async function requireAuth(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  const sessionId = await hashSessionToken(token);
  const now = Date.now();
  const row = await env.DB.prepare(`
    SELECT s.user_id, s.remember, s.last_used_at, u.is_admin
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ?
  `).bind(sessionId, now).first();
  if (!row) return null;
  // Remembered sessions slide: 30 days from last use, not from login.
  if (row.remember && now - row.last_used_at >= SESSION_TOUCH_INTERVAL_MS) {
    await env.DB.prepare(
      "UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?"
    ).bind(now, now + REMEMBERED_SESSION_TTL_MS, sessionId).run();
  }
  return { userId: row.user_id, isAdmin: !!row.is_admin, sessionId };
}

// ---------- password hashing (PBKDF2 via Web Crypto — no bcrypt/argon2 in Workers) ----------

function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    keyMaterial, 256
  );
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}

async function verifyPassword(password, stored) {
  const parts = (stored || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = parseInt(parts[1], 10);
  const salt = base64ToBytes(parts[2]);
  const keyMaterial = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations }, keyMaterial, 256
  );
  return constantTimeEqual(bytesToBase64(new Uint8Array(bits)), parts[3]);
}

function normalizeEmail(email) {
  return (email || "").toString().trim().toLowerCase();
}

// Single source of truth for name matching — used everywhere a
// master_students.name_key is written or looked up. The client-side
// deck-builder replicates this exact logic (trim, lowercase, collapse
// whitespace) and must be kept in sync with it.
function normalizeNameKey(name) {
  return (name || "").toString().trim().toLowerCase().replace(/\s+/g, " ");
}

// Grade level is stored as a plain integer (9 for "09", "9", or "9th").
// Returns null for blank (no grade on file), NaN for anything that isn't a
// real grade, so callers can tell "clear it" apart from "reject this".
function parseGrade(value) {
  const s = (value ?? "").toString().trim();
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : NaN;
}

function extFromType(type) {
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  return "jpg";
}

const OCR_TOOL = {
  name: "report_text_batch",
  description: "Report the transcribed text found in each provided image, in the same order the images were given.",
  input_schema: {
    type: "object",
    properties: {
      texts: {
        type: "array",
        items: { type: "string" },
        description: "One entry per input image, in the same order as given, containing the exact transcribed text. Empty string if unreadable or blank.",
      },
    },
    required: ["texts"],
  },
};

async function ocrBatch(env, images, instruction) {
  const content = [{ type: "text", text: instruction }];
  images.forEach((img, i) => {
    content.push({ type: "text", text: `Image ${i + 1}:` });
    content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
  });

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 2048,
      tools: [OCR_TOOL],
      tool_choice: { type: "tool", name: "report_text_batch" },
      messages: [{ role: "user", content }],
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Anthropic API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const toolUse = data.content.find((c) => c.type === "tool_use" && c.name === "report_text_batch");
  if (!toolUse) throw new Error("No structured OCR result returned");
  return toolUse.input.texts;
}

async function deleteR2KeysChunked(bucket, keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    await bucket.delete(keys.slice(i, i + 1000));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (pathname === "/api/signup" && request.method === "POST") {
      const { email, password, remember } = await request.json().catch(() => ({}));
      const normalizedEmail = normalizeEmail(email);
      if (!EMAIL_DOMAIN_RE.test(normalizedEmail)) {
        return json({ error: "Signup is restricted to @lhsparker.org email addresses" }, 400, env);
      }
      if (!password || password.toString().length < 8) {
        return json({ error: "Password must be at least 8 characters" }, 400, env);
      }
      const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(normalizedEmail).first();
      if (existing) {
        return json({ error: "An account with this email already exists" }, 409, env);
      }
      const id = crypto.randomUUID();
      const passwordHash = await hashPassword(password.toString());
      await env.DB.prepare(
        "INSERT INTO users (id, email, password_hash, is_admin, created_at) VALUES (?, ?, ?, 0, ?)"
      ).bind(id, normalizedEmail, passwordHash, Date.now()).run();
      const token = await createSession(env, id, remember === true);
      return json({ token }, 201, env);
    }

    if (pathname === "/api/login" && request.method === "POST") {
      const { email, password, remember } = await request.json().catch(() => ({}));
      const normalizedEmail = normalizeEmail(email);
      const user = await env.DB.prepare(
        "SELECT id, password_hash, is_admin FROM users WHERE email = ?"
      ).bind(normalizedEmail).first();
      if (!user || !(await verifyPassword((password || "").toString(), user.password_hash))) {
        return json({ error: "Invalid email or password" }, 401, env);
      }
      const token = await createSession(env, user.id, remember === true);
      return json({ token }, 200, env);
    }

    const auth = await requireAuth(request, env);
    if (!auth) {
      return json({ error: "Unauthorized" }, 401, env);
    }

    // Ends just this device's session.
    if (pathname === "/api/logout" && request.method === "POST") {
      await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(auth.sessionId).run();
      return json({ ok: true }, 200, env);
    }

    // Ends every session for this user, on every device (lost/stolen laptop).
    if (pathname === "/api/logout-all" && request.method === "POST") {
      await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(auth.userId).run();
      return json({ ok: true }, 200, env);
    }

    if (pathname === "/api/me" && request.method === "GET") {
      const row = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(auth.userId).first();
      return json({ email: row ? row.email : null, isAdmin: auth.isAdmin }, 200, env);
    }

    // ---------- Master student database (shared, admin-writable, everyone reads) ----------

    if (pathname === "/api/master/students" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, name, disambiguator, grade, photo_key IS NOT NULL AS has_photo FROM master_students ORDER BY name"
      ).all();
      const students = results.map((s) => ({
        id: s.id,
        name: s.name,
        disambiguator: s.disambiguator || null,
        grade: s.grade ?? null,
        hasPhoto: !!s.has_photo,
        photoUrl: s.has_photo ? `/api/master/photo/${s.id}` : null,
      }));
      return json({ students }, 200, env);
    }

    if (pathname === "/api/master/import" && request.method === "POST") {
      if (!auth.isAdmin) return forbidden(env);
      const form = await request.formData();
      const mode = (form.get("mode") || "").toString();
      if (mode !== "replace" && mode !== "append") {
        return json({ error: "mode must be 'replace' or 'append'" }, 400, env);
      }
      const names = form.getAll("name").map((n) => n.toString());
      const disambiguators = form.getAll("disambiguator").map((d) => d.toString());
      const photos = form.getAll("photo");
      if (names.length !== disambiguators.length || names.length !== photos.length) {
        return json({ error: "name/disambiguator/photo count mismatch" }, 400, env);
      }

      if (mode === "replace") {
        const { results } = await env.DB.prepare(
          "SELECT photo_key FROM master_students WHERE photo_key IS NOT NULL"
        ).all();
        await deleteR2KeysChunked(env.PHOTOS, results.map((r) => r.photo_key));
        await env.DB.prepare("DELETE FROM master_students").run();
      }

      const now = Date.now();
      const stmts = [];
      const inserted = [];
      for (let i = 0; i < names.length; i++) {
        const name = names[i].trim();
        if (!name) continue;
        const disambiguator = disambiguators[i].trim() || null;
        const photo = photos[i];
        const id = crypto.randomUUID();
        let photoKey = null;
        if (photo instanceof File && photo.size > 0) {
          photoKey = `${id}.${extFromType(photo.type)}`;
          await env.PHOTOS.put(photoKey, await photo.arrayBuffer(), { httpMetadata: { contentType: photo.type } });
        }
        stmts.push(env.DB.prepare(
          "INSERT INTO master_students (id, name, name_key, disambiguator, photo_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(id, name, normalizeNameKey(name), disambiguator, photoKey, now, now));
        inserted.push({ id, name });
      }
      if (stmts.length) await env.DB.batch(stmts);
      return json({ count: inserted.length, students: inserted }, 200, env);
    }

    if (pathname === "/api/master/students" && request.method === "POST") {
      if (!auth.isAdmin) return forbidden(env);
      const form = await request.formData();
      const name = (form.get("name") || "").toString().trim();
      if (!name) return json({ error: "Name is required" }, 400, env);
      const nameKey = normalizeNameKey(name);
      const forceDistinct = (form.get("forceDistinct") || "").toString() === "true";
      let disambiguator = (form.get("disambiguator") || "").toString().trim() || null;
      const grade = parseGrade(form.get("grade"));
      if (Number.isNaN(grade)) return json({ error: "Grade must be a number from 1 to 12" }, 400, env);

      const existing = await env.DB.prepare(
        "SELECT id, name, disambiguator, grade, photo_key IS NOT NULL AS has_photo FROM master_students WHERE name_key = ?"
      ).bind(nameKey).all();

      if (existing.results.length > 0 && !forceDistinct) {
        return json({
          error: "duplicate",
          candidates: existing.results.map((r) => ({
            id: r.id, name: r.name, disambiguator: r.disambiguator || null, grade: r.grade ?? null, hasPhoto: !!r.has_photo,
          })),
        }, 409, env);
      }
      if (forceDistinct && !disambiguator) {
        return json({ error: "A distinguishing nickname or initial is required for a duplicate name" }, 400, env);
      }

      const photo = form.get("photo");
      const id = crypto.randomUUID();
      let photoKey = null;
      if (photo instanceof File && photo.size > 0) {
        photoKey = `${id}.${extFromType(photo.type)}`;
        await env.PHOTOS.put(photoKey, await photo.arrayBuffer(), { httpMetadata: { contentType: photo.type } });
      }
      const now = Date.now();
      await env.DB.prepare(
        "INSERT INTO master_students (id, name, name_key, disambiguator, grade, photo_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(id, name, nameKey, disambiguator, grade, photoKey, now, now).run();
      return json({ id, name, disambiguator, grade, hasPhoto: !!photoKey }, 201, env);
    }

    // Bulk grade-level update from admin's "Grade Levels" import. The client
    // does all the matching of CSV names to master rows (and the admin
    // reviews every non-exact pairing) — this route only ever writes the
    // grade column of rows that already exist, never names or photos.
    // Students not listed are left as they are, so uploading one grade's
    // file alone doesn't wipe the other grades.
    if (pathname === "/api/master/grades" && request.method === "POST") {
      if (!auth.isAdmin) return forbidden(env);
      const { assignments } = await request.json().catch(() => ({}));
      if (!Array.isArray(assignments) || assignments.length === 0) {
        return json({ error: "assignments[] is required" }, 400, env);
      }
      const now = Date.now();
      const stmts = [];
      for (const a of assignments) {
        const grade = parseGrade(a && a.grade);
        if (!a || !a.id || grade === null || Number.isNaN(grade)) {
          return json({ error: "Each assignment needs an id and a grade from 1 to 12" }, 400, env);
        }
        stmts.push(env.DB.prepare(
          "UPDATE master_students SET grade = ?, updated_at = ? WHERE id = ?"
        ).bind(grade, now, a.id.toString()));
      }
      const results = await env.DB.batch(stmts);
      const updated = results.reduce((n, r) => n + (r.meta.changes || 0), 0);
      return json({ updated }, 200, env);
    }

    const masterStudentMatch = pathname.match(/^\/api\/master\/students\/([\w-]+)$/);
    if (masterStudentMatch && request.method === "PATCH") {
      if (!auth.isAdmin) return forbidden(env);
      const row = await env.DB.prepare(
        "SELECT id, photo_key FROM master_students WHERE id = ?"
      ).bind(masterStudentMatch[1]).first();
      if (!row) return json({ error: "Not found" }, 404, env);
      const form = await request.formData();
      const sets = [], binds = [];
      if (form.has("name")) {
        const name = (form.get("name") || "").toString().trim();
        if (!name) return json({ error: "Name cannot be blank" }, 400, env);
        sets.push("name = ?", "name_key = ?");
        binds.push(name, normalizeNameKey(name));
      }
      if (form.has("disambiguator")) {
        sets.push("disambiguator = ?");
        binds.push((form.get("disambiguator") || "").toString().trim() || null);
      }
      if (form.has("grade")) {
        const grade = parseGrade(form.get("grade"));
        if (Number.isNaN(grade)) return json({ error: "Grade must be a number from 1 to 12" }, 400, env);
        sets.push("grade = ?");
        binds.push(grade);
      }
      const photo = form.get("photo");
      if (photo instanceof File && photo.size > 0) {
        if (row.photo_key) await env.PHOTOS.delete(row.photo_key);
        const newKey = `${row.id}.${extFromType(photo.type)}`;
        await env.PHOTOS.put(newKey, await photo.arrayBuffer(), { httpMetadata: { contentType: photo.type } });
        sets.push("photo_key = ?");
        binds.push(newKey);
      } else if ((form.get("removePhoto") || "").toString() === "true") {
        if (row.photo_key) await env.PHOTOS.delete(row.photo_key);
        sets.push("photo_key = ?");
        binds.push(null);
      }
      if (sets.length === 0) return json({ error: "Nothing to update" }, 400, env);
      sets.push("updated_at = ?");
      binds.push(Date.now());
      await env.DB.prepare(
        `UPDATE master_students SET ${sets.join(", ")} WHERE id = ?`
      ).bind(...binds, masterStudentMatch[1]).run();
      return json({ ok: true }, 200, env);
    }
    if (masterStudentMatch && request.method === "DELETE") {
      if (!auth.isAdmin) return forbidden(env);
      const row = await env.DB.prepare(
        "SELECT photo_key FROM master_students WHERE id = ?"
      ).bind(masterStudentMatch[1]).first();
      if (row) {
        if (row.photo_key) await env.PHOTOS.delete(row.photo_key);
        // deck_entries referencing this id are left as-is on purpose (soft
        // reference) — GET /api/decks/:id/cards resolves the dangling
        // reference to hasPhoto:false instead of erroring.
        await env.DB.prepare("DELETE FROM master_students WHERE id = ?").bind(masterStudentMatch[1]).run();
      }
      return json({ ok: true }, 200, env);
    }

    // Any authenticated user (not just admin) may fill in a photo for a
    // student who doesn't have one yet — deliberately narrower than the
    // admin-only PATCH above: this route only ever sets photo_key when it's
    // currently NULL (409 otherwise), and can never touch name/disambiguator
    // or replace/remove an existing photo. That's what makes it safe to open
    // up broadly — a non-admin can only ever fill a real gap, never
    // overwrite or vandalize the shared database.
    const masterPhotoAddMatch = pathname.match(/^\/api\/master\/students\/([\w-]+)\/photo$/);
    if (masterPhotoAddMatch && request.method === "POST") {
      const row = await env.DB.prepare(
        "SELECT id, photo_key FROM master_students WHERE id = ?"
      ).bind(masterPhotoAddMatch[1]).first();
      if (!row) return json({ error: "Not found" }, 404, env);
      if (row.photo_key) return json({ error: "This student already has a photo" }, 409, env);
      const form = await request.formData();
      const photo = form.get("photo");
      if (!(photo instanceof File) || photo.size === 0) {
        return json({ error: "A photo is required" }, 400, env);
      }
      const photoKey = `${row.id}.${extFromType(photo.type)}`;
      await env.PHOTOS.put(photoKey, await photo.arrayBuffer(), { httpMetadata: { contentType: photo.type } });
      await env.DB.prepare(
        "UPDATE master_students SET photo_key = ?, updated_at = ? WHERE id = ?"
      ).bind(photoKey, Date.now(), row.id).run();
      return json({ id: row.id, hasPhoto: true, photoUrl: `/api/master/photo/${row.id}` }, 200, env);
    }

    const masterPhotoMatch = pathname.match(/^\/api\/master\/photo\/([\w-]+)$/);
    if (masterPhotoMatch && request.method === "GET") {
      const row = await env.DB.prepare(
        "SELECT photo_key FROM master_students WHERE id = ?"
      ).bind(masterPhotoMatch[1]).first();
      if (!row || !row.photo_key) return json({ error: "Not found" }, 404, env);
      const object = await env.PHOTOS.get(row.photo_key);
      if (!object) return json({ error: "Not found" }, 404, env);
      return new Response(object.body, {
        headers: {
          "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
          ...corsHeaders(env),
        },
      });
    }

    // ---------- Decks (per-user, reference the shared master database) ----------

    if (pathname === "/api/decks" && request.method === "GET") {
      const { results } = await env.DB.prepare(`
        SELECT d.id, d.label, d.created_at,
          (SELECT COUNT(*) FROM deck_entries WHERE deck_entries.deck_id = d.id) AS entry_count
        FROM decks d WHERE d.user_id = ? ORDER BY d.created_at DESC
      `).bind(auth.userId).all();
      const decks = results.map((d) => ({ id: d.id, label: d.label, entryCount: d.entry_count, createdAt: d.created_at }));
      return json({ decks }, 200, env);
    }

    if (pathname === "/api/decks" && request.method === "POST") {
      const { label, entries } = await request.json().catch(() => ({}));
      const trimmedLabel = (label || "").toString().trim();
      if (!trimmedLabel) return json({ error: "A deck name is required" }, 400, env);
      if (!Array.isArray(entries) || entries.length === 0) {
        return json({ error: "At least one name is required" }, 400, env);
      }
      const deckId = crypto.randomUUID();
      const now = Date.now();
      const stmts = [env.DB.prepare(
        "INSERT INTO decks (id, user_id, label, created_at) VALUES (?, ?, ?, ?)"
      ).bind(deckId, auth.userId, trimmedLabel, now)];
      for (const e of entries) {
        const rawName = ((e && e.rawName) || "").toString().trim();
        if (!rawName) continue;
        const masterStudentId = (e && e.masterStudentId) || null;
        stmts.push(env.DB.prepare(
          "INSERT INTO deck_entries (id, deck_id, raw_name_text, master_student_id, created_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), deckId, rawName, masterStudentId, now));
      }
      await env.DB.batch(stmts);
      return json({ id: deckId, label: trimmedLabel }, 201, env);
    }

    const deckCardsMatch = pathname.match(/^\/api\/decks\/([\w-]+)\/cards$/);
    if (deckCardsMatch && request.method === "GET") {
      const deck = await env.DB.prepare(
        "SELECT id, label FROM decks WHERE id = ? AND user_id = ?"
      ).bind(deckCardsMatch[1], auth.userId).first();
      if (!deck) return json({ error: "Not found" }, 404, env);
      const { results } = await env.DB.prepare(`
        SELECT de.id AS entry_id, de.raw_name_text, ms.id AS master_id, ms.name AS master_name,
               ms.disambiguator, ms.grade, ms.photo_key IS NOT NULL AS has_photo
        FROM deck_entries de LEFT JOIN master_students ms ON de.master_student_id = ms.id
        WHERE de.deck_id = ? ORDER BY de.created_at
      `).bind(deckCardsMatch[1]).all();
      const cards = results.map((r) => ({
        id: r.entry_id,
        name: r.master_name || r.raw_name_text,
        disambiguator: r.disambiguator || null,
        grade: r.grade ?? null,
        hasPhoto: !!r.has_photo,
        photoUrl: r.master_id ? `/api/master/photo/${r.master_id}` : null,
        masterStudentId: r.master_id || null,
      }));
      return json({ label: deck.label, cards }, 200, env);
    }

    // Which of the logged-in user's own decks contain this master student —
    // the home-page "Find a Student" result uses it to say "In your 9th
    // period" (or "You don't have this student in a class"). Scoped by
    // user_id like every other deck route: a teacher only ever learns about
    // their own decks, never anyone else's.
    //
    // Primarily matched by the entry's bound master_student_id. As a
    // fallback, an entry that is NOT bound to any current master row (never
    // matched, or its row was replaced by an annual re-import) also counts
    // when its raw_name_text is exactly this student's name_key — but only
    // when no other master row shares that name_key, so a duplicate-name
    // pair is never guessed between. Read-only display, never a rebind;
    // deck-edit's "Check Database for Updates" is what actually fixes the
    // stale entry.
    const studentDecksMatch = pathname.match(/^\/api\/master\/students\/([\w-]+)\/decks$/);
    if (studentDecksMatch && request.method === "GET") {
      const ms = await env.DB.prepare(
        "SELECT id, name_key, (SELECT COUNT(*) FROM master_students s2 WHERE s2.name_key = master_students.name_key) AS same_name_count FROM master_students WHERE id = ?"
      ).bind(studentDecksMatch[1]).first();
      if (!ms) return json({ error: "Student not found" }, 404, env);
      const { results } = await env.DB.prepare(`
        SELECT DISTINCT d.id, d.label
        FROM decks d
        JOIN deck_entries de ON de.deck_id = d.id
        LEFT JOIN master_students cur ON cur.id = de.master_student_id
        WHERE d.user_id = ?
          AND (de.master_student_id = ?
               OR (cur.id IS NULL AND ? = 1 AND lower(trim(de.raw_name_text)) = ?))
        ORDER BY d.label
      `).bind(auth.userId, ms.id, ms.same_name_count, ms.name_key).all();
      return json({ decks: results.map((d) => ({ id: d.id, label: d.label })) }, 200, env);
    }

    const deckEntriesMatch = pathname.match(/^\/api\/decks\/([\w-]+)\/entries$/);
    if (deckEntriesMatch && request.method === "POST") {
      const deck = await env.DB.prepare(
        "SELECT id FROM decks WHERE id = ? AND user_id = ?"
      ).bind(deckEntriesMatch[1], auth.userId).first();
      if (!deck) return json({ error: "Not found" }, 404, env);
      const { rawName, masterStudentId } = await request.json().catch(() => ({}));
      const trimmed = (rawName || "").toString().trim();
      if (!trimmed) return json({ error: "A name is required" }, 400, env);

      const entryId = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO deck_entries (id, deck_id, raw_name_text, master_student_id, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(entryId, deckEntriesMatch[1], trimmed, masterStudentId || null, Date.now()).run();

      let card = { id: entryId, name: trimmed, disambiguator: null, grade: null, hasPhoto: false, photoUrl: null };
      if (masterStudentId) {
        const ms = await env.DB.prepare(
          "SELECT name, disambiguator, grade, photo_key IS NOT NULL AS has_photo FROM master_students WHERE id = ?"
        ).bind(masterStudentId).first();
        if (ms) {
          card = {
            id: entryId, name: ms.name, disambiguator: ms.disambiguator || null, grade: ms.grade ?? null,
            hasPhoto: !!ms.has_photo, photoUrl: ms.has_photo ? `/api/master/photo/${masterStudentId}` : null,
          };
        }
      }
      return json(card, 201, env);
    }

    const deckEntryMatch = pathname.match(/^\/api\/decks\/([\w-]+)\/entries\/([\w-]+)$/);
    if (deckEntryMatch && request.method === "DELETE") {
      const deck = await env.DB.prepare(
        "SELECT id FROM decks WHERE id = ? AND user_id = ?"
      ).bind(deckEntryMatch[1], auth.userId).first();
      if (!deck) return json({ error: "Not found" }, 404, env);
      await env.DB.prepare(
        "DELETE FROM deck_entries WHERE id = ? AND deck_id = ?"
      ).bind(deckEntryMatch[2], deckEntryMatch[1]).run();
      return json({ ok: true }, 200, env);
    }

    // Rebinds an existing entry to a master_students row found by a later
    // re-check (deck-edit.js's "Check Database for Updates") — the entry's
    // master_student_id was NULL (never matched at deck-build time, or the
    // master row it pointed at was since deleted/replaced), and the user has
    // now confirmed which current master row it actually is. Only ever binds
    // to a row that exists; never creates one or touches raw_name_text.
    if (deckEntryMatch && request.method === "PATCH") {
      const deck = await env.DB.prepare(
        "SELECT id FROM decks WHERE id = ? AND user_id = ?"
      ).bind(deckEntryMatch[1], auth.userId).first();
      if (!deck) return json({ error: "Not found" }, 404, env);
      const { masterStudentId } = await request.json().catch(() => ({}));
      if (!masterStudentId) return json({ error: "masterStudentId is required" }, 400, env);
      const ms = await env.DB.prepare(
        "SELECT id, name, disambiguator, grade, photo_key IS NOT NULL AS has_photo FROM master_students WHERE id = ?"
      ).bind(masterStudentId).first();
      if (!ms) return json({ error: "Student not found" }, 404, env);
      const result = await env.DB.prepare(
        "UPDATE deck_entries SET master_student_id = ? WHERE id = ? AND deck_id = ?"
      ).bind(ms.id, deckEntryMatch[2], deckEntryMatch[1]).run();
      if (result.meta.changes === 0) return json({ error: "Not found" }, 404, env);
      return json({
        id: deckEntryMatch[2], name: ms.name, disambiguator: ms.disambiguator || null, grade: ms.grade ?? null,
        hasPhoto: !!ms.has_photo, photoUrl: ms.has_photo ? `/api/master/photo/${ms.id}` : null,
        masterStudentId: ms.id,
      }, 200, env);
    }

    const deckMatch = pathname.match(/^\/api\/decks\/([\w-]+)$/);
    if (deckMatch && request.method === "PATCH") {
      const { label } = await request.json().catch(() => ({}));
      const trimmedLabel = (label || "").toString().trim();
      if (!trimmedLabel) return json({ error: "A deck name is required" }, 400, env);
      const result = await env.DB.prepare(
        "UPDATE decks SET label = ? WHERE id = ? AND user_id = ?"
      ).bind(trimmedLabel, deckMatch[1], auth.userId).run();
      if (result.meta.changes === 0) return json({ error: "Not found" }, 404, env);
      return json({ ok: true, label: trimmedLabel }, 200, env);
    }
    if (deckMatch && request.method === "DELETE") {
      const row = await env.DB.prepare(
        "SELECT id FROM decks WHERE id = ? AND user_id = ?"
      ).bind(deckMatch[1], auth.userId).first();
      if (row) {
        await env.DB.batch([
          env.DB.prepare("DELETE FROM deck_entries WHERE deck_id = ?").bind(deckMatch[1]),
          env.DB.prepare("DELETE FROM decks WHERE id = ? AND user_id = ?").bind(deckMatch[1], auth.userId),
        ]);
      }
      return json({ ok: true }, 200, env);
    }

    // ---------- Admin ----------

    if (pathname === "/api/admin/users" && request.method === "GET") {
      if (!auth.isAdmin) return forbidden(env);
      const { results } = await env.DB.prepare(`
        SELECT u.id, u.email, u.is_admin, u.created_at,
          (SELECT COUNT(*) FROM decks WHERE decks.user_id = u.id) AS decks_count
        FROM users u ORDER BY u.created_at
      `).all();
      return json({ users: results }, 200, env);
    }

    const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([\w-]+)$/);
    if (adminUserMatch && request.method === "DELETE") {
      if (!auth.isAdmin) return forbidden(env);
      const targetId = adminUserMatch[1];
      if (targetId === auth.userId) {
        return json({ error: "You cannot delete your own account" }, 400, env);
      }
      const targetUser = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(targetId).first();
      if (!targetUser) return json({ error: "Not found" }, 404, env);

      // Deleting a user only removes their own decks/deck_entries (and
      // sessions, which logs them out everywhere at once) — never
      // master_students, which is shared, admin-owned data not tied to any
      // one user.
      await env.DB.batch([
        env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(targetId),
        env.DB.prepare(
          "DELETE FROM deck_entries WHERE deck_id IN (SELECT id FROM decks WHERE user_id = ?)"
        ).bind(targetId),
        env.DB.prepare("DELETE FROM decks WHERE user_id = ?").bind(targetId),
        env.DB.prepare("DELETE FROM users WHERE id = ?").bind(targetId),
      ]);
      return json({ ok: true }, 200, env);
    }

    // ---------- OCR (used by the master-import and deck-builder pipelines) ----------

    if (pathname === "/api/import/ocr-batch" && request.method === "POST") {
      const { images, instruction } = await request.json().catch(() => ({}));
      if (!Array.isArray(images) || images.length === 0 || !instruction) {
        return json({ error: "images[] and instruction are required" }, 400, env);
      }
      try {
        const texts = await ocrBatch(env, images, instruction);
        return json({ texts }, 200, env);
      } catch (err) {
        return json({ error: err.message || "OCR failed" }, 502, env);
      }
    }

    return json({ error: "Not found" }, 404, env);
  },
};
