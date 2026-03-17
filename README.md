# Wihda — Backend API

A fully serverless REST API for the Wihda neighborhood community app, built on Cloudflare's developer platform.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers (TypeScript) |
| Framework | Hono.js v4 |
| Database | Cloudflare D1 (SQLite) |
| File Storage | Cloudflare R2 |
| Cache / Rate Limiting | Cloudflare KV |
| Background Jobs | Cloudflare Queues + Cron Triggers |
| Real-time Chat | Cloudflare Durable Objects (WebSocket) |
| Email OTP | Resend |
| SMS OTP | Twilio |
| AI Review (KYC + Cleanify) | Google Gemini Vision |
| Campaign Scraping | Jina AI Reader + Gemini |
| Push Notifications | Firebase Cloud Messaging (FCM) |

---

## Architecture Overview

```
┌──────────────────────────────────────────────┐
│              Cloudflare Workers              │
│  ┌─────────────────────────────────────────┐ │
│  │           Hono.js Router                │ │
│  │  /v1/auth   /v1/me   /v1/leftovers ...  │ │
│  └────────────────────┬────────────────────┘ │
│                       │                      │
│   ┌───────────────────┼───────────────────┐  │
│   │        │          │          │        │  │
│  D1      R2          KV       Queues     DO  │
│ (DB)  (Files)  (Rate limit)  (Jobs)  (Chat)  │
└──────────────────────────────────────────────┘
```

| Service | Purpose |
|---|---|
| **D1** | All persistent data (users, posts, matches, coins, badges, store) |
| **R2** | Profile photos, KYC documents, Cleanify before/after images |
| **KV** | Rate limiting counters, short-lived flags |
| **Queues** | Async AI reviews, matching, notifications, campaign ingestion |
| **Durable Objects** | WebSocket sessions per chat thread |

---

## Features

- **Authentication** — Signup, login, JWT refresh, Google OAuth 2.0
- **Contact Verification** — Email and SMS OTP with rate limiting and lockout
- **Identity Verification (KYC)** — Document upload (ID front/back + selfie) with async Gemini AI review
- **Neighborhoods** — Create, join, and look up geographic neighborhoods
- **Leftovers** — Create food offers and needs; auto-matching; favorites; exchange confirmation
- **Chat** — Per-thread Durable Objects with WebSocket and REST message history
- **Clean & Earn** — Before/after photo submissions with Gemini AI verification and coin rewards
- **Campaigns** — Auto-ingested community events via Jina + Gemini cron job (every 12h)
- **Coins Ledger** — Append-only idempotent coin ledger with admin void/adjust
- **Badges** — Progress-based badge system (food_saver, active_member, etc.)
- **Rewards Store** — Purchasable items redeemed with coins
- **Notifications** — Per-user activity alerts
- **Profile** — Photo upload to R2, display name, neighborhood, public/private fields

---

## Project Structure

```
.
├── migrations/
│   ├── 0001_schema.sql                # Base schema — all core tables
│   ├── 0002_cleanify_multi_step.sql   # Cleanify multi-step submission tables
│   ├── 0003_kyc_verification.sql      # KYC verification sessions + user backfill
│   ├── 0004_contact_submissions.sql   # Public contact form table
│   ├── 0005_contact_verification.sql  # OTP verification table
│   ├── 0006_neighborhood_creation.sql # Neighborhood creation flow
│   ├── 0007_profile_photo.sql         # photo_url column on users
│   ├── 0008_badges.sql                # badges + user_badges tables, seed data
│   ├── 0009_google_oauth.sql          # google_id column + unique index on users
│   ├── 0010_store.sql                 # store_items + store_redemptions tables
│   ├── 0011_favorites.sql             # user_favorites table
│   ├── 0012_exchange_confirm.sql      # close_requested_by/at on matches
│   └── seed.sql                       # Initial seed data
├── src/
│   ├── index.ts                       # Entry point, route mounting, queue/cron handlers
│   ├── types/
│   │   └── index.ts                   # Shared TypeScript interfaces (User, Env, etc.)
│   ├── lib/
│   │   ├── db.ts                      # All database query functions
│   │   ├── utils.ts                   # JWT, crypto, UUID, validation helpers
│   │   ├── rate-limit.ts              # KV-based rate limiting helpers
│   │   └── upload-token.ts            # R2 presigned upload token helpers
│   ├── middleware/
│   │   └── auth.ts                    # authMiddleware, requireNeighborhood, requireModerator, requireAdmin
│   ├── routes/
│   │   ├── auth.ts                    # /v1/auth/* (login, signup, refresh, Google OAuth)
│   │   ├── contact-verification.ts    # /v1/auth/verify/* (OTP send + confirm)
│   │   ├── verification.ts            # /v1/verification/* (KYC flow)
│   │   ├── user.ts                    # /v1/me (profile, photo, coins, badges)
│   │   ├── neighborhood.ts            # /v1/neighborhoods/*
│   │   ├── leftovers.ts               # /v1/leftovers/* (offers, needs, matches, favorites)
│   │   ├── chat.ts                    # /v1/chats/* (threads, messages, WebSocket)
│   │   ├── cleanify.ts                # /v1/cleanify/* (submissions, presigned URLs, AI review)
│   │   ├── store.ts                   # /v1/store (list items, redeem)
│   │   ├── campaigns.ts               # /v1/campaigns/*
│   │   ├── notifications.ts           # /v1/notifications/*
│   │   ├── uploads.ts                 # /v1/uploads/*
│   │   └── contact.ts                 # /v1/contact (public contact form)
│   ├── queues/
│   │   ├── matching.ts                # Offer/need matching algorithm
│   │   ├── campaign.ts                # Campaign ingestion via Jina + Gemini
│   │   ├── notification.ts            # FCM push notification dispatch
│   │   ├── verification.ts            # Gemini Vision KYC document review
│   │   └── cleanify.ts                # Gemini Vision cleanify photo review
│   └── durable-objects/
│       └── ChatThreadDurableObject.ts # WebSocket sessions + message ordering
├── tests/                             # Vitest unit + integration tests
├── wrangler.toml                      # Cloudflare Workers configuration
├── package.json
└── tsconfig.json
```

---

## API Reference

### Authentication — `/v1/auth`

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/auth/signup` | Create account. Returns `access_token` + `refresh_token`. |
| `POST` | `/v1/auth/login` | Login with email/password. Returns tokens. |
| `POST` | `/v1/auth/refresh` | Refresh access token using refresh token. |
| `GET` | `/v1/auth/google` | Redirect to Google OAuth consent screen. |
| `POST` | `/v1/auth/google/callback` | Exchange OAuth code for tokens. |

### Contact Verification (OTP) — `/v1/auth/verify`

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/auth/verify/email/send` | Send 6-digit OTP to registered email via Resend. |
| `POST` | `/v1/auth/verify/email/confirm` | Confirm email OTP. |
| `POST` | `/v1/auth/verify/phone/send` | Send 6-digit OTP via Twilio SMS. |
| `POST` | `/v1/auth/verify/phone/confirm` | Confirm phone OTP. |
| `GET` | `/v1/auth/verify/status` | Current contact verification state. |

> Rate limited: 3 sends/hour per channel. 5 wrong guesses triggers a 60-minute lockout.

### Identity Verification (KYC) — `/v1/verification`

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/verification/start` | Open or reuse a KYC session. |
| `POST` | `/v1/verification/presigned-url` | Get R2 upload URL for `front`, `back`, or `selfie`. |
| `POST` | `/v1/verification/submit` | Submit documents for async Gemini AI review. |
| `GET` | `/v1/verification/status` | Poll current verification status. |
| `POST` | `/v1/verification/admin/review` | Manual approve/reject override. **Admin only.** |

### User — `/v1/me`

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/me` | Own profile (name, photo, neighborhood, coins, verification status). |
| `PATCH` | `/v1/me` | Update display name, language preference, FCM token. |
| `POST` | `/v1/me/photo` | Upload profile photo directly (multipart). |
| `GET` | `/v1/me/coins` | Coin balance + paginated ledger. |
| `GET` | `/v1/me/badges` | All badges with progress calculated from real activity. |
| `GET` | `/v1/users/:id` | Another user's public profile. |

### Neighborhoods — `/v1/neighborhoods`

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/neighborhoods/lookup` | Search by city or coordinates. |
| `GET` | `/v1/neighborhoods/:id` | Neighborhood details and stats. |
| `POST` | `/v1/neighborhoods/join` | Join a neighborhood. |
| `POST` | `/v1/neighborhoods` | Create a new neighborhood. |

### Leftovers — `/v1/leftovers`

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/leftovers/offers` | Create a food offer. |
| `GET` | `/v1/leftovers/offers` | List active offers (global or by neighborhood). |
| `GET` | `/v1/leftovers/offers/:id` | Get a single offer. |
| `POST` | `/v1/leftovers/needs` | Create a food need/request. |
| `GET` | `/v1/leftovers/needs` | List active needs. |
| `GET` | `/v1/leftovers/matches` | List current user's matches. |
| `POST` | `/v1/leftovers/matches/:id/request-close` | Request exchange confirmation (two-step). |
| `POST` | `/v1/leftovers/matches/:id/close` | Confirm exchange completion + award coins. |
| `POST` | `/v1/leftovers/offers/:id/favorite` | Toggle favorite on an offer. |
| `GET` | `/v1/leftovers/favorites` | List user's favorited offers. |

### Chat — `/v1/chats`

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/chats` | List chat threads for current user. |
| `GET` | `/v1/chats/:thread_id` | Thread metadata and match info. |
| `GET` | `/v1/chats/:thread_id/messages` | Paginated message history. |
| `POST` | `/v1/chats/:thread_id/messages` | Send a message. |
| `GET` | `/v1/chats/:thread_id/ws` | Upgrade to WebSocket (Durable Object). |

### Clean & Earn — `/v1/cleanify`

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/cleanify/start` | Create a new submission draft. |
| `POST` | `/v1/cleanify/:id/before/presigned-url` | Get R2 upload URL for before photo. |
| `POST` | `/v1/cleanify/:id/before/confirm` | Confirm before photo; starts 20-min timer. |
| `POST` | `/v1/cleanify/:id/after/presigned-url` | Get R2 upload URL for after photo (≥20 min after before). |
| `POST` | `/v1/cleanify/:id/after/confirm` | Confirm after photo; triggers Gemini AI review. |
| `GET` | `/v1/cleanify/submissions` | List own submissions. |
| `GET` | `/v1/cleanify/submissions/:id` | Get a single submission. |
| `POST` | `/v1/cleanify/submissions/:id/approve` | Approve + award coins. **Moderator only.** |
| `POST` | `/v1/cleanify/submissions/:id/reject` | Reject with note. **Moderator only.** |

### Rewards Store — `/v1/store`

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/store` | List store items with coin balance and redemption status. |
| `POST` | `/v1/store/:id/redeem` | Redeem an item (deducts coins via ledger entry). |

### Campaigns — `/v1/campaigns`

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/campaigns` | List campaigns for the user's neighborhood. |
| `GET` | `/v1/campaigns/:id` | Get campaign details. |

> Auto-populated every 12 hours via cron: Jina scrapes community event sources, Gemini extracts structured data.

### Notifications — `/v1/notifications`

| Method | Path | Description |
|---|---|---|
| `GET` | `/v1/notifications` | List notifications for current user. |
| `POST` | `/v1/notifications/read` | Mark notifications as read. |

### System

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check. |

---

## Local Development

### Prerequisites

- Node.js 18+
- Wrangler CLI: `npm install -g wrangler`
- Cloudflare account

### Install & Run

```bash
npm install
npm run dev
```

Server runs at `http://localhost:8787`.

### Environment Variables (local)

Create a `.dev.vars` file in the project root — **never commit this file**:

```
JWT_SECRET=any-random-secret-for-local-dev
GEMINI_API_KEY=your-gemini-key
INTERNAL_WEBHOOK_SECRET=any-random-secret
RESEND_API_KEY=re_xxxxxxxxxxxx
RESEND_FROM_EMAIL=Wihda <onboarding@resend.dev>
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_PHONE_NUMBER=+1XXXXXXXXXX
FCM_SERVER_KEY=your-fcm-key
JINA_API_KEY=your-jina-key
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
FRONTEND_URL=http://localhost:5173
```

> **Dev mode:** If `RESEND_API_KEY` or Twilio credentials are missing, OTPs are printed to the console instead of being sent. No external API calls are made.

### Database

```bash
# Apply all migrations locally
npm run db:migrate

# Seed test data
npm run db:seed
```

---

## Production Deployment

### 1. Create Cloudflare Resources

```bash
npx wrangler login

npx wrangler d1 create wihda-db
npx wrangler kv namespace create KV
npx wrangler r2 bucket create wihda-uploads

npx wrangler queues create wihda-matching-queue
npx wrangler queues create wihda-campaign-queue
npx wrangler queues create wihda-notification-queue
npx wrangler queues create wihda-verification-queue
npx wrangler queues create wihda-verification-dlq
npx wrangler queues create wihda-cleanify-queue
```

Copy the returned IDs into `wrangler.toml`.

### 2. Set Secrets

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put INTERNAL_WEBHOOK_SECRET
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put FCM_SERVER_KEY
npx wrangler secret put JINA_API_KEY
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_PHONE_NUMBER
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

### 3. Run Remote Migrations

```bash
npx wrangler d1 migrations apply wihda-db --remote
```

### 4. Deploy

```bash
npm run deploy:production
```

The API will be live at `https://wihda-backend-prod.YOUR_SUBDOMAIN.workers.dev`.

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | ✅ | Secret for signing/verifying JWTs. Must never change after deployment. |
| `GEMINI_API_KEY` | ✅ | Google Gemini API key. Used for KYC document review and Cleanify photo verification. |
| `INTERNAL_WEBHOOK_SECRET` | ✅ | Shared secret between queue consumers and the internal webhook endpoint. |
| `RESEND_API_KEY` | ✅ | Resend API key for email OTP delivery. |
| `RESEND_FROM_EMAIL` | ✅ | Sender address (e.g. `Wihda <noreply@wihdaapp.com>`). |
| `TWILIO_ACCOUNT_SID` | ✅ | Twilio Account SID for SMS OTP. |
| `TWILIO_AUTH_TOKEN` | ✅ | Twilio Auth Token. |
| `TWILIO_PHONE_NUMBER` | ✅ | Twilio sender number in E.164 format (e.g. `+12015551234`). |
| `FCM_SERVER_KEY` | ✅ | Firebase Cloud Messaging server key for push notifications. |
| `JINA_API_KEY` | ✅ | Jina AI Reader API key for campaign web scraping. |
| `GOOGLE_CLIENT_ID` | Optional | Google OAuth app client ID (required for Google login). |
| `GOOGLE_CLIENT_SECRET` | Optional | Google OAuth app client secret. |
| `FRONTEND_URL` | Optional | Frontend origin for OAuth redirects (e.g. `https://app.wihdaapp.com`). |
| `ENVIRONMENT` | Auto | Set to `development`, `staging`, or `production` via `wrangler.toml`. |

---

## Key Design Notes

### Coins Ledger

Coins use an append-only ledger (`coin_ledger_entries`) with a `UNIQUE(source_type, source_id, user_id)` constraint. This makes all coin awards idempotent — retrying an award never double-credits a user. Store redemptions are recorded as negative entries.

### Exchange Confirmation (Two-Step)

When a user requests to close a match, `close_requested_by` and `close_requested_at` are set on the match row. The second party confirming within 5 minutes completes the exchange and triggers coin awards. After 5 minutes the first request expires and must be re-initiated.

### Matching Algorithm

Offer/need pairs are scored on food type compatibility, dietary constraints, portions requested vs. available, pickup time overlap, and geographic proximity. Pairs scoring below `0.4` are discarded. Matching runs event-driven via queue on new offer/need creation, and on a scheduled cron.

### Real-time Chat

Each chat thread has a dedicated Durable Object instance. Clients connect via WebSocket for real-time messaging. Messages are persisted to D1 and broadcast to all connected sessions. The REST endpoints (`GET /messages`, `POST /messages`) are available as a polling fallback.

### OTP Security

6-digit codes are generated with `crypto.getRandomValues`. The plaintext code is never stored — only its SHA-256 hash is written to the DB. Codes expire after 10 minutes. After 5 consecutive wrong guesses the record is locked for 60 minutes.

### AI Review Pipeline

Both KYC and Cleanify use the same async pattern:
1. Frontend uploads files directly to R2 via presigned URL
2. Backend enqueues a review job
3. Queue consumer calls Gemini Vision with the R2 object URLs
4. Result is written back via internal webhook
5. Frontend polls `/status` until complete

---

## Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start local dev server with Wrangler |
| `npm run build` | TypeScript compile check |
| `npm run deploy:production` | Deploy to production environment |
| `npm run deploy:staging` | Deploy to staging environment |
| `npm run db:migrate` | Apply migrations to local D1 |
| `npm run db:migrate:remote` | Apply migrations to remote D1 |
| `npm run db:seed` | Seed local DB with test data |
| `npm run tail` | Tail live production logs |
| `npm test` | Run Vitest test suite |

---

## License

MIT
