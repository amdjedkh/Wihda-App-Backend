/**
 * Wihda Backend - Contact Form Routes
 *
 * Accepts public (unauthenticated) form submissions from the Wihda website.
 * Mirrors the frontend ContactPayload discriminated union exactly.
 *
 * POST /v1/contact  — Submit a citizen or partner form
 *
 * Rate limited: 5 submissions per IP per hour via KV.
 * Stored in D1 contact_submissions table for internal review.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { generateId, toISODateString } from "../lib/utils";
import { checkRateLimit, RATE_LIMITS } from "../lib/rate-limit";

const contact = new Hono<{ Bindings: Env }>();

// ─── Validation schemas — match frontend types exactly ────────────────────────

const citizenSchema = z.object({
  type: z.literal("citizen"),
  name: z.string().min(1).max(100),
  email: z.string().email(),
  topic: z.enum(["account", "bug", "feedback", "other"]),
  message: z.string().min(1).max(5000),
});

const partnerSchema = z.object({
  type: z.literal("partner"),
  organization: z.string().min(1).max(200),
  contactPerson: z.string().min(1).max(100),
  email: z.string().email(),
  proposal: z.string().min(1).max(10000),
});

// Discriminated union on 'type' — mirrors ContactPayload from the frontend
const contactSchema = z.discriminatedUnion("type", [
  citizenSchema,
  partnerSchema,
]);

// ─── Email notification ───────────────────────────────────────────────────────

async function sendContactNotification(
  env: Env,
  data: z.infer<typeof contactSchema>,
  submissionId: string,
): Promise<void> {
  let subject: string;
  let html: string;

  if (data.type === "citizen") {
    subject = `[Wihda Contact] ${data.topic} — ${data.name}`;
    html = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
        <h2 style="border-bottom:1px solid #e5e7eb;padding-bottom:12px">
          New citizen contact form submission
        </h2>
        <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
          <tr>
            <td style="padding:8px 0;color:#6b7280;width:120px">Submission ID</td>
            <td style="padding:8px 0;font-family:monospace">${submissionId}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#6b7280">Name</td>
            <td style="padding:8px 0">${data.name}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#6b7280">Email</td>
            <td style="padding:8px 0"><a href="mailto:${data.email}">${data.email}</a></td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#6b7280">Topic</td>
            <td style="padding:8px 0">${data.topic}</td>
          </tr>
        </table>
        <h3 style="color:#374151;margin-bottom:8px">Message</h3>
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;
                    padding:16px;white-space:pre-wrap;font-size:14px;line-height:1.6">
${data.message}
        </div>
      </div>
    `;
  } else {
    subject = `[Wihda Contact] Partner inquiry — ${data.organization}`;
    html = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
        <h2 style="border-bottom:1px solid #e5e7eb;padding-bottom:12px">
          New partner contact form submission
        </h2>
        <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
          <tr>
            <td style="padding:8px 0;color:#6b7280;width:140px">Submission ID</td>
            <td style="padding:8px 0;font-family:monospace">${submissionId}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#6b7280">Organization</td>
            <td style="padding:8px 0">${data.organization}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#6b7280">Contact person</td>
            <td style="padding:8px 0">${data.contactPerson}</td>
          </tr>
          <tr>
            <td style="padding:8px 0;color:#6b7280">Email</td>
            <td style="padding:8px 0"><a href="mailto:${data.email}">${data.email}</a></td>
          </tr>
        </table>
        <h3 style="color:#374151;margin-bottom:8px">Proposal</h3>
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;
                    padding:16px;white-space:pre-wrap;font-size:14px;line-height:1.6">
${data.proposal}
        </div>
      </div>
    `;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: ["contact@wihdaapp.com"],
      reply_to: data.email,
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[contact] Resend notification failed:", res.status, text);
  }
}

// ─── POST /v1/contact ─────────────────────────────────────────────────────────

/**
 * No auth required — this is a public website endpoint.
 * Rate limited by Cloudflare connecting IP (CF-Connecting-IP header).
 */
contact.post("/", async (c) => {
  // ── Rate limit by IP ───────────────────────────────────────────────────────
  const ip =
    c.req.header("CF-Connecting-IP") ||
    c.req.header("X-Forwarded-For")?.split(",")[0].trim() ||
    "unknown";

  const rl = await checkRateLimit(c.env.KV, ip, RATE_LIMITS.contactForm);

  c.header("X-RateLimit-Limit", RATE_LIMITS.contactForm.maxRequests.toString());
  c.header("X-RateLimit-Remaining", rl.remaining.toString());
  c.header("X-RateLimit-Reset", rl.resetAt.toString());

  if (!rl.allowed) {
    return c.json(
      {
        success: false,
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: "Too many submissions. Please try again later.",
          details: { reset_at: new Date(rl.resetAt).toISOString() },
        },
      },
      429,
    );
  }

  // ── Parse & validate ───────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        success: false,
        error: {
          code: "INVALID_JSON",
          message: "Request body must be valid JSON",
        },
      },
      400,
    );
  }

  const validation = contactSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid form data",
          details: validation.error.flatten(),
        },
      },
      400,
    );
  }

  const data = validation.data;
  const id = generateId();
  const now = toISODateString();

  // ── Persist to D1 ──────────────────────────────────────────────────────────
  if (data.type === "citizen") {
    await c.env.DB.prepare(
      `INSERT INTO contact_submissions
         (id, type, name, email, topic, message, ip_address, status, created_at)
       VALUES (?, 'citizen', ?, ?, ?, ?, ?, 'new', ?)`,
    )
      .bind(id, data.name, data.email, data.topic, data.message, ip, now)
      .run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO contact_submissions
         (id, type, organization, contact_person, email, proposal, ip_address, status, created_at)
       VALUES (?, 'partner', ?, ?, ?, ?, ?, 'new', ?)`,
    )
      .bind(
        id,
        data.organization,
        data.contactPerson,
        data.email,
        data.proposal,
        ip,
        now,
      )
      .run();
  }

  // Send email notification (non-blocking — failure does not affect response)
  c.executionCtx.waitUntil(sendContactNotification(c.env, data, id));

  return c.json(
    { success: true, data: { id, type: data.type, created_at: now } },
    201,
  );
});

export default contact;
