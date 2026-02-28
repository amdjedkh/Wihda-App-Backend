/**
 * Wihda Backend - Verification Routes
 *
 * POST /v1/verification/start           → Open or reuse a verification session
 * POST /v1/verification/presigned-url   → Get upload URL for one document
 * POST /v1/verification/submit          → Enqueue AI review job
 * GET  /v1/verification/status          → Poll current session status
 * POST /v1/verification/webhook         → Internal: called by queue consumer
 * POST /v1/verification/admin/review    → Admin manual override
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Env, PresignedUrlResponse } from "../types";
import {
  getVerificationSessionById,
  getLatestVerificationSessionForUser,
  createVerificationSession,
  updateVerificationSession,
  updateUserVerificationStatus,
} from "../lib/db";
import { successResponse, errorResponse } from "../lib/utils";
import { createUploadToken } from "../lib/upload-token";
import {
  authMiddleware,
  requireAdmin,
  getAuthContext,
} from "../middleware/auth";

const verification = new Hono<{ Bindings: Env }>();

// ─── Constants ────────────────────────────────────────────────────────────────

const ALLOWED_EXTENSIONS: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  webp: "image/webp",
};

// 10 MB per document
const MAX_BYTES = 10 * 1024 * 1024;

// ─── Validation schemas ────────────────────────────────────────────────────────

const presignedUrlSchema = z.object({
  session_id: z.string().uuid(),
  document_type: z.enum(["front", "back", "selfie"]),
  file_extension: z.enum(["jpg", "jpeg", "png", "heic", "webp"]),
});

const submitSchema = z.object({
  session_id: z.string().uuid(),
});

const webhookSchema = z.object({
  session_id: z.string().uuid(),
  approved: z.boolean(),
  confidence: z.number().min(0).max(1),
  rejection_reason: z.string().optional(),
  ai_result: z.record(z.unknown()).optional(),
});

const manualReviewSchema = z.object({
  session_id: z.string().uuid(),
  approved: z.boolean(),
  note: z.string().max(1000).optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a presigned upload URL using the existing upload-token infrastructure.
 *
 * The base URL is derived from the incoming request so this works correctly
 * in every environment (local, staging, production).
 */
async function generateDocumentPresignedUrl(
  secret: string,
  requestUrl: string,
  userId: string,
  sessionId: string,
  documentType: string,
  fileExtension: string,
): Promise<PresignedUrlResponse> {
  const fileKey = `verification/${userId}/${sessionId}/${documentType}.${fileExtension}`;
  const mimeType = ALLOWED_EXTENSIONS[fileExtension] ?? "image/jpeg";

  const token = await createUploadToken(secret, userId, fileKey, mimeType);

  // Derive base URL from the live request
  const { protocol, host } = new URL(requestUrl);
  const uploadUrl = `${protocol}//${host}/v1/uploads/direct?token=${encodeURIComponent(token)}`;

  return {
    upload_url: uploadUrl,
    file_key: fileKey,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}

// ─── POST /v1/verification/start ─────────────────────────────────────────────

verification.post("/start", authMiddleware, async (c) => {
  const auth = getAuthContext(c)!;

  if (auth.verificationStatus === "verified") {
    return successResponse({ already_verified: true });
  }

  try {
    const existing = await getLatestVerificationSessionForUser(
      c.env.DB,
      auth.userId,
    );

    if (
      existing &&
      (existing.status === "created" || existing.status === "pending")
    ) {
      return successResponse({
        session_id: existing.id,
        status: existing.status,
        expires_at: existing.expires_at,
        upload_requirements: {
          documents: ["front", "back", "selfie"],
          max_size_bytes: MAX_BYTES,
          allowed_extensions: Object.keys(ALLOWED_EXTENSIONS).filter(
            (k) => k !== "jpeg",
          ),
        },
      });
    }

    // Hard cap: 3 failed attempts before admin must intervene
    if ((existing?.attempt_count ?? 0) >= 3) {
      return errorResponse(
        "MAX_ATTEMPTS_EXCEEDED",
        "Maximum verification attempts reached. Please contact support.",
        429,
      );
    }

    const session = await createVerificationSession(c.env.DB, auth.userId);

    return successResponse(
      {
        session_id: session.id,
        status: session.status,
        expires_at: session.expires_at,
        upload_requirements: {
          documents: ["front", "back", "selfie"],
          max_size_bytes: MAX_BYTES,
          allowed_extensions: Object.keys(ALLOWED_EXTENSIONS).filter(
            (k) => k !== "jpeg",
          ),
        },
      },
      201,
    );
  } catch (error) {
    console.error("Verification start error:", error);
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to start verification session",
      500,
    );
  }
});

// ─── POST /v1/verification/presigned-url ─────────────────────────────────────

verification.post("/presigned-url", authMiddleware, async (c) => {
  const auth = getAuthContext(c)!;

  try {
    const body = await c.req.json();
    const validation = presignedUrlSchema.safeParse(body);
    if (!validation.success) {
      return errorResponse(
        "VALIDATION_ERROR",
        "Invalid request data",
        400,
        validation.error.flatten(),
      );
    }

    const { session_id, document_type, file_extension } = validation.data;
    const session = await getVerificationSessionById(c.env.DB, session_id);

    if (!session)
      return errorResponse(
        "SESSION_NOT_FOUND",
        "Verification session not found",
        404,
      );
    if (session.user_id !== auth.userId)
      return errorResponse("FORBIDDEN", "Access denied", 403);
    if (session.status !== "created") {
      return errorResponse(
        "SESSION_NOT_OPEN",
        `Session is in '${session.status}' state and cannot accept uploads.`,
        409,
      );
    }
    if (new Date(session.expires_at) < new Date()) {
      await updateVerificationSession(c.env.DB, session_id, {
        status: "expired",
      });
      return errorResponse(
        "SESSION_EXPIRED",
        "Verification session has expired. Please start a new one.",
        410,
      );
    }

    const result = await generateDocumentPresignedUrl(
      c.env.JWT_SECRET, // upload tokens use the same HMAC secret
      c.req.url,
      auth.userId,
      session_id,
      document_type,
      file_extension,
    );

    // Store the generated key so /submit can confirm all three are present
    const keyField =
      document_type === "front"
        ? { front_doc_key: result.file_key }
        : document_type === "back"
          ? { back_doc_key: result.file_key }
          : { selfie_key: result.file_key };

    await updateVerificationSession(c.env.DB, session_id, keyField);

    return successResponse(result);
  } catch (error) {
    console.error("Presigned URL error:", error);
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to generate upload URL",
      500,
    );
  }
});

// ─── POST /v1/verification/submit ─────────────────────────────────────────────

verification.post("/submit", authMiddleware, async (c) => {
  const auth = getAuthContext(c)!;

  try {
    const body = await c.req.json();
    const validation = submitSchema.safeParse(body);
    if (!validation.success) {
      return errorResponse(
        "VALIDATION_ERROR",
        "Invalid request data",
        400,
        validation.error.flatten(),
      );
    }

    const { session_id } = validation.data;
    const session = await getVerificationSessionById(c.env.DB, session_id);

    if (!session)
      return errorResponse(
        "SESSION_NOT_FOUND",
        "Verification session not found",
        404,
      );
    if (session.user_id !== auth.userId)
      return errorResponse("FORBIDDEN", "Access denied", 403);
    if (session.status !== "created") {
      return errorResponse(
        "SESSION_NOT_OPEN",
        `Session is already in '${session.status}' state.`,
        409,
      );
    }
    if (new Date(session.expires_at) < new Date()) {
      await updateVerificationSession(c.env.DB, session_id, {
        status: "expired",
      });
      return errorResponse(
        "SESSION_EXPIRED",
        "Verification session has expired.",
        410,
      );
    }

    if (
      !session.front_doc_key ||
      !session.back_doc_key ||
      !session.selfie_key
    ) {
      return errorResponse(
        "DOCUMENTS_INCOMPLETE",
        "All three documents (front ID, back ID, selfie) must be uploaded before submitting.",
        422,
      );
    }

    await updateVerificationSession(c.env.DB, session_id, {
      status: "pending",
      attempt_count: (session.attempt_count ?? 0) + 1,
      last_attempt_at: new Date().toISOString(),
    });

    await updateUserVerificationStatus(c.env.DB, auth.userId, "pending");

    await c.env.VERIFICATION_QUEUE.send({
      type: "run_ai_check",
      session_id,
      user_id: auth.userId,
      timestamp: new Date().toISOString(),
    });

    return successResponse({
      status: "pending",
      message: "Verification submitted. Review typically takes 1–2 minutes.",
    });
  } catch (error) {
    console.error("Verification submit error:", error);
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to submit verification",
      500,
    );
  }
});

// ─── GET /v1/verification/status ──────────────────────────────────────────────

verification.get("/status", authMiddleware, async (c) => {
  const auth = getAuthContext(c)!;

  try {
    const session = await getLatestVerificationSessionForUser(
      c.env.DB,
      auth.userId,
    );

    return successResponse({
      verification_status: auth.verificationStatus,
      session: session
        ? {
            id: session.id,
            status: session.status,
            expires_at: session.expires_at,
            rejection_reason:
              session.status === "failed" ? session.ai_rejection_reason : null,
            created_at: session.created_at,
          }
        : null,
    });
  } catch (error) {
    console.error("Verification status error:", error);
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to fetch verification status",
      500,
    );
  }
});

// ─── POST /v1/verification/webhook ────────────────────────────────────────────

/**
 * Internal endpoint called by the verification queue consumer after Gemini responds.
 *
 * This route is intentionally NOT behind authMiddleware.
 */
verification.post("/webhook", async (c) => {
  const secret = c.req.header("X-Internal-Secret");
  if (!secret || secret !== c.env.INTERNAL_WEBHOOK_SECRET) {
    return errorResponse("UNAUTHORIZED", "Invalid internal secret", 401);
  }

  try {
    const body = await c.req.json();
    const validation = webhookSchema.safeParse(body);
    if (!validation.success) {
      return errorResponse(
        "VALIDATION_ERROR",
        "Invalid webhook payload",
        400,
        validation.error.flatten(),
      );
    }

    const { session_id, approved, confidence, rejection_reason, ai_result } =
      validation.data;

    const session = await getVerificationSessionById(c.env.DB, session_id);
    if (!session)
      return errorResponse("SESSION_NOT_FOUND", "Session not found", 404);

    // Idempotency — ignore if already finalized
    if (session.status === "verified" || session.status === "failed") {
      return successResponse({ already_finalized: true });
    }

    const newStatus = approved ? "verified" : "failed";

    await updateVerificationSession(c.env.DB, session_id, {
      status: newStatus,
      ai_result: JSON.stringify(ai_result ?? {}),
      ai_confidence: confidence,
      ai_rejection_reason: rejection_reason ?? null,
      ai_reviewed_at: new Date().toISOString(),
    });

    await updateUserVerificationStatus(
      c.env.DB,
      session.user_id,
      approved ? "verified" : "failed",
    );

    await c.env.NOTIFICATION_QUEUE.send(
      approved
        ? {
            user_id: session.user_id,
            type: "verification_approved",
            title: "Identity Verified ✓",
            body: "Your identity has been verified. You now have full access to Wihda.",
            timestamp: new Date().toISOString(),
          }
        : {
            user_id: session.user_id,
            type: "verification_rejected",
            title: "Verification Failed",
            body:
              rejection_reason ??
              "Your verification could not be completed. Please try again.",
            timestamp: new Date().toISOString(),
          },
    );

    return successResponse({ finalized: true, status: newStatus });
  } catch (error) {
    console.error("Verification webhook error:", error);
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to process verification result",
      500,
    );
  }
});

// ─── POST /v1/verification/admin/review ───────────────────────────────────────

/** Admin manual override — approve or reject any session. */
verification.post("/admin/review", authMiddleware, requireAdmin, async (c) => {
  const auth = getAuthContext(c)!;

  try {
    const body = await c.req.json();
    const validation = manualReviewSchema.safeParse(body);
    if (!validation.success) {
      return errorResponse(
        "VALIDATION_ERROR",
        "Invalid request data",
        400,
        validation.error.flatten(),
      );
    }

    const { session_id, approved, note } = validation.data;
    const session = await getVerificationSessionById(c.env.DB, session_id);
    if (!session)
      return errorResponse("SESSION_NOT_FOUND", "Session not found", 404);

    const newStatus = approved ? "verified" : "failed";

    await updateVerificationSession(c.env.DB, session_id, {
      status: newStatus,
      manual_reviewer_id: auth.userId,
      manual_reviewed_at: new Date().toISOString(),
      manual_note: note ?? null,
    });

    await updateUserVerificationStatus(
      c.env.DB,
      session.user_id,
      approved ? "verified" : "failed",
    );

    return successResponse({ finalized: true, status: newStatus });
  } catch (error) {
    console.error("Admin review error:", error);
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to process admin review",
      500,
    );
  }
});

export default verification;
