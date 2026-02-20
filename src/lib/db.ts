/**
 * Wihda Backend - Database Helper Functions
 * D1 (SQLite) query utilities
 */

import type { User, Neighborhood, UserNeighborhood, CoinLedgerEntry, LeftoverOffer, LeftoverNeed, Match, ChatThread, ChatMessage, CleanifySubmission, Campaign, CoinRule } from '../types';
import { generateId, toISODateString } from './utils';

// ============================================
// User Operations
// ============================================

export async function createUser(
  db: D1Database,
  data: {
    email?: string;
    phone?: string;
    passwordHash: string;
    displayName: string;
    languagePreference?: string;
  }
): Promise<User> {
  const id = generateId();
  const now = toISODateString();
  
  await db.prepare(`
    INSERT INTO users (id, email, phone, password_hash, display_name, language_preference, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    data.email || null,
    data.phone || null,
    data.passwordHash,
    data.displayName,
    data.languagePreference || 'fr',
    now,
    now
  ).run();
  
  return getUserById(db, id) as Promise<User>;
}

export async function getUserById(db: D1Database, id: string): Promise<User | null> {
  const result = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>();
  return result;
}

export async function getUserByEmail(db: D1Database, email: string): Promise<User | null> {
  const result = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<User>();
  return result;
}

export async function getUserByPhone(db: D1Database, phone: string): Promise<User | null> {
  const result = await db.prepare('SELECT * FROM users WHERE phone = ?').bind(phone).first<User>();
  return result;
}

export async function updateUser(
  db: D1Database,
  id: string,
  data: { displayName?: string; languagePreference?: string; fcmToken?: string }
): Promise<User | null> {
  const updates: string[] = [];
  const values: (string | null)[] = [];
  
  if (data.displayName !== undefined) {
    updates.push('display_name = ?');
    values.push(data.displayName);
  }
  if (data.languagePreference !== undefined) {
    updates.push('language_preference = ?');
    values.push(data.languagePreference);
  }
  if (data.fcmToken !== undefined) {
    updates.push('fcm_token = ?');
    values.push(data.fcmToken);
  }
  
  if (updates.length === 0) return getUserById(db, id);
  
  updates.push('updated_at = ?');
  values.push(toISODateString());
  values.push(id);
  
  await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
  
  return getUserById(db, id);
}

// ============================================
// Neighborhood Operations
// ============================================

export async function getNeighborhoodById(db: D1Database, id: string): Promise<Neighborhood | null> {
  const result = await db.prepare('SELECT * FROM neighborhoods WHERE id = ?').bind(id).first<Neighborhood>();
  return result;
}

export async function getNeighborhoodsByCity(db: D1Database, city: string): Promise<Neighborhood[]> {
  const result = await db.prepare('SELECT * FROM neighborhoods WHERE city = ? AND is_active = 1').bind(city).all<Neighborhood>();
  return result.results;
}

export async function getNeighborhoodsNearLocation(
  db: D1Database,
  lat: number,
  lng: number
): Promise<Neighborhood[]> {
  // Get all active neighborhoods and filter by distance
  const result = await db.prepare('SELECT * FROM neighborhoods WHERE is_active = 1').all<Neighborhood>();
  
  // Filter by distance (simplified - in production use proper geo queries)
  return result.results.filter(n => {
    if (!n.center_lat || !n.center_lng || !n.radius_meters) return false;
    
    const distance = Math.sqrt(
      Math.pow((n.center_lat - lat) * 111, 2) +
      Math.pow((n.center_lng - lng) * 111 * Math.cos(lat * Math.PI / 180), 2)
    ) * 1000;
    
    return distance <= n.radius_meters;
  });
}

// ============================================
// User Neighborhood Membership
// ============================================

export async function getUserNeighborhood(db: D1Database, userId: string): Promise<UserNeighborhood | null> {
  const result = await db.prepare(`
    SELECT * FROM user_neighborhoods 
    WHERE user_id = ? AND left_at IS NULL AND is_primary = 1
  `).bind(userId).first<UserNeighborhood>();
  
  return result;
}

export async function joinNeighborhood(
  db: D1Database,
  userId: string,
  neighborhoodId: string
): Promise<UserNeighborhood> {
  const id = generateId();
  const now = toISODateString();
  
  // Leave any existing primary neighborhood
  await db.prepare(`
    UPDATE user_neighborhoods 
    SET left_at = ?, is_primary = 0 
    WHERE user_id = ? AND left_at IS NULL
  `).bind(now, userId).run();
  
  // Create new membership
  await db.prepare(`
    INSERT INTO user_neighborhoods (id, user_id, neighborhood_id, joined_at, is_primary)
    VALUES (?, ?, ?, ?, 1)
  `).bind(id, userId, neighborhoodId, now).run();
  
  return {
    id,
    user_id: userId,
    neighborhood_id: neighborhoodId,
    joined_at: now,
    left_at: null,
    is_primary: 1
  };
}

// ============================================
// Coin Ledger Operations
// ============================================

export async function getCoinBalance(db: D1Database, userId: string): Promise<number> {
  const result = await db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as balance 
    FROM coin_ledger_entries 
    WHERE user_id = ? AND status = 'valid'
  `).bind(userId).first<{ balance: number }>();
  
  return result?.balance || 0;
}

export async function getCoinLedgerEntries(
  db: D1Database,
  userId: string,
  limit: number = 50,
  cursor?: string
): Promise<{ entries: CoinLedgerEntry[]; hasMore: boolean }> {
  let query = `
    SELECT * FROM coin_ledger_entries 
    WHERE user_id = ? AND status = 'valid'
  `;
  const params: (string | number)[] = [userId];
  
  if (cursor) {
    query += ' AND created_at < ?';
    params.push(cursor);
  }
  
  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit + 1);
  
  const result = await db.prepare(query).bind(...params).all<CoinLedgerEntry>();
  const entries = result.results.slice(0, limit);
  const hasMore = result.results.length > limit;
  
  return { entries, hasMore };
}

export async function createCoinEntry(
  db: D1Database,
  data: {
    userId: string;
    neighborhoodId: string;
    sourceType: string;
    sourceId: string;
    amount: number;
    category: string;
    description?: string;
    createdBy: string;
  }
): Promise<CoinLedgerEntry | null> {
  const id = generateId();
  const now = toISODateString();
  
  try {
    await db.prepare(`
      INSERT INTO coin_ledger_entries 
      (id, user_id, neighborhood_id, source_type, source_id, amount, category, description, created_at, created_by, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valid')
    `).bind(
      id,
      data.userId,
      data.neighborhoodId,
      data.sourceType,
      data.sourceId,
      data.amount,
      data.category,
      data.description || null,
      now,
      data.createdBy
    ).run();
    
    return await db.prepare('SELECT * FROM coin_ledger_entries WHERE id = ?').bind(id).first<CoinLedgerEntry>();
  } catch (error) {
    // Unique constraint violation - entry already exists (idempotency)
    if ((error as Error).message?.includes('UNIQUE constraint failed')) {
      return null;
    }
    throw error;
  }
}

export async function getCoinRule(db: D1Database, sourceType: string): Promise<CoinRule | null> {
  const result = await db.prepare('SELECT * FROM coin_rules WHERE source_type = ? AND is_active = 1')
    .bind(sourceType)
    .first<CoinRule>();
  return result;
}

// ============================================
// Leftover Offer Operations
// ============================================

export async function createLeftoverOffer(
  db: D1Database,
  data: {
    userId: string;
    neighborhoodId: string;
    title: string;
    description?: string;
    surveyJson: string;
    quantity?: number;
    pickupWindowStart?: string;
    pickupWindowEnd?: string;
    expiryAt: string;
  }
): Promise<LeftoverOffer> {
  const id = generateId();
  const now = toISODateString();
  
  await db.prepare(`
    INSERT INTO leftover_offers 
    (id, user_id, neighborhood_id, title, description, survey_json, quantity, pickup_window_start, pickup_window_end, expiry_at, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).bind(
    id,
    data.userId,
    data.neighborhoodId,
    data.title,
    data.description || null,
    data.surveyJson,
    data.quantity || 1,
    data.pickupWindowStart || null,
    data.pickupWindowEnd || null,
    data.expiryAt,
    now,
    now
  ).run();
  
  return (await getLeftoverOfferById(db, id)) as LeftoverOffer;
}

export async function getLeftoverOfferById(db: D1Database, id: string): Promise<LeftoverOffer | null> {
  return await db.prepare('SELECT * FROM leftover_offers WHERE id = ?').bind(id).first<LeftoverOffer>();
}

export async function getActiveLeftoverOffers(
  db: D1Database,
  neighborhoodId: string,
  limit: number = 20
): Promise<LeftoverOffer[]> {
  const result = await db.prepare(`
    SELECT * FROM leftover_offers 
    WHERE neighborhood_id = ? AND status = 'active' AND expiry_at > datetime('now')
    ORDER BY created_at DESC LIMIT ?
  `).bind(neighborhoodId, limit).all<LeftoverOffer>();
  
  return result.results;
}

export async function updateLeftoverOfferStatus(
  db: D1Database,
  id: string,
  status: string
): Promise<void> {
  const now = toISODateString();
  await db.prepare('UPDATE leftover_offers SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, now, id).run();
}

// ============================================
// Leftover Need Operations
// ============================================

export async function createLeftoverNeed(
  db: D1Database,
  data: {
    userId: string;
    neighborhoodId: string;
    surveyJson: string;
    urgency?: string;
  }
): Promise<LeftoverNeed> {
  const id = generateId();
  const now = toISODateString();
  
  await db.prepare(`
    INSERT INTO leftover_needs 
    (id, user_id, neighborhood_id, survey_json, urgency, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
  `).bind(
    id,
    data.userId,
    data.neighborhoodId,
    data.surveyJson,
    data.urgency || 'normal',
    now,
    now
  ).run();
  
  return (await getLeftoverNeedById(db, id)) as LeftoverNeed;
}

export async function getLeftoverNeedById(db: D1Database, id: string): Promise<LeftoverNeed | null> {
  return await db.prepare('SELECT * FROM leftover_needs WHERE id = ?').bind(id).first<LeftoverNeed>();
}

export async function getActiveLeftoverNeeds(
  db: D1Database,
  neighborhoodId: string,
  limit: number = 20
): Promise<LeftoverNeed[]> {
  const result = await db.prepare(`
    SELECT * FROM leftover_needs 
    WHERE neighborhood_id = ? AND status = 'active'
    ORDER BY created_at DESC LIMIT ?
  `).bind(neighborhoodId, limit).all<LeftoverNeed>();
  
  return result.results;
}

export async function updateLeftoverNeedStatus(
  db: D1Database,
  id: string,
  status: string
): Promise<void> {
  const now = toISODateString();
  await db.prepare('UPDATE leftover_needs SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, now, id).run();
}

// ============================================
// Match Operations
// ============================================

export async function createMatch(
  db: D1Database,
  data: {
    neighborhoodId: string;
    offerId: string;
    needId: string;
    offerUserId: string;
    needUserId: string;
    score: number;
    matchReason?: string;
  }
): Promise<Match> {
  const id = generateId();
  const now = toISODateString();
  
  await db.prepare(`
    INSERT INTO matches 
    (id, neighborhood_id, offer_id, need_id, offer_user_id, need_user_id, score, match_reason, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `).bind(
    id,
    data.neighborhoodId,
    data.offerId,
    data.needId,
    data.offerUserId,
    data.needUserId,
    data.score,
    data.matchReason || null,
    now,
    now
  ).run();
  
  // Update offer and need status to matched
  await updateLeftoverOfferStatus(db, data.offerId, 'matched');
  await updateLeftoverNeedStatus(db, data.needId, 'matched');
  
  return (await getMatchById(db, id)) as Match;
}

export async function getMatchById(db: D1Database, id: string): Promise<Match | null> {
  return await db.prepare('SELECT * FROM matches WHERE id = ?').bind(id).first<Match>();
}

export async function getMatchesForUser(
  db: D1Database,
  userId: string,
  status?: string
): Promise<Match[]> {
  let query = 'SELECT * FROM matches WHERE (offer_user_id = ? OR need_user_id = ?)';
  const params: string[] = [userId, userId];
  
  if (status) {
    query += ' AND status = ?';
    params.push(status);
  }
  
  query += ' ORDER BY created_at DESC';
  
  const result = await db.prepare(query).bind(...params).all<Match>();
  return result.results;
}

export async function updateMatchStatus(
  db: D1Database,
  id: string,
  data: {
    status: string;
    closedBy?: string;
    closureType?: string;
    disputeReason?: string;
    coinsAwarded?: number;
  }
): Promise<void> {
  const now = toISODateString();
  
  await db.prepare(`
    UPDATE matches 
    SET status = ?, closed_by = ?, closed_at = ?, closure_type = ?, dispute_reason = ?, coins_awarded = ?, updated_at = ?
    WHERE id = ?
  `).bind(
    data.status,
    data.closedBy || null,
    now,
    data.closureType || null,
    data.disputeReason || null,
    data.coinsAwarded || 0,
    now,
    id
  ).run();
}

// ============================================
// Chat Thread Operations
// ============================================

export async function createChatThread(
  db: D1Database,
  data: {
    matchId: string;
    neighborhoodId: string;
    participant1Id: string;
    participant2Id: string;
  }
): Promise<ChatThread> {
  const id = generateId();
  const now = toISODateString();
  
  await db.prepare(`
    INSERT INTO chat_threads 
    (id, match_id, neighborhood_id, participant_1_id, participant_2_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?)
  `).bind(
    id,
    data.matchId,
    data.neighborhoodId,
    data.participant1Id,
    data.participant2Id,
    now
  ).run();
  
  return (await getChatThreadById(db, id)) as ChatThread;
}

export async function getChatThreadById(db: D1Database, id: string): Promise<ChatThread | null> {
  return await db.prepare('SELECT * FROM chat_threads WHERE id = ?').bind(id).first<ChatThread>();
}

export async function getChatThreadByMatchId(db: D1Database, matchId: string): Promise<ChatThread | null> {
  return await db.prepare('SELECT * FROM chat_threads WHERE match_id = ?').bind(matchId).first<ChatThread>();
}

export async function getChatThreadsForUser(db: D1Database, userId: string): Promise<ChatThread[]> {
  const result = await db.prepare(`
    SELECT * FROM chat_threads 
    WHERE (participant_1_id = ? OR participant_2_id = ?) AND status = 'active'
    ORDER BY last_message_at DESC NULLS LAST, created_at DESC
  `).bind(userId, userId).all<ChatThread>();
  
  return result.results;
}

// ============================================
// Chat Message Operations
// ============================================

export async function createChatMessage(
  db: D1Database,
  data: {
    threadId: string;
    senderId: string;
    body: string;
    messageType?: string;
    mediaUrl?: string;
    metadata?: string;
  }
): Promise<ChatMessage> {
  const id = generateId();
  const now = toISODateString();
  
  await db.prepare(`
    INSERT INTO chat_messages 
    (id, thread_id, sender_id, body, message_type, media_url, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    data.threadId,
    data.senderId,
    data.body,
    data.messageType || 'text',
    data.mediaUrl || null,
    data.metadata || null,
    now
  ).run();
  
  // Update thread's last_message_at
  await db.prepare('UPDATE chat_threads SET last_message_at = ? WHERE id = ?')
    .bind(now, data.threadId).run();
  
  return (await db.prepare('SELECT * FROM chat_messages WHERE id = ?').bind(id).first<ChatMessage>()) as ChatMessage;
}

export async function getChatMessages(
  db: D1Database,
  threadId: string,
  limit: number = 50,
  cursor?: string
): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
  let query = 'SELECT * FROM chat_messages WHERE thread_id = ? AND deleted_at IS NULL';
  const params: (string | number)[] = [threadId];
  
  if (cursor) {
    query += ' AND created_at < ?';
    params.push(cursor);
  }
  
  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit + 1);
  
  const result = await db.prepare(query).bind(...params).all<ChatMessage>();
  const messages = result.results.slice(0, limit).reverse();
  const hasMore = result.results.length > limit;
  
  return { messages, hasMore };
}

// ============================================
// Cleanify Operations
// ============================================

export async function createCleanifySubmission(
  db: D1Database,
  data: {
    userId: string;
    neighborhoodId: string;
    beforePhotoUrl: string;
    afterPhotoUrl: string;
    geoLat?: number;
    geoLng?: number;
    description?: string;
  }
): Promise<CleanifySubmission> {
  const id = generateId();
  const now = toISODateString();
  
  await db.prepare(`
    INSERT INTO cleanify_submissions 
    (id, user_id, neighborhood_id, before_photo_url, after_photo_url, geo_lat, geo_lng, description, status, submitted_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).bind(
    id,
    data.userId,
    data.neighborhoodId,
    data.beforePhotoUrl,
    data.afterPhotoUrl,
    data.geoLat || null,
    data.geoLng || null,
    data.description || null,
    now,
    now,
    now
  ).run();
  
  return (await getCleanifySubmissionById(db, id)) as CleanifySubmission;
}

export async function getCleanifySubmissionById(db: D1Database, id: string): Promise<CleanifySubmission | null> {
  return await db.prepare('SELECT * FROM cleanify_submissions WHERE id = ?').bind(id).first<CleanifySubmission>();
}

export async function getCleanifySubmissionsForUser(
  db: D1Database,
  userId: string,
  limit: number = 20
): Promise<CleanifySubmission[]> {
  const result = await db.prepare(`
    SELECT * FROM cleanify_submissions 
    WHERE user_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).bind(userId, limit).all<CleanifySubmission>();
  
  return result.results;
}

export async function getPendingCleanifySubmissions(
  db: D1Database,
  limit: number = 50
): Promise<CleanifySubmission[]> {
  const result = await db.prepare(`
    SELECT * FROM cleanify_submissions 
    WHERE status = 'pending'
    ORDER BY submitted_at ASC LIMIT ?
  `).bind(limit).all<CleanifySubmission>();
  
  return result.results;
}

export async function reviewCleanifySubmission(
  db: D1Database,
  id: string,
  data: {
    status: 'approved' | 'rejected';
    reviewerId: string;
    note?: string;
    coinsAwarded?: number;
  }
): Promise<void> {
  const now = toISODateString();
  
  await db.prepare(`
    UPDATE cleanify_submissions 
    SET status = ?, reviewer_id = ?, reviewed_at = ?, review_note = ?, coins_awarded = ?, updated_at = ?
    WHERE id = ?
  `).bind(
    data.status,
    data.reviewerId,
    now,
    data.note || null,
    data.coinsAwarded || 0,
    now,
    id
  ).run();
}

// ============================================
// Campaign Operations
// ============================================

export async function createOrUpdateCampaign(
  db: D1Database,
  data: {
    neighborhoodId: string;
    title: string;
    description?: string;
    organizer?: string;
    location?: string;
    startDt: string;
    endDt?: string;
    url?: string;
    source: string;
    sourceIdentifier?: string;
  }
): Promise<Campaign> {
  const id = generateId();
  const now = toISODateString();
  
  // Try to upsert based on source and url
  try {
    await db.prepare(`
      INSERT INTO campaigns 
      (id, neighborhood_id, title, description, organizer, location, start_dt, end_dt, url, source, source_identifier, status, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).bind(
      id,
      data.neighborhoodId,
      data.title,
      data.description || null,
      data.organizer || null,
      data.location || null,
      data.startDt,
      data.endDt || null,
      data.url || null,
      data.source,
      data.sourceIdentifier || null,
      now,
      now,
      now
    ).run();
    
    return (await getCampaignById(db, id)) as Campaign;
  } catch (error) {
    // If unique constraint on (source, url) fails, update existing
    if ((error as Error).message?.includes('UNIQUE constraint failed')) {
      await db.prepare(`
        UPDATE campaigns 
        SET title = ?, description = ?, organizer = ?, location = ?, start_dt = ?, end_dt = ?, 
            status = 'active', last_seen_at = ?, updated_at = ?
        WHERE source = ? AND url = ?
      `).bind(
        data.title,
        data.description || null,
        data.organizer || null,
        data.location || null,
        data.startDt,
        data.endDt || null,
        now,
        now,
        data.source,
        data.url
      ).run();
      
      const existing = await db.prepare('SELECT * FROM campaigns WHERE source = ? AND url = ?')
        .bind(data.source, data.url).first<Campaign>();
      return existing as Campaign;
    }
    throw error;
  }
}

export async function getCampaignById(db: D1Database, id: string): Promise<Campaign | null> {
  return await db.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first<Campaign>();
}

export async function getCampaignsForNeighborhood(
  db: D1Database,
  neighborhoodId: string,
  fromDate?: string,
  toDate?: string,
  limit: number = 20
): Promise<Campaign[]> {
  let query = 'SELECT * FROM campaigns WHERE neighborhood_id = ? AND status = ?';
  const params: (string | number)[] = [neighborhoodId, 'active'];
  
  if (fromDate) {
    query += ' AND start_dt >= ?';
    params.push(fromDate);
  }
  if (toDate) {
    query += ' AND start_dt <= ?';
    params.push(toDate);
  }
  
  query += ' ORDER BY start_dt ASC LIMIT ?';
  params.push(limit);
  
  const result = await db.prepare(query).bind(...params).all<Campaign>();
  return result.results;
}

export async function expireOldCampaigns(
  db: D1Database,
  gracePeriodHours: number = 72
): Promise<number> {
  const result = await db.prepare(`
    UPDATE campaigns 
    SET status = 'expired', updated_at = datetime('now')
    WHERE status = 'active' 
    AND datetime(last_seen_at) < datetime('now', '-' || ? || ' hours')
  `).bind(gracePeriodHours).run();
  
  return result.meta.changes;
}

// ============================================
// Moderation Log
// ============================================

export async function createModerationLog(
  db: D1Database,
  data: {
    moderatorId: string;
    actionType: string;
    targetType: string;
    targetId: string;
    reason?: string;
    metadata?: string;
  }
): Promise<void> {
  const id = generateId();
  const now = toISODateString();
  
  await db.prepare(`
    INSERT INTO moderation_logs 
    (id, moderator_id, action_type, target_type, target_id, reason, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    data.moderatorId,
    data.actionType,
    data.targetType,
    data.targetId,
    data.reason || null,
    data.metadata || null,
    now
  ).run();
}
