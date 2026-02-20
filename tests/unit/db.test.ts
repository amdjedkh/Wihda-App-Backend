/**
 * Tests for Database Helper Functions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createUser,
  getUserById,
  getUserByEmail,
  getUserByPhone,
  updateUser,
  getNeighborhoodById,
  getNeighborhoodsByCity,
  getUserNeighborhood,
  joinNeighborhood,
  getCoinBalance,
  getCoinLedgerEntries,
  createCoinEntry,
  createLeftoverOffer,
  getLeftoverOfferById,
  getActiveLeftoverOffers,
  updateLeftoverOfferStatus,
  createLeftoverNeed,
  getLeftoverNeedById,
  getActiveLeftoverNeeds,
  updateLeftoverNeedStatus,
  createMatch,
  getMatchById,
  getMatchesForUser,
  updateMatchStatus,
  createChatThread,
  getChatThreadById,
  getChatThreadsForUser,
  createChatMessage,
  getChatMessages,
  createCleanifySubmission,
  getCleanifySubmissionById,
  getCleanifySubmissionsForUser,
  getPendingCleanifySubmissions,
  reviewCleanifySubmission,
  createOrUpdateCampaign,
  getCampaignById,
  getCampaignsForNeighborhood,
} from '../../src/lib/db';
import { createMockD1Database, testUsers, testNeighborhoods, testOffers, testNeeds, testMatches, testChatThreads, testChatMessages, testSubmissions, testCampaigns } from '../fixtures';

describe('User Operations', () => {
  let mockDb: ReturnType<typeof createMockD1Database>;

  beforeEach(() => {
    mockDb = createMockD1Database();
    vi.clearAllMocks();
  });

  describe('createUser', () => {
    it('should create a new user with all fields', async () => {
      mockDb.run.mockResolvedValue({ success: true });
      // Mock for getUserById call after insert
      mockDb.first.mockResolvedValue({
        id: 'new-user-id',
        email: 'test@example.com',
        phone: '+212600000000',
        password_hash: 'hashed',
        display_name: 'Test User',
        role: 'user',
        status: 'active',
        language_preference: 'en',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });

      const result = await createUser(mockDb as any, {
        email: 'test@example.com',
        phone: '+212600000000',
        passwordHash: 'hashed',
        displayName: 'Test User',
        languagePreference: 'en',
      });

      expect(mockDb.prepare).toHaveBeenCalled();
      expect(result.display_name).toBe('Test User');
    });

    it('should create user with only email', async () => {
      mockDb.run.mockResolvedValue({ success: true });
      mockDb.first.mockResolvedValue({
        id: 'new-user-id',
        email: 'test@example.com',
        phone: null,
        display_name: 'Test User',
      });

      await createUser(mockDb as any, {
        email: 'test@example.com',
        passwordHash: 'hashed',
        displayName: 'Test User',
      });

      expect(mockDb.bind).toHaveBeenCalledWith(
        expect.any(String),
        'test@example.com',
        null,
        'hashed',
        'Test User',
        'fr',
        expect.any(String),
        expect.any(String)
      );
    });
  });

  describe('getUserById', () => {
    it('should return user when found', async () => {
      mockDb.first.mockResolvedValue(testUsers[0]);

      const result = await getUserById(mockDb as any, 'user-001');

      expect(result).toEqual(testUsers[0]);
      expect(mockDb.bind).toHaveBeenCalledWith('user-001');
    });

    it('should return null when user not found', async () => {
      mockDb.first.mockResolvedValue(null);

      const result = await getUserById(mockDb as any, 'nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getUserByEmail', () => {
    it('should return user by email', async () => {
      mockDb.first.mockResolvedValue(testUsers[0]);

      const result = await getUserByEmail(mockDb as any, 'admin@wihda.ma');

      expect(result).toEqual(testUsers[0]);
    });
  });

  describe('getUserByPhone', () => {
    it('should return user by phone', async () => {
      mockDb.first.mockResolvedValue(testUsers[0]);

      const result = await getUserByPhone(mockDb as any, '+212600000001');

      expect(result).toEqual(testUsers[0]);
    });
  });

  describe('updateUser', () => {
    it('should update user display name', async () => {
      mockDb.run.mockResolvedValue({ success: true });
      mockDb.first.mockResolvedValue({
        ...testUsers[0],
        display_name: 'Updated Name',
      });

      const result = await updateUser(mockDb as any, 'user-001', {
        displayName: 'Updated Name',
      });

      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('display_name = ?'));
    });

    it('should return user unchanged if no updates', async () => {
      mockDb.first.mockResolvedValue(testUsers[0]);

      const result = await updateUser(mockDb as any, 'user-001', {});

      expect(mockDb.run).not.toHaveBeenCalled();
    });
  });
});

describe('Neighborhood Operations', () => {
  let mockDb: ReturnType<typeof createMockD1Database>;

  beforeEach(() => {
    mockDb = createMockD1Database();
    vi.clearAllMocks();
  });

  describe('getNeighborhoodById', () => {
    it('should return neighborhood when found', async () => {
      mockDb.first.mockResolvedValue(testNeighborhoods[0]);

      const result = await getNeighborhoodById(mockDb as any, 'nb-001');

      expect(result).toEqual(testNeighborhoods[0]);
    });

    it('should return null when not found', async () => {
      mockDb.first.mockResolvedValue(null);

      const result = await getNeighborhoodById(mockDb as any, 'nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getNeighborhoodsByCity', () => {
    it('should return neighborhoods for a city', async () => {
      mockDb.all.mockResolvedValue({ results: testNeighborhoods.filter(n => n.city === 'Rabat') });

      const result = await getNeighborhoodsByCity(mockDb as any, 'Rabat');

      expect(result).toHaveLength(2);
      expect(result.every(n => n.city === 'Rabat')).toBe(true);
    });
  });
});

describe('User Neighborhood Membership', () => {
  let mockDb: ReturnType<typeof createMockD1Database>;

  beforeEach(() => {
    mockDb = createMockD1Database();
    vi.clearAllMocks();
  });

  describe('getUserNeighborhood', () => {
    it('should return user primary neighborhood', async () => {
      mockDb.first.mockResolvedValue({
        id: 'un-001',
        user_id: 'user-001',
        neighborhood_id: 'nb-001',
        is_primary: 1,
        joined_at: '2024-01-01T00:00:00Z',
      });

      const result = await getUserNeighborhood(mockDb as any, 'user-001');

      expect(result).not.toBeNull();
      expect(result?.neighborhood_id).toBe('nb-001');
    });
  });

  describe('joinNeighborhood', () => {
    it('should join user to neighborhood', async () => {
      mockDb.run.mockResolvedValue({ success: true });

      const result = await joinNeighborhood(mockDb as any, 'user-001', 'nb-001');

      expect(result.user_id).toBe('user-001');
      expect(result.neighborhood_id).toBe('nb-001');
      expect(result.is_primary).toBe(1);
    });
  });
});

describe('Coin Ledger Operations', () => {
  let mockDb: ReturnType<typeof createMockD1Database>;

  beforeEach(() => {
    mockDb = createMockD1Database();
    vi.clearAllMocks();
  });

  describe('getCoinBalance', () => {
    it('should return total balance', async () => {
      mockDb.first.mockResolvedValue({ balance: 200 });

      const result = await getCoinBalance(mockDb as any, 'user-001');

      expect(result).toBe(200);
    });

    it('should return 0 when no entries', async () => {
      mockDb.first.mockResolvedValue({ balance: null });

      const result = await getCoinBalance(mockDb as any, 'user-001');

      expect(result).toBe(0);
    });
  });

  describe('getCoinLedgerEntries', () => {
    it('should return paginated entries', async () => {
      const entries = [
        { id: 'coin-001', user_id: 'user-001', amount: 100 },
        { id: 'coin-002', user_id: 'user-001', amount: 50 },
      ];
      mockDb.all.mockResolvedValue({ results: entries });

      const result = await getCoinLedgerEntries(mockDb as any, 'user-001', 10);

      expect(result.entries).toHaveLength(2);
      expect(result.hasMore).toBe(false);
    });

    it('should indicate hasMore when more entries exist', async () => {
      const entries = Array.from({ length: 11 }, (_, i) => ({
        id: `coin-${i}`,
        user_id: 'user-001',
        amount: 10,
        created_at: new Date().toISOString(),
      }));
      mockDb.all.mockResolvedValue({ results: entries });

      const result = await getCoinLedgerEntries(mockDb as any, 'user-001', 10);

      expect(result.entries).toHaveLength(10);
      expect(result.hasMore).toBe(true);
    });
  });

  describe('createCoinEntry', () => {
    it('should create coin entry', async () => {
      mockDb.run.mockResolvedValue({ success: true });
      mockDb.first.mockResolvedValue({
        id: 'new-coin-id',
        user_id: 'user-001',
        amount: 100,
        source_type: 'cleanify_approved',
      });

      const result = await createCoinEntry(mockDb as any, {
        userId: 'user-001',
        neighborhoodId: 'nb-001',
        sourceType: 'cleanify_approved',
        sourceId: 'sub-001',
        amount: 100,
        category: 'cleanify',
        createdBy: 'system',
      });

      expect(result).not.toBeNull();
    });

    it('should return null on duplicate (idempotency)', async () => {
      const error = new Error('UNIQUE constraint failed: source_type, source_id, user_id');
      mockDb.run.mockRejectedValue(error);

      const result = await createCoinEntry(mockDb as any, {
        userId: 'user-001',
        neighborhoodId: 'nb-001',
        sourceType: 'cleanify_approved',
        sourceId: 'sub-001',
        amount: 100,
        category: 'cleanify',
        createdBy: 'system',
      });

      expect(result).toBeNull();
    });
  });
});

describe('Leftover Offer Operations', () => {
  let mockDb: ReturnType<typeof createMockD1Database>;

  beforeEach(() => {
    mockDb = createMockD1Database();
    vi.clearAllMocks();
  });

  describe('createLeftoverOffer', () => {
    it('should create a new offer', async () => {
      mockDb.run.mockResolvedValue({ success: true });
      mockDb.first.mockResolvedValue(testOffers[0]);

      const result = await createLeftoverOffer(mockDb as any, {
        userId: 'user-003',
        neighborhoodId: 'nb-001',
        title: 'Couscous traditionnel',
        surveyJson: JSON.stringify({ food_type: 'cooked_meal' }),
        expiryAt: new Date(Date.now() + 86400000).toISOString(),
      });

      expect(result).toEqual(testOffers[0]);
    });
  });

  describe('getLeftoverOfferById', () => {
    it('should return offer by id', async () => {
      mockDb.first.mockResolvedValue(testOffers[0]);

      const result = await getLeftoverOfferById(mockDb as any, 'offer-001');

      expect(result).toEqual(testOffers[0]);
    });
  });

  describe('getActiveLeftoverOffers', () => {
    it('should return active offers for neighborhood', async () => {
      mockDb.all.mockResolvedValue({ results: testOffers.filter(o => o.status === 'active') });

      const result = await getActiveLeftoverOffers(mockDb as any, 'nb-001');

      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('updateLeftoverOfferStatus', () => {
    it('should update offer status', async () => {
      mockDb.run.mockResolvedValue({ success: true });

      await updateLeftoverOfferStatus(mockDb as any, 'offer-001', 'matched');

      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE leftover_offers'));
    });
  });
});

describe('Leftover Need Operations', () => {
  let mockDb: ReturnType<typeof createMockD1Database>;

  beforeEach(() => {
    mockDb = createMockD1Database();
    vi.clearAllMocks();
  });

  describe('createLeftoverNeed', () => {
    it('should create a new need', async () => {
      mockDb.run.mockResolvedValue({ success: true });
      mockDb.first.mockResolvedValue(testNeeds[0]);

      const result = await createLeftoverNeed(mockDb as any, {
        userId: 'user-004',
        neighborhoodId: 'nb-001',
        surveyJson: JSON.stringify({ food_type: 'cooked_meal' }),
        urgency: 'normal',
      });

      expect(result).toEqual(testNeeds[0]);
    });
  });

  describe('getLeftoverNeedById', () => {
    it('should return need by id', async () => {
      mockDb.first.mockResolvedValue(testNeeds[0]);

      const result = await getLeftoverNeedById(mockDb as any, 'need-001');

      expect(result).toEqual(testNeeds[0]);
    });
  });
});

describe('Match Operations', () => {
  let mockDb: ReturnType<typeof createMockD1Database>;

  beforeEach(() => {
    mockDb = createMockD1Database();
    vi.clearAllMocks();
  });

  describe('createMatch', () => {
    it('should create a new match', async () => {
      mockDb.run.mockResolvedValue({ success: true });
      mockDb.first.mockResolvedValue(testMatches[0]);

      const result = await createMatch(mockDb as any, {
        neighborhoodId: 'nb-001',
        offerId: 'offer-001',
        needId: 'need-001',
        offerUserId: 'user-003',
        needUserId: 'user-004',
        score: 0.85,
      });

      expect(result).toBeDefined();
    });
  });

  describe('getMatchById', () => {
    it('should return match by id', async () => {
      mockDb.first.mockResolvedValue(testMatches[0]);

      const result = await getMatchById(mockDb as any, 'match-001');

      expect(result).toEqual(testMatches[0]);
    });
  });

  describe('getMatchesForUser', () => {
    it('should return matches for user as offer owner', async () => {
      mockDb.all.mockResolvedValue({ results: testMatches });

      const result = await getMatchesForUser(mockDb as any, 'user-003');

      expect(result).toHaveLength(1);
    });

    it('should filter by status when provided', async () => {
      mockDb.all.mockResolvedValue({ results: testMatches.filter(m => m.status === 'active') });

      const result = await getMatchesForUser(mockDb as any, 'user-003', 'active');

      expect(mockDb.bind).toHaveBeenCalledWith('user-003', 'user-003', 'active');
    });
  });

  describe('updateMatchStatus', () => {
    it('should update match status with closure info', async () => {
      mockDb.run.mockResolvedValue({ success: true });

      await updateMatchStatus(mockDb as any, 'match-001', {
        status: 'closed',
        closedBy: 'user-003',
        closureType: 'successful',
        coinsAwarded: 200,
      });

      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE matches'));
    });
  });
});

describe('Chat Thread Operations', () => {
  let mockDb: ReturnType<typeof createMockD1Database>;

  beforeEach(() => {
    mockDb = createMockD1Database();
    vi.clearAllMocks();
  });

  describe('createChatThread', () => {
    it('should create a new chat thread', async () => {
      mockDb.run.mockResolvedValue({ success: true });
      mockDb.first.mockResolvedValue(testChatThreads[0]);

      const result = await createChatThread(mockDb as any, {
        matchId: 'match-001',
        neighborhoodId: 'nb-001',
        participant1Id: 'user-003',
        participant2Id: 'user-004',
      });

      expect(result).toBeDefined();
    });
  });

  describe('getChatThreadById', () => {
    it('should return thread by id', async () => {
      mockDb.first.mockResolvedValue(testChatThreads[0]);

      const result = await getChatThreadById(mockDb as any, 'thread-001');

      expect(result).toEqual(testChatThreads[0]);
    });
  });

  describe('getChatThreadsForUser', () => {
    it('should return threads for user', async () => {
      mockDb.all.mockResolvedValue({ results: testChatThreads });

      const result = await getChatThreadsForUser(mockDb as any, 'user-003');

      expect(result).toHaveLength(1);
    });
  });
});

describe('Chat Message Operations', () => {
  let mockDb: ReturnType<typeof createMockD1Database>;

  beforeEach(() => {
    mockDb = createMockD1Database();
    vi.clearAllMocks();
  });

  describe('createChatMessage', () => {
    it('should create a new message', async () => {
      mockDb.run.mockResolvedValue({ success: true });
      mockDb.first.mockResolvedValue(testChatMessages[0]);

      const result = await createChatMessage(mockDb as any, {
        threadId: 'thread-001',
        senderId: 'user-003',
        body: 'Hello!',
        messageType: 'text',
      });

      expect(result).toBeDefined();
    });
  });

  describe('getChatMessages', () => {
    it('should return messages for thread', async () => {
      mockDb.all.mockResolvedValue({ results: testChatMessages });

      const result = await getChatMessages(mockDb as any, 'thread-001', 50);

      expect(result.messages).toBeDefined();
      expect(result.hasMore).toBe(false);
    });
  });
});

describe('Cleanify Operations', () => {
  let mockDb: ReturnType<typeof createMockD1Database>;

  beforeEach(() => {
    mockDb = createMockD1Database();
    vi.clearAllMocks();
  });

  describe('createCleanifySubmission', () => {
    it('should create a new submission', async () => {
      mockDb.run.mockResolvedValue({ success: true });
      mockDb.first.mockResolvedValue(testSubmissions[0]);

      const result = await createCleanifySubmission(mockDb as any, {
        userId: 'user-003',
        neighborhoodId: 'nb-001',
        beforePhotoUrl: 'https://example.com/before.jpg',
        afterPhotoUrl: 'https://example.com/after.jpg',
        description: 'Cleaned park',
      });

      expect(result).toBeDefined();
    });
  });

  describe('getCleanifySubmissionById', () => {
    it('should return submission by id', async () => {
      mockDb.first.mockResolvedValue(testSubmissions[0]);

      const result = await getCleanifySubmissionById(mockDb as any, 'sub-001');

      expect(result).toEqual(testSubmissions[0]);
    });
  });

  describe('getPendingCleanifySubmissions', () => {
    it('should return pending submissions', async () => {
      mockDb.all.mockResolvedValue({ results: testSubmissions.filter(s => s.status === 'pending') });

      const result = await getPendingCleanifySubmissions(mockDb as any, 50);

      expect(result.every(s => s.status === 'pending')).toBe(true);
    });
  });

  describe('reviewCleanifySubmission', () => {
    it('should approve submission and award coins', async () => {
      mockDb.run.mockResolvedValue({ success: true });

      await reviewCleanifySubmission(mockDb as any, 'sub-001', {
        status: 'approved',
        reviewerId: 'user-002',
        coinsAwarded: 150,
        note: 'Great job!',
      });

      expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE cleanify_submissions'));
    });
  });
});

describe('Campaign Operations', () => {
  let mockDb: ReturnType<typeof createMockD1Database>;

  beforeEach(() => {
    mockDb = createMockD1Database();
    vi.clearAllMocks();
  });

  describe('createOrUpdateCampaign', () => {
    it('should create a new campaign', async () => {
      mockDb.run.mockResolvedValue({ success: true });
      mockDb.first.mockResolvedValue(testCampaigns[0]);

      const result = await createOrUpdateCampaign(mockDb as any, {
        neighborhoodId: 'nb-001',
        title: 'Community Cleanup',
        startDt: '2024-02-15T09:00:00Z',
        source: 'manual',
      });

      expect(result).toBeDefined();
    });
  });

  describe('getCampaignById', () => {
    it('should return campaign by id', async () => {
      mockDb.first.mockResolvedValue(testCampaigns[0]);

      const result = await getCampaignById(mockDb as any, 'camp-001');

      expect(result).toEqual(testCampaigns[0]);
    });
  });

  describe('getCampaignsForNeighborhood', () => {
    it('should return campaigns for neighborhood', async () => {
      mockDb.all.mockResolvedValue({ results: testCampaigns });

      const result = await getCampaignsForNeighborhood(mockDb as any, 'nb-001');

      expect(result).toBeDefined();
    });

    it('should filter by date range', async () => {
      mockDb.all.mockResolvedValue({ results: testCampaigns });

      await getCampaignsForNeighborhood(
        mockDb as any,
        'nb-001',
        '2024-01-01T00:00:00Z',
        '2024-12-31T23:59:59Z'
      );

      expect(mockDb.bind).toHaveBeenCalledWith(
        'nb-001',
        'active',
        '2024-01-01T00:00:00Z',
        '2024-12-31T23:59:59Z',
        20
      );
    });
  });
});
