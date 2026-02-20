/**
 * Wihda Backend - Utility Functions
 */

import { v4 as uuidv4 } from 'uuid';

// ============================================
// UUID Generation
// ============================================

export function generateId(): string {
  return uuidv4();
}

// ============================================
// Password Hashing
// ============================================

/**
 * Hash a password using SHA-256 (for demo purposes)
 * In production, use a proper bcrypt implementation
 */
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + 'wihda-salt');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify a password against a hash
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const passwordHash = await hashPassword(password);
  return passwordHash === hash;
}

// ============================================
// JWT Handling
// ============================================

/**
 * Create a JWT token
 */
export async function createJWT(
  payload: { sub: string; role: string; neighborhood_id: string | null },
  secret: string,
  expiresInHours: number = 24
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInHours * 3600
  };

  const encoder = new TextEncoder();
  const headerB64 = btoa(JSON.stringify(header));
  const payloadB64 = btoa(JSON.stringify(fullPayload));
  
  const signatureInput = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signatureInput));
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  
  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

/**
 * Verify and decode a JWT token
 */
export async function verifyJWT(token: string, secret: string): Promise<{ sub: string; role: string; neighborhood_id: string | null } | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const [headerB64, payloadB64, signatureB64] = parts;
    const encoder = new TextEncoder();
    
    // Verify signature
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    
    const signatureInput = `${headerB64}.${payloadB64}`;
    const signature = Uint8Array.from(atob(signatureB64), c => c.charCodeAt(0));
    const isValid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(signatureInput));
    
    if (!isValid) return null;
    
    // Decode payload
    const payload = JSON.parse(atob(payloadB64));
    
    // Check expiration
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    
    return {
      sub: payload.sub,
      role: payload.role,
      neighborhood_id: payload.neighborhood_id
    };
  } catch {
    return null;
  }
}

// ============================================
// Date Utilities
// ============================================

export function toISODateString(date: Date = new Date()): string {
  return date.toISOString();
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3600000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

// ============================================
// JSON Parsing
// ============================================

export function safeJsonParse<T>(json: string, defaultValue: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return defaultValue;
  }
}

// ============================================
// String Utilities
// ============================================

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ============================================
// Validation
// ============================================

export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export function isValidPhone(phone: string): boolean {
  // Moroccan phone format: +212XXXXXXXXX or 0XXXXXXXXX
  const phoneRegex = /^(\+212|0)[5-7][0-9]{8}$/;
  return phoneRegex.test(phone.replace(/\s/g, ''));
}

export function isValidUUID(uuid: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// ============================================
// Geospatial Utilities
// ============================================

/**
 * Calculate distance between two points using Haversine formula
 * Returns distance in kilometers
 */
export function calculateDistance(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const R = 6371; // Earth's radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

/**
 * Check if a point is within a radius of a center point
 */
export function isWithinRadius(
  pointLat: number, pointLng: number,
  centerLat: number, centerLng: number,
  radiusMeters: number
): boolean {
  const distanceKm = calculateDistance(pointLat, pointLng, centerLat, centerLng);
  return distanceKm * 1000 <= radiusMeters;
}

// ============================================
// Response Helpers
// ============================================

export function jsonResponse<T>(data: T, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

export function errorResponse(code: string, message: string, status: number = 400, details?: Record<string, unknown>): Response {
  return jsonResponse({
    success: false,
    error: { code, message, details }
  }, status);
}

export function successResponse<T>(data: T): Response {
  return jsonResponse({
    success: true,
    data
  });
}

// ============================================
// CORS Headers
// ============================================

export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

export function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}
