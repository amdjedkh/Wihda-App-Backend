/**
 * Tests: Contact Form Routes
 *
 * POST /v1/contact — public, no auth, rate limited by IP
 *
 * Calls contact.fetch() directly on the sub-router (same pattern as
 * cleanify.test.ts) so URLs match routes as registered (e.g. "/" not
 * "/v1/contact").
 *
 * What this covers:
 *   ✓ Citizen form — happy path, field validation, missing fields
 *   ✓ Partner form — happy path, field validation, missing fields
 *   ✓ Discriminated union — unknown type rejected
 *   ✓ Rate limiting — 429 when limit exceeded
 *   ✓ Invalid JSON body
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import contact from "../../src/routes/contact";
import { createMockEnv } from "../fixtures";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function req(
  body: unknown,
  options: { ip?: string; rateLimitAllowed?: boolean } = {},
) {
  return new Request("http://localhost:8787/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": options.ip ?? "1.2.3.4",
    },
    body: JSON.stringify(body),
  });
}

function makeStmt(firstVal: unknown = null) {
  return {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(firstVal),
    all: vi.fn().mockResolvedValue({ results: [], success: true }),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
    raw: vi.fn().mockResolvedValue([]),
  };
}

// ─── Valid payloads (match frontend types exactly) ─────────────────────────

const VALID_CITIZEN = {
  type: "citizen",
  name: "Ahmed Benali",
  email: "ahmed@example.dz",
  topic: "feedback",
  message: "Great app, keep it up!",
};

const VALID_PARTNER = {
  type: "partner",
  organization: "Startup DZ",
  contactPerson: "Fatima Zahra",
  email: "fatima@startupDZ.dz",
  proposal: "We would like to partner with Wihda to expand to Oran.",
};

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("POST /v1/contact", () => {
  let mockEnv: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = createMockEnv();

    // Default: rate limit allows the request
    mockEnv.KV.get.mockResolvedValue(null);
    mockEnv.KV.put.mockResolvedValue(undefined);
  });

  // ── Citizen — happy path ────────────────────────────────────────────────

  it("stores a valid citizen submission and returns 201 with id and type", async () => {
    mockEnv.DB.prepare.mockReturnValueOnce(makeStmt()); // INSERT

    const res = await contact.fetch(
      req(VALID_CITIZEN),
      mockEnv as any,
      {} as any,
    );
    const data = (await res.json()) as any;

    expect(res.status).toBe(201);
    expect(data.success).toBe(true);
    expect(data.data.type).toBe("citizen");
    expect(data.data.id).toBeDefined();
    expect(data.data.created_at).toBeDefined();

    // Correct INSERT was called
    const calls = mockEnv.DB.prepare.mock.calls as unknown as string[][];
    expect(calls[0][0]).toContain("'citizen'");
  });

  // ── Citizen — field validation ─────────────────────────────────────────

  it("returns 400 VALIDATION_ERROR when citizen topic is invalid", async () => {
    const res = await contact.fetch(
      req({ ...VALID_CITIZEN, topic: "invalid_topic" }),
      mockEnv as any,
      {} as any,
    );
    const data = (await res.json()) as any;

    expect(res.status).toBe(400);
    expect(data.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 VALIDATION_ERROR when citizen email is malformed", async () => {
    const res = await contact.fetch(
      req({ ...VALID_CITIZEN, email: "not-an-email" }),
      mockEnv as any,
      {} as any,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 VALIDATION_ERROR when citizen message is missing", async () => {
    const { message: _, ...noMessage } = VALID_CITIZEN;
    const res = await contact.fetch(req(noMessage), mockEnv as any, {} as any);

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("VALIDATION_ERROR");
  });

  // ── Partner — happy path ────────────────────────────────────────────────

  it("stores a valid partner submission and returns 201 with id and type", async () => {
    mockEnv.DB.prepare.mockReturnValueOnce(makeStmt()); // INSERT

    const res = await contact.fetch(
      req(VALID_PARTNER),
      mockEnv as any,
      {} as any,
    );
    const data = (await res.json()) as any;

    expect(res.status).toBe(201);
    expect(data.success).toBe(true);
    expect(data.data.type).toBe("partner");
    expect(data.data.id).toBeDefined();

    const calls = mockEnv.DB.prepare.mock.calls as unknown as string[][];
    expect(calls[0][0]).toContain("'partner'");
  });

  // ── Partner — field validation ─────────────────────────────────────────

  it("returns 400 VALIDATION_ERROR when partner organization is missing", async () => {
    const { organization: _, ...noOrg } = VALID_PARTNER;
    const res = await contact.fetch(req(noOrg), mockEnv as any, {} as any);

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 VALIDATION_ERROR when partner contactPerson is missing", async () => {
    const { contactPerson: _, ...noContact } = VALID_PARTNER;
    const res = await contact.fetch(req(noContact), mockEnv as any, {} as any);

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 VALIDATION_ERROR when partner proposal is empty string", async () => {
    const res = await contact.fetch(
      req({ ...VALID_PARTNER, proposal: "" }),
      mockEnv as any,
      {} as any,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("VALIDATION_ERROR");
  });

  // ── Discriminated union ────────────────────────────────────────────────

  it("returns 400 VALIDATION_ERROR for an unknown type", async () => {
    const res = await contact.fetch(
      req({ type: "press", name: "Ali", email: "ali@press.dz" }),
      mockEnv as any,
      {} as any,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 400 VALIDATION_ERROR when type field is missing entirely", async () => {
    const res = await contact.fetch(
      req({ name: "Ali", email: "ali@wihda.dz", message: "hi" }),
      mockEnv as any,
      {} as any,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("VALIDATION_ERROR");
  });

  // ── Rate limiting ──────────────────────────────────────────────────────

  it("returns 429 RATE_LIMIT_EXCEEDED when the IP has exceeded the limit", async () => {
    // Simulate a KV counter that is already at max (5 requests in current window).
    // The mock does not simulate kv.get(key, 'json') auto-parsing, so pass the
    // already-parsed object directly — exactly what the real KV would return.
    const windowStart = Date.now() - 1000; // within current window
    mockEnv.KV.get.mockResolvedValueOnce({ count: 5, windowStart });

    const res = await contact.fetch(
      req(VALID_CITIZEN),
      mockEnv as any,
      {} as any,
    );
    const data = (await res.json()) as any;

    expect(res.status).toBe(429);
    expect(data.error.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(data.error.details.reset_at).toBeDefined();

    // Must NOT hit the DB
    expect(mockEnv.DB.prepare).not.toHaveBeenCalled();
  });

  it("sets X-RateLimit-* response headers", async () => {
    mockEnv.DB.prepare.mockReturnValueOnce(makeStmt());

    const res = await contact.fetch(
      req(VALID_CITIZEN),
      mockEnv as any,
      {} as any,
    );

    expect(res.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(res.headers.get("X-RateLimit-Remaining")).toBeDefined();
    expect(res.headers.get("X-RateLimit-Reset")).toBeDefined();
  });

  // ── Invalid JSON ───────────────────────────────────────────────────────

  it("returns 400 INVALID_JSON for a malformed body", async () => {
    const res = await contact.fetch(
      new Request("http://localhost:8787/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "1.2.3.4",
        },
        body: "this is { not json",
      }),
      mockEnv as any,
      {} as any,
    );

    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe("INVALID_JSON");
  });
});
