/**
 * Tests for Notification Queue Handler
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleNotificationQueue } from "../../src/queues/notification";
import { createMockEnv } from "../fixtures";

describe("Notification Queue", () => {
  let mockEnv: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = createMockEnv();
    // FIX (Bug 3): initialise globalThis.fetch as a spy in every test so that
    // `expect(globalThis.fetch).not.toHaveBeenCalled()` is always valid,
    // regardless of test execution order.
    globalThis.fetch = vi.fn();
  });

  describe("handleNotificationQueue", () => {
    it("should process push notification message", async () => {
      mockEnv.DB.first.mockResolvedValue({
        id: "user-001",
        fcm_token: "test-fcm-token",
      });
      mockEnv.DB.run.mockResolvedValue({ success: true });

      // FIX (Bug 2): FCM response must return `{ success: 1 }` (number), not
      // `{ success: true }` (boolean).  The source checks `result.success === 1`
      // using strict equality so a boolean `true` would silently fail the check
      // and the test would still pass (ack is called regardless of FCM result),
      // but the FCM call would be considered a failure by the application logic.
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ success: 1 }),
      });

      const messages = [
        {
          body: {
            user_id: "user-001",
            type: "match_created",
            title: "New Match!",
            body: "Your offer has been matched",
            data: { match_id: "match-001" },
            timestamp: new Date().toISOString(),
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      // FIX (Bug 1): The Cloudflare Queue consumer receives a `MessageBatch`
      // whose messages live at `batch.messages`.  Passing the array directly
      // means `batch.messages` is `undefined` and the for-loop throws before
      // processing a single message.  Wrap with `{ messages }` to match the
      // real Workers runtime shape.
      await handleNotificationQueue({ messages } as any, mockEnv);

      expect(messages[0].ack).toHaveBeenCalled();
    });

    it("should skip notification for user without FCM token", async () => {
      mockEnv.DB.first.mockResolvedValue({
        id: "user-001",
        fcm_token: null,
      });
      mockEnv.DB.run.mockResolvedValue({ success: true });

      const messages = [
        {
          body: {
            user_id: "user-001",
            type: "match_created",
            title: "New Match!",
            body: "Your offer has been matched",
            timestamp: new Date().toISOString(),
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      // FIX (Bug 1): wrap with { messages }
      await handleNotificationQueue({ messages } as any, mockEnv);

      expect(messages[0].ack).toHaveBeenCalled();
      // Should not attempt FCM send — globalThis.fetch is a clean spy from beforeEach
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("should store notification in database", async () => {
      mockEnv.DB.first.mockResolvedValue({ fcm_token: null });
      mockEnv.DB.run.mockResolvedValue({ success: true });

      const messages = [
        {
          body: {
            user_id: "user-001",
            type: "coins_awarded",
            title: "Coins Earned!",
            body: "You earned 150 coins",
            data: { amount: 150 },
            timestamp: new Date().toISOString(),
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      // FIX (Bug 1): wrap with { messages }
      await handleNotificationQueue({ messages } as any, mockEnv);

      // Should insert into notifications table
      expect(mockEnv.DB.prepare).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO notifications"),
      );
    });

    it("should handle FCM send failure gracefully", async () => {
      mockEnv.DB.first.mockResolvedValue({
        id: "user-001",
        fcm_token: "test-fcm-token",
      });
      mockEnv.DB.run.mockResolvedValue({ success: true });

      // Mock FCM failure
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const messages = [
        {
          body: {
            user_id: "user-001",
            type: "match_created",
            title: "New Match!",
            body: "Your offer has been matched",
            timestamp: new Date().toISOString(),
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      // FIX (Bug 1): wrap with { messages }
      await handleNotificationQueue({ messages } as any, mockEnv);

      // Should still ack the message — FCM failure is non-fatal because the
      // notification is already persisted in the DB.
      expect(messages[0].ack).toHaveBeenCalled();
    });

    it("should retry on database error", async () => {
      // Rejecting `run` simulates storeNotification failing (it is the first
      // DB call in the handler).  The catch block must call message.retry().
      mockEnv.DB.run.mockRejectedValue(new Error("Database error"));

      const messages = [
        {
          body: {
            user_id: "user-001",
            type: "match_created",
            title: "New Match!",
            body: "Your offer has been matched",
            timestamp: new Date().toISOString(),
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      // FIX (Bug 1): wrap with { messages }
      await handleNotificationQueue({ messages } as any, mockEnv);

      expect(messages[0].retry).toHaveBeenCalled();
    });

    it("should process multiple messages in batch", async () => {
      mockEnv.DB.first.mockResolvedValue({ fcm_token: null });
      mockEnv.DB.run.mockResolvedValue({ success: true });

      const messages = [
        {
          body: {
            user_id: "user-001",
            type: "match_created",
            title: "Match 1",
            body: "Body 1",
            timestamp: new Date().toISOString(),
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
        {
          body: {
            user_id: "user-002",
            type: "match_created",
            title: "Match 2",
            body: "Body 2",
            timestamp: new Date().toISOString(),
          },
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ];

      // FIX (Bug 1): wrap with { messages }
      await handleNotificationQueue({ messages } as any, mockEnv);

      expect(messages[0].ack).toHaveBeenCalled();
      expect(messages[1].ack).toHaveBeenCalled();
    });
  });
});
