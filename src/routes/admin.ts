/**
 * Wihda Backend - Admin Routes
 *
 * All routes require a valid JWT with role = 'admin'.
 * Validated server-side via requireAdmin middleware.
 *
 * GET    /v1/admin/stats                        — platform statistics
 * GET    /v1/admin/users                        — full user list
 * GET    /v1/admin/neighborhoods                — active neighborhood list (full + member_count)
 * POST   /v1/admin/neighborhoods                — create neighborhood (bypasses overlap check)
 * PUT    /v1/admin/neighborhoods/:id            — update neighborhood
 * DELETE /v1/admin/neighborhoods/:id            — soft-delete neighborhood (is_active=0)
 * GET    /v1/admin/campaigns                    — full campaign list
 * POST   /v1/admin/campaigns                    — create activity (all or targeted neighborhoods)
 * PUT    /v1/admin/campaigns/:id                — update an activity
 * DELETE /v1/admin/campaigns/:id                — delete an activity
 * POST   /v1/admin/campaigns/ingest             — trigger scraper run (returns job_id)
 * GET    /v1/admin/campaigns/ingest/status      — poll scraper job status
 * POST   /v1/admin/campaigns/generate           — AI-generate an activity from a text prompt
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { errorResponse } from "../lib/utils";
import { authMiddleware, requireAdmin, getAuthContext } from "../middleware/auth";
import { handleAdminScrapeWithJob } from "../queues/campaign";
import { createNeighborhood } from "../lib/db";

const GEMINI_MODEL    = "gemini-2.5-flash-lite";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const admin = new Hono<{ Bindings: Env }>();

// Every /v1/admin/* route requires a valid admin JWT
admin.use("*", authMiddleware, requireAdmin);

// ─── GET /v1/admin/stats ──────────────────────────────────────────────────────

admin.get("/stats", async (c) => {
  const db = c.env.DB;

  const [
    usersRow,
    submissionsRow,
    approvedRow,
    rejectedRow,
    coinsRow,
    campaignsRow,
  ] = await Promise.all([
    db.prepare("SELECT COUNT(*) as cnt FROM users").first<{ cnt: number }>(),
    db.prepare("SELECT COUNT(*) as cnt FROM cleanify_submissions").first<{ cnt: number }>(),
    db.prepare("SELECT COUNT(*) as cnt FROM cleanify_submissions WHERE status = 'approved'").first<{ cnt: number }>(),
    db.prepare("SELECT COUNT(*) as cnt FROM cleanify_submissions WHERE status = 'rejected'").first<{ cnt: number }>(),
    db.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM coin_ledger_entries WHERE amount > 0").first<{ total: number }>(),
    db.prepare("SELECT COUNT(*) as cnt FROM campaigns WHERE status = 'active'").first<{ cnt: number }>(),
  ]);

  return c.json({
    success: true,
    data: {
      users:            usersRow?.cnt    ?? 0,
      submissions:      submissionsRow?.cnt ?? 0,
      approved:         approvedRow?.cnt  ?? 0,
      rejected:         rejectedRow?.cnt  ?? 0,
      coins_awarded:    coinsRow?.total   ?? 0,
      active_campaigns: campaignsRow?.cnt ?? 0,
    },
  });
});

// ─── GET /v1/admin/users ──────────────────────────────────────────────────────

admin.get("/users", async (c) => {
  const db = c.env.DB;

  const { results } = await db
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.role,
              un.neighborhood_id, n.name as neighborhood_name,
              u.created_at,
              COALESCE(SUM(CASE WHEN l.amount > 0 AND l.status = 'valid' THEN l.amount ELSE 0 END), 0) as coins_earned
       FROM users u
       LEFT JOIN user_neighborhoods un ON un.user_id = u.id AND un.is_primary = 1 AND un.left_at IS NULL
       LEFT JOIN neighborhoods n ON n.id = un.neighborhood_id
       LEFT JOIN coin_ledger_entries l ON l.user_id = u.id
       WHERE u.deleted_at IS NULL
       GROUP BY u.id
       ORDER BY u.created_at DESC
       LIMIT 500`,
    )
    .all();

  return c.json({ success: true, data: results });
});

// ─── GET /v1/admin/neighborhoods ──────────────────────────────────────────────

admin.get("/neighborhoods", async (c) => {
  const { results } = await c.env.DB
    .prepare(
      `SELECT n.*,
              (SELECT COUNT(*) FROM user_neighborhoods un WHERE un.neighborhood_id = n.id AND un.left_at IS NULL) AS member_count
       FROM neighborhoods n
       WHERE n.is_active = 1
       ORDER BY n.name ASC`,
    )
    .all();
  return c.json({ success: true, data: results });
});

// ─── POST /v1/admin/neighborhoods ─────────────────────────────────────────────

admin.post("/neighborhoods", async (c) => {
  let body: any;
  try { body = await c.req.json(); }
  catch { return errorResponse("INVALID_BODY", "JSON body required", 400); }

  const { name, description, color, center_lat, center_lng, radius_meters, city, country } = body;

  if (!name || center_lat == null || center_lng == null || !radius_meters || !city) {
    return errorResponse("MISSING_FIELDS", "name, center_lat, center_lng, radius_meters, city required", 400);
  }

  try {
    const created = await createNeighborhood(c.env.DB, {
      name, description, color, center_lat, center_lng, radius_meters, city, country,
      created_by: getAuthContext(c)!.userId,
    });
    return c.json({ success: true, data: { neighborhood: created } }, 201);
  } catch (err: any) {
    return errorResponse("DB_ERROR", err?.message || "Failed to create neighborhood", 500);
  }
});

// ─── PUT /v1/admin/neighborhoods/:id ──────────────────────────────────────────

admin.put("/neighborhoods/:id", async (c) => {
  const { id } = c.req.param();
  let body: any;
  try { body = await c.req.json(); }
  catch { return errorResponse("INVALID_BODY", "JSON body required", 400); }

  const { name, description, color, center_lat, center_lng, radius_meters, city, country } = body;

  if (!name || center_lat == null || center_lng == null || !radius_meters || !city) {
    return errorResponse("MISSING_FIELDS", "name, center_lat, center_lng, radius_meters, city required", 400);
  }

  const now = new Date().toISOString();
  const { meta } = await c.env.DB
    .prepare(
      `UPDATE neighborhoods SET
         name           = ?,
         description    = ?,
         color          = ?,
         center_lat     = ?,
         center_lng     = ?,
         radius_meters  = ?,
         city           = ?,
         country        = ?,
         updated_at     = ?
       WHERE id = ? AND is_active = 1`,
    )
    .bind(
      name,
      description    ?? null,
      color          ?? "#14ae5c",
      center_lat,
      center_lng,
      radius_meters,
      city,
      country        ?? "DZ",
      now,
      id,
    )
    .run();

  if (meta.changes === 0) {
    return errorResponse("NOT_FOUND", "Neighborhood not found", 404);
  }

  return c.json({ success: true });
});

// ─── DELETE /v1/admin/neighborhoods/:id ───────────────────────────────────────

admin.delete("/neighborhoods/:id", async (c) => {
  const { id } = c.req.param();
  const now = new Date().toISOString();
  await c.env.DB
    .prepare("UPDATE neighborhoods SET is_active = 0, updated_at = ? WHERE id = ?")
    .bind(now, id)
    .run();
  return c.json({ success: true });
});

// ─── GET /v1/admin/campaigns ──────────────────────────────────────────────────

admin.get("/campaigns", async (c) => {
  const db = c.env.DB;

  const { results } = await db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM campaign_participants p WHERE p.campaign_id = c.id) AS participant_count
       FROM campaigns c
       ORDER BY c.created_at DESC
       LIMIT 300`,
    )
    .all();

  return c.json({ success: true, data: results });
});

// ─── POST /v1/admin/campaigns/generate ───────────────────────────────────────
// Must be defined BEFORE /:id routes.

admin.post("/campaigns/generate", async (c) => {
  let body: any;
  try { body = await c.req.json(); }
  catch { return errorResponse("INVALID_BODY", "JSON body required", 400); }

  const { prompt } = body;
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return errorResponse("MISSING_FIELDS", "prompt is required", 400);
  }

  const today = new Date().toISOString().split("T")[0];

  const geminiPrompt = `You are an activity planner for an Algerian civic community app called Wihda.
The admin wants to create a community activity based on this description:
"${prompt.trim()}"

Today's date is ${today}. Generate exactly ONE activity as a JSON object (no markdown fences, no extra text) with these fields:
{
  "title": "string (required, concise)",
  "subtitle": "string or null - short tagline",
  "description": "string (2-4 sentences, engaging)",
  "organizer": "string or null - who is organizing",
  "organizer_logo": null,
  "location": "string or null - city or venue in Algeria",
  "start_dt": "ISO 8601 datetime (required, set to a reasonable future date based on the prompt)",
  "end_dt": "ISO 8601 datetime or null",
  "url": null,
  "contact_phone": "string or null",
  "contact_email": "string or null",
  "coin_reward": integer between 50 and 500 based on activity effort level
}

Return ONLY the JSON object, no other text.`;

  let event: any = null;
  try {
    const geminiRes = await fetch(
      `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${c.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: geminiPrompt }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 1024 },
        }),
      },
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error("[admin/generate] Gemini error:", errText);
      return errorResponse("AI_ERROR", "Gemini API error", 500);
    }

    const geminiData: any = await geminiRes.json();
    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const cleaned = rawText.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    event = JSON.parse(cleaned);
  } catch (err: any) {
    console.error("[admin/generate] Failed to parse Gemini response:", err);
    return errorResponse("AI_PARSE_ERROR", "Failed to parse AI response", 500);
  }

  if (!event?.title || !event?.start_dt) {
    return errorResponse("AI_PARSE_ERROR", "AI returned incomplete event data", 500);
  }

  // Generate AI images
  const images: string[] = [];
  const baseKey = `campaign-images/${Date.now()}-${Math.random().toString(36).slice(2)}`;

  for (let i = 0; i < 3; i++) {
    try {
      const imgPrompt = buildGenerateImagePrompt(event, prompt, i);
      const result = await (c.env.AI as any).run("@cf/black-forest-labs/flux-1-schnell", {
        prompt: imgPrompt,
        steps: 4,
      }) as { image: string };

      if (!result?.image) continue;

      const binaryStr = atob(result.image);
      const bytes = new Uint8Array(binaryStr.length);
      for (let j = 0; j < binaryStr.length; j++) bytes[j] = binaryStr.charCodeAt(j);

      const key = `${baseKey}-${i}.png`;
      await c.env.STORAGE.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
      images.push(`${c.env.WORKERS_BASE_URL}/v1/uploads/${key}`);
    } catch (err) {
      console.error(`[admin/generate] Image ${i} failed:`, err);
    }
  }

  return c.json({
    success: true,
    data: {
      ...event,
      images,
      image_url: images[0] ?? null,
    },
  });
});

function buildGenerateImagePrompt(event: any, _userPrompt: string, variant: number): string {
  const title    = event.title    || "community activity";
  const location = event.location || "Algeria";
  const org      = event.organizer || "community volunteers";

  const angles = [
    `Wide shot of diverse Algerian community members participating in: ${title}, at ${location}`,
    `Close-up of smiling volunteers working together on a civic activity: ${title}`,
    `Documentary photo of people engaged in ${title} in an Algerian neighbourhood, organised by ${org}`,
  ];

  return `${angles[variant % 3]}. Natural daylight, photorealistic, warm colours, social impact, documentary style, high detail, 4k quality. No text or logos.`;
}

// ─── POST /v1/admin/campaigns/ingest ─────────────────────────────────────────
// Must be defined BEFORE /:id routes to avoid matching "ingest" as an id.

admin.post("/campaigns/ingest", async (c) => {
  const jobId = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, "0")).join("");

  // waitUntil keeps the Worker alive after the response is returned
  c.executionCtx.waitUntil(
    handleAdminScrapeWithJob(c.env, jobId).catch((err) =>
      console.error("[admin] ingest error:", err),
    ),
  );

  return c.json({ success: true, job_id: jobId });
});

// ─── GET /v1/admin/campaigns/ingest/status ────────────────────────────────────

admin.get("/campaigns/ingest/status", async (c) => {
  const id = c.req.query("id");
  if (!id) return c.json({ success: false, error: "id required" }, 400);

  const raw = await c.env.KV.get(`scrape:job:${id}`);
  if (!raw) return c.json({ success: false, error: "Job not found or expired" }, 404);

  return c.json({ success: true, data: JSON.parse(raw) });
});

// ─── POST /v1/admin/campaigns ─────────────────────────────────────────────────

admin.post("/campaigns", async (c) => {
  const db = c.env.DB;

  let body: any;
  try { body = await c.req.json(); }
  catch { return errorResponse("INVALID_BODY", "JSON body required", 400); }

  const {
    title, subtitle, description, organizer, organizer_logo,
    location, start_dt, end_dt, url,
    images, image_url,
    contact_phone, contact_email, coin_reward,
    neighborhood_ids,
  } = body;

  if (!title || !start_dt) {
    return errorResponse("MISSING_FIELDS", "title and start_dt are required", 400);
  }

  // Build images array: explicit array from admin OR fallback to single image_url
  const imagesArr: string[] = Array.isArray(images) ? images.filter(Boolean).slice(0, 3)
    : (image_url ? [image_url] : []);
  const imagesJson = imagesArr.length > 0 ? JSON.stringify(imagesArr) : null;
  const primaryImageUrl = imagesArr[0] ?? null;

  // Neighborhood targeting: use provided IDs or fall back to all active
  let neighborhoods: { id: string }[];
  if (Array.isArray(neighborhood_ids) && neighborhood_ids.length > 0) {
    const placeholders = neighborhood_ids.map(() => "?").join(",");
    const { results } = await db
      .prepare(`SELECT id FROM neighborhoods WHERE id IN (${placeholders}) AND is_active = 1`)
      .bind(...neighborhood_ids)
      .all<{ id: string }>();
    neighborhoods = results;
  } else {
    const { results } = await db
      .prepare("SELECT id FROM neighborhoods WHERE is_active = 1")
      .all<{ id: string }>();
    neighborhoods = results;
  }

  if (neighborhoods.length === 0) {
    return errorResponse("NO_NEIGHBORHOODS", "No active neighborhoods found", 400);
  }

  const now = new Date().toISOString();
  let inserted = 0;

  for (const n of neighborhoods) {
    const id = crypto.randomUUID();
    const sourceIdentifier = `admin:${n.id}:${id}`;
    await db
      .prepare(
        `INSERT INTO campaigns
           (id, neighborhood_id, title, subtitle, description, organizer, organizer_logo,
            location, start_dt, end_dt, url, image_url, images_json,
            contact_phone, contact_email,
            source, source_identifier, status, last_seen_at,
            coin_reward, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, 'active', ?, ?, ?, ?)`,
      )
      .bind(
        id,
        n.id,
        title,
        subtitle       ?? null,
        description    ?? null,
        organizer      ?? null,
        organizer_logo ?? null,
        location       ?? null,
        start_dt,
        end_dt         ?? null,
        url            ?? null,
        primaryImageUrl,
        imagesJson,
        contact_phone  ?? null,
        contact_email  ?? null,
        sourceIdentifier,
        now,
        parseInt(coin_reward) || 50,
        now,
        now,
      )
      .run();
    inserted++;

    // Notify all users in this neighborhood about the new activity
    const { results: usersInNeighborhood } = await db
      .prepare(
        `SELECT u.id FROM users u
         JOIN user_neighborhoods un ON un.user_id = u.id AND un.neighborhood_id = ? AND un.left_at IS NULL
         WHERE u.deleted_at IS NULL`,
      )
      .bind(n.id)
      .all<{ id: string }>();

    if (usersInNeighborhood.length > 0) {
      const notifBody = location
        ? `${organizer ?? 'Community'} at ${location}`
        : (organizer ?? 'A new community activity has been added');
      const notifData = JSON.stringify({ campaign_id: id });
      const notifStatements = usersInNeighborhood.map(u =>
        db.prepare(
          `INSERT INTO notifications (id, user_id, type, title, body, data, created_at) VALUES (?, ?, 'campaign_new', ?, ?, ?, ?)`
        ).bind(crypto.randomUUID(), u.id, `New Activity: ${title}`, notifBody, notifData, now)
      );
      // Batch insert in chunks of 50
      for (let i = 0; i < notifStatements.length; i += 50) {
        await db.batch(notifStatements.slice(i, i + 50));
      }
    }
  }

  return c.json({ success: true, data: { inserted } }, 201);
});

// ─── PUT /v1/admin/campaigns/:id ─────────────────────────────────────────────

admin.put("/campaigns/:id", async (c) => {
  const db  = c.env.DB;
  const { id } = c.req.param();

  let body: any;
  try { body = await c.req.json(); }
  catch { return errorResponse("INVALID_BODY", "JSON body required", 400); }

  const {
    title, subtitle, description, organizer, organizer_logo,
    location, start_dt, end_dt, url,
    images, image_url,
    contact_phone, contact_email, coin_reward,
  } = body;

  if (!title || !start_dt) {
    return errorResponse("MISSING_FIELDS", "title and start_dt are required", 400);
  }

  const imagesArr: string[] = Array.isArray(images) ? images.filter(Boolean).slice(0, 3)
    : (image_url ? [image_url] : []);
  const imagesJson      = imagesArr.length > 0 ? JSON.stringify(imagesArr) : null;
  const primaryImageUrl = imagesArr[0] ?? null;
  const now             = new Date().toISOString();

  const { meta } = await db
    .prepare(
      `UPDATE campaigns SET
         title          = ?,
         subtitle       = ?,
         description    = ?,
         organizer      = ?,
         organizer_logo = ?,
         location       = ?,
         start_dt       = ?,
         end_dt         = ?,
         url            = ?,
         image_url      = ?,
         images_json    = ?,
         contact_phone  = ?,
         contact_email  = ?,
         coin_reward    = ?,
         updated_at     = ?
       WHERE id = ?`,
    )
    .bind(
      title,
      subtitle       ?? null,
      description    ?? null,
      organizer      ?? null,
      organizer_logo ?? null,
      location       ?? null,
      start_dt,
      end_dt         ?? null,
      url            ?? null,
      primaryImageUrl,
      imagesJson,
      contact_phone  ?? null,
      contact_email  ?? null,
      parseInt(coin_reward) || 50,
      now,
      id,
    )
    .run();

  if (meta.changes === 0) {
    return errorResponse("NOT_FOUND", "Campaign not found", 404);
  }

  return c.json({ success: true });
});

// ─── DELETE /v1/admin/campaigns/:id ──────────────────────────────────────────

admin.delete("/campaigns/:id", async (c) => {
  const { id } = c.req.param();
  await c.env.DB.prepare("DELETE FROM campaigns WHERE id = ?").bind(id).run();
  return c.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /v1/admin/verifications
 * List PENDING verification sessions — oldest first (FIFO)
 */
admin.get("/verifications", async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT vs.id, vs.user_id, vs.status, vs.attempt_count,
           vs.front_doc_key, vs.back_doc_key, vs.selfie_key,
           vs.created_at, vs.last_attempt_at,
           u.display_name, u.email
    FROM verification_sessions vs
    JOIN users u ON u.id = vs.user_id
    WHERE vs.status = 'pending'
    ORDER BY vs.created_at ASC
  `).all<any>();
  return c.json({ success: true, data: rows.results });
});

/**
 * GET /v1/admin/verifications/history
 * List VERIFIED sessions — newest first
 */
admin.get("/verifications/history", async (c) => {
  const rows = await c.env.DB.prepare(`
    SELECT vs.id, vs.user_id, vs.status,
           vs.manual_note, vs.manual_reviewed_at,
           vs.created_at,
           u.display_name, u.email
    FROM verification_sessions vs
    JOIN users u ON u.id = vs.user_id
    WHERE vs.status = 'verified'
    ORDER BY vs.manual_reviewed_at DESC
  `).all<any>();
  return c.json({ success: true, data: rows.results });
});

/**
 * GET /v1/admin/verifications/:session_id
 * Get a single pending session with user info
 */
admin.get("/verifications/:session_id", async (c) => {
  const { session_id } = c.req.param();
  const row = await c.env.DB.prepare(`
    SELECT vs.id, vs.user_id, vs.status, vs.attempt_count,
           vs.front_doc_key, vs.back_doc_key, vs.selfie_key,
           vs.ai_rejection_reason, vs.manual_note, vs.created_at,
           u.display_name, u.email
    FROM verification_sessions vs
    JOIN users u ON u.id = vs.user_id
    WHERE vs.id = ?
  `).bind(session_id).first<any>();
  if (!row) return c.json({ success: false, error: { code: "NOT_FOUND", message: "Session not found" } }, 404);
  return c.json({ success: true, data: row });
});

/**
 * GET /v1/admin/verifications/:session_id/document/:type
 * Proxy an R2 verification document (front | back | selfie) to the admin browser.
 * Accepts auth either via Authorization header OR ?token= query param (for <img> tags).
 */
admin.get("/verifications/:session_id/document/:type", async (c) => {
  // Allow token via query param for direct <img> src usage
  const tokenParam = c.req.query("token");
  if (tokenParam && !c.req.header("Authorization")) {
    c.req.raw.headers.set("Authorization", `Bearer ${tokenParam}`);
  }

  const { session_id, type } = c.req.param();
  if (!["front", "back", "selfie"].includes(type)) {
    return c.json({ success: false, error: { code: "INVALID_TYPE" } }, 400);
  }

  const { verifyJWT } = await import("../lib/utils");
  const token = tokenParam ?? (c.req.header("Authorization") ?? "").replace("Bearer ", "");
  if (!token) return c.json({ success: false, error: { code: "UNAUTHORIZED" } }, 401);
  const payload = await verifyJWT(token, c.env.JWT_SECRET);
  if (!payload || payload.role !== "admin") {
    return c.json({ success: false, error: { code: "FORBIDDEN" } }, 403);
  }

  const session = await c.env.DB.prepare(
    "SELECT front_doc_key, back_doc_key, selfie_key FROM verification_sessions WHERE id = ?"
  ).bind(session_id).first<any>();
  if (!session) return c.json({ success: false, error: { code: "NOT_FOUND" } }, 404);

  const key: string | null =
    type === "front" ? session.front_doc_key :
    type === "back"  ? session.back_doc_key  :
                       session.selfie_key;

  if (!key) return c.json({ success: false, error: { code: "DOCUMENT_NOT_UPLOADED" } }, 404);

  const obj = await c.env.STORAGE.get(key);
  if (!obj) return c.json({ success: false, error: { code: "NOT_FOUND" } }, 404);

  const headers = new Headers();
  headers.set("Content-Type", obj.httpMetadata?.contentType ?? "image/jpeg");
  headers.set("Cache-Control", "private, max-age=300");
  return new Response(obj.body, { headers });
});

export default admin;
