/**
 * Wihda Backend - Authentication Middleware
 * JWT validation and user context extraction
 */

import { Context, Next } from 'hono';
import { verifyJWT } from '../lib/utils';
import type { Env } from '../types';

// Extend Hono context with user info
export interface AuthContext {
  userId: string;
  userRole: 'user' | 'moderator' | 'admin';
  neighborhoodId: string | null;
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

/**
 * Extract and validate JWT token from Authorization header
 */
export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({
      success: false,
      error: {
        code: 'MISSING_TOKEN',
        message: 'Authorization header with Bearer token is required'
      }
    }, 401);
  }
  
  const token = authHeader.substring(7);
  const payload = await verifyJWT(token, c.env.JWT_SECRET);
  
  if (!payload) {
    return c.json({
      success: false,
      error: {
        code: 'INVALID_TOKEN',
        message: 'Token is invalid or expired'
      }
    }, 401);
  }
  
  // Store auth context in Hono context
  c.set('auth', {
    userId: payload.sub,
    userRole: payload.role as AuthContext['userRole'],
    neighborhoodId: payload.neighborhood_id
  });
  
  await next();
}

/**
 * Optional auth - doesn't fail if no token, but sets context if present
 */
export async function optionalAuthMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const authHeader = c.req.header('Authorization');
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const payload = await verifyJWT(token, c.env.JWT_SECRET);
    
    if (payload) {
      c.set('auth', {
        userId: payload.sub,
        userRole: payload.role as AuthContext['userRole'],
        neighborhoodId: payload.neighborhood_id
      });
    }
  }
  
  await next();
}

/**
 * Require moderator or admin role
 */
export async function requireModerator(c: Context<{ Bindings: Env }>, next: Next) {
  const auth = c.get('auth');
  
  if (!auth) {
    return c.json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required'
      }
    }, 401);
  }
  
  if (auth.userRole !== 'moderator' && auth.userRole !== 'admin') {
    return c.json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Moderator or admin access required'
      }
    }, 403);
  }
  
  await next();
}

/**
 * Require admin role
 */
export async function requireAdmin(c: Context<{ Bindings: Env }>, next: Next) {
  const auth = c.get('auth');
  
  if (!auth) {
    return c.json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required'
      }
    }, 401);
  }
  
  if (auth.userRole !== 'admin') {
    return c.json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Admin access required'
      }
    }, 403);
  }
  
  await next();
}

/**
 * Require user to have a neighborhood
 */
export async function requireNeighborhood(c: Context<{ Bindings: Env }>, next: Next) {
  const auth = c.get('auth');
  
  if (!auth) {
    return c.json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required'
      }
    }, 401);
  }
  
  if (!auth.neighborhoodId) {
    return c.json({
      success: false,
      error: {
        code: 'NO_NEIGHBORHOOD',
        message: 'You must join a neighborhood first'
      }
    }, 400);
  }
  
  await next();
}

/**
 * Get auth context from Hono context
 */
export function getAuthContext(c: Context<{ Bindings: Env }>): AuthContext | null {
  return c.get('auth') || null;
}

/**
 * Check if user owns a resource or is moderator/admin
 */
export function canModifyResource(auth: AuthContext, resourceUserId: string): boolean {
  if (auth.userRole === 'admin' || auth.userRole === 'moderator') {
    return true;
  }
  return auth.userId === resourceUserId;
}
