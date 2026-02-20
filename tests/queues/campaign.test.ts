/**
 * Tests for Campaign Queue Handler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCampaignQueue, handleScheduledCampaignIngestion } from '../../src/queues/campaign';
import { createMockEnv, testCampaigns, testNeighborhoods } from '../fixtures';

describe('Campaign Queue', () => {
  let mockEnv: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = createMockEnv();
  });

  describe('handleCampaignQueue', () => {
    it('should process campaign ingestion message', async () => {
      mockEnv.DB.all.mockResolvedValueOnce({ results: testNeighborhoods });
      mockEnv.DB.all.mockResolvedValueOnce({ results: [] }); // No existing campaigns
      mockEnv.DB.run.mockResolvedValue({ success: true });
      mockEnv.DB.first.mockResolvedValue(testCampaigns[0]);

      const messages = [
        {
          body: {
            type: 'ingest',
            source: 'manual',
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      await handleCampaignQueue(messages as any, mockEnv);

      expect(messages[0].ack).toHaveBeenCalled();
    });

    it('should process campaign expire message', async () => {
      mockEnv.DB.run.mockResolvedValue({ success: true, meta: { changes: 5 } });

      const messages = [
        {
          body: {
            type: 'expire_old',
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      await handleCampaignQueue(messages as any, mockEnv);

      expect(messages[0].ack).toHaveBeenCalled();
    });

    it('should handle unknown message type', async () => {
      const messages = [
        {
          body: {
            type: 'unknown_type',
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      await handleCampaignQueue(messages as any, mockEnv);

      // Should still ack to prevent reprocessing
      expect(messages[0].ack).toHaveBeenCalled();
    });

    it('should retry on error', async () => {
      mockEnv.DB.all.mockRejectedValue(new Error('Database error'));

      const messages = [
        {
          body: {
            type: 'ingest',
            source: 'manual',
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      await handleCampaignQueue(messages as any, mockEnv);

      expect(messages[0].retry).toHaveBeenCalled();
    });
  });

  describe('handleScheduledCampaignIngestion', () => {
    it('should ingest campaigns for all active neighborhoods', async () => {
      mockEnv.DB.all.mockResolvedValueOnce({ results: testNeighborhoods });
      mockEnv.DB.run.mockResolvedValue({ success: true });

      await handleScheduledCampaignIngestion(mockEnv);

      expect(mockEnv.CAMPAIGN_QUEUE.send).toHaveBeenCalled();
    });

    it('should handle empty neighborhoods list', async () => {
      mockEnv.DB.all.mockResolvedValueOnce({ results: [] });

      await handleScheduledCampaignIngestion(mockEnv);

      // Should not throw
      expect(mockEnv.CAMPAIGN_QUEUE.send).not.toHaveBeenCalled();
    });

    it('should continue on individual neighborhood error', async () => {
      mockEnv.DB.all.mockResolvedValueOnce({ results: testNeighborhoods });
      mockEnv.DB.run.mockRejectedValueOnce(new Error('Error for first neighborhood'));
      mockEnv.DB.run.mockResolvedValue({ success: true });

      // Should not throw
      await expect(handleScheduledCampaignIngestion(mockEnv)).resolves.not.toThrow();
    });
  });
});
