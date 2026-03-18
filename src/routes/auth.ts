/**
 * Wihda Backend - Authentication Routes
 * POST /v1/auth/signup
 * POST /v1/auth/login
 * POST /v1/auth/refresh
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Env, LoginResponse, SignupResponse } from "../types";
import {
  createUser,
  getUserByEmail,
  getUserByPhone,
  getUserById,
  getUserNeighborhood,
  createVerificationSession,
  getUserByGoogleId,
  createUserWithGoogle,
  linkGoogleId,
} from "../lib/db";
import {
  hashPassword,
  verifyPassword,
  createJWT,
  verifyJWT,
  successResponse,
  errorResponse,
} from "../lib/utils";

const auth = new Hono<{ Bindings: Env }>();

// ─── KV key helpers ───────────────────────────────────────────────────────────

const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 3600; // 168 hours

function refreshTokenKey(jti: string): string {
  return `refresh_token:${jti}`;
}

// ─── Validation schemas ────────────────────────────────────────────────────────

const signupSchema = z
  .object({
    email: z.string().email().optional(),
    phone: z.string().min(8).optional(),
    password: z.string().min(8, "Password must be at least 8 characters"),
    display_name: z.string().min(2).max(50),
    language_preference: z.string().length(2).optional(),
  })
  .refine((d) => d.email || d.phone, {
    message: "Either email or phone is required",
  });

const loginSchema = z
  .object({
    email: z.string().email().optional(),
    phone: z.string().optional(),
    password: z.string().min(1),
  })
  .refine((d) => d.email || d.phone, {
    message: "Either email or phone is required",
  });

// ─── POST /v1/auth/signup ─────────────────────────────────────────────────────

/**
 * Creates a new user account in 'unverified' state.
 *
 * Returns a RESTRICTED token (scope: 'verification_only') that the client
 * must use to:
 *   1. Verify their contact info  → POST /v1/auth/verify/{email|phone}/send + confirm
 *   2. Complete KYC               → POST /v1/verification/start … submit
 *
 * Full API access is only granted after both steps are complete.
 */
auth.post("/signup", async (c) => {
  try {
    const body = await c.req.json();
    const validation = signupSchema.safeParse(body);

    if (!validation.success) {
      return errorResponse(
        "VALIDATION_ERROR",
        "Invalid request data",
        400,
        validation.error.flatten(),
      );
    }

    const data = validation.data;

    if (data.email) {
      const existing = await getUserByEmail(c.env.DB, data.email);
      if (existing)
        return errorResponse(
          "EMAIL_EXISTS",
          "An account with this email already exists",
          409,
        );
    }
    if (data.phone) {
      const existing = await getUserByPhone(c.env.DB, data.phone);
      if (existing)
        return errorResponse(
          "PHONE_EXISTS",
          "An account with this phone already exists",
          409,
        );
    }

    const passwordHash = await hashPassword(data.password);

    // User is created with verification_status = 'unverified' (DB default)
    // email_verified / phone_verified both default to 0 (DB default)
    const user = await createUser(c.env.DB, {
      email: data.email,
      phone: data.phone,
      passwordHash,
      displayName: data.display_name,
      languagePreference: data.language_preference,
    });

    const session = await createVerificationSession(c.env.DB, user.id);

    // Restricted token, only valid for /v1/verification/* and /v1/auth/verify/* routes.
    // Intentionally NOT stored in KV: verification_only tokens are not refreshable
    // and have no revocation use-case (they expire in 24 h and are single-purpose).
    const restrictedToken = await createJWT(
      {
        sub: user.id,
        role: user.role,
        neighborhood_id: null,
        verification_status: "unverified",
        scope: "verification_only",
      },
      c.env.JWT_SECRET,
      24,
    );

    // Tell the client which channel to verify first
    const contactChannel: "email" | "phone" = data.email ? "email" : "phone";

    const response: SignupResponse = {
      verification_session_id: session.id,
      restricted_token: restrictedToken,
      expires_in: 86400,
      user: { id: user.id, display_name: user.display_name },
      contact_verification_required: true,
      contact_channel: contactChannel,
    };

    return successResponse(response, 201);
  } catch (error) {
    console.error("Signup error:", error);
    return errorResponse("INTERNAL_ERROR", "Failed to create account", 500);
  }
});

// ─── POST /v1/auth/login ──────────────────────────────────────────────────────

auth.post("/login", async (c) => {
  try {
    const body = await c.req.json();
    const validation = loginSchema.safeParse(body);

    if (!validation.success) {
      return errorResponse(
        "VALIDATION_ERROR",
        "Invalid request data",
        400,
        validation.error.flatten(),
      );
    }

    const data = validation.data;

    let user;
    if (data.email) user = await getUserByEmail(c.env.DB, data.email);
    else if (data.phone) user = await getUserByPhone(c.env.DB, data.phone);

    if (!user) {
      return errorResponse(
        "INVALID_CREDENTIALS",
        "Invalid email/phone or password",
        401,
      );
    }

    const isValid = await verifyPassword(data.password, user.password_hash);
    if (!isValid) {
      return errorResponse(
        "INVALID_CREDENTIALS",
        "Invalid email/phone or password",
        401,
      );
    }

    // ── Account status gate ───────────────────────────────────────────────────
    if (user.status === "deleted") {
      return errorResponse("ACCOUNT_DELETED", "This account has been deleted", 403);
    }
    if (user.status === "banned") {
      return errorResponse(
        "ACCOUNT_BANNED",
        "Your account has been banned",
        403,
      );
    }
    if (user.status === "suspended") {
      return errorResponse(
        "ACCOUNT_SUSPENDED",
        "Your account has been temporarily suspended",
        403,
      );
    }

    // ── Contact verification gate ─────────────────────────────────────────────
    const hasVerifiedContact =
      (user.email !== null && user.email_verified === 1) ||
      (user.phone !== null && user.phone_verified === 1);

    if (!hasVerifiedContact) {
      const channel = user.email ? "email" : "phone";
      const restrictedToken = await createJWT(
        {
          sub: user.id,
          role: user.role,
          neighborhood_id: null,
          verification_status: user.verification_status,
          scope: "verification_only",
        },
        c.env.JWT_SECRET,
        24,
      );

      return c.json(
        {
          success: false,
          error: {
            code: "CONTACT_VERIFICATION_REQUIRED",
            message:
              "Please verify your email or phone number before logging in.",
            details: {
              contact_channel: channel,
              restricted_token: restrictedToken,
              expires_in: 86400,
            },
          },
        },
        403,
      );
    }

    const userNeighborhood = await getUserNeighborhood(c.env.DB, user.id);

    const tokenPayload = {
      sub: user.id,
      role: user.role,
      neighborhood_id: userNeighborhood?.neighborhood_id ?? null,
      verification_status: user.verification_status,
      scope: "full",
    };

    const accessToken = await createJWT(tokenPayload, c.env.JWT_SECRET, 24);
    const refreshToken = await createJWT(tokenPayload, c.env.JWT_SECRET, 168);

    const refreshPayload = await verifyJWT(refreshToken, c.env.JWT_SECRET);
    if (refreshPayload?.jti) {
      await c.env.KV.put(refreshTokenKey(refreshPayload.jti), user.id, {
        expirationTtl: REFRESH_TOKEN_TTL_SECONDS,
      });
    }

    const response: LoginResponse = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 86400,
      user: {
        id: user.id,
        display_name: user.display_name,
        role: user.role,
        created_at: user.created_at,
        verification_status: user.verification_status,
      },
    };

    return successResponse(response);
  } catch (error) {
    console.error("Login error:", error);
    return errorResponse("INTERNAL_ERROR", "Failed to authenticate", 500);
  }
});

// ─── POST /v1/auth/refresh ────────────────────────────────────────────────────

/**
 * Issues new access + refresh tokens using an existing refresh token.
 *
 * Refuses to refresh 'verification_only' scoped tokens — those are
 * one-shot and can only be exchanged by completing verification.
 */
auth.post("/refresh", async (c) => {
  try {
    const body = await c.req.json();
    const { refresh_token } = body as { refresh_token?: string };

    if (!refresh_token) {
      return errorResponse("MISSING_TOKEN", "Refresh token is required", 400);
    }

    const payload = await verifyJWT(refresh_token, c.env.JWT_SECRET);
    if (!payload) {
      return errorResponse(
        "INVALID_TOKEN",
        "Invalid or expired refresh token",
        401,
      );
    }

    if (payload.scope === "verification_only") {
      return errorResponse(
        "VERIFICATION_TOKEN_RESTRICTED",
        "Verification tokens cannot be refreshed. Complete identity verification to get a full token.",
        403,
      );
    }

    // ── KV revocation check ───────────────────────────────────────────────────
    if (!payload.jti) {
      return errorResponse(
        "INVALID_TOKEN",
        "Invalid or expired refresh token",
        401,
      );
    }

    const storedUserId = await c.env.KV.get(refreshTokenKey(payload.jti));
    if (!storedUserId || storedUserId !== payload.sub) {
      // Token was already used, revoked, or doesn't belong to this user.
      return errorResponse(
        "INVALID_TOKEN",
        "Invalid or expired refresh token",
        401,
      );
    }

    // Delete the old jti immediately, token rotation: each refresh token is single-use. If someone replays a used token, it will be rejected.
    await c.env.KV.delete(refreshTokenKey(payload.jti));

    // ── Re-validate user state ────────────────────────────────────────────────
    const user = await getUserById(c.env.DB, payload.sub);
    if (!user) {
      return errorResponse("USER_NOT_FOUND", "User not found", 404);
    }

    // Re-check contact verification in case something changed
    const hasVerifiedContact =
      (user.email !== null && user.email_verified === 1) ||
      (user.phone !== null && user.phone_verified === 1);

    if (!hasVerifiedContact) {
      return errorResponse(
        "CONTACT_VERIFICATION_REQUIRED",
        "Contact verification is required",
        403,
      );
    }

    // NOTE: KYC (verification_status) is intentionally NOT re-checked here.
    // KYC is optional — blocking refresh for non-KYC users would permanently
    // lock them out of the app after 24 h with no recovery path.

    const userNeighborhood = await getUserNeighborhood(c.env.DB, user.id);

    const tokenPayload = {
      sub: user.id,
      role: user.role,
      neighborhood_id: userNeighborhood?.neighborhood_id ?? null,
      verification_status: user.verification_status,
      scope: "full",
    };

    const accessToken = await createJWT(tokenPayload, c.env.JWT_SECRET, 24);
    const newRefreshToken = await createJWT(
      tokenPayload,
      c.env.JWT_SECRET,
      168,
    );

    // Store the new refresh token's jti in KV
    const newRefreshPayload = await verifyJWT(
      newRefreshToken,
      c.env.JWT_SECRET,
    );
    if (newRefreshPayload?.jti) {
      await c.env.KV.put(refreshTokenKey(newRefreshPayload.jti), user.id, {
        expirationTtl: REFRESH_TOKEN_TTL_SECONDS,
      });
    }

    const response: LoginResponse = {
      access_token: accessToken,
      refresh_token: newRefreshToken,
      expires_in: 86400,
      user: {
        id: user.id,
        display_name: user.display_name,
        role: user.role,
        created_at: user.created_at,
        verification_status: user.verification_status,
      },
    };

    return successResponse(response);
  } catch (error) {
    console.error("Refresh error:", error);
    return errorResponse("INTERNAL_ERROR", "Failed to refresh token", 500);
  }
});

// ─── GET /v1/auth/google ──────────────────────────────────────────────────────

/**
 * Redirects the user to Google's OAuth consent screen.
 * Stores a random state value in KV for CSRF protection (TTL: 10 minutes).
 */
auth.get("/google", async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID) {
    return errorResponse("NOT_CONFIGURED", "Google OAuth is not configured", 503);
  }

  const state = crypto.randomUUID();
  await c.env.KV.put(`oauth_state:${state}`, "1", { expirationTtl: 600 });

  const redirectUri = `${c.env.FRONTEND_URL || "http://localhost:5173"}/auth/google/callback`;

  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "email profile",
    state,
    access_type: "offline",
    prompt: "select_account",
  });

  return c.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  );
});

// ─── POST /v1/auth/google/callback ───────────────────────────────────────────

/**
 * Handles the Google OAuth callback.
 * Accepts { code, state } as JSON body (sent by the frontend after redirect).
 * - Verifies state (CSRF check)
 * - Exchanges code for tokens
 * - Fetches user info from Google
 * - Finds or creates a local user
 * - Returns access + refresh tokens
 */
auth.post("/google/callback", async (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return errorResponse("NOT_CONFIGURED", "Google OAuth is not configured", 503);
  }

  try {
    const body = await c.req.json();
    const { code, state } = body as { code?: string; state?: string };

    if (!code) {
      return errorResponse("VALIDATION_ERROR", "Authorization code is required", 400);
    }
    if (!state) {
      return errorResponse("VALIDATION_ERROR", "State parameter is required", 400);
    }

    // ── CSRF state verification ───────────────────────────────────────────────
    const storedState = await c.env.KV.get(`oauth_state:${state}`);
    if (!storedState) {
      return errorResponse("INVALID_STATE", "Invalid or expired OAuth state", 400);
    }
    await c.env.KV.delete(`oauth_state:${state}`);

    // ── Exchange code for Google tokens ───────────────────────────────────────
    const redirectUri = `${c.env.FRONTEND_URL || "http://localhost:5173"}/auth/google/callback`;

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: c.env.GOOGLE_CLIENT_ID,
        client_secret: c.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error("Google token exchange failed:", err);
      return errorResponse("OAUTH_ERROR", "Failed to exchange authorization code", 400);
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      id_token?: string;
      error?: string;
    };

    if (tokenData.error) {
      return errorResponse("OAUTH_ERROR", tokenData.error, 400);
    }

    // ── Fetch Google user info ────────────────────────────────────────────────
    const userInfoRes = await fetch(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      },
    );

    if (!userInfoRes.ok) {
      return errorResponse("OAUTH_ERROR", "Failed to fetch Google user info", 400);
    }

    const googleUser = (await userInfoRes.json()) as {
      sub: string;
      email: string;
      name: string;
      picture?: string;
      email_verified?: boolean;
    };

    if (!googleUser.email) {
      return errorResponse("OAUTH_ERROR", "Google account has no email address", 400);
    }

    // ── Find or create local user ─────────────────────────────────────────────
    let user = await getUserByGoogleId(c.env.DB, googleUser.sub);

    if (!user) {
      // Try to find by email — link the Google account to existing user
      user = await getUserByEmail(c.env.DB, googleUser.email);
      if (user) {
        await linkGoogleId(c.env.DB, user.id, googleUser.sub, googleUser.picture);
        user = await getUserById(c.env.DB, user.id);
      }
    }

    if (!user) {
      // Create a brand-new account; Google accounts are pre-verified
      user = await createUserWithGoogle(c.env.DB, {
        email: googleUser.email,
        googleId: googleUser.sub,
        displayName: googleUser.name || googleUser.email.split("@")[0],
        photoUrl: googleUser.picture,
      });
    }

    if (!user) {
      return errorResponse("INTERNAL_ERROR", "Failed to resolve user account", 500);
    }

    // ── Account status gate ───────────────────────────────────────────────────
    if (user.status === "banned") {
      return errorResponse("ACCOUNT_BANNED", "Your account has been banned", 403);
    }
    if (user.status === "suspended") {
      return errorResponse("ACCOUNT_SUSPENDED", "Your account has been temporarily suspended", 403);
    }

    // ── Issue tokens ──────────────────────────────────────────────────────────
    const userNeighborhood = await getUserNeighborhood(c.env.DB, user.id);

    const tokenPayload = {
      sub: user.id,
      role: user.role,
      neighborhood_id: userNeighborhood?.neighborhood_id ?? null,
      verification_status: user.verification_status,
      scope: "full",
    };

    const accessToken = await createJWT(tokenPayload, c.env.JWT_SECRET, 24);
    const refreshToken = await createJWT(tokenPayload, c.env.JWT_SECRET, 168);

    const refreshPayload = await verifyJWT(refreshToken, c.env.JWT_SECRET);
    if (refreshPayload?.jti) {
      await c.env.KV.put(refreshTokenKey(refreshPayload.jti), user.id, {
        expirationTtl: REFRESH_TOKEN_TTL_SECONDS,
      });
    }

    const response: LoginResponse = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 86400,
      user: {
        id: user.id,
        display_name: user.display_name,
        role: user.role,
        created_at: user.created_at,
        verification_status: user.verification_status,
      },
    };

    return successResponse(response);
  } catch (error) {
    console.error("Google OAuth callback error:", error);
    return errorResponse("INTERNAL_ERROR", "Google authentication failed", 500);
  }
});

// ─── Forgot Password helpers ──────────────────────────────────────────────────

const RESET_OTP_TTL = 10 * 60; // 10 minutes in seconds

function resetOtpKey(email: string): string {
  return `pwd_reset:${email.toLowerCase()}`;
}

function generateResetOtp(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return String(array[0] % 1_000_000).padStart(6, "0");
}

async function sendPasswordResetEmail(env: Env, toEmail: string, otp: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    console.log(`[DEV] Password reset OTP for ${toEmail}: ${otp}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [toEmail],
      subject: "Reset Your Password",
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
          <h2 style="color:#1a1a1a">Reset your password</h2>
          <p>Use the code below to reset your Wihda password.
             It expires in <strong>10 minutes</strong>.</p>
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
    throw new Error(`Email send failed: ${res.status}`);
  }
}

// ─── POST /v1/auth/forgot-password ───────────────────────────────────────────

auth.post("/forgot-password", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const email = (body.email ?? "").trim().toLowerCase();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return errorResponse("VALIDATION_ERROR", "Valid email is required", 400);
    }

    // Always respond with success to avoid user enumeration
    const user = await getUserByEmail(c.env.DB, email);
    if (!user) {
      return successResponse({ message: "If that email exists, a reset code has been sent." });
    }

    const otp = generateResetOtp();
    // Store: { otp, used: false } in KV with 10-min TTL
    await c.env.KV.put(resetOtpKey(email), JSON.stringify({ otp, used: false }), {
      expirationTtl: RESET_OTP_TTL,
    });

    await sendPasswordResetEmail(c.env, email, otp);

    return successResponse({ message: "If that email exists, a reset code has been sent." });
  } catch (error) {
    console.error("Forgot password error:", error);
    return errorResponse("INTERNAL_ERROR", "Failed to process request", 500);
  }
});

// ─── POST /v1/auth/verify-reset-code ─────────────────────────────────────────

auth.post("/verify-reset-code", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const email = (body.email ?? "").trim().toLowerCase();
    const code = (body.code ?? "").trim();

    if (!email || !code) {
      return errorResponse("VALIDATION_ERROR", "Email and code are required", 400);
    }

    const stored = await c.env.KV.get(resetOtpKey(email));
    if (!stored) {
      return errorResponse("INVALID_CODE", "Invalid or expired reset code", 400);
    }

    const { otp, used } = JSON.parse(stored);
    if (used || otp !== code) {
      return errorResponse("INVALID_CODE", "Invalid or expired reset code", 400);
    }

    return successResponse({ valid: true });
  } catch (error) {
    console.error("Verify reset code error:", error);
    return errorResponse("INTERNAL_ERROR", "Failed to verify code", 500);
  }
});

// ─── POST /v1/auth/reset-password ────────────────────────────────────────────

auth.post("/reset-password", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const email = (body.email ?? "").trim().toLowerCase();
    const code = (body.code ?? "").trim();
    const newPassword = body.new_password ?? "";

    if (!email || !code || !newPassword) {
      return errorResponse("VALIDATION_ERROR", "Email, code, and new password are required", 400);
    }
    if (newPassword.length < 8) {
      return errorResponse("VALIDATION_ERROR", "Password must be at least 8 characters", 400);
    }

    const stored = await c.env.KV.get(resetOtpKey(email));
    if (!stored) {
      return errorResponse("INVALID_CODE", "Invalid or expired reset code", 400);
    }

    const { otp, used } = JSON.parse(stored);
    if (used || otp !== code) {
      return errorResponse("INVALID_CODE", "Invalid or expired reset code", 400);
    }

    const user = await getUserByEmail(c.env.DB, email);
    if (!user) {
      return errorResponse("INVALID_CODE", "Invalid or expired reset code", 400);
    }

    // Hash new password and update
    const hashed = await hashPassword(newPassword);
    await c.env.DB.prepare(
      `UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(hashed, user.id).run();

    // Invalidate OTP
    await c.env.KV.put(resetOtpKey(email), JSON.stringify({ otp, used: true }), {
      expirationTtl: 60,
    });

    return successResponse({ message: "Password reset successfully." });
  } catch (error) {
    console.error("Reset password error:", error);
    return errorResponse("INTERNAL_ERROR", "Failed to reset password", 500);
  }
});

export default auth;
