# Wihda Backend - Cloudflare Workers API

A complete backend implementation for the Wihda neighborhood civic application using Cloudflare Workers, D1, R2, and Durable Objects.

## Architecture Overview

This backend implements the full MVP specification with the following Cloudflare services:

| Component          | Cloudflare Service     | Purpose                              |
| ------------------ | ---------------------- | ------------------------------------ |
| API Server         | Workers (TypeScript)   | REST API endpoints at `/v1/*`        |
| Database           | D1 (SQLite)            | All entities with UUID primary keys  |
| Object Storage     | R2                     | User photos, chat images             |
| Background Jobs    | Queues + Cron Triggers | Matching, ingestion, notifications   |
| Real-time Chat     | Durable Objects        | WebSocket sessions, message ordering |
| Rate Limiting      | KV                     | Simple counters, flags               |
| Push Notifications | FCM                    | Via HTTP API from Workers            |

## Project Structure

```
.
├── migrations/
│   ├── schema.sql                      # Base database schema
│   ├── 0002_cleanify_multi_step.sql    # Cleanify multi-step submission tables
│   ├── 0003_kyc_verification.sql       # KYC verification tables
│   ├── 0004_contact_submissions.sql    # Public contact form submissions
│   └── seed.sql                        # Initial seed data
├── scripts/
│   └── test-api.sh                     # Manual API smoke tests
├── src/
│   ├── index.ts                        # Main entry point, route mounting
│   ├── types/
│   │   └── index.ts                    # Shared TypeScript type definitions
│   ├── lib/
│   │   ├── utils.ts                    # JWT, crypto, validation helpers
│   │   ├── db.ts                       # Database query functions
│   │   ├── rate-limit.ts               # KV-based rate limiting helpers
│   │   └── upload-token.ts             # Presigned upload token helpers
│   ├── middleware/
│   │   └── auth.ts                     # authMiddleware, requireVerified, requireModerator, requireAdmin, requireNeighborhood
│   ├── routes/
│   │   ├── auth.ts                     # /v1/auth/*
│   │   ├── verification.ts             # /v1/verification/*
│   │   ├── user.ts                     # /v1/me, /v1/me/:userId
│   │   ├── neighborhood.ts             # /v1/neighborhoods/*
│   │   ├── leftovers.ts                # /v1/leftovers/*
│   │   ├── chat.ts                     # /v1/chats/*
│   │   ├── cleanify.ts                 # /v1/cleanify/*
│   │   ├── campaigns.ts                # /v1/campaigns/*
│   │   ├── uploads.ts                  # /v1/uploads/*
│   │   └── contact.ts                  # /v1/contact
│   ├── queues/
│   │   ├── matching.ts                 # Match offer/need pairs
│   │   ├── campaign.ts                 # Campaign ingestion
│   │   ├── notification.ts             # FCM push notifications
│   │   ├── verification.ts             # Gemini Vision AI KYC document review
│   │   └── cleanify.ts                 # Gemini Vision AI cleanify photo review
│   └── durable-objects/
│       └── ChatThreadDurableObject.ts  # WebSocket chat sessions
├── tests/
│   ├── setup.ts
│   ├── helpers.ts
│   ├── fixtures/
│   │   ├── index.ts
│   │   └── types.ts
│   ├── integration/
│   │   └── app.test.ts
│   ├── routes/
│   │   ├── auth.test.ts
│   │   ├── cleanify.test.ts
│   │   ├── contact.test.ts
│   │   ├── leftovers.test.ts
│   │   └── verification.test.ts
│   ├── queues/
│   │   ├── campaign.test.ts
│   │   ├── cleanify.test.ts
│   │   ├── matching.test.ts
│   │   └── notification.test.ts
│   └── unit/
│       ├── auth-middleware.test.ts
│       ├── db.test.ts
│       ├── rate-limit.test.ts
│       └── utils.test.ts
├── wrangler.toml
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Middleware

All protected routes pass through the following middleware pipeline, defined in `src/middleware/auth.ts`:

| Middleware               | Description                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `authMiddleware`         | Validates the Bearer JWT and populates `c.var.auth`. Returns `401` if missing or invalid. Does not enforce verification status.                |
| `optionalAuthMiddleware` | Same as above but never fails - populates context only when a valid token is present.                                                          |
| `requireVerified`        | Blocks `verification_only` scoped tokens and users whose `verification_status` is not `verified`. Returns `403`. Chain after `authMiddleware`. |
| `requireModerator`       | Requires `moderator` or `admin` role. Returns `403`. Chain after `authMiddleware`.                                                             |
| `requireAdmin`           | Requires `admin` role. Returns `403`. Chain after `authMiddleware`.                                                                            |
| `requireNeighborhood`    | Requires the user to have a `neighborhood_id` in their token. Returns `400`. Chain after `authMiddleware`.                                     |

Rate limiting is handled via `src/lib/rate-limit.ts` using KV counters and applied at the route level.

> **Auth flow note:** On signup, a `restricted_token` with scope `verification_only` is issued. This token only grants access to `/v1/verification/*` endpoints. Full API access requires completing KYC and receiving a standard JWT.

## API Endpoints

### Authentication

- `POST /v1/auth/signup` - Create account. Returns `restricted_token` + `verification_session_id`. No full API access until KYC is complete.
- `POST /v1/auth/login` - Login (requires `verified` status).
- `POST /v1/auth/refresh` - Refresh access and refresh tokens.

### Identity Verification (KYC)

New users must complete this flow before any protected endpoint is accessible.

- `POST /v1/verification/start` - Open or reuse a verification session.
- `POST /v1/verification/presigned-url` - Get R2 upload URL for one document (`front`, `back`, `selfie`).
- `POST /v1/verification/submit` - Submit documents for Gemini Vision AI review (~1–2 min async).
- `GET /v1/verification/status` - Poll current verification status.
- `POST /v1/verification/webhook` - **Internal:** Called by queue consumer with AI result. Protected by `INTERNAL_WEBHOOK_SECRET`.
- `POST /v1/verification/admin/review` - Manual approve/reject override. **Admin only.**

### User

- `GET /v1/me` - Get own profile (neighborhood, coins, verification status).
- `PATCH /v1/me` - Update own profile.
- `GET /v1/me/coins` - Own coin balance and transaction ledger.
- `GET /v1/me/:userId` - Get another user's profile. Response is **role-scoped**:
  - **Regular users** receive basic public info (display name, neighborhood, join date).
  - **Moderators / Admins** receive extended info (verification status, coin balance, submission history, flags).

### Neighborhoods

- `GET /v1/neighborhoods/lookup` - Search by city or location.
- `GET /v1/neighborhoods/:id` - Get neighborhood details.
- `POST /v1/neighborhoods/join` - Join a neighborhood.
- `GET /v1/neighborhoods/:id/stats` - Neighborhood statistics.

### Leftovers

- `POST /v1/leftovers/offers` - Create a food offer.
- `GET /v1/leftovers/offers` - List active offers.
- `POST /v1/leftovers/needs` - Create a food need.
- `GET /v1/leftovers/needs` - List active needs.
- `GET /v1/leftovers/matches` - List the current user's matches.
- `POST /v1/leftovers/matches/:id/close` - Close a match.

### Chat

- `GET /v1/chats` - List chat threads for the current user.
- `GET /v1/chats/:thread_id` - Thread metadata.
- `GET /v1/chats/:thread_id/messages` - Paginated message history.
- `POST /v1/chats/:thread_id/messages` - Send a message.
- `GET /v1/chats/:thread_id/ws` - WebSocket endpoint (upgrades to Durable Object connection).

### Cleanify

- `POST /v1/cleanify/start` - Create a new submission draft. Returns `submission_id`.
- `POST /v1/cleanify/:id/before/presigned-url` - Get a presigned R2 upload URL for the **before** photo.
- `POST /v1/cleanify/:id/before/confirm` - Confirm before photo upload; opens the 20-minute time gate.
- `POST /v1/cleanify/:id/after/presigned-url` - Get a presigned R2 upload URL for the **after** photo. Enforces ≥20 min since before photo and ≤48 hr total window.
- `POST /v1/cleanify/:id/after/confirm` - Confirm after photo upload; triggers async AI photo verification via Gemini Vision. Sets status to `pending_review`.
- `GET /v1/cleanify/submissions` - List own submissions. Moderators may pass `?pending=true` to see the review queue.
- `GET /v1/cleanify/submissions/:id` - Get a single submission (owner or moderator).
- `POST /v1/cleanify/submissions/:id/approve` - Approve and award coins. **Moderator only.**
- `POST /v1/cleanify/submissions/:id/reject` - Reject with a required note. **Moderator only.**
- `GET /v1/cleanify/stats` - Submission statistics for the user's neighborhood and themselves.

Submissions are automatically reviewed by Gemini Vision AI, which checks that both photos show the same location with a visible improvement in cleanliness. Moderator `approve`/`reject` endpoints remain available as manual overrides for disputed or edge-case submissions.

### Contact

Public website forms - no authentication required. Rate limited to 5 submissions per IP per hour.

- `POST /v1/contact` - Submit a citizen or partner form. Payload is a discriminated union on `type`:
  - **`citizen`** - requires `name`, `email`, `topic` (`account | bug | feedback | other`), `message`
  - **`partner`** - requires `organization`, `contactPerson`, `email`, `proposal`

### Campaigns

- `GET /v1/campaigns` - List campaigns for the user's neighborhood.
- `GET /v1/campaigns/:id` - Get campaign details.

### Uploads

- `POST /v1/uploads/presigned-url` - Get a presigned R2 upload URL.
- `POST /v1/uploads/direct` - Direct upload (small files).
- `GET /v1/uploads/:key` - Serve a file from R2.
- `DELETE /v1/uploads/:key` - Delete a file.

### Notifications

- `GET /v1/notifications` - List notifications for the current user.
- `POST /v1/notifications/read` - Mark notifications as read.

### System

- `GET /health` - Health check.
- `GET /openapi.json` - OpenAPI spec.

## Development

### Prerequisites

- Node.js 18+
- Wrangler CLI: `npm install -g wrangler`
- Cloudflare account

### Setup

```bash
npm install
```

### Local Development

```bash
# Start local development server
npm run dev

# Run database migrations locally
npm run db:migrate

# Seed test data
npm run db:seed
```

### Testing

```bash
npm test
```

Tests live in `tests/` and use [Vitest](https://vitest.dev/) with Cloudflare Workers test helpers. The suite covers unit tests, route-level integration tests, and queue consumer tests.

### Deployment

```bash
# Deploy to staging
npm run deploy:staging

# Deploy to production
npm run deploy:production

# Run migrations on remote D1
npm run db:migrate:remote
```

### Initial Cloudflare Resource Setup

```bash
# D1 database
wrangler d1 create wihda-db

# KV namespace
wrangler kv:namespace create KV

# R2 bucket
wrangler r2 bucket create wihda-uploads

# Queues
wrangler queues create wihda-matching-queue
wrangler queues create wihda-campaign-queue
wrangler queues create wihda-notification-queue
wrangler queues create wihda-verification-queue
wrangler queues create wihda-verification-dlq
wrangler queues create wihda-cleanify-queue
```

After creating resources, update `wrangler.toml` with the generated IDs.

### Secrets

```bash
wrangler secret put JWT_SECRET
wrangler secret put FCM_SERVER_KEY
wrangler secret put GEMINI_API_KEY
wrangler secret put INTERNAL_WEBHOOK_SECRET
```

## Environment Variables

| Variable                  | Description                                                                    |
| ------------------------- | ------------------------------------------------------------------------------ |
| `ENVIRONMENT`             | `development` / `staging` / `production`                                       |
| `JWT_SECRET`              | Secret used for JWT signing and verification                                   |
| `FCM_SERVER_KEY`          | Firebase Cloud Messaging server key                                            |
| `GEMINI_API_KEY`          | Google Gemini API key (used for KYC document review)                           |
| `INTERNAL_WEBHOOK_SECRET` | Shared secret between the verification queue consumer and the webhook endpoint |

## Key Design Notes

### Idempotency

Coin awards use a unique constraint on `(source_type, source_id, user_id)`. Match closures are idempotent via status checks. This prevents duplicate rewards across retries or race conditions.

### Matching Algorithm

Offer/need pairs are scored based on food type, dietary constraints, portions, pickup time availability, and proximity. Pairs below a score of `0.4` are discarded. Matching is event-driven via the `wihda-matching-queue` and a scheduled cron trigger.

### Real-time Chat

Each chat thread has a dedicated Durable Object instance. Clients connect via WebSocket. Messages are persisted to D1 and broadcast to all connected sessions. Read receipts are tracked per-user per-thread.

### Anti-abuse

Rate limiting is enforced via KV counters at the route level. Pair repetition is tracked to prevent gaming the matching system. All moderation actions (approve/reject) are written to an audit log.

## Monitoring

```bash
# Tail live logs
npm run tail
```

## License

MIT
