/**
 * Tests for Authentication Middleware
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  authMiddleware,
  optionalAuthMiddleware,
  requireModerator,
  requireAdmin,
  requireNeighborhood,
  getAuthContext,
  canModifyResource,
  AuthContext,
} from '../../src/middleware/auth';
import { createMockEnv } from '../fixtures';
import { createJWT } from '../../src/lib/utils';

// Mock Hono context
function createMockContext(options: {
  authHeader?: string;
  auth?: AuthContext;
  env?: ReturnType<typeof createMockEnv>;
} = {}) {
  const store: Record<string, unknown> = {};
  
  return {
    req: {
      header: (name: string) => {
        if (name === 'Authorization') return options.authHeader;
        return null;
      },
    },
    env: options.env || createMockEnv(),
    set: vi.fn((key: string, value: unknown) => {
      store[key] = value;
    }),
    get: vi.fn((key: string) => {
      if (options.auth && key === 'auth') return options.auth;
      return store[key];
    }),
    json: vi.fn((data: unknown, status: number) => ({ json: data, status })),
    header: vi.fn(),
  } as any;
}

describe('Auth Middleware', () => {
  let mockEnv: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = createMockEnv();
  });

  describe('authMiddleware', () => {
    it('should pass with valid token', async () => {
      const token = await createJWT(
        { sub: 'user-001', role: 'user', neighborhood_id: 'nb-001' },
        mockEnv.JWT_SECRET,
        24
      );

      const ctx = createMockContext({
        authHeader: `Bearer ${token}`,
        env: mockEnv,
      });
      const next = vi.fn();

      await authMiddleware(ctx, next);

      expect(next).toHaveBeenCalled();
      expect(ctx.set).toHaveBeenCalledWith('auth', {
        userId: 'user-001',
        userRole: 'user',
        neighborhoodId: 'nb-001',
      });
    });

    it('should reject missing authorization header', async () => {
      const ctx = createMockContext({ env: mockEnv });
      const next = vi.fn();

      const result = await authMiddleware(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(result.status).toBe(401);
    });

    it('should reject malformed authorization header', async () => {
      const ctx = createMockContext({
        authHeader: 'Basic somecredentials',
        env: mockEnv,
      });
      const next = vi.fn();

      const result = await authMiddleware(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(result.status).toBe(401);
    });

    it('should reject invalid token', async () => {
      const ctx = createMockContext({
        authHeader: 'Bearer invalid.token.here',
        env: mockEnv,
      });
      const next = vi.fn();

      const result = await authMiddleware(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(result.status).toBe(401);
    });

    it('should reject token with wrong secret', async () => {
      const token = await createJWT(
        { sub: 'user-001', role: 'user', neighborhood_id: null },
        'wrong-secret',
        24
      );

      const ctx = createMockContext({
        authHeader: `Bearer ${token}`,
        env: mockEnv,
      });
      const next = vi.fn();

      const result = await authMiddleware(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(result.status).toBe(401);
    });

    it('should handle null neighborhood_id', async () => {
      const token = await createJWT(
        { sub: 'user-001', role: 'user', neighborhood_id: null },
        mockEnv.JWT_SECRET,
        24
      );

      const ctx = createMockContext({
        authHeader: `Bearer ${token}`,
        env: mockEnv,
      });
      const next = vi.fn();

      await authMiddleware(ctx, next);

      expect(ctx.set).toHaveBeenCalledWith('auth', {
        userId: 'user-001',
        userRole: 'user',
        neighborhoodId: null,
      });
    });
  });

  describe('optionalAuthMiddleware', () => {
    it('should pass without token', async () => {
      const ctx = createMockContext({ env: mockEnv });
      const next = vi.fn();

      await optionalAuthMiddleware(ctx, next);

      expect(next).toHaveBeenCalled();
    });

    it('should set context with valid token', async () => {
      const token = await createJWT(
        { sub: 'user-001', role: 'user', neighborhood_id: 'nb-001' },
        mockEnv.JWT_SECRET,
        24
      );

      const ctx = createMockContext({
        authHeader: `Bearer ${token}`,
        env: mockEnv,
      });
      const next = vi.fn();

      await optionalAuthMiddleware(ctx, next);

      expect(next).toHaveBeenCalled();
      expect(ctx.set).toHaveBeenCalled();
    });

    it('should pass with invalid token (without setting context)', async () => {
      const ctx = createMockContext({
        authHeader: 'Bearer invalid.token',
        env: mockEnv,
      });
      const next = vi.fn();

      await optionalAuthMiddleware(ctx, next);

      expect(next).toHaveBeenCalled();
      expect(ctx.set).not.toHaveBeenCalled();
    });
  });

  describe('requireModerator', () => {
    it('should pass for moderator', async () => {
      const ctx = createMockContext({
        auth: { userId: 'user-001', userRole: 'moderator', neighborhoodId: 'nb-001' },
      });
      const next = vi.fn();

      await requireModerator(ctx, next);

      expect(next).toHaveBeenCalled();
    });

    it('should pass for admin', async () => {
      const ctx = createMockContext({
        auth: { userId: 'user-001', userRole: 'admin', neighborhoodId: 'nb-001' },
      });
      const next = vi.fn();

      await requireModerator(ctx, next);

      expect(next).toHaveBeenCalled();
    });

    it('should reject for regular user', async () => {
      const ctx = createMockContext({
        auth: { userId: 'user-001', userRole: 'user', neighborhoodId: 'nb-001' },
      });
      const next = vi.fn();

      const result = await requireModerator(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(result.status).toBe(403);
    });

    it('should reject without auth context', async () => {
      const ctx = createMockContext();
      const next = vi.fn();

      const result = await requireModerator(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(result.status).toBe(401);
    });
  });

  describe('requireAdmin', () => {
    it('should pass for admin', async () => {
      const ctx = createMockContext({
        auth: { userId: 'user-001', userRole: 'admin', neighborhoodId: 'nb-001' },
      });
      const next = vi.fn();

      await requireAdmin(ctx, next);

      expect(next).toHaveBeenCalled();
    });

    it('should reject for moderator', async () => {
      const ctx = createMockContext({
        auth: { userId: 'user-001', userRole: 'moderator', neighborhoodId: 'nb-001' },
      });
      const next = vi.fn();

      const result = await requireAdmin(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(result.status).toBe(403);
    });

    it('should reject for regular user', async () => {
      const ctx = createMockContext({
        auth: { userId: 'user-001', userRole: 'user', neighborhoodId: 'nb-001' },
      });
      const next = vi.fn();

      const result = await requireAdmin(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(result.status).toBe(403);
    });
  });

  describe('requireNeighborhood', () => {
    it('should pass for user with neighborhood', async () => {
      const ctx = createMockContext({
        auth: { userId: 'user-001', userRole: 'user', neighborhoodId: 'nb-001' },
      });
      const next = vi.fn();

      await requireNeighborhood(ctx, next);

      expect(next).toHaveBeenCalled();
    });

    it('should reject user without neighborhood', async () => {
      const ctx = createMockContext({
        auth: { userId: 'user-001', userRole: 'user', neighborhoodId: null },
      });
      const next = vi.fn();

      const result = await requireNeighborhood(ctx, next);

      expect(next).not.toHaveBeenCalled();
      expect(result.status).toBe(400);
    });
  });

  describe('getAuthContext', () => {
    it('should return auth context', () => {
      const auth: AuthContext = {
        userId: 'user-001',
        userRole: 'user',
        neighborhoodId: 'nb-001',
      };

      const ctx = createMockContext({ auth });

      const result = getAuthContext(ctx);

      expect(result).toEqual(auth);
    });

    it('should return null without auth context', () => {
      const ctx = createMockContext();

      const result = getAuthContext(ctx);

      expect(result).toBeNull();
    });
  });

  describe('canModifyResource', () => {
    it('should allow admin to modify any resource', () => {
      const auth: AuthContext = {
        userId: 'admin-001',
        userRole: 'admin',
        neighborhoodId: 'nb-001',
      };

      expect(canModifyResource(auth, 'user-999')).toBe(true);
    });

    it('should allow moderator to modify any resource', () => {
      const auth: AuthContext = {
        userId: 'mod-001',
        userRole: 'moderator',
        neighborhoodId: 'nb-001',
      };

      expect(canModifyResource(auth, 'user-999')).toBe(true);
    });

    it('should allow user to modify own resource', () => {
      const auth: AuthContext = {
        userId: 'user-001',
        userRole: 'user',
        neighborhoodId: 'nb-001',
      };

      expect(canModifyResource(auth, 'user-001')).toBe(true);
    });

    it('should not allow user to modify others resource', () => {
      const auth: AuthContext = {
        userId: 'user-001',
        userRole: 'user',
        neighborhoodId: 'nb-001',
      };

      expect(canModifyResource(auth, 'user-002')).toBe(false);
    });
  });
});
