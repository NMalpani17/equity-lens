# Development

Local setup, running services, and common scripts. For a fast path, see the
[Quick start](../README.md#quick-start) in the README.

## Prerequisites

- Node.js 20+ and npm
- Python 3.12+
- Git
- A **Supabase** project (free tier) for the PostgreSQL database
- A free **Finnhub** API key ([finnhub.io](https://finnhub.io/dashboard))
- For transcript search: free **Equibles**, **Gemini** and **Pinecone** keys
  (see [Transcript search (RAG) setup](#transcript-search-rag-setup))

## Environment files

Copy the example env files, then fill in the secrets:

```bash
cp client/.env.example client/.env
cp api/.env.example api/.env
cp ai-service/.env.example ai-service/.env
```

- `ai-service/.env` → `AI_SERVICE_FINNHUB_API_KEY` (your Finnhub key). For
  transcript search also `DATABASE_URL`, `AI_SERVICE_EQUIBLES_API_KEY`,
  `AI_SERVICE_GEMINI_API_KEY` and `AI_SERVICE_PINECONE_API_KEY` (see below).
- `api/.env` → `DATABASE_URL` (pooled) and `DIRECT_URL` (direct) from Supabase
  (**Project Settings → Database → Connection string**). Keep `?pgbouncer=true`
  on the pooled URL. Also set `SUPABASE_URL` (**Project Settings → Data API →
  Project URL**), used to verify user JWTs, and `SUPABASE_SERVICE_ROLE_KEY`
  (**Project Settings → API Keys → service_role**) — server-side only, used to
  delete a user's auth account. Never expose the service-role key to the client.
- `client/.env` → `VITE_SUPABASE_URL` (same Project URL) and
  `VITE_SUPABASE_PUBLISHABLE_KEY` (**Project Settings → API Keys → publishable /
  anon key**).

> Never commit `.env` files — only `.env.example` is tracked. See `CLAUDE.md`.

## Supabase Auth setup

Authentication uses Supabase Auth. In the Supabase dashboard:

1. **Authentication → Providers → Email:** enable it. For local dev, turn off
   "Confirm email" so a sign-up logs in immediately (otherwise users must click
   the email link before a session is issued).
2. **Authentication → Anonymous sign-ins:** enable it. The "Try demo" button
   uses anonymous sign-in, so each visitor gets their own temporary user. On
   that user's first dashboard load the API seeds a sample portfolio (from
   `api/src/services/demoHoldings.ts`); no shared account or credentials needed.
3. The API verifies access tokens against the project's **JWKS**, so the project
   must use asymmetric JWT signing keys (the default for new projects; legacy
   projects can migrate under **Project Settings → JWT Keys**).
4. **Password reset:** under **Authentication → URL Configuration**, add the
   reset page to the allowed **Redirect URLs** (e.g.
   `http://localhost:5173/reset-password`, plus your deployed origin). The
   "Forgot password?" link emails a link back to that page; a logged-in user can
   also change their password from **Account** in the header (hidden in demo).

## Transcript search (RAG) setup

The ai-service ingests earnings call transcripts from **Equibles**, embeds them
with **Gemini** (dense) and Pinecone's hosted sparse model (keywords), and
stores both in one **Pinecone** serverless index for hybrid search, reranked
with Pinecone's `bge-reranker-v2-m3`.

1. **Keys** (all free tiers) in `ai-service/.env`:
   - `AI_SERVICE_EQUIBLES_API_KEY` — [equibles.com/dashboard/apikeys](https://equibles.com/dashboard/apikeys)
     (100 requests/day, resets 00:00 UTC; one new ticker costs ~5 requests).
   - `AI_SERVICE_GEMINI_API_KEY` — [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
   - `AI_SERVICE_PINECONE_API_KEY` — [app.pinecone.io](https://app.pinecone.io).
     The Starter plan only allows indexes in AWS `us-east-1` and 500 rerank
     requests/month; when reranking is unavailable search falls back to hybrid
     order (`reranked: false`).
   - `DATABASE_URL` — the **same Supabase database** as the API (pooled URL is
     fine; the service disables prepared statements for the pooler).
2. **Tables:** RAG state lives in Postgres, not on local disk (Render's
   filesystem is ephemeral). Prisma owns the schema, so run the API migrations:
   `npm --prefix api run prisma:migrate` (dev) or `prisma:deploy` (prod). This
   creates `rag_tickers`, `rag_ingestion_jobs`, `rag_daily_usage` and
   `rag_transcripts` (raw Equibles JSON as `jsonb`).
3. **Seed** the ten default large caps (creates the Pinecone index on first
   run, ~50 Equibles requests):

   ```bash
   cd ai-service
   python -m scripts.seed_transcripts               # AAPL MSFT NVDA AMZN GOOGL META TSLA JPM NFLX AMD
   python -m scripts.seed_transcripts CRM ORCL      # specific tickers
   python -m scripts.seed_transcripts --force       # re-chunk/re-embed from the DB cache (no Equibles calls)
   python -m scripts.seed_transcripts --refresh     # re-fetch from Equibles (new quarters)
   ```

   Re-runs are idempotent: vector IDs are stable (`TICKER#FY2025Q3#0042`) and
   transcripts are served from the `rag_transcripts` cache. The seed bypasses the
   on-demand daily cap and stops cleanly if the Equibles quota runs out.

4. **On-demand tickers:** searching an unindexed ticker returns `202` and indexes
   it in a background thread. At most `AI_SERVICE_RAG_DAILY_INGESTION_CAP`
   (default 8) new tickers are ingested per UTC day; concurrent requests for the
   same ticker share one job (Postgres advisory lock). A job stuck in `indexing`
   for over 30 minutes (e.g. the process restarted) is re-claimed by the next
   search.
5. **Evaluate** retrieval (hit rate@5 and MRR for dense / hybrid / hybrid +
   rerank, with and without context headers) on the labeled questions in
   `ai-service/scripts/eval/questions.json`:

   ```bash
   python -m scripts.eval_rag --build-plain   # first time: index header-less copies
   python -m scripts.eval_rag
   ```

   Each run makes ~40 rerank calls, so mind the 500/month Starter quota.

Every search logs one structured JSON line (`event: rag_search`) with the
filters, candidate count, whether reranking applied, and per-stage latency.

Repository integration tests (advisory-lock dedupe, daily cap) run only when
`AI_SERVICE_TEST_DATABASE_URL` points at a Postgres database (use a direct,
non-pooled URL); they apply the migration into a throwaway schema and drop it.

## First-time install

```bash
npm install                                   # repo root — Husky + concurrently

cd ai-service && python -m venv .venv         # create the Python virtualenv
.venv\Scripts\activate                        # Windows (PowerShell/cmd)
# source .venv/bin/activate                    # macOS/Linux
pip install -r requirements-dev.txt
deactivate && cd ..

npm --prefix api install                      # also runs `prisma generate`
npm --prefix api run prisma:migrate           # creates/updates tables (first run)
npm --prefix client install
```

> `prisma:migrate` uses `DIRECT_URL`; the running app uses the pooled
> `DATABASE_URL`. Both must be set in `api/.env` before migrating.

## Run everything with one command

From the repo root:

```bash
npm run dev
```

This uses [`concurrently`](https://www.npmjs.com/package/concurrently) to run the
**ai-service** (via its own `.venv`), **api**, and **client** in a single
terminal with color-coded, prefixed output (`ai`, `api`, `client`). Press
`Ctrl+C` once to stop all three.

> The `dev:ai` script invokes `ai-service\.venv\Scripts\uvicorn` directly, so the
> virtualenv is used automatically — no manual `activate` needed. On macOS/Linux
> the venv binary lives at `.venv/bin/uvicorn`; adjust the `dev:ai` script in the
> root `package.json` accordingly.

Run a single service with `npm run dev:ai`, `npm run dev:api`, or
`npm run dev:client`.

## Running services individually

If you prefer separate terminals, start them **bottom-up**
(ai-service → api → client).

### 1. ai-service (FastAPI) — port 8000

```bash
cd ai-service
python -m venv .venv
.venv\Scripts\activate            # Windows (PowerShell/cmd)
# source .venv/bin/activate        # macOS/Linux
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8000
```

### 2. api (Express) — port 3001

```bash
cd api
npm install                 # also runs `prisma generate`
npm run prisma:migrate      # creates the holdings table in Supabase (first run)
npm run dev
```

### 3. client (React) — port 5173

```bash
cd client
npm install
npm run dev
```

Open <http://localhost:5173>. You'll land on a **login page** — sign up, log in,
or click **Try demo**. After authenticating you reach the **portfolio dashboard**
(positions, summary cards, and add/edit/delete), plus a **System health** card
that calls `api → ai-service` and reports the status of each hop. In demo mode a
slim banner invites you to sign up for your own account. For health and API
details, see [api.md](./api.md).

## Common scripts

| Service       | Lint           | Format           | Test           | Type-check          |
| ------------- | -------------- | ---------------- | -------------- | ------------------- |
| `client/`     | `npm run lint` | `npm run format` | `npm run test` | `npm run typecheck` |
| `api/`        | `npm run lint` | `npm run format` | `npm run test` | `npm run typecheck` |
| `ai-service/` | `ruff check .` | `ruff format .`  | `pytest`       | (type hints)        |

ai-service operational scripts (run from `ai-service/`):
`python -m scripts.seed_transcripts` and `python -m scripts.eval_rag`.

## Pre-commit hooks & CI

Pre-commit hooks run automatically. Set them up once:

```bash
npm install            # repo root — installs Husky hooks + lint-staged
pip install pre-commit # for the Python (Ruff) hook
```

Husky + lint-staged format/lint staged JS/TS; Ruff handles Python. CI runs lint,
typecheck, and tests for all three services on every push and PR.

## Repository layout

```
equity-lens/
├── CLAUDE.md          # project guide, rules, and code quality standards
├── README.md
├── docs/              # api.md (API reference), development.md (this file)
├── client/            # React + TypeScript front end
├── api/               # Express + TypeScript API gateway
└── ai-service/        # FastAPI (Python) AI service
```
