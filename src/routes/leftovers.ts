/**
 * Wihda Backend - Leftovers Routes
 * POST /v1/leftovers/offers
 * GET /v1/leftovers/offers
 * POST /v1/leftovers/needs
 * GET /v1/leftovers/needs
 * GET /v1/leftovers/matches
 * POST /v1/leftovers/matches/:id/close
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import {
  createLeftoverOffer,
  getLeftoverOfferById,
  getActiveLeftoverOffers,
  createLeftoverNeed,
  getLeftoverNeedById,
  getActiveLeftoverNeeds,
  getMatchesForUser,
  getMatchById,
  updateMatchStatus,
  getChatThreadByMatchId,
  getCoinRule,
  createCoinEntry,
  getUserById
} from '../lib/db';
import { successResponse, errorResponse, addHours, toISODateString } from '../lib/utils';
import { authMiddleware, getAuthContext, requireNeighborhood } from '../middleware/auth';

const leftovers = new Hono<{ Bindings: Env }>();

// Survey validation schema
const surveySchema = z.object({
  schema_version: z.number().default(1),
  food_type: z.enum(['bread', 'cooked_meal', 'vegetables', 'fruits', 'dairy', 'dry_goods', 'other']),
  diet_constraints: z.array(z.string()).default([]),
  portions: z.number().int().min(1).max(50),
  pickup_time_preference: z.enum(['morning', 'afternoon', 'evening', 'flexible']),
  distance_willing_km: z.number().min(0.5).max(20),
  notes: z.string().max(500).optional()
});

const createOfferSchema = z.object({
  title: z.string().min(3).max(100),
  description: z.string().max(1000).optional(),
  survey: surveySchema,
  quantity: z.number().int().min(1).max(10).default(1),
  pickup_window_start: z.string().datetime().optional(),
  pickup_window_end: z.string().datetime().optional(),
  expiry_hours: z.number().int().min(1).max(72).default(24)
});

const createNeedSchema = z.object({
  survey: surveySchema,
  urgency: z.enum(['low', 'normal', 'high', 'urgent']).default('normal')
});

const closeMatchSchema = z.object({
  closure_type: z.enum(['successful', 'cancelled', 'disputed']),
  dispute_reason: z.string().max(1000).optional()
});

/**
 * POST /v1/leftovers/offers
 * Create a new leftover offer
 */
leftovers.post('/offers', authMiddleware, requireNeighborhood, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext || !authContext.neighborhoodId) {
    return errorResponse('UNAUTHORIZED', 'Authentication and neighborhood required', 401);
  }
  
  try {
    const body = await c.req.json();
    const validation = createOfferSchema.safeParse(body);
    
    if (!validation.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request data', 400, validation.error.flatten());
    }
    
    const data = validation.data;
    const expiryAt = toISODateString(addHours(new Date(), data.expiry_hours));
    
    const offer = await createLeftoverOffer(c.env.DB, {
      userId: authContext.userId,
      neighborhoodId: authContext.neighborhoodId,
      title: data.title,
      description: data.description,
      surveyJson: JSON.stringify(data.survey),
      quantity: data.quantity,
      pickupWindowStart: data.pickup_window_start,
      pickupWindowEnd: data.pickup_window_end,
      expiryAt
    });
    
    // Queue matching job
    await c.env.MATCHING_QUEUE.send({
      type: 'match_offer',
      offer_id: offer.id,
      neighborhood_id: authContext.neighborhoodId,
      timestamp: toISODateString()
    });
    
    return successResponse({
      offer: {
        id: offer.id,
        title: offer.title,
        status: offer.status,
        expiry_at: offer.expiry_at,
        created_at: offer.created_at
      }
    });
  } catch (error) {
    console.error('Create offer error:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to create offer', 500);
  }
});

/**
 * GET /v1/leftovers/offers
 * List active offers in user's neighborhood
 */
leftovers.get('/offers', authMiddleware, requireNeighborhood, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext || !authContext.neighborhoodId) {
    return errorResponse('UNAUTHORIZED', 'Authentication and neighborhood required', 401);
  }
  
  const status = c.req.query('status') || 'active';
  const limit = parseInt(c.req.query('limit') || '20');
  
  let offers;
  if (status === 'active') {
    offers = await getActiveLeftoverOffers(c.env.DB, authContext.neighborhoodId, limit);
  } else {
    // Get user's own offers
    const result = await c.env.DB.prepare(`
      SELECT * FROM leftover_offers 
      WHERE user_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).bind(authContext.userId, limit).all();
    offers = result.results;
  }
  
  // Get user details for each offer
  const offersWithUser = await Promise.all(offers.map(async (offer: any) => {
    const user = await getUserById(c.env.DB, offer.user_id);
    return {
      id: offer.id,
      title: offer.title,
      description: offer.description,
      survey: JSON.parse(offer.survey_json),
      quantity: offer.quantity,
      status: offer.status,
      expiry_at: offer.expiry_at,
      user: user ? {
        id: user.id,
        display_name: user.display_name
      } : null,
      created_at: offer.created_at
    };
  }));
  
  return successResponse({
    offers: offersWithUser
  });
});

/**
 * GET /v1/leftovers/offers/:id
 * Get offer details
 */
leftovers.get('/offers/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  
  const offer = await getLeftoverOfferById(c.env.DB, id);
  if (!offer) {
    return errorResponse('NOT_FOUND', 'Offer not found', 404);
  }
  
  const user = await getUserById(c.env.DB, offer.user_id);
  
  return successResponse({
    id: offer.id,
    title: offer.title,
    description: offer.description,
    survey: JSON.parse(offer.survey_json),
    quantity: offer.quantity,
    pickup_window_start: offer.pickup_window_start,
    pickup_window_end: offer.pickup_window_end,
    status: offer.status,
    expiry_at: offer.expiry_at,
    user: user ? {
      id: user.id,
      display_name: user.display_name
    } : null,
    created_at: offer.created_at
  });
});

/**
 * POST /v1/leftovers/needs
 * Create a new leftover need
 */
leftovers.post('/needs', authMiddleware, requireNeighborhood, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext || !authContext.neighborhoodId) {
    return errorResponse('UNAUTHORIZED', 'Authentication and neighborhood required', 401);
  }
  
  try {
    const body = await c.req.json();
    const validation = createNeedSchema.safeParse(body);
    
    if (!validation.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request data', 400, validation.error.flatten());
    }
    
    const data = validation.data;
    
    const need = await createLeftoverNeed(c.env.DB, {
      userId: authContext.userId,
      neighborhoodId: authContext.neighborhoodId,
      surveyJson: JSON.stringify(data.survey),
      urgency: data.urgency
    });
    
    // Queue matching job
    await c.env.MATCHING_QUEUE.send({
      type: 'match_need',
      need_id: need.id,
      neighborhood_id: authContext.neighborhoodId,
      timestamp: toISODateString()
    });
    
    return successResponse({
      need: {
        id: need.id,
        urgency: need.urgency,
        status: need.status,
        created_at: need.created_at
      }
    });
  } catch (error) {
    console.error('Create need error:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to create need', 500);
  }
});

/**
 * GET /v1/leftovers/needs
 * List active needs in user's neighborhood
 */
leftovers.get('/needs', authMiddleware, requireNeighborhood, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext || !authContext.neighborhoodId) {
    return errorResponse('UNAUTHORIZED', 'Authentication and neighborhood required', 401);
  }
  
  const status = c.req.query('status') || 'active';
  const limit = parseInt(c.req.query('limit') || '20');
  
  let needs;
  if (status === 'active') {
    needs = await getActiveLeftoverNeeds(c.env.DB, authContext.neighborhoodId, limit);
  } else {
    const result = await c.env.DB.prepare(`
      SELECT * FROM leftover_needs 
      WHERE user_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).bind(authContext.userId, limit).all();
    needs = result.results;
  }
  
  const needsWithUser = await Promise.all(needs.map(async (need: any) => {
    const user = await getUserById(c.env.DB, need.user_id);
    return {
      id: need.id,
      survey: JSON.parse(need.survey_json),
      urgency: need.urgency,
      status: need.status,
      user: user ? {
        id: user.id,
        display_name: user.display_name
      } : null,
      created_at: need.created_at
    };
  }));
  
  return successResponse({
    needs: needsWithUser
  });
});

/**
 * GET /v1/leftovers/matches
 * Get user's matches
 */
leftovers.get('/matches', authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }
  
  const status = c.req.query('status') || 'active';
  const matches = await getMatchesForUser(c.env.DB, authContext.userId, status);
  
  // Enrich matches with details
  const enrichedMatches = await Promise.all(matches.map(async (match) => {
    const [offer, _need, offerUser, needUser, chatThread] = await Promise.all([
      getLeftoverOfferById(c.env.DB, match.offer_id),
      getLeftoverNeedById(c.env.DB, match.need_id),
      getUserById(c.env.DB, match.offer_user_id),
      getUserById(c.env.DB, match.need_user_id),
      getChatThreadByMatchId(c.env.DB, match.id)
    ]);
    
    const isOfferOwner = match.offer_user_id === authContext.userId;
    const otherUser = isOfferOwner ? needUser : offerUser;
    
    return {
      id: match.id,
      score: match.score,
      status: match.status,
      closure_type: match.closure_type,
      created_at: match.created_at,
      closed_at: match.closed_at,
      is_offer_owner: isOfferOwner,
      offer: offer ? {
        id: offer.id,
        title: offer.title
      } : null,
      other_user: otherUser ? {
        id: otherUser.id,
        display_name: otherUser.display_name
      } : null,
      chat_thread_id: chatThread?.id || null
    };
  }));
  
  return successResponse({
    matches: enrichedMatches
  });
});

/**
 * POST /v1/leftovers/matches/:id/close
 * Request or confirm match closure
 */
leftovers.post('/matches/:id/close', authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }
  
  const matchId = c.req.param('id');
  
  try {
    const body = await c.req.json();
    const validation = closeMatchSchema.safeParse(body);
    
    if (!validation.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request data', 400, validation.error.flatten());
    }
    
    const data = validation.data;
    
    // Get match
    const match = await getMatchById(c.env.DB, matchId);
    if (!match) {
      return errorResponse('NOT_FOUND', 'Match not found', 404);
    }
    
    // Verify user is part of this match
    if (match.offer_user_id !== authContext.userId && match.need_user_id !== authContext.userId) {
      return errorResponse('FORBIDDEN', 'You are not part of this match', 403);
    }
    
    // Check if match is already closed
    if (match.status === 'closed' || match.status === 'cancelled') {
      return errorResponse('ALREADY_CLOSED', 'This match is already closed', 400);
    }
    
    let coinsAwarded = 0;
    let newStatus = 'closed';
    
    if (data.closure_type === 'successful') {
      // Award coins to both parties
      const [giverRule, receiverRule] = await Promise.all([
        getCoinRule(c.env.DB, 'leftovers_match_closed_giver'),
        getCoinRule(c.env.DB, 'leftovers_match_closed_receiver')
      ]);
      
      // Award coins to giver (offer owner)
      const giverAmount = giverRule?.amount || 200;
      await createCoinEntry(c.env.DB, {
        userId: match.offer_user_id,
        neighborhoodId: match.neighborhood_id,
        sourceType: 'leftovers_match_closed_giver',
        sourceId: match.id,
        amount: giverAmount,
        category: 'leftovers',
        description: 'Reward for successfully giving leftovers',
        createdBy: 'system'
      });
      
      // Award coins to receiver
      const receiverAmount = receiverRule?.amount || 50;
      await createCoinEntry(c.env.DB, {
        userId: match.need_user_id,
        neighborhoodId: match.neighborhood_id,
        sourceType: 'leftovers_match_closed_receiver',
        sourceId: match.id,
        amount: receiverAmount,
        category: 'leftovers',
        description: 'Reward for completing pickup',
        createdBy: 'system'
      });
      
      coinsAwarded = giverAmount + receiverAmount;
    } else if (data.closure_type === 'cancelled') {
      // Reopen the offer and need
      await c.env.DB.prepare("UPDATE leftover_offers SET status = 'active', updated_at = ? WHERE id = ?")
        .bind(toISODateString(), match.offer_id).run();
      await c.env.DB.prepare("UPDATE leftover_needs SET status = 'active', updated_at = ? WHERE id = ?")
        .bind(toISODateString(), match.need_id).run();
      newStatus = 'cancelled';
    }
    
    // Update match status
    await updateMatchStatus(c.env.DB, matchId, {
      status: newStatus,
      closedBy: authContext.userId,
      closureType: data.closure_type,
      disputeReason: data.dispute_reason,
      coinsAwarded
    });
    
    // Close chat thread
    const chatThread = await getChatThreadByMatchId(c.env.DB, matchId);
    if (chatThread) {
      await c.env.DB.prepare("UPDATE chat_threads SET status = 'closed', closed_at = ? WHERE id = ?")
        .bind(toISODateString(), chatThread.id).run();
    }
    
    // Send notification to other party
    const otherUserId = match.offer_user_id === authContext.userId ? match.need_user_id : match.offer_user_id;
    await c.env.NOTIFICATION_QUEUE.send({
      user_id: otherUserId,
      type: 'match_closed',
      title: 'Match Completed',
      body: data.closure_type === 'successful' 
        ? 'The leftover exchange has been completed successfully!' 
        : 'The match has been cancelled.',
      data: { match_id: matchId, closure_type: data.closure_type },
      timestamp: toISODateString()
    });
    
    return successResponse({
      match: {
        id: matchId,
        status: newStatus,
        closure_type: data.closure_type,
        coins_awarded: coinsAwarded,
        closed_at: toISODateString()
      }
    });
  } catch (error) {
    console.error('Close match error:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to close match', 500);
  }
});

export default leftovers;
