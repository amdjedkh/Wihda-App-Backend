/**
 * Wihda Backend - Chat Routes
 * GET /v1/chats/:thread_id
 * GET /v1/chats/:thread_id/messages
 * POST /v1/chats/:thread_id/messages
 * GET /v1/chats (list threads)
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import {
  getChatThreadById,
  getChatThreadsForUser,
  getChatMessages,
  createChatMessage,
  getMatchById,
  getLeftoverOfferById,
  getLeftoverNeedById,
  createCoinEntry,
} from "../lib/db";
import { successResponse, errorResponse, toISODateString } from "../lib/utils";
import {
  authMiddleware,
  requireVerified,
  getAuthContext,
} from "../middleware/auth";
import { checkAndAwardBadges } from "../lib/badges";

const chat = new Hono<{ Bindings: Env }>();

const sendMessageSchema = z.object({
  body: z.string().min(1).max(2000),
  message_type: z.enum(["text", "image", "location"]).default("text"),
  media_url: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * GET /v1/chats
 * List user's chat threads
 */
chat.get("/", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const threads = await getChatThreadsForUser(c.env.DB, authContext.userId);

  if (threads.length === 0) {
    return successResponse({ threads: [] });
  }

  const otherUserIds = threads.map((t) =>
    t.participant_1_id === authContext.userId
      ? t.participant_2_id
      : t.participant_1_id,
  );
  const uniqueUserIds = [...new Set(otherUserIds)];
  const userRows = (
    await c.env.DB.prepare(
      `SELECT id, display_name FROM users WHERE id IN (${uniqueUserIds.map(() => "?").join(",")})`,
    )
      .bind(...uniqueUserIds)
      .all<{ id: string; display_name: string }>()
  ).results;
  const userMap = Object.fromEntries(userRows.map((u) => [u.id, u]));

  const lastMessages = await Promise.all(
    threads.map((t) =>
      c.env.DB.prepare(
        `
        SELECT id, body, created_at FROM chat_messages
        WHERE thread_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 1
      `,
      )
        .bind(t.id)
        .first<{ id: string; body: string; created_at: string }>(),
    ),
  );

  const enrichedThreads = threads.map((thread, i) => {
    const otherUserId =
      thread.participant_1_id === authContext.userId
        ? thread.participant_2_id
        : thread.participant_1_id;
    const lastMessage = lastMessages[i];
    return {
      id: thread.id,
      match_id: thread.match_id,
      other_user: userMap[otherUserId] ?? null,
      last_message: lastMessage
        ? {
            body: lastMessage.body.substring(0, 100),
            created_at: lastMessage.created_at,
          }
        : null,
      status: thread.status,
      created_at: thread.created_at,
    };
  });

  return successResponse({ threads: enrichedThreads });
});

/**
 * GET /v1/chats/:thread_id
 * Get thread metadata (includes role info for confirmation UI)
 */
chat.get("/:thread_id", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const threadId = c.req.param("thread_id");
  const thread = await getChatThreadById(c.env.DB, threadId);

  if (!thread) {
    return errorResponse("NOT_FOUND", "Chat thread not found", 404);
  }

  if (
    thread.participant_1_id !== authContext.userId &&
    thread.participant_2_id !== authContext.userId
  ) {
    if (authContext.userRole !== "moderator" && authContext.userRole !== "admin") {
      return errorResponse("FORBIDDEN", "You do not have access to this thread", 403);
    }
  }

  const threadAny = thread as any;
  const match = thread.match_id ? await getMatchById(c.env.DB, thread.match_id) : null;
  const otherUserId =
    thread.participant_1_id === authContext.userId
      ? thread.participant_2_id
      : thread.participant_1_id;

  const otherUser = await c.env.DB.prepare(
    "SELECT id, display_name FROM users WHERE id = ?",
  )
    .bind(otherUserId)
    .first<{ id: string; display_name: string }>();

  // Determine giver/receiver IDs for confirmation UI
  let giverId: string | null = null;
  let receiverId: string | null = null;

  if (threadAny.offer_id) {
    const offer = await getLeftoverOfferById(c.env.DB, threadAny.offer_id);
    if (offer) {
      giverId = offer.user_id;
      receiverId = thread.participant_1_id === offer.user_id
        ? thread.participant_2_id
        : thread.participant_1_id;
    }
  } else if (threadAny.need_id) {
    const need = await getLeftoverNeedById(c.env.DB, threadAny.need_id);
    if (need) {
      receiverId = need.user_id;
      giverId = thread.participant_1_id === need.user_id
        ? thread.participant_2_id
        : thread.participant_1_id;
    }
  }

  return successResponse({
    id: thread.id,
    match_id: thread.match_id,
    offer_id: threadAny.offer_id ?? null,
    need_id: threadAny.need_id ?? null,
    confirmation_state: threadAny.confirmation_state ?? null,
    giver_id: giverId,
    receiver_id: receiverId,
    match: match ? { id: match.id, status: match.status, score: match.score } : null,
    other_user: otherUser,
    participants: [thread.participant_1_id, thread.participant_2_id],
    status: thread.status,
    created_at: thread.created_at,
    closed_at: thread.closed_at,
  });
});

/**
 * POST /v1/chats/:thread_id/confirm
 * Two-step exchange confirmation:
 *   Step 1 — giver/helper clicks YES → state = 'giver_confirmed'
 *   Step 2 — receiver clicks YES → complete + award coins
 *             receiver clicks CANCEL → state = 'cancelled'
 */
chat.post("/:thread_id/confirm", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const threadId = c.req.param("thread_id");
  const thread = await getChatThreadById(c.env.DB, threadId);

  if (!thread) return errorResponse("NOT_FOUND", "Thread not found", 404);

  if (
    thread.participant_1_id !== authContext.userId &&
    thread.participant_2_id !== authContext.userId
  ) {
    return errorResponse("FORBIDDEN", "Not a participant", 403);
  }

  if (thread.status !== "active") {
    return errorResponse("THREAD_CLOSED", "Thread is already closed", 400);
  }

  const body = await c.req.json();
  const action: "confirm" | "cancel" = body.action;

  const threadAny = thread as any;
  const confirmationState: string | null = threadAny.confirmation_state ?? null;

  // Determine roles
  let giverId: string | null = null;
  let receiverId: string | null = null;
  let offerIdForDeletion: string | null = null;

  if (threadAny.offer_id) {
    const offer = await getLeftoverOfferById(c.env.DB, threadAny.offer_id);
    if (offer) {
      giverId = offer.user_id;
      receiverId = thread.participant_1_id === offer.user_id
        ? thread.participant_2_id
        : thread.participant_1_id;
      offerIdForDeletion = offer.id;
    }
  } else if (threadAny.need_id) {
    const need = await getLeftoverNeedById(c.env.DB, threadAny.need_id);
    if (need) {
      receiverId = need.user_id;
      giverId = thread.participant_1_id === need.user_id
        ? thread.participant_2_id
        : thread.participant_1_id;
    }
  }

  const isGiver = authContext.userId === giverId;
  const isReceiver = authContext.userId === receiverId;

  // ── Step 1: Giver initiates ───────────────────────────────────────────────
  if (confirmationState === null) {
    if (!isGiver) {
      return errorResponse("FORBIDDEN", "Only the giver/helper can initiate confirmation", 403);
    }
    await c.env.DB.prepare(
      "UPDATE chat_threads SET confirmation_state = 'giver_confirmed', confirmed_by = ? WHERE id = ?"
    ).bind(authContext.userId, threadId).run();

    // Notify receiver
    if (receiverId) {
      const isGiveThread = !!threadAny.offer_id;
      await c.env.NOTIFICATION_QUEUE.send({
        user_id: receiverId,
        type: "system" as any,
        title: isGiveThread ? "Did you receive the item?" : "Did you receive help?",
        body: "Open the chat to confirm the exchange",
        data: { thread_id: threadId },
        timestamp: toISODateString(),
      });
    }

    return successResponse({ confirmation_state: "giver_confirmed" });
  }

  // ── Step 2: Receiver responds ─────────────────────────────────────────────
  if (confirmationState === "giver_confirmed") {
    if (!isReceiver) {
      return errorResponse("FORBIDDEN", "Only the receiver can complete confirmation", 403);
    }

    if (action === "cancel") {
      await c.env.DB.prepare(
        "UPDATE chat_threads SET status = 'closed', confirmation_state = 'cancelled', closed_at = ? WHERE id = ?"
      ).bind(toISODateString(), threadId).run();
      return successResponse({ confirmation_state: "cancelled" });
    }

    // action === 'confirm' → complete exchange
    const neighborhoodId = thread.neighborhood_id;

    if (giverId) {
      await createCoinEntry(c.env.DB, {
        userId: giverId,
        neighborhoodId,
        sourceType: "leftovers_exchange_complete",
        sourceId: `${threadId}_give`,
        amount: 200,
        category: "leftovers",
        description: "Reward for completing exchange as giver/helper",
        createdBy: "system",
      });
    }

    if (receiverId) {
      await createCoinEntry(c.env.DB, {
        userId: receiverId,
        neighborhoodId,
        sourceType: "leftovers_exchange_receiver",
        sourceId: `${threadId}_recv`,
        amount: 50,
        category: "leftovers",
        description: "Reward for confirming exchange as receiver",
        createdBy: "system",
      });
    }

    // Close thread
    await c.env.DB.prepare(
      "UPDATE chat_threads SET status = 'closed', confirmation_state = 'completed', closed_at = ? WHERE id = ?"
    ).bind(toISODateString(), threadId).run();

    // Mark offer as completed (GIVE thread only)
    if (offerIdForDeletion) {
      await c.env.DB.prepare(
        "UPDATE leftover_offers SET status = 'closed', updated_at = ? WHERE id = ?"
      ).bind(toISODateString(), offerIdForDeletion).run();
    }

    // Award badges
    if (giverId) checkAndAwardBadges(c.env.DB, giverId);
    if (receiverId) checkAndAwardBadges(c.env.DB, receiverId);

    // Notify giver
    if (giverId) {
      await c.env.NOTIFICATION_QUEUE.send({
        user_id: giverId,
        type: "coins_awarded",
        title: "Exchange complete! 🎉",
        body: "You earned 200 coins for completing the exchange!",
        data: { thread_id: threadId, coins: 200 },
        timestamp: toISODateString(),
      });
    }

    return successResponse({ confirmation_state: "completed", coins_awarded: 250 });
  }

  return errorResponse("BAD_REQUEST", "Nothing to confirm in current state", 400);
});

/**
 * GET /v1/chats/:thread_id/messages
 * Get paginated messages
 */
chat.get("/:thread_id/messages", authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse("UNAUTHORIZED", "Authentication required", 401);
  }

  const threadId = c.req.param("thread_id");
  const cursor = c.req.query("cursor");
  const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);

  const thread = await getChatThreadById(c.env.DB, threadId);

  if (!thread) {
    return errorResponse("NOT_FOUND", "Chat thread not found", 404);
  }

  // Verify access
  if (
    thread.participant_1_id !== authContext.userId &&
    thread.participant_2_id !== authContext.userId
  ) {
    if (
      authContext.userRole !== "moderator" &&
      authContext.userRole !== "admin"
    ) {
      return errorResponse(
        "FORBIDDEN",
        "You do not have access to this thread",
        403,
      );
    }
  }

  const { messages, hasMore } = await getChatMessages(
    c.env.DB,
    threadId,
    limit,
    cursor,
  );

  // Mark messages as read
  await c.env.DB.prepare(
    `
    UPDATE chat_messages
    SET read_at = ?
    WHERE thread_id = ? AND sender_id != ? AND read_at IS NULL
  `,
  )
    .bind(toISODateString(), threadId, authContext.userId)
    .run();

  const senderIds = [...new Set(messages.map((m) => m.sender_id))];
  const senderRows =
    senderIds.length > 0
      ? (
          await c.env.DB.prepare(
            `SELECT id, display_name FROM users WHERE id IN (${senderIds.map(() => "?").join(",")})`,
          )
            .bind(...senderIds)
            .all<{ id: string; display_name: string }>()
        ).results
      : [];
  const senderMap = Object.fromEntries(senderRows.map((u) => [u.id, u]));

  const enrichedMessages = messages.map((msg) => ({
    id: msg.id,
    sender_id: msg.sender_id,
    sender_name: senderMap[msg.sender_id]?.display_name ?? "Unknown",
    body: msg.body,
    message_type: msg.message_type,
    media_url: msg.media_url,
    read_at: msg.read_at,
    created_at: msg.created_at,
  }));

  return successResponse({
    messages: enrichedMessages,
    has_more: hasMore,
    next_cursor:
      hasMore && enrichedMessages.length > 0
        ? enrichedMessages[enrichedMessages.length - 1].id
        : null,
  });
});

/**
 * POST /v1/chats/:thread_id/messages
 * Send a message
 */
chat.post(
  "/:thread_id/messages",
  authMiddleware,
  requireVerified,
  async (c) => {
    const authContext = getAuthContext(c);
    if (!authContext) {
      return errorResponse("UNAUTHORIZED", "Authentication required", 401);
    }

    const threadId = c.req.param("thread_id");

    const thread = await getChatThreadById(c.env.DB, threadId);

    if (!thread) {
      return errorResponse("NOT_FOUND", "Chat thread not found", 404);
    }

    // Verify user is a participant
    if (
      thread.participant_1_id !== authContext.userId &&
      thread.participant_2_id !== authContext.userId
    ) {
      return errorResponse(
        "FORBIDDEN",
        "You are not a participant in this thread",
        403,
      );
    }

    // Check if thread is closed
    if (thread.status !== "active") {
      return errorResponse("THREAD_CLOSED", "This chat thread is closed", 400);
    }

    try {
      const body = await c.req.json();
      const validation = sendMessageSchema.safeParse(body);

      if (!validation.success) {
        return errorResponse(
          "VALIDATION_ERROR",
          "Invalid message data",
          400,
          validation.error.flatten(),
        );
      }

      const data = validation.data;

      const message = await createChatMessage(c.env.DB, {
        threadId,
        senderId: authContext.userId,
        body: data.body,
        messageType: data.message_type,
        mediaUrl: data.media_url,
        metadata: data.metadata ? JSON.stringify(data.metadata) : undefined,
      });

      const otherUserId =
        thread.participant_1_id === authContext.userId
          ? thread.participant_2_id
          : thread.participant_1_id;

      const doId = c.env.CHAT_DO.idFromName(threadId);
      const stub = c.env.CHAT_DO.get(doId);
      await stub.fetch(
        new Request("https://do-internal/broadcast", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: {
              type: "message",
              payload: {
                id: message.id,
                thread_id: threadId,
                sender_id: authContext.userId,
                body: data.body,
                message_type: data.message_type,
                media_url: data.media_url ?? null,
                created_at: message.created_at,
              },
            },
          }),
        }),
      );

      // Push push notification to the other participant
      await c.env.NOTIFICATION_QUEUE.send({
        user_id: otherUserId,
        type: "new_message",
        title: "New Message",
        body: data.body.substring(0, 100),
        data: { thread_id: threadId, message_id: message.id },
        timestamp: toISODateString(),
      });

      return successResponse({
        message: {
          id: message.id,
          thread_id: message.thread_id,
          sender_id: message.sender_id,
          body: message.body,
          message_type: message.message_type,
          media_url: message.media_url,
          created_at: message.created_at,
        },
      });
    } catch (error) {
      console.error("Send message error:", error);
      return errorResponse("INTERNAL_ERROR", "Failed to send message", 500);
    }
  },
);

/**
 * GET /v1/chats/:thread_id/ws
 * WebSocket endpoint for real-time chat.
 * Auth is via ?token= query param (standard WS pattern, browsers can't set
 * Authorization headers on WebSocket connections).
 */
chat.get("/:thread_id/ws", async (c) => {
  const threadId = c.req.param("thread_id");
  const token = c.req.query("token");

  if (!token) {
    return errorResponse(
      "MISSING_TOKEN",
      "Token is required for WebSocket connection",
      401,
    );
  }

  const { verifyJWT } = await import("../lib/utils");
  const payload = await verifyJWT(token, c.env.JWT_SECRET);

  if (!payload) {
    return errorResponse("INVALID_TOKEN", "Invalid or expired token", 401);
  }

  if (payload.scope !== "full") {
    return errorResponse(
      "INSUFFICIENT_SCOPE",
      "Full-scope token required",
      403,
    );
  }
  if (payload.verification_status !== "verified") {
    return errorResponse("NOT_VERIFIED", "Identity verification required", 403);
  }

  const thread = await getChatThreadById(c.env.DB, threadId);

  if (!thread) {
    return errorResponse("NOT_FOUND", "Chat thread not found", 404);
  }

  // Verify user is a participant
  if (
    thread.participant_1_id !== payload.sub &&
    thread.participant_2_id !== payload.sub
  ) {
    return errorResponse(
      "FORBIDDEN",
      "You are not a participant in this thread",
      403,
    );
  }

  if (thread.status !== "active") {
    return errorResponse("THREAD_CLOSED", "This chat thread is closed", 400);
  }

  // Forward to Durable Object
  const doId = c.env.CHAT_DO.idFromName(threadId);
  const stub = c.env.CHAT_DO.get(doId);

  const url = new URL(c.req.url);
  url.pathname = "/ws";

  return stub.fetch(url.toString(), {
    headers: {
      Upgrade: "websocket",
      "X-User-Id": payload.sub,
      "X-Thread-Id": threadId,
    },
  });
});

export default chat;
