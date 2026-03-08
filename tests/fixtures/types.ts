/**
 * Type definitions for test fixtures
 *
 * Rule: fields that come from D1 DB rows use `Type | null` (nullable).
 *       `?: T` is reserved for fields that are genuinely absent in JS
 *       (e.g. truly optional metadata not present on every row).
 */

export interface User {
  id: string;
  email: string | null;
  phone: string | null;
  password_hash: string;
  display_name: string;
  role: "user" | "moderator" | "admin";
  status: "active" | "suspended" | "banned" | "deleted";
  verification_status: "unverified" | "pending" | "verified" | "failed";
  language_preference: string | null;
  fcm_token: string | null;
  created_at: string;
  updated_at: string;
}

export interface Neighborhood {
  id: string;
  name: string;
  city: string;
  country: string;
  center_lat: number | null;
  center_lng: number | null;
  radius_meters: number | null;
  is_active: boolean | null;
  created_at: string;
}

export interface UserNeighborhood {
  id: string;
  user_id: string;
  neighborhood_id: string;
  is_primary: boolean;
  joined_at: string;
  left_at: string | null;
}

export interface LeftoverOffer {
  id: string;
  user_id: string;
  neighborhood_id: string;
  title: string;
  description: string | null;
  survey_json: string;
  schema_version: number; // required — must match src/types/index.ts
  quantity: number;
  pickup_window_start: string | null;
  pickup_window_end: string | null;
  status: "draft" | "active" | "matched" | "closed" | "cancelled" | "expired";
  expiry_at: string;
  created_at: string;
  updated_at: string;
}

export interface LeftoverNeed {
  id: string;
  user_id: string;
  neighborhood_id: string;
  survey_json: string;
  schema_version: number; // required — must match src/types/index.ts
  urgency: "low" | "normal" | "high" | "urgent";
  status: "active" | "matched" | "closed" | "cancelled";
  created_at: string;
  updated_at: string;
}

export interface Match {
  id: string;
  neighborhood_id: string;
  offer_id: string;
  need_id: string;
  offer_user_id: string;
  need_user_id: string;
  score: number;
  match_reason: string | null;
  status: "active" | "pending_closure" | "closed" | "cancelled" | "disputed";
  closure_type: "successful" | "cancelled" | "expired" | "disputed" | null;
  closed_at: string | null;
  closed_by: string | null;
  coins_awarded: number;
  dispute_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatThread {
  id: string;
  match_id: string;
  neighborhood_id: string;
  participant_1_id: string;
  participant_2_id: string;
  status: "active" | "closed" | "archived";
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  thread_id: string;
  sender_id: string;
  body: string;
  message_type: "text" | "image" | "location" | "system";
  media_url: string | null;
  metadata: string | null;
  deleted_at: string | null;
  created_at: string;
}

export interface CleanifySubmission {
  id: string;
  user_id: string;
  neighborhood_id: string;
  before_photo_url: string | null;
  before_photo_key: string | null;
  before_uploaded_at: string | null;
  started_at: string | null;
  after_photo_url: string | null;
  after_photo_key: string | null;
  after_uploaded_at: string | null;
  completed_at: string | null;
  geo_lat: number | null;
  geo_lng: number | null;
  description: string | null;
  status:
    | "draft_before"
    | "in_progress"
    | "pending_review"
    | "approved"
    | "rejected"
    | "expired";
  reviewer_id: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  coins_awarded: number;
  created_at: string;
  updated_at: string;
}

export interface Campaign {
  id: string;
  neighborhood_id: string;
  title: string;
  description: string | null;
  organizer: string | null;
  location: string | null;
  location_geo_lat: number | null;
  location_geo_lng: number | null;
  start_dt: string;
  end_dt: string | null;
  url: string | null;
  image_url: string | null;
  source: string;
  source_identifier: string | null;
  status: string | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export interface CoinLedgerEntry {
  id: string;
  user_id: string;
  neighborhood_id: string;
  source_type: string;
  source_id: string;
  amount: number;
  category: string;
  description: string | null;
  status: "valid" | "void";
  created_by: string | null;
  created_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  data: string | null;
  read_at: string | null;
  created_at: string;
}

export interface LeftoverSurvey {
  schema_version?: number;
  food_type: string;
  diet_constraints: string[];
  portions: number;
  pickup_time_preference: string;
  distance_willing_km: number;
  notes: string | null;
}

export interface CoinRule {
  id: string;
  source_type: string;
  amount: number;
  category: string;
  description: string | null;
  is_active: boolean;
  created_at: string;
}
