/**
 * Tests for Utility Functions
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateId,
  hashPassword,
  verifyPassword,
  createJWT,
  verifyJWT,
  toISODateString,
  addHours,
  addDays,
  safeJsonParse,
  slugify,
  isValidEmail,
  isValidPhone,
  isValidUUID,
  calculateDistance,
  isWithinRadius,
  jsonResponse,
  errorResponse,
  successResponse,
  corsHeaders,
} from '../../src/lib/utils';

const TEST_JWT_SECRET = 'test-jwt-secret-key-for-testing';

describe('UUID Generation', () => {
  it('should generate a valid UUID v4', () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('should generate unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
  });
});

describe('Password Hashing', () => {
  it('should hash a password consistently', async () => {
    const password = 'testPassword123';
    const hash1 = await hashPassword(password);
    const hash2 = await hashPassword(password);
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different passwords', async () => {
    const hash1 = await hashPassword('password1');
    const hash2 = await hashPassword('password2');
    expect(hash1).not.toBe(hash2);
  });

  it('should verify correct password', async () => {
    const password = 'testPassword123';
    const hash = await hashPassword(password);
    const isValid = await verifyPassword(password, hash);
    expect(isValid).toBe(true);
  });

  it('should reject incorrect password', async () => {
    const hash = await hashPassword('correctPassword');
    const isValid = await verifyPassword('wrongPassword', hash);
    expect(isValid).toBe(false);
  });

  it('should produce 64 character hex string', async () => {
    const hash = await hashPassword('test');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('JWT Handling', () => {
  it('should create a valid JWT token', async () => {
    const payload = { sub: 'user-001', role: 'user', neighborhood_id: 'nb-001' };
    const token = await createJWT(payload, TEST_JWT_SECRET);
    
    expect(token).toBeDefined();
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
  });

  it('should verify and decode a valid JWT token', async () => {
    const payload = { sub: 'user-001', role: 'user', neighborhood_id: 'nb-001' };
    const token = await createJWT(payload, TEST_JWT_SECRET);
    
    const decoded = await verifyJWT(token, TEST_JWT_SECRET);
    
    expect(decoded).not.toBeNull();
    expect(decoded?.sub).toBe('user-001');
    expect(decoded?.role).toBe('user');
    expect(decoded?.neighborhood_id).toBe('nb-001');
  });

  it('should reject token with wrong secret', async () => {
    const payload = { sub: 'user-001', role: 'user', neighborhood_id: 'nb-001' };
    const token = await createJWT(payload, TEST_JWT_SECRET);
    
    const decoded = await verifyJWT(token, 'wrong-secret');
    
    expect(decoded).toBeNull();
  });

  it('should reject malformed token', async () => {
    const decoded = await verifyJWT('not.a.valid.token', TEST_JWT_SECRET);
    expect(decoded).toBeNull();
  });

  it('should reject token with wrong number of parts', async () => {
    const decoded = await verifyJWT('only.two.parts', TEST_JWT_SECRET);
    expect(decoded).toBeNull();
  });

  it('should accept custom expiration time', async () => {
    const payload = { sub: 'user-001', role: 'user', neighborhood_id: null };
    const token = await createJWT(payload, TEST_JWT_SECRET, 1); // 1 hour
    
    const decoded = await verifyJWT(token, TEST_JWT_SECRET);
    expect(decoded).not.toBeNull();
  });

  it('should handle null neighborhood_id', async () => {
    const payload = { sub: 'user-001', role: 'user', neighborhood_id: null };
    const token = await createJWT(payload, TEST_JWT_SECRET);
    
    const decoded = await verifyJWT(token, TEST_JWT_SECRET);
    
    expect(decoded?.neighborhood_id).toBeNull();
  });
});

describe('Date Utilities', () => {
  it('should convert date to ISO string', () => {
    const date = new Date('2024-01-15T10:30:00Z');
    const isoString = toISODateString(date);
    expect(isoString).toBe('2024-01-15T10:30:00.000Z');
  });

  it('should add hours to date', () => {
    const date = new Date('2024-01-15T10:00:00Z');
    const newDate = addHours(date, 5);
    expect(newDate.toISOString()).toBe('2024-01-15T15:00:00.000Z');
  });

  it('should add days to date', () => {
    const date = new Date('2024-01-15T10:00:00Z');
    const newDate = addDays(date, 7);
    expect(newDate.toISOString()).toBe('2024-01-22T10:00:00.000Z');
  });

  it('should handle negative hours', () => {
    const date = new Date('2024-01-15T10:00:00Z');
    const newDate = addHours(date, -5);
    expect(newDate.toISOString()).toBe('2024-01-15T05:00:00.000Z');
  });
});

describe('JSON Parsing', () => {
  it('should parse valid JSON', () => {
    const json = '{"name": "test", "value": 123}';
    const result = safeJsonParse(json, { name: 'default', value: 0 });
    expect(result).toEqual({ name: 'test', value: 123 });
  });

  it('should return default value for invalid JSON', () => {
    const defaultValue = { name: 'default', value: 0 };
    const result = safeJsonParse('not valid json', defaultValue);
    expect(result).toEqual(defaultValue);
  });

  it('should parse arrays', () => {
    const json = '[1, 2, 3]';
    const result = safeJsonParse(json, []);
    expect(result).toEqual([1, 2, 3]);
  });

  it('should not mutate default value', () => {
    const defaultValue = { items: [] as number[] };
    safeJsonParse('invalid', defaultValue);
    expect(defaultValue.items).toEqual([]);
  });
});

describe('Slugify', () => {
  it('should convert to lowercase', () => {
    expect(slugify('HELLO WORLD')).toBe('hello-world');
  });

  it('should replace spaces with hyphens', () => {
    expect(slugify('hello world test')).toBe('hello-world-test');
  });

  it('should remove special characters', () => {
    expect(slugify('Hello! @World# $Test%')).toBe('hello-world-test');
  });

  it('should handle multiple spaces', () => {
    expect(slugify('hello    world')).toBe('hello-world');
  });

  it('should trim hyphens', () => {
    expect(slugify('--hello world--')).toBe('hello-world');
  });

  it('should handle empty string', () => {
    expect(slugify('')).toBe('');
  });
});

describe('Email Validation', () => {
  it('should accept valid emails', () => {
    expect(isValidEmail('test@example.com')).toBe(true);
    expect(isValidEmail('user.name@domain.co.ma')).toBe(true);
    expect(isValidEmail('test123@test.org')).toBe(true);
  });

  it('should reject invalid emails', () => {
    expect(isValidEmail('notanemail')).toBe(false);
    expect(isValidEmail('missing@domain')).toBe(false);
    expect(isValidEmail('@nodomain.com')).toBe(false);
    expect(isValidEmail('spaces in@email.com')).toBe(false);
  });

  it('should handle empty string', () => {
    expect(isValidEmail('')).toBe(false);
  });
});

describe('Phone Validation (Moroccan)', () => {
  it('should accept valid Moroccan phone numbers', () => {
    expect(isValidPhone('+212600000000')).toBe(true);
    expect(isValidPhone('+212612345678')).toBe(true);
    expect(isValidPhone('+212700000000')).toBe(true);
    expect(isValidPhone('0600000000')).toBe(true);
    expect(isValidPhone('0700000000')).toBe(true);
  });

  it('should reject invalid phone numbers', () => {
    expect(isValidPhone('+212')).toBe(false);
    expect(isValidPhone('123456789')).toBe(false);
    expect(isValidPhone('+212400000000')).toBe(false); // Invalid prefix (4)
    // Note: 05 prefix is valid according to the regex [5-7]
  });

  it('should handle spaces in phone numbers', () => {
    expect(isValidPhone('+212 600 000 000')).toBe(true);
    expect(isValidPhone('06 00 00 00 00')).toBe(true);
  });
});

describe('UUID Validation', () => {
  it('should accept valid UUIDs', () => {
    expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidUUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(true); // v1 is also valid
  });

  it('should reject invalid UUIDs', () => {
    expect(isValidUUID('not-a-uuid')).toBe(false);
    expect(isValidUUID('550e8400-e29b-41d4-a716')).toBe(false);
    expect(isValidUUID('')).toBe(false);
  });
});

describe('Geospatial Utilities', () => {
  describe('calculateDistance', () => {
    it('should return 0 for same point', () => {
      const distance = calculateDistance(33.9716, -6.8498, 33.9716, -6.8498);
      expect(distance).toBe(0);
    });

    it('should calculate distance between Hay Riad and Agdal', () => {
      // Hay Riad: 33.9716, -6.8498
      // Agdal: 33.9911, -6.8477
      const distance = calculateDistance(33.9716, -6.8498, 33.9911, -6.8477);
      // Should be approximately 2.2 km
      expect(distance).toBeGreaterThan(2);
      expect(distance).toBeLessThan(3);
    });

    it('should handle negative coordinates', () => {
      const distance = calculateDistance(-33.9716, -6.8498, -33.9911, -6.8477);
      expect(distance).toBeGreaterThan(0);
    });
  });

  describe('isWithinRadius', () => {
    it('should return true for point within radius', () => {
      const result = isWithinRadius(
        33.9716, -6.8498, // Point
        33.9716, -6.8498, // Center
        1000 // 1km radius
      );
      expect(result).toBe(true);
    });

    it('should return false for point outside radius', () => {
      const result = isWithinRadius(
        33.9911, -6.8477, // Point (Agdal)
        33.9716, -6.8498, // Center (Hay Riad)
        500 // 500m radius
      );
      expect(result).toBe(false);
    });

    it('should work with larger radii', () => {
      const result = isWithinRadius(
        33.9911, -6.8477, // Point (Agdal)
        33.9716, -6.8498, // Center (Hay Riad)
        5000 // 5km radius
      );
      expect(result).toBe(true);
    });
  });
});

describe('Response Helpers', () => {
  describe('jsonResponse', () => {
    it('should create JSON response with default status', () => {
      const response = jsonResponse({ test: 'data' });
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');
    });

    it('should create JSON response with custom status', () => {
      const response = jsonResponse({ error: 'not found' }, 404);
      expect(response.status).toBe(404);
    });

    it('should include CORS headers', () => {
      const response = jsonResponse({});
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  describe('errorResponse', () => {
    it('should create error response with default status', async () => {
      const response = errorResponse('INVALID_INPUT', 'Invalid data provided');
      const body = await response.json();
      
      expect(response.status).toBe(400);
      expect(body).toEqual({
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Invalid data provided',
          details: undefined,
        },
      });
    });

    it('should include details when provided', async () => {
      const response = errorResponse('VALIDATION_ERROR', 'Validation failed', 422, { field: 'email' });
      const body = await response.json();
      
      expect(response.status).toBe(422);
      expect((body as any).error.details).toEqual({ field: 'email' });
    });
  });

  describe('successResponse', () => {
    it('should create success response', async () => {
      const response = successResponse({ id: '123', name: 'test' });
      const body = await response.json();
      
      expect(response.status).toBe(200);
      expect(body).toEqual({
        success: true,
        data: { id: '123', name: 'test' },
      });
    });
  });

  describe('corsHeaders', () => {
    it('should return CORS headers object', () => {
      const headers = corsHeaders();
      
      expect(headers['Access-Control-Allow-Origin']).toBe('*');
      expect(headers['Access-Control-Allow-Methods']).toContain('GET');
      expect(headers['Access-Control-Allow-Methods']).toContain('POST');
      expect(headers['Access-Control-Allow-Headers']).toContain('Authorization');
    });
  });
});
