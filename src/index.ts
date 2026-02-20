/**
 * Wihda Backend - Main Entry Point
 * Cloudflare Workers API Server
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, MatchingQueueMessage, CampaignQueueMessage, NotificationQueueMessage } from './types';

// Import routes
import authRoutes from './routes/auth';
import userRoutes from './routes/user';
import neighborhoodRoutes from './routes/neighborhood';
import leftoversRoutes from './routes/leftovers';
import chatRoutes from './routes/chat';
import cleanifyRoutes from './routes/cleanify';
import campaignsRoutes from './routes/campaigns';
import uploadsRoutes from './routes/uploads';

// Import queue handlers
import { handleMatchingQueue } from './queues/matching';
import { handleCampaignQueue, handleScheduledCampaignIngestion } from './queues/campaign';
import { handleNotificationQueue, getNotificationHistory, markNotificationsRead } from './queues/notification';

// Import Durable Object
import { ChatThreadDurableObject } from './durable-objects/ChatThreadDurableObject';

// Create main app
const app = new Hono<{ Bindings: Env }>();

// CORS middleware
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
}));

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'wihda-backend',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// OpenAPI spec endpoint
app.get('/openapi.json', (c) => {
  return c.json(getOpenAPISpec());
});

// API version info
app.get('/v1', (c) => {
  return c.json({
    name: 'Wihda API',
    version: '1.0.0',
    endpoints: {
      auth: '/v1/auth',
      user: '/v1/me',
      neighborhoods: '/v1/neighborhoods',
      leftovers: '/v1/leftovers',
      chats: '/v1/chats',
      cleanify: '/v1/cleanify',
      campaigns: '/v1/campaigns',
      uploads: '/v1/uploads',
      notifications: '/v1/notifications'
    }
  });
});

// Mount routes under /v1
app.route('/v1/auth', authRoutes);
app.route('/v1/me', userRoutes);
app.route('/v1/neighborhoods', neighborhoodRoutes);
app.route('/v1/leftovers', leftoversRoutes);
app.route('/v1/chats', chatRoutes);
app.route('/v1/cleanify', cleanifyRoutes);
app.route('/v1/campaigns', campaignsRoutes);
app.route('/v1/uploads', uploadsRoutes);

// Notification routes
app.get('/v1/notifications', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }
  
  const { verifyJWT } = await import('./lib/utils');
  const token = authHeader.substring(7);
  const payload = await verifyJWT(token, c.env.JWT_SECRET);
  
  if (!payload) {
    return c.json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid token' } }, 401);
  }
  
  const limit = parseInt(c.req.query('limit') || '20');
  const unreadOnly = c.req.query('unread_only') === 'true';
  
  const { notifications, hasMore } = await getNotificationHistory(c.env.DB, payload.sub, limit, unreadOnly);
  
  return c.json({
    success: true,
    data: {
      notifications,
      has_more: hasMore
    }
  });
});

app.post('/v1/notifications/read', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }
  
  const { verifyJWT } = await import('./lib/utils');
  const token = authHeader.substring(7);
  const payload = await verifyJWT(token, c.env.JWT_SECRET);
  
  if (!payload) {
    return c.json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid token' } }, 401);
  }
  
  const body = await c.req.json().catch(() => ({}));
  const ids = body.notification_ids as string[] | undefined;
  
  const count = await markNotificationsRead(c.env.DB, payload.sub, ids);
  
  return c.json({
    success: true,
    data: {
      marked_read: count
    }
  });
});

// 404 handler
app.notFound((c) => {
  return c.json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Endpoint not found'
    }
  }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Error:', err);
  return c.json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: err.message || 'An unexpected error occurred'
    }
  }, 500);
});

// Export Durable Object
export { ChatThreadDurableObject };

// Export the main fetch handler
export default {
  // Main HTTP handler
  fetch: app.fetch,
  
  // Queue handlers
  async queue(batch: MessageBatch, env: Env, _ctx: ExecutionContext) {
    // Determine queue type and route to appropriate handler
    if (batch.queue === 'wihda-matching-queue') {
      await handleMatchingQueue(batch as MessageBatch<MatchingQueueMessage>, env);
    } else if (batch.queue === 'wihda-campaign-queue') {
      await handleCampaignQueue(batch as MessageBatch<CampaignQueueMessage>, env);
    } else if (batch.queue === 'wihda-notification-queue') {
      await handleNotificationQueue(batch as MessageBatch<NotificationQueueMessage>, env);
    }
  },
  
  // Scheduled handler (cron)
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    // Campaign ingestion runs every 12 hours
    await handleScheduledCampaignIngestion(env);
    
    // Could also run:
    // - Expire old leftover offers
    // - Clean up old chat threads
    // - Generate analytics
  }
};

// OpenAPI specification generator
function getOpenAPISpec() {
  return {
    openapi: '3.0.0',
    info: {
      title: 'Wihda API',
      version: '1.0.0',
      description: 'Backend API for Wihda neighborhood civic application'
    },
    servers: [
      {
        url: '/v1',
        description: 'API v1'
      }
    ],
    paths: {
      '/auth/signup': {
        post: {
          summary: 'Create new user account',
          tags: ['Auth'],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['password', 'display_name'],
                  properties: {
                    email: { type: 'string', format: 'email' },
                    phone: { type: 'string' },
                    password: { type: 'string', minLength: 8 },
                    display_name: { type: 'string', minLength: 2 }
                  }
                }
              }
            }
          },
          responses: {
            '200': { description: 'Account created' },
            '400': { description: 'Validation error' },
            '409': { description: 'Email or phone already exists' }
          }
        }
      },
      '/auth/login': {
        post: {
          summary: 'Authenticate user',
          tags: ['Auth'],
          responses: {
            '200': { description: 'Authentication successful' },
            '401': { description: 'Invalid credentials' }
          }
        }
      },
      '/me': {
        get: {
          summary: 'Get current user profile',
          tags: ['User'],
          security: [{ bearerAuth: [] }],
          responses: {
            '200': { description: 'User profile' },
            '401': { description: 'Unauthorized' }
          }
        }
      },
      '/neighborhoods/lookup': {
        get: {
          summary: 'Search neighborhoods',
          tags: ['Neighborhoods'],
          parameters: [
            { name: 'city', in: 'query', schema: { type: 'string' } },
            { name: 'lat', in: 'query', schema: { type: 'number' } },
            { name: 'lng', in: 'query', schema: { type: 'number' } }
          ],
          responses: {
            '200': { description: 'List of neighborhoods' }
          }
        }
      },
      '/neighborhoods/join': {
        post: {
          summary: 'Join a neighborhood',
          tags: ['Neighborhoods'],
          security: [{ bearerAuth: [] }],
          responses: {
            '200': { description: 'Joined successfully' }
          }
        }
      },
      '/leftovers/offers': {
        get: {
          summary: 'List leftover offers',
          tags: ['Leftovers'],
          security: [{ bearerAuth: [] }]
        },
        post: {
          summary: 'Create leftover offer',
          tags: ['Leftovers'],
          security: [{ bearerAuth: [] }]
        }
      },
      '/leftovers/needs': {
        get: {
          summary: 'List leftover needs',
          tags: ['Leftovers'],
          security: [{ bearerAuth: [] }]
        },
        post: {
          summary: 'Create leftover need',
          tags: ['Leftovers'],
          security: [{ bearerAuth: [] }]
        }
      },
      '/leftovers/matches': {
        get: {
          summary: 'List user matches',
          tags: ['Leftovers'],
          security: [{ bearerAuth: [] }]
        }
      },
      '/chats': {
        get: {
          summary: 'List chat threads',
          tags: ['Chat'],
          security: [{ bearerAuth: [] }]
        }
      },
      '/cleanify/submissions': {
        get: {
          summary: 'List cleanify submissions',
          tags: ['Cleanify'],
          security: [{ bearerAuth: [] }]
        },
        post: {
          summary: 'Create cleanify submission',
          tags: ['Cleanify'],
          security: [{ bearerAuth: [] }]
        }
      },
      '/campaigns': {
        get: {
          summary: 'List campaigns',
          tags: ['Campaigns'],
          security: [{ bearerAuth: [] }]
        }
      }
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      }
    }
  };
}
