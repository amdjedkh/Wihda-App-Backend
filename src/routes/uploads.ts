/**
 * Wihda Backend - Upload Routes (R2 Signed URLs)
 * POST /v1/uploads/presigned-url
 * POST /v1/uploads/direct
 * GET  /v1/uploads/:key
 * DELETE /v1/uploads/:key
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { successResponse, errorResponse } from "../lib/utils";
import { authMiddleware, getAuthContext } from "../middleware/auth";
import { createUploadToken, verifyUploadToken } from "../lib/upload-token";

const uploads = new Hono<{ Bindings: Env }>();

const presignedUrlSchema = z.object({
  content_type: z.enum([
    "before_photo",
    "after_photo",
    "chat_image",
    "campaign_image",
  ]),
  file_extension: z.string().regex(/^(jpg|jpeg|png|webp|gif)$/i),
});

/**
 * POST /v1/uploads/presigned-url
 * Generate a signed upload URL for direct PUT to /v1/uploads/direct
 */
uploads.post("/presigned-url", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

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

    const { content_type, file_extension } = validation.data;

    const timestamp = Date.now();
    const randomId = crypto.randomUUID().split("-")[0];
    const fileKey = `uploads/${authContext.userId}/${content_type}/${timestamp}-${randomId}.${file_extension}`;

    const uploadToken = await createUploadToken(
      c.env.JWT_SECRET,
      authContext.userId,
      fileKey,
      content_type,
    );

    const origin = new URL(c.req.url).origin;
    const uploadUrl = `${origin}/v1/uploads/direct?token=${uploadToken}`;
    const fileUrl = `${origin}/v1/uploads/${fileKey}`;

    return successResponse({
      upload_url: uploadUrl,
      file_key: fileKey,
      file_url: fileUrl,
      expires_at: new Date(Date.now() + 3600000).toISOString(), // 1 hour
    });
  } catch (error) {
    console.error("Presigned URL error:", error);
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to generate upload URL",
      500,
    );
  }
});

/**
 * POST /v1/uploads/direct
 * Authenticated via signed token; receives raw file bytes and stores in R2
 */
uploads.post("/direct", async (c) => {
  const token = c.req.query("token");

  if (!token) {
    return errorResponse("MISSING_TOKEN", "Upload token is required", 400);
  }

  try {
    const payload = await verifyUploadToken(c.env.JWT_SECRET, token);

    if (!payload) {
      return errorResponse(
        "INVALID_TOKEN",
        "Invalid or expired upload token",
        401,
      );
    }

    const contentType = c.req.header("Content-Type") || "image/jpeg";
    const fileBuffer = await c.req.arrayBuffer();

    if (fileBuffer.byteLength > 10 * 1024 * 1024) {
      return errorResponse(
        "FILE_TOO_LARGE",
        "File size must be less than 10MB",
        400,
      );
    }

    await c.env.STORAGE.put(payload.fileKey, fileBuffer, {
      httpMetadata: { contentType },
      customMetadata: {
        userId: payload.userId,
        contentType: payload.contentType,
      },
    });

    const fileUrl = `${new URL(c.req.url).origin}/v1/uploads/${payload.fileKey}`;

    return successResponse({
      file_key: payload.fileKey,
      file_url: fileUrl,
      size: fileBuffer.byteLength,
    });
  } catch (error) {
    console.error("Direct upload error:", error);
    return errorResponse("INTERNAL_ERROR", "Failed to upload file", 500);
  }
});

/**
 * GET /v1/uploads/:key
 * Serve a file from R2 with caching headers
 */
uploads.get("/:key{.*}", async (c) => {
  const key = c.req.param("key");

  try {
    const object = await c.env.STORAGE.get(key);

    if (!object) {
      return errorResponse("NOT_FOUND", "File not found", 404);
    }

    const headers = new Headers();
    headers.set(
      "Content-Type",
      object.httpMetadata?.contentType || "image/jpeg",
    );
    headers.set("Cache-Control", "public, max-age=31536000");
    headers.set("ETag", object.etag);
    headers.set("Access-Control-Allow-Origin", "*");

    return new Response(object.body, { headers });
  } catch (error) {
    console.error("File serve error:", error);
    return errorResponse("INTERNAL_ERROR", "Failed to serve file", 500);
  }
});

/**
 * DELETE /v1/uploads/:key
 * Delete a file (owner only)
 */
uploads.delete("/:key{.*}", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const key = c.req.param("key");

  if (!key.startsWith(`uploads/${authContext.userId}/`)) {
    return errorResponse(
      "FORBIDDEN",
      "You can only delete your own files",
      403,
    );
  }

  try {
    await c.env.STORAGE.delete(key);
    return successResponse({ deleted: true, file_key: key });
  } catch (error) {
    console.error("File delete error:", error);
    return errorResponse("INTERNAL_ERROR", "Failed to delete file", 500);
  }
});

export default uploads;
