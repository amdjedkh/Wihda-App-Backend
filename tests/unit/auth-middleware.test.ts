/**
 * Tests for Authentication Middleware
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  authMiddleware,
  optionalAuthMiddleware,
  requireModerator,
  requireAdmin,
  requireNeighborhood,
  requireVerified,
  getAuthContext,
  canModifyResource,
  AuthContext,
} from "../../src/middleware/auth";
import { createMockEnv } from "../fixtures";
import { createJWT } from "../../src/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

/** What our mock context.json() returns */
interface MockResponse {
  status: number;
  json: { success: boolean; error?: { code: string; message: string } };
}

// ─── Mock context factory ─────────────────────────────────────────────────────

function createMockContext(
  options: {
    authHeader?: string;
    auth?: AuthContext;
    env?: ReturnType<typeof createMockEnv>;
  } = {},
) {
  const store: Record<string, unknown> = {};

  return {
    req: {
      header: (name: string) => {
        if (name === "Authorization") return options.authHeader;
        return null;
      },
    },
    env: options.env ?? createMockEnv(),
    set: vi.fn((key: string, value: unknown) => {
      store[key] = value;
    }),
    get: vi.fn((key: string) => {
      if (options.auth && key === "auth") return options.auth;
      return store[key];
    }),
    json: vi.fn(
      (data: unknown, status: number): MockResponse => ({
        json: data as any,
        status,
      }),
    ),
    header: vi.fn(),
  } as any;
}

/**
 * Helper that asserts the middleware returned a blocking response (not undefined)
 * and narrows the type so downstream assertions don't get "possibly undefined".
 *
 * Why this exists: middleware either calls next() (returns void) or returns a
 * Response. TypeScript sees the return type as Response | void, so accessing
 * .status on the raw return value is a type error. This helper makes the intent
 * explicit and gives a clear failure message if the middleware unexpectedly
 * passed through.
 */
function assertBlocked(result: unknown): MockResponse {
  if (result === undefined || result === null) {
    throw new Error(
      "Expected middleware to block the request, but it called next() instead.",
    );
  }
  return result as MockResponse;
}

/** Minimal valid AuthContext with all required fields. */
function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: "user-001",
    userRole: "user",
    neighborhoodId: "nb-001",
    verificationStatus: "verified",
    scope: "full",
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("authMiddleware", () => {
  let mockEnv: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = createMockEnv();
  });

  it("sets auth context including verificationStatus and scope from a valid token", async () => {
    const token = await createJWT(
      {
        sub: "user-001",
        role: "user",
        neighborhood_id: "nb-001",
        verification_status: "verified",
        scope: "full",
      },
      mockEnv.JWT_SECRET,
      24,
    );
    const ctx = createMockContext({
      authHeader: `Bearer ${token}`,
      env: mockEnv,
    });
    const next = vi.fn();

    await authMiddleware(ctx, next);

    expect(next).toHaveBeenCalled();
    expect(ctx.set).toHaveBeenCalledWith("auth", {
      userId: "user-001",
      userRole: "user",
      neighborhoodId: "nb-001",
      verificationStatus: "verified",
      scope: "full",
    });
  });

  it('defaults scope to "full" and verificationStatus to "unverified" for legacy tokens', async () => {
    // Token without the new KYC fields — simulates tokens issued before migration 0003
    const token = await createJWT(
      { sub: "user-old", role: "user", neighborhood_id: null },
      mockEnv.JWT_SECRET,
      24,
    );
    const ctx = createMockContext({
      authHeader: `Bearer ${token}`,
      env: mockEnv,
    });
    const next = vi.fn();

    await authMiddleware(ctx, next);

    expect(next).toHaveBeenCalled();
    expect(ctx.set).toHaveBeenCalledWith(
      "auth",
      expect.objectContaining({
        verificationStatus: "unverified",
        scope: "full",
      }),
    );
  });

  it("returns 401 MISSING_TOKEN for a missing Authorization header", async () => {
    const ctx = createMockContext({ env: mockEnv });
    const next = vi.fn();

    const res = assertBlocked(await authMiddleware(ctx, next));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
    expect(res.json.error?.code).toBe("MISSING_TOKEN");
  });

  it("returns 401 for a malformed Authorization header (Basic scheme)", async () => {
    const ctx = createMockContext({
      authHeader: "Basic credentials",
      env: mockEnv,
    });
    const next = vi.fn();

    const res = assertBlocked(await authMiddleware(ctx, next));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it("returns 401 INVALID_TOKEN for an invalid token", async () => {
    const ctx = createMockContext({
      authHeader: "Bearer invalid.token.here",
      env: mockEnv,
    });
    const next = vi.fn();

    const res = assertBlocked(await authMiddleware(ctx, next));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
    expect(res.json.error?.code).toBe("INVALID_TOKEN");
  });

  it("returns 401 for a token signed with the wrong secret", async () => {
    const token = await createJWT(
      { sub: "user-001", role: "user", neighborhood_id: null },
      "wrong-secret",
      24,
    );
    const ctx = createMockContext({
      authHeader: `Bearer ${token}`,
      env: mockEnv,
    });
    const next = vi.fn();

    const res = assertBlocked(await authMiddleware(ctx, next));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });

  it("handles null neighborhood_id correctly", async () => {
    const token = await createJWT(
      {
        sub: "user-001",
        role: "user",
        neighborhood_id: null,
        verification_status: "verified",
        scope: "full",
      },
      mockEnv.JWT_SECRET,
      24,
    );
    const ctx = createMockContext({
      authHeader: `Bearer ${token}`,
      env: mockEnv,
    });
    const next = vi.fn();

    await authMiddleware(ctx, next);

    expect(ctx.set).toHaveBeenCalledWith(
      "auth",
      expect.objectContaining({ neighborhoodId: null }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("optionalAuthMiddleware", () => {
  let mockEnv: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = createMockEnv();
  });

  it("passes through without setting context when no token is present", async () => {
    const ctx = createMockContext({ env: mockEnv });
    const next = vi.fn();
    await optionalAuthMiddleware(ctx, next);
    expect(next).toHaveBeenCalled();
    expect(ctx.set).not.toHaveBeenCalled();
  });

  it("sets context when a valid token is present", async () => {
    const token = await createJWT(
      {
        sub: "user-001",
        role: "user",
        neighborhood_id: "nb-001",
        verification_status: "verified",
        scope: "full",
      },
      mockEnv.JWT_SECRET,
      24,
    );
    const ctx = createMockContext({
      authHeader: `Bearer ${token}`,
      env: mockEnv,
    });
    const next = vi.fn();
    await optionalAuthMiddleware(ctx, next);
    expect(next).toHaveBeenCalled();
    expect(ctx.set).toHaveBeenCalled();
  });

  it("passes through without setting context when token is invalid", async () => {
    const ctx = createMockContext({
      authHeader: "Bearer bad.token",
      env: mockEnv,
    });
    const next = vi.fn();
    await optionalAuthMiddleware(ctx, next);
    expect(next).toHaveBeenCalled();
    expect(ctx.set).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("requireVerified", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes for a verified user with full scope", async () => {
    const ctx = createMockContext({
      auth: makeAuth({ verificationStatus: "verified", scope: "full" }),
    });
    const next = vi.fn();
    await requireVerified(ctx, next);
    expect(next).toHaveBeenCalled();
  });

  it("returns 403 VERIFICATION_REQUIRED for an unverified user", async () => {
    const ctx = createMockContext({
      auth: makeAuth({ verificationStatus: "unverified" }),
    });
    const next = vi.fn();

    const res = assertBlocked(await requireVerified(ctx, next));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
    expect(res.json.error?.code).toBe("VERIFICATION_REQUIRED");
  });

  it("returns 403 VERIFICATION_REQUIRED for a pending user", async () => {
    const ctx = createMockContext({
      auth: makeAuth({ verificationStatus: "pending" }),
    });
    const next = vi.fn();

    const res = assertBlocked(await requireVerified(ctx, next));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
    expect(res.json.error?.code).toBe("VERIFICATION_REQUIRED");
  });

  it("returns 403 VERIFICATION_TOKEN_RESTRICTED for a verification_only token", async () => {
    const ctx = createMockContext({
      auth: makeAuth({
        verificationStatus: "unverified",
        scope: "verification_only",
      }),
    });
    const next = vi.fn();

    const res = assertBlocked(await requireVerified(ctx, next));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
    expect(res.json.error?.code).toBe("VERIFICATION_TOKEN_RESTRICTED");
  });

  it("returns 401 when auth context is missing entirely", async () => {
    const ctx = createMockContext();
    const next = vi.fn();

    const res = assertBlocked(await requireVerified(ctx, next));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("requireModerator", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes for a moderator", async () => {
    const ctx = createMockContext({
      auth: makeAuth({ userRole: "moderator" }),
    });
    const next = vi.fn();
    await requireModerator(ctx, next);
    expect(next).toHaveBeenCalled();
  });

  it("passes for an admin", async () => {
    const ctx = createMockContext({ auth: makeAuth({ userRole: "admin" }) });
    const next = vi.fn();
    await requireModerator(ctx, next);
    expect(next).toHaveBeenCalled();
  });

  it("returns 403 INSUFFICIENT_PERMISSIONS for a regular user", async () => {
    const ctx = createMockContext({ auth: makeAuth({ userRole: "user" }) });
    const next = vi.fn();

    const res = assertBlocked(await requireModerator(ctx, next));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
    expect(res.json.error?.code).toBe("INSUFFICIENT_PERMISSIONS");
  });

  it("returns 401 when auth context is missing", async () => {
    const ctx = createMockContext();
    const next = vi.fn();

    const res = assertBlocked(await requireModerator(ctx, next));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("requireAdmin", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes for an admin", async () => {
    const ctx = createMockContext({ auth: makeAuth({ userRole: "admin" }) });
    const next = vi.fn();
    await requireAdmin(ctx, next);
    expect(next).toHaveBeenCalled();
  });

  it("returns 403 for a moderator", async () => {
    const ctx = createMockContext({
      auth: makeAuth({ userRole: "moderator" }),
    });
    const next = vi.fn();
    const res = assertBlocked(await requireAdmin(ctx, next));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
  });

  it("returns 403 for a regular user", async () => {
    const ctx = createMockContext({ auth: makeAuth({ userRole: "user" }) });
    const next = vi.fn();
    const res = assertBlocked(await requireAdmin(ctx, next));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("requireNeighborhood", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes when neighborhoodId is set", async () => {
    const ctx = createMockContext({
      auth: makeAuth({ neighborhoodId: "nb-001" }),
    });
    const next = vi.fn();
    await requireNeighborhood(ctx, next);
    expect(next).toHaveBeenCalled();
  });

  it("returns 400 NEIGHBORHOOD_REQUIRED when neighborhoodId is null", async () => {
    const ctx = createMockContext({ auth: makeAuth({ neighborhoodId: null }) });
    const next = vi.fn();

    const res = assertBlocked(await requireNeighborhood(ctx, next));

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe("NEIGHBORHOOD_REQUIRED");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("getAuthContext", () => {
  it("returns the auth context when present", () => {
    const auth = makeAuth();
    expect(getAuthContext(createMockContext({ auth }))).toEqual(auth);
  });

  it("returns null when no auth is set", () => {
    expect(getAuthContext(createMockContext())).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("canModifyResource", () => {
  it("allows admin to modify any resource", () => {
    expect(
      canModifyResource(
        makeAuth({ userRole: "admin", userId: "admin-001" }),
        "user-999",
      ),
    ).toBe(true);
  });

  it("allows moderator to modify any resource", () => {
    expect(
      canModifyResource(
        makeAuth({ userRole: "moderator", userId: "mod-001" }),
        "user-999",
      ),
    ).toBe(true);
  });

  it("allows a user to modify their own resource", () => {
    expect(
      canModifyResource(makeAuth({ userId: "user-001" }), "user-001"),
    ).toBe(true);
  });

  it("prevents a user from modifying someone else's resource", () => {
    expect(
      canModifyResource(makeAuth({ userId: "user-001" }), "user-002"),
    ).toBe(false);
  });
});
