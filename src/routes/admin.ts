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
    title, description, organizer, location,
    start_dt, end_dt, url, image_url,
    contact_phone, contact_email, coin_reward,
  } = body;

  if (!title || !start_dt) {
    return errorResponse("MISSING_FIELDS", "title and start_dt are required", 400);
  }

  const { results: neighborhoods } = await db
    .prepare("SELECT id FROM neighborhoods WHERE status = 'active'")
    .all<{ id: string }>();

  if (neighborhoods.length === 0) {
    return errorResponse("NO_NEIGHBORHOODS", "No active neighborhoods found", 400);
  }

  const now = new Date().toISOString();
  let inserted = 0;

  for (const n of neighborhoods) {
    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO campaigns
           (id, neighborhood_id, title, description, organizer, location,
            start_dt, end_dt, url, image_url,
            source, source_identifier, status, last_seen_at,
            coin_reward, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', ?, 'active', ?, ?, ?, ?)`,
      )
      .bind(
        id,
        n.id,
        title,
        description  ?? null,
        organizer    ?? null,
        location     ?? null,
        start_dt,
        end_dt       ?? null,
        url          ?? null,
        image_url    ?? null,
        title,          // source_identifier
        now,            // last_seen_at
        parseInt(coin_reward) || 50,
        now,
        now,
      )
      .run();
    inserted++;
  }

  return c.json({ success: true, data: { inserted } }, 201);
});

// ─── DELETE /v1/admin/campaigns/:id ──────────────────────────────────────────

admin.delete("/campaigns/:id", async (c) => {
  const { id } = c.req.param();
  await c.env.DB.prepare("DELETE FROM campaigns WHERE id = ?").bind(id).run();
  return c.json({ success: true });
});

export default admin;
