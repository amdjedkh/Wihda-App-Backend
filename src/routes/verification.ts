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
  getUserById,
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
}).refine((d) => d.approved || (d.note && d.note.trim().length > 0), {
  message: "A rejection reason is required when rejecting",
  path: ["note"],
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

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

    if (existing && existing.status === "processing") {
      return successResponse({
        session_id: existing.id,
        status: "processing",
        expires_at: existing.expires_at,
        message:
          "Your documents are currently being reviewed. Please poll /status for updates.",
      });
    }

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
      c.env.JWT_SECRET,
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

// ─── POST /v1/verification/upload ─────────────────────────────────────────────

/**
 * Direct multipart upload for verification documents.
 * Accepts a single file as multipart/form-data with fields:
 *   session_id      — verification session UUID
 *   document_type   — "front" | "back" | "selfie"
 *   file            — the image file
 */
verification.post("/upload", authMiddleware, async (c) => {
  const auth = getAuthContext(c)!;

  try {
    const formData = await c.req.formData();
    const sessionId = formData.get("session_id") as string | null;
    const documentType = formData.get("document_type") as string | null;
    const file = formData.get("file") as File | null;

    if (!sessionId || !documentType || !file) {
      return errorResponse("VALIDATION_ERROR", "session_id, document_type, and file are required", 400);
    }

    if (!["front", "back", "selfie"].includes(documentType)) {
      return errorResponse("VALIDATION_ERROR", "document_type must be front, back, or selfie", 400);
    }

    if (file.size > MAX_BYTES) {
      return errorResponse("FILE_TOO_LARGE", "File must be less than 10MB", 400);
    }

    const session = await getVerificationSessionById(c.env.DB, sessionId);
    if (!session) return errorResponse("SESSION_NOT_FOUND", "Session not found", 404);
    if (session.user_id !== auth.userId) return errorResponse("FORBIDDEN", "Access denied", 403);
    if (session.status !== "created") {
      return errorResponse("SESSION_NOT_OPEN", `Session is in '${session.status}' state`, 409);
    }
    if (new Date(session.expires_at) < new Date()) {
      await updateVerificationSession(c.env.DB, sessionId, { status: "expired" });
      return errorResponse("SESSION_EXPIRED", "Session expired. Please start a new one.", 410);
    }

    const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
    const safeExt = Object.keys(ALLOWED_EXTENSIONS).includes(ext) ? ext : "jpg";
    const fileKey = `verification/${auth.userId}/${sessionId}/${documentType}.${safeExt}`;
    const mimeType = file.type || ALLOWED_EXTENSIONS[safeExt] || "image/jpeg";

    const buffer = await file.arrayBuffer();
    await c.env.STORAGE.put(fileKey, buffer, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { userId: auth.userId, documentType },
    });

    const keyField =
      documentType === "front" ? { front_doc_key: fileKey } :
      documentType === "back"  ? { back_doc_key:  fileKey } :
                                  { selfie_key:    fileKey };

    await updateVerificationSession(c.env.DB, sessionId, keyField);

    return successResponse({ document_type: documentType, file_key: fileKey });
  } catch (error) {
    console.error("Verification upload error:", error);
    return errorResponse("INTERNAL_ERROR", "Failed to upload document", 500);
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

    return successResponse({
      status: "pending",
      message: "Verification submitted. Our team will review your documents shortly.",
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
    const user = await getUserById(c.env.DB, auth.userId);
    if (!user) {
      return errorResponse("USER_NOT_FOUND", "User not found", 404);
    }

    const session = await getLatestVerificationSessionForUser(
      c.env.DB,
      auth.userId,
    );

    return successResponse({
      verification_status: user.verification_status, // live DB value
      session: session
        ? {
            id: session.id,
            status: session.status,
            expires_at: session.expires_at,
            rejection_reason:
              session.status === "failed"
                ? ((session as any).manual_note || session.ai_rejection_reason || null)
                : null,
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
 * NOT behind authMiddleware - protected by INTERNAL_WEBHOOK_SECRET instead.
 */
verification.post("/webhook", async (c) => {
  const secret = c.req.header("X-Internal-Secret");

  if (!secret || !timingSafeEqual(secret, c.env.INTERNAL_WEBHOOK_SECRET)) {
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

/** Admin manual override, approve or reject any session. */
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

    if (session.status === "verified" || session.status === "failed") {
      return successResponse({
        already_finalized: true,
        status: session.status,
      });
    }

    const newStatus = approved ? "verified" : "failed";
    const now = new Date().toISOString();

    // 1. Update session
    await updateVerificationSession(c.env.DB, session_id, {
      status: newStatus,
      manual_reviewer_id: auth.userId,
      manual_reviewed_at: now,
      manual_note: note ?? null,
    });

    // 2. Update user verification_status
    await updateUserVerificationStatus(
      c.env.DB,
      session.user_id,
      approved ? "verified" : "failed",
    );

    // 3. Write notification directly to DB so user sees it immediately
    const notifTitle = approved ? "Identity Verified ✓" : "Verification Failed";
    const notifBody = approved
      ? "Your identity has been verified. You now have full access to Wihda."
      : (note ?? "Your verification was not approved. Please contact support for details.");

    await c.env.DB.prepare(
      `INSERT INTO notifications (id, user_id, type, title, body, data, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, datetime('now'))`
    ).bind(
      crypto.randomUUID(),
      session.user_id,
      approved ? "verification_approved" : "verification_rejected",
      notifTitle,
      notifBody,
    ).run();

    // 4. Best-effort: also push via queue for FCM (won't block if queue unavailable)
    try {
      if (c.env.NOTIFICATION_QUEUE) {
        await c.env.NOTIFICATION_QUEUE.send({
          user_id: session.user_id,
          type: approved ? "verification_approved" : "verification_rejected",
          title: notifTitle,
          body: notifBody,
          timestamp: now,
        });
      }
    } catch {
      // Queue unavailable — notification already saved to DB above
    }

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
