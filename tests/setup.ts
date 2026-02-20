/**
 * Test Setup for Wihda Backend
 * Configures test environment, mocks, and fixtures
 */

import { beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Mock Web Crypto API for tests
const mockCrypto = {
  randomUUID: () => 'test-uuid-' + Math.random().toString(36).substr(2, 9),
  subtle: {
    digest: async (algorithm: string, data: BufferSource) => {
      // Simple mock - in real tests use actual crypto
      const buffer = new ArrayBuffer(32);
      return buffer;
    },
  },
};

// Set global crypto if not available
if (!globalThis.crypto) {
  (globalThis as any).crypto = mockCrypto;
}

// Mock fetch globally
global.fetch = vi.fn();

// Console suppression for cleaner test output
const originalConsole = { ...console };
beforeAll(() => {
  // Uncomment to suppress console during tests
  // console.log = vi.fn();
  // console.info = vi.fn();
  // console.warn = vi.fn();
});

afterAll(() => {
  Object.assign(console, originalConsole);
});

// Reset all mocks between tests
beforeEach(() => {
  vi.clearAllMocks();
});

// Export for use in tests
export { mockCrypto };
