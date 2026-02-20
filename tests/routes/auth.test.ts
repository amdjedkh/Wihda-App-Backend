/**
 * Tests for Authentication Routes
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import auth from '../../src/routes/auth';
import { createMockEnv, testUsers, testNeighborhoods, createTestJWT } from '../fixtures';
import { hashPassword } from '../../src/lib/utils';

// Helper to create test request
function createRequest(path: string, options: {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
} = {}) {
  const url = `http://localhost:8787/v1/auth${path}`;
  return new Request(url, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

describe('Auth Routes', () => {
  let mockEnv: ReturnType<typeof createMockEnv>;
  let hashedPassword: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEnv = createMockEnv();
    hashedPassword = await hashPassword('password123');
  });

  describe('POST /signup', () => {
    it('should create a new user with email', async () => {
      // Mock: user doesn't exist
      mockEnv.DB.first.mockResolvedValue(null);
      // Mock: created user
      mockEnv.DB.first.mockResolvedValue({
        id: 'new-user-id',
        email: 'newuser@example.com',
        phone: null,
        password_hash: hashedPassword,
        display_name: 'New User',
        role: 'user',
        status: 'active',
        language_preference: 'en',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      mockEnv.DB.run.mockResolvedValue({ success: true });

      const req = createRequest('/signup', {
        method: 'POST',
        body: {
          email: 'newuser@example.com',
          password: 'password123',
          display_name: 'New User',
        },
      });

      const res = await auth.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).success).toBe(true);
      expect((data as any).data.access_token).toBeDefined();
      expect((data as any).data.user.display_name).toBe('New User');
    });

    it('should create a new user with phone', async () => {
      mockEnv.DB.first.mockResolvedValue(null);
      mockEnv.DB.first.mockResolvedValue({
        id: 'new-user-id',
        email: null,
        phone: '+212600000099',
        display_name: 'Phone User',
        role: 'user',
        created_at: new Date().toISOString(),
      });
      mockEnv.DB.run.mockResolvedValue({ success: true });

      const req = createRequest('/signup', {
        method: 'POST',
        body: {
          phone: '+212600000099',
          password: 'password123',
          display_name: 'Phone User',
        },
      });

      const res = await auth.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).success).toBe(true);
    });

    it('should reject signup with existing email', async () => {
      // Mock: user already exists
      mockEnv.DB.first.mockResolvedValue({
        id: 'existing-user',
        email: 'existing@example.com',
      });

      const req = createRequest('/signup', {
        method: 'POST',
        body: {
          email: 'existing@example.com',
          password: 'password123',
          display_name: 'Existing User',
        },
      });

      const res = await auth.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(409);
      expect((data as any).error.code).toBe('EMAIL_EXISTS');
    });

    it('should reject signup with existing phone', async () => {
      mockEnv.DB.first.mockResolvedValueOnce(null); // No email user
      mockEnv.DB.first.mockResolvedValue({
        id: 'existing-user',
        phone: '+212600000001',
      });

      const req = createRequest('/signup', {
        method: 'POST',
        body: {
          phone: '+212600000001',
          password: 'password123',
          display_name: 'Existing User',
        },
      });

      const res = await auth.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(409);
      expect((data as any).error.code).toBe('PHONE_EXISTS');
    });

    it('should reject signup without email or phone', async () => {
      const req = createRequest('/signup', {
        method: 'POST',
        body: {
          password: 'password123',
          display_name: 'No Contact User',
        },
      });

      const res = await auth.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect((data as any).error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject signup with short password', async () => {
      const req = createRequest('/signup', {
        method: 'POST',
        body: {
          email: 'test@example.com',
          password: 'short',
          display_name: 'Test User',
        },
      });

      const res = await auth.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect((data as any).error.code).toBe('VALIDATION_ERROR');
    });

    it('should reject signup with short display name', async () => {
      const req = createRequest('/signup', {
        method: 'POST',
        body: {
          email: 'test@example.com',
          password: 'password123',
          display_name: 'X',
        },
      });

      const res = await auth.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect((data as any).error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /login', () => {
    it('should login with valid email and password', async () => {
      const testUser = {
        ...testUsers[2], // ahmed@example.ma
        password_hash: hashedPassword,
      };
      
      mockEnv.DB.first.mockResolvedValue(testUser);
      mockEnv.DB.first.mockResolvedValue(null); // No neighborhood membership

      const req = createRequest('/login', {
        method: 'POST',
        body: {
          email: 'ahmed@example.ma',
          password: 'password123',
        },
      });

      const res = await auth.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).success).toBe(true);
      expect((data as any).data.access_token).toBeDefined();
      expect((data as any).data.user.display_name).toBe('Ahmed Benali');
    });

    it('should login with valid phone and password', async () => {
      const testUser = {
        ...testUsers[2],
        password_hash: hashedPassword,
      };
      
      mockEnv.DB.first.mockResolvedValue(testUser);
      mockEnv.DB.first.mockResolvedValue(null);

      const req = createRequest('/login', {
        method: 'POST',
        body: {
          phone: '+212600000003',
          password: 'password123',
        },
      });

      const res = await auth.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).success).toBe(true);
    });

    it('should reject login with invalid email', async () => {
      mockEnv.DB.first.mockResolvedValue(null);

      const req = createRequest('/login', {
        method: 'POST',
        body: {
          email: 'nonexistent@example.com',
          password: 'password123',
        },
      });

      const res = await auth.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(401);
      expect((data as any).error.code).toBe('INVALID_CREDENTIALS');
    });

    it('should reject login with wrong password', async () => {
      const testUser = {
        ...testUsers[2],
        password_hash: hashedPassword,
      };
      
      mockEnv.DB.first.mockResolvedValue(testUser);

      const req = createRequest('/login', {
        method: 'POST',
        body: {
          email: 'ahmed@example.ma',
          password: 'wrongpassword',
        },
      });

      const res = await auth.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(401);
      expect((data as any).error.code).toBe('INVALID_CREDENTIALS');
    });

    it('should reject login for banned user', async () => {
      const bannedUser = {
        ...testUsers[2],
        password_hash: hashedPassword,
        status: 'banned',
      };
      
      mockEnv.DB.first.mockResolvedValue(bannedUser);

      const req = createRequest('/login', {
        method: 'POST',
        body: {
          email: 'ahmed@example.ma',
          password: 'password123',
        },
      });

      const res = await auth.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(403);
      expect((data as any).error.code).toBe('ACCOUNT_BANNED');
    });

    it('should include neighborhood in token when user has one', async () => {
      const testUser = {
        ...testUsers[2],
        password_hash: hashedPassword,
      };
      
      mockEnv.DB.first.mockResolvedValueOnce(testUser);
      mockEnv.DB.first.mockResolvedValue({
        id: 'un-001',
        user_id: 'user-003',
        neighborhood_id: 'nb-001',
        is_primary: 1,
        joined_at: new Date().toISOString(),
      });

      const req = createRequest('/login', {
        method: 'POST',
        body: {
          email: 'ahmed@example.ma',
          password: 'password123',
        },
      });

      const res = await auth.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(200);
    });

    it('should reject login without email or phone', async () => {
      const req = createRequest('/login', {
        method: 'POST',
        body: {
          password: 'password123',
        },
      });

      const res = await auth.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect((data as any).error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /refresh', () => {
    it('should refresh token with valid refresh token', async () => {
      const testUser = testUsers[2];
      const refreshToken = await import('../../src/lib/utils').then(m => 
        m.createJWT(
          { sub: testUser.id, role: testUser.role, neighborhood_id: null },
          mockEnv.JWT_SECRET,
          168
        )
      );
      
      mockEnv.DB.first.mockResolvedValue(testUser);
      mockEnv.DB.first.mockResolvedValue(null);

      const req = createRequest('/refresh', {
        method: 'POST',
        body: {
          refresh_token: refreshToken,
        },
      });

      const res = await auth.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).success).toBe(true);
      expect((data as any).data.access_token).toBeDefined();
    });

    it('should reject refresh with missing token', async () => {
      const req = createRequest('/refresh', {
        method: 'POST',
        body: {},
      });

      const res = await auth.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect((data as any).error.code).toBe('MISSING_TOKEN');
    });

    it('should reject refresh with invalid token', async () => {
      const req = createRequest('/refresh', {
        method: 'POST',
        body: {
          refresh_token: 'invalid.token.here',
        },
      });

      const res = await auth.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(401);
      expect((data as any).error.code).toBe('INVALID_TOKEN');
    });

    it('should reject refresh for deleted user', async () => {
      const testUser = testUsers[2];
      const refreshToken = await import('../../src/lib/utils').then(m => 
        m.createJWT(
          { sub: testUser.id, role: testUser.role, neighborhood_id: null },
          mockEnv.JWT_SECRET,
          168
        )
      );
      
      mockEnv.DB.first.mockResolvedValue(null); // User not found

      const req = createRequest('/refresh', {
        method: 'POST',
        body: {
          refresh_token: refreshToken,
        },
      });

      const res = await auth.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(404);
      expect((data as any).error.code).toBe('USER_NOT_FOUND');
    });
  });

  describe('GET /me', () => {
    it('should return current user profile', async () => {
      const testUser = testUsers[2];
      const accessToken = await import('../../src/lib/utils').then(m => 
        m.createJWT(
          { sub: testUser.id, role: testUser.role, neighborhood_id: 'nb-001' },
          mockEnv.JWT_SECRET,
          24
        )
      );
      
      mockEnv.DB.first.mockResolvedValue(testUser);
      mockEnv.DB.first.mockResolvedValue({
        id: 'un-001',
        neighborhood_id: 'nb-001',
        joined_at: new Date().toISOString(),
      });

      const req = createRequest('/me', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const res = await auth.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect((data as any).success).toBe(true);
      expect((data as any).data.id).toBe('user-003');
    });

    it('should reject unauthenticated request', async () => {
      const req = createRequest('/me', {
        method: 'GET',
      });

      const res = await auth.fetch(req, mockEnv, {} as any);
      const data = await res.json();

      expect(res.status).toBe(401);
    });
  });
});
