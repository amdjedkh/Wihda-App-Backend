/**
 * Wihda Backend – Contact Verification Routes
 *
 * Handles OTP-based email and phone verification that sits BEFORE KYC.
 * All routes require the restricted_token issued at signup
 * (scope: 'verification_only').
 *
 * Endpoints:
 *   POST /v1/auth/verify/email/send
 *   POST /v1/auth/verify/email/confirm
 *   POST /v1/auth/verify/phone/send
 *   POST /v1/auth/verify/phone/confirm
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { authMiddleware } from "../middleware/auth";
import { generateId, errorResponse, successResponse } from "../lib/utils";

// ─── Constants ────────────────────────────────────────────────────────────────

const OTP_EXPIRY_MINUTES = 10;
const MAX_VERIFY_ATTEMPTS = 5; // Wrong guesses before lockout
const MAX_SENDS_PER_HOUR = 3; // Resend limit within a 1-hour window
const LOCKOUT_MINUTES = 60; // How long a locked record stays locked

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Generates a cryptographically random 6-digit OTP string. */
function generateOtp(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return String(array[0] % 1_000_000).padStart(6, "0");
}

/** SHA-256 hex hash of a plaintext OTP. */
async function hashOtp(otp: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(otp));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Returns the current UTC datetime as an ISO string shifted by `minutes`.
 * Used for setting `expires_at` and `locked_until`.
 */
function nowPlusMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Twilio SMS sender ────────────────────────────────────────────────────────

async function sendSmsOtp(
  env: Env,
  toPhone: string,
  otp: string,
): Promise<void> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;

  const body = new URLSearchParams({
    To: toPhone,
    From: env.TWILIO_PHONE_NUMBER,
    Body: `Your Wihda verification code is: ${otp}. It expires in ${OTP_EXPIRY_MINUTES} minutes. Do not share this code.`,
  });

  const credentials = btoa(
    `${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`,
  );

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Twilio error:", res.status, text);
    throw new Error(`Twilio SMS failed: ${res.status}`);
  }
}

// ─── Resend email sender ──────────────────────────────────────────────────────

async function sendEmailOtp(
  env: Env,
  toEmail: string,
  otp: string,
): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL, // e.g. "Wihda <noreply@wihdaapp.com>"
      to: [toEmail],
      subject: "Your Wihda verification code",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
          <h2 style="color:#1a1a1a">Verify your email</h2>
          <p>Use the code below to verify your Wihda account. 
             It expires in <strong>${OTP_EXPIRY_MINUTES} minutes</strong>.</p>
          <div style="font-size:36px;font-weight:bold;letter-spacing:8px;
                      background:#f4f4f5;padding:20px 32px;border-radius:8px;
                      text-align:center;color:#18181b;margin:24px 0">
            ${otp}
          </div>
          <p style="color:#71717a;font-size:14px">
            If you didn't request this, you can safely ignore this email.
            Never share this code with anyone.
          </p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Resend error:", res.status, text);
    throw new Error(`Resend email failed: ${res.status}`);
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

/** Fetch the most recent contact_verification row for a user+channel pair. */
async function getVerificationRecord(
  db: D1Database,
  userId: string,
  channel: "email" | "phone",
) {
  return db
    .prepare(
      `SELECT * FROM contact_verifications
       WHERE user_id = ? AND channel = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(userId, channel)
    .first<{
      id: string;
      user_id: string;
      channel: string;
      target: string;
      code_hash: string;
      expires_at: string;
      attempts: number;
      verified_at: string | null;
      send_count: number;
      last_sent_at: string;
      locked_until: string | null;
      created_at: string;
    }>();
}

// ─── Router ───────────────────────────────────────────────────────────────────

const contactVerification = new Hono<{ Bindings: Env }>();

// All routes in this file require a valid JWT (restricted or full).
contactVerification.use("*", authMiddleware);

// ─── Schema ───────────────────────────────────────────────────────────────────

const confirmSchema = z.object({
  code: z
    .string()
    .length(6)
    .regex(/^\d{6}$/, "Code must be exactly 6 digits"),
});

// ═══════════════════════════════════════════════════════════════════════════════
// EMAIL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /v1/auth/verify/email/send
 *
 * Sends (or re-sends) a 6-digit OTP to the user's registered email.
 * Rate-limited to MAX_SENDS_PER_HOUR per user per hour.
 */
contactVerification.post("/email/send", async (c) => {
  const auth = c.get("auth");

  // Fetch user so we know their email address
  const user = await c.env.DB.prepare(
    "SELECT id, email, email_verified FROM users WHERE id = ?",
  )
    .bind(auth.userId)
    .first<{ id: string; email: string | null; email_verified: number }>();

  if (!user || !user.email) {
    return errorResponse(
      "NO_EMAIL",
      "No email address is associated with this account",
      400,
    );
  }

  if (user.email_verified) {
    return errorResponse("ALREADY_VERIFIED", "Email is already verified", 400);
  }

  // ── Rate-limit check ────────────────────────────────────────────────────────
  const existing = await getVerificationRecord(c.env.DB, auth.userId, "email");
  const now = Date.now();

  if (existing) {
    const windowStart = new Date(existing.last_sent_at).getTime();
    const withinWindow = now - windowStart < 60 * 60_000; // 1 hour

    if (withinWindow && existing.send_count >= MAX_SENDS_PER_HOUR) {
      return errorResponse(
        "RATE_LIMITED",
        `Maximum of ${MAX_SENDS_PER_HOUR} codes per hour. Please wait before requesting another.`,
        429,
      );
    }
  }

  // ── Generate + send OTP ─────────────────────────────────────────────────────
  const otp = generateOtp();
  const codeHash = await hashOtp(otp);
  const expiresAt = nowPlusMinutes(OTP_EXPIRY_MINUTES);
  const sentAt = nowIso();

  try {
    await sendEmailOtp(c.env, user.email, otp);
  } catch (err) {
    console.error("sendEmailOtp failed:", err);
    return errorResponse(
      "DELIVERY_FAILED",
      "Failed to send verification email. Please try again.",
      502,
    );
  }

  // ── Upsert verification record ──────────────────────────────────────────────
  if (existing) {
    const windowStart = new Date(existing.last_sent_at).getTime();
    const withinWindow = now - windowStart < 60 * 60_000;
    const newCount = withinWindow ? existing.send_count + 1 : 1;

    await c.env.DB.prepare(
      `UPDATE contact_verifications
         SET code_hash    = ?,
             expires_at   = ?,
             attempts     = 0,
             send_count   = ?,
             last_sent_at = ?,
             locked_until = NULL,
             updated_at   = ?
         WHERE id = ?`,
    )
      .bind(codeHash, expiresAt, newCount, sentAt, sentAt, existing.id)
      .run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO contact_verifications
           (id, user_id, channel, target, code_hash, expires_at, send_count, last_sent_at, created_at, updated_at)
         VALUES (?, ?, 'email', ?, ?, ?, 1, ?, ?, ?)`,
    )
      .bind(
        generateId(),
        auth.userId,
        user.email,
        codeHash,
        expiresAt,
        sentAt,
        sentAt,
        sentAt,
      )
      .run();
  }

  return successResponse({
    message: "Verification code sent to your email address.",
    expires_in: OTP_EXPIRY_MINUTES * 60,
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /v1/auth/verify/email/confirm
 *
 * Validates the 6-digit OTP the user received by email.
 * On success: sets `users.email_verified = 1`.
 */
contactVerification.post("/email/confirm", async (c) => {
  const auth = c.get("auth");

  const body = await c.req.json();
  const validation = confirmSchema.safeParse(body);

  if (!validation.success) {
    return errorResponse(
      "VALIDATION_ERROR",
      "Code must be exactly 6 digits",
      400,
    );
  }

  const { code } = validation.data;

  const record = await getVerificationRecord(c.env.DB, auth.userId, "email");

  if (!record) {
    return errorResponse(
      "NO_CODE",
      "No verification code found. Please request a new one.",
      404,
    );
  }

  // ── Lockout check ───────────────────────────────────────────────────────────
  if (record.locked_until && new Date(record.locked_until) > new Date()) {
    return errorResponse(
      "ACCOUNT_LOCKED",
      `Too many incorrect attempts. Try again after ${new Date(record.locked_until).toISOString()}.`,
      429,
    );
  }

  // ── Already verified ────────────────────────────────────────────────────────
  if (record.verified_at) {
    return errorResponse("ALREADY_VERIFIED", "Email is already verified", 400);
  }

  // ── Expiry check ────────────────────────────────────────────────────────────
  if (new Date(record.expires_at) < new Date()) {
    return errorResponse(
      "CODE_EXPIRED",
      "Verification code has expired. Please request a new one.",
      410,
    );
  }

  // ── Code comparison ─────────────────────────────────────────────────────────
  const submittedHash = await hashOtp(code);
  const isCorrect = submittedHash === record.code_hash;

  if (!isCorrect) {
    const newAttempts = record.attempts + 1;
    const lockedUntil =
      newAttempts >= MAX_VERIFY_ATTEMPTS
        ? nowPlusMinutes(LOCKOUT_MINUTES)
        : null;

    await c.env.DB.prepare(
      `UPDATE contact_verifications
         SET attempts = ?, locked_until = ?, updated_at = ?
         WHERE id = ?`,
    )
      .bind(newAttempts, lockedUntil, nowIso(), record.id)
      .run();

    const remaining = MAX_VERIFY_ATTEMPTS - newAttempts;
    if (remaining <= 0) {
      return errorResponse(
        "ACCOUNT_LOCKED",
        "Too many incorrect attempts. Please wait before trying again.",
        429,
      );
    }

    return errorResponse(
      "INVALID_CODE",
      `Incorrect code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`,
      400,
    );
  }

  // ── Success: mark verified ──────────────────────────────────────────────────
  const verifiedAt = nowIso();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE contact_verifications SET verified_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(verifiedAt, verifiedAt, record.id),
    c.env.DB.prepare(
      `UPDATE users SET email_verified = 1, updated_at = ? WHERE id = ?`,
    ).bind(verifiedAt, auth.userId),
  ]);

  return successResponse({ message: "Email verified successfully." });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PHONE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /v1/auth/verify/phone/send
 *
 * Sends (or re-sends) a 6-digit OTP via SMS to the user's registered phone.
 * Rate-limited to MAX_SENDS_PER_HOUR per user per hour.
 */
contactVerification.post("/phone/send", async (c) => {
  const auth = c.get("auth");

  const user = await c.env.DB.prepare(
    "SELECT id, phone, phone_verified FROM users WHERE id = ?",
  )
    .bind(auth.userId)
    .first<{ id: string; phone: string | null; phone_verified: number }>();

  if (!user || !user.phone) {
    return errorResponse(
      "NO_PHONE",
      "No phone number is associated with this account",
      400,
    );
  }

  if (user.phone_verified) {
    return errorResponse("ALREADY_VERIFIED", "Phone is already verified", 400);
  }

  // ── Rate-limit check ────────────────────────────────────────────────────────
  const existing = await getVerificationRecord(c.env.DB, auth.userId, "phone");
  const now = Date.now();

  if (existing) {
    const windowStart = new Date(existing.last_sent_at).getTime();
    const withinWindow = now - windowStart < 60 * 60_000;

    if (withinWindow && existing.send_count >= MAX_SENDS_PER_HOUR) {
      return errorResponse(
        "RATE_LIMITED",
        `Maximum of ${MAX_SENDS_PER_HOUR} codes per hour. Please wait before requesting another.`,
        429,
      );
    }
  }

  // ── Generate + send OTP ─────────────────────────────────────────────────────
  const otp = generateOtp();
  const codeHash = await hashOtp(otp);
  const expiresAt = nowPlusMinutes(OTP_EXPIRY_MINUTES);
  const sentAt = nowIso();

  try {
    await sendSmsOtp(c.env, user.phone, otp);
  } catch (err) {
    console.error("sendSmsOtp failed:", err);
    return errorResponse(
      "DELIVERY_FAILED",
      "Failed to send SMS. Please try again.",
      502,
    );
  }

  // ── Upsert verification record ──────────────────────────────────────────────
  if (existing) {
    const windowStart = new Date(existing.last_sent_at).getTime();
    const withinWindow = now - windowStart < 60 * 60_000;
    const newCount = withinWindow ? existing.send_count + 1 : 1;

    await c.env.DB.prepare(
      `UPDATE contact_verifications
         SET code_hash    = ?,
             expires_at   = ?,
             attempts     = 0,
             send_count   = ?,
             last_sent_at = ?,
             locked_until = NULL,
             updated_at   = ?
         WHERE id = ?`,
    )
      .bind(codeHash, expiresAt, newCount, sentAt, sentAt, existing.id)
      .run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO contact_verifications
           (id, user_id, channel, target, code_hash, expires_at, send_count, last_sent_at, created_at, updated_at)
         VALUES (?, ?, 'phone', ?, ?, ?, 1, ?, ?, ?)`,
    )
      .bind(
        generateId(),
        auth.userId,
        user.phone,
        codeHash,
        expiresAt,
        sentAt,
        sentAt,
        sentAt,
      )
      .run();
  }

  return successResponse({
    message: "Verification code sent to your phone number.",
    expires_in: OTP_EXPIRY_MINUTES * 60,
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /v1/auth/verify/phone/confirm
 *
 * Validates the 6-digit OTP the user received by SMS.
 * On success: sets `users.phone_verified = 1`.
 */
contactVerification.post("/phone/confirm", async (c) => {
  const auth = c.get("auth");

  const body = await c.req.json();
  const validation = confirmSchema.safeParse(body);

  if (!validation.success) {
    return errorResponse(
      "VALIDATION_ERROR",
      "Code must be exactly 6 digits",
      400,
    );
  }

  const { code } = validation.data;

  const record = await getVerificationRecord(c.env.DB, auth.userId, "phone");

  if (!record) {
    return errorResponse(
      "NO_CODE",
      "No verification code found. Please request a new one.",
      404,
    );
  }

  // ── Lockout check ───────────────────────────────────────────────────────────
  if (record.locked_until && new Date(record.locked_until) > new Date()) {
    return errorResponse(
      "ACCOUNT_LOCKED",
      `Too many incorrect attempts. Try again after ${new Date(record.locked_until).toISOString()}.`,
      429,
    );
  }

  if (record.verified_at) {
    return errorResponse("ALREADY_VERIFIED", "Phone is already verified", 400);
  }

  // ── Expiry check ────────────────────────────────────────────────────────────
  if (new Date(record.expires_at) < new Date()) {
    return errorResponse(
      "CODE_EXPIRED",
      "Verification code has expired. Please request a new one.",
      410,
    );
  }

  // ── Code comparison ─────────────────────────────────────────────────────────
  const submittedHash = await hashOtp(code);
  const isCorrect = submittedHash === record.code_hash;

  if (!isCorrect) {
    const newAttempts = record.attempts + 1;
    const lockedUntil =
      newAttempts >= MAX_VERIFY_ATTEMPTS
        ? nowPlusMinutes(LOCKOUT_MINUTES)
        : null;

    await c.env.DB.prepare(
      `UPDATE contact_verifications
         SET attempts = ?, locked_until = ?, updated_at = ?
         WHERE id = ?`,
    )
      .bind(newAttempts, lockedUntil, nowIso(), record.id)
      .run();

    const remaining = MAX_VERIFY_ATTEMPTS - newAttempts;
    if (remaining <= 0) {
      return errorResponse(
        "ACCOUNT_LOCKED",
        "Too many incorrect attempts. Please wait before trying again.",
        429,
      );
    }

    return errorResponse(
      "INVALID_CODE",
      `Incorrect code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`,
      400,
    );
  }

  // ── Success: mark verified ──────────────────────────────────────────────────
  const verifiedAt = nowIso();

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE contact_verifications SET verified_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(verifiedAt, verifiedAt, record.id),
    c.env.DB.prepare(
      `UPDATE users SET phone_verified = 1, updated_at = ? WHERE id = ?`,
    ).bind(verifiedAt, auth.userId),
  ]);

  return successResponse({ message: "Phone verified successfully." });
});

// ─── Status endpoint ──────────────────────────────────────────────────────────

/**
 * GET /v1/auth/verify/status
 *
 * Returns the current email/phone verification state for the calling user.
 * Useful for the client to know which step to show next.
 */
contactVerification.get("/status", async (c) => {
  const auth = c.get("auth");

  const user = await c.env.DB.prepare(
    "SELECT email, phone, email_verified, phone_verified FROM users WHERE id = ?",
  )
    .bind(auth.userId)
    .first<{
      email: string | null;
      phone: string | null;
      email_verified: number;
      phone_verified: number;
    }>();

  if (!user) {
    return errorResponse("USER_NOT_FOUND", "User not found", 404);
  }

  return successResponse({
    email: user.email ? `${user.email.slice(0, 3)}***` : null, // masked
    phone: user.phone ? `***${user.phone.slice(-3)}` : null, // masked
    email_verified: user.email_verified === 1,
    phone_verified: user.phone_verified === 1,
    contact_verified:
      (user.email !== null && user.email_verified === 1) ||
      (user.phone !== null && user.phone_verified === 1),
  });
});

export default contactVerification;
