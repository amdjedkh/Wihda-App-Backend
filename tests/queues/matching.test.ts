/**
 * Tests for Matching Logic
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { calculateMatchScore, handleMatchingQueue } from '../../src/queues/matching';
import { LeftoverOffer, LeftoverNeed } from '../fixtures/types';
import { createMockEnv, testOffers, testNeeds } from '../fixtures';

describe('Matching Logic', () => {
  describe('calculateMatchScore', () => {
    it('should return perfect score for identical surveys', () => {
      const survey = {
        schema_version: 1,
        food_type: 'cooked_meal',
        diet_constraints: ['halal'],
        portions: 4,
        pickup_time_preference: 'evening',
        distance_willing_km: 5,
      };

      const offer: LeftoverOffer = {
        id: 'offer-001',
        user_id: 'user-001',
        neighborhood_id: 'nb-001',
        title: 'Test Offer',
        survey_json: JSON.stringify(survey),
        quantity: 1,
        status: 'active',
        expiry_at: new Date(Date.now() + 86400000).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const need: LeftoverNeed = {
        id: 'need-001',
        user_id: 'user-002',
        neighborhood_id: 'nb-001',
        survey_json: JSON.stringify(survey),
        urgency: 'normal',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { score, reasons } = calculateMatchScore(offer, need);

      expect(score).toBe(1); // Perfect match
      expect(reasons).toContain('Food type matches');
      expect(reasons).toContain('All dietary requirements satisfied');
      expect(reasons).toContain('Sufficient portions available');
      expect(reasons).toContain('Pickup time matches');
    });

    it('should return high score for matching food type', () => {
      const offerSurvey = {
        food_type: 'cooked_meal',
        diet_constraints: [],
        portions: 4,
        pickup_time_preference: 'evening',
        distance_willing_km: 5,
      };

      const needSurvey = {
        food_type: 'cooked_meal',
        diet_constraints: [],
        portions: 2,
        pickup_time_preference: 'morning',
        distance_willing_km: 3,
      };

      const offer: LeftoverOffer = {
        id: 'offer-001',
        user_id: 'user-001',
        neighborhood_id: 'nb-001',
        title: 'Test',
        survey_json: JSON.stringify(offerSurvey),
        quantity: 1,
        status: 'active',
        expiry_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const need: LeftoverNeed = {
        id: 'need-001',
        user_id: 'user-002',
        neighborhood_id: 'nb-001',
        survey_json: JSON.stringify(needSurvey),
        urgency: 'normal',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { score, reasons } = calculateMatchScore(offer, need);

      expect(score).toBeGreaterThan(0.7);
      expect(reasons).toContain('Food type matches');
    });

    it('should return partial score for different food types', () => {
      const offerSurvey = {
        food_type: 'bread',
        diet_constraints: [],
        portions: 4,
        pickup_time_preference: 'evening',
        distance_willing_km: 5,
      };

      const needSurvey = {
        food_type: 'cooked_meal',
        diet_constraints: [],
        portions: 2,
        pickup_time_preference: 'evening',
        distance_willing_km: 3,
      };

      const offer: LeftoverOffer = {
        id: 'offer-001',
        user_id: 'user-001',
        neighborhood_id: 'nb-001',
        title: 'Test',
        survey_json: JSON.stringify(offerSurvey),
        quantity: 1,
        status: 'active',
        expiry_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const need: LeftoverNeed = {
        id: 'need-001',
        user_id: 'user-002',
        neighborhood_id: 'nb-001',
        survey_json: JSON.stringify(needSurvey),
        urgency: 'normal',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { score } = calculateMatchScore(offer, need);

      expect(score).toBeLessThan(0.7);
      expect(score).toBeGreaterThan(0.3);
    });

    it('should give partial credit for "other" food type', () => {
      const offerSurvey = {
        food_type: 'other',
        diet_constraints: [],
        portions: 4,
        pickup_time_preference: 'evening',
        distance_willing_km: 5,
      };

      const needSurvey = {
        food_type: 'cooked_meal',
        diet_constraints: [],
        portions: 2,
        pickup_time_preference: 'evening',
        distance_willing_km: 3,
      };

      const offer: LeftoverOffer = {
        id: 'offer-001',
        user_id: 'user-001',
        neighborhood_id: 'nb-001',
        title: 'Test',
        survey_json: JSON.stringify(offerSurvey),
        quantity: 1,
        status: 'active',
        expiry_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const need: LeftoverNeed = {
        id: 'need-001',
        user_id: 'user-002',
        neighborhood_id: 'nb-001',
        survey_json: JSON.stringify(needSurvey),
        urgency: 'normal',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { score, reasons } = calculateMatchScore(offer, need);

      expect(reasons).toContain('Food type compatible');
    });

    it('should handle dietary constraints correctly', () => {
      const offerSurvey = {
        food_type: 'cooked_meal',
        diet_constraints: ['halal', 'vegetarian'],
        portions: 4,
        pickup_time_preference: 'evening',
        distance_willing_km: 5,
      };

      const needSurvey = {
        food_type: 'cooked_meal',
        diet_constraints: ['halal'],
        portions: 2,
        pickup_time_preference: 'evening',
        distance_willing_km: 3,
      };

      const offer: LeftoverOffer = {
        id: 'offer-001',
        user_id: 'user-001',
        neighborhood_id: 'nb-001',
        title: 'Test',
        survey_json: JSON.stringify(offerSurvey),
        quantity: 1,
        status: 'active',
        expiry_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const need: LeftoverNeed = {
        id: 'need-001',
        user_id: 'user-002',
        neighborhood_id: 'nb-001',
        survey_json: JSON.stringify(needSurvey),
        urgency: 'normal',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { score, reasons } = calculateMatchScore(offer, need);

      expect(reasons).toContain('All dietary requirements satisfied');
    });

    it('should give partial credit for partial dietary match', () => {
      const offerSurvey = {
        food_type: 'cooked_meal',
        diet_constraints: ['halal'],
        portions: 4,
        pickup_time_preference: 'evening',
        distance_willing_km: 5,
      };

      const needSurvey = {
        food_type: 'cooked_meal',
        diet_constraints: ['halal', 'vegetarian'],
        portions: 2,
        pickup_time_preference: 'evening',
        distance_willing_km: 3,
      };

      const offer: LeftoverOffer = {
        id: 'offer-001',
        user_id: 'user-001',
        neighborhood_id: 'nb-001',
        title: 'Test',
        survey_json: JSON.stringify(offerSurvey),
        quantity: 1,
        status: 'active',
        expiry_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const need: LeftoverNeed = {
        id: 'need-001',
        user_id: 'user-002',
        neighborhood_id: 'nb-001',
        survey_json: JSON.stringify(needSurvey),
        urgency: 'normal',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { score, reasons } = calculateMatchScore(offer, need);

      expect(reasons).toContain('1/2 dietary requirements satisfied');
    });

    it('should give full score when no dietary constraints', () => {
      const offerSurvey = {
        food_type: 'cooked_meal',
        diet_constraints: [],
        portions: 4,
        pickup_time_preference: 'evening',
        distance_willing_km: 5,
      };

      const needSurvey = {
        food_type: 'cooked_meal',
        diet_constraints: [],
        portions: 2,
        pickup_time_preference: 'evening',
        distance_willing_km: 3,
      };

      const offer: LeftoverOffer = {
        id: 'offer-001',
        user_id: 'user-001',
        neighborhood_id: 'nb-001',
        title: 'Test',
        survey_json: JSON.stringify(offerSurvey),
        quantity: 1,
        status: 'active',
        expiry_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const need: LeftoverNeed = {
        id: 'need-001',
        user_id: 'user-002',
        neighborhood_id: 'nb-001',
        survey_json: JSON.stringify(needSurvey),
        urgency: 'normal',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { reasons } = calculateMatchScore(offer, need);

      expect(reasons).toContain('No specific dietary requirements');
    });

    it('should handle portion mismatch', () => {
      const offerSurvey = {
        food_type: 'cooked_meal',
        diet_constraints: [],
        portions: 2,
        pickup_time_preference: 'evening',
        distance_willing_km: 5,
      };

      const needSurvey = {
        food_type: 'cooked_meal',
        diet_constraints: [],
        portions: 4,
        pickup_time_preference: 'evening',
        distance_willing_km: 3,
      };

      const offer: LeftoverOffer = {
        id: 'offer-001',
        user_id: 'user-001',
        neighborhood_id: 'nb-001',
        title: 'Test',
        survey_json: JSON.stringify(offerSurvey),
        quantity: 1,
        status: 'active',
        expiry_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const need: LeftoverNeed = {
        id: 'need-001',
        user_id: 'user-002',
        neighborhood_id: 'nb-001',
        survey_json: JSON.stringify(needSurvey),
        urgency: 'normal',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { score, reasons } = calculateMatchScore(offer, need);

      expect(reasons).toContain('Partial portion match');
    });

    it('should handle flexible pickup time', () => {
      const offerSurvey = {
        food_type: 'cooked_meal',
        diet_constraints: [],
        portions: 4,
        pickup_time_preference: 'flexible',
        distance_willing_km: 5,
      };

      const needSurvey = {
        food_type: 'cooked_meal',
        diet_constraints: [],
        portions: 2,
        pickup_time_preference: 'morning',
        distance_willing_km: 3,
      };

      const offer: LeftoverOffer = {
        id: 'offer-001',
        user_id: 'user-001',
        neighborhood_id: 'nb-001',
        title: 'Test',
        survey_json: JSON.stringify(offerSurvey),
        quantity: 1,
        status: 'active',
        expiry_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const need: LeftoverNeed = {
        id: 'need-001',
        user_id: 'user-002',
        neighborhood_id: 'nb-001',
        survey_json: JSON.stringify(needSurvey),
        urgency: 'normal',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { reasons } = calculateMatchScore(offer, need);

      expect(reasons).toContain('Flexible pickup time');
    });

    it('should handle malformed JSON gracefully', () => {
      const offer: LeftoverOffer = {
        id: 'offer-001',
        user_id: 'user-001',
        neighborhood_id: 'nb-001',
        title: 'Test',
        survey_json: 'not valid json',
        quantity: 1,
        status: 'active',
        expiry_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const need: LeftoverNeed = {
        id: 'need-001',
        user_id: 'user-002',
        neighborhood_id: 'nb-001',
        survey_json: JSON.stringify({
          food_type: 'cooked_meal',
          diet_constraints: [],
          portions: 2,
          pickup_time_preference: 'evening',
        }),
        urgency: 'normal',
        status: 'active',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      // Should not throw
      const { score } = calculateMatchScore(offer, need);
      expect(score).toBeDefined();
      expect(typeof score).toBe('number');
    });
  });

  describe('handleMatchingQueue', () => {
    let mockEnv: ReturnType<typeof createMockEnv>;

    beforeEach(() => {
      vi.clearAllMocks();
      mockEnv = createMockEnv();
    });

    it('should process match_offer message', async () => {
      const mockOffer = testOffers[0];
      const mockNeed = testNeeds[0];

      mockEnv.DB.first.mockResolvedValueOnce(mockOffer); // getLeftoverOfferById
      mockEnv.DB.all.mockResolvedValueOnce({ results: [mockNeed] }); // getActiveLeftoverNeeds
      mockEnv.DB.run.mockResolvedValue({ success: true });
      mockEnv.DB.first.mockResolvedValue({
        id: 'match-001',
        offer_id: mockOffer.id,
        need_id: mockNeed.id,
        score: 0.85,
      });

      const messages = [
        {
          body: {
            type: 'match_offer',
            offer_id: 'offer-001',
            neighborhood_id: 'nb-001',
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      await handleMatchingQueue(messages as any, mockEnv);

      expect(messages[0].ack).toHaveBeenCalled();
    });

    it('should skip inactive offers', async () => {
      mockEnv.DB.first.mockResolvedValueOnce({
        ...testOffers[0],
        status: 'closed',
      });

      const messages = [
        {
          body: {
            type: 'match_offer',
            offer_id: 'offer-001',
            neighborhood_id: 'nb-001',
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      await handleMatchingQueue(messages as any, mockEnv);

      expect(messages[0].ack).toHaveBeenCalled();
      expect(mockEnv.DB.all).not.toHaveBeenCalled();
    });

    it('should process match_need message', async () => {
      const mockOffer = testOffers[0];
      const mockNeed = testNeeds[0];

      mockEnv.DB.first.mockResolvedValueOnce(mockNeed); // getLeftoverNeedById
      mockEnv.DB.all.mockResolvedValueOnce({ results: [mockOffer] }); // getActiveLeftoverOffers
      mockEnv.DB.run.mockResolvedValue({ success: true });
      mockEnv.DB.first.mockResolvedValue({
        id: 'match-001',
        offer_id: mockOffer.id,
        need_id: mockNeed.id,
        score: 0.85,
      });

      const messages = [
        {
          body: {
            type: 'match_need',
            need_id: 'need-001',
            neighborhood_id: 'nb-001',
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      await handleMatchingQueue(messages as any, mockEnv);

      expect(messages[0].ack).toHaveBeenCalled();
    });

    it('should process scheduled_matching message', async () => {
      mockEnv.DB.all.mockResolvedValueOnce({ results: testOffers }); // offers
      mockEnv.DB.all.mockResolvedValueOnce({ results: testNeeds }); // needs
      mockEnv.DB.run.mockResolvedValue({ success: true });
      mockEnv.DB.first.mockResolvedValue({
        id: 'match-001',
        score: 0.85,
      });

      const messages = [
        {
          body: {
            type: 'scheduled_matching',
            neighborhood_id: 'nb-001',
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      await handleMatchingQueue(messages as any, mockEnv);

      expect(messages[0].ack).toHaveBeenCalled();
    });

    it('should retry on error', async () => {
      mockEnv.DB.first.mockRejectedValue(new Error('Database error'));

      const messages = [
        {
          body: {
            type: 'match_offer',
            offer_id: 'offer-001',
            neighborhood_id: 'nb-001',
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      await handleMatchingQueue(messages as any, mockEnv);

      expect(messages[0].retry).toHaveBeenCalled();
      expect(messages[0].ack).not.toHaveBeenCalled();
    });

    it('should filter out same user matches', async () => {
      // Offer and need from same user
      const mockOffer = {
        ...testOffers[0],
        user_id: 'user-001',
      };
      const mockNeed = {
        ...testNeeds[0],
        user_id: 'user-001', // Same user
      };

      mockEnv.DB.first.mockResolvedValueOnce(mockOffer);
      mockEnv.DB.all.mockResolvedValueOnce({ results: [mockNeed] });

      const messages = [
        {
          body: {
            type: 'match_offer',
            offer_id: 'offer-001',
            neighborhood_id: 'nb-001',
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      await handleMatchingQueue(messages as any, mockEnv);

      // Should not create a match for same user
      expect(mockEnv.DB.prepare).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO matches')
      );
    });
  });
});
