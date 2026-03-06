/**
 * Wihda Backend - User Routes
 * GET   /v1/me
 * PATCH /v1/me
 * GET   /v1/me/coins
 * GET   /v1/me/:userId
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import {
  getUserById,
  updateUser,
  getUserNeighborhood,
  getNeighborhoodById,
  getCoinBalance,
  getCoinLedgerEntries,
} from "../lib/db";
import { successResponse, errorResponse } from "../lib/utils";
import {
  authMiddleware,
  requireVerified,
  getAuthContext,
} from "../middleware/auth";

const user = new Hono<{ Bindings: Env }>();

const updateProfileSchema = z.object({
  display_name: z.string().min(2).max(50).optional(),
  language_preference: z.string().length(2).optional(),
  fcm_token: z.string().optional(),
});

/**
 * GET /v1/me
 * Get current user's own profile with neighborhood and coin balance.
 * Accessible with a verification_only token — used by the client to check
 * status during the KYC flow. NOT gated by requireVerified intentionally.
 */
user.get("/", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const currentUser = await getUserById(c.env.DB, authContext.userId);

  if (!currentUser) {
    return errorResponse("USER_NOT_FOUND", "User not found", 404);
  }

  const userNeighborhood = await getUserNeighborhood(c.env.DB, currentUser.id);
  const neighborhood = userNeighborhood
    ? await getNeighborhoodById(c.env.DB, userNeighborhood.neighborhood_id)
    : null;
  const coinBalance = await getCoinBalance(c.env.DB, currentUser.id);

  return successResponse({
    id: currentUser.id,
    email: currentUser.email,
    phone: currentUser.phone,
    display_name: currentUser.display_name,
    role: currentUser.role,
    status: currentUser.status,
    verification_status: currentUser.verification_status,
    language_preference: currentUser.language_preference,
    neighborhood: neighborhood
      ? {
          id: neighborhood.id,
          name: neighborhood.name,
          city: neighborhood.city,
          joined_at: userNeighborhood?.joined_at,
        }
      : null,
    coin_balance: coinBalance,
    created_at: currentUser.created_at,
  });
});

/**
 * PATCH /v1/me
 * Update current user's profile.
 */
user.patch("/", authMiddleware, requireVerified, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  try {
    const body = await c.req.json();
    const validation = updateProfileSchema.safeParse(body);

    if (!validation.success) {
      return errorResponse(
        "VALIDATION_ERROR",
        "Invalid request data",
        400,
        validation.error.flatten(),
      );
    }

    const data = validation.data;

    const updatedUser = await updateUser(c.env.DB, authContext.userId, {
      displayName: data.display_name,
      languagePreference: data.language_preference,
      fcmToken: data.fcm_token,
    });

    if (!updatedUser) {
      return errorResponse("USER_NOT_FOUND", "User not found", 404);
    }

    return successResponse({
      id: updatedUser.id,
      display_name: updatedUser.display_name,
      language_preference: updatedUser.language_preference,
      updated_at: updatedUser.updated_at,
    });
  } catch (error) {
    console.error("Update profile error:", error);
    return errorResponse("INTERNAL_ERROR", "Failed to update profile", 500);
  }
});

/**
 * GET /v1/me/coins
 * Get current user's coin balance and paginated ledger.
 */
user.get("/coins", authMiddleware, requireVerified, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const cursor = c.req.query("cursor");
  const limit = parseInt(c.req.query("limit") || "20");

  const balance = await getCoinBalance(c.env.DB, authContext.userId);
  const { entries, hasMore } = await getCoinLedgerEntries(
    c.env.DB,
    authContext.userId,
    limit,
    cursor,
  );

  return successResponse({
    balance,
    entries,
    has_more: hasMore,
    next_cursor:
      hasMore && entries.length > 0
        ? entries[entries.length - 1].created_at
        : null,
  });
});

/**
 * GET /v1/me/:userId
 * Look up another user's profile. Response is role-scoped:
 *
 *   Regular users  -> basic public info only
 *                    (id, display_name, role, neighborhood, created_at)
 *
 *   Moderator/Admin -> extended info
 *                    (+ status, verification_status, language_preference,
 *                       coin_balance)
 *
 * Requires a full-scope verified token. Unverified users and
 * verification_only tokens are blocked by requireVerified.
 */
user.get("/:userId", authMiddleware, requireVerified, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const { userId } = c.req.param();

  const targetUser = await getUserById(c.env.DB, userId);
  if (!targetUser) {
    return errorResponse("USER_NOT_FOUND", "User not found", 404);
  }

  const userNeighborhood = await getUserNeighborhood(c.env.DB, targetUser.id);
  const neighborhood = userNeighborhood
    ? await getNeighborhoodById(c.env.DB, userNeighborhood.neighborhood_id)
    : null;

  const isModerator =
    authContext.userRole === "moderator" || authContext.userRole === "admin";

  // ── Basic public profile (all verified users) ──────────────────────────────
  const publicProfile = {
    id: targetUser.id,
    display_name: targetUser.display_name,
    role: targetUser.role,
    neighborhood: neighborhood
      ? {
          id: neighborhood.id,
          name: neighborhood.name,
          city: neighborhood.city,
          joined_at: userNeighborhood?.joined_at,
        }
      : null,
    created_at: targetUser.created_at,
  };

  if (!isModerator) {
    return successResponse(publicProfile);
  }

  // ── Extended profile (moderators and admins only) ──────────────────────────
  const coinBalance = await getCoinBalance(c.env.DB, targetUser.id);

  return successResponse({
    ...publicProfile,
    status: targetUser.status,
    verification_status: targetUser.verification_status,
    language_preference: targetUser.language_preference,
    coin_balance: coinBalance,
  });
});

export default user;
