/**
 * Test Fixtures
 * Mock data and test utilities for Wihda Backend tests
 */

import { vi } from 'vitest';
import { User, Neighborhood, LeftoverOffer, LeftoverNeed, Match, ChatThread, ChatMessage, CleanifySubmission, Campaign, CoinLedgerEntry } from '../fixtures/types';

// Test users
export const testUsers: User[] = [
  {
    id: 'user-001',
    email: 'admin@wihda.ma',
    phone: '+212600000001',
    password_hash: 'hashed_password_123',
    display_name: 'Admin User',
    role: 'admin',
    status: 'active',
    language_preference: 'en',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 'user-002',
    email: 'mod@wihda.ma',
    phone: '+212600000002',
    password_hash: 'hashed_password_123',
    display_name: 'Moderator One',
    role: 'moderator',
    status: 'active',
    language_preference: 'en',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 'user-003',
    email: 'ahmed@example.ma',
    phone: '+212600000003',
    password_hash: 'hashed_password_123',
    display_name: 'Ahmed Benali',
    role: 'user',
    status: 'active',
    language_preference: 'en',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 'user-004',
    email: 'fatima@example.ma',
    phone: '+212600000004',
    password_hash: 'hashed_password_123',
    display_name: 'Fatima Zahra',
    role: 'user',
    status: 'active',
    language_preference: 'en',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
  },
];

// Test neighborhoods
export const testNeighborhoods: Neighborhood[] = [
  {
    id: 'nb-001',
    name: 'Hay Riad',
    city: 'Rabat',
    country: 'MA',
    center_lat: 33.9716,
    center_lng: -6.8498,
    radius_meters: 3000,
    is_active: true,
    created_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 'nb-002',
    name: 'Agdal',
    city: 'Rabat',
    country: 'MA',
    center_lat: 33.9911,
    center_lng: -6.8477,
    radius_meters: 2500,
    is_active: true,
    created_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 'nb-003',
    name: 'Maarif',
    city: 'Casablanca',
    country: 'MA',
    center_lat: 33.5883,
    center_lng: -7.6114,
    radius_meters: 2000,
    is_active: true,
    created_at: '2024-01-01T00:00:00Z',
  },
];

// Test leftover offers
export const testOffers: LeftoverOffer[] = [
  {
    id: 'offer-001',
    user_id: 'user-003',
    neighborhood_id: 'nb-001',
    title: 'Couscous traditionnel',
    description: 'Couscous aux légumes fait maison, assez pour 4 personnes',
    survey_json: JSON.stringify({
      schema_version: 1,
      food_type: 'cooked_meal',
      diet_constraints: ['halal'],
      portions: 4,
      pickup_time_preference: 'evening',
      distance_willing_km: 2,
      notes: 'Préparé aujourd\'hui',
    }),
    quantity: 1,
    status: 'active',
    expiry_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    created_at: '2024-01-15T10:00:00Z',
    updated_at: '2024-01-15T10:00:00Z',
  },
  {
    id: 'offer-002',
    user_id: 'user-003',
    neighborhood_id: 'nb-001',
    title: 'Fresh Bread',
    description: 'Baguettes from this morning',
    survey_json: JSON.stringify({
      schema_version: 1,
      food_type: 'bread',
      diet_constraints: [],
      portions: 6,
      pickup_time_preference: 'morning',
      distance_willing_km: 1,
    }),
    quantity: 2,
    status: 'active',
    expiry_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    created_at: '2024-01-15T08:00:00Z',
    updated_at: '2024-01-15T08:00:00Z',
  },
];

// Test leftover needs
export const testNeeds: LeftoverNeed[] = [
  {
    id: 'need-001',
    user_id: 'user-004',
    neighborhood_id: 'nb-001',
    survey_json: JSON.stringify({
      schema_version: 1,
      food_type: 'cooked_meal',
      diet_constraints: ['halal'],
      portions: 2,
      pickup_time_preference: 'evening',
      distance_willing_km: 3,
      notes: 'Famille de 2 personnes',
    }),
    urgency: 'normal',
    status: 'active',
    created_at: '2024-01-15T11:00:00Z',
    updated_at: '2024-01-15T11:00:00Z',
  },
];

// Test matches
export const testMatches: Match[] = [
  {
    id: 'match-001',
    offer_id: 'offer-001',
    need_id: 'need-001',
    giver_user_id: 'user-003',
    receiver_user_id: 'user-004',
    score: 0.85,
    status: 'active',
    created_at: '2024-01-15T12:00:00Z',
    updated_at: '2024-01-15T12:00:00Z',
  },
];

// Test chat threads
export const testChatThreads: ChatThread[] = [
  {
    id: 'thread-001',
    match_id: 'match-001',
    status: 'active',
    created_at: '2024-01-15T12:00:00Z',
    updated_at: '2024-01-15T12:00:00Z',
  },
];

// Test chat messages
export const testChatMessages: ChatMessage[] = [
  {
    id: 'msg-001',
    thread_id: 'thread-001',
    sender_id: 'user-003',
    body: 'Hi! I have the couscous ready for pickup.',
    message_type: 'text',
    created_at: '2024-01-15T12:05:00Z',
  },
  {
    id: 'msg-002',
    thread_id: 'thread-001',
    sender_id: 'user-004',
    body: 'Great! I can come at 6pm. Where are you located?',
    message_type: 'text',
    created_at: '2024-01-15T12:10:00Z',
  },
];

// Test cleanify submissions
export const testSubmissions: CleanifySubmission[] = [
  {
    id: 'sub-001',
    user_id: 'user-003',
    neighborhood_id: 'nb-001',
    before_photo_url: 'https://r2.example.com/before-001.jpg',
    after_photo_url: 'https://r2.example.com/after-001.jpg',
    geo_lat: 33.9716,
    geo_lng: -6.8498,
    description: 'Cleaned the park area near my building',
    status: 'pending',
    coins_awarded: 0,
    submitted_at: '2024-01-15T14:00:00Z',
    created_at: '2024-01-15T14:00:00Z',
    updated_at: '2024-01-15T14:00:00Z',
  },
  {
    id: 'sub-002',
    user_id: 'user-003',
    neighborhood_id: 'nb-001',
    before_photo_url: 'https://r2.example.com/before-002.jpg',
    after_photo_url: 'https://r2.example.com/after-002.jpg',
    geo_lat: 33.9710,
    geo_lng: -6.8500,
    description: 'Street cleanup initiative',
    status: 'approved',
    coins_awarded: 150,
    submitted_at: '2024-01-10T10:00:00Z',
    reviewed_at: '2024-01-10T16:00:00Z',
    reviewed_by: 'user-002',
    review_note: 'Great job! Area looks much cleaner.',
    created_at: '2024-01-10T10:00:00Z',
    updated_at: '2024-01-10T16:00:00Z',
  },
];

// Test campaigns
export const testCampaigns: Campaign[] = [
  {
    id: 'camp-001',
    neighborhood_id: 'nb-001',
    title: 'Nettoyage Quartier Hay Riad',
    description: 'Opération de nettoyage communautaire',
    organizer: 'Association Hay Riad',
    location: 'Place Hay Riad',
    start_dt: '2024-02-15T09:00:00Z',
    end_dt: '2024-02-15T12:00:00Z',
    source: 'manual',
    last_seen_at: '2024-01-15T00:00:00Z',
    created_at: '2024-01-10T00:00:00Z',
    updated_at: '2024-01-10T00:00:00Z',
  },
];

// Test coin ledger entries
export const testCoinEntries: CoinLedgerEntry[] = [
  {
    id: 'coin-001',
    user_id: 'user-003',
    source_type: 'signup_bonus',
    source_id: 'signup-001',
    amount: 50,
    category: 'bonus',
    description: 'Welcome bonus for joining Wihda',
    status: 'valid',
    created_at: '2024-01-01T00:00:00Z',
  },
  {
    id: 'coin-002',
    user_id: 'user-003',
    source_type: 'cleanify_approved',
    source_id: 'sub-002',
    amount: 150,
    category: 'cleanify',
    description: 'Cleanify submission approved',
    status: 'valid',
    created_at: '2024-01-10T16:00:00Z',
  },
];

// Mock D1 Database
export function createMockD1Database() {
  const mockDb = {
    prepare: vi.fn(() => mockDb),
    bind: vi.fn(() => mockDb),
    first: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
    batch: vi.fn(),
    exec: vi.fn(),
    dump: vi.fn(),
  };
  return mockDb;
}

// Mock R2 Bucket
export function createMockR2Bucket() {
  return {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  };
}

// Mock KV Namespace
export function createMockKVNamespace() {
  return {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  };
}

// Mock Queue
export function createMockQueue() {
  return {
    send: vi.fn(),
    sendBatch: vi.fn(),
  };
}

// Mock Environment
export function createMockEnv() {
  return {
    DB: createMockD1Database(),
    R2_BUCKET: createMockR2Bucket(),
    KV_CACHE: createMockKVNamespace(),
    JWT_SECRET: 'test-jwt-secret-key-for-testing-only',
    MATCHING_QUEUE: createMockQueue(),
    NOTIFICATION_QUEUE: createMockQueue(),
    CAMPAIGN_QUEUE: createMockQueue(),
    CHAT_DURABLE_OBJECT: {
      idFromString: vi.fn((id: string) => ({ toString: () => id })),
      newUniqueId: vi.fn(() => ({ toString: () => 'new-do-id' })),
      get: vi.fn(),
    },
    FCM_SERVER_KEY: 'test-fcm-key',
  };
}

// Helper to create mock request
export function createMockRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {}
): Request {
  const { method = 'GET', headers = {}, body } = options;
  
  const defaultHeaders = {
    'Content-Type': 'application/json',
    ...headers,
  };

  return new Request(url, {
    method,
    headers: defaultHeaders,
    body: body ? JSON.stringify(body) : undefined,
  }) as Request;
}

// Helper to create mock context
export function createMockContext(env: ReturnType<typeof createMockEnv>) {
  return {
    env,
    executionCtx: {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
    },
    req: {} as Request,
    res: {} as Response,
    event: {} as FetchEvent,
  };
}

// JWT test utilities
export const testJwtSecret = 'test-jwt-secret-key-for-testing-only';

export function createTestJWT(userId: string, role: string = 'user', secret: string = testJwtSecret): string {
  // Simple mock JWT - in real tests you'd use actual JWT creation
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({
    sub: userId,
    role,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  const signature = btoa('test-signature');
  return `${header}.${payload}.${signature}`;
}
