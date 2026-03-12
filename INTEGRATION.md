# Wihda Mobile Integration Guide

This document is written for the mobile developer connecting the Wihda app to the backend API. It covers auth flows, token handling, WebSocket setup, pagination, error shapes, and every endpoint the app needs to call.

---

## Base URL

```
https://api.wihda.app/v1
```

All endpoints are prefixed with `/v1`. The health check at `/health` (no prefix) can be used to verify connectivity.

---

## Authentication

### Token Types

The backend issues two types of JWT:

| Token              | Scope               | What it can access                                |
| ------------------ | ------------------- | ------------------------------------------------- |
| `restricted_token` | `verification_only` | Only `/v1/auth/verify/*` and `/v1/verification/*` |
| `access_token`     | `full`              | Everything else                                   |

Tokens are JWTs. Send them in every request header:

```
Authorization: Bearer <token>
```

### Token Lifecycle

```
POST /v1/auth/signup
  -> returns restricted_token + verification_session_id

POST /v1/auth/verify/email/send  (uses restricted_token)
POST /v1/auth/verify/email/confirm

POST /v1/verification/start      (uses restricted_token)
POST /v1/verification/submit

POST /v1/auth/login
  -> returns access_token (expires in 15 min) + refresh_token (expires in 7 days)

POST /v1/auth/refresh
  -> returns new access_token + new refresh_token (rotation)
```

Refresh tokens are single-use. Always store the latest refresh token and discard the old one immediately after a successful refresh. If a refresh token is used twice, the second use will fail with `INVALID_REFRESH_TOKEN`.

### Token Expiry Strategy

- `access_token` expires in **15 minutes**
- `refresh_token` expires in **7 days**
- On any `401` response, attempt one silent refresh. If refresh fails, redirect to login.

---

## Error Shape

All errors follow this exact shape:

```json
{
  "success": false,
  "error": {
    "code": "SNAKE_CASE_CODE",
    "message": "Human readable message",
    "details": {}
  }
}
```

Common codes:

| Code                    | HTTP | Meaning                                                |
| ----------------------- | ---- | ------------------------------------------------------ |
| `UNAUTHORIZED`          | 401  | Missing or invalid token                               |
| `INVALID_REFRESH_TOKEN` | 401  | Refresh token used twice or expired                    |
| `NOT_VERIFIED`          | 403  | User KYC not completed                                 |
| `INSUFFICIENT_SCOPE`    | 403  | Using restricted_token on a full-scope route           |
| `FORBIDDEN`             | 403  | Correct auth, wrong permissions                        |
| `NOT_FOUND`             | 404  | Resource does not exist                                |
| `VALIDATION_ERROR`      | 400  | Invalid request body. Check `details` for field errors |
| `THREAD_CLOSED`         | 400  | Sending to a closed chat thread                        |
| `TOO_EARLY`             | 400  | Cleanify after photo attempted before 20 min gate      |
| `SUBMISSION_EXPIRED`    | 410  | Cleanify 48h window passed                             |
| `RATE_LIMITED`          | 429  | Too many requests                                      |
| `INTERNAL_ERROR`        | 500  | Server error, safe to retry with backoff               |

---

## Success Shape

All successful responses:

```json
{
  "success": true,
  "data": {}
}
```

---

## Signup and Verification Flow

### 1. Signup

```
POST /v1/auth/signup
{
  "display_name": "string",
  "email": "string",          // at least one of email or phone
  "phone": "string",          // E.164 format e.g. +213XXXXXXXXX
  "password": "string"        // min 8 chars
}
```

Response:

```json
{
  "restricted_token": "...",
  "verification_session_id": "...",
  "contact_verification_required": true
}
```

Store the `restricted_token`. Use it (and only it) for the next two steps.

### 2. Contact Verification (OTP)

Send OTP:

```
POST /v1/auth/verify/email/send      // or /phone/send
Authorization: Bearer <restricted_token>
```

Confirm OTP:

```
POST /v1/auth/verify/email/confirm
Authorization: Bearer <restricted_token>
{ "code": "123456" }
```

Rate limits: 3 sends per hour. 5 wrong guesses locks the record for 60 minutes.

### 3. KYC

Start session:

```
POST /v1/verification/start
Authorization: Bearer <restricted_token>
```

Get upload URL for each document:

```
POST /v1/verification/presigned-url
Authorization: Bearer <restricted_token>
{ "document_type": "front" }     // front | back | selfie
```

Upload the file directly to the returned `upload_url` via PUT with the correct `Content-Type`.

Submit for review:

```
POST /v1/verification/submit
Authorization: Bearer <restricted_token>
```

Poll status (every 5 seconds, max 2 minutes):

```
GET /v1/verification/status
Authorization: Bearer <restricted_token>
```

Response `verification_status` values: `unverified`, `pending`, `processing`, `verified`, `failed`, `rejected`.

### 4. Login

Once KYC is `verified`:

```
POST /v1/auth/login
{ "email": "...", "password": "..." }
```

Returns `access_token` + `refresh_token`. Store both securely (Keychain / Keystore).

---

## Pagination

All list endpoints that return large collections use **cursor-based pagination**:

```
GET /v1/me/coins?limit=20&cursor=<next_cursor>
```

Response always includes:

```json
{
  "has_more": true,
  "next_cursor": "entry-uuid-here"
}
```

Pass `next_cursor` as `cursor` in the next request. When `has_more` is `false`, you have reached the end. Cursors are stable UUIDs, not timestamps.

Default and max limits per endpoint:

| Endpoint                     | Default | Max |
| ---------------------------- | ------- | --- |
| `GET /v1/leftovers/offers`   | 20      | 100 |
| `GET /v1/leftovers/needs`    | 20      | 100 |
| `GET /v1/chats/:id/messages` | 50      | 100 |
| `GET /v1/me/coins`           | 20      | 100 |
| `GET /v1/me/coins/history`   | 20      | 100 |
| `GET /v1/campaigns`          | 20      | 100 |

---

## User Profile

```
GET /v1/me
```

Returns the full profile including `neighborhood`, `coin_balance`, and `verification_status`. This is the first call to make after login. Does not require `verification_status: verified` -- safe to call during the KYC flow.

```
PATCH /v1/me
{ "display_name": "...", "language_preference": "ar", "fcm_token": "..." }
```

Update `fcm_token` here whenever the FCM registration token refreshes.

---

## Neighborhoods

```
GET /v1/neighborhoods/lookup?city=Alger
GET /v1/neighborhoods/:id
POST /v1/neighborhoods/join
{ "neighborhood_id": "..." }
GET /v1/neighborhoods/:id/stats
```

Users must join a neighborhood before accessing Leftovers, Cleanify, Campaigns, or Chat.

---

## Leftovers

### Create an offer

```
POST /v1/leftovers/offers
{
  "title": "string",
  "description": "string",
  "survey": {
    "food_type": "cooked_meal",         // cooked_meal | raw_ingredients | packaged
    "diet_constraints": ["halal"],       // halal | vegetarian | vegan | gluten_free | none
    "portions": 4,
    "pickup_time_preference": "evening", // morning | afternoon | evening | flexible
    "distance_willing_km": 5
  },
  "expiry_at": "2025-06-20T18:00:00Z"
}
```

### Create a need

```
POST /v1/leftovers/needs
{
  "survey": { ... same shape as offer survey ... },
  "urgency": "normal"   // normal | urgent
}
```

### List

```
GET /v1/leftovers/offers?status=active    // active | mine
GET /v1/leftovers/needs?status=active
```

### Matches

```
GET /v1/leftovers/matches
```

Returns all matches for the current user (as giver or receiver).

### Close a match

```
POST /v1/leftovers/matches/:id/close
{ "outcome": "successful" }    // successful | cancelled | disputed | no_show
```

Closing a match as `successful` awards coins to both parties and opens a chat thread.

---

## Chat

### List threads

```
GET /v1/chats
```

### Thread metadata

```
GET /v1/chats/:thread_id
```

### Message history

```
GET /v1/chats/:thread_id/messages?limit=50&cursor=<id>
```

Messages are returned oldest-first after cursor reversal. `next_cursor` points to the oldest message in the current page -- pass it to get older messages.

### Send a message (REST)

```
POST /v1/chats/:thread_id/messages
{ "body": "string", "message_type": "text" }   // text | image | location
```

### WebSocket (real-time)

Connect:

```
wss://api.wihda.app/v1/chats/:thread_id/ws?token=<access_token>
```

The token goes in the query string -- browsers cannot set Authorization headers on WebSocket connections.

**Client -> Server message types:**

```json
{ "type": "message",  "payload": { "body": "Hello", "message_type": "text" } }
{ "type": "typing",   "payload": true }
{ "type": "read",     "payload": null }
{ "type": "ping",     "payload": null }
```

**Server -> Client message types:**

```json
{ "type": "connected",   "payload": { "thread_id": "...", "connected_users": [...] } }
{ "type": "message",     "payload": { "id": "...", "sender_id": "...", "body": "...", "created_at": "..." } }
{ "type": "typing",      "payload": { "user_id": "...", "is_typing": true } }
{ "type": "read",        "payload": { "read_by": "...", "read_at": "..." } }
{ "type": "user_joined", "payload": { "user_id": "...", "connected_users": [...] } }
{ "type": "user_left",   "payload": { "user_id": "...", "connected_users": [...] } }
{ "type": "pong",        "payload": 1718000000000 }
{ "type": "error",       "payload": { "message": "..." } }
```

Rate limit: 20 messages per 10 seconds per connection. Exceeding this returns an `error` message -- the connection stays open.

Messages sent via the REST endpoint (`POST /messages`) are also broadcast to all connected WebSocket clients in real time.

---

## Cleanify

Multi-step, time-gated submission flow:

```
POST /v1/cleanify/start
-> { submission_id, status: "draft_before" }

POST /v1/cleanify/:id/before/presigned-url
{ "file_extension": "jpg" }    // jpg | jpeg | png | heic | webp
-> { upload_url, file_key, expires_at }

// PUT file bytes to upload_url with Content-Type: image/jpeg

POST /v1/cleanify/:id/before/confirm
{ "file_key": "..." }
-> { status: "in_progress", available_after: "..." }

// Wait until available_after (20 minutes minimum)

POST /v1/cleanify/:id/after/presigned-url
{ "file_extension": "jpg" }
-> { upload_url, file_key }

// PUT file bytes to upload_url

POST /v1/cleanify/:id/after/confirm
{ "file_key": "..." }
-> { status: "pending_review" }
```

The submission is then automatically reviewed by Gemini Vision AI. Poll `GET /v1/cleanify/submissions/:id` for the result. Status values: `draft_before`, `in_progress`, `pending_review`, `approved`, `rejected`, `expired`.

The 48-hour window starts from `before_uploaded_at`. If you try to upload the after photo after 48 hours, you get `410 SUBMISSION_EXPIRED`.

```
GET /v1/cleanify/submissions             // own submissions
GET /v1/cleanify/submissions?pending=true  // moderator only: review queue
GET /v1/cleanify/submissions/:id
GET /v1/cleanify/stats
```

---

## Coins

```
GET /v1/me/coins
-> { balance, entries: [...], has_more, next_cursor }
```

`entries` contains only valid (non-voided) transactions.

```
GET /v1/me/coins/history
-> { entries: [...], has_more, next_cursor }
```

`history` includes voided entries too -- useful for showing a full audit trail if a user asks why their balance changed.

### Coin sources

| Source                           | Amount | Trigger                      |
| -------------------------------- | ------ | ---------------------------- |
| Leftover match closed (giver)    | +200   | Match closed as `successful` |
| Leftover match closed (receiver) | +50    | Match closed as `successful` |
| Cleanify approved                | +150   | AI or moderator approval     |
| Signup bonus                     | +50    | On first login               |

---

## Campaigns

```
GET /v1/campaigns
GET /v1/campaigns/:id
```

Campaigns are populated automatically from [cra.dz](https://cra.dz/) every 12 hours. No user action needed. Results are scoped to the user's neighborhood.

---

## Push Notifications

Register the FCM token on login or when it refreshes:

```
PATCH /v1/me
{ "fcm_token": "<FCM registration token>" }
```

Notification `type` values the app should handle:

| Type                    | Trigger                      |
| ----------------------- | ---------------------------- |
| `new_message`           | New chat message             |
| `match_found`           | A leftover match was created |
| `cleanify_approved`     | Cleanify submission approved |
| `cleanify_rejected`     | Cleanify submission rejected |
| `verification_approved` | KYC approved                 |
| `verification_rejected` | KYC rejected                 |

---

## File Uploads

For any file upload (profile photo, chat image, etc.):

```
POST /v1/uploads/presigned-url
{ "file_extension": "jpg", "purpose": "chat_image" }
-> { upload_url, file_key, expires_at }
```

Then PUT the file bytes directly to `upload_url` with the correct `Content-Type` header.

To serve the file later:

```
GET /v1/uploads/:file_key
```

---

## Moderator and Admin Endpoints

These are not needed in the standard mobile app flow, but document them here for completeness.

### Coin management (admin only)

```
POST /v1/me/:userId/coins/:entryId/void
{ "reason": "string" }

POST /v1/me/:userId/coins/adjust
{ "amount": -50, "reason": "string" }    // positive or negative integer
```

### Cleanify moderation (moderator+)

```
POST /v1/cleanify/submissions/:id/approve
{ "note": "optional" }

POST /v1/cleanify/submissions/:id/reject
{ "note": "required" }
```

### KYC moderation (admin only)

```
POST /v1/verification/admin/review
{ "session_id": "...", "decision": "approved", "note": "optional" }
```

---

## Recommended App Startup Sequence

```
1. Check for stored access_token + refresh_token
2. If no tokens -> show login/signup screen
3. If tokens exist -> silently call POST /v1/auth/refresh
   a. On success -> store new tokens, proceed
   b. On failure -> clear tokens, show login screen
4. Call GET /v1/me to hydrate user state
5. If verification_status != "verified" -> route to verification flow
6. If neighborhood is null -> route to neighborhood selection
7. Otherwise -> show main app
```

---

## Environment Notes

- All timestamps are **ISO 8601 UTC** strings (e.g. `2025-06-15T09:00:00.000Z`)
- All IDs are **UUIDs** (text)
- Amounts in coin ledger are **integers** (positive for credits, negative for debits)
- Phone numbers must be in **E.164 format** (e.g. `+213XXXXXXXXX`)
- Pagination cursors are **UUIDs** -- do not parse or construct them, treat as opaque strings
