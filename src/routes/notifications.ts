/**
 * Wihda Backend - Notification Routes
 *
 * GET  /v1/notifications       -> List notifications for the current user
 * POST /v1/notifications/read  -> Mark notifications as read
 */

import { Hono } from "hono";
import type { Env } from "../types";
import {
  getNotificationHistory,
  markNotificationsRead,
} from "../queues/notification";
import { successResponse, errorResponse } from "../lib/utils";
import {
  authMiddleware,
  requireVerified,
  getAuthContext,
} from "../middleware/auth";

const notifications = new Hono<{ Bindings: Env }>();

// Both endpoints require a fully verified user.
// authMiddleware validates the JWT and populates c.var.auth.
// requireVerified blocks verification_only scoped tokens and unverified users.
notifications.use("*", authMiddleware, requireVerified);

// ─── GET /v1/notifications ────────────────────────────────────────────────────

notifications.get("/", async (c) => {
  const auth = getAuthContext(c)!;

  try {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20"), 100);
    const unreadOnly = c.req.query("unread_only") === "true";

    const { notifications: items, hasMore } = await getNotificationHistory(
      c.env.DB,
      auth.userId,
      limit,
      unreadOnly,
    );

    return successResponse({ notifications: items, has_more: hasMore });
  } catch (error) {
    console.error("Get notifications error:", error);
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to fetch notifications",
      500,
    );
  }
});

// ─── POST /v1/notifications/read ─────────────────────────────────────────────

notifications.post("/read", async (c) => {
  const auth = getAuthContext(c)!;

  try {
    const body = await c.req.json().catch(() => ({}));
    const notificationIds = (body as any).notification_ids;

    const count = await markNotificationsRead(
      c.env.DB,
      auth.userId,
      notificationIds,
    );

    return successResponse({ marked_read: count });
  } catch (error) {
    console.error("Mark notifications read error:", error);
    return errorResponse(
      "INTERNAL_ERROR",
      "Failed to mark notifications as read",
      500,
    );
  }
});

export default notifications;
