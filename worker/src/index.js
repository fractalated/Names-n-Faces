const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env) },
  });
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
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signToken(env, exp) {
  const payload = btoa(JSON.stringify({ exp })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const sig = await hmac(env.ADMIN_PASSWORD, payload);
  return `${payload}.${sig}`;
}

async function verifyToken(env, token) {
  if (!token) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expectedSig = await hmac(env.ADMIN_PASSWORD, payload);
  if (sig !== expectedSig) return false;
  try {
    const { exp } = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    return Date.now() < exp;
  } catch {
    return false;
  }
}

async function requireAuth(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return verifyToken(env, token);
}

function extFromType(type) {
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  return "jpg";
}

const COLLECTIONS = [
  "period-1", "period-2", "period-3", "period-4", "period-5",
  "period-6", "period-7", "period-8", "period-9", "chapel",
];

function patternToCollection(pattern) {
  if (!pattern) return null;
  const p = pattern.toString().trim().toLowerCase();
  if (p === "chapel") return "chapel";
  const n = parseInt(p, 10);
  if (n >= 1 && n <= 9) return `period-${n}`;
  return null;
}

const ROSTER_TOOL = {
  name: "report_roster_page",
  description: "Report the class/period identifier and each student's name and photo location found on a school class roster page.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The value printed after 'Pattern:' near the top of the page (e.g. '1', '4', 'chapel'). Empty string if not present.",
      },
      students: {
        type: "array",
        description: "Every student listed on the page, in the order their photos appear (left to right, top to bottom).",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Student name exactly as printed, e.g. 'Bradshaw, Abby'." },
            hasPhoto: { type: "boolean", description: "True if this student has a visible headshot photo on the page." },
            bbox: {
              type: "array",
              items: { type: "number" },
              description: "[x0,y0,x1,y1] as fractions (0 to 1) of the full image width/height, tightly bounding ONLY the photo itself (not the printed name text below it). Empty array if hasPhoto is false.",
            },
          },
          required: ["name", "hasPhoto", "bbox"],
        },
      },
    },
    required: ["pattern", "students"],
  },
};

async function extractRosterPage(env, imageBase64, mediaType) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 4096,
      tools: [ROSTER_TOOL],
      tool_choice: { type: "tool", name: "report_roster_page" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "This image is one page of a school 'Class Roster' export. Near the top it has a 'Pattern:' field giving the period number or 'chapel'. Below that is a grid of student headshot photos with the student's name printed in bold directly under each photo. Extract the pattern value and every student's name with a tight bounding box around just their photo. If a student's photo appears missing, blank, or broken, set hasPhoto to false and bbox to an empty array, but still include their name.",
            },
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: imageBase64 },
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Anthropic API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const toolUse = data.content.find((c) => c.type === "tool_use" && c.name === "report_roster_page");
  if (!toolUse) throw new Error("No structured extraction returned");

  const collection = patternToCollection(toolUse.input.pattern);
  return { collection, pattern: toolUse.input.pattern, students: toolUse.input.students };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (pathname === "/api/login" && request.method === "POST") {
      const { password } = await request.json().catch(() => ({}));
      if (password !== env.ADMIN_PASSWORD) {
        return json({ error: "Invalid password" }, 401, env);
      }
      const token = await signToken(env, Date.now() + TOKEN_TTL_MS);
      return json({ token }, 200, env);
    }

    if (!(await requireAuth(request, env))) {
      return json({ error: "Unauthorized" }, 401, env);
    }

    if (pathname === "/api/import/extract-page" && request.method === "POST") {
      const { image, mediaType } = await request.json().catch(() => ({}));
      if (!image || !mediaType) {
        return json({ error: "image and mediaType are required" }, 400, env);
      }
      try {
        const extracted = await extractRosterPage(env, image, mediaType);
        return json(extracted, 200, env);
      } catch (err) {
        return json({ error: err.message || "Extraction failed" }, 502, env);
      }
    }

    if (pathname === "/api/import/replace-collection" && request.method === "POST") {
      const form = await request.formData();
      const collection = (form.get("collection") || "").toString().trim();
      if (!COLLECTIONS.includes(collection)) {
        return json({ error: "Valid collection is required" }, 400, env);
      }
      const names = form.getAll("name").map((n) => n.toString());
      const photos = form.getAll("photo");
      if (names.length !== photos.length) {
        return json({ error: "name/photo count mismatch" }, 400, env);
      }

      const existing = await env.DB.prepare("SELECT photo_key FROM people WHERE collection = ?")
        .bind(collection).all();
      for (const row of existing.results) {
        await env.PHOTOS.delete(row.photo_key);
      }
      await env.DB.prepare("DELETE FROM people WHERE collection = ?").bind(collection).run();

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
          "INSERT INTO people (id, name, photo_key, collection, created_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(id, name, key, collection, Date.now()).run();
        inserted.push({ id, name });
      }
      return json({ collection, count: inserted.length, people: inserted }, 200, env);
    }

    if (pathname === "/api/people" && request.method === "GET") {
      const collection = url.searchParams.get("collection");
      const query = collection && collection !== "all"
        ? env.DB.prepare("SELECT id, name, collection FROM people WHERE collection = ? ORDER BY created_at DESC").bind(collection)
        : env.DB.prepare("SELECT id, name, collection FROM people ORDER BY created_at DESC");
      const { results } = await query.all();
      const people = results.map((p) => ({
        id: p.id, name: p.name, collection: p.collection, photoUrl: `/api/photo/${p.id}`,
      }));
      return json({ people }, 200, env);
    }

    if (pathname === "/api/people" && request.method === "POST") {
      const form = await request.formData();
      const name = (form.get("name") || "").toString().trim();
      const collection = (form.get("collection") || "").toString().trim();
      const photo = form.get("photo");
      if (!name || !(photo instanceof File) || !COLLECTIONS.includes(collection)) {
        return json({ error: "Name, valid collection, and photo are required" }, 400, env);
      }
      const id = crypto.randomUUID();
      const key = `${id}.${extFromType(photo.type)}`;
      await env.PHOTOS.put(key, await photo.arrayBuffer(), {
        httpMetadata: { contentType: photo.type },
      });
      await env.DB.prepare(
        "INSERT INTO people (id, name, photo_key, collection, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(id, name, key, collection, Date.now()).run();
      return json({ id, name, collection, photoUrl: `/api/photo/${id}` }, 201, env);
    }

    const photoMatch = pathname.match(/^\/api\/photo\/([\w-]+)$/);
    if (photoMatch && request.method === "GET") {
      const row = await env.DB.prepare("SELECT photo_key FROM people WHERE id = ?")
        .bind(photoMatch[1]).first();
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
      const row = await env.DB.prepare("SELECT photo_key FROM people WHERE id = ?")
        .bind(personMatch[1]).first();
      if (row) {
        await env.PHOTOS.delete(row.photo_key);
        await env.DB.prepare("DELETE FROM people WHERE id = ?").bind(personMatch[1]).run();
      }
      return json({ ok: true }, 200, env);
    }

    return json({ error: "Not found" }, 404, env);
  },
};
