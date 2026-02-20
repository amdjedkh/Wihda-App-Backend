/**
 * Wihda Backend - Campaigns Routes
 * GET /v1/campaigns
 * GET /v1/campaigns/:id
 */

import { Hono } from 'hono';
import type { Env } from '../types';
import { getCampaignsForNeighborhood, getCampaignById } from '../lib/db';
import { successResponse, errorResponse } from '../lib/utils';
import { authMiddleware, getAuthContext, requireNeighborhood } from '../middleware/auth';

const campaigns = new Hono<{ Bindings: Env }>();

/**
 * GET /v1/campaigns
 * List campaigns for user's neighborhood
 */
campaigns.get('/', authMiddleware, requireNeighborhood, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext || !authContext.neighborhoodId) {
    return errorResponse('UNAUTHORIZED', 'Authentication and neighborhood required', 401);
  }
  
  const fromDate = c.req.query('from');
  const toDate = c.req.query('to');
  const limit = parseInt(c.req.query('limit') || '20');
  
  const campaigns = await getCampaignsForNeighborhood(
    c.env.DB,
    authContext.neighborhoodId,
    fromDate,
    toDate,
    limit
  );
  
  const result = campaigns.map(campaign => ({
    id: campaign.id,
    title: campaign.title,
    description: campaign.description,
    organizer: campaign.organizer,
    location: campaign.location,
    location_geo: campaign.location_lat && campaign.location_lng ? {
      lat: campaign.location_lat,
      lng: campaign.location_lng
    } : null,
    start_dt: campaign.start_dt,
    end_dt: campaign.end_dt,
    url: campaign.url,
    image_url: campaign.image_url,
    source: campaign.source,
    status: campaign.status
  }));
  
  return successResponse({
    campaigns: result
  });
});

/**
 * GET /v1/campaigns/:id
 * Get campaign details
 */
campaigns.get('/:id', authMiddleware, async (c) => {
  const id = c.req.param('id');
  
  const campaign = await getCampaignById(c.env.DB, id);
  
  if (!campaign) {
    return errorResponse('NOT_FOUND', 'Campaign not found', 404);
  }
  
  return successResponse({
    id: campaign.id,
    title: campaign.title,
    description: campaign.description,
    organizer: campaign.organizer,
    location: campaign.location,
    location_geo: campaign.location_lat && campaign.location_lng ? {
      lat: campaign.location_lat,
      lng: campaign.location_lng
    } : null,
    start_dt: campaign.start_dt,
    end_dt: campaign.end_dt,
    url: campaign.url,
    image_url: campaign.image_url,
    source: campaign.source,
    status: campaign.status,
    neighborhood_id: campaign.neighborhood_id,
    created_at: campaign.created_at
  });
});

export default campaigns;
