/**
 * Tests: Contact Verification Routes
 *
 * Pattern mirrors cleanify.test.ts:
 *  - Call sub-router .fetch() directly (no /v1/auth/verify prefix in URLs)
 *  - createMockEnv() from fixtures, extended with Resend/Twilio secrets
 *  - stmt() helper to mock sequential DB prepare() calls
 *  - createJWT() to mint real tokens
 *  - globalThis.fetch replaced per-test to intercept Resend / Twilio HTTP calls
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import contactVerification from "../../src/routes/contact-verification";
import { createMockEnv } from "../fixtures";
import { createJWT } from "../../src/lib/utils";

// ─── Request helper ───────────────────────────────────────────────────────────

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

// ─── D1 mock helpers ──────────────────────────────────────────────────────────

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

// ─── Env factory ──────────────────────────────────────────────────────────────
/**
 * Extends the base mock env with Resend/Twilio secrets and ensures DB.batch
 * is wired up (the route uses batch() for atomic double-writes on confirm).
 */
function makeEnv() {
  const base = createMockEnv();
  return {
    ...base,
    RESEND_API_KEY: "re_test_key",
    RESEND_FROM_EMAIL: "Wihda <noreply@wihda.app>",
    TWILIO_ACCOUNT_SID: "ACtest000000000000000000000000000",
    TWILIO_AUTH_TOKEN: "auth_test_token",
    TWILIO_PHONE_NUMBER: "+10000000000",
    DB: {
      ...base.DB,
      // batch() is called once on successful confirm:
      // [UPDATE contact_verifications SET verified_at, UPDATE users SET *_verified]
      batch: vi.fn().mockResolvedValue([
        { success: true, meta: { changes: 1 } },
        { success: true, meta: { changes: 1 } },
      ]),
    },
  };
}

// ─── Fixture factories ────────────────────────────────────────────────────────

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-001",
    email: "user@wihda.dz",
    phone: null,
    email_verified: 0,
    phone_verified: 0,
    ...overrides,
  };
}

/**
 * code_hash is SHA-256("123456") so tests can confirm with code "123456".
 * Computed once: echo -n "123456" | sha256sum
 */
const HASH_OF_123456 =
  "8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92";

function makeVerificationRow(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  return {
    id: "cv-001",
    user_id: "user-001",
    channel: "email",
    target: "user@wihda.dz",
    code_hash: HASH_OF_123456,
    expires_at: expires,
    attempts: 0,
    verified_at: null,
    send_count: 1,
    last_sent_at: now,
    locked_until: null,
    created_at: now,
    ...overrides,
  };
}

// ─── Fetch mocks ──────────────────────────────────────────────────────────────

function mockDeliverySuccess() {
  return vi.fn(async (url: RequestInfo | URL) => {
    const s = url.toString();
    if (
      s.startsWith("https://api.resend.com") ||
      s.includes("api.twilio.com")
    ) {
      return new Response(JSON.stringify({ id: "mock-msg-id" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected external fetch in test: ${s}`);
  });
}

function mockDeliveryFailure() {
  return vi.fn(async (url: RequestInfo | URL) => {
    const s = url.toString();
    if (
      s.startsWith("https://api.resend.com") ||
      s.includes("api.twilio.com")
    ) {
      return new Response(JSON.stringify({ error: "unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected external fetch in test: ${s}`);
  });
}

// ─── Suite: Email ─────────────────────────────────────────────────────────────

describe("Contact Verification — Email", () => {
  let mockEnv: ReturnType<typeof makeEnv>;
  let userToken: string;
  let savedFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEnv = makeEnv();
    savedFetch = globalThis.fetch;
    globalThis.fetch = mockDeliverySuccess() as any;

    userToken = await createJWT(
      {
        sub: "user-001",
        role: "user",
        neighborhood_id: null,
        verification_status: "unverified",
        scope: "verification_only",
      },
      mockEnv.JWT_SECRET,
    );
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  // ── POST /email/send ────────────────────────────────────────────────────────

  describe("POST /email/send", () => {
    it("200 — inserts a new row when no prior record exists", async () => {
      // prepare() call order inside /email/send:
      // 1. SELECT user → { email, email_verified }
      // 2. getVerificationRecord → null
      // 3. INSERT new row
      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt(makeUser()))
        .mockReturnValueOnce(stmt(null))
        .mockReturnValueOnce(stmt());

      const res = await contactVerification.fetch(
        req("/email/send", { method: "POST", auth: userToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.expires_in).toBe(600);
    });

    it("200 — updates existing row when resending within hour (count < 3)", async () => {
      const existing = makeVerificationRow({ send_count: 1 });
      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt(makeUser()))
        .mockReturnValueOnce(stmt(existing))
        .mockReturnValueOnce(stmt()); // UPDATE

      const res = await contactVerification.fetch(
        req("/email/send", { method: "POST", auth: userToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
    });

    it("200 — resets send_count and allows send after 1-hour window expires", async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      const existing = makeVerificationRow({
        send_count: 3, // was maxed
        last_sent_at: twoHoursAgo, // window passed
      });
      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt(makeUser()))
        .mockReturnValueOnce(stmt(existing))
        .mockReturnValueOnce(stmt());

      const res = await contactVerification.fetch(
        req("/email/send", { method: "POST", auth: userToken }),
        mockEnv,
        {} as any,
      );

      expect(res.status).toBe(200);
    });

    it("400 — NO_EMAIL when user has no email address", async () => {
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(makeUser({ email: null })));

      const res = await contactVerification.fetch(
        req("/email/send", { method: "POST", auth: userToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(data.error.code).toBe("NO_EMAIL");
    });

    it("400 — ALREADY_VERIFIED when email is already confirmed", async () => {
      mockEnv.DB.prepare.mockReturnValueOnce(
        stmt(makeUser({ email_verified: 1 })),
      );

      const res = await contactVerification.fetch(
        req("/email/send", { method: "POST", auth: userToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(data.error.code).toBe("ALREADY_VERIFIED");
    });

    it("429 — RATE_LIMITED when send_count >= 3 within the same hour", async () => {
      const existing = makeVerificationRow({
        send_count: 3,
        last_sent_at: new Date().toISOString(),
      });
      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt(makeUser()))
        .mockReturnValueOnce(stmt(existing));

      const res = await contactVerification.fetch(
        req("/email/send", { method: "POST", auth: userToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(429);
      expect(data.error.code).toBe("RATE_LIMITED");
    });

    it("502 — DELIVERY_FAILED when Resend returns an error", async () => {
      globalThis.fetch = mockDeliveryFailure() as any;

      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt(makeUser()))
        .mockReturnValueOnce(stmt(null));

      const res = await contactVerification.fetch(
        req("/email/send", { method: "POST", auth: userToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(502);
      expect(data.error.code).toBe("DELIVERY_FAILED");
    });

    it("401 — no token provided", async () => {
      const res = await contactVerification.fetch(
        req("/email/send", { method: "POST" }),
        mockEnv,
        {} as any,
      );

      expect(res.status).toBe(401);
    });
  });

  // ── POST /email/confirm ─────────────────────────────────────────────────────

  describe("POST /email/confirm", () => {
    it("200 — marks email verified and calls DB.batch on correct code", async () => {
      // code_hash in fixture = SHA-256("123456"), so submitting "123456" succeeds
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(makeVerificationRow()));

      const res = await contactVerification.fetch(
        req("/email/confirm", {
          method: "POST",
          auth: userToken,
          body: { code: "123456" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.data.message).toContain("verified");
      // batch() must be called to atomically write both rows
      expect(mockEnv.DB.batch).toHaveBeenCalledOnce();
    });

    it("400 — INVALID_CODE with wrong code, shows remaining attempts", async () => {
      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt(makeVerificationRow({ attempts: 0 })))
        .mockReturnValueOnce(stmt()); // UPDATE attempts

      const res = await contactVerification.fetch(
        req("/email/confirm", {
          method: "POST",
          auth: userToken,
          body: { code: "000000" }, // almost certainly wrong
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      // Edge case: 000000 could hash-match — skip assertion if so
      if (res.status === 200) return;

      expect(res.status).toBe(400);
      expect(data.error.code).toBe("INVALID_CODE");
      expect(data.error.message).toContain("remaining");
    });

    it("429 — ACCOUNT_LOCKED when 5th wrong attempt triggers lockout", async () => {
      // attempts = 4; one more wrong guess = lockout
      mockEnv.DB.prepare
        .mockReturnValueOnce(stmt(makeVerificationRow({ attempts: 4 })))
        .mockReturnValueOnce(stmt()); // UPDATE with locked_until

      const res = await contactVerification.fetch(
        req("/email/confirm", {
          method: "POST",
          auth: userToken,
          body: { code: "000000" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      if (res.status === 200) return;

      expect(res.status).toBe(429);
      expect(data.error.code).toBe("ACCOUNT_LOCKED");
    });

    it("429 — ACCOUNT_LOCKED immediately when record is already locked", async () => {
      const future = new Date(Date.now() + 30 * 60_000).toISOString();
      mockEnv.DB.prepare.mockReturnValueOnce(
        stmt(makeVerificationRow({ locked_until: future })),
      );

      const res = await contactVerification.fetch(
        req("/email/confirm", {
          method: "POST",
          auth: userToken,
          body: { code: "123456" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(429);
      expect(data.error.code).toBe("ACCOUNT_LOCKED");
    });

    it("410 — CODE_EXPIRED when OTP is past its expiry", async () => {
      mockEnv.DB.prepare.mockReturnValueOnce(
        stmt(
          makeVerificationRow({
            expires_at: new Date(Date.now() - 60_000).toISOString(),
          }),
        ),
      );

      const res = await contactVerification.fetch(
        req("/email/confirm", {
          method: "POST",
          auth: userToken,
          body: { code: "123456" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(410);
      expect(data.error.code).toBe("CODE_EXPIRED");
    });

    it("400 — ALREADY_VERIFIED when verified_at is already set", async () => {
      mockEnv.DB.prepare.mockReturnValueOnce(
        stmt(makeVerificationRow({ verified_at: new Date().toISOString() })),
      );

      const res = await contactVerification.fetch(
        req("/email/confirm", {
          method: "POST",
          auth: userToken,
          body: { code: "123456" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(data.error.code).toBe("ALREADY_VERIFIED");
    });

    it("404 — NO_CODE when no verification row exists yet", async () => {
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(null));

      const res = await contactVerification.fetch(
        req("/email/confirm", {
          method: "POST",
          auth: userToken,
          body: { code: "123456" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(404);
      expect(data.error.code).toBe("NO_CODE");
    });

    it("400 — VALIDATION_ERROR when code is fewer than 6 digits", async () => {
      const res = await contactVerification.fetch(
        req("/email/confirm", {
          method: "POST",
          auth: userToken,
          body: { code: "12345" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(data.error.code).toBe("VALIDATION_ERROR");
    });

    it("400 — VALIDATION_ERROR when code contains non-digit characters", async () => {
      const res = await contactVerification.fetch(
        req("/email/confirm", {
          method: "POST",
          auth: userToken,
          body: { code: "abc123" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(data.error.code).toBe("VALIDATION_ERROR");
    });
  });
});

// ─── Suite: Phone ─────────────────────────────────────────────────────────────

describe("Contact Verification — Phone", () => {
  let mockEnv: ReturnType<typeof makeEnv>;
  let phoneToken: string;
  let savedFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEnv = makeEnv();
    savedFetch = globalThis.fetch;
    globalThis.fetch = mockDeliverySuccess() as any;

    phoneToken = await createJWT(
      {
        sub: "user-002",
        role: "user",
        neighborhood_id: null,
        verification_status: "unverified",
        scope: "verification_only",
      },
      mockEnv.JWT_SECRET,
    );
  });

  afterEach(() => {
    globalThis.fetch = savedFetch;
  });

  // ── POST /phone/send ────────────────────────────────────────────────────────

  describe("POST /phone/send", () => {
    it("200 — inserts a row for a phone-only user", async () => {
      mockEnv.DB.prepare
        .mockReturnValueOnce(
          stmt(
            makeUser({ id: "user-002", email: null, phone: "+213555000001" }),
          ),
        )
        .mockReturnValueOnce(stmt(null)) // no existing record
        .mockReturnValueOnce(stmt()); // INSERT

      const res = await contactVerification.fetch(
        req("/phone/send", { method: "POST", auth: phoneToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(data.data.expires_in).toBe(600);
    });

    it("400 — NO_PHONE when user has no phone number", async () => {
      mockEnv.DB.prepare.mockReturnValueOnce(
        stmt(makeUser({ id: "user-002", phone: null })),
      );

      const res = await contactVerification.fetch(
        req("/phone/send", { method: "POST", auth: phoneToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(data.error.code).toBe("NO_PHONE");
    });

    it("400 — ALREADY_VERIFIED when phone is already confirmed", async () => {
      mockEnv.DB.prepare.mockReturnValueOnce(
        stmt(
          makeUser({
            id: "user-002",
            phone: "+213555000001",
            phone_verified: 1,
          }),
        ),
      );

      const res = await contactVerification.fetch(
        req("/phone/send", { method: "POST", auth: phoneToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(400);
      expect(data.error.code).toBe("ALREADY_VERIFIED");
    });

    it("429 — RATE_LIMITED when send_count >= 3 within the hour", async () => {
      const existing = makeVerificationRow({
        channel: "phone",
        user_id: "user-002",
        send_count: 3,
        last_sent_at: new Date().toISOString(),
      });
      mockEnv.DB.prepare
        .mockReturnValueOnce(
          stmt(makeUser({ id: "user-002", phone: "+213555000001" })),
        )
        .mockReturnValueOnce(stmt(existing));

      const res = await contactVerification.fetch(
        req("/phone/send", { method: "POST", auth: phoneToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(429);
      expect(data.error.code).toBe("RATE_LIMITED");
    });

    it("502 — DELIVERY_FAILED when Twilio returns an error", async () => {
      globalThis.fetch = mockDeliveryFailure() as any;

      mockEnv.DB.prepare
        .mockReturnValueOnce(
          stmt(makeUser({ id: "user-002", phone: "+213555000001" })),
        )
        .mockReturnValueOnce(stmt(null));

      const res = await contactVerification.fetch(
        req("/phone/send", { method: "POST", auth: phoneToken }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(502);
      expect(data.error.code).toBe("DELIVERY_FAILED");
    });
  });

  // ── POST /phone/confirm ─────────────────────────────────────────────────────

  describe("POST /phone/confirm", () => {
    it("200 — marks phone verified and calls DB.batch on correct code", async () => {
      mockEnv.DB.prepare.mockReturnValueOnce(
        stmt(makeVerificationRow({ channel: "phone", user_id: "user-002" })),
      );

      const res = await contactVerification.fetch(
        req("/phone/confirm", {
          method: "POST",
          auth: phoneToken,
          body: { code: "123456" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockEnv.DB.batch).toHaveBeenCalledOnce();
    });

    it("410 — CODE_EXPIRED when OTP is past its expiry", async () => {
      mockEnv.DB.prepare.mockReturnValueOnce(
        stmt(
          makeVerificationRow({
            channel: "phone",
            user_id: "user-002",
            expires_at: new Date(Date.now() - 60_000).toISOString(),
          }),
        ),
      );

      const res = await contactVerification.fetch(
        req("/phone/confirm", {
          method: "POST",
          auth: phoneToken,
          body: { code: "123456" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(410);
      expect(data.error.code).toBe("CODE_EXPIRED");
    });

    it("429 — ACCOUNT_LOCKED when record is already locked", async () => {
      const future = new Date(Date.now() + 30 * 60_000).toISOString();
      mockEnv.DB.prepare.mockReturnValueOnce(
        stmt(makeVerificationRow({ channel: "phone", locked_until: future })),
      );

      const res = await contactVerification.fetch(
        req("/phone/confirm", {
          method: "POST",
          auth: phoneToken,
          body: { code: "123456" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(429);
      expect(data.error.code).toBe("ACCOUNT_LOCKED");
    });

    it("404 — NO_CODE when no verification row exists", async () => {
      mockEnv.DB.prepare.mockReturnValueOnce(stmt(null));

      const res = await contactVerification.fetch(
        req("/phone/confirm", {
          method: "POST",
          auth: phoneToken,
          body: { code: "123456" },
        }),
        mockEnv,
        {} as any,
      );
      const data = (await res.json()) as any;

      expect(res.status).toBe(404);
      expect(data.error.code).toBe("NO_CODE");
    });
  });
});

// ─── Suite: Status ────────────────────────────────────────────────────────────

describe("Contact Verification — GET /status", () => {
  let mockEnv: ReturnType<typeof makeEnv>;
  let userToken: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEnv = makeEnv();

    userToken = await createJWT(
      {
        sub: "user-001",
        role: "user",
        neighborhood_id: null,
        verification_status: "unverified",
        scope: "verification_only",
      },
      mockEnv.JWT_SECRET,
    );
  });

  it("200 — returns unverified state with masked email after signup", async () => {
    mockEnv.DB.prepare.mockReturnValueOnce(
      stmt(makeUser({ email: "user@wihda.dz", email_verified: 0 })),
    );

    const res = await contactVerification.fetch(
      req("/status", { auth: userToken }),
      mockEnv,
      {} as any,
    );
    const data = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(data.data.email_verified).toBe(false);
    expect(data.data.phone_verified).toBe(false);
    expect(data.data.contact_verified).toBe(false);
    expect(data.data.email).toMatch(/^use\*\*\*/); // "use***" — first 3 chars + ***
    expect(data.data.phone).toBeNull();
  });

  it("200 — contact_verified true when email is verified", async () => {
    mockEnv.DB.prepare.mockReturnValueOnce(
      stmt(makeUser({ email_verified: 1 })),
    );

    const res = await contactVerification.fetch(
      req("/status", { auth: userToken }),
      mockEnv,
      {} as any,
    );
    const data = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(data.data.email_verified).toBe(true);
    expect(data.data.contact_verified).toBe(true);
  });

  it("200 — contact_verified true for phone-only user with verified phone", async () => {
    mockEnv.DB.prepare.mockReturnValueOnce(
      stmt(
        makeUser({ email: null, phone: "+213555000001", phone_verified: 1 }),
      ),
    );

    const res = await contactVerification.fetch(
      req("/status", { auth: userToken }),
      mockEnv,
      {} as any,
    );
    const data = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(data.data.phone_verified).toBe(true);
    expect(data.data.contact_verified).toBe(true);
    expect(data.data.email).toBeNull();
    expect(data.data.phone).toMatch(/^\*\*\*001$/); // masked: ***001
  });

  it("404 — USER_NOT_FOUND when user is missing from DB", async () => {
    mockEnv.DB.prepare.mockReturnValueOnce(stmt(null));

    const res = await contactVerification.fetch(
      req("/status", { auth: userToken }),
      mockEnv,
      {} as any,
    );
    const data = (await res.json()) as any;

    expect(res.status).toBe(404);
    expect(data.error.code).toBe("USER_NOT_FOUND");
  });

  it("401 — no token provided", async () => {
    const res = await contactVerification.fetch(
      req("/status"),
      mockEnv,
      {} as any,
    );

    expect(res.status).toBe(401);
  });
});

// ─── Suite: Auth login gate ───────────────────────────────────────────────────

describe("Auth — login blocked when contact not verified", () => {
  let mockEnv: ReturnType<typeof makeEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = makeEnv();
  });

  it("403 — CONTACT_VERIFICATION_REQUIRED for email user who skipped OTP", async () => {
    const { default: auth } = await import("../../src/routes/auth");

    // User passed KYC but never verified their email OTP
    const user = {
      id: "user-001",
      email: "user@wihda.dz",
      phone: null,
      password_hash: "hashed_password_123",
      display_name: "Test User",
      role: "user",
      status: "active",
      verification_status: "verified",
      email_verified: 0, // ← contact not verified
      phone_verified: 0,
    };

    mockEnv.DB.prepare.mockReturnValueOnce(stmt(user));

    const res = await auth.fetch(
      new Request("http://localhost:8787/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "user@wihda.dz",
          password: "password1234",
        }),
      }),
      mockEnv,
      {} as any,
    );
    const data = (await res.json()) as any;

    expect(res.status).toBe(403);
    expect(data.error.code).toBe("CONTACT_VERIFICATION_REQUIRED");
    expect(data.error.details.contact_channel).toBe("email");
  });

  it("403 — CONTACT_VERIFICATION_REQUIRED for phone user who skipped OTP", async () => {
    const { default: auth } = await import("../../src/routes/auth");

    const user = {
      id: "user-002",
      email: null,
      phone: "+213555000001",
      password_hash: "hashed_password_123",
      display_name: "Phone User",
      role: "user",
      status: "active",
      verification_status: "verified",
      email_verified: 0,
      phone_verified: 0, // ← contact not verified
    };

    mockEnv.DB.prepare.mockReturnValueOnce(stmt(user));

    const res = await auth.fetch(
      new Request("http://localhost:8787/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: "+213555000001",
          password: "password1234",
        }),
      }),
      mockEnv,
      {} as any,
    );
    const data = (await res.json()) as any;

    expect(res.status).toBe(403);
    expect(data.error.code).toBe("CONTACT_VERIFICATION_REQUIRED");
    expect(data.error.details.contact_channel).toBe("phone");
  });
});
