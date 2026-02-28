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
    email: "admin@wihda.dz",
    phone: "+213600000001",
    password_hash: "hashed_password_123",
    display_name: "Admin User",
    role: "admin",
    status: "active",
    verification_status: "verified",
    language_preference: "fr",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "user-002",
    email: "mod@wihda.dz",
    phone: "+213600000002",
    password_hash: "hashed_password_123",
    display_name: "Moderator One",
    role: "moderator",
    status: "active",
    verification_status: "verified",
    language_preference: "fr",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "user-003",
    email: "ahmed@example.dz",
    phone: "+213600000003",
    password_hash: "hashed_password_123",
    display_name: "Ahmed Benali",
    role: "user",
    status: "active",
    verification_status: "verified",
    language_preference: "fr",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "user-004",
    email: "fatima@example.dz",
    phone: "+213600000004",
    password_hash: "hashed_password_123",
    display_name: "Fatima Zahra",
    role: "user",
    status: "active",
    verification_status: "verified",
    language_preference: "fr",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  },
];

// ─── Test neighborhoods ───────────────────────────────────────────────────────

export const testNeighborhoods: Neighborhood[] = [
  {
    id: "nb-001",
    name: "Bab El Oued",
    city: "Algiers",
    country: "DZ",
    center_lat: 36.7802,
    center_lng: 3.0597,
    radius_meters: 3000,
    is_active: true,
    created_at: "2024-01-01T00:00:00Z",
  },
  {
    id: "nb-002",
    name: "Hydra",
    city: "Algiers",
    country: "DZ",
    center_lat: 36.7411,
    center_lng: 3.0464,
    radius_meters: 2500,
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
    description: "Couscous aux légumes fait maison, pour 4 personnes",
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
    body: "Hi! The couscous is ready for pickup.",
    message_type: "text",
    created_at: "2024-01-15T12:05:00Z",
  },
];

// ─── Test cleanify submissions ────────────────────────────────────────────────

const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

export const testSubmissions: CleanifySubmission[] = [
  {
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
    geo_lat: 36.7802,
    geo_lng: 3.0597,
    description: "Cleaned the street near my building",
    status: "pending_review",
    reviewer_id: null,
    reviewed_at: null,
    review_note: null,
    coins_awarded: 0,
    created_at: "2024-01-15T14:00:00Z",
    updated_at: "2024-01-15T14:00:00Z",
  },
];

// ─── Test campaigns ───────────────────────────────────────────────────────────

export const testCampaigns: Campaign[] = [
  {
    id: "camp-001",
    neighborhood_id: "nb-001",
    title: "Nettoyage Bab El Oued",
    description: "Opération de nettoyage communautaire",
    organizer: "Association Bab El Oued",
    location: "Place Bab El Oued",
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
];

// ─── Mock D1 Database ─────────────────────────────────────────────────────────

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
    bind: vi.fn().mockReturnThis(),
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

export function createMockEnv() {
  return {
    DB: createMockD1Database(),
    STORAGE: createMockR2Bucket(),
    KV: createMockKVNamespace(),

    JWT_SECRET: "test-jwt-secret-key-for-testing-only",
    FCM_SERVER_KEY: "test-fcm-key",
    GEMINI_API_KEY: "test-gemini-api-key",
    INTERNAL_WEBHOOK_SECRET: "test-internal-secret",
    ENVIRONMENT: "test",

    MATCHING_QUEUE: createMockQueue(),
    NOTIFICATION_QUEUE: createMockQueue(),
    CAMPAIGN_QUEUE: createMockQueue(),
    VERIFICATION_QUEUE: createMockQueue(),

    CHAT_DO: {
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
