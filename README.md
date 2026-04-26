# Konnect

A production-ready real-time chat platform built on a microservices architecture, featuring AI-powered content moderation, OAuth 2.0 social login, end-to-end JWT authentication, and a Next.js frontend — all orchestrated via Docker Compose with Traefik as the API gateway.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
  - [System Overview](#system-overview)
  - [ML Pipeline](#ml-pipeline)
  - [Dampening Logic](#dampening-logic)
- [Services](#services)
- [Tech Stack](#tech-stack)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
- [Security](#security)

---

## Overview

Konnect provides:

- **Real-time messaging** — 1:1 and group chat over WebSocket (Socket.IO)
- **AI content moderation** — dual-model ML pipeline (RoBERTa + Toxic-BERT) with sliding-window group analysis
- **Secure auth** — JWT dual-token (RS256), OTP email verification, Google & GitHub OAuth 2.0
- **Scalable infrastructure** — Kafka message streaming, Redis pub/sub, RabbitMQ email queue, MongoDB persistence

---

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Next.js Frontend UI                          │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │   Traefik v3.0      │  Reverse Proxy
                    │  /auth  /api  /ws   │  Port 80 / 443
                    └──┬──────┬──────┬───┘
                       │      │      │
          ┌────────────▼─┐ ┌──▼────┐ ┌▼──────────────────┐
          │  Auth Service │ │ Chat  │ │  WebSocket Gateway │
          │  Node.js 3002 │ │Service│ │  Socket.IO   3004  │
          │  JWT·OAuth·OTP│ │ 3003  │ └────────┬───────────┘
          └──────┬────────┘ └──┬────┘          │
                 │             │           Socket.IO
          ┌──────▼──┐   ┌──────▼──┐            │
          │ MongoDB │   │ MongoDB │         Clients
          └─────────┘   └─────────┘
                 │             │
          ┌──────▼─────────────▼──────────────────────────────┐
          │                Redis (Upstash)                      │
          │  OTP cache · Refresh tokens · Pub/Sub · Presence   │
          └─────────────────────────────────────────────────────┘
                 │
          ┌──────▼──────┐        ┌────────────────────────┐
          │  RabbitMQ   │───────▶│    Email Service        │
          │  email_queue│        │  Node.js · Resend API  │
          └─────────────┘        └────────────────────────┘

          ┌─────────────────────────────────────────────────────┐
          │               Apache Kafka (KRaft)                  │
          │   chat_messages ──────────────▶ sentiment_results   │
          └────────────────┬────────────────────────────────────┘
                           │
                  ┌────────▼─────────┐
                  │ Sentiment Service │
                  │ Python · Flask   │
                  │ RoBERTa + BERT   │
                  └──────────────────┘
```

### ML Pipeline

Each message published to the `chat_messages` Kafka topic is processed in parallel by two models:

```
Kafka (chat_messages)
        │
        ▼
  Parse Message
  content · conv_id · sender_id · msg_id
        │
   ┌────┴──────────────┐
   │                   │
   ▼                   ▼
RoBERTa             Toxic-BERT
twitter-roberta     unitary/toxic-bert
125M params         110M params
→ POS / NEU / NEG   → toxicity score t ∈ [0..1]
  + confidence
   │                   │
   └────────┬──────────┘
            ▼
      t_raw ≥ 0.95?
      ┌──────┴──────┐
     YES            NO
      │              │
      ▼              ▼
  Immediate      Dampening Layer
  Flag           Pronoun-target + Venting detection
  flagged:true        │
      │               ▼
      │     Redis Sliding Window Aggregation
      │           last 50 messages
      └───────────────┤
                      ▼
              Kafka (sentiment_results)
```

### Dampening Logic

The dampening layer prevents over-flagging of venting, frustration, or self-directed expressions that score high on toxicity but are not targeted attacks:

```
Raw Toxicity Score (t_raw) from Toxic-BERT
               │
        t_raw ≥ 0.95?
        ┌──────┴──────┐
       YES            NO
        │              │
        ▼              ▼
   Human target?    Human target?
   you/your/he/she  you/your/he/she
   they/@mention    they/@mention
    ┌────┴────┐      ┌──────┴──────┐
   YES       NO    YES             NO
    │         │     │               │
    ▼         ▼     ▼               ▼
 Score     Venting  Score        Venting pattern?
UNCHANGED  pattern? UNCHANGED    hate/sick of/tired of
t = t×1.0  │        t = t×1.0   frustrated/ugh/worst
"You are   │                    ┌──────┴──────┐
 an idiot" │                   YES             NO
0.92→0.92  │                    │               │
           │                    ▼               ▼
           │              STRONG DAMPEN    MILD DAMPEN
           │              t = t_raw × 0.3  t = t_raw × 0.5
           │              "I hate Mondays" "Bad code quality"
           │              0.65 → 0.195     0.50 → 0.25
           │                    │               │
    Immediate FLAG              └───────┬───────┘
    Bypass                              ▼
    flagged:true              Sliding Window Aggregation
           │                           │
           └───────────────────────────┘
                                       ▼
                              Kafka (sentiment_results)
```

**Dampening multipliers:**

| Scenario | Multiplier | Example |
|---|---|---|
| Human-targeted, high confidence | ×1.0 (no change) | "You are an idiot" |
| Venting with no human target | ×0.3 (strong) | "I hate Mondays" |
| General frustration, no target | ×0.5 (mild) | "Bad code quality" |
| t_raw ≥ 0.95 any context | Bypass — immediate flag | — |

---

## Services

| Service | Language | Port | Responsibility |
|---|---|---|---|
| **Auth Service** | Node.js / Express | 3002 | Registration, login, JWT, OTP, OAuth 2.0 |
| **Chat Service** | Node.js / Express | 3003 | Messages, conversations, groups, invite links |
| **WebSocket Gateway** | Node.js / Socket.IO | 3004 | Real-time relay, presence, Redis pub/sub |
| **Email Service** | Node.js | — | RabbitMQ consumer, OTP delivery via Resend |
| **Sentiment Service** | Python / Flask | 5000 | Kafka consumer, ML inference, moderation aggregation |
| **Traefik** | — | 80 / 443 / 8080 | Reverse proxy, routing, TLS |

---

## Tech Stack

**Frontend**
- Next.js 14 (App Router)
- Tailwind CSS
- Socket.IO client

**Backend**
- Node.js + Express (Auth, Chat, WebSocket)
- Python + Flask (Sentiment)

**Messaging & Streaming**
- Apache Kafka (KRaft mode) — chat event streaming
- RabbitMQ — email job queue
- Redis (Upstash) — pub/sub, token store, sliding window

**Data**
- MongoDB (Atlas) — users, messages, conversations

**ML Models**
- [`cardiffnlp/twitter-roberta-base-sentiment-latest`](https://huggingface.co/cardiffnlp/twitter-roberta-base-sentiment-latest) — sentiment (POS/NEU/NEG)
- [`unitary/toxic-bert`](https://huggingface.co/unitary/toxic-bert) — toxicity score

**Infrastructure**
- Docker Compose
- Traefik v3.0

---

## Getting Started

### Prerequisites

- Docker + Docker Compose
- Node.js 18+ (for local dev without Docker)
- Python 3.10+ (sentiment service local dev)

### 1. Clone the repo

```bash
git clone https://github.com/AnkitSinha0/Konnect.git
cd Konnect
```

### 2. Configure environment variables

Each service has a `.env.example`. Copy and fill in credentials:

```bash
cp services/auth-service/.env.example        services/auth-service/.env
cp services/chat-service/.env.example        services/chat-service/.env
cp services/websocket-gateway/.env.example   services/websocket-gateway/.env
cp services/email-service/.env.example       services/email-service/.env
cp services/sentiment-service/.env.example   services/sentiment-service/.env
```

See [Environment Variables](#environment-variables) for all required values.

### 3. Start all services

```bash
docker compose up --build
```

| Endpoint | URL |
|---|---|
| Frontend | http://localhost:3000 |
| API Gateway | http://localhost |
| Auth | http://localhost/auth |
| Chat API | http://localhost/api |
| WebSocket | http://localhost/ws |
| Traefik Dashboard | http://localhost:8080 |
| Sentiment health | http://localhost:5000/health |

### 4. Run frontend locally (optional)

```bash
cd ../frontend
cp .env.example .env.local
npm install
npm run dev
```

---

## Environment Variables

### Auth Service (`services/auth-service/.env`)

```env
PORT=3002
NODE_ENV=development

MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/konnect

REDIS_URL=rediss://default:token@host.upstash.io:6379
REDIS_TOKEN=your_upstash_token

ACCESS_TOKEN_SECRET=your_access_token_secret
REFRESH_TOKEN_SECRET=your_refresh_token_secret
ACCESS_TOKEN_EXPIRY=15m
REFRESH_TOKEN_EXPIRY=7d

RABBITMQ_URL=amqps://user:pass@host.rmq.cloudamqp.com/vhost

GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3002/auth/google/callback

GITHUB_CLIENT_ID=your_github_client_id
GITHUB_CLIENT_SECRET=your_github_client_secret
GITHUB_REDIRECT_URI=http://localhost:3002/auth/github/callback

FRONTEND_URL=http://localhost:3000
```

### Email Service (`services/email-service/.env`)

```env
RABBITMQ_URL=amqps://user:pass@host.rmq.cloudamqp.com/vhost
RESEND_API_KEY=re_your_resend_api_key
EMAIL_FROM=Konnect <noreply@yourdomain.com>
```

### Chat Service (`services/chat-service/.env`)

```env
PORT=3003
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/konnect
REDIS_URL=rediss://default:token@host.upstash.io:6379
JWT_SECRET=your_jwt_secret
FRONTEND_URL=http://localhost:3000
KAFKA_BROKER=kafka:9092
KAFKA_TOPIC=chat_messages
```

### WebSocket Gateway (`services/websocket-gateway/.env`)

```env
PORT=3004
REDIS_URL=rediss://default:token@host.upstash.io:6379
JWT_SECRET=your_jwt_secret
FRONTEND_URL=http://localhost:3000
KAFKA_BROKER=kafka:9092
KAFKA_SENTIMENT_TOPIC=sentiment_results
```

### Sentiment Service (`services/sentiment-service/.env`)

```env
KAFKA_BROKER=kafka:9092
KAFKA_TOPIC=chat_messages
KAFKA_SENTIMENT_TOPIC=sentiment_results
REDIS_URL=rediss://default:token@host.upstash.io:6379
SLIDING_WINDOW_SIZE=50
PORT=5000
```

### Frontend (`frontend/.env.local`)

```env
NEXT_PUBLIC_API_URL=http://localhost
NEXT_PUBLIC_SOCKET_URL=http://localhost
NODE_ENV=development
```

---

## API Reference

### Auth (`/auth`)

| Method | Path | Description |
|---|---|---|
| `POST` | `/auth/register` | Register new user |
| `POST` | `/auth/login` | Login with email + password |
| `POST` | `/auth/verify-otp` | Verify OTP to receive tokens |
| `POST` | `/auth/refresh-token` | Rotate access token |
| `POST` | `/auth/logout` | Invalidate tokens |
| `GET` | `/auth/oauth/google` | Initiate Google OAuth flow |
| `GET` | `/auth/oauth/github` | Initiate GitHub OAuth flow |
| `GET` | `/auth/health` | Health check |

### Chat (`/api`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/conversations` | List user's conversations |
| `POST` | `/api/conversations` | Create new conversation |
| `GET` | `/api/conversations/:id/messages` | Fetch message history |
| `POST` | `/api/conversations/:id/messages` | Send a message |
| `POST` | `/api/groups` | Create group |
| `GET` | `/api/groups/:id/invite` | Get invite link |
| `POST` | `/api/join/:code` | Join group via invite |
| `GET` | `/api/health` | Health check |

### WebSocket Events (`/ws`)

| Event | Direction | Payload |
|---|---|---|
| `join_conversation` | Client → Server | `{ conversationId }` |
| `send_message` | Client → Server | `{ conversationId, content }` |
| `new_message` | Server → Client | Full message object |
| `sentiment_result` | Server → Client | `{ conversationId, flagged, toxicity, sentiment }` |
| `user_online` | Server → Client | `{ userId }` |
| `user_offline` | Server → Client | `{ userId }` |
| `group_locked` | Server → Client | `{ conversationId, reason }` |

### Sentiment Service

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Service health |
| `GET` | `/stats/:group_id` | Moderation stats for group |
| `POST` | `/unlock/:group_id` | Manually unlock a locked group |

---

## Security

- **JWT RS256** — access tokens (15 min) + refresh tokens (7 days, httpOnly cookie)
- **OTP** — all logins require email OTP verification
- **OAuth 2.0** — Google and GitHub social login with CSRF state parameter
- **Bcrypt** — passwords hashed at cost factor 12
- **Token rotation** — refresh tokens are single-use; rotated on every use
- **CORS** — locked to `FRONTEND_URL`
- **No secrets in code** — all credentials loaded via environment variables
- **Redis TTL** — OTP codes expire after 5 minutes, max 5 attempts

See [`SECURITY_CHECKLIST.md`](SECURITY_CHECKLIST.md) and [`OAUTH_SETUP.md`](OAUTH_SETUP.md) for detailed setup guides.

---

## Project Structure

```
Konnect/
├── docker-compose.yaml
├── traefik-config.yml
├── services/
│   ├── auth-service/          # Node.js · JWT · OAuth · OTP
│   ├── chat-service/          # Node.js · Messages · Groups
│   ├── websocket-gateway/     # Node.js · Socket.IO · Presence
│   ├── email-service/         # Node.js · RabbitMQ · Resend
│   └── sentiment-service/     # Python · Flask · RoBERTa · Toxic-BERT
└── shared/

frontend/                      # Next.js 14 App Router
├── app/
│   ├── login/
│   ├── register/
│   ├── verify-otp/
│   ├── chat/
│   ├── dashboard/
│   └── whatsapp/
├── components/
├── hooks/
└── lib/
```
