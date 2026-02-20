/**
 * Wihda Backend - Cleanify Routes
 * POST /v1/cleanify/submissions
 * GET /v1/cleanify/submissions
 * POST /v1/mod/cleanify/:id/approve
 * POST /v1/mod/cleanify/:id/reject
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import {
  createCleanifySubmission,
  getCleanifySubmissionById,
  getCleanifySubmissionsForUser,
  getPendingCleanifySubmissions,
  reviewCleanifySubmission,
  getCoinRule,
  createCoinEntry,
  createModerationLog
} from '../lib/db';
import { successResponse, errorResponse, toISODateString } from '../lib/utils';
import { authMiddleware, getAuthContext, requireNeighborhood, requireModerator } from '../middleware/auth';

const cleanify = new Hono<{ Bindings: Env }>();

const createSubmissionSchema = z.object({
  before_photo_url: z.string().url(),
  after_photo_url: z.string().url(),
  geo_lat: z.number().min(-90).max(90).optional(),
  geo_lng: z.number().min(-180).max(180).optional(),
  description: z.string().max(1000).optional()
});

const reviewSchema = z.object({
  note: z.string().max(1000).optional()
});

/**
 * POST /v1/cleanify/submissions
 * Create a new cleanify submission
 */
cleanify.post('/submissions', authMiddleware, requireNeighborhood, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext || !authContext.neighborhoodId) {
    return errorResponse('UNAUTHORIZED', 'Authentication and neighborhood required', 401);
  }
  
  try {
    const body = await c.req.json();
    const validation = createSubmissionSchema.safeParse(body);
    
    if (!validation.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request data', 400, validation.error.flatten());
    }
    
    const data = validation.data;
    
    const submission = await createCleanifySubmission(c.env.DB, {
      userId: authContext.userId,
      neighborhoodId: authContext.neighborhoodId,
      beforePhotoUrl: data.before_photo_url,
      afterPhotoUrl: data.after_photo_url,
      geoLat: data.geo_lat,
      geoLng: data.geo_lng,
      description: data.description
    });
    
    return successResponse({
      submission: {
        id: submission.id,
        status: submission.status,
        submitted_at: submission.submitted_at
      }
    });
  } catch (error) {
    console.error('Create submission error:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to create submission', 500);
  }
});

/**
 * GET /v1/cleanify/submissions
 * Get user's submissions or pending submissions (for moderators)
 */
cleanify.get('/submissions', authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }
  
  const mine = c.req.query('mine') === 'true';
  const pending = c.req.query('pending') === 'true';
  const limit = parseInt(c.req.query('limit') || '20');
  
  let submissions;
  
  if (pending && (authContext.userRole === 'moderator' || authContext.userRole === 'admin')) {
    // Get pending submissions for moderation
    submissions = await getPendingCleanifySubmissions(c.env.DB, limit);
  } else if (mine || !pending) {
    // Get user's own submissions
    submissions = await getCleanifySubmissionsForUser(c.env.DB, authContext.userId, limit);
  } else {
    return errorResponse('FORBIDDEN', 'Moderator access required for pending submissions', 403);
  }
  
  const enrichedSubmissions = await Promise.all(submissions.map(async (sub) => {
    const user = await c.env.DB.prepare('SELECT id, display_name FROM users WHERE id = ?')
      .bind(sub.user_id).first<{ id: string; display_name: string }>();
    
    const reviewer = sub.reviewer_id 
      ? await c.env.DB.prepare('SELECT id, display_name FROM users WHERE id = ?')
          .bind(sub.reviewer_id).first<{ id: string; display_name: string }>()
      : null;
    
    return {
      id: sub.id,
      user: user ? {
        id: user.id,
        display_name: user.display_name
      } : null,
      before_photo_url: sub.before_photo_url,
      after_photo_url: sub.after_photo_url,
      geo: sub.geo_lat && sub.geo_lng ? {
        lat: sub.geo_lat,
        lng: sub.geo_lng
      } : null,
      description: sub.description,
      status: sub.status,
      submitted_at: sub.submitted_at,
      reviewer: reviewer ? {
        id: reviewer.id,
        display_name: reviewer.display_name
      } : null,
      reviewed_at: sub.reviewed_at,
      review_note: sub.review_note,
      coins_awarded: sub.coins_awarded,
      created_at: sub.created_at
    };
  }));
  
  return successResponse({
    submissions: enrichedSubmissions
  });
});

/**
 * GET /v1/cleanify/submissions/:id
 * Get submission details
 */
cleanify.get('/submissions/:id', authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }
  
  const id = c.req.param('id');
  const submission = await getCleanifySubmissionById(c.env.DB, id);
  
  if (!submission) {
    return errorResponse('NOT_FOUND', 'Submission not found', 404);
  }
  
  // Check access
  const isOwner = submission.user_id === authContext.userId;
  const isModerator = authContext.userRole === 'moderator' || authContext.userRole === 'admin';
  
  if (!isOwner && !isModerator) {
    return errorResponse('FORBIDDEN', 'Access denied', 403);
  }
  
  const user = await c.env.DB.prepare('SELECT id, display_name FROM users WHERE id = ?')
    .bind(submission.user_id).first<{ id: string; display_name: string }>();
  
  return successResponse({
    id: submission.id,
    user: user ? {
      id: user.id,
      display_name: user.display_name
    } : null,
    before_photo_url: submission.before_photo_url,
    after_photo_url: submission.after_photo_url,
    geo: submission.geo_lat && submission.geo_lng ? {
      lat: submission.geo_lat,
      lng: submission.geo_lng
    } : null,
    description: submission.description,
    status: submission.status,
    submitted_at: submission.submitted_at,
    reviewed_at: submission.reviewed_at,
    review_note: submission.review_note,
    coins_awarded: submission.coins_awarded,
    created_at: submission.created_at
  });
});

/**
 * POST /v1/mod/cleanify/:id/approve
 * Approve a cleanify submission (moderator only)
 */
cleanify.post('/submissions/:id/approve', authMiddleware, requireModerator, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }
  
  const id = c.req.param('id');
  
  try {
    const body = await c.req.json().catch(() => ({}));
    const validation = reviewSchema.safeParse(body);
    
    const submission = await getCleanifySubmissionById(c.env.DB, id);
    
    if (!submission) {
      return errorResponse('NOT_FOUND', 'Submission not found', 404);
    }
    
    if (submission.status !== 'pending') {
      return errorResponse('ALREADY_REVIEWED', 'This submission has already been reviewed', 400);
    }
    
    // Get coin reward amount
    const coinRule = await getCoinRule(c.env.DB, 'cleanify_approved');
    const coinAmount = coinRule?.amount || 150;
    
    // Review submission
    await reviewCleanifySubmission(c.env.DB, id, {
      status: 'approved',
      reviewerId: authContext.userId,
      note: validation.success ? validation.data.note : undefined,
      coinsAwarded: coinAmount
    });
    
    // Award coins (idempotent via unique constraint)
    await createCoinEntry(c.env.DB, {
      userId: submission.user_id,
      neighborhoodId: submission.neighborhood_id,
      sourceType: 'cleanify_approved',
      sourceId: id,
      amount: coinAmount,
      category: 'cleanify',
      description: 'Reward for approved cleanify submission',
      createdBy: authContext.userId
    });
    
    // Log moderation action
    await createModerationLog(c.env.DB, {
      moderatorId: authContext.userId,
      actionType: 'cleanify_approve',
      targetType: 'submission',
      targetId: id,
      reason: validation.success ? validation.data.note : undefined
    });
    
    // Notify user
    await c.env.NOTIFICATION_QUEUE.send({
      user_id: submission.user_id,
      type: 'cleanify_approved',
      title: 'Submission Approved!',
      body: `Your cleanify submission has been approved. You earned ${coinAmount} coins!`,
      data: { submission_id: id, coins: coinAmount },
      timestamp: toISODateString()
    });
    
    return successResponse({
      submission: {
        id,
        status: 'approved',
        coins_awarded: coinAmount,
        reviewed_at: toISODateString()
      }
    });
  } catch (error) {
    console.error('Approve submission error:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to approve submission', 500);
  }
});

/**
 * POST /v1/mod/cleanify/:id/reject
 * Reject a cleanify submission (moderator only)
 */
cleanify.post('/submissions/:id/reject', authMiddleware, requireModerator, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }
  
  const id = c.req.param('id');
  
  try {
    const body = await c.req.json();
    const validation = reviewSchema.safeParse(body);
    
    if (!validation.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request data', 400, validation.error.flatten());
    }
    
    const submission = await getCleanifySubmissionById(c.env.DB, id);
    
    if (!submission) {
      return errorResponse('NOT_FOUND', 'Submission not found', 404);
    }
    
    if (submission.status !== 'pending') {
      return errorResponse('ALREADY_REVIEWED', 'This submission has already been reviewed', 400);
    }
    
    // Review submission
    await reviewCleanifySubmission(c.env.DB, id, {
      status: 'rejected',
      reviewerId: authContext.userId,
      note: validation.data.note
    });
    
    // Log moderation action
    await createModerationLog(c.env.DB, {
      moderatorId: authContext.userId,
      actionType: 'cleanify_reject',
      targetType: 'submission',
      targetId: id,
      reason: validation.data.note
    });
    
    // Notify user
    await c.env.NOTIFICATION_QUEUE.send({
      user_id: submission.user_id,
      type: 'cleanify_rejected',
      title: 'Submission Review',
      body: validation.data.note || 'Your cleanify submission was not approved.',
      data: { submission_id: id, reason: validation.data.note },
      timestamp: toISODateString()
    });
    
    return successResponse({
      submission: {
        id,
        status: 'rejected',
        reviewed_at: toISODateString()
      }
    });
  } catch (error) {
    console.error('Reject submission error:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to reject submission', 500);
  }
});

/**
 * GET /v1/cleanify/stats
 * Get cleanify statistics for user or neighborhood
 */
cleanify.get('/stats', authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }
  
  const neighborhoodId = c.req.query('neighborhood_id') || authContext.neighborhoodId;
  
  // Get stats
  const [totalSubmissions, approvedCount, pendingCount, rejectedCount, totalCoinsAwarded] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as count FROM cleanify_submissions WHERE neighborhood_id = ?')
      .bind(neighborhoodId).first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as count FROM cleanify_submissions WHERE neighborhood_id = ? AND status = 'approved'")
      .bind(neighborhoodId).first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as count FROM cleanify_submissions WHERE neighborhood_id = ? AND status = 'pending'")
      .bind(neighborhoodId).first<{ count: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) as count FROM cleanify_submissions WHERE neighborhood_id = ? AND status = 'rejected'")
      .bind(neighborhoodId).first<{ count: number }>(),
    c.env.DB.prepare('SELECT SUM(coins_awarded) as total FROM cleanify_submissions WHERE neighborhood_id = ? AND status = ?')
      .bind(neighborhoodId, 'approved').first<{ total: number }>()
  ]);
  
  // User's personal stats
  const userStats = await c.env.DB.prepare(`
    SELECT COUNT(*) as count, SUM(coins_awarded) as coins
    FROM cleanify_submissions 
    WHERE user_id = ?
  `).bind(authContext.userId).first<{ count: number; coins: number }>();
  
  return successResponse({
    neighborhood: {
      total_submissions: totalSubmissions?.count || 0,
      approved: approvedCount?.count || 0,
      pending: pendingCount?.count || 0,
      rejected: rejectedCount?.count || 0,
      total_coins_awarded: totalCoinsAwarded?.total || 0
    },
    user: {
      total_submissions: userStats?.count || 0,
      coins_earned: userStats?.coins || 0
    }
  });
});

export default cleanify;
