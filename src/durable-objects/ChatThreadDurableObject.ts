/**
 * Wihda Backend - Chat Thread Durable Object
 * Handles WebSocket connections and real-time messaging.
 */

import type { Env } from "../types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface WebSocketMessage {
  type:
    | "message"
    | "typing"
    | "read"
    | "ping"
    | "user_joined"
    | "user_left"
    | "connected"
    | "error"
    | "pong";
  payload: unknown;
}

interface ClientAttachment {
  userId: string;
}

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 10_000;

const VALID_MESSAGE_TYPES = new Set(["text", "image", "location"]);

// ─── Durable Object ───────────────────────────────────────────────────────────

export class ChatThreadDurableObject {
  private ctx: DurableObjectState;
  private env: Env;

  private threadId: string | null = null;

  private rateLimitCounts: Map<string, { count: number; windowStart: number }> =
    new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;

    this.ctx.blockConcurrencyWhile(async () => {
      this.threadId = (await this.ctx.storage.get<string>("threadId")) ?? null;
    });
  }

  // ─── HTTP / WebSocket upgrade entry point ──────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade (either by Upgrade header or /ws pathname)
    if (
      request.headers.get("Upgrade") === "websocket" ||
      url.pathname === "/ws"
    ) {
      return this.handleWebSocket(request);
    }

    // Health check
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          clients: this.ctx.getWebSockets().length,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // Broadcast from HTTP route (POST /messages calls this to push to WS clients)
    if (url.pathname === "/broadcast" && request.method === "POST") {
      const body = (await request.json()) as {
        message: WebSocketMessage;
        excludeUserId?: string;
      };
      this.broadcast(body.message, body.excludeUserId);
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  }

  // ─── WebSocket upgrade handler ─────────────────────────────────────────────

  private async handleWebSocket(request: Request): Promise<Response> {
    const userId = request.headers.get("X-User-Id");
    const threadId = request.headers.get("X-Thread-Id");

    if (!userId || !threadId) {
      return new Response("Missing user or thread ID", { status: 400 });
    }

    if (!this.threadId) {
      this.threadId = threadId;
      await this.ctx.storage.put("threadId", threadId);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.serializeAttachment({ userId } satisfies ClientAttachment);
    this.ctx.acceptWebSocket(server);

    // Send welcome message immediately (before hibernation can kick in)
    server.send(
      JSON.stringify({
        type: "connected",
        payload: {
          thread_id: threadId,
          user_id: userId,
          connected_users: this.getConnectedUsers(),
        },
      }),
    );

    // Notify others that user joined
    this.broadcastUserJoined(userId);

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── Hibernation API handlers ──────────────────────────────────────────────
  // These replace addEventListener('message'|'close'|'error') from the legacy API.

  async webSocketMessage(
    ws: WebSocket,
    data: string | ArrayBuffer,
  ): Promise<void> {
    const { userId } = ws.deserializeAttachment() as ClientAttachment;

    if (!this.checkRateLimit(userId)) {
      ws.send(
        JSON.stringify({
          type: "error",
          payload: { message: "Rate limit exceeded. Please slow down." },
        }),
      );
      return;
    }

    if (typeof data !== "string") {
      ws.send(
        JSON.stringify({
          type: "error",
          payload: { message: "Binary messages not supported" },
        }),
      );
      return;
    }

    try {
      const message = JSON.parse(data) as WebSocketMessage;

      switch (message.type) {
        case "message":
          await this.handleChatMessage(ws, userId, message.payload);
          break;

        case "typing":
          this.broadcast(
            {
              type: "typing",
              payload: { user_id: userId, is_typing: message.payload },
            },
            userId,
          );
          break;

        case "read":
          await this.handleReadMessages(userId);
          break;

        case "ping":
          ws.send(JSON.stringify({ type: "pong", payload: Date.now() }));
          break;
      }
    } catch (error) {
      console.error("Error parsing message:", error);
      ws.send(
        JSON.stringify({
          type: "error",
          payload: { message: "Invalid message format" },
        }),
      );
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const { userId } = ws.deserializeAttachment() as ClientAttachment;
    this.rateLimitCounts.delete(userId);
    this.broadcastUserLeft(userId);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("WebSocket error:", error);
    const attachment = ws.deserializeAttachment() as ClientAttachment | null;
    if (attachment?.userId) {
      this.rateLimitCounts.delete(attachment.userId);
    }
  }

  // ─── Message handling ──────────────────────────────────────────────────────

  private async handleChatMessage(
    ws: WebSocket,
    userId: string,
    payload: unknown,
  ): Promise<void> {
    const {
      body,
      message_type = "text",
      media_url,
    } = payload as {
      body?: string;
      message_type?: string;
      media_url?: string;
    };

    if (
      !body ||
      typeof body !== "string" ||
      body.trim().length === 0 ||
      body.length > 2000
    ) {
      ws.send(
        JSON.stringify({
          type: "error",
          payload: { message: "Invalid message body" },
        }),
      );
      return;
    }

    if (!VALID_MESSAGE_TYPES.has(message_type)) {
      ws.send(
        JSON.stringify({
          type: "error",
          payload: {
            message: `Invalid message_type. Must be one of: ${[...VALID_MESSAGE_TYPES].join(", ")}`,
          },
        }),
      );
      return;
    }

    if (!this.threadId) {
      ws.send(
        JSON.stringify({
          type: "error",
          payload: { message: "Thread not initialized" },
        }),
      );
      return;
    }

    const thread = await this.env.DB.prepare(
      "SELECT status FROM chat_threads WHERE id = ?",
    )
      .bind(this.threadId)
      .first<{ status: string }>();

    if (!thread || thread.status !== "active") {
      ws.send(
        JSON.stringify({
          type: "error",
          payload: { message: "This chat thread is closed" },
        }),
      );
      return;
    }

    try {
      const messageId = crypto.randomUUID();
      const now = new Date().toISOString();

      await this.env.DB.prepare(
        `
        INSERT INTO chat_messages (id, thread_id, sender_id, body, message_type, media_url, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
        .bind(
          messageId,
          this.threadId,
          userId,
          body,
          message_type,
          media_url ?? null,
          now,
        )
        .run();

      await this.env.DB.prepare(
        "UPDATE chat_threads SET last_message_at = ? WHERE id = ?",
      )
        .bind(now, this.threadId)
        .run();

      this.broadcast({
        type: "message",
        payload: {
          id: messageId,
          thread_id: this.threadId,
          sender_id: userId,
          body,
          message_type,
          media_url: media_url ?? null,
          created_at: now,
        },
      });
    } catch (error) {
      console.error("Error storing message:", error);
      ws.send(
        JSON.stringify({
          type: "error",
          payload: { message: "Failed to send message" },
        }),
      );
    }
  }

  private async handleReadMessages(userId: string): Promise<void> {
    if (!this.threadId) return;

    const now = new Date().toISOString();

    await this.env.DB.prepare(
      `
      UPDATE chat_messages
      SET read_at = ?
      WHERE thread_id = ? AND sender_id != ? AND read_at IS NULL
    `,
    )
      .bind(now, this.threadId, userId)
      .run();

    this.broadcast(
      {
        type: "read",
        payload: { thread_id: this.threadId, read_by: userId, read_at: now },
      },
      userId,
    );
  }

  // ─── Broadcast ─────────────────────────────────────────────────────────────

  private broadcast(message: WebSocketMessage, excludeUserId?: string): void {
    const messageStr = JSON.stringify(message);

    for (const ws of this.ctx.getWebSockets()) {
      try {
        const { userId } = ws.deserializeAttachment() as ClientAttachment;
        if (excludeUserId && userId === excludeUserId) continue;
        ws.send(messageStr);
      } catch (error) {
        console.error("Error broadcasting to client:", error);
      }
    }
  }

  private broadcastUserJoined(userId: string): void {
    this.broadcast(
      {
        type: "user_joined",
        payload: { user_id: userId, connected_users: this.getConnectedUsers() },
      },
      userId,
    );
  }

  private broadcastUserLeft(userId: string): void {
    this.broadcast({
      type: "user_left",
      payload: { user_id: userId, connected_users: this.getConnectedUsers() },
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private getConnectedUsers(): string[] {
    const users = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const { userId } = ws.deserializeAttachment() as ClientAttachment;
      users.add(userId);
    }
    return Array.from(users);
  }

  private checkRateLimit(userId: string): boolean {
    const now = Date.now();
    const entry = this.rateLimitCounts.get(userId);

    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      this.rateLimitCounts.set(userId, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= RATE_LIMIT_MAX) {
      return false;
    }

    entry.count++;
    return true;
  }
}

export default ChatThreadDurableObject;
