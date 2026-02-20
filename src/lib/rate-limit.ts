/**
 * Wihda Backend - Rate Limiting Utilities
 * Uses Cloudflare KV for distributed rate limiting
 */

interface RateLimitConfig {
  windowMs: number;      // Time window in milliseconds
  maxRequests: number;   // Maximum requests per window
  keyPrefix: string;     // Prefix for KV keys
}

// Default rate limit configurations
export const RATE_LIMITS = {
  // Auth endpoints
  login: { windowMs: 60000, maxRequests: 5, keyPrefix: 'rl:login' },
  signup: { windowMs: 3600000, maxRequests: 3, keyPrefix: 'rl:signup' },
  
  // Leftovers
  createOffer: { windowMs: 86400000, maxRequests: 10, keyPrefix: 'rl:offer' },
  createNeed: { windowMs: 86400000, maxRequests: 10, keyPrefix: 'rl:need' },
  
  // Chat
  sendMessage: { windowMs: 60000, maxRequests: 10, keyPrefix: 'rl:chat' },
  
  // Cleanify
  createSubmission: { windowMs: 86400000, maxRequests: 5, keyPrefix: 'rl:cleanify' },
  
  // General API
  api: { windowMs: 60000, maxRequests: 100, keyPrefix: 'rl:api' }
};

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Check and increment rate limit counter
 */
export async function checkRateLimit(
  kv: KVNamespace,
  identifier: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const key = `${config.keyPrefix}:${identifier}`;
  const now = Date.now();
  const windowStart = now - config.windowMs;
  
  // Get current count and window start
  const stored = await kv.get(key, 'json') as { count: number; windowStart: number } | null;
  
  let count = 1;
  let currentWindowStart = now;
  
  if (stored) {
    // Check if we're still in the same window
    if (stored.windowStart > windowStart) {
      // Same window - increment
      count = stored.count + 1;
      currentWindowStart = stored.windowStart;
    }
    // Otherwise, start new window with count = 1
  }
  
  const allowed = count <= config.maxRequests;
  const remaining = Math.max(0, config.maxRequests - count);
  const resetAt = currentWindowStart + config.windowMs;
  
  // Store updated count (with expiration)
  await kv.put(key, JSON.stringify({ count, windowStart: currentWindowStart }), {
    expirationTtl: Math.ceil(config.windowMs / 1000) + 1
  });
  
  return { allowed, remaining, resetAt };
}

/**
 * Rate limit middleware factory
 */
export function createRateLimiter(
  configKey: keyof typeof RATE_LIMITS,
  identifierFn: (c: any) => string
) {
  return async (c: any, next: () => Promise<void>) => {
    const config = RATE_LIMITS[configKey];
    const identifier = identifierFn(c);
    
    const result = await checkRateLimit(c.env.KV, identifier, config);
    
    // Add rate limit headers
    c.header('X-RateLimit-Limit', config.maxRequests.toString());
    c.header('X-RateLimit-Remaining', result.remaining.toString());
    c.header('X-RateLimit-Reset', result.resetAt.toString());
    
    if (!result.allowed) {
      return c.json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests. Please try again later.',
          details: {
            reset_at: new Date(result.resetAt).toISOString()
          }
        }
      }, 429);
    }
    
    await next();
  };
}

/**
 * Check pair repetition for anti-abuse
 */
export async function checkPairRepetition(
  db: D1Database,
  userId1: string,
  userId2: string,
  daysWindow: number = 7
): Promise<{ count: number; flagged: boolean }> {
  const result = await db.prepare(`
    SELECT COUNT(*) as count FROM match_history
    WHERE ((user_1_id = ? AND user_2_id = ?) OR (user_1_id = ? AND user_2_id = ?))
    AND closed_at > datetime('now', '-' || ? || ' days')
  `).bind(userId1, userId2, userId2, userId1, daysWindow).first<{ count: number }>();
  
  const count = result?.count || 0;
  
  // Flag if more than 5 matches between same pair in window
  const flagged = count >= 5;
  
  return { count, flagged };
}

/**
 * Record match in history for pair tracking
 */
export async function recordMatchHistory(
  db: D1Database,
  matchId: string,
  userId1: string,
  userId2: string,
  wasSuccessful: boolean
): Promise<void> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  
  await db.prepare(`
    INSERT INTO match_history (id, user_1_id, user_2_id, match_id, closed_at, was_successful, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    userId1 < userId2 ? userId1 : userId2,
    userId1 < userId2 ? userId2 : userId1,
    matchId,
    now,
    wasSuccessful ? 1 : 0,
    now
  ).run();
}

/**
 * Simple abuse flagging in KV
 */
export async function checkAbuseFlag(
  kv: KVNamespace,
  userId: string
): Promise<{ flagged: boolean; reason?: string }> {
  const flag = await kv.get(`abuse:${userId}`, 'json') as { reason: string; flagged_at: string } | null;
  
  if (flag) {
    return { flagged: true, reason: flag.reason };
  }
  
  return { flagged: false };
}

export async function setAbuseFlag(
  kv: KVNamespace,
  userId: string,
  reason: string,
  ttlSeconds: number = 86400 // 24 hours default
): Promise<void> {
  await kv.put(`abuse:${userId}`, JSON.stringify({
    reason,
    flagged_at: new Date().toISOString()
  }), {
    expirationTtl: ttlSeconds
  });
}

export async function clearAbuseFlag(
  kv: KVNamespace,
  userId: string
): Promise<void> {
  await kv.delete(`abuse:${userId}`);
}
