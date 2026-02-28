/**
 * Wihda Backend - Verification Queue Consumer
 *
 * Handles 'run_ai_check':
 *   1. Fetch document images from R2
 *   2. Call Gemini Vision API
 *   3. Write result directly to D1
 *   4. Enqueue notification
 *   5. Delete raw images from R2 (PII retention policy)
 *
 * Handles 'expire_sessions' (triggered by the existing scheduled cron):
 *   Mark stale sessions as expired and reset affected users to 'unverified'.
 */

import type { Env, VerificationQueueMessage } from "../types";

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
const CONFIDENCE_THRESHOLD = 0.75;

const SYSTEM_PROMPT = `You are an identity document verification assistant for the Wihda platform, a civic neighbourhood application.

You will receive three images:
1. FRONT of a national ID card or passport
2. BACK of the ID card (or second angle of the passport)
3. SELFIE of the document holder

Evaluate ALL of the following:
- Document authenticity: Is the document a real, unaltered national ID or passport? Check for consistent formatting and no obvious edits.
- Selfie match: Does the face in the selfie plausibly match the photo on the document?
- Readability: Are the ID number, full name, and expiry date visible and legible?
- Validity: Is the document not yet expired based on the visible expiry date?

Respond ONLY with a valid JSON object — no markdown, no preamble, no extra text:
{
  "approved": boolean,
  "confidence": number between 0.0 and 1.0,
  "checks": {
    "document_authentic": boolean,
    "selfie_matches": boolean,
    "document_readable": boolean,
    "not_expired": boolean
  },
  "rejection_reason": "string describing the problem, or null if approved"
}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Fetch an R2 object and return base64-encoded bytes + inferred MIME type. */
async function fetchR2AsBase64(
  storage: R2Bucket,
  key: string,
): Promise<{ data: string; mimeType: string } | null> {
  const obj = await storage.get(key);
  if (!obj) return null;

  const bytes = await obj.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));

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

interface VerificationResult {
  approved: boolean;
  confidence: number;
  rejection_reason?: string;
  raw: Record<string, unknown>;
}

/** Call Gemini Vision and parse the structured response. */
async function runGeminiVerification(
  apiKey: string,
  frontImage: { data: string; mimeType: string },
  backImage: { data: string; mimeType: string },
  selfieImage: { data: string; mimeType: string },
): Promise<VerificationResult> {
  const contents: GeminiContent[] = [
    {
      parts: [
        { text: SYSTEM_PROMPT },
        { text: "\n\n--- IMAGE 1: Front of ID document ---" },
        {
          inline_data: {
            mime_type: frontImage.mimeType,
            data: frontImage.data,
          },
        },
        { text: "\n\n--- IMAGE 2: Back of ID document ---" },
        {
          inline_data: { mime_type: backImage.mimeType, data: backImage.data },
        },
        { text: "\n\n--- IMAGE 3: Selfie of document holder ---" },
        {
          inline_data: {
            mime_type: selfieImage.mimeType,
            data: selfieImage.data,
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
        temperature: 0.1, // deterministic output
        maxOutputTokens: 512,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${text}`);
  }

  const geminiData = (await response.json()) as GeminiResponse;
  const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

  // Strip accidental markdown fences
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
        "Document analysis failed — AI returned an unparseable response.",
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
      rejection_reason: `Confidence score (${(confidence * 100).toFixed(0)}%) is below the required threshold.`,
      raw: parsed,
    };
  }

  return { approved, confidence, rejection_reason, raw: parsed };
}

// ─── DB write helpers (inlined to avoid circular imports with routes/db.ts) ────

/** Write the AI review result back to the verification_sessions row. */
async function finalizeSession(
  db: D1Database,
  sessionId: string,
  result: VerificationResult,
): Promise<void> {
  const status = result.approved ? "verified" : "failed";
  await db
    .prepare(
      `UPDATE verification_sessions
       SET    status = ?, ai_result = ?, ai_confidence = ?,
              ai_rejection_reason = ?, ai_reviewed_at = datetime('now'),
              updated_at = datetime('now')
       WHERE  id = ?`,
    )
    .bind(
      status,
      JSON.stringify(result.raw),
      result.confidence,
      result.rejection_reason ?? null,
      sessionId,
    )
    .run();
}

async function setUserVerificationStatus(
  db: D1Database,
  userId: string,
  status: "verified" | "failed",
): Promise<void> {
  await db
    .prepare(
      "UPDATE users SET verification_status = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(status, userId)
    .run();
}

// ─── Main consumer ────────────────────────────────────────────────────────────

export async function handleVerificationQueue(
  batch: MessageBatch<VerificationQueueMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    const { type, session_id, user_id } = message.body;

    // ── Expire stale sessions (runs on the existing scheduled cron) ─────────
    if (type === "expire_sessions") {
      try {
        await env.DB.prepare(
          `
          UPDATE verification_sessions
          SET    status = 'expired', updated_at = datetime('now')
          WHERE  expires_at < datetime('now')
            AND  status IN ('created', 'pending')
        `,
        ).run();

        // Users whose only active session just expired go back to unverified
        // so they can start a new session rather than being stuck in 'pending'.
        await env.DB.prepare(
          `
          UPDATE users
          SET    verification_status = 'unverified', updated_at = datetime('now')
          WHERE  verification_status = 'pending'
            AND  id NOT IN (
              SELECT user_id FROM verification_sessions
              WHERE  status IN ('created', 'pending', 'processing', 'verified')
            )
        `,
        ).run();

        message.ack();
      } catch (err) {
        console.error("expire_sessions error:", err);
        message.retry();
      }
      continue;
    }

    // ── AI document check ────────────────────────────────────────────────────
    if (type === "run_ai_check" && session_id && user_id) {
      try {
        const row = await env.DB.prepare(
          "SELECT * FROM verification_sessions WHERE id = ? AND user_id = ?",
        )
          .bind(session_id, user_id)
          .first<{
            id: string;
            user_id: string;
            front_doc_key: string | null;
            back_doc_key: string | null;
            selfie_key: string | null;
            status: string;
          }>();

        if (!row) {
          console.warn(
            `Session ${session_id} not found — acking to avoid poison pill`,
          );
          message.ack();
          continue;
        }

        if (row.status !== "pending") {
          console.warn(`Session ${session_id} in '${row.status}' — skipping`);
          message.ack();
          continue;
        }

        // Mark processing to prevent duplicate runs if the message is re-delivered
        await env.DB.prepare(
          "UPDATE verification_sessions SET status = 'processing', updated_at = datetime('now') WHERE id = ?",
        )
          .bind(session_id)
          .run();

        // Documents-missing guard (should never happen after /submit validation,
        // but defensive programming prevents a silent failure)
        if (!row.front_doc_key || !row.back_doc_key || !row.selfie_key) {
          const fallback: VerificationResult = {
            approved: false,
            confidence: 0,
            raw: {},
            rejection_reason:
              "One or more required document images are missing from storage.",
          };
          await finalizeSession(env.DB, session_id, fallback);
          await setUserVerificationStatus(env.DB, user_id, "failed");
          message.ack();
          continue;
        }

        // Fetch images from R2
        const [frontImage, backImage, selfieImage] = await Promise.all([
          fetchR2AsBase64(env.STORAGE, row.front_doc_key),
          fetchR2AsBase64(env.STORAGE, row.back_doc_key),
          fetchR2AsBase64(env.STORAGE, row.selfie_key),
        ]);

        if (!frontImage || !backImage || !selfieImage) {
          const fallback: VerificationResult = {
            approved: false,
            confidence: 0,
            raw: {},
            rejection_reason:
              "Could not retrieve one or more document images from storage.",
          };
          await finalizeSession(env.DB, session_id, fallback);
          await setUserVerificationStatus(env.DB, user_id, "failed");
          message.ack();
          continue;
        }

        const result = await runGeminiVerification(
          env.GEMINI_API_KEY,
          frontImage,
          backImage,
          selfieImage,
        );

        await finalizeSession(env.DB, session_id, result);
        await setUserVerificationStatus(
          env.DB,
          user_id,
          result.approved ? "verified" : "failed",
        );

        // Notify user of outcome
        await env.NOTIFICATION_QUEUE.send(
          result.approved
            ? {
                user_id,
                type: "verification_approved",
                title: "Identity Verified ✓",
                body: "Your identity has been verified. You now have full access to Wihda.",
                timestamp: new Date().toISOString(),
              }
            : {
                user_id,
                type: "verification_rejected",
                title: "Verification Failed",
                body:
                  result.rejection_reason ??
                  "Your verification could not be completed. Please try again.",
                timestamp: new Date().toISOString(),
              },
        );

        // PII retention: delete raw document images regardless of outcome
        await Promise.allSettled([
          env.STORAGE.delete(row.front_doc_key),
          env.STORAGE.delete(row.back_doc_key),
          env.STORAGE.delete(row.selfie_key),
        ]);

        message.ack();
      } catch (err) {
        console.error(`run_ai_check error for session ${session_id}:`, err);
        message.retry();
      }
    }
  }
}
