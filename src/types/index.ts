/**
 * Wihda Backend - Type Definitions
 * All entities mapped from database schema
 */

// ============================================
// Environment Bindings
// ============================================

export interface Env {
  // D1 Database
  DB: D1Database;
  
  // R2 Storage
  STORAGE: R2Bucket;
  
  // KV Namespace
  KV: KVNamespace;
  
  // Queues
  MATCHING_QUEUE: Queue<MatchingQueueMessage>;
  CAMPAIGN_QUEUE: Queue<CampaignQueueMessage>;
  NOTIFICATION_QUEUE: Queue<NotificationQueueMessage>;
  
  // Durable Objects
  CHAT_DO: DurableObjectNamespace;
  
  // Environment variables
  ENVIRONMENT: string;
  JWT_SECRET: string;
  FCM_SERVER_KEY: string;
}

// ============================================
// User Types
// ============================================

export type UserRole = 'user' | 'moderator' | 'admin';
export type UserStatus = 'active' | 'banned' | 'suspended';

export interface User {
  id: string;
  email: string | null;
  phone: string | null;
  password_hash: string;
  display_name: string;
  role: UserRole;
  status: UserStatus;
  language_preference: string;
  fcm_token: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserPublic {
  id: string;
  display_name: string;
  role: UserRole;
  created_at: string;
}

export interface UserWithNeighborhood extends User {
  neighborhood_id: string | null;
  neighborhood_name: string | null;
}

// ============================================
// Neighborhood Types
// ============================================

export interface Neighborhood {
  id: string;
  name: string;
  city: string;
  country: string;
  center_lat: number | null;
  center_lng: number | null;
  radius_meters: number | null;
  geo_polygon: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface UserNeighborhood {
  id: string;
  user_id: string;
  neighborhood_id: string;
  joined_at: string;
  left_at: string | null;
  is_primary: number;
}

// ============================================
// Coins Types
// ============================================

export type CoinSourceType = 
  | 'leftovers_match_closed_giver'
  | 'leftovers_match_closed_receiver'
  | 'cleanify_approved'
  | 'admin_adjustment'
  | 'signup_bonus'
  | 'referral_bonus';

export type CoinStatus = 'valid' | 'void';

export type CoinCategory = 'leftovers' | 'cleanify' | 'admin' | 'bonus';

export interface CoinLedgerEntry {
  id: string;
  user_id: string;
  neighborhood_id: string;
  source_type: CoinSourceType;
  source_id: string;
  amount: number;
  category: CoinCategory;
  description: string | null;
  status: CoinStatus;
  created_at: string;
  created_by: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
}

export interface CoinRule {
  id: string;
  source_type: CoinSourceType;
  amount: number;
  description: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface CoinBalance {
  user_id: string;
  balance: number;
  last_updated: string;
}

// ============================================
// Leftovers Types
// ============================================

export type OfferStatus = 'draft' | 'active' | 'matched' | 'closed' | 'cancelled' | 'expired';
export type NeedStatus = 'active' | 'matched' | 'closed' | 'cancelled';
export type Urgency = 'low' | 'normal' | 'high' | 'urgent';

export interface LeftoverSurvey {
  schema_version: number;
  food_type: string;
  diet_constraints: string[];
  portions: number;
  pickup_time_preference: string;
  distance_willing_km: number;
  notes?: string;
}

export interface LeftoverOffer {
  id: string;
  user_id: string;
  neighborhood_id: string;
  title: string;
  description: string | null;
  survey_json: string;
  schema_version: number;
  quantity: number;
  pickup_window_start: string | null;
  pickup_window_end: string | null;
  expiry_at: string;
  status: OfferStatus;
  created_at: string;
  updated_at: string;
}

export interface LeftoverNeed {
  id: string;
  user_id: string;
  neighborhood_id: string;
  survey_json: string;
  schema_version: number;
  urgency: Urgency;
  status: NeedStatus;
  created_at: string;
  updated_at: string;
}

// ============================================
// Match Types
// ============================================

export type MatchStatus = 'active' | 'pending_closure' | 'closed' | 'cancelled' | 'disputed';
export type ClosureType = 'successful' | 'cancelled' | 'expired' | 'disputed';

export interface Match {
  id: string;
  neighborhood_id: string;
  offer_id: string;
  need_id: string;
  offer_user_id: string;
  need_user_id: string;
  score: number;
  match_reason: string | null;
  status: MatchStatus;
  closed_by: string | null;
  closed_at: string | null;
  closure_type: ClosureType | null;
  dispute_reason: string | null;
  coins_awarded: number;
  created_at: string;
  updated_at: string;
}

export interface MatchWithDetails extends Match {
  offer?: LeftoverOffer;
  need?: LeftoverNeed;
  offer_user?: UserPublic;
  need_user?: UserPublic;
  chat_thread_id?: string;
}

// ============================================
// Chat Types
// ============================================

export type ChatThreadStatus = 'active' | 'closed' | 'archived';
export type MessageType = 'text' | 'image' | 'system' | 'location';

export interface ChatThread {
  id: string;
  match_id: string;
  neighborhood_id: string;
  participant_1_id: string;
  participant_2_id: string;
  status: ChatThreadStatus;
  last_message_at: string | null;
  created_at: string;
  closed_at: string | null;
}

export interface ChatMessage {
  id: string;
  thread_id: string;
  sender_id: string;
  body: string;
  message_type: MessageType;
  media_url: string | null;
  metadata: string | null;
  read_at: string | null;
  created_at: string;
  deleted_at: string | null;
}

export interface ChatMessageWithSender extends ChatMessage {
  sender_name: string;
}

// ============================================
// Cleanify Types
// ============================================

export type CleanifyStatus = 'pending' | 'approved' | 'rejected';

export interface CleanifySubmission {
  id: string;
  user_id: string;
  neighborhood_id: string;
  before_photo_url: string;
  after_photo_url: string;
  geo_lat: number | null;
  geo_lng: number | null;
  description: string | null;
  status: CleanifyStatus;
  submitted_at: string;
  reviewer_id: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  coins_awarded: number;
  created_at: string;
  updated_at: string;
}

export interface CleanifySubmissionWithUser extends CleanifySubmission {
  user_name: string;
}

// ============================================
// Campaign Types
// ============================================

export type CampaignSource = 'scrape' | 'manual' | 'api';
export type CampaignStatus = 'active' | 'expired' | 'cancelled';

export interface Campaign {
  id: string;
  neighborhood_id: string;
  title: string;
  description: string | null;
  organizer: string | null;
  location: string | null;
  location_lat: number | null;
  location_lng: number | null;
  start_dt: string;
  end_dt: string | null;
  url: string | null;
  image_url: string | null;
  source: CampaignSource;
  source_identifier: string | null;
  external_id: string | null;
  status: CampaignStatus;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

// ============================================
// Notification Types
// ============================================

export type NotificationType = 
  | 'match_created'
  | 'new_message'
  | 'match_closed'
  | 'coins_awarded'
  | 'cleanify_approved'
  | 'cleanify_rejected'
  | 'campaign_new'
  | 'system';

export interface Notification {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  body: string;
  data: string | null;
  read_at: string | null;
  sent_at: string | null;
  created_at: string;
}

// ============================================
// Moderation Types
// ============================================

export type ModerationActionType = 
  | 'cleanify_approve'
  | 'cleanify_reject'
  | 'match_void'
  | 'coin_void'
  | 'user_ban'
  | 'user_unban'
  | 'content_remove';

export interface ModerationLog {
  id: string;
  moderator_id: string;
  action_type: ModerationActionType;
  target_type: string;
  target_id: string;
  reason: string | null;
  metadata: string | null;
  created_at: string;
}

// ============================================
// Queue Message Types
// ============================================

export interface MatchingQueueMessage {
  type: 'match_offer' | 'match_need' | 'scheduled_matching';
  offer_id?: string;
  need_id?: string;
  neighborhood_id?: string;
  timestamp: string;
}

export interface CampaignQueueMessage {
  type: 'ingest' | 'expire_old';
  source?: string;
  neighborhood_id?: string;
  timestamp: string;
}

export interface NotificationQueueMessage {
  user_id: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

// ============================================
// API Types
// ============================================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface PaginatedResponse<T> {
  items: T[];
  cursor: string | null;
  has_more: boolean;
  total?: number;
}

export interface JWTPayload {
  sub: string;  // user_id
  role: UserRole;
  neighborhood_id: string | null;
  iat: number;
  exp: number;
}

// ============================================
// Request/Response DTOs
// ============================================

// Auth
export interface SignupRequest {
  email?: string;
  phone?: string;
  password: string;
  display_name: string;
  language_preference?: string;
}

export interface LoginRequest {
  email?: string;
  phone?: string;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: UserPublic;
}

// User
export interface UpdateProfileRequest {
  display_name?: string;
  language_preference?: string;
  fcm_token?: string;
}

// Neighborhood
export interface JoinNeighborhoodRequest {
  neighborhood_id: string;
}

export interface LookupNeighborhoodRequest {
  city?: string;
  name?: string;
  lat?: number;
  lng?: number;
}

// Leftovers
export interface CreateOfferRequest {
  title: string;
  description?: string;
  survey: LeftoverSurvey;
  quantity?: number;
  pickup_window_start?: string;
  pickup_window_end?: string;
  expiry_hours?: number;
}

export interface CreateNeedRequest {
  survey: LeftoverSurvey;
  urgency?: Urgency;
}

export interface CloseMatchRequest {
  closure_type: ClosureType;
  dispute_reason?: string;
}

// Chat
export interface SendMessageRequest {
  body: string;
  message_type?: MessageType;
  media_url?: string;
}

// Cleanify
export interface CreateCleanifyRequest {
  before_photo_url: string;
  after_photo_url: string;
  geo_lat?: number;
  geo_lng?: number;
  description?: string;
}

export interface ReviewCleanifyRequest {
  approve: boolean;
  note?: string;
}

// Image Upload
export interface UploadUrlRequest {
  content_type: 'before_photo' | 'after_photo' | 'chat_image';
  file_extension: string;
}

export interface UploadUrlResponse {
  upload_url: string;
  file_key: string;
  expires_at: string;
}
