/**
 * Tests: Verification Routes
 *
 * Each test primes the mock D1 in the exact call-order the handler makes:
 *   GET session → UPDATE session → UPDATE user → QUEUE.send → etc.
 *
 * Assertions cover:
 *   - HTTP status codes and error codes (the API contract)
 *   - Session ownership enforcement (different user → 403)
 *   - Status-machine transitions (wrong state → 409)
 *   - Queue dispatch (submit → VERIFICATION_QUEUE.send called)
 *   - Webhook idempotency (already finalized → 200, no-op)
 *   - Webhook secret enforcement (wrong secret → 401)
 *   - Admin-only routes (non-admin → 403)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTestApp,
  createTestEnv,
  mockFirstOnce,
  mockRunOnce,
} from "../helpers";
import { createJWT } from "../../src/lib/utils";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function makeToken(
  env: ReturnType<typeof createTestEnv>,
  opts: {
    userId?: string;
    role?: string;
    verificationStatus?: string;
    scope?: string;
  } = {},
) {
  return createJWT(
    {
      sub: opts.userId ?? "user-test-001",
      role: opts.role ?? "user",
      neighborhood_id: null,
      verification_status: opts.verificationStatus ?? "unverified",
      scope: opts.scope ?? "verification_only",
    },
    env.JWT_SECRET,
    24,
  );
}

// Must be a valid UUID — routes validate session_id with z.string().uuid()
const TEST_SESSION_ID = "a1b2c3d4-0000-0000-0000-000000000001";

const SESSION_CREATED = {
  id: TEST_SESSION_ID,
  user_id: "user-test-001",
  status: "created",
  expires_at: new Date(Date.now() + 86400000).toISOString(),
  attempt_count: 0,
  front_doc_key: null,
  back_doc_key: null,
  selfie_key: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const SESSION_WITH_DOCS = {
  ...SESSION_CREATED,
  front_doc_key:
    "verification/user-test-001/a1b2c3d4-0000-0000-0000-000000000001/front.jpg",
  back_doc_key:
    "verification/user-test-001/a1b2c3d4-0000-0000-0000-000000000001/back.jpg",
  selfie_key:
    "verification/user-test-001/a1b2c3d4-0000-0000-0000-000000000001/selfie.jpg",
};

const SESSION_PENDING = { ...SESSION_WITH_DOCS, status: "pending" };
const SESSION_VERIFIED = { ...SESSION_WITH_DOCS, status: "verified" };

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /v1/verification/start", () => {
  let app: ReturnType<typeof createTestApp>;
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createTestEnv();
  });

  it("creates a new session (201) for an unverified user with no existing session", async () => {
    const token = await makeToken(env);
    mockFirstOnce(env, null); // getLatestVerificationSessionForUser → none
    mockRunOnce(env); // INSERT session
    mockFirstOnce(env, SESSION_CREATED); // SELECT after insert

    const res = await app.request(
      "/v1/verification/start",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
      env,
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.session_id).toBe(TEST_SESSION_ID);
    expect(body.data.status).toBe("created");
    expect(body.data.upload_requirements.documents).toEqual([
      "front",
      "back",
      "selfie",
    ]);
  });

  it("returns 200 and reuses an existing open session", async () => {
    const token = await makeToken(env);
    mockFirstOnce(env, SESSION_CREATED); // existing open session found

    const res = await app.request(
      "/v1/verification/start",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
      env,
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data.session_id).toBe(TEST_SESSION_ID);
  });

  it("returns 200 already_verified for a verified user", async () => {
    const token = await makeToken(env, {
      verificationStatus: "verified",
      scope: "full",
    });

    const res = await app.request(
      "/v1/verification/start",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
      env,
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data.already_verified).toBe(true);
  });

  it("returns 429 MAX_ATTEMPTS_EXCEEDED after 3 failed attempts", async () => {
    const token = await makeToken(env);
    mockFirstOnce(env, {
      ...SESSION_CREATED,
      status: "failed",
      attempt_count: 3,
    });

    const res = await app.request(
      "/v1/verification/start",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
      env,
    );

    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("MAX_ATTEMPTS_EXCEEDED");
  });

  it("returns 401 without a token", async () => {
    const res = await app.request(
      "/v1/verification/start",
      { method: "POST" },
      env,
    );
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /v1/verification/presigned-url", () => {
  let app: ReturnType<typeof createTestApp>;
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createTestEnv();
  });

  it("returns 200 with upload_url and file_key for a valid session", async () => {
    const token = await makeToken(env);
    mockFirstOnce(env, SESSION_CREATED); // getVerificationSessionById
    mockRunOnce(env); // updateVerificationSession (store key)

    const res = await app.request(
      "/v1/verification/presigned-url",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id: TEST_SESSION_ID,
          document_type: "front",
          file_extension: "jpg",
        }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.file_key).toContain("verification/");
    expect(body.data.file_key).toContain("front.jpg");
    expect(body.data.upload_url).toContain("/v1/uploads/direct");
    expect(body.data.expires_at).toBeDefined();
  });

  it("returns 403 when session belongs to a different user", async () => {
    const token = await makeToken(env, { userId: "user-other-999" });
    // session belongs to user-test-001, token is for user-other-999
    mockFirstOnce(env, SESSION_CREATED);

    const res = await app.request(
      "/v1/verification/presigned-url",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id: TEST_SESSION_ID,
          document_type: "front",
          file_extension: "jpg",
        }),
      },
      env,
    );

    expect(res.status).toBe(403);
  });

  it("returns 409 SESSION_NOT_OPEN when session is pending", async () => {
    const token = await makeToken(env);
    mockFirstOnce(env, SESSION_PENDING);

    const res = await app.request(
      "/v1/verification/presigned-url",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id: TEST_SESSION_ID,
          document_type: "front",
          file_extension: "jpg",
        }),
      },
      env,
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("SESSION_NOT_OPEN");
  });

  it("returns 404 for an unknown session_id", async () => {
    const token = await makeToken(env);
    mockFirstOnce(env, null); // session not found

    const res = await app.request(
      "/v1/verification/presigned-url",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id: "00000000-0000-0000-0000-000000000000",
          document_type: "selfie",
          file_extension: "png",
        }),
      },
      env,
    );

    expect(res.status).toBe(404);
  });

  it("returns 400 for an invalid document_type", async () => {
    const token = await makeToken(env);

    const res = await app.request(
      "/v1/verification/presigned-url",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id: TEST_SESSION_ID,
          document_type: "invalid",
          file_extension: "jpg",
        }),
      },
      env,
    );

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /v1/verification/submit", () => {
  let app: ReturnType<typeof createTestApp>;
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createTestEnv();
  });

  it("transitions session to pending and enqueues AI job", async () => {
    const token = await makeToken(env);
    mockFirstOnce(env, SESSION_WITH_DOCS); // getVerificationSessionById
    mockRunOnce(env); // UPDATE session → pending
    mockRunOnce(env); // UPDATE user verification_status → pending

    const res = await app.request(
      "/v1/verification/submit",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ session_id: TEST_SESSION_ID }),
      },
      env,
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe("pending");

    expect(env.VERIFICATION_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "run_ai_check",
        session_id: TEST_SESSION_ID,
      }),
    );
  });

  it("returns 422 DOCUMENTS_INCOMPLETE when docs are missing", async () => {
    const token = await makeToken(env);
    // Session has no doc keys
    mockFirstOnce(env, SESSION_CREATED);

    const res = await app.request(
      "/v1/verification/submit",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ session_id: TEST_SESSION_ID }),
      },
      env,
    );

    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("DOCUMENTS_INCOMPLETE");
    expect(env.VERIFICATION_QUEUE.send).not.toHaveBeenCalled();
  });

  it("returns 409 when session is already pending", async () => {
    const token = await makeToken(env);
    mockFirstOnce(env, SESSION_PENDING);

    const res = await app.request(
      "/v1/verification/submit",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ session_id: TEST_SESSION_ID }),
      },
      env,
    );

    expect(res.status).toBe(409);
  });

  it("returns 403 when session belongs to a different user", async () => {
    const token = await makeToken(env, { userId: "different-user" });
    mockFirstOnce(env, SESSION_WITH_DOCS); // still belongs to user-test-001

    const res = await app.request(
      "/v1/verification/submit",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ session_id: TEST_SESSION_ID }),
      },
      env,
    );

    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/verification/status", () => {
  let app: ReturnType<typeof createTestApp>;
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createTestEnv();
  });

  it("returns session info when a session exists", async () => {
    const token = await makeToken(env);
    mockFirstOnce(env, SESSION_PENDING);

    const res = await app.request(
      "/v1/verification/status",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.session.id).toBe(TEST_SESSION_ID);
    expect(body.data.session.status).toBe("pending");
    // rejection_reason only exposed on failed sessions
    expect(body.data.session.rejection_reason).toBeNull();
  });

  it("returns null session when user has no sessions", async () => {
    const token = await makeToken(env);
    mockFirstOnce(env, null);

    const res = await app.request(
      "/v1/verification/status",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data.session).toBeNull();
  });

  it("exposes rejection_reason on a failed session", async () => {
    const token = await makeToken(env);
    mockFirstOnce(env, {
      ...SESSION_WITH_DOCS,
      status: "failed",
      ai_rejection_reason: "Document appears to be altered.",
    });

    const res = await app.request(
      "/v1/verification/status",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect((await res.json()).data.session.rejection_reason).toBe(
      "Document appears to be altered.",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /v1/verification/webhook", () => {
  let app: ReturnType<typeof createTestApp>;
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createTestEnv();
  });

  const call = (body: object, secret?: string) =>
    app.request(
      "/v1/verification/webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Secret": secret ?? env.INTERNAL_WEBHOOK_SECRET,
        },
        body: JSON.stringify(body),
      },
      env,
    );

  it("approves the session and updates the user on approved=true", async () => {
    mockFirstOnce(env, SESSION_PENDING);
    mockRunOnce(env); // UPDATE session
    mockRunOnce(env); // UPDATE user

    const res = await call({
      session_id: TEST_SESSION_ID,
      approved: true,
      confidence: 0.95,
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe("verified");
    expect(env.NOTIFICATION_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "verification_approved" }),
    );
  });

  it("rejects the session on approved=false with a rejection_reason", async () => {
    mockFirstOnce(env, SESSION_PENDING);
    mockRunOnce(env);
    mockRunOnce(env);

    const res = await call({
      session_id: TEST_SESSION_ID,
      approved: false,
      confidence: 0.3,
      rejection_reason: "Selfie does not match the document photo.",
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe("failed");
    expect(env.NOTIFICATION_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "verification_rejected",
        body: "Selfie does not match the document photo.",
      }),
    );
  });

  it("is idempotent — returns already_finalized for a verified session", async () => {
    mockFirstOnce(env, SESSION_VERIFIED);

    const res = await call({
      session_id: TEST_SESSION_ID,
      approved: true,
      confidence: 0.9,
    });

    expect(res.status).toBe(200);
    expect((await res.json()).data.already_finalized).toBe(true);
    // Must NOT mutate anything
    expect(env.NOTIFICATION_QUEUE.send).not.toHaveBeenCalled();
  });

  it("returns 401 with an invalid internal secret", async () => {
    const res = await call(
      { session_id: TEST_SESSION_ID, approved: true, confidence: 0.9 },
      "wrong-secret",
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 VALIDATION_ERROR for malformed payload", async () => {
    const res = await call({ session_id: "not-a-uuid", approved: "yes" });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /v1/verification/admin/review", () => {
  let app: ReturnType<typeof createTestApp>;
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createTestEnv();
  });

  it("allows an admin to manually approve a session", async () => {
    const token = await makeToken(env, {
      role: "admin",
      verificationStatus: "verified",
      scope: "full",
    });
    mockFirstOnce(env, SESSION_PENDING); // getVerificationSessionById
    mockRunOnce(env); // UPDATE session
    mockRunOnce(env); // UPDATE user

    const res = await app.request(
      "/v1/verification/admin/review",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id: TEST_SESSION_ID,
          approved: true,
          note: "Manually verified by ops team",
        }),
      },
      env,
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe("verified");
  });

  it("returns 403 INSUFFICIENT_PERMISSIONS for a non-admin user", async () => {
    const token = await makeToken(env, {
      role: "user",
      verificationStatus: "verified",
      scope: "full",
    });

    const res = await app.request(
      "/v1/verification/admin/review",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ session_id: TEST_SESSION_ID, approved: true }),
      },
      env,
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("INSUFFICIENT_PERMISSIONS");
  });

  it("returns 401 without a token", async () => {
    const res = await app.request(
      "/v1/verification/admin/review",
      { method: "POST" },
      env,
    );
    expect(res.status).toBe(401);
  });
});
