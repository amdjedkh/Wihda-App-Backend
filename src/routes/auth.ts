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

    // Restricted token — only valid for /v1/verification/* and /v1/auth/verify/* routes
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

    if (!user)
      return errorResponse(
        "INVALID_CREDENTIALS",
        "Invalid email/phone or password",
        401,
      );

    if (user.status === "banned")
      return errorResponse(
        "ACCOUNT_BANNED",
        "Your account has been banned",
        403,
      );
    if (user.status === "suspended")
      return errorResponse(
        "ACCOUNT_SUSPENDED",
        "Your account has been temporarily suspended",
        403,
      );

    // ── Contact verification gate ─────────────────────────────────────────────
    // The user must have verified at least the contact method they signed up with.
    const hasVerifiedContact =
      (user.email !== null && user.email_verified === 1) ||
      (user.phone !== null && user.phone_verified === 1);

    if (!hasVerifiedContact) {
      const channel = user.email ? "email" : "phone";
      return c.json(
        {
          success: false,
          error: {
            code: "CONTACT_VERIFICATION_REQUIRED",
            message:
              "Please verify your email or phone number before logging in.",
            details: { contact_channel: channel },
          },
        },
        403,
      );
    }

    // ── KYC gate ──────────────────────────────────────────────────────────────
    if (user.verification_status !== "verified") {
      const message =
        user.verification_status === "unverified" ||
        user.verification_status === "pending"
          ? "Your identity has not been verified yet. Please complete the verification process."
          : "Your verification was rejected. Please contact support or retry.";

      return c.json(
        {
          success: false,
          error: {
            code: "VERIFICATION_REQUIRED",
            message,
            details: { verification_status: user.verification_status },
          },
        },
        403,
      );
    }

    const isValid = await verifyPassword(data.password, user.password_hash);
    if (!isValid)
      return errorResponse(
        "INVALID_CREDENTIALS",
        "Invalid email/phone or password",
        401,
      );

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

    if (!refresh_token)
      return errorResponse("MISSING_TOKEN", "Refresh token is required", 400);

    const payload = await verifyJWT(refresh_token, c.env.JWT_SECRET);
    if (!payload)
      return errorResponse(
        "INVALID_TOKEN",
        "Invalid or expired refresh token",
        401,
      );

    if (payload.scope === "verification_only") {
      return errorResponse(
        "VERIFICATION_TOKEN_RESTRICTED",
        "Verification tokens cannot be refreshed. Complete identity verification to get a full token.",
        403,
      );
    }

    const user = await getUserById(c.env.DB, payload.sub);
    if (!user) return errorResponse("USER_NOT_FOUND", "User not found", 404);

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

    // Re-check KYC in case an admin revoked it since last login
    if (user.verification_status !== "verified") {
      return errorResponse(
        "VERIFICATION_REQUIRED",
        "Identity verification is required",
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
    const newRefreshToken = await createJWT(
      tokenPayload,
      c.env.JWT_SECRET,
      168,
    );

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

export default auth;
