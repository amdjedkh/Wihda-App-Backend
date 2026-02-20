/**
 * Tests for Leftovers Routes
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import leftovers from '../../src/routes/leftovers';
import { createMockEnv, testUsers, testOffers, testNeeds, testMatches } from '../fixtures';
import { hashPassword, createJWT } from '../../src/lib/utils';

// Helper to create test request
function createRequest(path: string, options: {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
} = {}) {
  const url = `http://localhost:8787${path}`;
  return new Request(url, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

describe('Leftovers Routes', () => {
  let mockEnv: ReturnType<typeof createMockEnv>;
  let accessToken: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEnv = createMockEnv();
    accessToken = await createJWT(
      { sub: 'user-003', role: 'user', neighborhood_id: 'nb-001' },
      mockEnv.JWT_SECRET,
      24
    );
  });

  describe('POST /offers', () => {
    it('should create a new leftover offer', async () => {
      mockEnv.DB.first.mockResolvedValueOnce({
        id: 'un-001',
        neighborhood_id: 'nb-001',
      }); // getUserNeighborhood
      mockEnv.DB.run.mockResolvedValue({ success: true });
      mockEnv.DB.first.mockResolvedValue(testOffers[0]);

      const req = createRequest('/offers', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: {
          title: 'Homemade Couscous',
          description: 'Fresh couscous for 4 people',
          survey: {
            food_type: 'cooked_meal',
            diet_constraints: ['halal'],
            portions: 4,
            pickup_time_preference: 'evening',
            distance_willing_km: 3,
          },
          quantity: 1,
          expiry_hours: 24,
        },
      });

      const res = await leftovers.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).success).toBe(true);
    });

    it('should reject offer creation without neighborhood', async () => {
      mockEnv.DB.first.mockResolvedValueOnce(null); // No neighborhood

      const token = await createJWT(
        { sub: 'user-003', role: 'user', neighborhood_id: null },
        mockEnv.JWT_SECRET,
        24
      );

      const req = createRequest('/offers', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: {
          title: 'Test Offer',
          survey: {
            food_type: 'cooked_meal',
            diet_constraints: [],
            portions: 2,
            pickup_time_preference: 'evening',
            distance_willing_km: 3,
          },
        },
      });

      const res = await leftovers.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect((data as any).error.code).toBe('NO_NEIGHBORHOOD');
    });

    it('should reject unauthenticated request', async () => {
      const req = createRequest('/offers', {
        method: 'POST',
        body: { title: 'Test' },
      });

      const res = await leftovers.fetch(req, mockEnv, {} as any);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /offers', () => {
    it('should return list of offers', async () => {
      mockEnv.DB.first.mockResolvedValueOnce({ neighborhood_id: 'nb-001' });
      mockEnv.DB.all.mockResolvedValue({ results: testOffers });

      const req = createRequest('/offers', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const res = await leftovers.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).success).toBe(true);
      expect((data as any).data.offers).toBeDefined();
    });

    it('should filter by status', async () => {
      mockEnv.DB.first.mockResolvedValueOnce({ neighborhood_id: 'nb-001' });
      mockEnv.DB.all.mockResolvedValue({ results: testOffers.filter(o => o.status === 'active') });

      const req = createRequest('/offers?status=active', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const res = await leftovers.fetch(req, mockEnv, {} as any);
      expect(res.status).toBe(200);
    });
  });

  describe('POST /needs', () => {
    it('should create a new leftover need', async () => {
      mockEnv.DB.first.mockResolvedValueOnce({ neighborhood_id: 'nb-001' });
      mockEnv.DB.run.mockResolvedValue({ success: true });
      mockEnv.DB.first.mockResolvedValue(testNeeds[0]);

      const req = createRequest('/needs', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: {
          survey: {
            food_type: 'cooked_meal',
            diet_constraints: ['halal'],
            portions: 2,
            pickup_time_preference: 'evening',
            distance_willing_km: 3,
          },
          urgency: 'normal',
        },
      });

      const res = await leftovers.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).success).toBe(true);
    });
  });

  describe('GET /needs', () => {
    it('should return list of needs', async () => {
      mockEnv.DB.first.mockResolvedValueOnce({ neighborhood_id: 'nb-001' });
      mockEnv.DB.all.mockResolvedValue({ results: testNeeds });

      const req = createRequest('/needs', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const res = await leftovers.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).success).toBe(true);
      expect((data as any).data.needs).toBeDefined();
    });
  });

  describe('GET /matches', () => {
    it('should return user matches', async () => {
      mockEnv.DB.all.mockResolvedValue({ results: testMatches });

      const req = createRequest('/matches', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const res = await leftovers.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).success).toBe(true);
      expect((data as any).data.matches).toBeDefined();
    });
  });

  describe('POST /matches/:id/close', () => {
    it('should close a match as successful', async () => {
      mockEnv.DB.first.mockResolvedValueOnce({
        ...testMatches[0],
        offer_user_id: 'user-003',
        need_user_id: 'user-004',
      });
      mockEnv.DB.run.mockResolvedValue({ success: true });
      mockEnv.DB.first.mockResolvedValue({
        ...testMatches[0],
        offer_user_id: 'user-003',
        need_user_id: 'user-004',
        status: 'closed',
        closure_type: 'successful',
      });

      const req = createRequest('/matches/match-001/close', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: {
          closure_type: 'successful',
        },
      });

      const res = await leftovers.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).success).toBe(true);
    });

    it('should close a match as cancelled', async () => {
      mockEnv.DB.first.mockResolvedValue({
        ...testMatches[0],
        offer_user_id: 'user-003',
        need_user_id: 'user-004',
      });
      mockEnv.DB.run.mockResolvedValue({ success: true });

      const req = createRequest('/matches/match-001/close', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: {
          closure_type: 'cancelled',
        },
      });

      const res = await leftovers.fetch(req, mockEnv, {} as any);
      expect(res.status).toBe(200);
    });

    it('should reject closing non-existent match', async () => {
      mockEnv.DB.first.mockResolvedValue(null);

      const req = createRequest('/matches/nonexistent/close', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: {
          closure_type: 'successful',
        },
      });

      const res = await leftovers.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(404);
      expect((data as any).error.code).toBe('NOT_FOUND');
    });

    it('should reject closing by non-participant', async () => {
      mockEnv.DB.first.mockResolvedValue({
        ...testMatches[0],
        offer_user_id: 'user-001',
        need_user_id: 'user-002',
      });

      const req = createRequest('/matches/match-001/close', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: {
          closure_type: 'successful',
        },
      });

      const res = await leftovers.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(403);
      expect((data as any).error.code).toBe('FORBIDDEN');
    });
  });
});
