# Equity Lens

[![CI](https://github.com/NMalpani17/equity-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/NMalpani17/equity-lens/actions/workflows/ci.yml)

An AI-powered investment research platform for tracking an equity portfolio with
live market data.

<!-- Screenshot: replace with a real image, e.g. docs/screenshot.png -->

![Equity Lens dashboard](docs/screenshot.png)

**Live demo:** _coming soon_ <!-- replace with the deployed URL -->

## Features

- **User accounts** — email/password sign-up and login via **Supabase Auth**,
  with password reset (email link) and an account page showing your profile
  (email, member-since date) where you can change your password or delete your
  account (which removes all your data).
  The dashboard is behind a protected route, each user sees only their own
  holdings, and a **"Try demo"** button starts a per-visitor demo (anonymous
  sign-in) that the API auto-seeds with a sample portfolio.
- **Portfolio with lot grouping** — each purchase is its own lot; the dashboard
  groups lots by ticker into a position showing total shares, weighted-average
  cost, and combined market value, gain/loss, and today's change. Expand a
  position to see and edit individual lots (with an optional purchase date).
- **Live prices** — quotes from **Finnhub** (primary) with an automatic
  **yfinance** fallback on failure or rate limiting, plus a short-lived cache.
- **Invalid-ticker validation** — new tickers are verified against the market
  data service; unknown symbols are rejected with a clear message.
- **Earnings call search (RAG)** — hybrid (dense + keyword) search over the
  last four earnings call transcripts per ticker, reranked, with speaker and
  quarter citations. Ten large caps are pre-seeded; searching any other ticker
  indexes it in the background (capped per day to protect API quotas).
- **AI analyst chat** — ask about companies, earnings calls, markets or your
  portfolio and get a streamed answer with inline citations ([1], [2]) that open
  the exact transcript passage. A LangGraph agent (Gemini 3.8 Flash by default,
  swappable via config) uses read-only tools served by an MCP server: transcript
  search, quotes, price history, your portfolio, company/period resolution and
  exact position math. Guardrails keep it on topic, refuse prompt-injection and
  avoid personalized buy/sell advice; daily message caps protect the budget.
- **Graceful degradation** — one bad ticker never breaks the batch, unpriced
  holdings are excluded from totals (shown as partial), and the UI reports when
  the AI service is unavailable instead of failing.

## Architecture

```
Browser ──▶ client/ (React) ──▶ api/ (Express) ──▶ ai-service/ (FastAPI)
```

The **client** talks only to the **api**, which is the gateway: it persists
holdings (Supabase/Prisma) and orchestrates calls to the **ai-service**, which
owns market data, transcript ingestion and retrieval (and, in later phases, all
LLM logic).

## Tech stack

| Part          | Stack                                                                | Port   |
| ------------- | -------------------------------------------------------------------- | ------ |
| `client/`     | React 19, TypeScript, Vite, Tailwind CSS v4, shadcn/ui               | `5173` |
| `api/`        | Node.js, TypeScript, Express, Zod, Pino, Prisma (Supabase PG)        | `3001` |
| `ai-service/` | Python 3.12, FastAPI, LangGraph, FastMCP, Gemini, Pinecone, Equibles | `8000` |

## Quick start

**Prerequisites:** Node.js 20+, Python 3.12+, Git, a [Supabase](https://supabase.com)
project (PostgreSQL), and a free [Finnhub](https://finnhub.io/dashboard) API key.
Transcript search additionally needs free [Equibles](https://equibles.com),
[Gemini](https://aistudio.google.com/apikey) and [Pinecone](https://app.pinecone.io)
keys.

```bash
# 1. Env: copy the examples, then fill in the secrets (see below)
cp client/.env.example client/.env
cp api/.env.example api/.env
cp ai-service/.env.example ai-service/.env

# 2. Install
npm install                                   # repo root (Husky + concurrently)
cd ai-service && python -m venv .venv && .venv\Scripts\activate \
  && pip install -r requirements-dev.txt && deactivate && cd ..
npm --prefix api install                      # also runs `prisma generate`
npm --prefix api run prisma:migrate           # creates/updates tables (first run)
npm --prefix client install

# 3. Run all three services together
npm run dev
```

Fill in the required secrets before running:

- `ai-service/.env` → `AI_SERVICE_FINNHUB_API_KEY`; for transcript search also
  `DATABASE_URL` (same Supabase database, pooled URL),
  `AI_SERVICE_EQUIBLES_API_KEY`, `AI_SERVICE_GEMINI_API_KEY` and
  `AI_SERVICE_PINECONE_API_KEY`, then seed the index once with
  `cd ai-service && python -m scripts.seed_transcripts`.
- Chat: the same `AI_SERVICE_INTERNAL_TOKEN` secret in **both** `ai-service/.env`
  and `api/.env` (generate one with
  `python -c "import secrets; print(secrets.token_urlsafe(32))"`); it reuses the
  Gemini key above.
- `api/.env` → `DATABASE_URL` (pooled) and `DIRECT_URL` (direct) from Supabase,
  `SUPABASE_URL` (verifies user JWTs), and `SUPABASE_SERVICE_ROLE_KEY`
  (server-only; used to delete a user's auth account).
- `client/.env` → `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.

**Auth setup:** in your Supabase project, enable **Email** auth and (for local
dev) turn off email confirmation so sign-ups log in immediately; enable
**Anonymous sign-ins** to power the "Try demo" button. The API verifies access
tokens against the project's JWKS, so the project must use Supabase's asymmetric
JWT signing keys (the default for new projects). No demo credentials are needed —
each visitor gets their own temporary user, seeded with a sample portfolio.

Then open <http://localhost:5173>. Never commit `.env` files — only
`.env.example` is tracked.

More detail: **[docs/development.md](docs/development.md)** (per-service run
steps, scripts, health checks) and **[docs/api.md](docs/api.md)** (API reference).

## Contributing

Branch per feature, Conventional Commits, and merge only when CI is green.
Engineering standards, workflow, and code-quality rules live in
[`CLAUDE.md`](./CLAUDE.md).
