/**
 * Wihda Backend - Campaign Queue Consumer & Scheduled Scraper
 *
 * Exports:
 *   handleCampaignQueue              - processes wihda-campaign-queue messages
 *   handleScheduledCampaignIngestion - called by the cron scheduled() handler
 *
 * Flow:
 *   1. Expire campaigns not seen in 72 h
 *   2. Fetch all active neighborhoods
 *   3. Scrape cra.dz once via Jina AI Reader -> clean markdown
 *   4. Extract structured events with Gemini
 *   5. Upsert each event into every active neighborhood
 *
 * No coins, no push notifications - campaigns are read-only enrichment.
 */

import type { Env, CampaignQueueMessage } from "../types";
import { createOrUpdateCampaign, expireOldCampaigns } from "../lib/db";

interface ScrapedEvent {
  title: string;
  description?: string;
  organizer?: string;
  location?: string;
  start_dt: string;
  end_dt?: string;
  url?: string;
  image_url?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CRA_DZ_URL = "https://cra.dz/";
const JINA_READER_BASE = "https://r.jina.ai/";
const GEMINI_MODEL = "gemini-2.5-flash-lite";
const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

// ─── Queue consumer ───────────────────────────────────────────────────────────

export async function handleCampaignQueue(
  batch: MessageBatch<CampaignQueueMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      const { type } = message.body;

      if (type === "ingest") {
        // Scrape cra.dz and upsert into neighborhoods
        await handleCampaignScrape(env, (message.body as any).neighborhood_id);
      } else if (type === "expire_old") {
        // Expire stale campaigns only - no scrape
        const expired = await expireOldCampaigns(env.DB, 72);
        console.log(`[campaigns] Expired ${expired} stale campaigns`);
      } else {
        console.warn(`[campaigns] Unknown message type: ${type}`);
      }

      message.ack();
    } catch (err) {
      console.error("[campaigns] Queue message failed:", err);
      message.retry();
    }
  }
}

// ─── Scheduled handler ────────────────────────────────────────────────────────

export async function handleScheduledCampaignIngestion(
  env: Env,
): Promise<void> {
  await handleCampaignScrape(env);
}

// ─── Core scrape + upsert ─────────────────────────────────────────────────────

async function handleCampaignScrape(
  env: Env,
  scopeNeighborhoodId?: string,
): Promise<void> {
  console.log("[campaigns] Starting scrape run");

  // 1. Expire campaigns not seen in 72 hours
  const expired = await expireOldCampaigns(env.DB, 72);
  console.log(`[campaigns] Expired ${expired} stale campaigns`);

  // 2. Get active neighborhoods (scoped if queue message specifies one)
  let neighborhoodQuery = `SELECT id, name FROM neighborhoods WHERE status = 'active'`;
  const neighborhoodParams: string[] = [];
  if (scopeNeighborhoodId) {
    neighborhoodQuery += " AND id = ?";
    neighborhoodParams.push(scopeNeighborhoodId);
  }

  const { results: neighborhoods } = await env.DB.prepare(neighborhoodQuery)
    .bind(...neighborhoodParams)
    .all<{ id: string; name: string }>();

  if (neighborhoods.length === 0) {
    console.log("[campaigns] No active neighborhoods - nothing to do");
    return;
  }

  // 3. Scrape cra.dz once - content is national, same for all neighborhoods
  const events = await scrapeCraDz(env);
  if (events.length === 0) {
    console.log("[campaigns] No events extracted from cra.dz");
    return;
  }

  console.log(`[campaigns] Extracted ${events.length} events`);

  // 4. Upsert into every active neighborhood
  let upserted = 0;
  for (const neighborhood of neighborhoods) {
    for (const event of events) {
      try {
        await createOrUpdateCampaign(env.DB, {
          neighborhoodId: neighborhood.id,
          title: event.title,
          description: event.description,
          organizer: event.organizer,
          location: event.location,
          startDt: event.start_dt,
          endDt: event.end_dt,
          url: event.url,
          source: "scrape",
          // Best unique key available - url if present, else title
          sourceIdentifier: event.url ?? event.title,
        });
        upserted++;
      } catch (err) {
        console.error(
          `[campaigns] Failed to upsert "${event.title}" for ${neighborhood.name}:`,
          err,
        );
      }
    }
  }

  console.log(
    `[campaigns] Upserted ${upserted} campaign rows across ${neighborhoods.length} neighborhoods`,
  );
}

// ─── Jina AI Reader ───────────────────────────────────────────────────────────

async function fetchWithJina(
  url: string,
  jinaApiKey: string,
): Promise<string | null> {
  const res = await fetch(`${JINA_READER_BASE}${url}`, {
    headers: {
      Accept: "text/markdown",
      Authorization: `Bearer ${jinaApiKey}`,
      "X-Wait-For-Selector": "body",
      "X-Timeout": "30",
    },
  });

  if (!res.ok) {
    console.error(
      `[campaigns] Jina fetch failed: ${res.status} ${res.statusText}`,
    );
    return null;
  }

  const text = await res.text();
  return text.trim() || null;
}

// ─── Gemini extraction ────────────────────────────────────────────────────────

async function extractEventsWithGemini(
  markdown: string,
  geminiApiKey: string,
): Promise<ScrapedEvent[]> {
  const today = new Date().toISOString().split("T")[0];

  const prompt = `You are a structured data extractor. The text below is the Algerian Scouts website (cra.dz) converted to markdown.

Extract all activities, events, or campaigns listed on the page.
Today's date is ${today}. Include events from the last 30 days and all future events.

Return ONLY a valid JSON array (no markdown fences, no explanation) where each item has:
{
  "title": "string (required)",
  "description": "string or null",
  "organizer": "string or null - group, team, or wilaya organising it",
  "location": "string or null - city or venue",
  "start_dt": "ISO 8601 datetime string e.g. 2025-06-15T00:00:00 (required)",
  "end_dt": "ISO 8601 datetime string or null",
  "url": "string or null - full absolute URL to the event page",
  "image_url": "string or null - full absolute URL to an image"
}

Rules:
- Skip any item where you cannot determine a start date.
- Normalize dates to ISO 8601. Assume UTC+1 (Africa/Algiers) if no timezone given.
- Only extract what is explicitly on the page - do not invent data.
- If no events are found return an empty array [].

Page content:
${markdown.slice(0, 12000)}`;

  const res = await fetch(
    `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${geminiApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
      }),
    },
  );

  if (!res.ok) {
    console.error(`[campaigns] Gemini error: ${res.status} ${res.statusText}`);
    return [];
  }

  const data = (await res.json()) as any;
  const rawText: string =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

  if (!rawText) {
    console.error("[campaigns] Gemini returned empty response");
    return [];
  }

  // Strip accidental markdown fences
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) {
      console.error("[campaigns] Gemini response is not an array");
      return [];
    }

    const valid: ScrapedEvent[] = [];
    for (const item of parsed) {
      if (typeof item.title !== "string" || !item.title.trim()) continue;
      if (typeof item.start_dt !== "string" || isNaN(Date.parse(item.start_dt)))
        continue;

      valid.push({
        title: item.title.trim(),
        description: str(item.description),
        organizer: str(item.organizer),
        location: str(item.location),
        start_dt: item.start_dt,
        end_dt: validDate(item.end_dt),
        url: validUrl(item.url),
        image_url: validUrl(item.image_url),
      });
    }

    return valid;
  } catch (err) {
    console.error(
      "[campaigns] JSON parse error:",
      err,
      "\nRaw:",
      cleaned.slice(0, 300),
    );
    return [];
  }
}

// ─── Orchestrate ──────────────────────────────────────────────────────────────

async function scrapeCraDz(env: Env): Promise<ScrapedEvent[]> {
  const markdown = await fetchWithJina(CRA_DZ_URL, env.JINA_API_KEY);
  if (!markdown) return [];
  return extractEventsWithGemini(markdown, env.GEMINI_API_KEY);
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function validDate(v: unknown): string | undefined {
  return typeof v === "string" && !isNaN(Date.parse(v)) ? v : undefined;
}

function validUrl(v: unknown): string | undefined {
  return typeof v === "string" && v.startsWith("http") ? v : undefined;
}
