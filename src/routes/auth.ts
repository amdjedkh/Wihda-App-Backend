/**
 * Wihda Backend - Authentication Routes
 * POST /v1/auth/signup
 * POST /v1/auth/login
 * POST /v1/auth/refresh
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env, LoginResponse } from '../types';
import { createUser, getUserByEmail, getUserByPhone, getUserById, getUserNeighborhood } from '../lib/db';
import { hashPassword, verifyPassword, createJWT, successResponse, errorResponse } from '../lib/utils';
import { authMiddleware, getAuthContext } from '../middleware/auth';

const auth = new Hono<{ Bindings: Env }>();

// Validation schemas
const signupSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().optional(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  display_name: z.string().min(2, 'Display name must be at least 2 characters').max(50),
  language_preference: z.string().length(2).optional()
}).refine(data => data.email || data.phone, {
  message: 'Either email or phone is required'
});

const loginSchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().optional(),
  password: z.string().min(1)
}).refine(data => data.email || data.phone, {
  message: 'Either email or phone is required'
});

/**
 * POST /v1/auth/signup
 * Create a new user account
 */
auth.post('/signup', async (c) => {
  try {
    const body = await c.req.json();
    const validation = signupSchema.safeParse(body);
    
    if (!validation.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request data', 400, validation.error.flatten());
    }
    
    const data = validation.data;
    
    // Check if user already exists
    if (data.email) {
      const existingEmail = await getUserByEmail(c.env.DB, data.email);
      if (existingEmail) {
        return errorResponse('EMAIL_EXISTS', 'An account with this email already exists', 409);
      }
    }
    
    if (data.phone) {
      const existingPhone = await getUserByPhone(c.env.DB, data.phone);
      if (existingPhone) {
        return errorResponse('PHONE_EXISTS', 'An account with this phone already exists', 409);
      }
    }
    
    // Hash password
    const passwordHash = await hashPassword(data.password);
    
    // Create user
    const user = await createUser(c.env.DB, {
      email: data.email,
      phone: data.phone,
      passwordHash,
      displayName: data.display_name,
      languagePreference: data.language_preference
    });
    
    // Generate JWT tokens
    const accessToken = await createJWT(
      { sub: user.id, role: user.role, neighborhood_id: null },
      c.env.JWT_SECRET,
      24 // 24 hours
    );
    
    const refreshToken = await createJWT(
      { sub: user.id, role: user.role, neighborhood_id: null },
      c.env.JWT_SECRET,
      168 // 7 days
    );
    
    // Award signup bonus (will be handled by queue)
    // TODO: Send to notification queue
    
    const response: LoginResponse = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 86400, // 24 hours in seconds
      user: {
        id: user.id,
        display_name: user.display_name,
        role: user.role,
        created_at: user.created_at
      }
    };
    
    return successResponse(response);
  } catch (error) {
    console.error('Signup error:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to create account', 500);
  }
});

/**
 * POST /v1/auth/login
 * Authenticate user and get tokens
 */
auth.post('/login', async (c) => {
  try {
    const body = await c.req.json();
    const validation = loginSchema.safeParse(body);
    
    if (!validation.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request data', 400, validation.error.flatten());
    }
    
    const data = validation.data;
    
    // Find user by email or phone
    let user;
    if (data.email) {
      user = await getUserByEmail(c.env.DB, data.email);
    } else if (data.phone) {
      user = await getUserByPhone(c.env.DB, data.phone);
    }
    
    if (!user) {
      return errorResponse('INVALID_CREDENTIALS', 'Invalid email/phone or password', 401);
    }
    
    // Check if user is banned
    if (user.status === 'banned') {
      return errorResponse('ACCOUNT_BANNED', 'Your account has been banned', 403);
    }
    
    // Verify password
    const isValid = await verifyPassword(data.password, user.password_hash);
    if (!isValid) {
      return errorResponse('INVALID_CREDENTIALS', 'Invalid email/phone or password', 401);
    }
    
    // Get user's neighborhood
    const userNeighborhood = await getUserNeighborhood(c.env.DB, user.id);
    
    // Generate JWT tokens
    const accessToken = await createJWT(
      { sub: user.id, role: user.role, neighborhood_id: userNeighborhood?.neighborhood_id || null },
      c.env.JWT_SECRET,
      24
    );
    
    const refreshToken = await createJWT(
      { sub: user.id, role: user.role, neighborhood_id: userNeighborhood?.neighborhood_id || null },
      c.env.JWT_SECRET,
      168
    );
    
    const response: LoginResponse = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 86400,
      user: {
        id: user.id,
        display_name: user.display_name,
        role: user.role,
        created_at: user.created_at
      }
    };
    
    return successResponse(response);
  } catch (error) {
    console.error('Login error:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to authenticate', 500);
  }
});

/**
 * POST /v1/auth/refresh
 * Refresh access token using refresh token
 */
auth.post('/refresh', async (c) => {
  try {
    const body = await c.req.json();
    const { refresh_token } = body as { refresh_token?: string };
    
    if (!refresh_token) {
      return errorResponse('MISSING_TOKEN', 'Refresh token is required', 400);
    }
    
    // Verify refresh token
    const { verifyJWT } = await import('../lib/utils');
    const payload = await verifyJWT(refresh_token, c.env.JWT_SECRET);
    if (!payload) {
      return errorResponse('INVALID_TOKEN', 'Invalid or expired refresh token', 401);
    }
    
    // Get user and current neighborhood
    const user = await getUserById(c.env.DB, payload.sub);
    if (!user) {
      return errorResponse('USER_NOT_FOUND', 'User not found', 404);
    }
    
    const userNeighborhood = await getUserNeighborhood(c.env.DB, user.id);
    
    // Generate new tokens
    const accessToken = await createJWT(
      { sub: user.id, role: user.role, neighborhood_id: userNeighborhood?.neighborhood_id || null },
      c.env.JWT_SECRET,
      24
    );
    
    const newRefreshToken = await createJWT(
      { sub: user.id, role: user.role, neighborhood_id: userNeighborhood?.neighborhood_id || null },
      c.env.JWT_SECRET,
      168
    );
    
    const response: LoginResponse = {
      access_token: accessToken,
      refresh_token: newRefreshToken,
      expires_in: 86400,
      user: {
        id: user.id,
        display_name: user.display_name,
        role: user.role,
        created_at: user.created_at
      }
    };
    
    return successResponse(response);
  } catch (error) {
    console.error('Refresh error:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to refresh token', 500);
  }
});

/**
 * GET /v1/auth/me
 * Get current user profile (requires auth)
 */
auth.get('/me', authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }
  
  const user = await getUserById(c.env.DB, authContext.userId);
  if (!user) {
    return errorResponse('USER_NOT_FOUND', 'User not found', 404);
  }
  
  const userNeighborhood = await getUserNeighborhood(c.env.DB, user.id);
  
  return successResponse({
    id: user.id,
    email: user.email,
    phone: user.phone,
    display_name: user.display_name,
    role: user.role,
    language_preference: user.language_preference,
    neighborhood: userNeighborhood ? {
      id: userNeighborhood.neighborhood_id,
      joined_at: userNeighborhood.joined_at
    } : null,
    created_at: user.created_at
  });
});

export default auth;
