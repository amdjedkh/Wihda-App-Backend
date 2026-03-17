/**
 * Wihda Backend - Neighborhood Routes
 * GET  /v1/neighborhoods          - List all active neighborhoods (map)
 * GET  /v1/neighborhoods/lookup   - Search by city or coords
 * POST /v1/neighborhoods          - Create a new neighborhood (auth required)
 * POST /v1/neighborhoods/join     - Join a neighborhood (auth required)
 * GET  /v1/neighborhoods/:id      - Get neighborhood details
 * GET  /v1/neighborhoods/:id/stats
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import {
  getAllActiveNeighborhoods,
  getNeighborhoodsByCity,
  getNeighborhoodsNearLocation,
  getNeighborhoodById,
  joinNeighborhood,
  getUserById,
  createNeighborhood,
  getOverlappingNeighborhoods,
} from '../lib/db';
import { successResponse, errorResponse, calculateDistance, createJWT } from '../lib/utils';
import { authMiddleware, getAuthContext } from '../middleware/auth';

const neighborhood = new Hono<{ Bindings: Env }>();

const joinSchema = z.object({
  neighborhood_id: z.string().uuid(),
});

const createSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(500).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  center_lat: z.number().min(-90).max(90),
  center_lng: z.number().min(-180).max(180),
  radius_meters: z.number().min(100).max(50000),
  city: z.string().min(1).max(100),
  country: z.string().length(2).optional(),
});

/**
 * GET /v1/neighborhoods
 * Return all active neighborhoods for map display (public)
 */
neighborhood.get('/', async (c) => {
  const neighborhoods = await getAllActiveNeighborhoods(c.env.DB);
  return successResponse({
    neighborhoods: neighborhoods.map(formatNeighborhood),
  });
});

/**
 * POST /v1/neighborhoods
 * Create a new neighborhood (auth required)
 */
neighborhood.post('/', authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }

  try {
    const body = await c.req.json();
    const validation = createSchema.safeParse(body);

    if (!validation.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request data', 400, validation.error.flatten());
    }

    const data = validation.data;

    // Check for overlapping neighborhoods
    const overlapping = await getOverlappingNeighborhoods(
      c.env.DB,
      data.center_lat,
      data.center_lng,
      data.radius_meters,
    );

    if (overlapping.length > 0) {
      return errorResponse(
        'NEIGHBORHOOD_EXISTS',
        `A neighborhood already exists in this area: "${overlapping[0].name}"`,
        409,
        { existing: overlapping.map(formatNeighborhood) },
      );
    }

    const created = await createNeighborhood(c.env.DB, {
      ...data,
      created_by: authContext.userId,
    });

    return c.json({ success: true, data: { neighborhood: formatNeighborhood(created) } }, 201);
  } catch (error) {
    console.error('Create neighborhood error:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to create neighborhood', 500);
  }
});

/**
 * GET /v1/neighborhoods/lookup
 * Search neighborhoods by city or location
 */
neighborhood.get('/lookup', async (c) => {
  const city = c.req.query('city');
  const lat = c.req.query('lat') ? parseFloat(c.req.query('lat')!) : null;
  const lng = c.req.query('lng') ? parseFloat(c.req.query('lng')!) : null;

  let neighborhoods;

  if (lat !== null && lng !== null) {
    neighborhoods = await getNeighborhoodsNearLocation(c.env.DB, lat, lng);
  } else if (city) {
    neighborhoods = await getNeighborhoodsByCity(c.env.DB, city);
  } else {
    return errorResponse('MISSING_PARAMS', 'Provide city or lat/lng coordinates', 400);
  }

  const result = neighborhoods.map((n) => ({
    ...formatNeighborhood(n),
    distance_km:
      lat !== null && lng !== null && n.center_lat && n.center_lng
        ? calculateDistance(lat, lng, n.center_lat, n.center_lng)
        : null,
  }));

  if (lat !== null && lng !== null) {
    result.sort((a, b) => (a.distance_km || 0) - (b.distance_km || 0));
  }

  return successResponse({ neighborhoods: result });
});

/**
 * POST /v1/neighborhoods/join
 * Join a neighborhood (auth required)
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

    const nbh = await getNeighborhoodById(c.env.DB, neighborhood_id);
    if (!nbh) {
      return errorResponse('NOT_FOUND', 'Neighborhood not found', 404);
    }

    const membership = await joinNeighborhood(c.env.DB, authContext.userId, neighborhood_id);

    const user = await getUserById(c.env.DB, authContext.userId);
    if (!user) {
      return errorResponse('USER_NOT_FOUND', 'User not found', 404);
    }

    const accessToken = await createJWT(
      { sub: user.id, role: user.role, neighborhood_id },
      c.env.JWT_SECRET,
      24,
    );

    return successResponse({
      membership: {
        id: membership.id,
        neighborhood_id: membership.neighborhood_id,
        neighborhood_name: nbh.name,
        joined_at: membership.joined_at,
      },
      new_access_token: accessToken,
    });
  } catch (error) {
    console.error('Join neighborhood error:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to join neighborhood', 500);
  }
});

/**
 * GET /v1/neighborhoods/:id
 */
neighborhood.get('/:id', async (c) => {
  const id = c.req.param('id');
  const nbh = await getNeighborhoodById(c.env.DB, id);
  if (!nbh) {
    return errorResponse('NOT_FOUND', 'Neighborhood not found', 404);
  }
  return successResponse(formatNeighborhood(nbh));
});

/**
 * GET /v1/neighborhoods/:id/stats
 */
neighborhood.get('/:id/stats', async (c) => {
  const id = c.req.param('id');

  const nbh = await getNeighborhoodById(c.env.DB, id);
  if (!nbh) {
    return errorResponse('NOT_FOUND', 'Neighborhood not found', 404);
  }

  const [members, offers, needs, cleanify, campaigns] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as count FROM user_neighborhoods WHERE neighborhood_id = ? AND left_at IS NULL').bind(id).first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as count FROM leftover_offers WHERE neighborhood_id = ? AND status = 'active'").bind(id).first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as count FROM leftover_needs WHERE neighborhood_id = ? AND status = 'active'").bind(id).first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as count FROM cleanify_submissions WHERE neighborhood_id = ? AND status = 'pending'").bind(id).first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as count FROM campaigns WHERE neighborhood_id = ? AND status = 'active' AND start_dt >= datetime('now')").bind(id).first<{ count: number }>(),
  ]);

  return successResponse({
    neighborhood_id: id,
    neighborhood_name: nbh.name,
    members_count: members?.count || 0,
    active_offers_count: offers?.count || 0,
    active_needs_count: needs?.count || 0,
    pending_cleanify_count: cleanify?.count || 0,
    upcoming_campaigns_count: campaigns?.count || 0,
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function formatNeighborhood(n: any) {
  return {
    id: n.id,
    name: n.name,
    description: n.description ?? null,
    color: n.color ?? '#14ae5c',
    city: n.city,
    country: n.country,
    center_lat: n.center_lat,
    center_lng: n.center_lng,
    radius_meters: n.radius_meters,
    created_by: n.created_by ?? null,
    created_at: n.created_at,
  };
}

export default neighborhood;
