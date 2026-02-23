/**
 * Test Fixtures
 * Mock data and test utilities for Wihda Backend tests
 */

import { vi } from "vitest";
import type {
  User,
  Neighborhood,
  LeftoverOffer,
  LeftoverNeed,
  Match,
  ChatThread,
  ChatMessage,
  CleanifySubmission,
  Campaign,
  CoinLedgerEntry,
} from "../fixtures/types";

// ─── Test users ───────────────────────────────────────────────────────────────

export const testUsers: User[] = [
  {
    id: "user-001",
    email: "admin@wihda.ma",
    phone: "+212600000001",
    password_hash: "hashed_password_123",
    display_name: "Admin User",
    role: "admin",
    status: "active",
    language_preference: "en",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "user-002",
    email: "mod@wihda.ma",
    phone: "+212600000002",
    password_hash: "hashed_password_123",
    display_name: "Moderator One",
    role: "moderator",
    status: "active",
    language_preference: "en",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "user-003",
    email: "ahmed@example.ma",
    phone: "+212600000003",
    password_hash: "hashed_password_123",
    display_name: "Ahmed Benali",
    role: "user",
    status: "active",
    language_preference: "en",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "user-004",
    email: "fatima@example.ma",
    phone: "+212600000004",
    password_hash: "hashed_password_123",
    display_name: "Fatima Zahra",
    role: "user",
    status: "active",
    language_preference: "en",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
];

// ─── Test neighborhoods ───────────────────────────────────────────────────────

export const testNeighborhoods: Neighborhood[] = [
  {
    id: "nb-001",
    name: "Hay Riad",
    city: "Rabat",
    country: "MA",
    center_lat: 33.9716,
    center_lng: -6.8498,
    radius_meters: 3000,
    is_active: true,
    created_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "nb-002",
    name: "Agdal",
    city: "Rabat",
    country: "MA",
    center_lat: 33.9911,
    center_lng: -6.8477,
    radius_meters: 2500,
    is_active: true,
    created_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "nb-003",
    name: "Maarif",
    city: "Casablanca",
    country: "MA",
    center_lat: 33.5883,
    center_lng: -7.6114,
    radius_meters: 2000,
    is_active: true,
    created_at: "2024-01-01T00:00:00Z",
  },
];

// ─── Test leftover offers ─────────────────────────────────────────────────────

export const testOffers: LeftoverOffer[] = [
  {
    id: "offer-001",
    user_id: "user-003",
    neighborhood_id: "nb-001",
    title: "Couscous traditionnel",
    description: "Couscous aux légumes fait maison, assez pour 4 personnes",
    survey_json: JSON.stringify({
      schema_version: 1,
      food_type: "cooked_meal",
      diet_constraints: ["halal"],
      portions: 4,
      pickup_time_preference: "evening",
      distance_willing_km: 2,
      notes: "Préparé aujourd'hui",
    }),
    quantity: 1,
    status: "active",
    expiry_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    created_at: "2024-01-15T10:00:00Z",
    updated_at: "2024-01-15T10:00:00Z",
  },
  {
    id: "offer-002",
    user_id: "user-003",
    neighborhood_id: "nb-001",
    title: "Fresh Bread",
    description: "Baguettes from this morning",
    survey_json: JSON.stringify({
      schema_version: 1,
      food_type: "bread",
      diet_constraints: [],
      portions: 6,
      pickup_time_preference: "morning",
      distance_willing_km: 1,
    }),
    quantity: 2,
    status: "active",
    expiry_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    created_at: "2024-01-15T08:00:00Z",
    updated_at: "2024-01-15T08:00:00Z",
  },
];

// ─── Test leftover needs ──────────────────────────────────────────────────────

export const testNeeds: LeftoverNeed[] = [
  {
    id: "need-001",
    user_id: "user-004",
    neighborhood_id: "nb-001",
    survey_json: JSON.stringify({
      schema_version: 1,
      food_type: "cooked_meal",
      diet_constraints: ["halal"],
      portions: 2,
      pickup_time_preference: "evening",
      distance_willing_km: 3,
      notes: "Famille de 2 personnes",
    }),
    urgency: "normal",
    status: "active",
    created_at: "2024-01-15T11:00:00Z",
    updated_at: "2024-01-15T11:00:00Z",
  },
];

// ─── Test matches ─────────────────────────────────────────────────────────────

export const testMatches: Match[] = [
  {
    id: "match-001",
    offer_id: "offer-001",
    need_id: "need-001",
    giver_user_id: "user-003",
    receiver_user_id: "user-004",
    score: 0.85,
    status: "active",
    created_at: "2024-01-15T12:00:00Z",
    updated_at: "2024-01-15T12:00:00Z",
  },
];

// ─── Test chat ────────────────────────────────────────────────────────────────

export const testChatThreads: ChatThread[] = [
  {
    id: "thread-001",
    match_id: "match-001",
    status: "active",
    created_at: "2024-01-15T12:00:00Z",
    updated_at: "2024-01-15T12:00:00Z",
  },
];

export const testChatMessages: ChatMessage[] = [
  {
    id: "msg-001",
    thread_id: "thread-001",
    sender_id: "user-003",
    body: "Hi! I have the couscous ready for pickup.",
    message_type: "text",
    created_at: "2024-01-15T12:05:00Z",
  },
  {
    id: "msg-002",
    thread_id: "thread-001",
    sender_id: "user-004",
    body: "Great! I can come at 6pm. Where are you located?",
    message_type: "text",
    created_at: "2024-01-15T12:10:00Z",
  },
];

// ─── Test cleanify submissions ────────────────────────────────────────────────
// Updated for multi-step schema: draft_before → in_progress → pending_review
// → approved | rejected | expired

const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

export const testSubmissions: CleanifySubmission[] = [
  {
    // A submission sitting in pending_review — the standard moderation target
    id: "sub-001",
    user_id: "user-003",
    neighborhood_id: "nb-001",
    before_photo_url: "https://r2.example.com/before-001.jpg",
    before_photo_key: "cleanify/user-003/sub-001/before.jpg",
    before_uploaded_at: thirtyMinAgo,
    started_at: thirtyMinAgo,
    after_photo_url: "https://r2.example.com/after-001.jpg",
    after_photo_key: "cleanify/user-003/sub-001/after.jpg",
    after_uploaded_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    completed_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    geo_lat: 33.9716,
    geo_lng: -6.8498,
    description: "Cleaned the park area near my building",
    status: "pending_review",
    reviewer_id: null,
    reviewed_at: null,
    review_note: null,
    coins_awarded: 0,
    created_at: "2024-01-15T14:00:00Z",
    updated_at: "2024-01-15T14:00:00Z",
  },
  {
    // An already-approved submission — used to test ALREADY_REVIEWED guard
    id: "sub-002",
    user_id: "user-003",
    neighborhood_id: "nb-001",
    before_photo_url: "https://r2.example.com/before-002.jpg",
    before_photo_key: "cleanify/user-003/sub-002/before.jpg",
    before_uploaded_at: "2024-01-10T10:00:00Z",
    started_at: "2024-01-10T10:00:00Z",
    after_photo_url: "https://r2.example.com/after-002.jpg",
    after_photo_key: "cleanify/user-003/sub-002/after.jpg",
    after_uploaded_at: "2024-01-10T11:00:00Z",
    completed_at: "2024-01-10T11:00:00Z",
    geo_lat: 33.971,
    geo_lng: -6.85,
    description: "Street cleanup initiative",
    status: "approved",
    reviewer_id: "user-002",
    reviewed_at: "2024-01-10T16:00:00Z",
    review_note: "Great job! Area looks much cleaner.",
    coins_awarded: 150,
    created_at: "2024-01-10T10:00:00Z",
    updated_at: "2024-01-10T16:00:00Z",
  },
];

// ─── Test campaigns ───────────────────────────────────────────────────────────

export const testCampaigns: Campaign[] = [
  {
    id: "camp-001",
    neighborhood_id: "nb-001",
    title: "Nettoyage Quartier Hay Riad",
    description: "Opération de nettoyage communautaire",
    organizer: "Association Hay Riad",
    location: "Place Hay Riad",
    start_dt: "2024-02-15T09:00:00Z",
    end_dt: "2024-02-15T12:00:00Z",
    source: "manual",
    last_seen_at: "2024-01-15T00:00:00Z",
    created_at: "2024-01-10T00:00:00Z",
    updated_at: "2024-01-10T00:00:00Z",
  },
];

// ─── Test coin ledger entries ─────────────────────────────────────────────────

export const testCoinEntries: CoinLedgerEntry[] = [
  {
    id: "coin-001",
    user_id: "user-003",
    source_type: "signup_bonus",
    source_id: "signup-001",
    amount: 50,
    category: "bonus",
    description: "Welcome bonus for joining Wihda",
    status: "valid",
    created_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "coin-002",
    user_id: "user-003",
    source_type: "cleanify_approved",
    source_id: "sub-002",
    amount: 150,
    category: "cleanify",
    description: "Cleanify submission approved",
    status: "valid",
    created_at: "2024-01-10T16:00:00Z",
  },
];

// ─── Mock D1 Database ─────────────────────────────────────────────────────────
// Each call to prepare() returns a FRESH statement mock so that chained
// .bind().first() / .bind().all() / .bind().run() calls don't bleed into
// each other across different queries in the same test.

export function createMockD1Database() {
  const db = {
    prepare: vi.fn(() => createMockStatement()),
    batch: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue({ count: 0, duration: 0 }),
    dump: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
  };
  return db;
}

function createMockStatement() {
  const stmt = {
    bind: vi.fn(() => stmt), // bind() returns same statement for chaining
    first: vi.fn().mockResolvedValue(null),
    all: vi.fn().mockResolvedValue({ results: [], success: true }),
    run: vi.fn().mockResolvedValue({ success: true, meta: {} }),
    raw: vi.fn().mockResolvedValue([]),
  };
  return stmt;
}

// ─── Mock R2 Bucket ───────────────────────────────────────────────────────────

export function createMockR2Bucket() {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  };
}

// ─── Mock KV Namespace ────────────────────────────────────────────────────────

export function createMockKVNamespace() {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
    getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
  };
}

// ─── Mock Queue ───────────────────────────────────────────────────────────────

export function createMockQueue() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    sendBatch: vi.fn().mockResolvedValue(undefined),
  };
}

// ─── Mock Environment ─────────────────────────────────────────────────────────
// Binding names MUST match the Env interface in src/types/index.ts exactly.

export function createMockEnv() {
  return {
    DB: createMockD1Database(),
    STORAGE: createMockR2Bucket(), // was R2_BUCKET — wrong name
    KV: createMockKVNamespace(), // was KV_CACHE — wrong name
    JWT_SECRET: "test-jwt-secret-key-for-testing-only",
    FCM_SERVER_KEY: "test-fcm-key",
    ENVIRONMENT: "test",
    MATCHING_QUEUE: createMockQueue(),
    NOTIFICATION_QUEUE: createMockQueue(),
    CAMPAIGN_QUEUE: createMockQueue(),
    CHAT_DO: {
      // was CHAT_DURABLE_OBJECT — wrong name
      idFromString: vi.fn((id: string) => ({ toString: () => id })),
      idFromName: vi.fn((name: string) => ({ toString: () => name })),
      newUniqueId: vi.fn(() => ({ toString: () => "new-do-id" })),
      get: vi.fn(),
    },
  };
}

// ─── Request helper ───────────────────────────────────────────────────────────

export function createMockRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Request {
  const { method = "GET", headers = {}, body } = options;
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export const testJwtSecret = "test-jwt-secret-key-for-testing-only";
