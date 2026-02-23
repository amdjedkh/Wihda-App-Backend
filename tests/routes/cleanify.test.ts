/**
 * Tests for Cleanify Routes – multi-step flow
 *
 * We call cleanify.fetch() directly on the sub-router, so URLs must match
 * the routes as registered (e.g. "/start", not "/v1/cleanify/start").
 *
 * DB mock pattern: each c.env.DB.prepare() call returns a fresh statement
 * object. Tests set up responses by calling mockReturnValueOnce on prepare()
 * itself so that sequential queries return values in order.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import cleanify from "../../src/routes/cleanify";
import { createMockEnv } from "../fixtures";
import { createJWT } from "../../src/lib/utils";

// ─── Request helper ───────────────────────────────────────────────────────────
// NOTE: No /v1/cleanify prefix — we're testing the sub-router directly.

function req(
  path: string,
  options: { method?: string; body?: unknown; auth?: string } = {},
) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.auth) headers["Authorization"] = `Bearer ${options.auth}`;

  return new Request(`http://localhost:8787${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

// ─── DB mock helpers ──────────────────────────────────────────────────────────
// Returns a fake D1 statement that resolves first()/all()/run() to given values.

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

// ─── Submission fixture factory ───────────────────────────────────────────────

const T_30_MIN_AGO = new Date(Date.now() - 30 * 60 * 1000).toISOString();
const T_5_MIN_AGO = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const T_49_HR_AGO = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString();

function makeSub(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-001",
    user_id: "user-003",
    neighborhood_id: "nb-001",
    status: "draft_before",
    before_photo_url: null,
    before_photo_key: null,
    before_uploaded_at: null,
    started_at: null,
    after_photo_url: null,
    after_photo_key: null,
    after_uploaded_at: null,
    completed_at: null,
    reviewer_id: null,
    reviewed_at: null,
    review_note: null,
    coins_awarded: 0,
    created_at: T_30_MIN_AGO,
    updated_at: T_30_MIN_AGO,
    ...overrides,
  };
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("Cleanify Routes", () => {
  let mockEnv: ReturnType<typeof createMockEnv>;
  let userToken: string;
  let modToken: string;
  let noNbToken: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEnv = createMockEnv();

    userToken = await createJWT(
      { sub: "user-003", role: "user", neighborhood_id: "nb-001" },
      mockEnv.JWT_SECRET,
    );
    modToken = await createJWT(
      { sub: "user-002", role: "moderator", neighborhood_id: "nb-001" },
      mockEnv.JWT_SECRET,
    );
    noNbToken = await createJWT(
      { sub: "user-003", role: "user", neighborhood_id: null },
      mockEnv.JWT_SECRET,
    );
  });

  // ── POST /start ─────────────────────────────────────────────────────────────

  describe("POST /start", () => {
    it("creates a new submission in draft_before status", async () => {
      // 1st prepare: expireStaleSubmissions UPDATE — run()
      // 2nd prepare: getActiveSubmission SELECT — returns null (no conflict)
      // 3rd prepare: INSERT new submission — run()
      // 4th prepare: SELECT new submission — returns draft
      const draft = makeSub({ status: "draft_before" });
      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt()) // expire stale
        .mockReturnValueOnce(stmt(null)) // active submission check
        .mockReturnValueOnce(stmt()) // insert
        .mockReturnValueOnce(stmt(draft)); // fetch created

      const res = await cleanify.fetch(
        req("/start", { method: "POST", auth: userToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(201);
      expect(data.success).toBe(true);
      expect(data.data.status).toBe("draft_before");
    });

    it("blocks if user already has an active submission", async () => {
      const active = makeSub({ status: "in_progress" });
      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt()) // expire stale
        .mockReturnValueOnce(stmt(active)); // active submission found

      const res = await cleanify.fetch(
        req("/start", { method: "POST", auth: userToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(409);
      expect(data.error.code).toBe("ACTIVE_SUBMISSION_EXISTS");
    });

    it("rejects request without neighborhood in token", async () => {
      const res = await cleanify.fetch(
        req("/start", { method: "POST", auth: noNbToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(data.error.code).toBe("NEIGHBORHOOD_REQUIRED");
    });

    it("rejects unauthenticated request", async () => {
      const res = await cleanify.fetch(
        req("/start", { method: "POST" }),
        mockEnv,
        {} as any,
      );

      expect(res.status).toBe(401);
    });
  });

  // ── POST /:id/before/presigned-url ──────────────────────────────────────────

  describe("POST /:id/before/presigned-url", () => {
    it("returns a presigned URL for a draft_before submission", async () => {
      const draft = makeSub({ status: "draft_before" });
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(draft));

      const res = await cleanify.fetch(
        req("/sub-001/before/presigned-url", {
          method: "POST",
          auth: userToken,
          body: { file_extension: "jpg" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(data.data.upload_url).toBeDefined();
      expect(data.data.file_key).toContain("before");
    });

    it("rejects if submission is not draft_before", async () => {
      const inProgress = makeSub({ status: "in_progress" });
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(inProgress));

      const res = await cleanify.fetch(
        req("/sub-001/before/presigned-url", {
          method: "POST",
          auth: userToken,
          body: { file_extension: "jpg" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(data.error.code).toBe("INVALID_STATUS");
    });

    it("returns 404 for non-existent submission", async () => {
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(null));

      const res = await cleanify.fetch(
        req("/nonexistent/before/presigned-url", {
          method: "POST",
          auth: userToken,
          body: { file_extension: "jpg" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(404);
      expect(data.error.code).toBe("SUBMISSION_NOT_FOUND");
    });
  });

  // ── POST /:id/before/confirm ─────────────────────────────────────────────────

  describe("POST /:id/before/confirm", () => {
    it("confirms before photo and transitions to in_progress", async () => {
      const draft = makeSub({ status: "draft_before" });
      const updated = makeSub({
        status: "in_progress",
        before_uploaded_at: T_5_MIN_AGO,
      });
      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt(draft)) // fetch submission
        .mockReturnValueOnce(stmt()) // UPDATE status
        .mockReturnValueOnce(stmt(updated)); // fetch updated

      const res = await cleanify.fetch(
        req("/sub-001/before/confirm", {
          method: "POST",
          auth: userToken,
          body: { file_key: "cleanify/user-003/sub-001/before.jpg" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(data.data.status).toBe("in_progress");
    });

    it("requires file_key in body", async () => {
      const draft = makeSub({ status: "draft_before" });
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(draft));

      const res = await cleanify.fetch(
        req("/sub-001/before/confirm", {
          method: "POST",
          auth: userToken,
          body: {},
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(data.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ── POST /:id/after/presigned-url ────────────────────────────────────────────

  describe("POST /:id/after/presigned-url", () => {
    it("returns presigned URL when 20-min gate has passed", async () => {
      const sub = makeSub({
        status: "in_progress",
        before_uploaded_at: T_30_MIN_AGO,
        started_at: T_30_MIN_AGO,
      });
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(sub));

      const res = await cleanify.fetch(
        req("/sub-001/after/presigned-url", {
          method: "POST",
          auth: userToken,
          body: { file_extension: "jpg" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(data.data.upload_url).toBeDefined();
    });

    it("rejects with TOO_EARLY if less than 20 minutes have passed", async () => {
      const sub = makeSub({
        status: "in_progress",
        before_uploaded_at: T_5_MIN_AGO, // only 5 min ago
        started_at: T_5_MIN_AGO,
      });
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(sub));

      const res = await cleanify.fetch(
        req("/sub-001/after/presigned-url", {
          method: "POST",
          auth: userToken,
          body: { file_extension: "jpg" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(data.error.code).toBe("TOO_EARLY");
    });

    it("rejects with SUBMISSION_EXPIRED if 48-hour window has passed", async () => {
      const sub = makeSub({
        status: "in_progress",
        before_uploaded_at: T_49_HR_AGO, // 49 hours ago
        started_at: T_49_HR_AGO,
      });
      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt(sub)) // fetch
        .mockReturnValueOnce(stmt()); // UPDATE to expired

      const res = await cleanify.fetch(
        req("/sub-001/after/presigned-url", {
          method: "POST",
          auth: userToken,
          body: { file_extension: "jpg" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(410);
      expect(data.error.code).toBe("SUBMISSION_EXPIRED");
    });

    it("rejects if status is not in_progress", async () => {
      const sub = makeSub({ status: "draft_before" });
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(sub));

      const res = await cleanify.fetch(
        req("/sub-001/after/presigned-url", {
          method: "POST",
          auth: userToken,
          body: { file_extension: "jpg" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(data.error.code).toBe("INVALID_STATUS");
    });
  });

  // ── POST /:id/after/confirm ──────────────────────────────────────────────────

  describe("POST /:id/after/confirm", () => {
    it("confirms after photo and transitions to pending_review", async () => {
      const sub = makeSub({
        status: "in_progress",
        before_uploaded_at: T_30_MIN_AGO,
      });
      const updated = makeSub({ status: "pending_review" });
      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt(sub)) // fetch
        .mockReturnValueOnce(stmt()) // UPDATE
        .mockReturnValueOnce(stmt()) // notification queue (run)
        .mockReturnValueOnce(stmt(updated)); // fetch updated

      const res = await cleanify.fetch(
        req("/sub-001/after/confirm", {
          method: "POST",
          auth: userToken,
          body: { file_key: "cleanify/user-003/sub-001/after.jpg" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(data.data.status).toBe("pending_review");
    });

    it("requires file_key in body", async () => {
      const sub = makeSub({
        status: "in_progress",
        before_uploaded_at: T_30_MIN_AGO,
      });
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(sub));

      const res = await cleanify.fetch(
        req("/sub-001/after/confirm", {
          method: "POST",
          auth: userToken,
          body: {},
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(data.error.code).toBe("VALIDATION_ERROR");
    });
  });

  // ── GET /submissions ─────────────────────────────────────────────────────────

  describe("GET /submissions", () => {
    it("returns caller own submissions by default", async () => {
      const subs = [makeSub(), makeSub({ id: "sub-002", status: "approved" })];
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(null, subs));

      const res = await cleanify.fetch(
        req("/submissions", { auth: userToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(Array.isArray(data.data.submissions)).toBe(true);
    });

    it("returns pending_review submissions for moderator", async () => {
      const pending = [makeSub({ status: "pending_review" })];
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(null, pending));

      const res = await cleanify.fetch(
        req("/submissions?pending=true", { auth: modToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(data.data.submissions).toHaveLength(1);
    });

    it("forbids regular user from accessing pending queue", async () => {
      const res = await cleanify.fetch(
        req("/submissions?pending=true", { auth: userToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(403);
      expect(data.error.code).toBe("INSUFFICIENT_PERMISSIONS");
    });
  });

  // ── GET /submissions/:id ─────────────────────────────────────────────────────

  describe("GET /submissions/:id", () => {
    it("returns submission for the owner", async () => {
      const sub = makeSub({ status: "pending_review" });
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(sub));

      const res = await cleanify.fetch(
        req("/submissions/sub-001", { auth: userToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(data.data.id).toBe("sub-001");
    });

    it("returns 404 for non-existent submission", async () => {
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(null));

      const res = await cleanify.fetch(
        req("/submissions/nonexistent", { auth: userToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(404);
      expect(data.error.code).toBe("SUBMISSION_NOT_FOUND");
    });

    it("forbids access to another user submission", async () => {
      const sub = makeSub({ user_id: "user-004" }); // different owner
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(sub));

      const res = await cleanify.fetch(
        req("/submissions/sub-001", { auth: userToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(403);
      expect(data.error.code).toBe("FORBIDDEN");
    });
  });

  // ── POST /submissions/:id/approve ────────────────────────────────────────────

  describe("POST /submissions/:id/approve", () => {
    it("approves a pending_review submission as moderator", async () => {
      const sub = makeSub({ status: "pending_review" });
      const updated = makeSub({ status: "approved", coins_awarded: 150 });
      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt(sub)) // fetch
        .mockReturnValueOnce(stmt()) // UPDATE status
        .mockReturnValueOnce(stmt()) // INSERT coin ledger
        .mockReturnValueOnce(stmt(updated)); // fetch updated

      const res = await cleanify.fetch(
        req("/submissions/sub-001/approve", {
          method: "POST",
          auth: modToken,
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(data.data.submission.status).toBe("approved");
    });

    it("blocks regular user from approving", async () => {
      const res = await cleanify.fetch(
        req("/submissions/sub-001/approve", {
          method: "POST",
          auth: userToken,
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(403);
      expect(data.error.code).toBe("INSUFFICIENT_PERMISSIONS");
    });

    it("returns ALREADY_REVIEWED for a non-pending_review submission", async () => {
      const sub = makeSub({ status: "approved" });
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(sub));

      const res = await cleanify.fetch(
        req("/submissions/sub-001/approve", {
          method: "POST",
          auth: modToken,
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(data.error.code).toBe("ALREADY_REVIEWED");
    });

    it("returns SUBMISSION_NOT_FOUND for unknown id", async () => {
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(null));

      const res = await cleanify.fetch(
        req("/submissions/nonexistent/approve", {
          method: "POST",
          auth: modToken,
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(404);
      expect(data.error.code).toBe("SUBMISSION_NOT_FOUND");
    });
  });

  // ── POST /submissions/:id/reject ─────────────────────────────────────────────

  describe("POST /submissions/:id/reject", () => {
    it("rejects a pending_review submission with a note", async () => {
      const sub = makeSub({ status: "pending_review" });
      const updated = makeSub({ status: "rejected", review_note: "Bad photo" });
      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt(sub))
        .mockReturnValueOnce(stmt())
        .mockReturnValueOnce(stmt(updated));

      const res = await cleanify.fetch(
        req("/submissions/sub-001/reject", {
          method: "POST",
          auth: modToken,
          body: { note: "Bad photo" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(data.data.submission.status).toBe("rejected");
    });

    it("requires a rejection note", async () => {
      const sub = makeSub({ status: "pending_review" });
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(sub));

      const res = await cleanify.fetch(
        req("/submissions/sub-001/reject", {
          method: "POST",
          auth: modToken,
          body: {},
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(data.error.code).toBe("VALIDATION_ERROR");
    });

    it("blocks regular user from rejecting", async () => {
      const res = await cleanify.fetch(
        req("/submissions/sub-001/reject", {
          method: "POST",
          auth: userToken,
          body: { note: "test" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(403);
      expect(data.error.code).toBe("INSUFFICIENT_PERMISSIONS");
    });

    it("returns SUBMISSION_NOT_FOUND for unknown id", async () => {
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(null));

      const res = await cleanify.fetch(
        req("/submissions/nonexistent/reject", {
          method: "POST",
          auth: modToken,
          body: { note: "Not found" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(404);
      expect(data.error.code).toBe("SUBMISSION_NOT_FOUND");
    });
  });

  // ── GET /stats ───────────────────────────────────────────────────────────────

  describe("GET /stats", () => {
    it("returns combined neighborhood and user statistics", async () => {
      const statsRow = {
        total: 10,
        approved: 7,
        pending_review: 2,
        rejected: 1,
        user_total: 3,
        user_approved: 2,
        user_coins: 300,
      };
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(statsRow));

      const res = await cleanify.fetch(
        req("/stats", { auth: userToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(data.data.neighborhood.total_submissions).toBe(10);
    });

    it("returns NEIGHBORHOOD_REQUIRED when no neighborhood context", async () => {
      const res = await cleanify.fetch(
        req("/stats", { auth: noNbToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(data.error.code).toBe("NEIGHBORHOOD_REQUIRED");
    });
  });
});
