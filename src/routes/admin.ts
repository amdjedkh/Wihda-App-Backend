/**
 * Wihda Backend - Admin Routes
 *
 * All routes require a valid JWT with role = 'admin'.
 * Validated server-side via requireAdmin middleware.
 *
 * GET    /v1/admin/stats              — platform statistics
 * GET    /v1/admin/campaigns          — full campaign list
 * POST   /v1/admin/campaigns          — create activity in all active neighborhoods
 * DELETE /v1/admin/campaigns/:id      — delete an activity
 * POST   /v1/admin/campaigns/ingest   — trigger scraper run (fire-and-forget)
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { errorResponse } from "../lib/utils";
import { authMiddleware, requireAdmin } from "../middleware/auth";
import { handleScheduledCampaignIngestion } from "../queues/campaign";

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
  handleScheduledCampaignIngestion(c.env).catch((err) =>
    console.error("[admin] ingest error:", err),
  );
  return c.json({ success: true, message: "Scrape triggered" });
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
  } = body;

  if (!title || !start_dt) {
    return errorResponse("MISSING_FIELDS", "title and start_dt are required", 400);
  }

  // Build images array: explicit array from admin OR fallback to single image_url
  const imagesArr: string[] = Array.isArray(images) ? images.filter(Boolean).slice(0, 3)
    : (image_url ? [image_url] : []);
  const imagesJson = imagesArr.length > 0 ? JSON.stringify(imagesArr) : null;
  const primaryImageUrl = imagesArr[0] ?? null;

  const { results: neighborhoods } = await db
    .prepare("SELECT id FROM neighborhoods WHERE is_active = 1")
    .all<{ id: string }>();

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
      .prepare("SELECT id FROM users WHERE neighborhood_id = ? AND deleted_at IS NULL")
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
