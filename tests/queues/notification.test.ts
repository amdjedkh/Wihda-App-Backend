/**
 * Tests for Notification Queue Handler
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleNotificationQueue } from '../../src/queues/notification';
import { createMockEnv } from '../fixtures';

describe('Notification Queue', () => {
  let mockEnv: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = createMockEnv();
  });

  describe('handleNotificationQueue', () => {
    it('should process push notification message', async () => {
      mockEnv.DB.first.mockResolvedValue({
        id: 'user-001',
        fcm_token: 'test-fcm-token',
      });
      mockEnv.DB.run.mockResolvedValue({ success: true });

      // Mock fetch for FCM
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });

      const messages = [
        {
          body: {
            user_id: 'user-001',
            type: 'match_created',
            title: 'New Match!',
            body: 'Your offer has been matched',
            data: { match_id: 'match-001' },
            timestamp: new Date().toISOString(),
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      await handleNotificationQueue(messages as any, mockEnv);

      expect(messages[0].ack).toHaveBeenCalled();
    });

    it('should skip notification for user without FCM token', async () => {
      mockEnv.DB.first.mockResolvedValue({
        id: 'user-001',
        fcm_token: null,
      });
      mockEnv.DB.run.mockResolvedValue({ success: true });

      const messages = [
        {
          body: {
            user_id: 'user-001',
            type: 'match_created',
            title: 'New Match!',
            body: 'Your offer has been matched',
            timestamp: new Date().toISOString(),
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      await handleNotificationQueue(messages as any, mockEnv);

      expect(messages[0].ack).toHaveBeenCalled();
      // Should not attempt FCM send
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should store notification in database', async () => {
      mockEnv.DB.first.mockResolvedValue({ fcm_token: null });
      mockEnv.DB.run.mockResolvedValue({ success: true });

      const messages = [
        {
          body: {
            user_id: 'user-001',
            type: 'coins_awarded',
            title: 'Coins Earned!',
            body: 'You earned 150 coins',
            data: { amount: 150 },
            timestamp: new Date().toISOString(),
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      await handleNotificationQueue(messages as any, mockEnv);

      // Should insert into notifications table
      expect(mockEnv.DB.prepare).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO notifications')
      );
    });

    it('should handle FCM send failure gracefully', async () => {
      mockEnv.DB.first.mockResolvedValue({
        id: 'user-001',
        fcm_token: 'test-fcm-token',
      });
      mockEnv.DB.run.mockResolvedValue({ success: true });

      // Mock FCM failure
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const messages = [
        {
          body: {
            user_id: 'user-001',
            type: 'match_created',
            title: 'New Match!',
            body: 'Your offer has been matched',
            timestamp: new Date().toISOString(),
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      await handleNotificationQueue(messages as any, mockEnv);

      // Should still ack the message (notification stored in DB)
      expect(messages[0].ack).toHaveBeenCalled();
    });

    it('should retry on database error', async () => {
      mockEnv.DB.first.mockRejectedValue(new Error('Database error'));

      const messages = [
        {
          body: {
            user_id: 'user-001',
            type: 'match_created',
            title: 'New Match!',
            body: 'Your offer has been matched',
            timestamp: new Date().toISOString(),
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      await handleNotificationQueue(messages as any, mockEnv);

      expect(messages[0].retry).toHaveBeenCalled();
    });

    it('should process multiple messages in batch', async () => {
      mockEnv.DB.first.mockResolvedValue({ fcm_token: null });
      mockEnv.DB.run.mockResolvedValue({ success: true });

      const messages = [
        {
          body: {
            user_id: 'user-001',
            type: 'match_created',
            title: 'Match 1',
            body: 'Body 1',
            timestamp: new Date().toISOString(),
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
        {
          body: {
            user_id: 'user-002',
            type: 'match_created',
            title: 'Match 2',
            body: 'Body 2',
            timestamp: new Date().toISOString(),
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      await handleNotificationQueue(messages as any, mockEnv);

      expect(messages[0].ack).toHaveBeenCalled();
      expect(messages[1].ack).toHaveBeenCalled();
    });
  });
});
