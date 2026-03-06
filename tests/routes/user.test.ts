/**
 * Tests: User Routes
 *
 * GET   /v1/me          — own profile (accessible with verification_only token)
 * PATCH /v1/me          — update own profile (requires verified)
 * GET   /v1/me/coins    — coin ledger (requires verified)
 * GET   /v1/me/:userId  — look up another user's profile (role-scoped)
 *
 * Mock-DB pattern mirrors auth.test.ts:
 *   mockFirstOnce → primes the next .first() call
 *   mockRunOnce   → primes the next .run() call
 * Mocks are consumed in the order the route handler issues queries.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createTestApp,
  createTestEnv,
  mockFirstOnce,
  mockRunOnce,
} from "../helpers";
import { createJWT } from "../../src/lib/utils";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const VERIFIED_USER = {
  id: "user-verified-001",
  email: "verified@wihda.dz",
  phone: null,
  password_hash: "hashed",
  display_name: "Verified User",
  role: "user",
  status: "active",
  verification_status: "verified",
  language_preference: "fr",
  fcm_token: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

const UNVERIFIED_USER = {
  ...VERIFIED_USER,
  id: "user-unverified-001",
  email: "unverified@wihda.dz",
  verification_status: "unverified",
};

const MODERATOR_USER = {
  ...VERIFIED_USER,
  id: "user-mod-001",
  email: "mod@wihda.dz",
  role: "moderator",
};

const ADMIN_USER = {
  ...VERIFIED_USER,
  id: "user-admin-001",
  email: "admin@wihda.dz",
  role: "admin",
};

const NEIGHBORHOOD = {
  id: "nb-001",
  name: "Bab El Oued",
  city: "Algiers",
  country: "DZ",
  center_lat: 36.77,
  center_lng: 3.05,
  radius_meters: 1000,
  is_active: 1,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
};

const USER_NEIGHBORHOOD = {
  id: "un-001",
  user_id: "user-verified-001",
  neighborhood_id: "nb-001",
  joined_at: "2024-02-01T00:00:00Z",
  left_at: null,
  is_primary: 1,
};

// ─── Token helpers ─────────────────────────────────────────────────────────────

async function makeToken(
  env: ReturnType<typeof createTestEnv>,
  overrides: {
    sub?: string;
    role?: string;
    verificationStatus?: string;
    scope?: string;
    neighborhoodId?: string | null;
  } = {},
) {
  return createJWT(
    {
      sub: overrides.sub ?? "user-verified-001",
      role: overrides.role ?? "user",
      neighborhood_id: overrides.neighborhoodId ?? null,
      verification_status: overrides.verificationStatus ?? "verified",
      scope: overrides.scope ?? "full",
    },
    env.JWT_SECRET,
    1,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/me", () => {
  let app: ReturnType<typeof createTestApp>;
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createTestEnv();
  });

  it("returns own profile including verification_status and coin_balance", async () => {
    const token = await makeToken(env);
    mockFirstOnce(env, { ...VERIFIED_USER }); // getUserById
    mockFirstOnce(env, USER_NEIGHBORHOOD); // getUserNeighborhood
    mockFirstOnce(env, NEIGHBORHOOD); // getNeighborhoodById
    mockFirstOnce(env, { balance: 42 }); // getCoinBalance

    const res = await app.request(
      "/v1/me",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.verification_status).toBe("verified");
    expect(body.data.coin_balance).toBe(42);
    expect(body.data.neighborhood.id).toBe("nb-001");
    // Own profile must always include sensitive fields
    expect(body.data.email).toBe("verified@wihda.dz");
    expect(body.data.status).toBe("active");
  });

  it("returns own profile with null neighborhood when user has not joined one", async () => {
    const token = await makeToken(env);
    mockFirstOnce(env, { ...VERIFIED_USER }); // getUserById
    mockFirstOnce(env, null); // getUserNeighborhood → none
    mockFirstOnce(env, { balance: 0 }); // getCoinBalance

    const res = await app.request(
      "/v1/me",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.neighborhood).toBeNull();
  });

  it("returns 401 without a token", async () => {
    const res = await app.request("/v1/me", {}, env);
    expect(res.status).toBe(401);
  });

  it("is accessible with a verification_only token — client needs this to poll KYC status", async () => {
    // GET /v1/me is intentionally NOT gated by requireVerified so unverified
    // users can check their own status during the KYC flow.
    const token = await makeToken(env, {
      sub: "user-unverified-001",
      verificationStatus: "unverified",
      scope: "verification_only",
    });
    mockFirstOnce(env, { ...UNVERIFIED_USER }); // getUserById
    mockFirstOnce(env, null); // getUserNeighborhood
    mockFirstOnce(env, { balance: 0 }); // getCoinBalance

    const res = await app.request(
      "/v1/me",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data.verification_status).toBe("unverified");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /v1/me", () => {
  let app: ReturnType<typeof createTestApp>;
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createTestEnv();
  });

  it("updates display_name and returns the updated fields", async () => {
    const token = await makeToken(env);
    mockRunOnce(env); // updateUser → UPDATE run
    mockFirstOnce(env, {
      // getUserById inside updateUser
      ...VERIFIED_USER,
      display_name: "Updated Name",
      updated_at: "2024-06-01T00:00:00Z",
    });

    const res = await app.request(
      "/v1/me",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ display_name: "Updated Name" }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.display_name).toBe("Updated Name");
    expect(body.data.updated_at).toBeDefined();
  });

  it("returns 400 VALIDATION_ERROR for a display_name that is too short", async () => {
    const token = await makeToken(env);

    const res = await app.request(
      "/v1/me",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ display_name: "X" }),
      },
      env,
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 403 VERIFICATION_TOKEN_RESTRICTED for a verification_only token", async () => {
    const token = await makeToken(env, {
      verificationStatus: "unverified",
      scope: "verification_only",
    });

    const res = await app.request(
      "/v1/me",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ display_name: "Should Fail" }),
      },
      env,
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("VERIFICATION_TOKEN_RESTRICTED");
  });

  it("returns 401 without a token", async () => {
    const res = await app.request(
      "/v1/me",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: "No Token" }),
      },
      env,
    );
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/me/coins", () => {
  let app: ReturnType<typeof createTestApp>;
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createTestEnv();
  });

  it("returns coin balance and empty ledger", async () => {
    const token = await makeToken(env);
    mockFirstOnce(env, { balance: 100 }); // getCoinBalance
    // getCoinLedgerEntries → .all() — mockFirstOnce covers first() calls;
    // for .all() we prime via the mock returning results directly.
    // The helpers mock returns { results: [] } for .all() by default.

    const res = await app.request(
      "/v1/me/coins",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.balance).toBe(100);
    expect(body.data.has_more).toBe(false);
  });

  it("returns 403 VERIFICATION_TOKEN_RESTRICTED for a verification_only token", async () => {
    const token = await makeToken(env, {
      verificationStatus: "unverified",
      scope: "verification_only",
    });

    const res = await app.request(
      "/v1/me/coins",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("VERIFICATION_TOKEN_RESTRICTED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("GET /v1/me/:userId", () => {
  let app: ReturnType<typeof createTestApp>;
  let env: ReturnType<typeof createTestEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createTestApp();
    env = createTestEnv();
  });

  it("returns basic public profile only for a regular user caller", async () => {
    const token = await makeToken(env, { role: "user" });
    mockFirstOnce(env, { ...VERIFIED_USER, id: "user-target-001" }); // getUserById (target)
    mockFirstOnce(env, USER_NEIGHBORHOOD); // getUserNeighborhood
    mockFirstOnce(env, NEIGHBORHOOD); // getNeighborhoodById

    const res = await app.request(
      "/v1/me/user-target-001",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe("user-target-001");
    expect(body.data.display_name).toBeDefined();
    expect(body.data.role).toBeDefined();
    expect(body.data.created_at).toBeDefined();
    expect(body.data.neighborhood).not.toBeNull();

    // Must NOT expose sensitive fields to a regular user
    expect(body.data.verification_status).toBeUndefined();
    expect(body.data.status).toBeUndefined();
    expect(body.data.coin_balance).toBeUndefined();
    expect(body.data.language_preference).toBeUndefined();
    expect(body.data.email).toBeUndefined();
    expect(body.data.phone).toBeUndefined();
  });

  it("returns extended profile for a moderator caller", async () => {
    const token = await makeToken(env, {
      sub: "user-mod-001",
      role: "moderator",
    });
    mockFirstOnce(env, { ...VERIFIED_USER, id: "user-target-001" }); // getUserById (target)
    mockFirstOnce(env, USER_NEIGHBORHOOD); // getUserNeighborhood
    mockFirstOnce(env, NEIGHBORHOOD); // getNeighborhoodById
    mockFirstOnce(env, { balance: 75 }); // getCoinBalance

    const res = await app.request(
      "/v1/me/user-target-001",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe("user-target-001");

    // Extended fields must be present for moderators
    expect(body.data.verification_status).toBe("verified");
    expect(body.data.status).toBe("active");
    expect(body.data.coin_balance).toBe(75);
    expect(body.data.language_preference).toBe("fr");
  });

  it("returns extended profile for an admin caller", async () => {
    const token = await makeToken(env, {
      sub: "user-admin-001",
      role: "admin",
    });
    mockFirstOnce(env, { ...VERIFIED_USER, id: "user-target-001" }); // getUserById (target)
    mockFirstOnce(env, null); // getUserNeighborhood → none
    mockFirstOnce(env, { balance: 0 }); // getCoinBalance

    const res = await app.request(
      "/v1/me/user-target-001",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.verification_status).toBe("verified");
    expect(body.data.status).toBe("active");
    expect(body.data.coin_balance).toBe(0);
    expect(body.data.neighborhood).toBeNull();
  });

  it("returns 404 for an unknown userId", async () => {
    const token = await makeToken(env);
    mockFirstOnce(env, null); // getUserById → not found

    const res = await app.request(
      "/v1/me/nonexistent-user",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("USER_NOT_FOUND");
  });

  it("returns 401 without a token", async () => {
    const res = await app.request("/v1/me/user-target-001", {}, env);
    expect(res.status).toBe(401);
  });

  it("returns 403 VERIFICATION_TOKEN_RESTRICTED for a verification_only token", async () => {
    const token = await makeToken(env, {
      verificationStatus: "unverified",
      scope: "verification_only",
    });

    const res = await app.request(
      "/v1/me/user-target-001",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("VERIFICATION_TOKEN_RESTRICTED");
  });

  it("returns 403 VERIFICATION_REQUIRED for a verified=false full-scope token", async () => {
    const token = await makeToken(env, {
      verificationStatus: "pending",
      scope: "full",
    });

    const res = await app.request(
      "/v1/me/user-target-001",
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("VERIFICATION_REQUIRED");
  });
});
