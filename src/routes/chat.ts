/**
 * Wihda Backend - Chat Routes
 * GET /v1/chats/:thread_id
 * GET /v1/chats/:thread_id/messages
 * POST /v1/chats/:thread_id/messages
 * GET /v1/chats (list threads)
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import {
  getChatThreadById,
  getChatThreadsForUser,
  getChatMessages,
  createChatMessage,
  getMatchById
} from '../lib/db';
import { successResponse, errorResponse, toISODateString } from '../lib/utils';
import { authMiddleware, getAuthContext } from '../middleware/auth';

const chat = new Hono<{ Bindings: Env }>();

const sendMessageSchema = z.object({
  body: z.string().min(1).max(2000),
  message_type: z.enum(['text', 'image', 'location']).default('text'),
  media_url: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional()
});

/**
 * GET /v1/chats
 * List user's chat threads
 */
chat.get('/', authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }
  
  const threads = await getChatThreadsForUser(c.env.DB, authContext.userId);
  
  // Enrich with match and user info
  const enrichedThreads = await Promise.all(threads.map(async (thread) => {
    await getMatchById(c.env.DB, thread.match_id); // Ensure match exists
    const otherUserId = thread.participant_1_id === authContext.userId
      ? thread.participant_2_id
      : thread.participant_1_id;
    
    const otherUser = await c.env.DB.prepare('SELECT id, display_name FROM users WHERE id = ?')
      .bind(otherUserId).first<{ id: string; display_name: string }>();
    
    // Get last message
    const lastMessage = await c.env.DB.prepare(`
      SELECT body, created_at FROM chat_messages 
      WHERE thread_id = ? AND deleted_at IS NULL 
      ORDER BY created_at DESC LIMIT 1
    `).bind(thread.id).first<{ body: string; created_at: string }>();
    
    return {
      id: thread.id,
      match_id: thread.match_id,
      other_user: otherUser,
      last_message: lastMessage ? {
        body: lastMessage.body.substring(0, 100),
        created_at: lastMessage.created_at
      } : null,
      status: thread.status,
      created_at: thread.created_at
    };
  }));
  
  return successResponse({
    threads: enrichedThreads
  });
});

/**
 * GET /v1/chats/:thread_id
 * Get thread metadata
 */
chat.get('/:thread_id', authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }
  
  const threadId = c.req.param('thread_id');
  const thread = await getChatThreadById(c.env.DB, threadId);
  
  if (!thread) {
    return errorResponse('NOT_FOUND', 'Chat thread not found', 404);
  }
  
  // Verify user is a participant
  if (thread.participant_1_id !== authContext.userId && thread.participant_2_id !== authContext.userId) {
    // Check if moderator
    if (authContext.userRole !== 'moderator' && authContext.userRole !== 'admin') {
      return errorResponse('FORBIDDEN', 'You do not have access to this thread', 403);
    }
  }
  
  const match = await getMatchById(c.env.DB, thread.match_id);
  const otherUserId = thread.participant_1_id === authContext.userId
    ? thread.participant_2_id
    : thread.participant_1_id;
  
  const otherUser = await c.env.DB.prepare('SELECT id, display_name FROM users WHERE id = ?')
    .bind(otherUserId).first<{ id: string; display_name: string }>();
  
  return successResponse({
    id: thread.id,
    match_id: thread.match_id,
    match: match ? {
      id: match.id,
      status: match.status,
      score: match.score
    } : null,
    other_user: otherUser,
    participants: [thread.participant_1_id, thread.participant_2_id],
    status: thread.status,
    created_at: thread.created_at,
    closed_at: thread.closed_at
  });
});

/**
 * GET /v1/chats/:thread_id/messages
 * Get paginated messages
 */
chat.get('/:thread_id/messages', authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }
  
  const threadId = c.req.param('thread_id');
  const cursor = c.req.query('cursor');
  const limit = parseInt(c.req.query('limit') || '50');
  
  const thread = await getChatThreadById(c.env.DB, threadId);
  
  if (!thread) {
    return errorResponse('NOT_FOUND', 'Chat thread not found', 404);
  }
  
  // Verify access
  if (thread.participant_1_id !== authContext.userId && thread.participant_2_id !== authContext.userId) {
    if (authContext.userRole !== 'moderator' && authContext.userRole !== 'admin') {
      return errorResponse('FORBIDDEN', 'You do not have access to this thread', 403);
    }
  }
  
  const { messages, hasMore } = await getChatMessages(c.env.DB, threadId, limit, cursor);
  
  // Mark messages as read
  await c.env.DB.prepare(`
    UPDATE chat_messages 
    SET read_at = ? 
    WHERE thread_id = ? AND sender_id != ? AND read_at IS NULL
  `).bind(toISODateString(), threadId, authContext.userId).run();
  
  // Enrich messages with sender names
  const enrichedMessages = await Promise.all(messages.map(async (msg) => {
    const sender = await c.env.DB.prepare('SELECT display_name FROM users WHERE id = ?')
      .bind(msg.sender_id).first<{ display_name: string }>();
    
    return {
      id: msg.id,
      sender_id: msg.sender_id,
      sender_name: sender?.display_name || 'Unknown',
      body: msg.body,
      message_type: msg.message_type,
      media_url: msg.media_url,
      read_at: msg.read_at,
      created_at: msg.created_at
    };
  }));
  
  return successResponse({
    messages: enrichedMessages,
    has_more: hasMore,
    next_cursor: hasMore && enrichedMessages.length > 0 
      ? enrichedMessages[0].created_at 
      : null
  });
});

/**
 * POST /v1/chats/:thread_id/messages
 * Send a message
 */
chat.post('/:thread_id/messages', authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }
  
  const threadId = c.req.param('thread_id');
  
  const thread = await getChatThreadById(c.env.DB, threadId);
  
  if (!thread) {
    return errorResponse('NOT_FOUND', 'Chat thread not found', 404);
  }
  
  // Verify user is a participant
  if (thread.participant_1_id !== authContext.userId && thread.participant_2_id !== authContext.userId) {
    return errorResponse('FORBIDDEN', 'You are not a participant in this thread', 403);
  }
  
  // Check if thread is closed
  if (thread.status !== 'active') {
    return errorResponse('THREAD_CLOSED', 'This chat thread is closed', 400);
  }
  
  try {
    const body = await c.req.json();
    const validation = sendMessageSchema.safeParse(body);
    
    if (!validation.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid message data', 400, validation.error.flatten());
    }
    
    const data = validation.data;
    
    const message = await createChatMessage(c.env.DB, {
      threadId,
      senderId: authContext.userId,
      body: data.body,
      messageType: data.message_type,
      mediaUrl: data.media_url,
      metadata: data.metadata ? JSON.stringify(data.metadata) : undefined
    });
    
    // Notify the other participant via Durable Object
    const otherUserId = thread.participant_1_id === authContext.userId
      ? thread.participant_2_id
      : thread.participant_1_id;
    
    // Get Durable Object for real-time notification
    const doId = c.env.CHAT_DO.idFromName(threadId);
    void c.env.CHAT_DO.get(doId); // Initialize DO for potential real-time updates
    
    // Send notification to queue
    await c.env.NOTIFICATION_QUEUE.send({
      user_id: otherUserId,
      type: 'new_message',
      title: 'New Message',
      body: data.body.substring(0, 100),
      data: { thread_id: threadId, message_id: message.id },
      timestamp: toISODateString()
    });
    
    return successResponse({
      message: {
        id: message.id,
        thread_id: message.thread_id,
        sender_id: message.sender_id,
        body: message.body,
        message_type: message.message_type,
        media_url: message.media_url,
        created_at: message.created_at
      }
    });
  } catch (error) {
    console.error('Send message error:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to send message', 500);
  }
});

/**
 * GET /v1/chats/:thread_id/ws
 * WebSocket endpoint for real-time chat
 */
chat.get('/:thread_id/ws', async (c) => {
  const threadId = c.req.param('thread_id');
  const token = c.req.query('token');
  
  if (!token) {
    return errorResponse('MISSING_TOKEN', 'Token is required for WebSocket connection', 401);
  }
  
  // Verify token
  const { verifyJWT } = await import('../lib/utils');
  const payload = await verifyJWT(token, c.env.JWT_SECRET);
  
  if (!payload) {
    return errorResponse('INVALID_TOKEN', 'Invalid or expired token', 401);
  }
  
  const thread = await getChatThreadById(c.env.DB, threadId);
  
  if (!thread) {
    return errorResponse('NOT_FOUND', 'Chat thread not found', 404);
  }
  
  // Verify user is a participant
  if (thread.participant_1_id !== payload.sub && thread.participant_2_id !== payload.sub) {
    return errorResponse('FORBIDDEN', 'You are not a participant in this thread', 403);
  }
  
  // Get Durable Object and forward WebSocket
  const doId = c.env.CHAT_DO.idFromName(threadId);
  const stub = c.env.CHAT_DO.get(doId);
  
  // Forward to Durable Object
  const url = new URL(c.req.url);
  url.pathname = '/ws';
  
  return stub.fetch(url.toString(), {
    headers: {
      'X-User-Id': payload.sub,
      'X-Thread-Id': threadId
    }
  });
});

export default chat;
