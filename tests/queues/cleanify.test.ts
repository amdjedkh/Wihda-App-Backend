/**
 * Tests: Cleanify Queue Consumer
 *
 * Tests the handleCleanifyQueue function which receives 'run_ai_check'
 * messages, calls Gemini Vision, finalizes the submission in D1, awards
 * coins on approval, notifies the user, and deletes photos from R2.
 *
 * Pattern:
 *   - Mock fetch() globally to intercept Gemini API calls
 *   - Prime DB via mockEnv.DB.prepare.mockReturnValueOnce in query order
 *   - Prime R2 via mockEnv.STORAGE.get.mockResolvedValueOnce
 *   - Assert on DB prepare call count, NOTIFICATION_QUEUE.send, STORAGE.delete
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleCleanifyQueue } from "../../src/queues/cleanify";
import { createMockEnv } from "../fixtures";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal fake R2 object with arrayBuffer() support. */
function fakeR2Object(content = "fake-image-bytes") {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content);
  return {
    arrayBuffer: vi.fn().mockResolvedValue(bytes.buffer),
    text: vi.fn().mockResolvedValue(content),
    json: vi.fn(),
    blob: vi.fn(),
    body: null,
    bodyUsed: false,
    headers: new Headers(),
    key: "fake-key",
    version: "1",
    size: bytes.length,
    etag: "fake-etag",
    httpEtag: '"fake-etag"',
    checksums: {},
    uploaded: new Date(),
    httpMetadata: {},
    customMetadata: {},
    range: undefined,
    writeHttpMetadata: vi.fn(),
  };
}

function makeStmt(firstVal: unknown = null, allVal: unknown[] = []) {
  return {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(firstVal),
    all: vi.fn().mockResolvedValue({ results: allVal, success: true }),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
    raw: vi.fn().mockResolvedValue([]),
  };
}

/** Build a minimal MessageBatch<CleanifyQueueMessage> mock. */
function makeBatch(body: Record<string, unknown>) {
  const message = {
    id: "msg-001",
    timestamp: new Date(),
    attempts: 1,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
  return {
    queue: "wihda-cleanify-queue",
    messages: [message],
  } as any;
}

/** Build a Gemini API response JSON string with the given result. */
function geminiResponse(payload: Record<string, unknown>) {
  return JSON.stringify({
    candidates: [
      {
        content: {
          parts: [{ text: JSON.stringify(payload) }],
        },
      },
    ],
  });
}

const BASE_MESSAGE = {
  type: "run_ai_check",
  submission_id: "sub-001",
  user_id: "user-003",
  neighborhood_id: "nb-001",
  timestamp: new Date().toISOString(),
};

const PENDING_SUBMISSION = {
  id: "sub-001",
  user_id: "user-003",
  neighborhood_id: "nb-001",
  before_photo_key: "cleanify/user-003/sub-001/before.jpg",
  after_photo_key: "cleanify/user-003/sub-001/after.jpg",
  status: "pending_review",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handleCleanifyQueue — run_ai_check", () => {
  let mockEnv: ReturnType<typeof createMockEnv>;
  let fetchSpy: ReturnType<typeof vi.spyOn<any, any>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv = createMockEnv();
    fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<
      typeof vi.spyOn<any, any>
    >;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // ── Happy path: approved ──────────────────────────────────────────────────

  it("approves submission, awards coins, and notifies user when Gemini approves", async () => {
    // DB: 1. fetch submission, 2. UPDATE finalise, 3. coin rule, 4. INSERT coin
    mockEnv.DB.prepare
      .mockReturnValueOnce(makeStmt(PENDING_SUBMISSION)) // SELECT submission
      .mockReturnValueOnce(makeStmt()) // UPDATE status→approved
      .mockReturnValueOnce(makeStmt({ amount: 150 })) // SELECT coin rule
      .mockReturnValueOnce(makeStmt()); // INSERT coin ledger

    // R2: before + after images
    mockEnv.STORAGE.get
      .mockResolvedValueOnce(fakeR2Object()) // before
      .mockResolvedValueOnce(fakeR2Object()); // after

    // Gemini: approve with high confidence
    fetchSpy.mockResolvedValueOnce(
      new Response(
        geminiResponse({
          approved: true,
          confidence: 0.92,
          checks: {
            same_location: true,
            visible_improvement: true,
            photos_authentic: true,
            photos_different: true,
          },
          rejection_reason: null,
        }),
        { status: 200 },
      ),
    );

    const batch = makeBatch(BASE_MESSAGE);
    await handleCleanifyQueue(batch, mockEnv as any);

    // Message acked
    expect(batch.messages[0].ack).toHaveBeenCalled();
    expect(batch.messages[0].retry).not.toHaveBeenCalled();

    // User notified with approval
    expect(mockEnv.NOTIFICATION_QUEUE.send).toHaveBeenCalledOnce();
    expect(mockEnv.NOTIFICATION_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user-003",
        type: "cleanify_approved",
      }),
    );

    // Photos deleted from R2
    expect(mockEnv.STORAGE.delete).toHaveBeenCalledWith(
      "cleanify/user-003/sub-001/before.jpg",
    );
    expect(mockEnv.STORAGE.delete).toHaveBeenCalledWith(
      "cleanify/user-003/sub-001/after.jpg",
    );
  });

  // ── Happy path: rejected ──────────────────────────────────────────────────

  it("rejects submission and notifies user with rejection reason when Gemini rejects", async () => {
    mockEnv.DB.prepare
      .mockReturnValueOnce(makeStmt(PENDING_SUBMISSION)) // SELECT submission
      .mockReturnValueOnce(makeStmt()) // UPDATE status→rejected
      .mockReturnValueOnce(makeStmt({ amount: 150 })); // SELECT coin rule (still fetched)

    mockEnv.STORAGE.get
      .mockResolvedValueOnce(fakeR2Object())
      .mockResolvedValueOnce(fakeR2Object());

    fetchSpy.mockResolvedValueOnce(
      new Response(
        geminiResponse({
          approved: false,
          confidence: 0.85,
          checks: {
            same_location: false,
            visible_improvement: false,
            photos_authentic: true,
            photos_different: true,
          },
          rejection_reason:
            "Before and after photos do not appear to show the same location.",
        }),
        { status: 200 },
      ),
    );

    const batch = makeBatch(BASE_MESSAGE);
    await handleCleanifyQueue(batch, mockEnv as any);

    expect(batch.messages[0].ack).toHaveBeenCalled();

    expect(mockEnv.NOTIFICATION_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user-003",
        type: "cleanify_rejected",
        body: expect.stringContaining("same location"),
      }),
    );

    // No coins awarded
    const prepareCallSqls = (mockEnv.DB.prepare.mock.calls as string[][]).map(
      (args) => args[0],
    );
    expect(
      prepareCallSqls.some((sql) =>
        sql.includes("INSERT INTO coin_ledger_entries"),
      ),
    ).toBe(false);
  });

  // ── Low confidence rejected ───────────────────────────────────────────────

  it("rejects when Gemini approves but confidence is below threshold", async () => {
    mockEnv.DB.prepare
      .mockReturnValueOnce(makeStmt(PENDING_SUBMISSION))
      .mockReturnValueOnce(makeStmt())
      .mockReturnValueOnce(makeStmt({ amount: 150 }));

    mockEnv.STORAGE.get
      .mockResolvedValueOnce(fakeR2Object())
      .mockResolvedValueOnce(fakeR2Object());

    fetchSpy.mockResolvedValueOnce(
      new Response(
        geminiResponse({
          approved: true,
          confidence: 0.55, // below 0.70 threshold
          checks: {
            same_location: true,
            visible_improvement: true,
            photos_authentic: true,
            photos_different: true,
          },
          rejection_reason: null,
        }),
        { status: 200 },
      ),
    );

    const batch = makeBatch(BASE_MESSAGE);
    await handleCleanifyQueue(batch, mockEnv as any);

    expect(mockEnv.NOTIFICATION_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "cleanify_rejected",
        body: expect.stringContaining("confidence score"),
      }),
    );
  });

  // ── Idempotency ───────────────────────────────────────────────────────────

  it("skips and acks if submission is no longer pending_review (idempotency)", async () => {
    const alreadyApproved = { ...PENDING_SUBMISSION, status: "approved" };
    mockEnv.DB.prepare.mockReturnValueOnce(makeStmt(alreadyApproved));

    const batch = makeBatch(BASE_MESSAGE);
    await handleCleanifyQueue(batch, mockEnv as any);

    expect(batch.messages[0].ack).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled(); // Gemini must not be called
    expect(mockEnv.NOTIFICATION_QUEUE.send).not.toHaveBeenCalled();
  });

  // ── Not found ────────────────────────────────────────────────────────────

  it("acks without processing when submission is not found", async () => {
    mockEnv.DB.prepare.mockReturnValueOnce(makeStmt(null));

    const batch = makeBatch(BASE_MESSAGE);
    await handleCleanifyQueue(batch, mockEnv as any);

    expect(batch.messages[0].ack).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── Missing photos ────────────────────────────────────────────────────────

  it("rejects and notifies when photo keys are missing from the submission row", async () => {
    const missingKeys = {
      ...PENDING_SUBMISSION,
      before_photo_key: null,
      after_photo_key: null,
    };
    mockEnv.DB.prepare
      .mockReturnValueOnce(makeStmt(missingKeys)) // SELECT submission
      .mockReturnValueOnce(makeStmt()) // UPDATE
      .mockReturnValueOnce(makeStmt({ amount: 150 })); // coin rule

    const batch = makeBatch(BASE_MESSAGE);
    await handleCleanifyQueue(batch, mockEnv as any);

    expect(batch.messages[0].ack).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockEnv.NOTIFICATION_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "cleanify_rejected" }),
    );
  });

  // ── R2 fetch failure ──────────────────────────────────────────────────────

  it("rejects and notifies when R2 cannot retrieve photos", async () => {
    mockEnv.DB.prepare
      .mockReturnValueOnce(makeStmt(PENDING_SUBMISSION))
      .mockReturnValueOnce(makeStmt())
      .mockReturnValueOnce(makeStmt({ amount: 150 }));

    // R2 returns null (object not found)
    mockEnv.STORAGE.get.mockResolvedValue(null);

    const batch = makeBatch(BASE_MESSAGE);
    await handleCleanifyQueue(batch, mockEnv as any);

    expect(batch.messages[0].ack).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockEnv.NOTIFICATION_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "cleanify_rejected" }),
    );
  });

  // ── Gemini API error → retry ──────────────────────────────────────────────

  it("retries the message when the Gemini API returns a non-200 response", async () => {
    mockEnv.DB.prepare.mockReturnValueOnce(makeStmt(PENDING_SUBMISSION));

    mockEnv.STORAGE.get
      .mockResolvedValueOnce(fakeR2Object())
      .mockResolvedValueOnce(fakeR2Object());

    fetchSpy.mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );

    const batch = makeBatch(BASE_MESSAGE);
    await handleCleanifyQueue(batch, mockEnv as any);

    expect(batch.messages[0].retry).toHaveBeenCalled();
    expect(batch.messages[0].ack).not.toHaveBeenCalled();
  });

  // ── Gemini non-JSON response ──────────────────────────────────────────────

  it("rejects gracefully when Gemini returns non-JSON text", async () => {
    mockEnv.DB.prepare
      .mockReturnValueOnce(makeStmt(PENDING_SUBMISSION))
      .mockReturnValueOnce(makeStmt())
      .mockReturnValueOnce(makeStmt({ amount: 150 }));

    mockEnv.STORAGE.get
      .mockResolvedValueOnce(fakeR2Object())
      .mockResolvedValueOnce(fakeR2Object());

    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: "not valid json at all" }] } },
          ],
        }),
        { status: 200 },
      ),
    );

    const batch = makeBatch(BASE_MESSAGE);
    await handleCleanifyQueue(batch, mockEnv as any);

    // Should still ack (graceful degradation), not retry
    expect(batch.messages[0].ack).toHaveBeenCalled();
    expect(mockEnv.NOTIFICATION_QUEUE.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "cleanify_rejected" }),
    );
  });

  // ── Unknown message type ──────────────────────────────────────────────────

  it("acks and skips messages with an unknown type", async () => {
    const batch = makeBatch({
      type: "unknown_type",
      timestamp: new Date().toISOString(),
    });
    await handleCleanifyQueue(batch, mockEnv as any);

    expect(batch.messages[0].ack).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
