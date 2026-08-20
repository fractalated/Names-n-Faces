const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
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

// ---------- base64url / HMAC / token ----------

function base64UrlEncode(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlDecode(str) {
  return atob(str.replace(/-/g, "+").replace(/_/g, "/"));
}

async function hmac(key, message) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return base64UrlEncode(String.fromCharCode(...new Uint8Array(sig)));
}

// Constant-time string comparison (both inputs expected to be same-alphabet
// base64url-ish strings) to avoid timing side channels on signature/hash checks.
function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signToken(env, payloadObj) {
  const payload = base64UrlEncode(JSON.stringify(payloadObj));
  const sig = await hmac(env.TOKEN_SECRET, payload);
  return `${payload}.${sig}`;
}

async function verifyToken(env, token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expectedSig = await hmac(env.TOKEN_SECRET, payload);
  if (!constantTimeEqual(sig, expectedSig)) return null;
  let data;
  try {
    data = JSON.parse(base64UrlDecode(payload));
  } catch {
    return null;
  }
  if (!data.sub || !data.exp || Date.now() >= data.exp) return null;
  return { userId: data.sub, isAdmin: !!data.admin };
}

async function requireAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return verifyToken(env, token);
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

function slugifyWord(s) {
  return (s || "").toString().toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
}

function extFromType(type) {
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  return "jpg";
}

// Resolve a collection by id (must belong to the user), or find-or-create by
// label (slugified). Returns null if neither a valid id nor a usable label
// was given. Shared by /api/people (POST) and /api/import/replace-collection
// so neither route needs to know about a hardcoded collection list anymore.
async function getOrCreateCollection(db, userId, { collectionId, label }) {
  if (collectionId) {
    const row = await db.prepare(
      "SELECT id, slug, label FROM collections WHERE id = ? AND user_id = ?"
    ).bind(collectionId, userId).first();
    return row || null;
  }
  const trimmedLabel = (label || "").toString().trim();
  const slug = slugifyWord(trimmedLabel);
  if (!slug) return null;
  const existing = await db.prepare(
    "SELECT id, slug, label FROM collections WHERE user_id = ? AND slug = ?"
  ).bind(userId, slug).first();
  if (existing) return existing;
  const id = crypto.randomUUID();
  await db.prepare(
    "INSERT INTO collections (id, user_id, slug, label, sort_order, created_at) VALUES (?, ?, ?, ?, 0, ?)"
  ).bind(id, userId, slug, trimmedLabel, Date.now()).run();
  return { id, slug, label: trimmedLabel };
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (pathname === "/api/signup" && request.method === "POST") {
      const { email, password } = await request.json().catch(() => ({}));
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
      const token = await signToken(env, { sub: id, admin: false, exp: Date.now() + TOKEN_TTL_MS });
      return json({ token }, 201, env);
    }

    if (pathname === "/api/login" && request.method === "POST") {
      const { email, password } = await request.json().catch(() => ({}));
      const normalizedEmail = normalizeEmail(email);
      const user = await env.DB.prepare(
        "SELECT id, password_hash, is_admin FROM users WHERE email = ?"
      ).bind(normalizedEmail).first();
      if (!user || !(await verifyPassword((password || "").toString(), user.password_hash))) {
        return json({ error: "Invalid email or password" }, 401, env);
      }
      const token = await signToken(env, { sub: user.id, admin: !!user.is_admin, exp: Date.now() + TOKEN_TTL_MS });
      return json({ token }, 200, env);
    }

    const auth = await requireAuth(request, env);
    if (!auth) {
      return json({ error: "Unauthorized" }, 401, env);
    }

    if (pathname === "/api/me" && request.method === "GET") {
      const row = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(auth.userId).first();
      return json({ email: row ? row.email : null, isAdmin: auth.isAdmin }, 200, env);
    }

    // ---------- Collections ----------

    if (pathname === "/api/collections" && request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT id, slug, label, sort_order FROM collections WHERE user_id = ? ORDER BY sort_order, label"
      ).bind(auth.userId).all();
      return json({ collections: results }, 200, env);
    }

    if (pathname === "/api/collections" && request.method === "POST") {
      const { label } = await request.json().catch(() => ({}));
      const trimmed = (label || "").toString().trim();
      const slug = slugifyWord(trimmed);
      if (!slug) return json({ error: "A collection name is required" }, 400, env);
      const existing = await env.DB.prepare(
        "SELECT id FROM collections WHERE user_id = ? AND slug = ?"
      ).bind(auth.userId, slug).first();
      if (existing) return json({ error: "A collection with that name already exists" }, 409, env);
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO collections (id, user_id, slug, label, sort_order, created_at) VALUES (?, ?, ?, ?, 0, ?)"
      ).bind(id, auth.userId, slug, trimmed, Date.now()).run();
      return json({ id, slug, label: trimmed }, 201, env);
    }

    const collectionMatch = pathname.match(/^\/api\/collections\/([\w-]+)$/);
    if (collectionMatch && request.method === "PATCH") {
      const row = await env.DB.prepare(
        "SELECT id FROM collections WHERE id = ? AND user_id = ?"
      ).bind(collectionMatch[1], auth.userId).first();
      if (!row) return json({ error: "Not found" }, 404, env);
      const { label } = await request.json().catch(() => ({}));
      const trimmed = (label || "").toString().trim();
      if (!trimmed) return json({ error: "A collection name is required" }, 400, env);
      await env.DB.prepare(
        "UPDATE collections SET label = ? WHERE id = ? AND user_id = ?"
      ).bind(trimmed, collectionMatch[1], auth.userId).run();
      return json({ ok: true }, 200, env);
    }
    if (collectionMatch && request.method === "DELETE") {
      const row = await env.DB.prepare(
        "SELECT slug FROM collections WHERE id = ? AND user_id = ?"
      ).bind(collectionMatch[1], auth.userId).first();
      if (!row) return json({ error: "Not found" }, 404, env);
      const inUse = await env.DB.prepare(
        "SELECT COUNT(*) as n FROM people WHERE user_id = ? AND collection = ?"
      ).bind(auth.userId, row.slug).first();
      if (inUse.n > 0) {
        return json({ error: "This collection still has students in it — remove or move them first" }, 409, env);
      }
      await env.DB.prepare(
        "DELETE FROM collections WHERE id = ? AND user_id = ?"
      ).bind(collectionMatch[1], auth.userId).run();
      return json({ ok: true }, 200, env);
    }

    // ---------- Admin ----------

    if (pathname === "/api/admin/users" && request.method === "GET") {
      if (!auth.isAdmin) return forbidden(env);
      const { results } = await env.DB.prepare(`
        SELECT u.id, u.email, u.is_admin, u.created_at,
          (SELECT COUNT(*) FROM people WHERE people.user_id = u.id) AS people_count,
          (SELECT COUNT(*) FROM collections WHERE collections.user_id = u.id) AS collections_count
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

      const { results: photoRows } = await env.DB.prepare(
        "SELECT photo_key FROM people WHERE user_id = ?"
      ).bind(targetId).all();
      const keys = photoRows.map((r) => r.photo_key);
      for (let i = 0; i < keys.length; i += 1000) {
        await env.PHOTOS.delete(keys.slice(i, i + 1000));
      }
      // Explicit ordered deletes rather than relying on D1's SQLite FK cascade,
      // which isn't reliably enforced across requests.
      await env.DB.batch([
        env.DB.prepare("DELETE FROM people WHERE user_id = ?").bind(targetId),
        env.DB.prepare("DELETE FROM collections WHERE user_id = ?").bind(targetId),
        env.DB.prepare("DELETE FROM users WHERE id = ?").bind(targetId),
      ]);
      return json({ ok: true }, 200, env);
    }

    // ---------- PDF import ----------

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

    if (pathname === "/api/import/replace-collection" && request.method === "POST") {
      const form = await request.formData();
      const collectionId = (form.get("collectionId") || "").toString().trim() || null;
      const newCollectionLabel = (form.get("newCollectionLabel") || "").toString().trim();
      const collection = await getOrCreateCollection(env.DB, auth.userId, {
        collectionId, label: newCollectionLabel,
      });
      if (!collection) {
        return json({ error: "Pick an existing collection or name a new one" }, 400, env);
      }
      const names = form.getAll("name").map((n) => n.toString());
      const photos = form.getAll("photo");
      if (names.length !== photos.length) {
        return json({ error: "name/photo count mismatch" }, 400, env);
      }

      const existing = await env.DB.prepare(
        "SELECT photo_key FROM people WHERE user_id = ? AND collection = ?"
      ).bind(auth.userId, collection.slug).all();
      for (const row of existing.results) {
        await env.PHOTOS.delete(row.photo_key);
      }
      await env.DB.prepare(
        "DELETE FROM people WHERE user_id = ? AND collection = ?"
      ).bind(auth.userId, collection.slug).run();

      const inserted = [];
      for (let i = 0; i < names.length; i++) {
        const name = names[i].trim();
        const photo = photos[i];
        if (!name || !(photo instanceof File)) continue;
        const id = crypto.randomUUID();
        const key = `${id}.${extFromType(photo.type)}`;
        await env.PHOTOS.put(key, await photo.arrayBuffer(), {
          httpMetadata: { contentType: photo.type },
        });
        await env.DB.prepare(
          "INSERT INTO people (id, name, photo_key, collection, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(id, name, key, collection.slug, auth.userId, Date.now()).run();
        inserted.push({ id, name });
      }
      return json({
        collection: { id: collection.id, slug: collection.slug, label: collection.label },
        count: inserted.length,
        people: inserted,
      }, 200, env);
    }

    // ---------- People ----------

    if (pathname === "/api/people" && request.method === "GET") {
      const collectionParam = url.searchParams.get("collection");
      const query = collectionParam && collectionParam !== "all"
        ? env.DB.prepare(
            "SELECT id, name, collection FROM people WHERE user_id = ? AND collection = ? ORDER BY created_at DESC"
          ).bind(auth.userId, collectionParam)
        : env.DB.prepare(
            "SELECT id, name, collection FROM people WHERE user_id = ? ORDER BY created_at DESC"
          ).bind(auth.userId);
      const { results } = await query.all();
      const people = results.map((p) => ({
        id: p.id, name: p.name, collection: p.collection, photoUrl: `/api/photo/${p.id}`,
      }));
      return json({ people }, 200, env);
    }

    if (pathname === "/api/people" && request.method === "POST") {
      const form = await request.formData();
      const name = (form.get("name") || "").toString().trim();
      const photo = form.get("photo");
      const collectionId = (form.get("collectionId") || "").toString().trim() || null;
      const newCollectionLabel = (form.get("newCollectionLabel") || "").toString().trim();
      if (!name || !(photo instanceof File)) {
        return json({ error: "Name and photo are required" }, 400, env);
      }
      const collection = await getOrCreateCollection(env.DB, auth.userId, {
        collectionId, label: newCollectionLabel,
      });
      if (!collection) {
        return json({ error: "Pick an existing collection or name a new one" }, 400, env);
      }
      const id = crypto.randomUUID();
      const key = `${id}.${extFromType(photo.type)}`;
      await env.PHOTOS.put(key, await photo.arrayBuffer(), {
        httpMetadata: { contentType: photo.type },
      });
      await env.DB.prepare(
        "INSERT INTO people (id, name, photo_key, collection, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(id, name, key, collection.slug, auth.userId, Date.now()).run();
      return json({ id, name, collection: collection.slug, photoUrl: `/api/photo/${id}` }, 201, env);
    }

    const photoMatch = pathname.match(/^\/api\/photo\/([\w-]+)$/);
    if (photoMatch && request.method === "GET") {
      const row = await env.DB.prepare(
        "SELECT photo_key FROM people WHERE id = ? AND user_id = ?"
      ).bind(photoMatch[1], auth.userId).first();
      if (!row) return json({ error: "Not found" }, 404, env);
      const object = await env.PHOTOS.get(row.photo_key);
      if (!object) return json({ error: "Not found" }, 404, env);
      return new Response(object.body, {
        headers: {
          "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
          ...corsHeaders(env),
        },
      });
    }

    const personMatch = pathname.match(/^\/api\/people\/([\w-]+)$/);
    if (personMatch && request.method === "DELETE") {
      const row = await env.DB.prepare(
        "SELECT photo_key FROM people WHERE id = ? AND user_id = ?"
      ).bind(personMatch[1], auth.userId).first();
      if (row) {
        await env.PHOTOS.delete(row.photo_key);
        await env.DB.prepare(
          "DELETE FROM people WHERE id = ? AND user_id = ?"
        ).bind(personMatch[1], auth.userId).run();
      }
      return json({ ok: true }, 200, env);
    }

    return json({ error: "Not found" }, 404, env);
  },
};
