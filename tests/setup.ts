/**
 * Test Setup for Wihda Backend
 */

import { beforeAll, afterAll, beforeEach, vi } from "vitest";

// ─── Crypto mock ──────────────────────────────────────────────────────────────
// verifyJWT does: sign → btoa(String.fromCharCode(...new Uint8Array(sig)))
// then on verify: atob(sigB64) → Uint8Array → crypto.subtle.verify()
// The mock signature bytes MUST be ASCII-safe (0–127) so btoa/atob round-trips
// cleanly. Using printable ASCII bytes (65–90 = A–Z) keeps it clean.

let _counter = 0;

// A fixed 32-byte signature using only ASCII-printable values
const MOCK_SIG_BYTES = new Uint8Array(32).map((_, i) => 65 + (i % 26)); // A-Z repeating
const MOCK_SIG_BUFFER = MOCK_SIG_BYTES.buffer;

const mockSubtle = {
  importKey: vi
    .fn()
    .mockResolvedValue({ type: "secret", algorithm: { name: "HMAC" } }),
  sign: vi.fn().mockResolvedValue(MOCK_SIG_BUFFER),
  verify: vi.fn().mockResolvedValue(true),
  digest: vi.fn().mockResolvedValue(new ArrayBuffer(32)),
};

const mockCrypto = {
  randomUUID: vi.fn(
    () =>
      `test-uuid-${String(++_counter).padStart(4, "0")}-xxxx-xxxx-xxxx-xxxxxxxxxxxx`,
  ),
  subtle: mockSubtle,
};

// Install globally — Workers runtime exposes crypto at globalThis.crypto
if (
  !globalThis.crypto ||
  typeof globalThis.crypto.subtle?.importKey !== "function"
) {
  (globalThis as any).crypto = mockCrypto;
}

// ─── Global fetch mock ────────────────────────────────────────────────────────

globalThis.fetch = vi.fn() as any;

// ─── Lifecycle hooks ──────────────────────────────────────────────────────────

const originalConsole = { ...console };

beforeAll(() => {
  // Uncomment to suppress logs during test runs:
  // console.log = vi.fn();
  // console.info = vi.fn();
  // console.warn = vi.fn();
  // console.error = vi.fn();
});

afterAll(() => {
  Object.assign(console, originalConsole);
});

beforeEach(() => {
  vi.clearAllMocks();
  _counter = 0; // reset UUID counter so IDs are deterministic per test
});

export { mockCrypto };
