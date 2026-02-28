/**
 * Wihda Backend - Main Entry Point
 * Cloudflare Workers API Server
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type {
  Env,
  MatchingQueueMessage,
  CampaignQueueMessage,
  NotificationQueueMessage,
  VerificationQueueMessage,
} from "./types";

// Import routes
import authRoutes from "./routes/auth";
import userRoutes from "./routes/user";
import neighborhoodRoutes from "./routes/neighborhood";
import leftoversRoutes from "./routes/leftovers";
import chatRoutes from "./routes/chat";
import cleanifyRoutes from "./routes/cleanify";
import campaignsRoutes from "./routes/campaigns";
import uploadsRoutes from "./routes/uploads";
import verificationRoutes from "./routes/verification";

// Import queue handlers
import { handleMatchingQueue } from "./queues/matching";
import {
  handleCampaignQueue,
  handleScheduledCampaignIngestion,
} from "./queues/campaign";
import {
  handleNotificationQueue,
  getNotificationHistory,
  markNotificationsRead,
} from "./queues/notification";
import { handleVerificationQueue } from "./queues/verification";

// Import Durable Object
import { ChatThreadDurableObject } from "./durable-objects/ChatThreadDurableObject";

// ─── App ──────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

// CORS
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  }),
);

// ─── System endpoints ─────────────────────────────────────────────────────────

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "wihda-backend",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  }),
);

app.get("/openapi.json", (c) => c.json(getOpenAPISpec()));

app.get("/v1", (c) =>
  c.json({
    name: "Wihda API",
    version: "1.0.0",
    endpoints: {
      auth: "/v1/auth",
      verification: "/v1/verification",
      user: "/v1/me",
      neighborhoods: "/v1/neighborhoods",
      leftovers: "/v1/leftovers",
      chats: "/v1/chats",
      cleanify: "/v1/cleanify",
      campaigns: "/v1/campaigns",
      uploads: "/v1/uploads",
      notifications: "/v1/notifications",
    },
  }),
);

// ─── Route mounting ───────────────────────────────────────────────────────────

app.route("/v1/auth", authRoutes);
app.route("/v1/verification", verificationRoutes);
app.route("/v1/me", userRoutes);
app.route("/v1/neighborhoods", neighborhoodRoutes);
app.route("/v1/leftovers", leftoversRoutes);
app.route("/v1/chats", chatRoutes);
app.route("/v1/cleanify", cleanifyRoutes);
app.route("/v1/campaigns", campaignsRoutes);
app.route("/v1/uploads", uploadsRoutes);

// ─── Notification endpoints ───────────────────────────────────────────────────

app.get("/v1/notifications", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json(
      {
        success: false,
        error: { code: "UNAUTHORIZED", message: "Authentication required" },
      },
      401,
    );
  }

  const { verifyJWT } = await import("./lib/utils");
  const payload = await verifyJWT(authHeader.substring(7), c.env.JWT_SECRET);
  if (!payload) {
    return c.json(
      {
        success: false,
        error: { code: "INVALID_TOKEN", message: "Invalid token" },
      },
      401,
    );
  }

  const limit = parseInt(c.req.query("limit") ?? "20");
  const unreadOnly = c.req.query("unread_only") === "true";
  const { notifications, hasMore } = await getNotificationHistory(
    c.env.DB,
    payload.sub,
    limit,
    unreadOnly,
  );

  return c.json({ success: true, data: { notifications, has_more: hasMore } });
});

app.post("/v1/notifications/read", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json(
      {
        success: false,
        error: { code: "UNAUTHORIZED", message: "Authentication required" },
      },
      401,
    );
  }

  const { verifyJWT } = await import("./lib/utils");
  const payload = await verifyJWT(authHeader.substring(7), c.env.JWT_SECRET);
  if (!payload) {
    return c.json(
      {
        success: false,
        error: { code: "INVALID_TOKEN", message: "Invalid token" },
      },
      401,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const count = await markNotificationsRead(
    c.env.DB,
    payload.sub,
    (body as any).notification_ids,
  );

  return c.json({ success: true, data: { marked_read: count } });
});

// ─── 404 / error handlers ─────────────────────────────────────────────────────

app.notFound((c) =>
  c.json(
    {
      success: false,
      error: { code: "NOT_FOUND", message: "Endpoint not found" },
    },
    404,
  ),
);

app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json(
    {
      success: false,
      error: {
        code: "INTERNAL_ERROR",
        message: err.message || "An unexpected error occurred",
      },
    },
    500,
  );
});

// ─── Exports ──────────────────────────────────────────────────────────────────

export { ChatThreadDurableObject };

export default {
  fetch: app.fetch,

  // ── Queue handler ────────────────────────────────────────────────────────────
  async queue(batch: MessageBatch, env: Env, _ctx: ExecutionContext) {
    switch (batch.queue) {
      case "wihda-matching-queue":
        await handleMatchingQueue(
          batch as MessageBatch<MatchingQueueMessage>,
          env,
        );
        break;
      case "wihda-campaign-queue":
        await handleCampaignQueue(
          batch as MessageBatch<CampaignQueueMessage>,
          env,
        );
        break;
      case "wihda-notification-queue":
        await handleNotificationQueue(
          batch as MessageBatch<NotificationQueueMessage>,
          env,
        );
        break;
      case "wihda-verification-queue":
        await handleVerificationQueue(
          batch as MessageBatch<VerificationQueueMessage>,
          env,
        );
        break;
      default:
        console.warn(`Unknown queue: ${batch.queue}`);
    }
  },

  // ── Scheduled handler (every 12 h) ───────────────────────────────────────────
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    // Existing work
    await handleScheduledCampaignIngestion(env);

    // Expire verification sessions whose 24-hour TTL has elapsed.
    // The queue consumer handles the actual DB update when it receives this message.
    await env.VERIFICATION_QUEUE.send({
      type: "expire_sessions",
      timestamp: new Date().toISOString(),
    });
  },
};

// ─── OpenAPI spec ─────────────────────────────────────────────────────────────

function getOpenAPISpec() {
  return {
    openapi: "3.0.0",
    info: {
      title: "Wihda API",
      version: "1.0.0",
      description: "Backend API for Wihda neighborhood civic application",
    },
    servers: [{ url: "/v1", description: "API v1" }],
    paths: {
      "/auth/signup": {
        post: {
          summary: "Create new user account",
          tags: ["Auth"],
          responses: {
            "201": {
              description:
                "Account created — returns restricted_token + verification_session_id",
            },
            "400": { description: "Validation error" },
            "409": { description: "Email or phone already exists" },
          },
        },
      },
      "/auth/login": {
        post: {
          summary: "Authenticate user (requires verified identity)",
          tags: ["Auth"],
          responses: {
            "200": { description: "Authentication successful" },
            "401": { description: "Invalid credentials" },
            "403": {
              description:
                "Account banned, suspended, or identity not verified",
            },
          },
        },
      },
      "/verification/start": {
        post: {
          summary: "Open a KYC verification session",
          tags: ["Verification"],
          security: [{ bearerAuth: [] }],
        },
      },
      "/verification/presigned-url": {
        post: {
          summary: "Get upload URL for a verification document",
          tags: ["Verification"],
          security: [{ bearerAuth: [] }],
        },
      },
      "/verification/submit": {
        post: {
          summary: "Submit documents for AI review",
          tags: ["Verification"],
          security: [{ bearerAuth: [] }],
        },
      },
      "/verification/status": {
        get: {
          summary: "Poll current verification status",
          tags: ["Verification"],
          security: [{ bearerAuth: [] }],
        },
      },
      "/me": {
        get: {
          summary: "Get current user profile",
          tags: ["User"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": { description: "User profile" },
            "401": { description: "Unauthorized" },
          },
        },
      },
      "/neighborhoods/lookup": {
        get: {
          summary: "Search neighborhoods",
          tags: ["Neighborhoods"],
          responses: { "200": { description: "List of neighborhoods" } },
        },
      },
      "/leftovers/offers": {
        get: {
          summary: "List offers",
          tags: ["Leftovers"],
          security: [{ bearerAuth: [] }],
        },
        post: {
          summary: "Create offer",
          tags: ["Leftovers"],
          security: [{ bearerAuth: [] }],
        },
      },
      "/cleanify/submissions": {
        get: {
          summary: "List submissions",
          tags: ["Cleanify"],
          security: [{ bearerAuth: [] }],
        },
        post: {
          summary: "Start submission",
          tags: ["Cleanify"],
          security: [{ bearerAuth: [] }],
        },
      },
      "/campaigns": {
        get: {
          summary: "List campaigns",
          tags: ["Campaigns"],
          security: [{ bearerAuth: [] }],
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
  };
}
