/**
 * Wihda Backend - Campaigns Routes
 * GET /v1/campaigns        — list campaigns (neighborhood-scoped when available, global otherwise)
 * GET /v1/campaigns/:id    — campaign detail
 * POST /v1/campaigns/:id/join — join a campaign
 */

import { Hono } from "hono";
import type { Env } from "../types";
import { successResponse, errorResponse } from "../lib/utils";
import { authMiddleware, getAuthContext } from "../middleware/auth";

const campaigns = new Hono<{ Bindings: Env }>();

/**
 * GET /v1/campaigns
 * Returns active campaigns.
 * - If user has a neighborhood → neighborhood-scoped (their campaigns + global ones)
 * - If user has no neighborhood → all active campaigns
 */
campaigns.get("/", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 100);
  const fromDate = c.req.query("from");
  const toDate = c.req.query("to");

  let rows: any[];

  if (authContext.neighborhoodId) {
    // Neighborhood-scoped: return campaigns for this neighborhood
    let query = `
      SELECT * FROM campaigns
      WHERE (neighborhood_id = ? OR neighborhood_id IS NULL)
        AND status = 'active'
    `;
    const params: any[] = [authContext.neighborhoodId];

    if (fromDate) { query += ` AND start_dt >= ?`; params.push(fromDate); }
    if (toDate)   { query += ` AND end_dt <= ?`;   params.push(toDate); }
    query += ` ORDER BY start_dt ASC LIMIT ?`;
    params.push(limit);

    const result = await c.env.DB.prepare(query).bind(...params).all();
    rows = result.results as any[];
  } else {
    // No neighborhood — return all active campaigns
    let query = `SELECT * FROM campaigns WHERE status = 'active'`;
    const params: any[] = [];

    if (fromDate) { query += ` AND start_dt >= ?`; params.push(fromDate); }
    if (toDate)   { query += ` AND end_dt <= ?`;   params.push(toDate); }
    query += ` ORDER BY start_dt ASC LIMIT ?`;
    params.push(limit);

    const result = params.length > 1
      ? await c.env.DB.prepare(query).bind(...params).all()
      : await c.env.DB.prepare(query).bind(limit).all();
    rows = result.results as any[];
  }

  // Enrich with participant count
  const enriched = await Promise.all(
    rows.map(async (campaign: any) => {
      const countRow = await c.env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM campaign_participants WHERE campaign_id = ?"
      ).bind(campaign.id).first<{ cnt: number }>();

      return {
        id: campaign.id,
        title: campaign.title,
        description: campaign.description,
        organizer: campaign.organizer,
        location: campaign.location,
        location_geo: campaign.location_lat && campaign.location_lng
          ? { lat: campaign.location_lat, lng: campaign.location_lng }
          : null,
        event_date: campaign.start_dt,
        start_dt: campaign.start_dt,
        end_dt: campaign.end_dt,
        url: campaign.url,
        image_url: campaign.image_url,
        source: campaign.source,
        status: campaign.status,
        participant_count: countRow?.cnt ?? 0,
        coin_reward: campaign.coin_reward ?? 0,
      };
    }),
  );

  return successResponse({ campaigns: enriched });
});

/**
 * GET /v1/campaigns/:id
 * Campaign detail — accessible regardless of neighborhood.
 */
campaigns.get("/:id", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const id = c.req.param("id");

  const campaign = await c.env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ? AND status = 'active'"
  ).bind(id).first<any>();

  if (!campaign) {
    return errorResponse("NOT_FOUND", "Campaign not found", 404);
  }

  const countRow = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM campaign_participants WHERE campaign_id = ?"
  ).bind(campaign.id).first<{ cnt: number }>();

  return successResponse({
    id: campaign.id,
    title: campaign.title,
    description: campaign.description,
    organizer: campaign.organizer,
    location: campaign.location,
    location_geo: campaign.location_lat && campaign.location_lng
      ? { lat: campaign.location_lat, lng: campaign.location_lng }
      : null,
    event_date: campaign.start_dt,
    start_dt: campaign.start_dt,
    end_dt: campaign.end_dt,
    url: campaign.url,
    image_url: campaign.image_url,
    source: campaign.source,
    status: campaign.status,
    neighborhood_id: campaign.neighborhood_id,
    participant_count: countRow?.cnt ?? 0,
    coin_reward: campaign.coin_reward ?? 0,
    created_at: campaign.created_at,
  });
});

/**
 * POST /v1/campaigns/:id/join
 * Join a campaign. Idempotent — joining twice returns success.
 */
campaigns.post("/:id/join", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const campaignId = c.req.param("id");

  const campaign = await c.env.DB.prepare(
    "SELECT * FROM campaigns WHERE id = ? AND status = 'active'"
  ).bind(campaignId).first<any>();

  if (!campaign) {
    return errorResponse("NOT_FOUND", "Campaign not found", 404);
  }

  // Check if already joined (idempotent)
  const existing = await c.env.DB.prepare(
    "SELECT id FROM campaign_participants WHERE campaign_id = ? AND user_id = ?"
  ).bind(campaignId, authContext.userId).first<any>();

  if (existing) {
    return successResponse({ joined: true, already_joined: true });
  }

  // Insert participant record
  const participantId = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO campaign_participants (id, campaign_id, user_id, joined_at) VALUES (?, ?, ?, datetime('now'))"
  ).bind(participantId, campaignId, authContext.userId).run();

  // Get updated count
  const countRow = await c.env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM campaign_participants WHERE campaign_id = ?"
  ).bind(campaignId).first<{ cnt: number }>();

  return successResponse({
    joined: true,
    already_joined: false,
    participant_count: countRow?.cnt ?? 1,
  });
});

export default campaigns;
