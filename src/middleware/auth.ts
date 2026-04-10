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

  // Accept token from Authorization header OR ?token= query param
  // (the latter is used by direct-URL endpoints like <img src="...?token=...">)
  let token: string | null = null;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.substring(7);
  } else {
    token = c.req.query("token") ?? null;
  }

  if (!token) {
    return unauthorizedResponse(
      c,
      "MISSING_TOKEN",
      "Authorization header with Bearer token is required",
    );
  }
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
 * Requires the user to have a full-scope token (i.e. completed contact
 * verification via OTP).  KYC is OPTIONAL — we no longer gate the whole
 * app behind it.  The only thing blocked here is a raw verification_only
 * token that was issued at signup before the OTP step.
 *
 * Chain AFTER authMiddleware.
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
      "Please complete contact verification (OTP) first.",
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
