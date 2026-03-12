/**
 * Tests for Campaign Queue Consumer
 *
 * Mocks global fetch to intercept Jina AI Reader and Gemini API calls.
 * DB mock pattern matches the rest of the test suite.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  handleCampaignQueue,
  handleScheduledCampaignIngestion,
} from "../../src/queues/campaign";
import { createMockEnv } from "../fixtures";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMessage(body: Record<string, unknown>) {
  return {
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function makeBatch(messages: ReturnType<typeof makeMessage>[]) {
  return { messages } as any;
}

/** Gemini response shape for a single extracted event */
function geminiResponse(events: object[]) {
  return {
    candidates: [
      {
        content: {
          parts: [{ text: JSON.stringify(events) }],
        },
      },
    ],
  };
}

const MOCK_EVENT = {
  title: "Camp Scout National",
  description: "Rassemblement annuel des scouts algeriens",
  organizer: "CRA Alger",
  location: "Alger",
  start_dt: "2025-08-01T09:00:00",
  end_dt: "2025-08-07T18:00:00",
  url: "https://cra.dz/camp-2025",
  image_url: "https://cra.dz/images/camp.jpg",
};

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("Campaign Queue", () => {
  let mockEnv: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = createMockEnv();

    // Add JINA_API_KEY to env (not in base createMockEnv)
    (mockEnv as any).JINA_API_KEY = "test-jina-key";
  });

  // ── handleCampaignQueue ───────────────────────────────────────────────────

  describe("handleCampaignQueue", () => {
    it("should process campaign ingestion message", async () => {
      // expireOldCampaigns UPDATE
      mockEnv.DB.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ meta: { changes: 2 } }),
      });
      // neighborhoods SELECT
      mockEnv.DB.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnThis(),
        all: vi
          .fn()
          .mockResolvedValue({ results: [{ id: "nb-001", name: "Hydra" }] }),
      });
      // createOrUpdateCampaign INSERT (one event x one neighborhood)
      mockEnv.DB.prepare.mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ success: true }),
        first: vi.fn().mockResolvedValue({ id: "camp-001" }),
        all: vi.fn().mockResolvedValue({ results: [] }),
      });

      // Mock fetch: Jina returns markdown, Gemini returns one event
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(
            new Response("# CRA Events\n\n## Camp Scout National", {
              status: 200,
            }),
          )
          .mockResolvedValueOnce(
            new Response(JSON.stringify(geminiResponse([MOCK_EVENT])), {
              status: 200,
            }),
          ),
      );

      const message = makeMessage({
        type: "ingest",
        timestamp: new Date().toISOString(),
      });
      await handleCampaignQueue(makeBatch([message]), mockEnv as any);

      expect(message.ack).toHaveBeenCalled();
      expect(message.retry).not.toHaveBeenCalled();
    });

    it("should process campaign expire message", async () => {
      // expireOldCampaigns UPDATE only - no scrape
      mockEnv.DB.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ meta: { changes: 5 } }),
      });

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const message = makeMessage({
        type: "expire_old",
        timestamp: new Date().toISOString(),
      });
      await handleCampaignQueue(makeBatch([message]), mockEnv as any);

      expect(message.ack).toHaveBeenCalled();
      // Should NOT call Jina or Gemini for an expire_old message
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should handle unknown message type", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const message = makeMessage({
        type: "unknown_type",
        timestamp: new Date().toISOString(),
      });
      await handleCampaignQueue(makeBatch([message]), mockEnv as any);

      // Should ack (not retry) for unknown types - no point retrying garbage
      expect(message.ack).toHaveBeenCalled();
      expect(message.retry).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Unknown message type"),
      );

      warnSpy.mockRestore();
    });

    it("should retry on error", async () => {
      // Make expireOldCampaigns (first DB call inside ingest) throw
      mockEnv.DB.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockRejectedValue(new Error("D1 connection error")),
      });

      vi.stubGlobal("fetch", vi.fn());

      const message = makeMessage({
        type: "ingest",
        timestamp: new Date().toISOString(),
      });
      await handleCampaignQueue(makeBatch([message]), mockEnv as any);

      expect(message.retry).toHaveBeenCalled();
      expect(message.ack).not.toHaveBeenCalled();
    });
  });

  // ── handleScheduledCampaignIngestion ─────────────────────────────────────

  describe("handleScheduledCampaignIngestion", () => {
    it("should ingest campaigns for all active neighborhoods", async () => {
      // expireOldCampaigns
      mockEnv.DB.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
      });
      // neighborhoods
      mockEnv.DB.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [
            { id: "nb-001", name: "Hydra" },
            { id: "nb-002", name: "Bab Ezzouar" },
          ],
        }),
      });
      // createOrUpdateCampaign calls (2 neighborhoods x 1 event = 2 upserts)
      mockEnv.DB.prepare.mockReturnValue({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ success: true }),
        first: vi.fn().mockResolvedValue({ id: "camp-001" }),
        all: vi.fn().mockResolvedValue({ results: [] }),
      });

      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(new Response("# Events", { status: 200 }))
          .mockResolvedValueOnce(
            new Response(JSON.stringify(geminiResponse([MOCK_EVENT])), {
              status: 200,
            }),
          ),
      );

      await handleScheduledCampaignIngestion(mockEnv as any);

      // Both Jina and Gemini should have been called
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    });

    it("should handle empty neighborhoods list", async () => {
      // expireOldCampaigns
      mockEnv.DB.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
      });
      // neighborhoods - empty
      mockEnv.DB.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({ results: [] }),
      });

      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await handleScheduledCampaignIngestion(mockEnv as any);

      // No scrape should happen when there are no neighborhoods
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("should continue on individual neighborhood error", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      // expireOldCampaigns
      mockEnv.DB.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnThis(),
        run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
      });
      // neighborhoods
      mockEnv.DB.prepare.mockReturnValueOnce({
        bind: vi.fn().mockReturnThis(),
        all: vi.fn().mockResolvedValue({
          results: [
            { id: "nb-001", name: "Hydra" },
            { id: "nb-002", name: "Bab Ezzouar" },
          ],
        }),
      });
      // First upsert throws, second succeeds
      mockEnv.DB.prepare
        .mockReturnValueOnce({
          bind: vi.fn().mockReturnThis(),
          run: vi.fn().mockRejectedValue(new Error("Constraint error")),
        })
        .mockReturnValue({
          bind: vi.fn().mockReturnThis(),
          run: vi.fn().mockResolvedValue({ success: true }),
          first: vi.fn().mockResolvedValue({ id: "camp-001" }),
          all: vi.fn().mockResolvedValue({ results: [] }),
        });

      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(new Response("# Events", { status: 200 }))
          .mockResolvedValueOnce(
            new Response(JSON.stringify(geminiResponse([MOCK_EVENT])), {
              status: 200,
            }),
          ),
      );

      // Should not throw - errors are caught per-upsert
      await expect(
        handleScheduledCampaignIngestion(mockEnv as any),
      ).resolves.not.toThrow();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to upsert"),
        expect.any(Error),
      );

      errorSpy.mockRestore();
    });
  });
});
