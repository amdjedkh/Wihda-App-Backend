/**
 * Wihda Backend - Leftovers Routes
 * POST /v1/leftovers/offers
 * GET /v1/leftovers/offers
 * GET /v1/leftovers/offers/:id
 * DELETE /v1/leftovers/offers/:id
 * POST /v1/leftovers/offers/:id/request  (creates direct chat thread)
 * POST /v1/leftovers/needs
 * GET /v1/leftovers/needs
 * GET /v1/leftovers/needs/:id
 * DELETE /v1/leftovers/needs/:id
 * GET /v1/leftovers/matches
 * POST /v1/leftovers/matches/:id/close
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import {
  createLeftoverOffer,
  getLeftoverOfferById,
  getActiveLeftoverOffers,
  createLeftoverNeed,
  getLeftoverNeedById,
  getActiveLeftoverNeeds,
  getMatchesForUser,
  getMatchById,
  updateMatchStatus,
  getChatThreadByMatchId,
  getCoinRule,
  createCoinEntry,
  getUserById,
  createChatThread,
} from "../lib/db";
import {
  successResponse,
  errorResponse,
  addHours,
  toISODateString,
  generateId,
} from "../lib/utils";
import {
  authMiddleware,
  getAuthContext,
  requireNeighborhood,
} from "../middleware/auth";
import { checkAndAwardBadges } from "../lib/badges";

const leftovers = new Hono<{ Bindings: Env }>();

// Survey validation schema (GIVE posts)
const surveySchema = z.object({
  schema_version: z.number().default(1),
  food_type: z.enum([
    "bread",
    "cooked_meal",
    "vegetables",
    "fruits",
    "dairy",
    "dry_goods",
    "other",
  ]),
  diet_constraints: z.array(z.string()).default([]),
  portions: z.number().int().min(1).max(50),
  pickup_time_preference: z.enum([
    "morning",
    "afternoon",
    "evening",
    "flexible",
  ]),
  distance_willing_km: z.number().min(0.5).max(20),
  notes: z.string().max(500).optional(),
});

const createOfferSchema = z.object({
  title: z.string().min(3).max(100),
  description: z.string().max(1000).optional(),
  image_url: z.string().max(2000).optional(),
  survey: surveySchema,
  quantity: z.number().int().min(1).max(10).default(1),
  pickup_window_start: z.string().datetime().optional(),
  pickup_window_end: z.string().datetime().optional(),
  expiry_hours: z.number().int().min(1).max(72).default(24),
});

// GET (need) posts: just title + description + urgency
const createNeedSchema = z.object({
  title: z.string().min(3).max(100),
  description: z.string().max(1000).optional(),
  urgency: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
});

const closeMatchSchema = z.object({
  closure_type: z.enum(["successful", "cancelled", "disputed"]),
  dispute_reason: z.string().max(1000).optional(),
});

// ─── Helper: map offer row to API shape ───────────────────────────────────────

function mapOffer(offer: any, user: any) {
  const survey = (() => {
    try { return JSON.parse(offer.survey_json); } catch { return {}; }
  })();
  return {
    id: offer.id,
    title: offer.title,
    description: offer.description ?? null,
    image_url: offer.image_url ?? null,
    survey,
    quantity: offer.quantity,
    status: offer.status,
    expiry_at: offer.expiry_at,
    user: user ? { id: user.id, display_name: user.display_name } : null,
    user_id: offer.user_id,
    created_at: offer.created_at,
  };
}

function mapNeed(need: any, user: any) {
  return {
    id: need.id,
    title: need.title ?? null,
    description: need.description ?? null,
    urgency: need.urgency,
    status: need.status,
    user: user ? { id: user.id, display_name: user.display_name } : null,
    user_id: need.user_id,
    created_at: need.created_at,
  };
}

/**
 * POST /v1/leftovers/offers
 * Create a new leftover offer (GIVE)
 */
leftovers.post(
  "/offers",
  authMiddleware,
  requireNeighborhood,
  async (c) => {
    const authContext = getAuthContext(c);
    if (!authContext || !authContext.neighborhoodId) {
      return errorResponse(
        "UNAUTHORIZED",
        "Authentication and neighborhood required",
        401,
      );
    }

    try {
      const body = await c.req.json();
      const validation = createOfferSchema.safeParse(body);

      if (!validation.success) {
        return errorResponse(
          "VALIDATION_ERROR",
          "Invalid request data",
          400,
          validation.error.flatten(),
        );
      }

      const data = validation.data;
      const expiryAt = toISODateString(addHours(new Date(), data.expiry_hours));

      const offer = await createLeftoverOffer(c.env.DB, {
        userId: authContext.userId,
        neighborhoodId: authContext.neighborhoodId,
        title: data.title,
        description: data.description,
        imageUrl: data.image_url,
        surveyJson: JSON.stringify(data.survey),
        quantity: data.quantity,
        pickupWindowStart: data.pickup_window_start,
        pickupWindowEnd: data.pickup_window_end,
        expiryAt,
      });

      // Queue matching job
      await c.env.MATCHING_QUEUE.send({
        type: "match_offer",
        offer_id: offer.id,
        neighborhood_id: authContext.neighborhoodId,
        timestamp: toISODateString(),
      });

      // Check & award badges asynchronously
      checkAndAwardBadges(c.env.DB, authContext.userId);

      return successResponse({
        offer: {
          id: offer.id,
          title: offer.title,
          status: offer.status,
          expiry_at: offer.expiry_at,
          created_at: offer.created_at,
        },
      });
    } catch (error) {
      console.error("Create offer error:", error);
      return errorResponse("INTERNAL_ERROR", "Failed to create offer", 500);
    }
  },
);

/**
 * GET /v1/leftovers/offers
 * List active offers — neighborhood-scoped or global
 */
leftovers.get("/offers", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const rawStatus = c.req.query("status") || "active";
  if (rawStatus !== "active" && rawStatus !== "mine") {
    return errorResponse(
      "VALIDATION_ERROR",
      "status must be 'active' or 'mine'",
      400,
    );
  }

  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 100);

  let offers: any[];
  if (rawStatus === "active") {
    offers = await getActiveLeftoverOffers(
      c.env.DB,
      authContext.neighborhoodId ?? null,
      limit,
    );
  } else {
    const result = await c.env.DB.prepare(
      `SELECT * FROM leftover_offers WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
      .bind(authContext.userId, limit)
      .all();
    offers = result.results as any[];
  }

  const userIds = [...new Set(offers.map((o: any) => o.user_id as string))];
  const userRows =
    userIds.length > 0
      ? ((
          await c.env.DB.prepare(
            `SELECT id, display_name FROM users WHERE id IN (${userIds.map(() => "?").join(",")})`,
          )
            .bind(...userIds)
            .all()
        ).results as { id: string; display_name: string }[])
      : [];
  const userMap = Object.fromEntries(userRows.map((u) => [u.id, u]));

  return successResponse({
    offers: offers.map((offer: any) => mapOffer(offer, userMap[offer.user_id] ?? null)),
  });
});

/**
 * GET /v1/leftovers/offers/:id
 * Get offer details
 */
leftovers.get("/offers/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");
  const offer = await getLeftoverOfferById(c.env.DB, id);
  if (!offer) {
    return errorResponse("NOT_FOUND", "Offer not found", 404);
  }

  const user = await getUserById(c.env.DB, offer.user_id);
  return successResponse(mapOffer(offer, user ? { id: user.id, display_name: user.display_name } : null));
});

/**
 * DELETE /v1/leftovers/offers/:id
 * Delete own offer
 */
leftovers.delete("/offers/:id", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const id = c.req.param("id");
  const offer = await getLeftoverOfferById(c.env.DB, id);
  if (!offer) {
    return errorResponse("NOT_FOUND", "Offer not found", 404);
  }
  if (offer.user_id !== authContext.userId) {
    return errorResponse("FORBIDDEN", "Not your offer", 403);
  }

  await c.env.DB.prepare("DELETE FROM leftover_offers WHERE id = ?").bind(id).run();
  return successResponse({ deleted: true });
});

/**
 * POST /v1/leftovers/offers/:id/request
 * Requester clicks "Request" on an offer → creates a direct chat thread
 */
leftovers.post("/offers/:id/request", authMiddleware, requireNeighborhood, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext || !authContext.neighborhoodId) {
    return errorResponse("UNAUTHORIZED", "Authentication and neighborhood required", 401);
  }

  const offerId = c.req.param("id");
  const offer = await getLeftoverOfferById(c.env.DB, offerId);
  if (!offer) {
    return errorResponse("NOT_FOUND", "Offer not found", 404);
  }

  if (offer.user_id === authContext.userId) {
    return errorResponse("FORBIDDEN", "You cannot request your own offer", 403);
  }

  if (offer.status !== "active") {
    return errorResponse("GONE", "This offer is no longer available", 410);
  }

  // Check if a thread already exists between these two users for this offer
  const existing = await c.env.DB.prepare(
    `SELECT id FROM chat_threads
     WHERE offer_id = ? AND (
       (participant_1_id = ? AND participant_2_id = ?) OR
       (participant_1_id = ? AND participant_2_id = ?)
     ) AND status = 'active'`,
  )
    .bind(offerId, authContext.userId, offer.user_id, offer.user_id, authContext.userId)
    .first<{ id: string }>();

  if (existing) {
    return successResponse({ thread_id: existing.id, already_exists: true });
  }

  // Create new direct chat thread
  const thread = await createChatThread(c.env.DB, {
    matchId: null,
    offerId,
    neighborhoodId: authContext.neighborhoodId,
    participant1Id: authContext.userId,
    participant2Id: offer.user_id,
  });

  // Send an automated first message
  const requester = await getUserById(c.env.DB, authContext.userId);
  const requesterName = requester?.display_name || "A neighbor";
  await c.env.DB.prepare(
    `INSERT INTO chat_messages (id, thread_id, sender_id, body, message_type, created_at)
     VALUES (?, ?, ?, ?, 'system', datetime('now'))`,
  )
    .bind(generateId(), thread.id, authContext.userId,
      `${requesterName} is interested in "${offer.title}"`)
    .run();

  // Notify the offer owner
  await c.env.NOTIFICATION_QUEUE.send({
    user_id: offer.user_id,
    type: "leftover_request",
    title: "Someone wants your offer!",
    body: `${requesterName} is interested in "${offer.title}"`,
    data: { thread_id: thread.id, offer_id: offerId },
    timestamp: toISODateString(),
  });

  return successResponse({ thread_id: thread.id, already_exists: false });
});

/**
 * POST /v1/leftovers/offers/:id/favorite
 * Toggle favorite status for an offer
 */
leftovers.post("/offers/:id/favorite", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const offerId = c.req.param("id");

  const existing = await c.env.DB.prepare(
    "SELECT id FROM user_favorites WHERE user_id = ? AND item_type = 'offer' AND item_id = ?"
  )
    .bind(authContext.userId, offerId)
    .first<{ id: string }>();

  if (existing) {
    await c.env.DB.prepare(
      "DELETE FROM user_favorites WHERE user_id = ? AND item_type = 'offer' AND item_id = ?"
    )
      .bind(authContext.userId, offerId)
      .run();
    return successResponse({ favorited: false });
  } else {
    const id = generateId();
    await c.env.DB.prepare(
      "INSERT INTO user_favorites (id, user_id, item_type, item_id) VALUES (?, ?, 'offer', ?)"
    )
      .bind(id, authContext.userId, offerId)
      .run();
    return successResponse({ favorited: true });
  }
});

/**
 * GET /v1/leftovers/favorites
 * List user's favorited offers
 */
leftovers.get("/favorites", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 100);

  const result = await c.env.DB.prepare(
    `SELECT lo.* FROM leftover_offers lo
     INNER JOIN user_favorites uf ON uf.item_id = lo.id AND uf.item_type = 'offer'
     WHERE uf.user_id = ?
     ORDER BY uf.created_at DESC LIMIT ?`
  )
    .bind(authContext.userId, limit)
    .all();

  const offers = result.results as any[];
  const userIds = [...new Set(offers.map((o: any) => o.user_id as string))];
  const userRows =
    userIds.length > 0
      ? ((
          await c.env.DB.prepare(
            `SELECT id, display_name FROM users WHERE id IN (${userIds.map(() => "?").join(",")})`
          )
            .bind(...userIds)
            .all()
        ).results as { id: string; display_name: string }[])
      : [];
  const userMap = Object.fromEntries(userRows.map((u) => [u.id, u]));

  return successResponse({
    offers: offers.map((offer: any) => mapOffer(offer, userMap[offer.user_id] ?? null)),
  });
});

/**
 * POST /v1/leftovers/needs
 * Create a new leftover need (GET/request)
 */
leftovers.post(
  "/needs",
  authMiddleware,
  requireNeighborhood,
  async (c) => {
    const authContext = getAuthContext(c);
    if (!authContext || !authContext.neighborhoodId) {
      return errorResponse(
        "UNAUTHORIZED",
        "Authentication and neighborhood required",
        401,
      );
    }

    try {
      const body = await c.req.json();
      const validation = createNeedSchema.safeParse(body);

      if (!validation.success) {
        return errorResponse(
          "VALIDATION_ERROR",
          "Invalid request data",
          400,
          validation.error.flatten(),
        );
      }

      const data = validation.data;

      const need = await createLeftoverNeed(c.env.DB, {
        userId: authContext.userId,
        neighborhoodId: authContext.neighborhoodId,
        title: data.title,
        description: data.description,
        urgency: data.urgency,
      });

      return successResponse({
        need: {
          id: need.id,
          urgency: need.urgency,
          status: need.status,
          created_at: need.created_at,
        },
      });
    } catch (error) {
      console.error("Create need error:", error);
      return errorResponse("INTERNAL_ERROR", "Failed to create need", 500);
    }
  },
);

/**
 * GET /v1/leftovers/needs
 * List active needs
 */
leftovers.get("/needs", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const rawStatus = c.req.query("status") || "active";
  if (rawStatus !== "active" && rawStatus !== "mine") {
    return errorResponse(
      "VALIDATION_ERROR",
      "status must be 'active' or 'mine'",
      400,
    );
  }

  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 100);

  let needs: any[];
  if (rawStatus === "active") {
    needs = await getActiveLeftoverNeeds(
      c.env.DB,
      authContext.neighborhoodId ?? null,
      limit,
    );
  } else {
    const result = await c.env.DB.prepare(
      `SELECT * FROM leftover_needs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
      .bind(authContext.userId, limit)
      .all();
    needs = result.results as any[];
  }

  const userIds = [...new Set(needs.map((n: any) => n.user_id as string))];
  const userRows =
    userIds.length > 0
      ? ((
          await c.env.DB.prepare(
            `SELECT id, display_name FROM users WHERE id IN (${userIds.map(() => "?").join(",")})`,
          )
            .bind(...userIds)
            .all()
        ).results as { id: string; display_name: string }[])
      : [];
  const userMap = Object.fromEntries(userRows.map((u) => [u.id, u]));

  return successResponse({
    needs: needs.map((need: any) => mapNeed(need, userMap[need.user_id] ?? null)),
  });
});

/**
 * GET /v1/leftovers/needs/:id
 * Get need details
 */
leftovers.get("/needs/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");
  const need = await getLeftoverNeedById(c.env.DB, id);
  if (!need) {
    return errorResponse("NOT_FOUND", "Need not found", 404);
  }

  const user = await getUserById(c.env.DB, need.user_id);
  return successResponse(mapNeed(need, user ? { id: user.id, display_name: user.display_name } : null));
});

/**
 * DELETE /v1/leftovers/needs/:id
 * Delete own need
 */
leftovers.delete("/needs/:id", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const id = c.req.param("id");
  const need = await getLeftoverNeedById(c.env.DB, id);
  if (!need) {
    return errorResponse("NOT_FOUND", "Need not found", 404);
  }
  if (need.user_id !== authContext.userId) {
    return errorResponse("FORBIDDEN", "Not your post", 403);
  }

  await c.env.DB.prepare("DELETE FROM leftover_needs WHERE id = ?").bind(id).run();
  return successResponse({ deleted: true });
});

/**
 * GET /v1/leftovers/matches
 * Get user's matches
 */
leftovers.get("/matches", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const status = c.req.query("status") || "active";
  const matches = await getMatchesForUser(c.env.DB, authContext.userId, status);

  const enrichedMatches = await Promise.all(
    matches.map(async (match) => {
      const [offer, _need, offerUser, needUser, chatThread] = await Promise.all(
        [
          getLeftoverOfferById(c.env.DB, match.offer_id),
          getLeftoverNeedById(c.env.DB, match.need_id),
          getUserById(c.env.DB, match.offer_user_id),
          getUserById(c.env.DB, match.need_user_id),
          getChatThreadByMatchId(c.env.DB, match.id),
        ],
      );

      const isOfferOwner = match.offer_user_id === authContext.userId;
      const otherUser = isOfferOwner ? needUser : offerUser;

      return {
        id: match.id,
        score: match.score,
        status: match.status,
        closure_type: match.closure_type,
        created_at: match.created_at,
        closed_at: match.closed_at,
        close_requested_by: (match as any).close_requested_by ?? null,
        close_requested_at: (match as any).close_requested_at ?? null,
        is_offer_owner: isOfferOwner,
        offer: offer ? { id: offer.id, title: offer.title } : null,
        other_user: otherUser ? { id: otherUser.id, display_name: otherUser.display_name } : null,
        chat_thread_id: chatThread?.id || null,
      };
    }),
  );

  return successResponse({ matches: enrichedMatches });
});

/**
 * POST /v1/leftovers/matches/:id/request-close
 * Two-step exchange confirmation with 5-minute timer
 */
leftovers.post("/matches/:id/request-close", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const matchId = c.req.param("id");
  const match = await getMatchById(c.env.DB, matchId);
  if (!match) {
    return errorResponse("NOT_FOUND", "Match not found", 404);
  }

  if (
    match.offer_user_id !== authContext.userId &&
    match.need_user_id !== authContext.userId
  ) {
    return errorResponse("FORBIDDEN", "You are not part of this match", 403);
  }

  if (match.status === "closed" || match.status === "cancelled") {
    return errorResponse("ALREADY_CLOSED", "This match is already closed", 400);
  }

  const matchAny = match as any;
  const closeRequestedBy: string | null = matchAny.close_requested_by ?? null;
  const closeRequestedAt: string | null = matchAny.close_requested_at ?? null;
  const userId = authContext.userId;
  const now = new Date();

  if (closeRequestedBy === null) {
    await c.env.DB.prepare(
      "UPDATE matches SET close_requested_by = ?, close_requested_at = ? WHERE id = ?"
    )
      .bind(userId, now.toISOString(), matchId)
      .run();
    return successResponse({
      status: "pending",
      message: "Waiting for other user to confirm within 5 minutes",
    });
  }

  if (closeRequestedBy === userId) {
    return errorResponse("ALREADY_REQUESTED", "You have already requested closure, waiting for the other user", 409);
  }

  const requestedAt = closeRequestedAt ? new Date(closeRequestedAt) : null;
  const elapsedSeconds = requestedAt
    ? (now.getTime() - requestedAt.getTime()) / 1000
    : Infinity;

  if (elapsedSeconds > 300) {
    await c.env.DB.prepare(
      "UPDATE matches SET close_requested_by = ?, close_requested_at = ? WHERE id = ?"
    )
      .bind(userId, now.toISOString(), matchId)
      .run();
    return successResponse({
      status: "pending",
      message: "Previous request expired, your request is now pending",
    });
  }

  // Within 5 minutes — complete the closure
  const [giverRule, receiverRule] = await Promise.all([
    getCoinRule(c.env.DB, "leftovers_match_closed_giver"),
    getCoinRule(c.env.DB, "leftovers_match_closed_receiver"),
  ]);

  const giverAmount = giverRule?.amount || 200;
  await createCoinEntry(c.env.DB, {
    userId: match.offer_user_id,
    neighborhoodId: match.neighborhood_id,
    sourceType: "leftovers_match_closed_giver",
    sourceId: match.id,
    amount: giverAmount,
    category: "leftovers",
    description: "Reward for successfully giving leftovers",
    createdBy: "system",
  });

  const receiverAmount = receiverRule?.amount || 50;
  await createCoinEntry(c.env.DB, {
    userId: match.need_user_id,
    neighborhoodId: match.neighborhood_id,
    sourceType: "leftovers_match_closed_receiver",
    sourceId: match.id,
    amount: receiverAmount,
    category: "leftovers",
    description: "Reward for completing pickup",
    createdBy: "system",
  });

  const coinsAwarded = giverAmount + receiverAmount;

  await updateMatchStatus(c.env.DB, matchId, {
    status: "closed",
    closedBy: userId,
    closureType: "successful",
    coinsAwarded,
  });

  const chatThread = await getChatThreadByMatchId(c.env.DB, matchId);
  if (chatThread) {
    await c.env.DB.prepare(
      "UPDATE chat_threads SET status = 'closed', closed_at = ? WHERE id = ?"
    )
      .bind(toISODateString(), chatThread.id)
      .run();
  }

  const otherUserId =
    match.offer_user_id === userId ? match.need_user_id : match.offer_user_id;
  await c.env.NOTIFICATION_QUEUE.send({
    user_id: otherUserId,
    type: "match_closed",
    title: "Match Completed",
    body: "The leftover exchange has been completed successfully!",
    data: { match_id: matchId, closure_type: "successful" },
    timestamp: toISODateString(),
  });

  return successResponse({ status: "completed", coins_awarded: coinsAwarded });
});

/**
 * POST /v1/leftovers/matches/:id/close
 */
leftovers.post("/matches/:id/close", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const matchId = c.req.param("id");

  try {
    const body = await c.req.json();
    const validation = closeMatchSchema.safeParse(body);

    if (!validation.success) {
      return errorResponse(
        "VALIDATION_ERROR",
        "Invalid request data",
        400,
        validation.error.flatten(),
      );
    }

    const data = validation.data;
    const match = await getMatchById(c.env.DB, matchId);
    if (!match) {
      return errorResponse("NOT_FOUND", "Match not found", 404);
    }

    if (
      match.offer_user_id !== authContext.userId &&
      match.need_user_id !== authContext.userId
    ) {
      return errorResponse("FORBIDDEN", "You are not part of this match", 403);
    }

    if (match.status === "closed" || match.status === "cancelled") {
      return errorResponse("ALREADY_CLOSED", "This match is already closed", 400);
    }

    let coinsAwarded = 0;
    let newStatus = "closed";

    if (data.closure_type === "successful") {
      const [giverRule, receiverRule] = await Promise.all([
        getCoinRule(c.env.DB, "leftovers_match_closed_giver"),
        getCoinRule(c.env.DB, "leftovers_match_closed_receiver"),
      ]);

      const giverAmount = giverRule?.amount || 200;
      await createCoinEntry(c.env.DB, {
        userId: match.offer_user_id,
        neighborhoodId: match.neighborhood_id,
        sourceType: "leftovers_match_closed_giver",
        sourceId: match.id,
        amount: giverAmount,
        category: "leftovers",
        description: "Reward for successfully giving leftovers",
        createdBy: "system",
      });

      const receiverAmount = receiverRule?.amount || 50;
      await createCoinEntry(c.env.DB, {
        userId: match.need_user_id,
        neighborhoodId: match.neighborhood_id,
        sourceType: "leftovers_match_closed_receiver",
        sourceId: match.id,
        amount: receiverAmount,
        category: "leftovers",
        description: "Reward for completing pickup",
        createdBy: "system",
      });

      coinsAwarded = giverAmount + receiverAmount;
    } else if (data.closure_type === "cancelled") {
      await c.env.DB.prepare(
        "UPDATE leftover_offers SET status = 'active', updated_at = ? WHERE id = ?",
      )
        .bind(toISODateString(), match.offer_id)
        .run();
      await c.env.DB.prepare(
        "UPDATE leftover_needs SET status = 'active', updated_at = ? WHERE id = ?",
      )
        .bind(toISODateString(), match.need_id)
        .run();
      newStatus = "cancelled";
    } else if (data.closure_type === "disputed") {
      newStatus = "disputed";
    }

    await updateMatchStatus(c.env.DB, matchId, {
      status: newStatus,
      closedBy: authContext.userId,
      closureType: data.closure_type,
      disputeReason: data.dispute_reason,
      coinsAwarded,
    });

    const chatThread = await getChatThreadByMatchId(c.env.DB, matchId);
    if (chatThread) {
      await c.env.DB.prepare(
        "UPDATE chat_threads SET status = 'closed', closed_at = ? WHERE id = ?",
      )
        .bind(toISODateString(), chatThread.id)
        .run();
    }

    const otherUserId =
      match.offer_user_id === authContext.userId
        ? match.need_user_id
        : match.offer_user_id;
    await c.env.NOTIFICATION_QUEUE.send({
      user_id: otherUserId,
      type: "match_closed",
      title: "Match Completed",
      body:
        data.closure_type === "successful"
          ? "The leftover exchange has been completed successfully!"
          : "The match has been cancelled.",
      data: { match_id: matchId, closure_type: data.closure_type },
      timestamp: toISODateString(),
    });

    return successResponse({
      match: {
        id: matchId,
        status: newStatus,
        closure_type: data.closure_type,
        coins_awarded: coinsAwarded,
        closed_at: toISODateString(),
      },
    });
  } catch (error) {
    console.error("Close match error:", error);
    return errorResponse("INTERNAL_ERROR", "Failed to close match", 500);
  }
});

export default leftovers;
