/**
 * Tests: Notification Routes
 *
 * GET  /v1/notifications
 * POST /v1/notifications/read
 *
 * Key things verified:
 *   ✓ authMiddleware enforced — 401 without token
 *   ✓ requireVerified enforced — 403 for verification_only tokens
 *   ✓ Returns notification list with has_more flag
 *   ✓ Respects unread_only query param
 *   ✓ Marks notifications as read and returns count
 *   ✓ Works with no notification_ids (marks all read)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestApp, createTestEnv, mockFirstOnce } from "../helpers";
import { createJWT } from "../../src/lib/utils";

// ─── Token helpers ────────────────────────────────────────────────────────────

async function makeFullToken(env: ReturnType<typeof createTestEnv>) {
  return createJWT(
    {
      sub: "user-001",
      role: "user",
      neighborhood_id: "nb-001",
      verification_status: "verified",
      scope: "full",
    },
    env.JWT_SECRET,
  );
}

async function makeRestrictedToken(env: ReturnType<typeof createTestEnv>) {
  return createJWT(
    {
      sub: "user-001",
      role: "user",
      neighborhood_id: null,
      verification_status: "unverified",
      scope: "verification_only",
    },
    env.JWT_SECRET,
  );
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOTIFICATION_1 = {
  id: "notif-001",
  user_id: "user-001",
  type: "verification_approved",
  title: "Identity Verified ✓",
  body: "Your identity has been verified.",
  read_at: null,
  created_at: new Date().toISOString(),
};

const NOTIFICATION_2 = {
  id: "notif-002",
  user_id: "user-001",
  type: "match_found",
  title: "New Match",
  body: "Someone wants your leftovers.",
  read_at: null,
  created_at: new Date().toISOString(),
};

// ─── GET /v1/notifications ────────────────────────────────────────────────────

describe("GET /v1/notifications", () => {
  let app: ReturnType<typeof createTestApp>;
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createTestEnv();
  });

  it("returns 401 without a token", async () => {
    const res = await app.request("/v1/notifications", {}, env);
    expect(res.status).toBe(401);
  });

  it("returns 403 VERIFICATION_TOKEN_RESTRICTED for a verification_only token", async () => {
    const token = await makeRestrictedToken(env);

    const res = await app.request(
      "/v1/notifications",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("VERIFICATION_TOKEN_RESTRICTED");
  });

  it("returns 200 with notifications and has_more flag", async () => {
    const token = await makeFullToken(env);

    // getNotificationHistory returns { notifications, hasMore }
    vi.spyOn(
      await import("../../src/queues/notification"),
      "getNotificationHistory",
    ).mockResolvedValueOnce({
      notifications: [NOTIFICATION_1, NOTIFICATION_2],
      hasMore: false,
    });

    const res = await app.request(
      "/v1/notifications",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.notifications).toHaveLength(2);
    expect(body.data.has_more).toBe(false);
  });

  it("passes unread_only=true to getNotificationHistory", async () => {
    const token = await makeFullToken(env);

    const spy = vi
      .spyOn(
        await import("../../src/queues/notification"),
        "getNotificationHistory",
      )
      .mockResolvedValueOnce({
        notifications: [NOTIFICATION_1],
        hasMore: false,
      });

    await app.request(
      "/v1/notifications?unread_only=true",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(spy).toHaveBeenCalledWith(
      expect.anything(), // DB
      "user-001",
      expect.any(Number),
      true, // unread_only
    );
  });

  it("caps limit at 100 regardless of query param", async () => {
    const token = await makeFullToken(env);

    const spy = vi
      .spyOn(
        await import("../../src/queues/notification"),
        "getNotificationHistory",
      )
      .mockResolvedValueOnce({ notifications: [], hasMore: false });

    await app.request(
      "/v1/notifications?limit=9999",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      "user-001",
      100, // capped
      false,
    );
  });
});

// ─── POST /v1/notifications/read ─────────────────────────────────────────────

describe("POST /v1/notifications/read", () => {
  let app: ReturnType<typeof createTestApp>;
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createTestEnv();
  });

  it("returns 401 without a token", async () => {
    const res = await app.request(
      "/v1/notifications/read",
      { method: "POST" },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 VERIFICATION_TOKEN_RESTRICTED for a verification_only token", async () => {
    const token = await makeRestrictedToken(env);

    const res = await app.request(
      "/v1/notifications/read",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ notification_ids: ["notif-001"] }),
      },
      env,
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("VERIFICATION_TOKEN_RESTRICTED");
  });

  it("marks specific notifications as read and returns count", async () => {
    const token = await makeFullToken(env);

    vi.spyOn(
      await import("../../src/queues/notification"),
      "markNotificationsRead",
    ).mockResolvedValueOnce(2);

    const res = await app.request(
      "/v1/notifications/read",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ notification_ids: ["notif-001", "notif-002"] }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.marked_read).toBe(2);
  });

  it("marks all notifications as read when no ids provided", async () => {
    const token = await makeFullToken(env);

    const spy = vi
      .spyOn(
        await import("../../src/queues/notification"),
        "markNotificationsRead",
      )
      .mockResolvedValueOnce(5);

    await app.request(
      "/v1/notifications/read",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}), // no notification_ids
      },
      env,
    );

    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      "user-001",
      undefined, // no ids → mark all
    );
  });
});
