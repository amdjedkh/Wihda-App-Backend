/**
 * Tests for Rate Limiting Utilities
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkRateLimit,
  RATE_LIMITS,
  checkPairRepetition,
  recordMatchHistory,
  checkAbuseFlag,
  setAbuseFlag,
  clearAbuseFlag,
} from '../../src/lib/rate-limit';
import { createMockKVNamespace, createMockD1Database } from '../fixtures';

describe('Rate Limiting', () => {
  let mockKv: ReturnType<typeof createMockKVNamespace>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockKv = createMockKVNamespace();
  });

  describe('checkRateLimit', () => {
    it('should allow request under limit', async () => {
      mockKv.get.mockResolvedValue(null);

      const result = await checkRateLimit(mockKv as any, 'user-001', RATE_LIMITS.login);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4); // 5 - 1
    });

    it('should increment counter for same window', async () => {
      const now = Date.now();
      mockKv.get.mockResolvedValue({ count: 2, windowStart: now - 1000 });

      const result = await checkRateLimit(mockKv as any, 'user-001', RATE_LIMITS.login);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2); // 5 - 3
    });

    it('should block request over limit', async () => {
      const now = Date.now();
      mockKv.get.mockResolvedValue({ count: 5, windowStart: now - 1000 });

      const result = await checkRateLimit(mockKv as any, 'user-001', RATE_LIMITS.login);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should reset counter for new window', async () => {
      const oldWindow = Date.now() - RATE_LIMITS.login.windowMs - 1000;
      mockKv.get.mockResolvedValue({ count: 10, windowStart: oldWindow });

      const result = await checkRateLimit(mockKv as any, 'user-001', RATE_LIMITS.login);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
    });

    it('should store updated counter', async () => {
      mockKv.get.mockResolvedValue(null);

      await checkRateLimit(mockKv as any, 'user-001', RATE_LIMITS.login);

      expect(mockKv.put).toHaveBeenCalledWith(
        'rl:login:user-001',
        expect.any(String),
        expect.objectContaining({ expirationTtl: expect.any(Number) })
      );
    });
  });

  describe('RATE_LIMITS configuration', () => {
    it('should have correct login limits', () => {
      expect(RATE_LIMITS.login.windowMs).toBe(60000);
      expect(RATE_LIMITS.login.maxRequests).toBe(5);
    });

    it('should have correct signup limits', () => {
      expect(RATE_LIMITS.signup.windowMs).toBe(3600000);
      expect(RATE_LIMITS.signup.maxRequests).toBe(3);
    });

    it('should have correct offer limits', () => {
      expect(RATE_LIMITS.createOffer.windowMs).toBe(86400000);
      expect(RATE_LIMITS.createOffer.maxRequests).toBe(10);
    });

    it('should have correct chat limits', () => {
      expect(RATE_LIMITS.sendMessage.windowMs).toBe(60000);
      expect(RATE_LIMITS.sendMessage.maxRequests).toBe(10);
    });
  });

  describe('checkPairRepetition', () => {
    let mockDb: ReturnType<typeof createMockD1Database>;

    beforeEach(() => {
      mockDb = createMockD1Database();
    });

    it('should return count and flagged status', async () => {
      mockDb.first.mockResolvedValue({ count: 3 });

      const result = await checkPairRepetition(mockDb as any, 'user-001', 'user-002');

      expect(result.count).toBe(3);
      expect(result.flagged).toBe(false);
    });

    it('should flag pairs with too many matches', async () => {
      mockDb.first.mockResolvedValue({ count: 5 });

      const result = await checkPairRepetition(mockDb as any, 'user-001', 'user-002');

      expect(result.count).toBe(5);
      expect(result.flagged).toBe(true);
    });

    it('should use custom days window', async () => {
      mockDb.first.mockResolvedValue({ count: 0 });

      await checkPairRepetition(mockDb as any, 'user-001', 'user-002', 14);

      expect(mockDb.bind).toHaveBeenCalledWith(
        'user-001', 'user-002', 'user-002', 'user-001', 14
      );
    });
  });

  describe('recordMatchHistory', () => {
    let mockDb: ReturnType<typeof createMockD1Database>;

    beforeEach(() => {
      mockDb = createMockD1Database();
    });

    it('should record match in history', async () => {
      mockDb.run.mockResolvedValue({ success: true });

      await recordMatchHistory(mockDb as any, 'match-001', 'user-001', 'user-002', true);

      expect(mockDb.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO match_history')
      );
    });

    it('should order user IDs consistently', async () => {
      mockDb.run.mockResolvedValue({ success: true });

      // Record with IDs in different order
      await recordMatchHistory(mockDb as any, 'match-001', 'user-002', 'user-001', true);

      // user-001 should always be first (alphabetically)
      expect(mockDb.bind).toHaveBeenCalledWith(
        expect.any(String),
        'user-001',
        'user-002',
        expect.any(String),
        expect.any(String),
        expect.any(Number),
        expect.any(String)
      );
    });
  });

  describe('Abuse Flags', () => {
    it('should check abuse flag', async () => {
      mockKv.get.mockResolvedValue({
        reason: 'Suspicious activity',
        flagged_at: new Date().toISOString(),
      });

      const result = await checkAbuseFlag(mockKv as any, 'user-001');

      expect(result.flagged).toBe(true);
      expect(result.reason).toBe('Suspicious activity');
    });

    it('should return not flagged for no flag', async () => {
      mockKv.get.mockResolvedValue(null);

      const result = await checkAbuseFlag(mockKv as any, 'user-001');

      expect(result.flagged).toBe(false);
    });

    it('should set abuse flag', async () => {
      await setAbuseFlag(mockKv as any, 'user-001', 'Rate limit abuse');

      expect(mockKv.put).toHaveBeenCalledWith(
        'abuse:user-001',
        expect.stringContaining('Rate limit abuse'),
        expect.objectContaining({ expirationTtl: 86400 })
      );
    });

    it('should set abuse flag with custom TTL', async () => {
      await setAbuseFlag(mockKv as any, 'user-001', 'Test', 3600);

      expect(mockKv.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ expirationTtl: 3600 })
      );
    });

    it('should clear abuse flag', async () => {
      await clearAbuseFlag(mockKv as any, 'user-001');

      expect(mockKv.delete).toHaveBeenCalledWith('abuse:user-001');
    });
  });
});
