/**
 * Wihda Backend - Upload Routes (R2 Signed URLs)
 * POST /v1/uploads/presigned-url
 * GET /v1/uploads/:key
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { successResponse, errorResponse } from '../lib/utils';
import { authMiddleware, getAuthContext } from '../middleware/auth';

const uploads = new Hono<{ Bindings: Env }>();

const presignedUrlSchema = z.object({
  content_type: z.enum(['before_photo', 'after_photo', 'chat_image', 'campaign_image']),
  file_extension: z.string().regex(/^(jpg|jpeg|png|webp|gif)$/i)
});

/**
 * POST /v1/uploads/presigned-url
 * Generate a presigned URL for direct upload to R2
 */
uploads.post('/presigned-url', authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }
  
  try {
    const body = await c.req.json();
    const validation = presignedUrlSchema.safeParse(body);
    
    if (!validation.success) {
      return errorResponse('VALIDATION_ERROR', 'Invalid request data', 400, validation.error.flatten());
    }
    
    const data = validation.data;
    
    // Generate unique file key
    const timestamp = Date.now();
    const randomId = crypto.randomUUID().split('-')[0];
    const fileKey = `uploads/${authContext.userId}/${data.content_type}/${timestamp}-${randomId}.${data.file_extension}`;
    
    // Create presigned URL for upload
    // R2 doesn't have native presigned URLs like S3, so we'll use a different approach
    // We'll return a URL that points to our upload endpoint with a signed token
    
    const uploadToken = await createUploadToken(
      c.env.JWT_SECRET,
      authContext.userId,
      fileKey,
      data.content_type
    );
    
    // In production, this would be your actual R2 public URL or a worker endpoint
    const uploadUrl = `${new URL(c.req.url).origin}/v1/uploads/direct?token=${uploadToken}`;
    
    // The file will be accessible at this URL after upload
    const fileUrl = `${new URL(c.req.url).origin}/v1/uploads/${fileKey}`;
    
    return successResponse({
      upload_url: uploadUrl,
      file_key: fileKey,
      file_url: fileUrl,
      expires_at: new Date(Date.now() + 3600000).toISOString() // 1 hour
    });
  } catch (error) {
    console.error('Presigned URL error:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to generate upload URL', 500);
  }
});

/**
 * POST /v1/uploads/direct
 * Direct upload endpoint (authenticated via token)
 */
uploads.post('/direct', async (c) => {
  const token = c.req.query('token');
  
  if (!token) {
    return errorResponse('MISSING_TOKEN', 'Upload token is required', 400);
  }
  
  try {
    // Verify upload token
    const payload = await verifyUploadToken(c.env.JWT_SECRET, token);
    
    if (!payload) {
      return errorResponse('INVALID_TOKEN', 'Invalid or expired upload token', 401);
    }
    
    // Get file content from request body
    const contentType = c.req.header('Content-Type') || 'image/jpeg';
    const fileBuffer = await c.req.arrayBuffer();
    
    // Validate file size (max 10MB)
    if (fileBuffer.byteLength > 10 * 1024 * 1024) {
      return errorResponse('FILE_TOO_LARGE', 'File size must be less than 10MB', 400);
    }
    
    // Upload to R2
    await c.env.STORAGE.put(payload.fileKey, fileBuffer, {
      httpMetadata: {
        contentType
      },
      customMetadata: {
        userId: payload.userId,
        contentType: payload.contentType
      }
    });
    
    const fileUrl = `${new URL(c.req.url).origin}/v1/uploads/${payload.fileKey}`;
    
    return successResponse({
      file_key: payload.fileKey,
      file_url: fileUrl,
      size: fileBuffer.byteLength
    });
  } catch (error) {
    console.error('Direct upload error:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to upload file', 500);
  }
});

/**
 * GET /v1/uploads/:key
 * Serve uploaded file from R2
 */
uploads.get('/:key{.*}', async (c) => {
  const key = c.req.param('key');
  
  try {
    const object = await c.env.STORAGE.get(key);
    
    if (!object) {
      return errorResponse('NOT_FOUND', 'File not found', 404);
    }
    
    const headers = new Headers();
    headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg');
    headers.set('Cache-Control', 'public, max-age=31536000'); // 1 year cache
    headers.set('ETag', object.etag);
    
    // Add CORS headers
    headers.set('Access-Control-Allow-Origin', '*');
    
    return new Response(object.body, { headers });
  } catch (error) {
    console.error('File serve error:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to serve file', 500);
  }
});

/**
 * DELETE /v1/uploads/:key
 * Delete uploaded file (owner only)
 */
uploads.delete('/:key{.*}', authMiddleware, async (c) => {
  const authContext = getAuthContext(c);
  if (!authContext) {
    return errorResponse('UNAUTHORIZED', 'Authentication required', 401);
  }
  
  const key = c.req.param('key');
  
  // Verify ownership
  if (!key.startsWith(`uploads/${authContext.userId}/`)) {
    return errorResponse('FORBIDDEN', 'You can only delete your own files', 403);
  }
  
  try {
    await c.env.STORAGE.delete(key);
    
    return successResponse({
      deleted: true,
      file_key: key
    });
  } catch (error) {
    console.error('File delete error:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to delete file', 500);
  }
});

// Helper functions for upload tokens

interface UploadTokenPayload {
  userId: string;
  fileKey: string;
  contentType: string;
  exp: number;
}

async function createUploadToken(
  secret: string,
  userId: string,
  fileKey: string,
  contentType: string
): Promise<string> {
  const encoder = new TextEncoder();
  const payload: UploadTokenPayload = {
    userId,
    fileKey,
    contentType,
    exp: Math.floor(Date.now() / 1000) + 3600 // 1 hour
  };
  
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = btoa(payloadStr);
  
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  
  return `${payloadB64}.${signatureB64}`;
}

async function verifyUploadToken(
  secret: string,
  token: string
): Promise<UploadTokenPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    
    const [payloadB64, signatureB64] = parts;
    const encoder = new TextEncoder();
    
    // Verify signature
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    
    const signature = Uint8Array.from(atob(signatureB64), c => c.charCodeAt(0));
    const isValid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(payloadB64));
    
    if (!isValid) return null;
    
    // Decode payload
    const payload = JSON.parse(atob(payloadB64)) as UploadTokenPayload;
    
    // Check expiration
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    
    return payload;
  } catch {
    return null;
  }
}

export default uploads;
