/**
 * Wihda Backend - Campaigns Routes
 *
 * GET    /v1/campaigns          — list campaigns (neighborhood-scoped or global)
 * GET    /v1/campaigns/:id      — campaign detail
 * POST   /v1/campaigns/:id/join — join a campaign
 * DELETE /v1/campaigns/:id/join — cancel participation
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { successResponse, errorResponse } from "../lib/utils";
import { authMiddleware, getAuthContext } from "../middleware/auth";

const campaigns = new Hono<{ Bindings: Env }>();

// ─── Helper ───────────────────────────────────────────────────────────────────

function parseImages(imagesJson: string | null, fallbackUrl: string | null): string[] {
  if (imagesJson) {
    try {
      const arr = JSON.parse(imagesJson);
      if (Array.isArray(arr) && arr.length > 0) return arr.filter(Boolean);
    } catch { /* ignore */ }
  }
  return fallbackUrl ? [fallbackUrl] : [];
}

function formatCampaign(c: any, participantCount: number, isJoined: boolean): Record<string, unknown> {
  return {
    id:             c.id,
    title:          c.title,
    subtitle:       c.subtitle ?? null,
    description:    c.description,
    organizer:      c.organizer,
    organizer_logo: c.organizer_logo ?? null,
    location:       c.location,
    event_date:     c.start_dt,
    start_dt:       c.start_dt,
    end_dt:         c.end_dt,
    url:            c.url,
    image_url:      c.image_url,
    images:         parseImages(c.images_json, c.image_url),
    contact_phone:  c.contact_phone ?? null,
    contact_email:  c.contact_email ?? null,
    source:         c.source,
    status:         c.status,
    participant_count: participantCount,
    coin_reward:    c.coin_reward ?? 0,
    is_joined:      isJoined,
    created_at:     c.created_at,
  };
}

// ─── GET /v1/campaigns ────────────────────────────────────────────────────────

campaigns.get("/", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) return errorResponse("UNAUTHORIZED", "Authentication required", 401);

  const limit    = Math.min(parseInt(c.req.query("limit") || "30"), 100);
  const fromDate = c.req.query("from");
  const toDate   = c.req.query("to");

  let rows: any[];

  if (authContext.neighborhoodId) {
    let query  = `SELECT * FROM campaigns WHERE neighborhood_id = ? AND status = 'active'`;
    const params: any[] = [authContext.neighborhoodId];
    if (fromDate) { query += ` AND start_dt >= ?`; params.push(fromDate); }
    if (toDate)   { query += ` AND end_dt <= ?`;   params.push(toDate); }
    query += ` ORDER BY start_dt ASC LIMIT ?`;
    params.push(limit);
    rows = (await c.env.DB.prepare(query).bind(...params).all()).results as any[];
  } else {
    let query  = `SELECT * FROM campaigns WHERE status = 'active'`;
    const params: any[] = [];
    if (fromDate) { query += ` AND start_dt >= ?`; params.push(fromDate); }
    if (toDate)   { query += ` AND end_dt <= ?`;   params.push(toDate); }
    query += ` ORDER BY start_dt ASC LIMIT ?`;
    params.push(limit);
    rows = (await c.env.DB.prepare(query).bind(...params).all()).results as any[];
  }

  if (rows.length === 0) {
    return successResponse({ campaigns: [] });
  }

  // Batch-fetch participant counts + join status
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => "?").join(",");

  const [countRows, joinedRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT campaign_id, COUNT(*) as cnt FROM campaign_participants WHERE campaign_id IN (${placeholders}) GROUP BY campaign_id`
    ).bind(...ids).all<{ campaign_id: string; cnt: number }>(),
    c.env.DB.prepare(
      `SELECT campaign_id FROM campaign_participants WHERE user_id = ? AND campaign_id IN (${placeholders})`
    ).bind(authContext.userId, ...ids).all<{ campaign_id: string }>(),
  ]);

  const countMap  = new Map(countRows.results.map(r => [r.campaign_id, r.cnt]));
  const joinedSet = new Set(joinedRows.results.map(r => r.campaign_id));

  const enriched = rows.map(row =>
    formatCampaign(row, countMap.get(row.id) ?? 0, joinedSet.has(row.id))
  );

  return successResponse({ campaigns: enriched });
});

// ─── GET /v1/campaigns/:id ────────────────────────────────────────────────────

campaigns.get("/:id", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) return errorResponse("UNAUTHORIZED", "Authentication required", 401);

  const id = c.req.param("id");
  const campaign = await c.env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ? AND status = 'active'"
  ).bind(id).first<any>();

  if (!campaign) return errorResponse("NOT_FOUND", "Campaign not found", 404);

  const [countRow, joinRow] = await Promise.all([
    c.env.DB.prepare("SELECT COUNT(*) as cnt FROM campaign_participants WHERE campaign_id = ?")
      .bind(id).first<{ cnt: number }>(),
    c.env.DB.prepare("SELECT id FROM campaign_participants WHERE campaign_id = ? AND user_id = ?")
      .bind(id, authContext.userId).first<{ id: string }>(),
  ]);

  return successResponse(formatCampaign(campaign, countRow?.cnt ?? 0, !!joinRow));
});

// ─── POST /v1/campaigns/:id/join ─────────────────────────────────────────────

campaigns.post("/:id/join", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) return errorResponse("UNAUTHORIZED", "Authentication required", 401);

  const campaignId = c.req.param("id");

  const campaign = await c.env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ? AND status = 'active'"
  ).bind(campaignId).first<any>();
  if (!campaign) return errorResponse("NOT_FOUND", "Campaign not found", 404);

  const existing = await c.env.DB.prepare(
    "SELECT id FROM campaign_participants WHERE campaign_id = ? AND user_id = ?"
  ).bind(campaignId, authContext.userId).first<any>();

  if (existing) return successResponse({ joined: true, already_joined: true });

  const participantId = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO campaign_participants (id, campaign_id, user_id, joined_at) VALUES (?, ?, ?, datetime('now'))"
  ).bind(participantId, campaignId, authContext.userId).run();

  const countRow = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM campaign_participants WHERE campaign_id = ?"
  ).bind(campaignId).first<{ cnt: number }>();

  return successResponse({ joined: true, already_joined: false, participant_count: countRow?.cnt ?? 1 });
});

// ─── DELETE /v1/campaigns/:id/join ───────────────────────────────────────────

campaigns.delete("/:id/join", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) return errorResponse("UNAUTHORIZED", "Authentication required", 401);

  const campaignId = c.req.param("id");

  await c.env.DB.prepare(
    "DELETE FROM campaign_participants WHERE campaign_id = ? AND user_id = ?"
  ).bind(campaignId, authContext.userId).run();

  const countRow = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM campaign_participants WHERE campaign_id = ?"
  ).bind(campaignId).first<{ cnt: number }>();

  return successResponse({ cancelled: true, participant_count: countRow?.cnt ?? 0 });
});

export default campaigns;
