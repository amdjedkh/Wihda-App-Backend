/**
 * Wihda Backend - Cleanify Queue Consumer
 *
 * Handles 'run_ai_check':
 *   1. Fetch before + after photos from R2
 *   2. Call Gemini Vision API with both images
 *   3. Write result to D1 (approved / rejected)
 *   4. Award coins on approval (idempotent)
 *   5. Enqueue user notification
 *   6. Delete raw photos from R2 (storage hygiene)
 *
 * Moderator approve/reject endpoints remain available as manual overrides
 * for edge cases where AI confidence is insufficient or a user disputes.
 */

import type { Env, CleanifyQueueMessage } from "../types";

// ─── Gemini types ──────────────────────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

interface GeminiContent {
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates: Array<{
    content: { parts: Array<{ text: string }> };
  }>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const GEMINI_MODEL = "gemini-2.5-flash-lite";
const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";
const CONFIDENCE_THRESHOLD = 0.7;

const SYSTEM_PROMPT = `You are a photo verification assistant for Wihda, a civic neighbourhood application.

You will receive TWO photos submitted by a community member who claims to have cleaned a public area in their neighbourhood:
1. BEFORE photo — taken before the cleaning effort
2. AFTER photo — taken after the cleaning effort

Evaluate ALL of the following criteria:
- Same location: Do both photos appear to show the same physical location? Look for matching background, structures, pavement, walls, or other fixed landmarks.
- Visible improvement: Does the after photo show a genuine, measurable improvement in cleanliness compared to the before photo? (reduced litter, cleared debris, swept surfaces, removed graffiti, etc.)
- Photo authenticity: Do the photos appear to be genuine original photos taken by a phone camera? Reject stock images, AI-generated images, screenshots, or heavily filtered/edited photos.
- Photos are different: Are the two photos genuinely of a different state (same place, clearly different condition)? Reject submissions where both photos appear identical or nearly identical.

Approve the submission only if ALL four checks pass with reasonable confidence.
Be strict — the platform rewards coins for genuine civic effort.

Respond ONLY with a valid JSON object — no markdown, no preamble, no extra text:
{
  "approved": boolean,
  "confidence": number between 0.0 and 1.0,
  "checks": {
    "same_location": boolean,
    "visible_improvement": boolean,
    "photos_authentic": boolean,
    "photos_different": boolean
  },
  "rejection_reason": "string describing the specific problem, or null if approved"
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Fetch an R2 object and return base64-encoded bytes + inferred MIME type. */
async function fetchR2AsBase64(
  storage: R2Bucket,
  key: string,
): Promise<{ data: string; mimeType: string } | null> {
  const obj = await storage.get(key);
  if (!obj) return null;

  const bytes = await obj.arrayBuffer();
  const base64 = arrayBufferToBase64(bytes);

  const ext = key.split(".").pop()?.toLowerCase() ?? "jpg";
  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    heic: "image/heic",
    webp: "image/webp",
  };

  return { data: base64, mimeType: mimeMap[ext] ?? "image/jpeg" };
}

interface CleanifyAIResult {
  approved: boolean;
  confidence: number;
  rejection_reason?: string;
  raw: Record<string, unknown>;
}

/** Call Gemini Vision with before + after photos and parse the result. */
async function runGeminiCleanifyCheck(
  apiKey: string,
  beforeImage: { data: string; mimeType: string },
  afterImage: { data: string; mimeType: string },
): Promise<CleanifyAIResult> {
  const contents: GeminiContent[] = [
    {
      parts: [
        { text: SYSTEM_PROMPT },
        { text: "\n\n--- IMAGE 1: BEFORE the cleaning ---" },
        {
          inline_data: {
            mime_type: beforeImage.mimeType,
            data: beforeImage.data,
          },
        },
        { text: "\n\n--- IMAGE 2: AFTER the cleaning ---" },
        {
          inline_data: {
            mime_type: afterImage.mimeType,
            data: afterImage.data,
          },
        },
        { text: "\n\nRespond with the JSON object only." },
      ],
    },
  ];

  const url = `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 512,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`Gemini API error ${response.status}: ${text}`);
    (err as any).status = response.status;
    throw err;
  }

  const geminiData = (await response.json()) as GeminiResponse;
  const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

  const cleanedText = rawText
    .replace(/^```json\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleanedText);
  } catch {
    console.error("Gemini non-JSON response:", rawText);
    return {
      approved: false,
      confidence: 0,
      rejection_reason:
        "Photo analysis failed — AI returned an unparseable response.",
      raw: { rawText },
    };
  }

  const approved = Boolean(parsed.approved);
  const confidence =
    typeof parsed.confidence === "number" ? parsed.confidence : 0;
  const rejection_reason =
    !approved && typeof parsed.rejection_reason === "string"
      ? parsed.rejection_reason
      : undefined;

  // Enforce minimum confidence even when Gemini says approved
  if (approved && confidence < CONFIDENCE_THRESHOLD) {
    return {
      approved: false,
      confidence,
      rejection_reason: `Photo confidence score (${(confidence * 100).toFixed(0)}%) is below the required threshold. Please retake clearer photos.`,
      raw: parsed,
    };
  }

  return { approved, confidence, rejection_reason, raw: parsed };
}

// ─── DB helpers (inlined to stay consistent with verification.ts pattern) ─────

interface SubmissionRow {
  id: string;
  user_id: string;
  neighborhood_id: string;
  before_photo_key: string | null;
  after_photo_key: string | null;
  status: string;
}

async function finalizeSubmission(
  db: D1Database,
  submissionId: string,
  result: CleanifyAIResult,
  coinAmount: number,
): Promise<void> {
  const status = result.approved ? "approved" : "rejected";
  const now = new Date().toISOString();

  await db
    .prepare(
      `UPDATE cleanify_submissions
       SET status         = ?,
           reviewer_id    = NULL,
           reviewed_at    = ?,
           review_note    = ?,
           coins_awarded  = ?,
           updated_at     = ?
       WHERE id = ?`,
    )
    .bind(
      status,
      now,
      result.rejection_reason ?? null,
      result.approved ? coinAmount : 0,
      now,
      submissionId,
    )
    .run();
}

async function awardCoins(
  db: D1Database,
  submissionId: string,
  userId: string,
  neighborhoodId: string,
  amount: number,
): Promise<void> {
  // Idempotent: unique constraint on (source_type, source_id, user_id)
  // prevents double-awarding on message re-delivery.
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  try {
    await db
      .prepare(
        `INSERT INTO coin_ledger_entries
         (id, user_id, neighborhood_id, source_type, source_id, amount, category, description, created_at, created_by, status)
         VALUES (?, ?, ?, 'cleanify_approved', ?, ?, 'cleanify', 'Reward for AI-verified cleanify submission', ?, ?, 'valid')`,
      )
      .bind(id, userId, neighborhoodId, submissionId, amount, now, null)
      .run();
  } catch (err) {
    // Swallow unique-constraint violations — means coins were already awarded
    if (!(err as Error).message?.includes("UNIQUE constraint failed")) {
      throw err;
    }
  }
}

async function getCoinRewardAmount(db: D1Database): Promise<number> {
  const rule = await db
    .prepare(
      `SELECT amount FROM coin_rules WHERE source_type = 'cleanify_approved' AND is_active = 1 LIMIT 1`,
    )
    .first<{ amount: number }>();
  return rule?.amount ?? 150;
}

// ─── Main consumer ────────────────────────────────────────────────────────────

export async function handleCleanifyQueue(
  batch: MessageBatch<CleanifyQueueMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const { type, submission_id, user_id } = message.body;

    if (type !== "run_ai_check" || !submission_id || !user_id) {
      console.warn("Unexpected cleanify queue message:", message.body);
      message.ack();
      continue;
    }

    try {
      // ── 1. Fetch submission ──────────────────────────────────────────────────
      const row = await env.DB.prepare(
        `SELECT id, user_id, neighborhood_id, before_photo_key, after_photo_key, status
         FROM cleanify_submissions WHERE id = ? AND user_id = ?`,
      )
        .bind(submission_id, user_id)
        .first<SubmissionRow>();

      if (!row) {
        console.warn(
          `Cleanify submission ${submission_id} not found — acking to avoid poison pill`,
        );
        message.ack();
        continue;
      }

      // Idempotency: only process pending_review submissions
      if (row.status !== "pending_review") {
        console.warn(
          `Cleanify submission ${submission_id} is '${row.status}' — skipping`,
        );
        message.ack();
        continue;
      }

      // ── 2. Guard: both photo keys must exist ─────────────────────────────────
      if (!row.before_photo_key || !row.after_photo_key) {
        const fallback: CleanifyAIResult = {
          approved: false,
          confidence: 0,
          raw: {},
          rejection_reason:
            "One or more required photos are missing from storage.",
        };
        await finalizeSubmission(env.DB, submission_id, fallback, 0);
        await env.NOTIFICATION_QUEUE.send({
          user_id,
          type: "cleanify_rejected",
          title: "Submission Could Not Be Reviewed",
          body: fallback.rejection_reason!,
          data: { submission_id },
          timestamp: new Date().toISOString(),
        });
        message.ack();
        continue;
      }

      // ── 3. Fetch photos from R2 ──────────────────────────────────────────────
      const [beforeImage, afterImage] = await Promise.all([
        fetchR2AsBase64(env.STORAGE, row.before_photo_key),
        fetchR2AsBase64(env.STORAGE, row.after_photo_key),
      ]);

      if (!beforeImage || !afterImage) {
        const fallback: CleanifyAIResult = {
          approved: false,
          confidence: 0,
          raw: {},
          rejection_reason:
            "Could not retrieve one or more photos from storage.",
        };
        await finalizeSubmission(env.DB, submission_id, fallback, 0);
        await env.NOTIFICATION_QUEUE.send({
          user_id,
          type: "cleanify_rejected",
          title: "Submission Could Not Be Reviewed",
          body: fallback.rejection_reason!,
          data: { submission_id },
          timestamp: new Date().toISOString(),
        });
        message.ack();
        continue;
      }

      // ── 4. Run Gemini ────────────────────────────────────────────────────────
      console.log(`[cleanify] Running AI check for submission ${submission_id} with model ${GEMINI_MODEL}`);
      const result = await runGeminiCleanifyCheck(
        env.GEMINI_API_KEY,
        beforeImage,
        afterImage,
      );
      console.log(`[cleanify] AI result for ${submission_id}: approved=${result.approved} confidence=${result.confidence}`);

      // ── 5. Award coins first so they are in DB before status becomes visible ─
      const coinAmount = await getCoinRewardAmount(env.DB);
      if (result.approved) {
        await awardCoins(
          env.DB,
          submission_id,
          user_id,
          row.neighborhood_id,
          coinAmount,
        );
      }

      // ── 6. Finalize in DB (sets status → approved/rejected) ──────────────────
      await finalizeSubmission(env.DB, submission_id, result, coinAmount);

      // ── 7. Notify user ───────────────────────────────────────────────────────
      await env.NOTIFICATION_QUEUE.send(
        result.approved
          ? {
              user_id,
              type: "cleanify_approved",
              title: "Submission Approved! 🎉",
              body: `Your cleanify submission was verified. You earned ${coinAmount} coins!`,
              data: { submission_id, coins: coinAmount },
              timestamp: new Date().toISOString(),
            }
          : {
              user_id,
              type: "cleanify_rejected",
              title: "Submission Not Approved",
              body:
                result.rejection_reason ??
                "Your submission could not be verified. Please try again with clearer photos.",
              data: { submission_id },
              timestamp: new Date().toISOString(),
            },
      );

      // Photos are kept in R2 so users can view them on the result page.

      message.ack();
    } catch (err: any) {
      const status = err?.status;
      if (status === 429) {
        // Daily quota exceeded — retry later (queue will back off automatically)
        console.warn(`[cleanify] Rate limited for submission ${submission_id} — will retry`);
        message.retry({ delaySeconds: 3600 }); // retry in 1 hour
      } else {
        console.error(`[cleanify] FAILED for submission ${submission_id}:`, String(err));
        message.retry();
      }
    }
  }
}
