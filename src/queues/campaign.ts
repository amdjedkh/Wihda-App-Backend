/**
 * Wihda Backend - Campaign Queue Consumer & Scheduled Scraper
 *
 * Flow:
 *   1. Expire campaigns not seen in 72 h
 *   2. Fetch all active neighborhoods
 *   3. Scrape 3 Algerian civic sources via Jina AI Reader
 *   4. Extract structured events with Gemini (contact info, images, logo)
 *   5. For events missing images → generate 3 AI images via Workers AI → upload to R2
 *   6. Upsert each event into every active neighborhood
 *   7. If nothing scraped → inject static fallback events
 */

import type { Env, CampaignQueueMessage } from "../types";
import { createOrUpdateCampaign, expireOldCampaigns } from "../lib/db";

interface ScrapedEvent {
  title: string;
  subtitle?: string;
  description?: string;
  organizer?: string;
  organizer_logo?: string;
  location?: string;
  start_dt: string;
  end_dt?: string;
  url?: string;
  image_url?: string;
  images?: string[];
  contact_phone?: string;
  contact_email?: string;
  coin_reward?: number;
}

// ─── Sources ──────────────────────────────────────────────────────────────────

const SOURCES = [
  {
    name: "cra.dz",
    url: "https://cra.dz/",
    description: "Algerian Scouts (Commissariat aux Scouts Musulmans d'Algérie)",
  },
  {
    name: "algerian-human.org",
    url: "https://algerian-human.org/",
    description: "Algerian Human Rights Organisation — civic events and campaigns",
  },
  {
    name: "fondation-algeria-youth-ambassadors.dz",
    url: "https://fondation-algeria-youth-ambassadors.dz/",
    description: "Algeria Youth Ambassadors Foundation — youth civic activities",
  },
];

const JINA_READER_BASE = "https://r.jina.ai/";
const GEMINI_MODEL = "gemini-2.5-flash-lite";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// ─── Static fallback events ───────────────────────────────────────────────────

function buildFallbackEvents(): ScrapedEvent[] {
  const now = new Date();
  const nextWeek  = new Date(now.getTime() + 7  * 24 * 60 * 60 * 1000);
  const nextMonth = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  return [
    {
      title: "Neighbourhood Clean-Up Drive",
      subtitle: "Join us for a community cleanup",
      description: "Join your neighbours for a morning clean-up of shared public spaces. Gloves and bags provided. Everyone welcome!",
      organizer: "Wihda Community",
      location: "Local public park",
      start_dt: nextWeek.toISOString(),
      end_dt: new Date(nextWeek.getTime() + 3 * 60 * 60 * 1000).toISOString(),
      images: [],
      contact_email: "community@wihdaapp.com",
      coin_reward: 100,
    },
    {
      title: "Tree Planting Campaign",
      subtitle: "Help green our neighbourhood",
      description: "Help us plant trees and shrubs in common areas to improve air quality and beautify our neighbourhood.",
      organizer: "Wihda Community",
      location: "Neighbourhood garden",
      start_dt: nextMonth.toISOString(),
      images: [],
      contact_email: "community@wihdaapp.com",
      coin_reward: 150,
    },
  ];
}

// ─── Queue consumer ───────────────────────────────────────────────────────────

export async function handleCampaignQueue(
  batch: MessageBatch<CampaignQueueMessage>,
  env: Env,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      const { type } = message.body;
      if (type === "ingest") {
        await handleCampaignScrape(env, (message.body as any).neighborhood_id);
      } else if (type === "expire_old") {
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

export async function handleScheduledCampaignIngestion(env: Env): Promise<void> {
  await handleCampaignScrape(env);
}

// ─── Core scrape + upsert ─────────────────────────────────────────────────────

async function handleCampaignScrape(env: Env, scopeNeighborhoodId?: string): Promise<void> {
  console.log("[campaigns] Starting scrape run");

  const expired = await expireOldCampaigns(env.DB, 72);
  console.log(`[campaigns] Expired ${expired} stale campaigns`);

  let neighborhoodQuery = `SELECT id, name FROM neighborhoods WHERE is_active = 1`;
  const neighborhoodParams: string[] = [];
  if (scopeNeighborhoodId) {
    neighborhoodQuery += " AND id = ?";
    neighborhoodParams.push(scopeNeighborhoodId);
  }

  const { results: neighborhoods } = await env.DB.prepare(neighborhoodQuery)
    .bind(...neighborhoodParams)
    .all<{ id: string; name: string }>();

  if (neighborhoods.length === 0) {
    console.log("[campaigns] No active neighborhoods");
    return;
  }

  // Scrape all sources
  let allEvents: ScrapedEvent[] = [];
  for (const source of SOURCES) {
    console.log(`[campaigns] Scraping ${source.name}...`);
    try {
      const events = await scrapeSource(source.url, source.name, env);
      console.log(`[campaigns] Got ${events.length} events from ${source.name}`);
      allEvents = allEvents.concat(events);
    } catch (err) {
      console.error(`[campaigns] Failed to scrape ${source.name}:`, err);
    }
  }

  if (allEvents.length === 0) {
    console.log("[campaigns] No events found — using fallback");
    allEvents = buildFallbackEvents();
  }

  // Deduplicate by title
  const seen = new Set<string>();
  const unique = allEvents.filter((e) => {
    const key = e.title.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[campaigns] ${unique.length} unique events`);

  // Generate AI images for events that have none
  for (const event of unique) {
    if (!event.images || event.images.length === 0) {
      try {
        const aiImages = await generateAIImages(event, env);
        if (aiImages.length > 0) {
          event.images = aiImages;
          event.image_url = aiImages[0];
          console.log(`[campaigns] Generated ${aiImages.length} AI images for "${event.title}"`);
        }
      } catch (err) {
        console.error(`[campaigns] AI image generation failed for "${event.title}":`, err);
      }
    }
  }

  // Upsert into every active neighborhood
  let upserted = 0;
  for (const neighborhood of neighborhoods) {
    for (const event of unique) {
      try {
        await upsertCampaign(env.DB, neighborhood.id, event);
        upserted++;
      } catch (err) {
        console.error(`[campaigns] Failed to upsert "${event.title}" for ${neighborhood.name}:`, err);
      }
    }
  }

  console.log(`[campaigns] Upserted ${upserted} rows across ${neighborhoods.length} neighborhoods`);
}

// ─── AI Image Generation ──────────────────────────────────────────────────────

function buildImagePrompt(event: ScrapedEvent, variant: number): string {
  const title       = event.title || "community activity";
  const organizer   = event.organizer || "community volunteers";
  const location    = event.location || "Algeria";
  const description = event.description || "";

  // Detect activity type from keywords
  const text = `${title} ${description}`.toLowerCase();
  let activityContext = "community civic activity";
  let actionDesc = "participating in a community event";

  if (text.includes("clean") || text.includes("nettoy")) {
    activityContext = "neighbourhood cleanup drive";
    actionDesc = "volunteers picking up litter and cleaning public spaces";
  } else if (text.includes("tree") || text.includes("plant") || text.includes("arbre")) {
    activityContext = "tree planting campaign";
    actionDesc = "volunteers planting trees and greenery in urban areas";
  } else if (text.includes("food") || text.includes("donation") || text.includes("don")) {
    activityContext = "food and supply donation drive";
    actionDesc = "volunteers distributing food and essentials to people in need";
  } else if (text.includes("scout") || text.includes("jeune") || text.includes("youth")) {
    activityContext = "youth community event";
    actionDesc = "young volunteers working together on a civic project";
  } else if (text.includes("health") || text.includes("santé") || text.includes("medical")) {
    activityContext = "health awareness campaign";
    actionDesc = "volunteers raising health awareness in the community";
  } else if (text.includes("educat") || text.includes("school") || text.includes("école")) {
    activityContext = "education support initiative";
    actionDesc = "volunteers supporting students and educational activities";
  } else if (text.includes("environment") || text.includes("environnement")) {
    activityContext = "environmental conservation activity";
    actionDesc = "community members working to protect the environment";
  }

  const angles = [
    `Wide shot of ${actionDesc} outdoors in ${location}`,
    `Close-up of diverse community volunteers smiling and working together during a ${activityContext}`,
    `Candid documentary photo of people engaged in ${activityContext} in an Algerian neighbourhood`,
  ];

  return `${angles[variant % 3]}, organised by ${organizer}. Natural daylight, photorealistic, warm colours, meaningful social impact, documentary photography style, high detail, 4k quality. No text or logos.`;
}

async function generateAIImages(event: ScrapedEvent, env: Env): Promise<string[]> {
  const urls: string[] = [];
  const baseKey = `campaign-images/${Date.now()}-${Math.random().toString(36).slice(2)}`;

  for (let i = 0; i < 3; i++) {
    try {
      const prompt = buildImagePrompt(event, i);
      console.log(`[campaigns] AI image prompt [${i}]: ${prompt.slice(0, 80)}...`);

      const result = await (env.AI as any).run("@cf/black-forest-labs/flux-1-schnell", {
        prompt,
        steps: 4,
      }) as { image: string };

      if (!result?.image) continue;

      // Decode base64 → Uint8Array
      const binaryStr = atob(result.image);
      const bytes = new Uint8Array(binaryStr.length);
      for (let j = 0; j < binaryStr.length; j++) bytes[j] = binaryStr.charCodeAt(j);

      const key = `${baseKey}-${i}.png`;
      await env.STORAGE.put(key, bytes, { httpMetadata: { contentType: "image/png" } });

      const imageUrl = `${env.WORKERS_BASE_URL}/v1/uploads/${key}`;
      urls.push(imageUrl);
    } catch (err) {
      console.error(`[campaigns] AI image ${i} failed:`, err);
    }
  }

  return urls;
}

// ─── DB upsert ────────────────────────────────────────────────────────────────

async function upsertCampaign(db: D1Database, neighborhoodId: string, event: ScrapedEvent): Promise<void> {
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();

  const imagesJson = event.images && event.images.length > 0
    ? JSON.stringify(event.images.slice(0, 3))
    : null;

  await db
    .prepare(
      `INSERT INTO campaigns
         (id, neighborhood_id, title, subtitle, description, organizer, organizer_logo,
          location, start_dt, end_dt, url, image_url, images_json,
          contact_phone, contact_email,
          source, source_identifier, status, last_seen_at, coin_reward, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scrape', ?, 'active', ?, ?, ?, ?)
       ON CONFLICT(source, url) DO UPDATE SET
         title          = excluded.title,
         subtitle       = excluded.subtitle,
         description    = excluded.description,
         organizer      = excluded.organizer,
         organizer_logo = excluded.organizer_logo,
         location       = excluded.location,
         start_dt       = excluded.start_dt,
         end_dt         = excluded.end_dt,
         image_url      = excluded.image_url,
         images_json    = excluded.images_json,
         contact_phone  = excluded.contact_phone,
         contact_email  = excluded.contact_email,
         status         = 'active',
         last_seen_at   = excluded.last_seen_at,
         updated_at     = excluded.updated_at`,
    )
    .bind(
      id,
      neighborhoodId,
      event.title,
      event.subtitle    ?? null,
      event.description ?? null,
      event.organizer   ?? null,
      event.organizer_logo ?? null,
      event.location    ?? null,
      event.start_dt,
      event.end_dt      ?? null,
      event.url         ?? null,
      event.image_url   ?? null,
      imagesJson,
      event.contact_phone  ?? null,
      event.contact_email  ?? null,
      event.url ?? event.title,        // source_identifier
      now,                              // last_seen_at
      event.coin_reward ?? 50,         // coin_reward
      now,
      now,
    )
    .run();
}

// ─── Jina AI Reader ───────────────────────────────────────────────────────────

async function fetchWithJina(url: string, jinaApiKey: string): Promise<string | null> {
  const res = await fetch(`${JINA_READER_BASE}${url}`, {
    headers: {
      Accept: "text/markdown",
      Authorization: `Bearer ${jinaApiKey}`,
      "X-Wait-For-Selector": "body",
      "X-Timeout": "30",
    },
  });
  if (!res.ok) {
    console.error(`[campaigns] Jina fetch failed for ${url}: ${res.status}`);
    return null;
  }
  const text = await res.text();
  return text.trim() || null;
}

// ─── Gemini extraction ────────────────────────────────────────────────────────

async function extractEventsWithGemini(
  markdown: string,
  sourceName: string,
  geminiApiKey: string,
): Promise<ScrapedEvent[]> {
  const today = new Date().toISOString().split("T")[0];

  const prompt = `You are a structured data extractor. The text below is from "${sourceName}", an Algerian civic website.

Extract all activities, events, campaigns, or volunteer opportunities listed.
Today's date is ${today}. Include events from the last 30 days and all future events.

Return ONLY a valid JSON array (no markdown fences) where each item has:
{
  "title": "string (required)",
  "subtitle": "string or null - short tagline or subtitle",
  "description": "string or null",
  "organizer": "string or null",
  "organizer_logo": "string or null - absolute URL to the organizer logo image",
  "location": "string or null - city or venue",
  "start_dt": "ISO 8601 datetime (required)",
  "end_dt": "ISO 8601 datetime or null",
  "url": "string or null - absolute URL to event page",
  "image_url": "string or null - absolute URL to primary image",
  "images": ["string"] or [] - up to 3 absolute image URLs,
  "contact_phone": "string or null",
  "contact_email": "string or null",
  "coin_reward": integer between 50 and 500 - assign based on activity complexity:
    50–100: simple local tasks (short cleanup, small awareness stand, one-hour activity)
    100–200: moderate effort (half-day cleanup, food/supply donation drive, tree planting)
    200–350: significant commitment (full-day event, multi-location campaign, training workshop)
    350–500: high complexity or multi-day (national campaign, major environmental project, multi-day youth programme)
}

Rules:
- Skip items where you cannot determine a start date.
- Normalize dates to ISO 8601 (UTC+1 / Africa/Algiers if no timezone).
- Only extract what is explicitly on the page.
- coin_reward must always be an integer, never null, minimum 50, maximum 500.
- If no events found return [].

Page content:
${markdown.slice(0, 14000)}`;

  const res = await fetch(
    `${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${geminiApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 4096, responseMimeType: "application/json" },
      }),
    },
  );

  if (!res.ok) {
    console.error(`[campaigns] Gemini error: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as any;
  const rawText: string = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  if (!rawText) return [];

  const cleaned = rawText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];

    const valid: ScrapedEvent[] = [];
    for (const item of parsed) {
      if (typeof item.title !== "string" || !item.title.trim()) continue;
      if (typeof item.start_dt !== "string" || isNaN(Date.parse(item.start_dt))) continue;

      const images: string[] = [];
      if (Array.isArray(item.images)) {
        for (const img of item.images) {
          const u = validUrl(img);
          if (u && !images.includes(u) && images.length < 3) images.push(u);
        }
      }
      const imageUrl = validUrl(item.image_url);
      if (imageUrl && !images.includes(imageUrl)) images.unshift(imageUrl);
      if (images.length > 3) images.length = 3;

      const rawCoins = parseInt(item.coin_reward);
      const coinReward = isNaN(rawCoins) ? 50 : Math.min(500, Math.max(50, rawCoins));

      valid.push({
        title:          item.title.trim(),
        subtitle:       str(item.subtitle),
        description:    str(item.description),
        organizer:      str(item.organizer),
        organizer_logo: validUrl(item.organizer_logo),
        location:       str(item.location),
        start_dt:       item.start_dt,
        end_dt:         validDate(item.end_dt),
        url:            validUrl(item.url),
        image_url:      images[0] ?? imageUrl,
        images,
        contact_phone:  str(item.contact_phone),
        contact_email:  str(item.contact_email),
        coin_reward:    coinReward,
      });
    }
    return valid;
  } catch (err) {
    console.error("[campaigns] JSON parse error:", err);
    return [];
  }
}

// ─── Orchestrate single source ────────────────────────────────────────────────

async function scrapeSource(url: string, name: string, env: Env): Promise<ScrapedEvent[]> {
  const markdown = await fetchWithJina(url, env.JINA_API_KEY);
  if (!markdown) return [];
  return extractEventsWithGemini(markdown, name, env.GEMINI_API_KEY);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function validDate(v: unknown): string | undefined {
  return typeof v === "string" && !isNaN(Date.parse(v)) ? v : undefined;
}
function validUrl(v: unknown): string | undefined {
  return typeof v === "string" && v.startsWith("http") ? v : undefined;
}
