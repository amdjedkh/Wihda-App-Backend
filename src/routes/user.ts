/**
 * Wihda Backend - User Routes
 * GET /v1/me
 * PATCH /v1/me
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { getUserById, updateUser, getUserNeighborhood, getNeighborhoodById, getCoinBalance, getCoinLedgerEntries } from '../lib/db';
import { successResponse, errorResponse } from '../lib/utils';
import { authMiddleware, getAuthContext } from '../middleware/auth';

const user = new Hono<{ Bindings: Env }>();

const updateProfileSchema = z.object({
  display_name: z.string().min(2).max(50).optional(),
  language_preference: z.string().length(2).optional(),
  fcm_token: z.string().optional()
});

/**
 * GET /v1/me
 * Get current user profile with neighborhood and coin balance
 */
user.get('/', authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }
  
  const user = await getUserById(c.env.DB, authContext.userId);
  
  if (!user) {
    return errorResponse('USER_NOT_FOUND', 'User not found', 403);
  }
  
  const userNeighborhood = await getUserNeighborhood(c.env.DB, user.id);
  const neighborhood = userNeighborhood ? await getNeighborhoodById(c.env.DB, userNeighborhood.neighborhood_id) : null;
  const coinBalance = await getCoinBalance(c.env.DB, user.id);
  
  return successResponse({
    id: user.id,
    email: user.email,
    phone: user.phone,
    display_name: user.display_name,
    role: user.role,
    status: user.status,
    language_preference: user.language_preference,
    neighborhood: neighborhood ? {
      id: neighborhood.id,
      name: neighborhood.name,
      city: neighborhood.city,
      joined_at: userNeighborhood?.joined_at
    } : null,
    coin_balance: coinBalance,
    created_at: user.created_at
  });
});

/**
 * PATCH /v1/me
 * Update current user profile
 */
user.patch('/', authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }
  
  try {
    const body = await c.req.json();
    const validation = updateProfileSchema.safeParse(body);
    
    if (!validation.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request data', 400, validation.error.flatten());
    }
    
    const data = validation.data;
    
    const updatedUser = await updateUser(c.env.DB, authContext.userId, {
      displayName: data.display_name,
      languagePreference: data.language_preference,
      fcmToken: data.fcm_token
    });
    
    if (!updatedUser) {
      return errorResponse('USER_NOT_FOUND', 'User not found', 404);
    }
    
    return successResponse({
      id: updatedUser.id,
      display_name: updatedUser.display_name,
      language_preference: updatedUser.language_preference,
      updated_at: updatedUser.updated_at
    });
  } catch (error) {
    console.error('Update profile error:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to update profile', 500);
  }
});

/**
 * GET /v1/me/coins
 * Get user's coin balance and recent ledger entries
 */
user.get('/coins', authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }
  
  const cursor = c.req.query('cursor');
  const limit = parseInt(c.req.query('limit') || '20');
  
  const balance = await getCoinBalance(c.env.DB, authContext.userId);
  const { entries, hasMore } = await getCoinLedgerEntries(c.env.DB, authContext.userId, limit, cursor);
  
  return successResponse({
    balance,
    entries,
    has_more: hasMore,
    next_cursor: hasMore && entries.length > 0 ? entries[entries.length - 1].created_at : null
  });
});

export default user;
