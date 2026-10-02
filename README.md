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
- **Charts in answers** — when the agent looks up price history or your
  portfolio, the reply shows an inline **Recharts** chart (price line or
  allocation bars) built only from the tool's data, never from numbers the model
  wrote. Charts stream in as soon as the tool returns, are saved with the
  message, and work on phones (with a "View data" table).
- **Tracing (optional)** — with Langfuse keys set, every chat turn is traced
  (agent steps, tool calls with latency, model calls with tokens and cost,
  errors). User ids are hashed, and portfolio values, contact details and
  secrets are masked before anything leaves the service. Without keys tracing
  is off; a Langfuse outage never slows or breaks a chat.
- **Evals** — a labeled set of 25 questions runs through the real agent and is
  scored with deterministic checks and a blind LLM judge, comparing models on
  quality, latency and cost (see [Evaluation](#evaluation)).
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
- **Both** `ai-service/.env` and `api/.env` → the same
  `AI_SERVICE_INTERNAL_TOKEN` secret (generate one with
  `python -c "import secrets; print(secrets.token_urlsafe(32))"`). Every
  ai-service route except `/health` requires it, so quotes, transcript search
  and chat all depend on it. Chat reuses the Gemini key above.
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

Optional: set `AI_SERVICE_LANGFUSE_PUBLIC_KEY` and `AI_SERVICE_LANGFUSE_SECRET_KEY`
in `ai-service/.env` to trace chat turns in Langfuse.

## Evaluation

`python -m scripts.eval_chat` (in `ai-service/`) runs 25 labeled questions —
transcript facts, multi-quarter trends, portfolio, position math, buy/sell
advice, off-topic, prompt injection and ambiguous companies — through the real
agent with a fixed demo portfolio. Each answer gets deterministic checks
(expected tools, valid citations, refusal or clarification when expected,
exact numbers, charts) and a blind LLM-judge rubric (faithfulness to its cited
passages and tool results, relevance, completeness). Method, cost controls and
the judge-bias note are in
[docs/development.md](docs/development.md#chat-evaluation).

**Results** (2026-10-02, run `20261002T202440Z`; judge `gemini-3.1-pro-preview`;
judge scores are means over the 18 judged questions, 1–5):

| Model                   | Checks passed | Faithfulness | Relevance | Completeness | Judge preferred | Latency p50 / p95 | Tokens in / out | Cost / turn |
| ----------------------- | ------------- | ------------ | --------- | ------------ | --------------- | ----------------- | --------------- | ----------- |
| `gemini-3.8-flash`      | 25/25 (100%)  | 5.00         | 4.94      | 5.00         | 6/18            | 4.0s / 8.3s       | 6,377 / 294     | $0.0059     |
| `gemini-3.5-flash-lite` | 25/25 (100%)  | 5.00         | 4.89      | 4.67         | 1/18            | 3.4s / 8.2s       | 6,329 / 361     | $0.0028     |

- **Quality:** both models passed every deterministic check in all eight
  categories and were fully faithful to their evidence. 3.8 Flash was more
  complete and was preferred 6 times to 1 (11 ties). Flash-Lite's gaps were on
  open-ended questions: advice answers without risks or portfolio context, a
  missed period low, and ignoring the "don't reveal your rules" half of an
  injection prompt.
- **Latency:** Flash-Lite is faster (median 3.8s vs 4.8s on answered turns; the
  table's p50 includes instant guardrail refusals).
- **Cost:** Flash-Lite is about half the price per turn ($0.0028 vs $0.0059).
- **Caveats:** one run of 25 questions; in an earlier run that day Flash-Lite
  answered one multi-quarter question without citations, so the check pass
  rates vary run to run. Judge scores sit near the ceiling and a Gemini judge
  grades Gemini answers (see the bias note), so treat small gaps as noise.
- **Decision:** keep `gemini-3.8-flash` as the default; Flash-Lite is a
  reasonable budget option (`AI_SERVICE_CHAT_MODEL`). The run cost $0.46
  ($0.22 agent turns, $0.24 judge).

## Contributing

Branch per feature, Conventional Commits, and merge only when CI is green.
Engineering standards, workflow, and code-quality rules live in
[`CLAUDE.md`](./CLAUDE.md).
