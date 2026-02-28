/**
 * Wihda Backend - Authentication Middleware
 */

import { Context, Next } from "hono";
import { verifyJWT } from "../lib/utils";
import type { Env, VerificationStatus } from "../types";

export interface AuthContext {
  userId: string;
  userRole: "user" | "moderator" | "admin";
  neighborhoodId: string | null;
  verificationStatus: VerificationStatus;
  /** 'full' = normal access; 'verification_only' = post-signup restricted token */
  scope: "full" | "verification_only";
}

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function unauthorizedResponse(
  c: Context,
  code: string,
  message: string,
  status: 401 | 403 = 401,
) {
  return c.json({ success: false, error: { code, message } }, status);
}

// ─── Core auth middleware ──────────────────────────────────────────────────────

/**
 * Validates the Bearer JWT and populates c.var.auth.
 * Does NOT enforce verification status — chain requireVerified for that.
 */
export async function authMiddleware(
  c: Context<{ Bindings: Env }>,
  next: Next,
) {
  const authHeader = c.req.header("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    return unauthorizedResponse(
      c,
      "MISSING_TOKEN",
      "Authorization header with Bearer token is required",
    );
  }

  const token = authHeader.substring(7);
  const payload = await verifyJWT(token, c.env.JWT_SECRET);

  if (!payload) {
    return unauthorizedResponse(
      c,
      "INVALID_TOKEN",
      "Token is invalid or expired",
    );
  }

  // payload.verification_status and payload.scope are string | null in JWTOutput;
  // fall back to safe defaults for tokens issued before KYC was introduced.
  c.set("auth", {
    userId: payload.sub,
    userRole: payload.role as AuthContext["userRole"],
    neighborhoodId: payload.neighborhood_id,
    verificationStatus: (payload.verification_status ??
      "unverified") as VerificationStatus,
    scope: (payload.scope ?? "full") as AuthContext["scope"],
  });

  await next();
}

/**
 * Optional auth — never fails; populates context only when a valid token
 * is present.
 */
export async function optionalAuthMiddleware(
  c: Context<{ Bindings: Env }>,
  next: Next,
) {
  const authHeader = c.req.header("Authorization");

  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.substring(7);
    const payload = await verifyJWT(token, c.env.JWT_SECRET);

    if (payload) {
      c.set("auth", {
        userId: payload.sub,
        userRole: payload.role as AuthContext["userRole"],
        neighborhoodId: payload.neighborhood_id,
        verificationStatus: (payload.verification_status ??
          "unverified") as VerificationStatus,
        scope: (payload.scope ?? "full") as AuthContext["scope"],
      });
    }
  }

  await next();
}

// ─── Role / verification guards ───────────────────────────────────────────────

/**
 * Requires the user to have completed KYC.
 * Chain AFTER authMiddleware.
 *
 * Also blocks 'verification_only' scoped tokens — those are only valid for
 * /v1/verification/* routes.
 */
export async function requireVerified(
  c: Context<{ Bindings: Env }>,
  next: Next,
) {
  const auth = c.get("auth");

  if (!auth) {
    return unauthorizedResponse(c, "UNAUTHORIZED", "Authentication required");
  }

  if (auth.scope === "verification_only") {
    return unauthorizedResponse(
      c,
      "VERIFICATION_TOKEN_RESTRICTED",
      "This token can only be used for verification endpoints. Complete identity verification first.",
      403,
    );
  }

  if (auth.verificationStatus !== "verified") {
    return unauthorizedResponse(
      c,
      "VERIFICATION_REQUIRED",
      "Identity verification is required to access this resource.",
      403,
    );
  }

  await next();
}

/** Requires moderator or admin role. Chain AFTER authMiddleware. */
export async function requireModerator(
  c: Context<{ Bindings: Env }>,
  next: Next,
) {
  const auth = c.get("auth");

  if (!auth) {
    return unauthorizedResponse(c, "UNAUTHORIZED", "Authentication required");
  }

  if (auth.userRole !== "moderator" && auth.userRole !== "admin") {
    return unauthorizedResponse(
      c,
      "INSUFFICIENT_PERMISSIONS",
      "Moderator or admin access required",
      403,
    );
  }

  await next();
}

/** Requires admin role. Chain AFTER authMiddleware. */
export async function requireAdmin(c: Context<{ Bindings: Env }>, next: Next) {
  const auth = c.get("auth");

  if (!auth) {
    return unauthorizedResponse(c, "UNAUTHORIZED", "Authentication required");
  }

  if (auth.userRole !== "admin") {
    return unauthorizedResponse(
      c,
      "INSUFFICIENT_PERMISSIONS",
      "Admin access required",
      403,
    );
  }

  await next();
}

/** Requires the user to have joined a neighborhood. Chain AFTER authMiddleware. */
export async function requireNeighborhood(
  c: Context<{ Bindings: Env }>,
  next: Next,
) {
  const auth = c.get("auth");

  if (!auth) {
    return unauthorizedResponse(c, "UNAUTHORIZED", "Authentication required");
  }

  if (!auth.neighborhoodId) {
    return c.json(
      {
        success: false,
        error: {
          code: "NEIGHBORHOOD_REQUIRED",
          message: "You must join a neighborhood first",
        },
      },
      400,
    );
  }

  await next();
}

// ─── Utilities ────────────────────────────────────────────────────────────────

export function getAuthContext(
  c: Context<{ Bindings: Env }>,
): AuthContext | null {
  return c.get("auth") ?? null;
}

export function canModifyResource(
  auth: AuthContext,
  resourceUserId: string,
): boolean {
  if (auth.userRole === "admin" || auth.userRole === "moderator") return true;
  return auth.userId === resourceUserId;
}
