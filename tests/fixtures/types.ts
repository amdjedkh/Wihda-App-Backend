/**
 * Type definitions for test fixtures
 */

export interface User {
  id: string;
  email?: string;
  phone?: string;
  password_hash: string;
  display_name: string;
  role: "user" | "moderator" | "admin";
  status: "active" | "suspended" | "banned" | "deleted";
  language_preference?: string;
  fcm_token?: string;
  created_at: string;
  updated_at: string;
}

export interface Neighborhood {
  id: string;
  name: string;
  city: string;
  country: string;
  center_lat?: number;
  center_lng?: number;
  radius_meters?: number;
  is_active?: boolean;
  created_at?: string;
}

export interface UserNeighborhood {
  id: string;
  user_id: string;
  neighborhood_id: string;
  is_primary: boolean;
  joined_at: string;
  left_at?: string | null;
}

export interface LeftoverOffer {
  id: string;
  user_id: string;
  neighborhood_id: string;
  title: string;
  description?: string;
  survey_json: string;
  quantity: number;
  pickup_window_start?: string;
  pickup_window_end?: string;
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
  urgency: "low" | "normal" | "high" | "urgent";
  status: "active" | "matched" | "closed" | "cancelled";
  created_at: string;
  updated_at: string;
}

export interface Match {
  id: string;
  neighborhood_id?: string;
  offer_id: string;
  need_id: string;
  offer_user_id?: string;
  need_user_id?: string;
  giver_user_id?: string;
  receiver_user_id?: string;
  score: number;
  status: "active" | "pending_closure" | "closed" | "cancelled" | "disputed";
  closure_type?: "successful" | "cancelled" | "expired" | "disputed";
  closed_at?: string;
  closed_by?: string;
  coins_awarded?: number;
  match_reason?: string;
  dispute_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface ChatThread {
  id: string;
  match_id: string;
  neighborhood_id?: string;
  participant_1_id?: string;
  participant_2_id?: string;
  status: "active" | "closed" | "archived";
  last_message_at?: string;
  created_at: string;
  updated_at?: string;
}

export interface ChatMessage {
  id: string;
  thread_id: string;
  sender_id: string;
  body: string;
  message_type: "text" | "image" | "location" | "system";
  media_url?: string;
  metadata?: string;
  deleted_at?: string;
  created_at: string;
}

// Updated for multi-step flow:
// draft_before → in_progress → pending_review → approved | rejected | expired
export interface CleanifySubmission {
  id: string;
  user_id: string;
  neighborhood_id: string;

  // Step 1 – before photo
  before_photo_url: string | null;
  before_photo_key: string | null;
  before_uploaded_at: string | null;
  started_at: string | null;

  // Step 2 – after photo
  after_photo_url: string | null;
  after_photo_key: string | null;
  after_uploaded_at: string | null;
  completed_at: string | null;

  geo_lat?: number;
  geo_lng?: number;
  description?: string;

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
  description?: string;
  organizer?: string;
  location?: string;
  location_geo_lat?: number;
  location_geo_lng?: number;
  start_dt: string;
  end_dt?: string;
  url?: string;
  image_url?: string;
  source: string;
  source_identifier?: string;
  status?: string;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

export interface CoinLedgerEntry {
  id: string;
  user_id?: string;
  neighborhood_id?: string;
  source_type: string;
  source_id: string;
  amount: number;
  category: string;
  description?: string;
  status: "valid" | "void";
  created_by?: string;
  created_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string;
  data?: string;
  read_at?: string;
  created_at: string;
}

export interface LeftoverSurvey {
  schema_version?: number;
  food_type: string;
  diet_constraints: string[];
  portions: number;
  pickup_time_preference: string;
  distance_willing_km: number;
  notes?: string;
}

export interface CoinRule {
  id: string;
  source_type: string;
  amount: number;
  category: string;
  description?: string;
  is_active: boolean;
  created_at: string;
}
