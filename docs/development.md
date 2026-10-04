# Development

Local setup, configuration, running the services, tests and scripts. How the
system works is in [architecture.md](architecture.md); evals are in
[evaluation.md](evaluation.md). For a fast path, see
[Run locally](../README.md#run-locally) in the README.

## Prerequisites

- Node.js 22+ and npm
- Python 3.12+
- Git
- A **Supabase** project (free tier) for the PostgreSQL database
- A free **Finnhub** API key ([finnhub.io](https://finnhub.io/dashboard))
- For transcript search and chat: **Equibles** and **Pinecone** keys (free
  tiers) and a **Gemini** key with billing enabled (see
  [Transcript search (RAG) setup](#transcript-search-rag-setup))

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
  Always `AI_SERVICE_INTERNAL_TOKEN` (required by every route except
  `/health`; see the chat setup below).
- `api/.env` → `DATABASE_URL` (pooled) and `DIRECT_URL` (direct) from Supabase
  (**Project Settings → Database → Connection string**). Keep `?pgbouncer=true`
  on the pooled URL. Also set `SUPABASE_URL` (**Project Settings → Data API →
  Project URL**), used to verify user JWTs, and `SUPABASE_SERVICE_ROLE_KEY`
  (**Project Settings → API Keys → service_role**) — server-side only, used to
  delete a user's auth account. Never expose the service-role key to the client.
  Also `AI_SERVICE_INTERNAL_TOKEN` (the same value as in `ai-service/.env`);
  without it quotes, transcript search and chat are unavailable.
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

The ai-service indexes earnings call transcripts from **Equibles** into a
**Pinecone** index for hybrid search (dense **Gemini** embeddings + sparse
keywords, reranked); see [architecture.md](architecture.md#rag-pipeline).

1. **Keys** in `ai-service/.env`:
   - `AI_SERVICE_EQUIBLES_API_KEY` — [equibles.com/dashboard/apikeys](https://equibles.com/dashboard/apikeys)
     (free tier: 100 requests/day, resets 00:00 UTC; one new ticker costs ~5 requests).
   - `AI_SERVICE_GEMINI_API_KEY` — [aistudio.google.com/apikey](https://aistudio.google.com/apikey),
     on a project with **billing enabled** (as the live deployment uses;
     embedding the ten default tickers costs well under $1). The service throttles
     embeddings to `AI_SERVICE_GEMINI_EMBED_TEXTS_PER_MINUTE` (default 100)
     plus an estimated-token budget (`AI_SERVICE_GEMINI_EMBED_TOKENS_PER_MINUTE`,
     default 24,000), and honors Gemini's `retryDelay` on 429s. _If you run it
     yourself on the free tier:_ each embedded text counts as a request
     (100/minute) and embeddings are capped at 1,000 texts per day (reset at
     midnight Pacific; query embeddings count too). The ten default tickers are
     ~2,400 chunks, so seeding then spans several days (the seed stops cleanly
     when the daily quota runs out and resumes on the next run).
   - `AI_SERVICE_PINECONE_API_KEY` — [app.pinecone.io](https://app.pinecone.io).
     The Starter plan only allows indexes in AWS `us-east-1` and 500 rerank
     requests/month; when reranking is unavailable search falls back to hybrid
     order (`reranked: false`).
   - `DATABASE_URL` — the **same Supabase database** as the API (pooled URL is
     fine; the service disables prepared statements for the pooler).
2. **Tables:** RAG state lives in Postgres, not on local disk (Cloud Run's
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

4. **Other tickers** are indexed on demand the first time they're searched, at
   most `AI_SERVICE_RAG_DAILY_INGESTION_CAP` (default 8) new tickers per UTC
   day.

To measure retrieval quality, see [evaluation.md](evaluation.md#retrieval-evaluation).

## AI analyst chat setup

The chat is a LangGraph agent in the ai-service with read-only tools on a
FastMCP server; the api authenticates, enforces limits, stores conversations and
streams the reply. See [architecture.md](architecture.md#a-chat-turn).

1. **Internal token.** Generate one secret and put it in both
   `ai-service/.env` and `api/.env` as `AI_SERVICE_INTERNAL_TOKEN`:

   ```bash
   python -c "import secrets; print(secrets.token_urlsafe(32))"
   ```

   Every ai-service route except `/health` rejects requests without it
   (`401`), and fails closed (`503`) if none is configured; see
   [architecture.md](architecture.md#security).

2. **Model.** Reuses `AI_SERVICE_GEMINI_API_KEY` (with billing enabled).
   Defaults: `gemini-3.8-flash` with `low` thinking and a 2,048-token output cap
   (thinking included). The provider is swappable: `AI_SERVICE_CHAT_MODEL` is a
   LangChain `provider:model` string for `init_chat_model`. A typical turn uses
   ~6–7K input and ~0.3K output tokens, about $0.006 at 3.8 Flash's 2026 prices.
   When prepaid credits run out Gemini returns HTTP 402, shown to users as
   "out of credits".

3. **Database.** Conversations live in Postgres. Run the API migrations
   (`npm --prefix api run prisma:migrate`), which add `chat_conversations`,
   `chat_messages` (including a `charts` JSONB column for inline charts) and
   `chat_usage_events` (one row per turn — a sent message or a retry — which
   the daily caps count).

4. **Limits** (in `api/.env`): `CHAT_DAILY_LIMIT` (20), `CHAT_DAILY_LIMIT_ANON`
   (5), `CHAT_GLOBAL_DAILY_LIMIT` (60), `CHAT_MAX_MESSAGE_CHARS` (2000). Per
   turn (in `ai-service/.env`): `AI_SERVICE_CHAT_MAX_MODEL_CALLS` (6) and
   `AI_SERVICE_CHAT_MAX_TOOL_CALLS` (8).

## Tracing (Langfuse, optional)

Set both keys in `ai-service/.env` to trace every chat turn; leave them empty
to turn tracing off (the SDK isn't even imported):

```bash
AI_SERVICE_LANGFUSE_PUBLIC_KEY=pk-lf-...
AI_SERVICE_LANGFUSE_SECRET_KEY=sk-lf-...
AI_SERVICE_LANGFUSE_BASE_URL=https://cloud.langfuse.com   # or https://us.cloud.langfuse.com / self-hosted
```

`AI_SERVICE_TRACE_USER_SALT` keys the hashed user ids (plain SHA-256 if unset),
`AI_SERVICE_LANGFUSE_SAMPLE_RATE` (1.0) traces a fraction of turns, and
`AI_SERVICE_LANGFUSE_TIMEOUT_SECONDS` (2) bounds each export. Langfuse prices
Gemini models from its model table (editable under Project Settings → Models).
What's traced and how it's masked: [architecture.md](architecture.md#tracing-and-privacy).

## Running locally

### First-time install

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

### Run everything with one command

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

### Single services

Run one service with `npm run dev:ai`, `npm run dev:api`, or
`npm run dev:client`. In separate terminals, start them **bottom-up**:

```bash
cd ai-service && .venv\Scripts\activate && uvicorn app.main:app --reload --port 8000   # :8000
npm --prefix api run dev                                                              # :3001
npm --prefix client run dev                                                           # :5173
```

Open <http://localhost:5173>. You'll land on a **login page** — sign up, log in,
or click **Try demo**. After authenticating you reach the **portfolio dashboard**
(positions, summary cards, and add/edit/delete). The **status dot** in the top
bar, next to the avatar, calls `api → ai-service` and turns green (ok), amber
(the ai-service is waking up; re-checked every 5 s) or red (the API can't be
reached or reports another problem); hover or focus it for the status of each
hop. In demo mode a slim banner invites you to sign up for your own account. For health and API
details, see [api.md](./api.md).

## Tests, lint and scripts

| Service       | Lint           | Format           | Test           | Type-check          |
| ------------- | -------------- | ---------------- | -------------- | ------------------- |
| `client/`     | `npm run lint` | `npm run format` | `npm run test` | `npm run typecheck` |
| `api/`        | `npm run lint` | `npm run format` | `npm run test` | `npm run typecheck` |
| `ai-service/` | `ruff check .` | `ruff format .`  | `pytest`       | (type hints)        |

- Chat tests need no network: a scripted fake chat model drives the real agent
  and MCP tools (`ai-service/tests/test_chat_agent.py`).
- RAG repository integration tests (advisory-lock dedupe, daily cap) run only
  when `AI_SERVICE_TEST_DATABASE_URL` points at a Postgres database (use a
  direct, non-pooled URL); they apply the migration into a throwaway schema and
  drop it.
- Tracing tests cover the disabled path, a handler that raises on every
  callback, an unreachable host, and the masked spans the real SDK would export
  (`ai-service/tests/test_tracing.py`, `test_trace_masking.py`).

ai-service operational scripts (run from `ai-service/`):
`python -m scripts.seed_transcripts` (above), and `python -m scripts.eval_rag`
and `python -m scripts.eval_chat` ([evaluation.md](evaluation.md)).

### Pre-commit hooks & CI

Pre-commit hooks run automatically. Set them up once:

```bash
npm install            # repo root — installs Husky hooks + lint-staged
pip install pre-commit # for the Python (Ruff) hook
```

Husky + lint-staged format/lint staged JS/TS; Ruff handles Python. CI runs lint,
typecheck, and tests for `client` and `api`, plus Ruff lint/format and Pytest
for `ai-service`, on every push and PR.

### Docker

Both backend services have Dockerfiles; build and run them locally with
`docker build` / `docker run` as described in
[deployment.md](deployment.md#docker-images). The containers read `PORT`; the
api's liveness check is `GET /api/live` and the ai-service's is `GET /health`.
