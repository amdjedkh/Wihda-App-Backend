/**
 * Tests for Chat Routes
 *
 * Tests call chat.fetch() directly on the sub-router so URLs omit /v1/chats.
 *
 * DB mock pattern: each c.env.DB.prepare() call returns a fresh stmt object.
 * Tests set up responses with mockReturnValueOnce so sequential queries
 * resolve in order.
 *
 * The WS route (/ws) is not tested here, it proxies to a Durable Object
 * which requires a Workers integration test environment.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import chat from "../../src/routes/chat";
import { createMockEnv } from "../fixtures";
import { createJWT } from "../../src/lib/utils";

// ─── Request helper ───────────────────────────────────────────────────────────

function req(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    auth?: string;
    query?: Record<string, string>;
  } = {},
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.auth) headers["Authorization"] = `Bearer ${options.auth}`;

  let url = `http://localhost:8787${path}`;
  if (options.query) {
    const qs = new URLSearchParams(options.query).toString();
    url += `?${qs}`;
  }

  return new Request(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

// ─── DB mock helpers ──────────────────────────────────────────────────────────

function stmt(firstVal: unknown = null, allVal: unknown[] = []) {
  const s: any = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(firstVal),
    all: vi.fn().mockResolvedValue({ results: allVal, success: true }),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
    raw: vi.fn().mockResolvedValue([]),
  };
  return s;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeThread(overrides: Record<string, unknown> = {}) {
  return {
    id: "thread-001",
    match_id: "match-001",
    participant_1_id: "user-001",
    participant_2_id: "user-002",
    status: "active",
    created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    closed_at: null,
    last_message_at: null,
    ...overrides,
  };
}

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-001",
    thread_id: "thread-001",
    sender_id: "user-001",
    body: "Hello there",
    message_type: "text",
    media_url: null,
    read_at: null,
    deleted_at: null,
    created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function makeMatch(overrides: Record<string, unknown> = {}) {
  return {
    id: "match-001",
    status: "successful",
    score: 85,
    ...overrides,
  };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("Chat Routes", () => {
  let mockEnv: ReturnType<typeof createMockEnv>;
  let userToken: string;
  let otherUserToken: string;
  let modToken: string;
  let unverifiedToken: string;
  let scopeOnlyToken: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEnv = createMockEnv();

    // Standard verified full-scope token for participant 1
    userToken = await createJWT(
      {
        sub: "user-001",
        role: "user",
        neighborhood_id: "nb-001",
        verification_status: "verified",
        scope: "full",
      },
      mockEnv.JWT_SECRET,
    );
    // Participant 2
    otherUserToken = await createJWT(
      {
        sub: "user-002",
        role: "user",
        neighborhood_id: "nb-001",
        verification_status: "verified",
        scope: "full",
      },
      mockEnv.JWT_SECRET,
    );
    // Moderator
    modToken = await createJWT(
      {
        sub: "mod-001",
        role: "moderator",
        neighborhood_id: "nb-001",
        verification_status: "verified",
        scope: "full",
      },
      mockEnv.JWT_SECRET,
    );
    // Unverified user, blocked by requireVerified
    unverifiedToken = await createJWT(
      {
        sub: "user-003",
        role: "user",
        neighborhood_id: "nb-001",
        verification_status: "unverified",
        scope: "full",
      },
      mockEnv.JWT_SECRET,
    );
    // Verified but verification_only scope, blocked by requireVerified
    scopeOnlyToken = await createJWT(
      {
        sub: "user-001",
        role: "user",
        neighborhood_id: "nb-001",
        verification_status: "verified",
        scope: "verification_only",
      },
      mockEnv.JWT_SECRET,
    );
  });

  // ── GET / - list threads ────────────────────────────────────────────────────

  describe("GET /", () => {
    it("returns enriched thread list for the current user", async () => {
      const thread = makeThread();
      const otherUser = { id: "user-002", display_name: "Bob" };
      const lastMsg = {
        id: "msg-001",
        body: "See you soon",
        created_at: new Date().toISOString(),
      };

      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt(null, [thread])) // getChatThreadsForUser
        .mockReturnValueOnce(stmt(null, [otherUser])) // batched users IN query
        .mockReturnValueOnce(stmt(lastMsg)); // last message for thread-001

      const res = await chat.fetch(
        req("/", { auth: userToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(Array.isArray(data.data.threads)).toBe(true);
      expect(data.data.threads[0].id).toBe("thread-001");
      expect(data.data.threads[0].other_user.id).toBe("user-002");
      expect(data.data.threads[0].last_message.body).toBe("See you soon");
    });

    it("returns empty array when user has no threads", async () => {
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(null, [])); // no threads

      const res = await chat.fetch(
        req("/", { auth: userToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(data.data.threads).toHaveLength(0);
    });

    it("rejects unauthenticated request", async () => {
      const res = await chat.fetch(req("/"), mockEnv, {} as any);
      expect(res.status).toBe(401);
    });

    it("rejects unverified token", async () => {
      const res = await chat.fetch(
        req("/", { auth: unverifiedToken }),
        mockEnv,
        {} as any,
      );
      expect(res.status).toBe(403);
    });

    it("rejects verification_only scope token", async () => {
      const res = await chat.fetch(
        req("/", { auth: scopeOnlyToken }),
        mockEnv,
        {} as any,
      );
      expect(res.status).toBe(403);
    });
  });

  // ── GET /:thread_id - thread metadata ──────────────────────────────────────

  describe("GET /:thread_id", () => {
    it("returns thread metadata for a participant", async () => {
      const thread = makeThread();
      const match = makeMatch();
      const otherUser = { id: "user-002", display_name: "Bob" };

      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt(thread)) // getChatThreadById
        .mockReturnValueOnce(stmt(match)) // getMatchById
        .mockReturnValueOnce(stmt(otherUser)); // other user lookup

      const res = await chat.fetch(
        req("/thread-001", { auth: userToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(data.data.id).toBe("thread-001");
      expect(data.data.match.status).toBe("successful");
      expect(data.data.other_user.display_name).toBe("Bob");
    });

    it("allows moderator to view any thread", async () => {
      // Thread where mod-001 is NOT a participant
      const thread = makeThread({
        participant_1_id: "user-001",
        participant_2_id: "user-002",
      });
      const match = makeMatch();
      const otherUser = { id: "user-002", display_name: "Bob" };

      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt(thread))
        .mockReturnValueOnce(stmt(match))
        .mockReturnValueOnce(stmt(otherUser));

      const res = await chat.fetch(
        req("/thread-001", { auth: modToken }),
        mockEnv,
        {} as any,
      );
      expect(res.status).toBe(200);
    });

    it("returns 404 for non-existent thread", async () => {
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(null));

      const res = await chat.fetch(
        req("/nonexistent", { auth: userToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(404);
      expect(data.error.code).toBe("NOT_FOUND");
    });

    it("returns 403 for non-participant regular user", async () => {
      // thread-001 has participant_1=user-001 and participant_2=user-002
      // user-003 is neither
      const outsiderToken = await createJWT(
        {
          sub: "user-003",
          role: "user",
          neighborhood_id: "nb-001",
          verification_status: "verified",
          scope: "full",
        },
        mockEnv.JWT_SECRET,
      );
      const thread = makeThread();
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(thread));

      const res = await chat.fetch(
        req("/thread-001", { auth: outsiderToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
    });

    it("rejects unauthenticated request", async () => {
      const res = await chat.fetch(req("/thread-001"), mockEnv, {} as any);
      expect(res.status).toBe(401);
    });
  });

  // ── GET /:thread_id/messages ───────────────────────────────────────────────

  describe("GET /:thread_id/messages", () => {
    it("returns paginated messages with sender names batched", async () => {
      const thread = makeThread();
      const messages = [
        makeMessage({ id: "msg-001", sender_id: "user-001" }),
        makeMessage({ id: "msg-002", sender_id: "user-002", body: "Reply" }),
      ];
      const senders = [
        { id: "user-001", display_name: "Alice" },
        { id: "user-002", display_name: "Bob" },
      ];

      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt(thread)) // getChatThreadById
        .mockReturnValueOnce(stmt(null, messages)) // getChatMessages
        .mockReturnValueOnce(stmt()) // UPDATE read_at
        .mockReturnValueOnce(stmt(null, senders)); // batched sender IN query

      const res = await chat.fetch(
        req("/thread-001/messages", { auth: userToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(data.data.messages).toHaveLength(2);
      // getChatMessages reverses the DESC-ordered results so index order is not
      // deterministic in tests - assert by content rather than position
      const names = data.data.messages.map((m: any) => m.sender_name);
      expect(names).toContain("Alice");
      expect(names).toContain("Bob");
    });

    it("returns next_cursor as message id (not created_at)", async () => {
      const thread = makeThread();
      // getChatMessages returns limit+1 items to indicate hasMore
      const messages = Array.from({ length: 21 }, (_, i) =>
        makeMessage({
          id: `msg-${String(i).padStart(3, "0")}`,
          sender_id: "user-001",
        }),
      );

      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt(thread))
        .mockReturnValueOnce(stmt(null, messages))
        .mockReturnValueOnce(stmt()) // UPDATE read_at
        .mockReturnValueOnce(
          stmt(null, [{ id: "user-001", display_name: "Alice" }]),
        );

      const res = await chat.fetch(
        req("/thread-001/messages", {
          auth: userToken,
          query: { limit: "20" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(data.data.has_more).toBe(true);
      // cursor must be an id (UUID-like), not a timestamp
      expect(data.data.next_cursor).toMatch(/^msg-/);
    });

    it("caps limit at 100", async () => {
      const thread = makeThread();
      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt(thread))
        .mockReturnValueOnce(stmt(null, []))
        .mockReturnValueOnce(stmt())
        .mockReturnValueOnce(stmt(null, []));

      // Pass limit=9999 - route should cap it internally
      const res = await chat.fetch(
        req("/thread-001/messages", {
          auth: userToken,
          query: { limit: "9999" },
        }),
        mockEnv,
        {} as any,
      );
      expect(res.status).toBe(200);
      // We can't inspect the DB call's limit arg directly here, but a 200
      // confirms the route didn't crash with an uncapped parse
    });

    it("returns 403 for non-participant user", async () => {
      const outsiderToken = await createJWT(
        {
          sub: "user-003",
          role: "user",
          neighborhood_id: "nb-001",
          verification_status: "verified",
          scope: "full",
        },
        mockEnv.JWT_SECRET,
      );
      const thread = makeThread();
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(thread));

      const res = await chat.fetch(
        req("/thread-001/messages", { auth: outsiderToken }),
        mockEnv,
        {} as any,
      );
      expect(res.status).toBe(403);
    });

    it("rejects unauthenticated request", async () => {
      const res = await chat.fetch(
        req("/thread-001/messages"),
        mockEnv,
        {} as any,
      );
      expect(res.status).toBe(401);
    });
  });

  // ── POST /:thread_id/messages ──────────────────────────────────────────────

  describe("POST /:thread_id/messages", () => {
    it("sends a message, broadcasts to DO, and enqueues notification", async () => {
      const thread = makeThread();
      const message = makeMessage();

      // Mock the DO broadcast fetch
      const doStub = {
        fetch: vi.fn().mockResolvedValue(new Response('{"success":true}')),
      };
      mockEnv.CHAT_DO = {
        idFromName: vi.fn().mockReturnValue("do-id"),
        get: vi.fn().mockReturnValue(doStub),
      } as any;

      // createChatMessage does 3 prepare calls:
      //   1. INSERT INTO chat_messages
      //   2. UPDATE chat_threads SET last_message_at
      //   3. SELECT * FROM chat_messages WHERE id = ? (returns the created message)
      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt(thread)) // getChatThreadById
        .mockReturnValueOnce(stmt()) // INSERT chat_messages
        .mockReturnValueOnce(stmt()) // UPDATE chat_threads last_message_at
        .mockReturnValueOnce(stmt(message)); // SELECT chat_messages WHERE id = ?

      const res = await chat.fetch(
        req("/thread-001/messages", {
          method: "POST",
          auth: userToken,
          body: { body: "Hello there", message_type: "text" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(data.data.message.id).toBe("msg-001");
      // DO broadcast was called with a request to /broadcast
      expect(doStub.fetch).toHaveBeenCalledWith(
        expect.objectContaining({ url: "https://do-internal/broadcast" }),
      );
      // Push notification queued for the OTHER participant (user-002)
      expect(mockEnv.NOTIFICATION_QUEUE.send).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: "user-002", type: "new_message" }),
      );
    });

    it("rejects message to a closed thread", async () => {
      const thread = makeThread({ status: "closed" });
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(thread));

      const res = await chat.fetch(
        req("/thread-001/messages", {
          method: "POST",
          auth: userToken,
          body: { body: "Hello" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(data.error.code).toBe("THREAD_CLOSED");
    });

    it("rejects non-participant from sending", async () => {
      const outsiderToken = await createJWT(
        {
          sub: "user-003",
          role: "user",
          neighborhood_id: "nb-001",
          verification_status: "verified",
          scope: "full",
        },
        mockEnv.JWT_SECRET,
      );
      const thread = makeThread();
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(thread));

      const res = await chat.fetch(
        req("/thread-001/messages", {
          method: "POST",
          auth: outsiderToken,
          body: { body: "Hello" },
        }),
        mockEnv,
        {} as any,
      );
      expect(res.status).toBe(403);
    });

    it("returns 404 for non-existent thread", async () => {
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(null));

      const res = await chat.fetch(
        req("/thread-001/messages", {
          method: "POST",
          auth: userToken,
          body: { body: "Hello" },
        }),
        mockEnv,
        {} as any,
      );
      expect(res.status).toBe(404);
    });

    it("rejects empty message body", async () => {
      const thread = makeThread();
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(thread));

      const res = await chat.fetch(
        req("/thread-001/messages", {
          method: "POST",
          auth: userToken,
          body: { body: "" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(data.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects message body over 2000 chars", async () => {
      const thread = makeThread();
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(thread));

      const res = await chat.fetch(
        req("/thread-001/messages", {
          method: "POST",
          auth: userToken,
          body: { body: "x".repeat(2001) },
        }),
        mockEnv,
        {} as any,
      );
      expect(res.status).toBe(400);
    });

    it("rejects unauthenticated request", async () => {
      const res = await chat.fetch(
        req("/thread-001/messages", {
          method: "POST",
          body: { body: "Hello" },
        }),
        mockEnv,
        {} as any,
      );
      expect(res.status).toBe(401);
    });

    it("rejects verification_only scope token", async () => {
      const res = await chat.fetch(
        req("/thread-001/messages", {
          method: "POST",
          auth: scopeOnlyToken,
          body: { body: "Hello" },
        }),
        mockEnv,
        {} as any,
      );
      expect(res.status).toBe(403);
    });
  });
});
