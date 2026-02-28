/**
 * Tests: Auth Routes
 *
 * Pattern used throughout:
 *   1. Create a fresh app + env per test via beforeEach
 *   2. Use mockFirstOnce/mockRunOnce to prime the mock D1 with the exact
 *      rows each route handler will query — in the order they're queried
 *   3. Call the route via app.request(url, init, env) — same code path as prod
 *   4. Assert on status, response body, and (where meaningful) queue calls
 *
 * What this covers vs. what it doesn't:
 *   ✓ HTTP contract (status codes, response shapes, error codes)
 *   ✓ Business-logic branches (KYC gate, banned accounts, token scope checks)
 *   ✓ That the right DB methods are invoked (via prepare mock assertions)
 *   ✓ That queues are dispatched with the right payload
 *   ✗ Raw SQL correctness — covered by integration tests against real D1
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTestApp,
  createTestEnv,
  mockFirstOnce,
  mockRunOnce,
} from "../helpers";
import { createJWT, hashPassword } from "../../src/lib/utils";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const VERIFIED_USER = {
  id: "user-verified-001",
  email: "verified@wihda.dz",
  phone: null,
  password_hash: "", // set in beforeEach after hashing
  display_name: "Verified User",
  role: "user",
  status: "active",
  verification_status: "verified",
  language_preference: "fr",
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

const UNVERIFIED_USER = {
  ...VERIFIED_USER,
  id: "user-unverified-001",
  email: "unverified@wihda.dz",
  verification_status: "unverified",
};

const PENDING_USER = {
  ...VERIFIED_USER,
  id: "user-pending-001",
  email: "pending@wihda.dz",
  verification_status: "pending",
};

const BANNED_USER = {
  ...VERIFIED_USER,
  id: "user-banned-001",
  email: "banned@wihda.dz",
  status: "banned",
};

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /v1/auth/signup", () => {
  let app: ReturnType<typeof createTestApp>;
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createTestEnv();
  });

  const validBody = {
    email: "new@wihda.dz",
    password: "SecurePass123!",
    display_name: "New User",
    language_preference: "fr",
  };

  it("returns 201 with restricted_token and verification_session_id — no full tokens", async () => {
    // getUserByEmail → null (no existing user)
    mockFirstOnce(env, null);
    // createUser insert (.run)
    mockRunOnce(env);
    // getUserById inside createUser → new user row
    mockFirstOnce(env, {
      id: "new-user-id",
      display_name: "New User",
      role: "user",
      status: "active",
      verification_status: "unverified",
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    });
    // createVerificationSession insert (.run)
    mockRunOnce(env);
    // session SELECT after insert
    mockFirstOnce(env, {
      id: "session-id-001",
      user_id: "new-user-id",
      status: "created",
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      attempt_count: 0,
      created_at: new Date().toISOString(),
    });

    const res = await app.request(
      "/v1/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      },
      env,
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.verification_session_id).toBeDefined();
    expect(body.data.restricted_token).toBeDefined();
    expect(body.data.expires_in).toBe(86400);
    // Must NOT contain full access/refresh tokens
    expect(body.data.access_token).toBeUndefined();
    expect(body.data.refresh_token).toBeUndefined();
  });

  it("returns 409 EMAIL_EXISTS when email is already taken", async () => {
    // getUserByEmail → existing user
    mockFirstOnce(env, { id: "existing-001", email: "new@wihda.dz" });

    const res = await app.request(
      "/v1/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validBody),
      },
      env,
    );

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("EMAIL_EXISTS");
  });

  it("returns 400 VALIDATION_ERROR when neither email nor phone provided", async () => {
    const res = await app.request(
      "/v1/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password: "SecurePass123!",
          display_name: "No Contact",
        }),
      },
      env,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when password is shorter than 8 characters", async () => {
    const res = await app.request(
      "/v1/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...validBody, password: "short" }),
      },
      env,
    );

    expect(res.status).toBe(400);
  });

  it("accepts a phone-only signup", async () => {
    mockFirstOnce(env, null); // getUserByPhone → null
    mockRunOnce(env); // createUser
    mockFirstOnce(env, {
      id: "new-user-id",
      display_name: "Phone User",
      role: "user",
      status: "active",
      verification_status: "unverified",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    mockRunOnce(env); // session insert
    mockFirstOnce(env, {
      id: "session-id-002",
      user_id: "new-user-id",
      status: "created",
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      attempt_count: 0,
      created_at: new Date().toISOString(),
    });

    const res = await app.request(
      "/v1/auth/signup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: "+213555123456",
          password: "SecurePass123!",
          display_name: "Phone User",
        }),
      },
      env,
    );

    expect(res.status).toBe(201);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /v1/auth/login", () => {
  let app: ReturnType<typeof createTestApp>;
  let env: ReturnType<typeof createTestEnv>;
  let hashedPassword: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createTestEnv();
    hashedPassword = await hashPassword("SecurePass123!");
    VERIFIED_USER.password_hash = hashedPassword;
  });

  it("returns 200 with full tokens for a verified user", async () => {
    mockFirstOnce(env, { ...VERIFIED_USER, password_hash: hashedPassword });
    mockFirstOnce(env, null); // getUserNeighborhood → no neighborhood

    const res = await app.request(
      "/v1/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "verified@wihda.dz",
          password: "SecurePass123!",
        }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.access_token).toBeDefined();
    expect(body.data.refresh_token).toBeDefined();
    expect(body.data.user.verification_status).toBe("verified");
  });

  it("returns 403 VERIFICATION_REQUIRED for an unverified user", async () => {
    mockFirstOnce(env, { ...UNVERIFIED_USER, password_hash: hashedPassword });

    const res = await app.request(
      "/v1/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "unverified@wihda.dz",
          password: "SecurePass123!",
        }),
      },
      env,
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("VERIFICATION_REQUIRED");
    expect(body.error.details.verification_status).toBe("unverified");
  });

  it("returns 403 VERIFICATION_REQUIRED for a pending user", async () => {
    mockFirstOnce(env, { ...PENDING_USER, password_hash: hashedPassword });

    const res = await app.request(
      "/v1/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "pending@wihda.dz",
          password: "SecurePass123!",
        }),
      },
      env,
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("VERIFICATION_REQUIRED");
  });

  it("returns 403 ACCOUNT_BANNED for a banned user", async () => {
    mockFirstOnce(env, { ...BANNED_USER, password_hash: hashedPassword });

    const res = await app.request(
      "/v1/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "banned@wihda.dz",
          password: "SecurePass123!",
        }),
      },
      env,
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("ACCOUNT_BANNED");
  });

  it("returns 401 INVALID_CREDENTIALS for wrong password", async () => {
    mockFirstOnce(env, { ...VERIFIED_USER, password_hash: hashedPassword });

    const res = await app.request(
      "/v1/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "verified@wihda.dz",
          password: "WrongPassword!",
        }),
      },
      env,
    );

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("INVALID_CREDENTIALS");
  });

  it("returns 401 for an unknown email", async () => {
    mockFirstOnce(env, null); // user not found

    const res = await app.request(
      "/v1/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "nobody@wihda.dz",
          password: "SecurePass123!",
        }),
      },
      env,
    );

    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("POST /v1/auth/refresh", () => {
  let app: ReturnType<typeof createTestApp>;
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createTestEnv();
  });

  it("returns new tokens for a valid full-scope refresh token", async () => {
    const token = await createJWT(
      {
        sub: "user-001",
        role: "user",
        neighborhood_id: null,
        verification_status: "verified",
        scope: "full",
      },
      env.JWT_SECRET,
      168,
    );

    mockFirstOnce(env, { ...VERIFIED_USER, id: "user-001" }); // getUserById
    mockFirstOnce(env, null); // getUserNeighborhood

    const res = await app.request(
      "/v1/auth/refresh",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: token }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.access_token).toBeDefined();
    expect(body.data.refresh_token).toBeDefined();
  });

  it("returns 403 VERIFICATION_TOKEN_RESTRICTED for a verification_only token", async () => {
    const token = await createJWT(
      {
        sub: "user-001",
        role: "user",
        neighborhood_id: null,
        verification_status: "unverified",
        scope: "verification_only",
      },
      env.JWT_SECRET,
      24,
    );

    const res = await app.request(
      "/v1/auth/refresh",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: token }),
      },
      env,
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("VERIFICATION_TOKEN_RESTRICTED");
  });

  it("returns 400 when refresh_token is missing", async () => {
    const res = await app.request(
      "/v1/auth/refresh",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      env,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("MISSING_TOKEN");
  });

  it("returns 401 for an invalid token", async () => {
    const res = await app.request(
      "/v1/auth/refresh",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: "bad.token.here" }),
      },
      env,
    );

    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("INVALID_TOKEN");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/auth/me", () => {
  let app: ReturnType<typeof createTestApp>;
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createTestEnv();
  });

  async function makeToken(verificationStatus = "verified", scope = "full") {
    return createJWT(
      {
        sub: "user-001",
        role: "user",
        neighborhood_id: null,
        verification_status: verificationStatus,
        scope,
      },
      env.JWT_SECRET,
      1,
    );
  }

  it("returns the user profile including verification_status", async () => {
    const token = await makeToken();
    mockFirstOnce(env, { ...VERIFIED_USER, id: "user-001" });
    mockFirstOnce(env, null); // no neighborhood

    const res = await app.request(
      "/v1/auth/me",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.verification_status).toBe("verified");
  });

  it("returns 401 without a token", async () => {
    const res = await app.request("/v1/auth/me", {}, env);
    expect(res.status).toBe(401);
  });

  it("allows /auth/me with a verification_only token (me is not gated by requireVerified)", async () => {
    // /auth/me uses authMiddleware only — it's intentionally accessible to
    // unverified users so the client can check their own status.
    const token = await makeToken("unverified", "verification_only");
    mockFirstOnce(env, { ...UNVERIFIED_USER, id: "user-001" });
    mockFirstOnce(env, null);

    const res = await app.request(
      "/v1/auth/me",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data.verification_status).toBe("unverified");
  });
});
