/**
 * Test Helpers
 *
 * How the test layer works
 * ────────────────────────
 * We have two layers:
 *
 * 1. UNIT / middleware tests (tests/unit/*)
 *    These construct a bare Hono Context mock manually and call middleware
 *    functions directly.  Fast, zero I/O, verify branching logic only.
 *
 * 2. ROUTE tests (tests/routes/*)
 *    These create a real Hono app (same wiring as production) and exercise it
 *    via `app.request(url, init, env)`.  Hono injects `env` as `c.env` so
 *    every route handler runs exactly as it would in the Workers runtime — the
 *    only difference is that D1/R2/KV/Queue are mock objects.
 *
 * This split keeps unit/route tests fast and deterministic.
 */

import { Hono } from "hono";
import { vi } from "vitest";
import type { Env } from "../src/types";
import authRoutes from "../src/routes/auth";
import verificationRoutes from "../src/routes/verification";
import { createMockEnv } from "./fixtures";

// ─── App factory ──────────────────────────────────────────────────────────────

/**
 * Creates a minimal Hono app that mounts only the routes under test.
 * This is intentionally NOT the full app so tests stay isolated.
 */
export function createTestApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/v1/auth", authRoutes);
  app.route("/v1/verification", verificationRoutes);
  return app;
}

// ─── Env factory ──────────────────────────────────────────────────────────────

/**
 * Extends the base mock env with the bindings added by the KYC PR.
 * Import this instead of createMockEnv() in route tests.
 */
export function createTestEnv() {
  return {
    ...createMockEnv(),
    VERIFICATION_QUEUE: {
      send: vi.fn().mockResolvedValue(undefined),
      sendBatch: vi.fn().mockResolvedValue(undefined),
    },
    GEMINI_API_KEY: "test-gemini-api-key",
    INTERNAL_WEBHOOK_SECRET: "test-internal-secret",
  };
}

export type TestEnv = ReturnType<typeof createTestEnv>;

// ─── Mock DB seeding helpers ───────────────────────────────────────────────────

/**
 * Tells the mock D1 what to return for the NEXT call to .first().
 * Each call to mockFirstOnce consumes one queued response in order.
 *
 * Usage:
 *   mockFirstOnce(env, null);          // next first() → null (not found)
 *   mockFirstOnce(env, { id: 'x' });  // next first() → the row
 */
export function mockFirstOnce(env: TestEnv, value: unknown) {
  const stmt = createMockStatement(value);
  (env.DB.prepare as ReturnType<typeof vi.fn>).mockReturnValueOnce(stmt);
}

/**
 * Tells the mock D1 what to return for the NEXT call to .run().
 */
export function mockRunOnce(env: TestEnv) {
  const stmt = createMockStatement(null);
  (env.DB.prepare as ReturnType<typeof vi.fn>).mockReturnValueOnce(stmt);
}

function createMockStatement(firstValue: unknown) {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(firstValue),
    all: vi.fn().mockResolvedValue({ results: [], success: true }),
    run: vi.fn().mockResolvedValue({ success: true, meta: {} }),
    raw: vi.fn().mockResolvedValue([]),
  };
  return stmt;
}
