/**
 * Integration Tests for Main App Entry Point
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import app from '../../src/index';
import { createMockEnv, testUsers } from '../fixtures';
import { hashPassword, createJWT } from '../../src/lib/utils';

describe('Main App', () => {
  let mockEnv: ReturnType<typeof createMockEnv>;
  let hashedPassword: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEnv = createMockEnv();
    hashedPassword = await hashPassword('password123');
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const req = new Request('http://localhost:8787/health');
      
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).status).toBe('ok');
      expect((data as any).service).toBe('wihda-backend');
    });
  });

  describe('GET /v1', () => {
    it('should return API info', async () => {
      const req = new Request('http://localhost:8787/v1');
      
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).name).toBe('Wihda API');
      expect((data as any).endpoints).toBeDefined();
    });
  });

  describe('GET /openapi.json', () => {
    it('should return OpenAPI spec', async () => {
      const req = new Request('http://localhost:8787/openapi.json');
      
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).openapi).toBe('3.0.0');
      expect((data as any).info.title).toBe('Wihda API');
    });
  });

  describe('404 Handler', () => {
    it('should return 404 for unknown routes', async () => {
      const req = new Request('http://localhost:8787/unknown-route');
      
      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(404);
      expect((data as any).error.code).toBe('NOT_FOUND');
    });
  });

  describe('CORS', () => {
    it('should include CORS headers', async () => {
      const req = new Request('http://localhost:8787/health');
      
      const res = await app.fetch(req, mockEnv);

      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('should handle OPTIONS preflight', async () => {
      const req = new Request('http://localhost:8787/v1/auth/login', {
        method: 'OPTIONS',
        headers: {
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type, Authorization',
        },
      });
      
      const res = await app.fetch(req, mockEnv);

      expect(res.status).toBe(204);
    });
  });

  describe('Auth Flow Integration', () => {
    it('should complete full signup flow', async () => {
      // Mock: user doesn't exist
      mockEnv.DB.first.mockResolvedValue(null);
      // Mock: created user
      mockEnv.DB.first.mockResolvedValue({
        id: 'new-user-id',
        email: 'newuser@example.com',
        display_name: 'New User',
        role: 'user',
        created_at: new Date().toISOString(),
      });
      mockEnv.DB.run.mockResolvedValue({ success: true });

      const req = new Request('http://localhost:8787/v1/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'newuser@example.com',
          password: 'password123',
          display_name: 'New User',
        }),
      });

      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).success).toBe(true);
      expect((data as any).data.access_token).toBeDefined();
    });

    it('should complete full login flow', async () => {
      mockEnv.DB.first.mockResolvedValue({
        ...testUsers[2],
        password_hash: hashedPassword,
      });
      mockEnv.DB.first.mockResolvedValue(null); // No neighborhood

      const req = new Request('http://localhost:8787/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'ahmed@example.ma',
          password: 'password123',
        }),
      });

      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).success).toBe(true);
      expect((data as any).data.access_token).toBeDefined();
    });

    it('should access protected route with token', async () => {
      const token = await createJWT(
        { sub: 'user-003', role: 'user', neighborhood_id: 'nb-001' },
        mockEnv.JWT_SECRET,
        24
      );

      mockEnv.DB.first.mockResolvedValue(testUsers[2]);
      mockEnv.DB.first.mockResolvedValue({
        id: 'un-001',
        neighborhood_id: 'nb-001',
        joined_at: new Date().toISOString(),
      });

      const req = new Request('http://localhost:8787/v1/me', {
        headers: { Authorization: `Bearer ${token}` },
      });

      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).success).toBe(true);
      expect((data as any).data.id).toBe('user-003');
    });
  });

  describe('Error Handling', () => {
    it('should handle internal errors gracefully', async () => {
      mockEnv.DB.first.mockRejectedValue(new Error('Database connection failed'));

      const req = new Request('http://localhost:8787/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'password123',
        }),
      });

      const res = await app.fetch(req, mockEnv);
      const data = await res.json();

      expect(res.status).toBe(500);
      expect((data as any).error.code).toBe('INTERNAL_ERROR');
    });
  });
});
