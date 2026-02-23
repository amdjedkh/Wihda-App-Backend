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
    .regex(/^\.[a-zA-Z0-9]+$/)
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
  return `${new URL(requestUrl).origin}/v1/uploads/direct?token=${token}`;
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

/**
 * POST /v1/cleanify/start
 * Creates a new submission in draft_before status.
 * Blocks if user already has an active submission in this neighborhood.
 */
cleanify.post("/start", authMiddleware, requireNeighborhood, async (c) => {
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

  // Expire any stale submissions first so the concurrent check is accurate
  await expireStaleSubmissions(c.env.DB, auth.userId, auth.neighborhoodId);

  // Concurrent-submission guard
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
});

// ─── STEP 1b – Before photo presigned URL ─────────────────────────────────────

/**
 * POST /v1/cleanify/:id/before/presigned-url
 * Returns a presigned R2 upload URL for the before photo.
 * Submission must be in draft_before status and belong to the caller.
 */
cleanify.post("/:id/before/presigned-url", authMiddleware, async (c) => {
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
  const ext =
    validation.success && validation.data.file_extension
      ? validation.data.file_extension
      : ".jpg";

  const fileKey = `cleanify/${auth.userId}/${id}/before${ext}`;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // matches 1h token life

  const uploadUrl = await buildUploadUrl(
    c.req.url,
    c.env.JWT_SECRET,
    auth.userId,
    fileKey,
    "before_photo",
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
});

// ─── STEP 1c – Confirm before photo ──────────────────────────────────────────

/**
 * POST /v1/cleanify/:id/before/confirm
 * Confirms the before photo was uploaded. Sets status → in_progress and
 * records before_uploaded_at (the start of the 20-min / 48-hr window).
 */
cleanify.post("/:id/before/confirm", authMiddleware, async (c) => {
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
});

// ─── STEP 2a – After photo presigned URL ──────────────────────────────────────

/**
 * POST /v1/cleanify/:id/after/presigned-url
 * Returns a presigned R2 upload URL for the after photo.
 * Enforces:
 *   - status must be in_progress
 *   - at least MIN_DELAY_MS (20 min) must have passed since before_uploaded_at
 *   - no more than MAX_WINDOW_MS (48 h) since before_uploaded_at
 */
cleanify.post("/:id/after/presigned-url", authMiddleware, async (c) => {
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

  const beforeAt = new Date(submission.before_uploaded_at as string).getTime();
  const now = Date.now();
  const elapsed = now - beforeAt;

  // 48-hour expiry
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

  // 20-minute minimum
  if (elapsed < MIN_DELAY_MS) {
    const waitMs = MIN_DELAY_MS - elapsed;
    const availableAt = new Date(beforeAt + MIN_DELAY_MS).toISOString();
    return errorResponse(
      "TOO_EARLY",
      `After photo not available yet. Please wait ${Math.ceil(waitMs / 60000)} more minute(s).`,
      400,
      { available_at: availableAt },
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const validation = presignedUrlSchema.safeParse(body);
  const ext =
    validation.success && validation.data.file_extension
      ? validation.data.file_extension
      : ".jpg";

  const fileKey = `cleanify/${auth.userId}/${id}/after${ext}`;
  const expiresAt = new Date(now + 60 * 60 * 1000).toISOString();

  const uploadUrl = await buildUploadUrl(
    c.req.url,
    c.env.JWT_SECRET,
    auth.userId,
    fileKey,
    "after_photo",
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
});

// ─── STEP 2b – Confirm after photo ───────────────────────────────────────────

/**
 * POST /v1/cleanify/:id/after/confirm
 * Confirms the after photo was uploaded.
 * Sets status → pending_review and enqueues a mod notification.
 */
cleanify.post("/:id/after/confirm", authMiddleware, async (c) => {
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

  // Re-check 48h window on confirm too
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

  // Notify moderators a new submission is waiting
  await c.env.NOTIFICATION_QUEUE.send({
    user_id: auth.userId, // sender context; mod notification handled in queue consumer
    type: "system",
    title: "New Cleanify Submission",
    body: "A new cleanify submission is awaiting review.",
    data: { submission_id: id, neighborhood_id: submission.neighborhood_id },
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
});

// ─── List submissions ─────────────────────────────────────────────────────────

/**
 * GET /v1/cleanify/submissions
 * ?mine=true   → caller's own submissions (default if no other flag)
 * ?pending=true → pending_review list (moderator/admin only)
 * ?limit=N
 */
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
    // Default: return caller's own submissions
    submissions = await getCleanifySubmissionsForUser(
      c.env.DB,
      auth.userId,
      limit,
    );
  }

  const enriched = await Promise.all(
    submissions.map(async (sub) => {
      const user = await c.env.DB.prepare(
        "SELECT id, display_name FROM users WHERE id = ?",
      )
        .bind(sub.user_id)
        .first<{ id: string; display_name: string }>();

      const reviewer = sub.reviewer_id
        ? await c.env.DB.prepare(
            "SELECT id, display_name FROM users WHERE id = ?",
          )
            .bind(sub.reviewer_id)
            .first<{ id: string; display_name: string }>()
        : null;

      return formatSubmission(sub, user, reviewer);
    }),
  );

  return c.json({ success: true, data: { submissions: enriched } });
});

// ─── Get single submission ────────────────────────────────────────────────────

/**
 * GET /v1/cleanify/submissions/:id
 */
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

  const user = await c.env.DB.prepare(
    "SELECT id, display_name FROM users WHERE id = ?",
  )
    .bind(submission.user_id)
    .first<{ id: string; display_name: string }>();

  const reviewer = submission.reviewer_id
    ? await c.env.DB.prepare("SELECT id, display_name FROM users WHERE id = ?")
        .bind(submission.reviewer_id)
        .first<{ id: string; display_name: string }>()
    : null;

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

    // Idempotent coin award (unique constraint on source_type + source_id + user_id)
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

/**
 * GET /v1/cleanify/stats
 * ?neighborhood_id=... (defaults to caller's neighborhood)
 */
cleanify.get("/stats", authMiddleware, async (c) => {
  const auth = getAuthContext(c);
  if (!auth)
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);

  const neighborhoodId = c.req.query("neighborhood_id") || auth.neighborhoodId;
  if (!neighborhoodId) {
    return errorResponse(
      "NEIGHBORHOOD_REQUIRED",
      "neighborhood_id is required",
      400,
    );
  }

  const [nbStats, coinsRow, userStats] = await Promise.all([
    // All status counts in one query
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

    // Total coins awarded in neighborhood
    c.env.DB.prepare(
      `SELECT COALESCE(SUM(coins_awarded), 0) AS total
       FROM cleanify_submissions
       WHERE neighborhood_id = ? AND status = 'approved'`,
    )
      .bind(neighborhoodId)
      .first<{ total: number }>(),

    // Caller's personal stats
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
