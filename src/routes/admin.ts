/**
 * Wihda Backend - Admin Routes
 *
 * All routes require a valid JWT with role = 'admin'.
 * Validated server-side via requireAdmin middleware.
 *
 * GET    /v1/admin/stats                        — platform statistics
 * GET    /v1/admin/users                        — full user list
 * GET    /v1/admin/neighborhoods                — active neighborhood list
 * GET    /v1/admin/campaigns                    — full campaign list
 * POST   /v1/admin/campaigns                    — create activity (all or targeted neighborhoods)
 * PUT    /v1/admin/campaigns/:id                — update an activity
 * DELETE /v1/admin/campaigns/:id                — delete an activity
 * POST   /v1/admin/campaigns/ingest             — trigger scraper run (returns job_id)
 * GET    /v1/admin/campaigns/ingest/status      — poll scraper job status
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { errorResponse } from "../lib/utils";
import { authMiddleware, requireAdmin } from "../middleware/auth";
import { handleAdminScrapeWithJob } from "../queues/campaign";

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
    .prepare("SELECT id, name FROM neighborhoods WHERE is_active = 1 ORDER BY name ASC")
    .all();
  return c.json({ success: true, data: results });
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
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'manual', ?, 'active', ?, ?, ?, ?)`,
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
          `INSERT INTO notifications (id, user_id, type, title, body, data, created_at) VALUES (?, ?, 'new_activity', ?, ?, ?, ?)`
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

export default admin;
