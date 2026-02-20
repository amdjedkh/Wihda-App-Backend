/**
 * Wihda Backend - Neighborhood Routes
 * GET /v1/neighborhoods/lookup
 * POST /v1/neighborhoods/join
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { getNeighborhoodsByCity, getNeighborhoodsNearLocation, getNeighborhoodById, joinNeighborhood, getUserById } from '../lib/db';
import { successResponse, errorResponse, calculateDistance } from '../lib/utils';
import { authMiddleware, getAuthContext } from '../middleware/auth';
import { createJWT } from '../lib/utils';

const neighborhood = new Hono<{ Bindings: Env }>();

const joinSchema = z.object({
  neighborhood_id: z.string().uuid()
});

/**
 * GET /v1/neighborhoods/lookup
 * Search neighborhoods by city, name, or location
 */
neighborhood.get('/lookup', async (c) => {
  const city = c.req.query('city');
  // name query parameter available for future use
  const lat = c.req.query('lat') ? parseFloat(c.req.query('lat')!) : null;
  const lng = c.req.query('lng') ? parseFloat(c.req.query('lng')!) : null;
  
  let neighborhoods;
  
  if (lat && lng) {
    // Find neighborhoods near location
    neighborhoods = await getNeighborhoodsNearLocation(c.env.DB, lat, lng);
  } else if (city) {
    // Find by city
    neighborhoods = await getNeighborhoodsByCity(c.env.DB, city);
  } else {
    return errorResponse('MISSING_PARAMS', 'Provide city, name, or lat/lng coordinates', 400);
  }
  
  // Add distance if coordinates provided
  const result = neighborhoods.map(n => ({
    id: n.id,
    name: n.name,
    city: n.city,
    country: n.country,
    center_lat: n.center_lat,
    center_lng: n.center_lng,
    radius_meters: n.radius_meters,
    distance_km: lat && lng && n.center_lat && n.center_lng
      ? calculateDistance(lat, lng, n.center_lat, n.center_lng)
      : null
  }));
  
  // Sort by distance if available
  if (lat && lng) {
    result.sort((a, b) => (a.distance_km || 0) - (b.distance_km || 0));
  }
  
  return successResponse({
    neighborhoods: result
  });
});

/**
 * GET /v1/neighborhoods/:id
 * Get neighborhood details
 */
neighborhood.get('/:id', async (c) => {
  const id = c.req.param('id');
  
  const neighborhood = await getNeighborhoodById(c.env.DB, id);
  if (!neighborhood) {
    return errorResponse('NOT_FOUND', 'Neighborhood not found', 404);
  }
  
  return successResponse({
    id: neighborhood.id,
    name: neighborhood.name,
    city: neighborhood.city,
    country: neighborhood.country,
    center_lat: neighborhood.center_lat,
    center_lng: neighborhood.center_lng,
    radius_meters: neighborhood.radius_meters,
    created_at: neighborhood.created_at
  });
});

/**
 * POST /v1/neighborhoods/join
 * Join a neighborhood (requires auth)
 */
neighborhood.post('/join', authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }
  
  try {
    const body = await c.req.json();
    const validation = joinSchema.safeParse(body);
    
    if (!validation.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request data', 400, validation.error.flatten());
    }
    
    const { neighborhood_id } = validation.data;
    
    // Verify neighborhood exists
    const neighborhood = await getNeighborhoodById(c.env.DB, neighborhood_id);
    if (!neighborhood) {
      return errorResponse('NOT_FOUND', 'Neighborhood not found', 404);
    }
    
    // Join neighborhood
    const membership = await joinNeighborhood(c.env.DB, authContext.userId, neighborhood_id);
    
    // Get user to regenerate token with new neighborhood
    const user = await getUserById(c.env.DB, authContext.userId);
    if (!user) {
      return errorResponse('USER_NOT_FOUND', 'User not found', 404);
    }
    
    // Generate new JWT with updated neighborhood
    const accessToken = await createJWT(
      { sub: user.id, role: user.role, neighborhood_id: neighborhood_id },
      c.env.JWT_SECRET,
      24
    );
    
    return successResponse({
      membership: {
        id: membership.id,
        neighborhood_id: membership.neighborhood_id,
        neighborhood_name: neighborhood.name,
        joined_at: membership.joined_at
      },
      new_access_token: accessToken
    });
  } catch (error) {
    console.error('Join neighborhood error:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to join neighborhood', 500);
  }
});

/**
 * GET /v1/neighborhoods/:id/stats
 * Get neighborhood statistics
 */
neighborhood.get('/:id/stats', async (c) => {
  const id = c.req.param('id');
  
  const neighborhood = await getNeighborhoodById(c.env.DB, id);
  if (!neighborhood) {
    return errorResponse('NOT_FOUND', 'Neighborhood not found', 404);
  }
  
  // Get stats from database
  const [membersCount, activeOffersCount, activeNeedsCount, pendingCleanifyCount, upcomingCampaignsCount] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as count FROM user_neighborhoods WHERE neighborhood_id = ? AND left_at IS NULL').bind(id).first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as count FROM leftover_offers WHERE neighborhood_id = ? AND status = 'active'").bind(id).first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as count FROM leftover_needs WHERE neighborhood_id = ? AND status = 'active'").bind(id).first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as count FROM cleanify_submissions WHERE neighborhood_id = ? AND status = 'pending'").bind(id).first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as count FROM campaigns WHERE neighborhood_id = ? AND status = 'active' AND start_dt >= datetime('now')").bind(id).first<{ count: number }>()
  ]);
  
  return successResponse({
    neighborhood_id: id,
    neighborhood_name: neighborhood.name,
    members_count: membersCount?.count || 0,
    active_offers_count: activeOffersCount?.count || 0,
    active_needs_count: activeNeedsCount?.count || 0,
    pending_cleanify_count: pendingCleanifyCount?.count || 0,
    upcoming_campaigns_count: upcomingCampaignsCount?.count || 0
  });
});

export default neighborhood;
