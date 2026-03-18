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
  getCoinHistory,
  getCoinEntryById,
  voidCoinEntry,
  createCoinEntry,
} from "../lib/db";
import { successResponse, errorResponse } from "../lib/utils";
import {
  authMiddleware,
  requireVerified,
  requireAdmin,
  getAuthContext,
} from "../middleware/auth";
import { createUploadToken } from "../lib/upload-token";

const user = new Hono<{ Bindings: Env }>();

const updateProfileSchema = z.object({
  display_name: z.string().min(2).max(50).optional(),
  language_preference: z.string().length(2).optional(),
  fcm_token: z.string().optional(),
  photo_url: z.string().url().optional(),
  bio: z.string().max(200).optional(),
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
    photo_url: currentUser.photo_url,
    bio: (currentUser as any).bio ?? null,
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
 * POST /v1/me/photo
 * Generate a signed upload URL for a profile photo, then update photo_url after upload.
 * Accepts multipart/form-data with a `file` field.
 * Auth required; no requireVerified — unverified users can set a profile photo.
 */
user.post("/photo", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  try {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return errorResponse("VALIDATION_ERROR", "A 'file' field is required", 400);
    }

    if (file.size > 10 * 1024 * 1024) {
      return errorResponse("FILE_TOO_LARGE", "File size must be less than 10MB", 400);
    }

    const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
    const allowedExts = ["jpg", "jpeg", "png", "webp"];
    if (!allowedExts.includes(ext)) {
      return errorResponse(
        "VALIDATION_ERROR",
        "Only jpg, jpeg, png, and webp files are allowed",
        400,
      );
    }

    const timestamp = Date.now();
    const key = `profiles/${authContext.userId}/photo_${timestamp}.${ext}`;

    const fileBuffer = await file.arrayBuffer();
    const contentType = file.type || "image/jpeg";

    await c.env.STORAGE.put(key, fileBuffer, {
      httpMetadata: { contentType },
      customMetadata: { userId: authContext.userId, contentType: "profile_photo" },
    });

    const origin = new URL(c.req.url).origin;
    const photoUrl = `${origin}/v1/uploads/${key}`;

    await updateUser(c.env.DB, authContext.userId, { photoUrl });

    return successResponse({ photo_url: photoUrl, object_key: key });
  } catch (error) {
    console.error("Profile photo upload error:", error);
    return errorResponse("INTERNAL_ERROR", "Failed to upload profile photo", 500);
  }
});

/**
 * POST /v1/me/photo-url
 * Generate a presigned upload URL for a profile photo (client uploads directly).
 * Auth required; no requireVerified.
 */
user.post("/photo-url", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  try {
    const body = await c.req.json().catch(() => ({}));
    const fileExtension = ((body as any).file_extension || "jpg")
      .toLowerCase()
      .replace(/^\./, "");
    const allowedExts = ["jpg", "jpeg", "png", "webp"];
    if (!allowedExts.includes(fileExtension)) {
      return errorResponse(
        "VALIDATION_ERROR",
        "Only jpg, jpeg, png, and webp files are allowed",
        400,
      );
    }

    const timestamp = Date.now();
    const key = `profiles/${authContext.userId}/photo_${timestamp}.${fileExtension}`;

    const uploadToken = await createUploadToken(
      c.env.JWT_SECRET,
      authContext.userId,
      key,
      "profile_photo",
    );

    const origin = new URL(c.req.url).origin;
    const uploadUrl = `${origin}/v1/uploads/direct?token=${uploadToken}`;
    const fileUrl = `${origin}/v1/uploads/${key}`;

    return successResponse({
      upload_url: uploadUrl,
      object_key: key,
      file_url: fileUrl,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
  } catch (error) {
    console.error("Profile photo-url error:", error);
    return errorResponse("INTERNAL_ERROR", "Failed to generate upload URL", 500);
  }
});

/**
 * GET /v1/me/badges
 * Returns all badges with progress and earned status for the current user.
 * Auth required; no requireVerified.
 */
user.get("/badges", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  try {
    // Fetch all badge definitions
    const badgesResult = await c.env.DB.prepare(
      "SELECT * FROM badges ORDER BY requirement_value ASC",
    ).all<{
      id: string;
      key: string;
      name: string;
      description: string | null;
      icon: string;
      color: string;
      category: string;
      requirement_type: string;
      requirement_value: number;
    }>();

    // Fetch user's earned badges
    const earnedResult = await c.env.DB.prepare(
      "SELECT badge_key, earned_at FROM user_badges WHERE user_id = ?",
    )
      .bind(authContext.userId)
      .all<{ badge_key: string; earned_at: string }>();

    const earnedMap = Object.fromEntries(
      earnedResult.results.map((ub) => [ub.badge_key, ub.earned_at]),
    );

    // Count user progress metrics
    const [leftoverOffersRow, cleanifyApprovedRow, campaignsJoinedRow] = await Promise.all([
      c.env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM leftover_offers WHERE user_id = ?",
      )
        .bind(authContext.userId)
        .first<{ cnt: number }>(),
      c.env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM cleanify_submissions WHERE user_id = ? AND status = 'approved'",
      )
        .bind(authContext.userId)
        .first<{ cnt: number }>(),
      c.env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM campaign_participants WHERE user_id = ?",
      )
        .bind(authContext.userId)
        .first<{ cnt: number }>(),
    ]);

    const leftoverOffers   = leftoverOffersRow?.cnt   ?? 0;
    const cleanifyApproved = cleanifyApprovedRow?.cnt  ?? 0;
    const campaignsJoined  = campaignsJoinedRow?.cnt   ?? 0;
    const totalActivities  = campaignsJoined + cleanifyApproved;

    const progressMap: Record<string, number> = {
      leftover_offers:   leftoverOffers,
      cleanify_approved: cleanifyApproved,
      campaigns_joined:  campaignsJoined,
      total_activities:  totalActivities,
    };

    const badges = badgesResult.results.map((badge) => {
      const progress = progressMap[badge.requirement_type] ?? 0;
      const earned = badge.key in earnedMap;
      return {
        key: badge.key,
        name: badge.name,
        description: badge.description,
        icon: badge.icon,
        color: badge.color,
        category: badge.category,
        requirement_value: badge.requirement_value,
        progress,
        earned,
        earned_at: earned ? earnedMap[badge.key] : null,
      };
    });

    return successResponse({
      badges,
      stats: {
        cleanify_count:  cleanifyApproved,
        shared_count:    leftoverOffers,
        volunteer_count: campaignsJoined,
      },
    });
  } catch (error) {
    console.error("Badges fetch error:", error);
    return errorResponse("INTERNAL_ERROR", "Failed to fetch badges", 500);
  }
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
      photoUrl: data.photo_url,
      bio: data.bio,
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
 * DELETE /v1/me
 * Soft-delete the authenticated user's account.
 * Sets status to 'deleted', preventing future logins.
 */
user.delete("/", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  await c.env.DB.prepare(
    "UPDATE users SET status = 'deleted', updated_at = datetime('now') WHERE id = ?",
  ).bind(authContext.userId).run();

  return successResponse({ deleted: true });
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
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 100);

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
      hasMore && entries.length > 0 ? entries[entries.length - 1].id : null,
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

/**
 * GET /v1/me/coins/history
 * Full paginated coin history for the current user - includes both valid
 * and voided entries so users can see the complete audit trail.
 * Use GET /v1/me/coins for balance + valid entries only.
 */
user.get("/coins/history", authMiddleware, requireVerified, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const cursor = c.req.query("cursor");
  const limit = Math.min(parseInt(c.req.query("limit") || "20"), 100);

  const { entries, hasMore } = await getCoinHistory(
    c.env.DB,
    authContext.userId,
    limit,
    cursor,
  );

  return successResponse({
    entries,
    has_more: hasMore,
    next_cursor:
      hasMore && entries.length > 0 ? entries[entries.length - 1].id : null,
  });
});

/**
 * POST /v1/me/:userId/coins/:entryId/void
 * Admin only. Marks a coin ledger entry as voided so it no longer counts
 * toward the user's balance. Used to correct accidental or duplicate awards.
 *
 * The entry is never deleted, the void is an audit trail event.
 * A void_reason is required so there's always a paper trail.
 */
user.post(
  "/:userId/coins/:entryId/void",
  authMiddleware,
  requireAdmin,
  async (c) => {
    const authContext = getAuthContext(c);
    if (!authContext) {
      return errorResponse("UNAUTHORIZED", "Authentication required", 401);
    }

    const { userId, entryId } = c.req.param();

    const body = await c.req.json().catch(() => ({}));
    const reason = (body as any).reason;
    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
      return errorResponse(
        "VALIDATION_ERROR",
        "A void reason is required",
        400,
      );
    }

    // Confirm entry belongs to the specified user
    const entry = await getCoinEntryById(c.env.DB, entryId);
    if (!entry) {
      return errorResponse("NOT_FOUND", "Coin entry not found", 404);
    }
    if (entry.user_id !== userId) {
      return errorResponse(
        "FORBIDDEN",
        "Entry does not belong to this user",
        403,
      );
    }
    if (entry.status === "void") {
      return successResponse({ already_voided: true, entry_id: entryId });
    }

    await voidCoinEntry(c.env.DB, entryId, authContext.userId, reason.trim());

    return successResponse({
      voided: true,
      entry_id: entryId,
      user_id: userId,
      amount_reversed: entry.amount,
    });
  },
);

/**
 * POST /v1/me/:userId/coins/adjust
 * Admin only. Creates a manual coin adjustment (positive or negative) for a
 * user. Used for support resolutions, correction of missed rewards, or
 * penalty deductions.
 *
 * Negative amounts reduce the user's balance. The ledger constraint
 * (source_type + source_id + user_id) is satisfied by using a fresh UUID
 * as source_id, each admin adjustment is a distinct event.
 */
const adjustSchema = z.object({
  amount: z
    .number()
    .int()
    .refine((n) => n !== 0, {
      message: "Amount must be non-zero",
    }),
  reason: z.string().min(1).max(500),
});

user.post("/:userId/coins/adjust", authMiddleware, requireAdmin, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const { userId } = c.req.param();

  const body = await c.req.json().catch(() => ({}));
  const validation = adjustSchema.safeParse(body);
  if (!validation.success) {
    return errorResponse(
      "VALIDATION_ERROR",
      "Invalid adjustment data",
      400,
      validation.error.flatten(),
    );
  }

  const { amount, reason } = validation.data;

  // Confirm the target user exists
  const targetUser = await getUserById(c.env.DB, userId);
  if (!targetUser) {
    return errorResponse("USER_NOT_FOUND", "User not found", 404);
  }

  // Neighborhood is required for ledger entries, use the user's current one
  const userNeighborhood = await getUserNeighborhood(c.env.DB, userId);
  if (!userNeighborhood) {
    return errorResponse(
      "NO_NEIGHBORHOOD",
      "User is not a member of any neighborhood - cannot create ledger entry",
      409,
    );
  }

  // source_id is a fresh UUID, each adjustment is a distinct event so the
  // unique constraint (source_type, source_id, user_id) is never a duplicate
  const entry = await createCoinEntry(c.env.DB, {
    userId,
    neighborhoodId: userNeighborhood.neighborhood_id,
    sourceType: "admin_adjustment",
    sourceId: crypto.randomUUID(),
    amount,
    category: "admin",
    description: reason,
    createdBy: authContext.userId,
  });

  const newBalance = await getCoinBalance(c.env.DB, userId);

  return successResponse({
    entry_id: entry?.id,
    user_id: userId,
    amount,
    new_balance: newBalance,
  });
});

export default user;
