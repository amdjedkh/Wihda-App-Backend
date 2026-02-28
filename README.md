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
backend/
├── src/
│   ├── index.ts              # Main entry point, route mounting
│   ├── types/                # TypeScript type definitions
│   │   └── index.ts
│   ├── lib/                  # Utility functions
│   │   ├── utils.ts          # JWT, crypto, validation helpers
│   │   └── db.ts             # Database query functions
│   ├── middleware/           # Hono middleware
│   │   └── auth.ts           # JWT validation, role checks
│   ├── routes/               # API route handlers
│   │   ├── auth.ts           # /v1/auth/*
│   │   ├── verification.ts   # /v1/verification/*
│   │   ├── user.ts           # /v1/me
│   │   ├── neighborhood.ts   # /v1/neighborhoods/*
│   │   ├── leftovers.ts      # /v1/leftovers/*
│   │   ├── chat.ts           # /v1/chats/*
│   │   ├── cleanify.ts       # /v1/cleanify/*
│   │   ├── campaigns.ts      # /v1/campaigns/*
│   │   └── uploads.ts        # /v1/uploads/*
│   ├── queues/               # Queue consumers
│   │   ├── matching.ts       # Match offer/need pairs
│   │   ├── campaign.ts       # Campaign ingestion
│   │   ├── notification.ts   # FCM push notifications
│   │   └── verification.ts   # Gemini Vision AI document review
│   └── durable-objects/
│       └── ChatThreadDurableObject.ts  # WebSocket chat
├── migrations/
│   ├── schema.sql            # Database schema
│   ├── 0003_kyc_verification.sql  # KYC verification tables
│   └── seed.sql              # Initial seed data
├── wrangler.toml             # Cloudflare Workers config
├── package.json
└── tsconfig.json
```

## API Endpoints

### Authentication

- `POST /v1/auth/signup` - Create account — returns `restricted_token` + `verification_session_id` (no full access until KYC complete)
- `POST /v1/auth/login` - Login (requires `verified` status)
- `POST /v1/auth/refresh` - Refresh tokens
- `GET /v1/auth/me` - Get current user

### Identity Verification (KYC)

New users must complete this flow before any protected endpoint is accessible.

- `POST /v1/verification/start` - Open or reuse a verification session
- `POST /v1/verification/presigned-url` - Get R2 upload URL for one document (`front`, `back`, `selfie`)
- `POST /v1/verification/submit` - Submit documents for Gemini Vision AI review (~1–2 min)
- `GET /v1/verification/status` - Poll current verification status
- `POST /v1/verification/webhook` - Internal: called by queue consumer with AI result (protected by `INTERNAL_WEBHOOK_SECRET`)
- `POST /v1/verification/admin/review` - Manual approve/reject override (admin only)

### User

- `GET /v1/me` - Get profile with neighborhood & coins
- `PATCH /v1/me` - Update profile
- `GET /v1/me/coins` - Coin balance & ledger

### Neighborhoods

- `GET /v1/neighborhoods/lookup` - Search by city/location
- `GET /v1/neighborhoods/:id` - Get details
- `POST /v1/neighborhoods/join` - Join neighborhood
- `GET /v1/neighborhoods/:id/stats` - Statistics

### Leftovers

- `POST /v1/leftovers/offers` - Create offer
- `GET /v1/leftovers/offers` - List offers
- `POST /v1/leftovers/needs` - Create need
- `GET /v1/leftovers/needs` - List needs
- `GET /v1/leftovers/matches` - User's matches
- `POST /v1/leftovers/matches/:id/close` - Close match

### Chat

- `GET /v1/chats` - List threads
- `GET /v1/chats/:thread_id` - Thread metadata
- `GET /v1/chats/:thread_id/messages` - Paginated messages
- `POST /v1/chats/:thread_id/messages` - Send message
- `GET /v1/chats/:thread_id/ws` - WebSocket endpoint

### Cleanify

- `POST /v1/cleanify/start` - Create a new submission draft (returns `submission_id`)
- `POST /v1/cleanify/:id/before/presigned-url` - Get a presigned R2 upload URL for the before photo
- `POST /v1/cleanify/:id/before/confirm` - Confirm before photo upload; opens the 20-minute gate
- `POST /v1/cleanify/:id/after/presigned-url` - Get a presigned R2 upload URL for the after photo (enforces ≥20 min since before, ≤48 hr window)
- `POST /v1/cleanify/:id/after/confirm` - Confirm after photo upload; sets status to `pending_review`
- `GET /v1/cleanify/submissions` - List own submissions, or `?pending=true` for moderators to see the review queue
- `GET /v1/cleanify/submissions/:id` - Get a single submission (owner or moderator)
- `POST /v1/cleanify/submissions/:id/approve` - Approve submission and award coins (moderator only)
- `POST /v1/cleanify/submissions/:id/reject` - Reject submission with a required note (moderator only)
- `GET /v1/cleanify/stats` - Submission statistics for a neighborhood and the current user

### Campaigns

- `GET /v1/campaigns` - List for neighborhood
- `GET /v1/campaigns/:id` - Get details

### Uploads

- `POST /v1/uploads/presigned-url` - Get upload URL
- `POST /v1/uploads/direct` - Direct upload
- `GET /v1/uploads/:key` - Serve file
- `DELETE /v1/uploads/:key` - Delete file

### Notifications

- `GET /v1/notifications` - List notifications
- `POST /v1/notifications/read` - Mark as read

## Development

### Prerequisites

- Node.js 18+
- Wrangler CLI: `npm install -g wrangler`
- Cloudflare account

### Setup

```bash
cd backend
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

### Deployment

```bash
# Deploy to staging
npm run deploy:staging

# Deploy to production
npm run deploy:production

# Run migrations on remote
npm run db:migrate:remote
```

### Configuration

1. Create D1 database:

```bash
wrangler d1 create wihda-db
```

2. Create KV namespace:

```bash
wrangler kv:namespace create KV
```

3. Create R2 bucket:

```bash
wrangler r2 bucket create wihda-uploads
```

4. Create queues:

```bash
wrangler queues create wihda-matching-queue
wrangler queues create wihda-campaign-queue
wrangler queues create wihda-notification-queue
wrangler queues create wihda-verification-queue
wrangler queues create wihda-verification-dlq
```

5. Update `wrangler.toml` with actual IDs

6. Set secrets:

```bash
wrangler secret put JWT_SECRET
wrangler secret put FCM_SERVER_KEY
wrangler secret put GEMINI_API_KEY
wrangler secret put INTERNAL_WEBHOOK_SECRET
```

## Key Features

### Idempotency

- Coin awards use unique constraint on `(source_type, source_id, user_id)`
- Match closures are idempotent via status checks
- Prevents duplicate rewards

### Matching Algorithm

- Scoring based on: food type, diet constraints, portions, pickup time, distance
- Minimum threshold: 0.4 score
- Event-driven via Queue + scheduled matching

### Real-time Chat

- Durable Object per thread
- WebSocket connections
- Message persistence in D1
- Read receipts

### Anti-abuse

- Rate limits via KV
- Pair repetition tracking
- Moderator oversight
- Audit logs

## Environment Variables

| Variable                | Description                                      |
| ----------------------- | ------------------------------------------------ |
| ENVIRONMENT             | `development` / `staging` / `production`         |
| JWT_SECRET              | Secret for JWT signing                           |
| FCM_SERVER_KEY          | Firebase Cloud Messaging server key              |
| GEMINI_API_KEY          | Google Gemini API key (for KYC document review)  |
| INTERNAL_WEBHOOK_SECRET | Shared secret between queue consumer and webhook |

## Monitoring

- Health endpoint: `GET /health`
- OpenAPI spec: `GET /openapi.json`
- View logs: `npm run tail`

## Testing

```bash
npm test
```

## License

MIT
