/**
 * Wihda Backend – Cleanify Routes
 *
 * Implements the multi-step, time-gated submission flow from Architecture.md:
 *
 *   POST   /v1/cleanify/start                       – Create draft, return submission_id
 *   POST   /v1/cleanify/:id/before/presigned-url    – Get R2 upload URL for before photo
 *   POST   /v1/cleanify/:id/before/confirm          – Confirm upload, open 20-min gate
 *   POST   /v1/cleanify/:id/after/presigned-url     – Get R2 upload URL (enforces ≥20 min)
 *   POST   /v1/cleanify/:id/after/confirm           – Confirm upload, set pending_review
 *   GET    /v1/cleanify/submissions                 – List (own or pending for mods)
 *   GET    /v1/cleanify/submissions/:id             – Get single submission
 *   POST   /v1/cleanify/submissions/:id/approve     – Approve (moderator+)
 *   POST   /v1/cleanify/submissions/:id/reject      – Reject  (moderator+)
 *   GET    /v1/cleanify/stats                       – Stats for neighborhood / user
 *
 * Time gates & rules (Architecture.md):
 *   MIN_DELAY   : 20 minutes between before_uploaded_at and after presigned-url request
 *   MAX_WINDOW  : 48 hours from before_uploaded_at to complete; else → expired
 *   Concurrent  : 1 active (draft_before | in_progress) submission per user/neighborhood
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Env, CleanifySubmission } from "../types";
import {
  getCleanifySubmissionById,
  getCleanifySubmissionsForUser,
  getPendingCleanifySubmissions,
  reviewCleanifySubmission,
  getCoinRule,
  createCoinEntry,
  createModerationLog,
} from "../lib/db";
import { errorResponse, toISODateString, generateId } from "../lib/utils";
import { checkAndAwardBadges } from "../lib/badges";
import { createUploadToken } from "../lib/upload-token";
import {
  authMiddleware,
  getAuthContext,
  requireNeighborhood,
  requireModerator,
} from "../middleware/auth";

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_DELAY_MS = 20 * 60 * 1000; // 20 minutes
const MAX_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours
const ALLOWED_EXTENSIONS: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".heic": "image/heic",
  ".webp": "image/webp",
};

// ─── Validation schemas ───────────────────────────────────────────────────────

const startSchema = z.object({
  geo_lat: z.number().min(-90).max(90).optional(),
  geo_lng: z.number().min(-180).max(180).optional(),
  description: z.string().max(1000).optional(),
});

const confirmPhotoSchema = z.object({
  file_key: z.string().min(1),
});

const presignedUrlSchema = z.object({
  file_extension: z
    .string()
    .transform((v) =>
      v.startsWith(".") ? v.toLowerCase() : `.${v.toLowerCase()}`,
    )
    .refine((v) => Object.keys(ALLOWED_EXTENSIONS).includes(v), {
      message: "file_extension must be one of: jpg, jpeg, png, heic, webp",
    })
    .optional(),
});

// note is optional on approve, required on reject (enforced per-handler)
const reviewSchema = z.object({
  note: z.string().min(1).max(1000).optional(),
});

const rejectSchema = z.object({
  note: z.string().min(1, "Rejection note is required").max(1000),
});

// ─── Router ───────────────────────────────────────────────────────────────────

const cleanify = new Hono<{ Bindings: Env }>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the upload_url the client POSTs their file bytes to.
 * Uses the same signed-token pattern as POST /v1/uploads/presigned-url so
 * the /v1/uploads/direct handler can verify and accept the upload.
 */
async function buildUploadUrl(
  requestUrl: string,
  jwtSecret: string,
  userId: string,
  fileKey: string,
  contentType: string,
): Promise<string> {
  const token = await createUploadToken(
    jwtSecret,
    userId,
    fileKey,
    contentType,
  );
  return `${new URL(requestUrl).origin}/v1/uploads/direct?token=${encodeURIComponent(token)}`;
}

/** Public read URL for a confirmed R2 object key. */
function r2Url(key: string): string {
  return `/v1/uploads/${key}`;
}

/**
 * Check whether the user already has an active (draft_before | in_progress)
 * submission in this neighborhood. Returns the existing row or null.
 */
async function getActiveSubmission(
  db: D1Database,
  userId: string,
  neighborhoodId: string,
): Promise<{ id: string; status: string } | null> {
  return db
    .prepare(
      `SELECT id, status FROM cleanify_submissions
       WHERE user_id = ? AND neighborhood_id = ?
         AND status IN ('draft_before', 'in_progress')
       LIMIT 1`,
    )
    .bind(userId, neighborhoodId)
    .first<{ id: string; status: string }>();
}

/**
 * Mark any stale in_progress submissions that have exceeded the 48-hour window
 * as expired. Called lazily on reads so we don't need a cron for this path.
 */
async function expireStaleSubmissions(
  db: D1Database,
  userId: string,
  neighborhoodId: string,
): Promise<void> {
  const cutoff = new Date(Date.now() - MAX_WINDOW_MS).toISOString();
  await db
    .prepare(
      `UPDATE cleanify_submissions
       SET status = 'expired', updated_at = datetime('now')
       WHERE user_id = ? AND neighborhood_id = ?
         AND status IN ('draft_before', 'in_progress')
         AND before_uploaded_at IS NOT NULL
         AND before_uploaded_at < ?`,
    )
    .bind(userId, neighborhoodId, cutoff)
    .run();
}

// ─── STEP 1a – Start submission ───────────────────────────────────────────────

cleanify.post(
  "/start",
  authMiddleware,
  requireNeighborhood,
  async (c) => {
    const auth = getAuthContext(c);
    if (!auth?.neighborhoodId) {
      return errorResponse(
        "NEIGHBORHOOD_REQUIRED",
        "You must join a neighborhood first",
        400,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const validation = startSchema.safeParse(body);
    if (!validation.success) {
      return errorResponse(
        "VALIDATION_ERROR",
        "Invalid request data",
        400,
        validation.error.flatten(),
      );
    }

    const { geo_lat, geo_lng, description } = validation.data;

    await expireStaleSubmissions(c.env.DB, auth.userId, auth.neighborhoodId);

    const active = await getActiveSubmission(
      c.env.DB,
      auth.userId,
      auth.neighborhoodId,
    );
    if (active) {
      return errorResponse(
        "ACTIVE_SUBMISSION_EXISTS",
        `You already have an active submission (id: ${active.id}, status: ${active.status}). Complete or abandon it first.`,
        409,
      );
    }

    const id = generateId();
    const now = toISODateString();

    await c.env.DB.prepare(
      `INSERT INTO cleanify_submissions
       (id, user_id, neighborhood_id, geo_lat, geo_lng, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'draft_before', ?, ?)`,
    )
      .bind(
        id,
        auth.userId,
        auth.neighborhoodId,
        geo_lat ?? null,
        geo_lng ?? null,
        description ?? null,
        now,
        now,
      )
      .run();

    return c.json(
      { success: true, data: { submission_id: id, status: "draft_before" } },
      201,
    );
  },
);

// ─── STEP 1b – Before photo presigned URL ─────────────────────────────────────

cleanify.post(
  "/:id/before/presigned-url",
  authMiddleware,
  async (c) => {
    const auth = getAuthContext(c);
    if (!auth)
      return errorResponse("UNAUTHORIZED", "Authentication required", 401);

    const id = c.req.param("id");
    const submission = await getCleanifySubmissionById(c.env.DB, id);

    if (!submission) {
      return errorResponse("SUBMISSION_NOT_FOUND", "Submission not found", 404);
    }
    if (submission.user_id !== auth.userId) {
      return errorResponse("FORBIDDEN", "Access denied", 403);
    }
    if (submission.status !== "draft_before") {
      return errorResponse(
        "INVALID_STATUS",
        `Cannot upload before photo when status is '${submission.status}'`,
        400,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const validation = presignedUrlSchema.safeParse(body);
    if (!validation.success) {
      return errorResponse(
        "VALIDATION_ERROR",
        validation.error.flatten().fieldErrors.file_extension?.[0] ??
          "Invalid file extension",
        400,
        validation.error.flatten(),
      );
    }
    const ext = validation.data.file_extension ?? ".jpg";
    const contentType = ALLOWED_EXTENSIONS[ext.toLowerCase()] ?? "image/jpeg";
    const fileKey = `cleanify/${auth.userId}/${id}/before${ext}`;
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const uploadUrl = await buildUploadUrl(
      c.req.url,
      c.env.JWT_SECRET,
      auth.userId,
      fileKey,
      contentType,
    );

    return c.json({
      success: true,
      data: {
        upload_url: uploadUrl,
        file_key: fileKey,
        expires_at: expiresAt,
        purpose: "cleanify_before",
      },
    });
  },
);

// ─── STEP 1c – Confirm before photo ──────────────────────────────────────────

cleanify.post(
  "/:id/before/confirm",
  authMiddleware,
  async (c) => {
    const auth = getAuthContext(c);
    if (!auth)
      return errorResponse("UNAUTHORIZED", "Authentication required", 401);

    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const validation = confirmPhotoSchema.safeParse(body);

    if (!validation.success) {
      return errorResponse(
        "VALIDATION_ERROR",
        "file_key is required",
        400,
        validation.error.flatten(),
      );
    }

    const submission = await getCleanifySubmissionById(c.env.DB, id);

    if (!submission) {
      return errorResponse("SUBMISSION_NOT_FOUND", "Submission not found", 404);
    }
    if (submission.user_id !== auth.userId) {
      return errorResponse("FORBIDDEN", "Access denied", 403);
    }
    if (submission.status !== "draft_before") {
      return errorResponse(
        "INVALID_STATUS",
        `Expected status 'draft_before', got '${submission.status}'`,
        400,
      );
    }

    const { file_key } = validation.data;
    const photoUrl = r2Url(file_key);
    const now = toISODateString();

    await c.env.DB.prepare(
      `UPDATE cleanify_submissions
     SET before_photo_url    = ?,
         before_photo_key    = ?,
         before_uploaded_at  = ?,
         started_at          = ?,
         status              = 'in_progress',
         updated_at          = ?
     WHERE id = ?`,
    )
      .bind(photoUrl, file_key, now, now, now, id)
      .run();

    return c.json({
      success: true,
      data: {
        submission_id: id,
        status: "in_progress",
        before_uploaded_at: now,
        available_after: new Date(Date.now() + MIN_DELAY_MS).toISOString(),
      },
    });
  },
);

// ─── STEP 2a – After photo presigned URL ──────────────────────────────────────

cleanify.post(
  "/:id/after/presigned-url",
  authMiddleware,
  async (c) => {
    const auth = getAuthContext(c);
    if (!auth)
      return errorResponse("UNAUTHORIZED", "Authentication required", 401);

    const id = c.req.param("id");
    const submission = await getCleanifySubmissionById(c.env.DB, id);

    if (!submission) {
      return errorResponse("SUBMISSION_NOT_FOUND", "Submission not found", 404);
    }
    if (submission.user_id !== auth.userId) {
      return errorResponse("FORBIDDEN", "Access denied", 403);
    }
    if (submission.status !== "in_progress") {
      return errorResponse(
        "INVALID_STATUS",
        `Expected status 'in_progress', got '${submission.status}'`,
        400,
      );
    }

    const beforeAt = new Date(
      submission.before_uploaded_at as string,
    ).getTime();
    const now = Date.now();
    const elapsed = now - beforeAt;

    if (elapsed > MAX_WINDOW_MS) {
      await c.env.DB.prepare(
        `UPDATE cleanify_submissions SET status = 'expired', updated_at = datetime('now') WHERE id = ?`,
      )
        .bind(id)
        .run();
      return errorResponse(
        "SUBMISSION_EXPIRED",
        "The 48-hour completion window has passed",
        410,
      );
    }

    const body = await c.req.json().catch(() => ({}));
    const validation = presignedUrlSchema.safeParse(body);
    if (!validation.success) {
      return errorResponse(
        "VALIDATION_ERROR",
        validation.error.flatten().fieldErrors.file_extension?.[0] ??
          "Invalid file extension",
        400,
        validation.error.flatten(),
      );
    }

    const ext = validation.data.file_extension ?? ".jpg";
    const contentType = ALLOWED_EXTENSIONS[ext.toLowerCase()] ?? "image/jpeg";
    const fileKey = `cleanify/${auth.userId}/${id}/after${ext}`;
    const expiresAt = new Date(now + 60 * 60 * 1000).toISOString();

    const uploadUrl = await buildUploadUrl(
      c.req.url,
      c.env.JWT_SECRET,
      auth.userId,
      fileKey,
      contentType,
    );

    return c.json({
      success: true,
      data: {
        upload_url: uploadUrl,
        file_key: fileKey,
        expires_at: expiresAt,
        purpose: "cleanify_after",
      },
    });
  },
);

// ─── STEP 2b – Confirm after photo ───────────────────────────────────────────

cleanify.post(
  "/:id/after/confirm",
  authMiddleware,
  async (c) => {
    const auth = getAuthContext(c);
    if (!auth)
      return errorResponse("UNAUTHORIZED", "Authentication required", 401);

    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const validation = confirmPhotoSchema.safeParse(body);

    if (!validation.success) {
      return errorResponse(
        "VALIDATION_ERROR",
        "file_key is required",
        400,
        validation.error.flatten(),
      );
    }

    const submission = await getCleanifySubmissionById(c.env.DB, id);

    if (!submission) {
      return errorResponse("SUBMISSION_NOT_FOUND", "Submission not found", 404);
    }
    if (submission.user_id !== auth.userId) {
      return errorResponse("FORBIDDEN", "Access denied", 403);
    }
    if (submission.status !== "in_progress") {
      return errorResponse(
        "INVALID_STATUS",
        `Expected status 'in_progress', got '${submission.status}'`,
        400,
      );
    }

    const elapsed =
      Date.now() - new Date(submission.before_uploaded_at as string).getTime();
    if (elapsed > MAX_WINDOW_MS) {
      await c.env.DB.prepare(
        `UPDATE cleanify_submissions SET status = 'expired', updated_at = datetime('now') WHERE id = ?`,
      )
        .bind(id)
        .run();
      return errorResponse(
        "SUBMISSION_EXPIRED",
        "The 48-hour completion window has passed",
        410,
      );
    }

    const { file_key } = validation.data;
    const photoUrl = r2Url(file_key);
    const now = toISODateString();

    await c.env.DB.prepare(
      `UPDATE cleanify_submissions
     SET after_photo_url   = ?,
         after_photo_key   = ?,
         after_uploaded_at = ?,
         completed_at      = ?,
         status            = 'pending_review',
         updated_at        = ?
     WHERE id = ?`,
    )
      .bind(photoUrl, file_key, now, now, now, id)
      .run();

    await c.env.CLEANIFY_QUEUE.send({
      type: "run_ai_check",
      submission_id: id,
      user_id: auth.userId,
      neighborhood_id: submission.neighborhood_id,
      timestamp: now,
    });

    return c.json({
      success: true,
      data: {
        submission_id: id,
        status: "pending_review",
        completed_at: now,
      },
    });
  },
);

// ─── List submissions ─────────────────────────────────────────────────────────

cleanify.get("/submissions", authMiddleware, async (c) => {
  const auth = getAuthContext(c);
  if (!auth)
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);

  const pending = c.req.query("pending") === "true";
  const limit = Math.min(parseInt(c.req.query("limit") || "20", 10), 100);

  let submissions: CleanifySubmission[];

  if (pending) {
    const isMod = auth.userRole === "moderator" || auth.userRole === "admin";
    if (!isMod) {
      return errorResponse(
        "INSUFFICIENT_PERMISSIONS",
        "Moderator access required for pending submissions",
        403,
      );
    }
    submissions = await getPendingCleanifySubmissions(c.env.DB, limit);
  } else {
    submissions = await getCleanifySubmissionsForUser(
      c.env.DB,
      auth.userId,
      limit,
    );
  }

  const userIds = [...new Set(submissions.map((s) => s.user_id))];
  const reviewerIds = [
    ...new Set(
      submissions
        .map((s) => s.reviewer_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const fetchUsersById = async (ids: string[]) => {
    if (ids.length === 0)
      return {} as Record<string, { id: string; display_name: string }>;
    const rows = (
      await c.env.DB.prepare(
        `SELECT id, display_name FROM users WHERE id IN (${ids.map(() => "?").join(",")})`,
      )
        .bind(...ids)
        .all()
    ).results as { id: string; display_name: string }[];
    return Object.fromEntries(rows.map((u) => [u.id, u]));
  };

  const [userMap, reviewerMap] = await Promise.all([
    fetchUsersById(userIds),
    fetchUsersById(reviewerIds),
  ]);

  const enriched = submissions.map((sub) =>
    formatSubmission(
      sub,
      userMap[sub.user_id] ?? null,
      sub.reviewer_id ? (reviewerMap[sub.reviewer_id] ?? null) : null,
    ),
  );

  return c.json({ success: true, data: { submissions: enriched } });
});

// ─── Get single submission ────────────────────────────────────────────────────

cleanify.get("/submissions/:id", authMiddleware, async (c) => {
  const auth = getAuthContext(c);
  if (!auth)
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);

  const id = c.req.param("id");
  const submission = await getCleanifySubmissionById(c.env.DB, id);

  if (!submission) {
    return errorResponse("SUBMISSION_NOT_FOUND", "Submission not found", 404);
  }

  const isOwner = submission.user_id === auth.userId;
  const isMod = auth.userRole === "moderator" || auth.userRole === "admin";
  if (!isOwner && !isMod) {
    return errorResponse("FORBIDDEN", "Access denied", 403);
  }

  const [user, reviewer] = await Promise.all([
    c.env.DB.prepare("SELECT id, display_name FROM users WHERE id = ?")
      .bind(submission.user_id)
      .first<{ id: string; display_name: string }>(),
    submission.reviewer_id
      ? c.env.DB.prepare("SELECT id, display_name FROM users WHERE id = ?")
          .bind(submission.reviewer_id)
          .first<{ id: string; display_name: string }>()
      : Promise.resolve(null),
  ]);

  return c.json({
    success: true,
    data: formatSubmission(submission, user, reviewer),
  });
});

// ─── Approve ──────────────────────────────────────────────────────────────────

/**
 * POST /v1/cleanify/submissions/:id/approve
 * Moderator only. Awards coins and notifies user.
 */
cleanify.post(
  "/submissions/:id/approve",
  authMiddleware,
  requireModerator,
  async (c) => {
    const auth = getAuthContext(c);
    if (!auth)
      return errorResponse("UNAUTHORIZED", "Authentication required", 401);

    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const validation = reviewSchema.safeParse(body);

    const submission = await getCleanifySubmissionById(c.env.DB, id);
    if (!submission) {
      return errorResponse("SUBMISSION_NOT_FOUND", "Submission not found", 404);
    }
    if (submission.status !== "pending_review") {
      return errorResponse(
        "ALREADY_REVIEWED",
        "This submission has already been reviewed",
        400,
      );
    }

    const coinRule = await getCoinRule(c.env.DB, "cleanify_approved");
    const coinAmount = coinRule?.amount ?? 150;
    const note = validation.success ? validation.data.note : undefined;

    await reviewCleanifySubmission(c.env.DB, id, {
      status: "approved",
      reviewerId: auth.userId,
      note,
      coinsAwarded: coinAmount,
    });

    await createCoinEntry(c.env.DB, {
      userId: submission.user_id,
      neighborhoodId: submission.neighborhood_id,
      sourceType: "cleanify_approved",
      sourceId: id,
      amount: coinAmount,
      category: "cleanify",
      description: "Reward for approved cleanify submission",
      createdBy: auth.userId,
    });

    await createModerationLog(c.env.DB, {
      moderatorId: auth.userId,
      actionType: "cleanify_approve",
      targetType: "submission",
      targetId: id,
      reason: note,
    });

    const now = toISODateString();
    await c.env.NOTIFICATION_QUEUE.send({
      user_id: submission.user_id,
      type: "cleanify_approved",
      title: "Submission Approved! 🎉",
      body: `Your cleanify submission has been approved. You earned ${coinAmount} coins!`,
      data: { submission_id: id, coins: coinAmount },
      timestamp: now,
    });

    // Check & award badges after cleanify approval (non-blocking)
    checkAndAwardBadges(c.env.DB, submission.user_id);

    return c.json({
      success: true,
      data: {
        submission: {
          id,
          status: "approved",
          coins_awarded: coinAmount,
          reviewed_at: now,
        },
      },
    });
  },
);

// ─── Reject ───────────────────────────────────────────────────────────────────

/**
 * POST /v1/cleanify/submissions/:id/reject
 * Moderator only. Note is required.
 */
cleanify.post(
  "/submissions/:id/reject",
  authMiddleware,
  requireModerator,
  async (c) => {
    const auth = getAuthContext(c);
    if (!auth)
      return errorResponse("UNAUTHORIZED", "Authentication required", 401);

    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const validation = rejectSchema.safeParse(body);

    if (!validation.success) {
      return errorResponse(
        "VALIDATION_ERROR",
        "A rejection note is required",
        400,
        validation.error.flatten(),
      );
    }

    const submission = await getCleanifySubmissionById(c.env.DB, id);
    if (!submission) {
      return errorResponse("SUBMISSION_NOT_FOUND", "Submission not found", 404);
    }
    if (submission.status !== "pending_review") {
      return errorResponse(
        "ALREADY_REVIEWED",
        "This submission has already been reviewed",
        400,
      );
    }

    const { note } = validation.data;

    await reviewCleanifySubmission(c.env.DB, id, {
      status: "rejected",
      reviewerId: auth.userId,
      note,
    });

    await createModerationLog(c.env.DB, {
      moderatorId: auth.userId,
      actionType: "cleanify_reject",
      targetType: "submission",
      targetId: id,
      reason: note,
    });

    const now = toISODateString();
    await c.env.NOTIFICATION_QUEUE.send({
      user_id: submission.user_id,
      type: "cleanify_rejected",
      title: "Submission Review",
      body: note,
      data: { submission_id: id, reason: note },
      timestamp: now,
    });

    return c.json({
      success: true,
      data: {
        submission: { id, status: "rejected", reviewed_at: now },
      },
    });
  },
);

// ─── Stats ────────────────────────────────────────────────────────────────────

cleanify.get("/stats", authMiddleware, async (c) => {
  const auth = getAuthContext(c);
  if (!auth)
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);

  const neighborhoodId = auth.neighborhoodId;
  if (!neighborhoodId) {
    return errorResponse(
      "NEIGHBORHOOD_REQUIRED",
      "You must join a neighborhood to view stats",
      400,
    );
  }

  const [nbStats, coinsRow, userStats] = await Promise.all([
    c.env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'approved'       THEN 1 ELSE 0 END) AS approved,
         SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END) AS pending_review,
         SUM(CASE WHEN status = 'rejected'       THEN 1 ELSE 0 END) AS rejected,
         SUM(CASE WHEN status = 'in_progress'    THEN 1 ELSE 0 END) AS in_progress,
         SUM(CASE WHEN status = 'expired'        THEN 1 ELSE 0 END) AS expired
       FROM cleanify_submissions
       WHERE neighborhood_id = ?`,
    )
      .bind(neighborhoodId)
      .first<Record<string, number>>(),

    c.env.DB.prepare(
      `SELECT COALESCE(SUM(coins_awarded), 0) AS total
       FROM cleanify_submissions
       WHERE neighborhood_id = ? AND status = 'approved'`,
    )
      .bind(neighborhoodId)
      .first<{ total: number }>(),

    c.env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
         COALESCE(SUM(coins_awarded), 0) AS coins
       FROM cleanify_submissions
       WHERE user_id = ? AND neighborhood_id = ?`,
    )
      .bind(auth.userId, neighborhoodId)
      .first<Record<string, number>>(),
  ]);

  return c.json({
    success: true,
    data: {
      neighborhood: {
        total_submissions: nbStats?.total ?? 0,
        approved: nbStats?.approved ?? 0,
        pending_review: nbStats?.pending_review ?? 0,
        rejected: nbStats?.rejected ?? 0,
        in_progress: nbStats?.in_progress ?? 0,
        expired: nbStats?.expired ?? 0,
        total_coins_awarded: coinsRow?.total ?? 0,
      },
      user: {
        total_submissions: userStats?.total ?? 0,
        approved: userStats?.approved ?? 0,
        coins_earned: userStats?.coins ?? 0,
      },
    },
  });
});

// ─── GET /v1/cleanify/active ──────────────────────────────────────────────────
/**
 * Returns the user's current active submission (draft_before or in_progress),
 * or null if none exists.
 */
cleanify.get("/active", authMiddleware, async (c) => {
  const auth = getAuthContext(c);
  if (!auth) return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  if (!auth.neighborhoodId) return c.json({ success: true, data: { submission: null } });

  await expireStaleSubmissions(c.env.DB, auth.userId, auth.neighborhoodId);

  const active = await getActiveSubmission(c.env.DB, auth.userId, auth.neighborhoodId);
  return c.json({ success: true, data: { submission: active ?? null } });
});

// ─── POST /v1/cleanify/:id/abandon ───────────────────────────────────────────
/**
 * Abandons a draft_before or in_progress submission owned by the user.
 */
cleanify.post("/:id/abandon", authMiddleware, async (c) => {
  const auth = getAuthContext(c);
  if (!auth) return errorResponse("UNAUTHORIZED", "Authentication required", 401);

  const id = c.req.param("id");
  const submission = await getCleanifySubmissionById(c.env.DB, id);

  if (!submission) return errorResponse("NOT_FOUND", "Submission not found", 404);
  if (submission.user_id !== auth.userId) return errorResponse("FORBIDDEN", "Not your submission", 403);
  if (!["draft_before", "in_progress"].includes(submission.status)) {
    return errorResponse("INVALID_STATE", "Only active submissions can be abandoned", 400);
  }

  await c.env.DB.prepare(
    `UPDATE cleanify_submissions SET status = 'expired', updated_at = datetime('now') WHERE id = ?`
  ).bind(id).run();

  return c.json({ success: true, data: { abandoned: true } });
});

// ─── Format helper ────────────────────────────────────────────────────────────

function formatSubmission(
  sub: CleanifySubmission,
  user: { id: string; display_name: string } | null | undefined,
  reviewer: { id: string; display_name: string } | null | undefined,
) {
  return {
    id: sub.id,
    user: user ? { id: user.id, display_name: user.display_name } : null,
    before_photo_url: sub.before_photo_url,
    after_photo_url: sub.after_photo_url,
    geo:
      sub.geo_lat != null && sub.geo_lng != null
        ? { lat: sub.geo_lat, lng: sub.geo_lng }
        : null,
    description: sub.description,
    status: sub.status,
    before_uploaded_at: sub.before_uploaded_at,
    started_at: sub.started_at,
    completed_at: sub.completed_at,
    reviewer: reviewer
      ? { id: reviewer.id, display_name: reviewer.display_name }
      : null,
    reviewed_at: sub.reviewed_at,
    review_note: sub.review_note,
    coins_awarded: sub.coins_awarded,
    created_at: sub.created_at,
  };
}

export default cleanify;
