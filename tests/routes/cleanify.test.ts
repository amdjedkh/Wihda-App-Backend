/**
 * Tests for Cleanify Routes
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import cleanify from '../../src/routes/cleanify';
import { createMockEnv, testUsers, testSubmissions } from '../fixtures';
import { createJWT } from '../../src/lib/utils';

function createRequest(path: string, options: {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
} = {}) {
  const url = `http://localhost:8787/v1/cleanify${path}`;
  return new Request(url, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

describe('Cleanify Routes', () => {
  let mockEnv: ReturnType<typeof createMockEnv>;
  let userToken: string;
  let moderatorToken: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEnv = createMockEnv();
    userToken = await createJWT(
      { sub: 'user-003', role: 'user', neighborhood_id: 'nb-001' },
      mockEnv.JWT_SECRET,
      24
    );
    moderatorToken = await createJWT(
      { sub: 'user-002', role: 'moderator', neighborhood_id: 'nb-001' },
      mockEnv.JWT_SECRET,
      24
    );
  });

  describe('POST /submissions', () => {
    it('should create a new cleanify submission', async () => {
      mockEnv.DB.first.mockResolvedValueOnce({ neighborhood_id: 'nb-001' });
      mockEnv.DB.run.mockResolvedValue({ success: true });
      mockEnv.DB.first.mockResolvedValue(testSubmissions[0]);

      const req = createRequest('/submissions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${userToken}` },
        body: {
          before_photo_url: 'https://example.com/before.jpg',
          after_photo_url: 'https://example.com/after.jpg',
          description: 'Cleaned the park',
        },
      });

      const res = await cleanify.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).success).toBe(true);
    });

    it('should reject submission without neighborhood', async () => {
      mockEnv.DB.first.mockResolvedValueOnce(null);

      const token = await createJWT(
        { sub: 'user-003', role: 'user', neighborhood_id: null },
        mockEnv.JWT_SECRET,
        24
      );

      const req = createRequest('/submissions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: {
          before_photo_url: 'https://example.com/before.jpg',
          after_photo_url: 'https://example.com/after.jpg',
        },
      });

      const res = await cleanify.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect((data as any).error.code).toBe('NEIGHBORHOOD_REQUIRED');
    });

    it('should require before and after photos', async () => {
      mockEnv.DB.first.mockResolvedValueOnce({ neighborhood_id: 'nb-001' });

      const req = createRequest('/submissions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${userToken}` },
        body: {
          before_photo_url: 'https://example.com/before.jpg',
          // Missing after_photo_url
        },
      });

      const res = await cleanify.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect((data as any).error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject unauthenticated request', async () => {
      const req = createRequest('/submissions', {
        method: 'POST',
        body: {
          before_photo_url: 'https://example.com/before.jpg',
          after_photo_url: 'https://example.com/after.jpg',
        },
      });

      const res = await cleanify.fetch(req, mockEnv, {} as any);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /submissions', () => {
    it('should return user submissions', async () => {
      mockEnv.DB.all.mockResolvedValue({ results: testSubmissions });

      const req = createRequest('/submissions?mine=true', {
        headers: { Authorization: `Bearer ${userToken}` },
      });

      const res = await cleanify.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).success).toBe(true);
      expect((data as any).data.submissions).toBeDefined();
    });

    it('should return pending submissions for moderator', async () => {
      mockEnv.DB.all.mockResolvedValue({ results: testSubmissions.filter(s => s.status === 'pending') });

      const req = createRequest('/submissions?pending=true', {
        headers: { Authorization: `Bearer ${moderatorToken}` },
      });

      const res = await cleanify.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(200);
    });
  });

  describe('POST /submissions/:id/approve', () => {
    it('should approve submission as moderator', async () => {
      mockEnv.DB.first.mockResolvedValue(testSubmissions[0]); // Pending submission
      mockEnv.DB.first.mockResolvedValue(testUsers[0]); // User
      mockEnv.DB.run.mockResolvedValue({ success: true });
      mockEnv.DB.first.mockResolvedValue({
        ...testSubmissions[0],
        status: 'approved',
        coins_awarded: 150,
      });

      const req = createRequest('/submissions/sub-001/approve', {
        method: 'POST',
        headers: { Authorization: `Bearer ${moderatorToken}` },
        body: {
          note: 'Great job!',
        },
      });

      const res = await cleanify.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).success).toBe(true);
    });

    it('should reject non-moderator approval', async () => {
      mockEnv.DB.first.mockResolvedValue(testSubmissions[0]);

      const req = createRequest('/submissions/sub-001/approve', {
        method: 'POST',
        headers: { Authorization: `Bearer ${userToken}` },
        body: { note: 'Test' },
      });

      const res = await cleanify.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(403);
      expect((data as any).error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('should reject approving already reviewed submission', async () => {
      mockEnv.DB.first.mockResolvedValue(testSubmissions[1]); // Already approved

      const req = createRequest('/submissions/sub-002/approve', {
        method: 'POST',
        headers: { Authorization: `Bearer ${moderatorToken}` },
        body: { note: 'Test' },
      });

      const res = await cleanify.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect((data as any).error.code).toBe('ALREADY_REVIEWED');
    });

    it('should reject approving non-existent submission', async () => {
      mockEnv.DB.first.mockResolvedValue(null);

      const req = createRequest('/submissions/nonexistent/approve', {
        method: 'POST',
        headers: { Authorization: `Bearer ${moderatorToken}` },
        body: { note: 'Test' },
      });

      const res = await cleanify.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(404);
      expect((data as any).error.code).toBe('SUBMISSION_NOT_FOUND');
    });
  });

  describe('POST /submissions/:id/reject', () => {
    it('should reject submission as moderator', async () => {
      mockEnv.DB.first.mockResolvedValue(testSubmissions[0]); // Pending submission
      mockEnv.DB.run.mockResolvedValue({ success: true });

      const req = createRequest('/submissions/sub-001/reject', {
        method: 'POST',
        headers: { Authorization: `Bearer ${moderatorToken}` },
        body: {
          note: 'Photos do not show the same location',
        },
      });

      const res = await cleanify.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).success).toBe(true);
    });

    it('should require rejection note', async () => {
      mockEnv.DB.first.mockResolvedValue(testSubmissions[0]);

      const req = createRequest('/submissions/sub-001/reject', {
        method: 'POST',
        headers: { Authorization: `Bearer ${moderatorToken}` },
        body: {}, // No note
      });

      const res = await cleanify.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(400);
    });
  });

  describe('GET /stats', () => {
    it('should return cleanify statistics', async () => {
      mockEnv.DB.first.mockResolvedValueOnce({ neighborhood_id: 'nb-001' });
      mockEnv.DB.first.mockResolvedValueOnce({ total: 10, approved: 7, pending: 2, rejected: 1 });
      mockEnv.DB.first.mockResolvedValueOnce({ total: 5, coins: 750 });

      const req = createRequest('/stats', {
        headers: { Authorization: `Bearer ${userToken}` },
      });

      const res = await cleanify.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).success).toBe(true);
    });
  });
});
