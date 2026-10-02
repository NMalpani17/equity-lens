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

The ai-service ingests earnings call transcripts from **Equibles**, embeds them
with **Gemini** (dense) and Pinecone's hosted sparse model (keywords), and
stores both in one **Pinecone** serverless index for hybrid search, reranked
with Pinecone's `bge-reranker-v2-m3`.

1. **Keys** (all free tiers) in `ai-service/.env`:
   - `AI_SERVICE_EQUIBLES_API_KEY` — [equibles.com/dashboard/apikeys](https://equibles.com/dashboard/apikeys)
     (100 requests/day, resets 00:00 UTC; one new ticker costs ~5 requests).
   - `AI_SERVICE_GEMINI_API_KEY` — [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
     The free tier counts **each embedded text** as a request (100/minute), so
     the service throttles itself to `AI_SERVICE_GEMINI_EMBED_TEXTS_PER_MINUTE`
     (default 100) plus an estimated-token budget
     (`AI_SERVICE_GEMINI_EMBED_TOKENS_PER_MINUTE`, default 24,000), and honors
     Gemini's `retryDelay` on 429s. **The free tier also caps embeddings at
     1,000 texts per day** (reset at midnight Pacific), and query embeddings
     count too. The ten default tickers are ~2,400 chunks, so on the free tier
     seeding spans several days (the seed stops cleanly when the daily quota
     runs out and resumes on the next run). Enabling billing on the Gemini
     project removes this limit; embedding everything costs well under $1.
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

## AI analyst chat setup

The chat is a LangGraph tool-calling agent in the ai-service. Express
authenticates the user, enforces limits, stores conversations, and proxies the
reply stream (SSE) to the browser.

```
Browser ──SSE── api (auth, caps, Prisma) ──SSE + X-Internal-Token── ai-service
                                                                       │
                LangGraph agent ── MCP client (langchain.mcp) ── FastMCP server (read-only tools)
```

1. **Internal token.** Generate one secret and put it in both
   `ai-service/.env` and `api/.env` as `AI_SERVICE_INTERNAL_TOKEN`:

   ```bash
   python -c "import secrets; print(secrets.token_urlsafe(32))"
   ```

   Every ai-service route except `/health` (quotes, transcript search, chat
   and `/mcp/`) rejects requests without it with `401`, and fails closed
   with `503` if the ai-service has no token configured. The gateway sends it
   on every call (`api/src/services/aiServiceClient.ts`), so the ai-service
   only trusts requests, and user ids, that come from the gateway.

2. **Model.** Reuses `AI_SERVICE_GEMINI_API_KEY` (with billing enabled).
   Defaults: `gemini-3.8-flash` with `low` thinking and a 2,048-token output cap
   (thinking included). The provider is swappable: `AI_SERVICE_CHAT_MODEL` is a
   LangChain `provider:model` string for `init_chat_model`. A typical turn uses
   ~6–7K input and ~0.5K output tokens, about $0.006 at 3.8 Flash's 2026 prices.
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

**Tools** are defined once on the FastMCP server
(`ai-service/app/services/chat/mcp_server.py`) and are all read-only:
`search_transcripts`, `get_quote`, `get_price_history`, `get_portfolio`,
`resolve_company` and `calculate_position`. The agent loads them through
`langchain.mcp.MCPAdapter` with a per-turn client that tags each call with a
turn id; tools resolve the user's portfolio and the turn's citation numbering
from that id, never from model-supplied arguments. The same server is mounted at
`/mcp/` for other MCP clients (bearer = internal token).

**Transcript search** (`ai-service/app/services/chat/transcripts.py`):

- `query` is optional: when the model leaves it out (it sometimes does when it
  wants an overview of a call), the user's question is searched instead (or a
  broad "results, outlook and management commentary" default), rather than
  rejecting the call and costing the agent a retry step.
- Out-of-range numeric arguments are clamped (e.g. `top_k` to 1–8) instead of
  failing the call; the limits are in the tool schema and descriptions.
- With no period named, it fetches extra candidates, boosts newer calls, makes
  sure the company's latest call is represented, and lists passages newest
  first.
- For trends across quarters ("over the last year", "quarter by quarter") the
  agent passes `quarters` (1–4): each of the company's latest N indexed
  quarters gets its own filtered retrieval, so no quarter is crowded out, and
  the union is reranked in **one** request (one rerank call per company, not
  per quarter). Passages are grouped by quarter; a quarter with no passages,
  or none scoring at least `MIN_QUARTER_RELEVANCE` (0.02) after reranking, is
  marked "NO RELEVANT PASSAGES" so the answer says so explicitly.
- Share classes of one company (GOOG/GOOGL, BRK.A/BRK.B, …) map to the class
  that is indexed, so transcript questions never ask which class and never index
  a duplicate. The agent asks about the class only for prices.
- If a company isn't indexed yet, the tool waits for on-demand indexing within
  the turn (`AI_SERVICE_CHAT_INDEX_WAIT_SECONDS`, default 45) and streams a
  `tool_progress` label such as "Indexing Starbucks transcripts…", then
  answers; only after that does it say to try again shortly.

**Stop, errors and Retry** (`client/src/hooks/useChat.ts`): a turn that ends
without the server's final message (Stop, an error, a dropped connection) is
marked stopped or failed at once and the thread is re-synced from the server,
which supplies the saved message ids that Retry needs, final statuses and the
conversation title (set from the first question even if that turn was stopped).
A reply the server still reports as `streaming` is re-checked briefly, then
shown as stopped, so the UI never waits on "Thinking…". Retry is offered only
on the latest reply; a question the server never saved is simply sent again.
Errors are shown as plain sentences (`client/src/lib/chatErrors.ts`), never
status codes. The API watches for a client disconnect from the very start of a
turn, so a Stop during setup is saved as `interrupted` immediately.

**Answer clean-up** (`ai-service/app/services/chat/formatting.py`): the final
answer gets a deterministic pass after citation validation. Double negatives
are removed ("down -$13,457" becomes "down $13,457"), whole share counts lose their
decimals ("42.0 shares" becomes "42 shares"; fractional shares are kept), and lists
inside Markdown table cells are flattened to "a; b". Tools also report whole
share counts as integers.

**Logs never contain credentials.** Provider keys travel in headers (Finnhub
uses `X-Finnhub-Token`), HTTP client loggers run at WARNING, and the ai-service
JSON formatter redacts secret query parameters, bearer tokens and auth headers.
The API's pino logger censors `authorization`, `cookie`, `x-internal-token` and
`set-cookie` as `***`.

**Guardrails.** Obvious off-topic requests and instruction-override attempts get
a short canned reply without calling the model. The system prompt (today's date,
no secrets) adds the scope rules, untrusted tool data, cite only retrieved
passages, numbers only from tools, ask when a company is ambiguous, report tool
status honestly, and no personalized buy/sell advice (answers to "should I
buy…" get facts plus a not-financial-advice note). Answers are validated after
generation: citations to passages that weren't retrieved are dropped, and empty,
truncated and blocked responses get explicit messages.

**Inline charts** (`ai-service/app/services/chat/charts.py`): when
`get_price_history` or `get_portfolio` succeeds, the agent builds a typed chart
from the tool's structured output (never from the model's text), streams it as
a `chart` event and attaches the turn's charts to `done`. The API validates
them with Zod and saves them on the message; the client renders them with
Recharts (`client/src/components/chat/charts/`), lazy-loaded in its own chunk.
Charts fill the bubble width (the full row on phones), use the `--chart-1`
color token (separate light and dark values) and include a "View data" table.

Chat tests need no network: a scripted fake chat model drives the real agent
and MCP tools (`ai-service/tests/test_chat_agent.py`).

## Tracing (Langfuse, optional)

Set both keys in `ai-service/.env` to trace every chat turn; leave them empty
to turn tracing off (the SDK isn't even imported):

```bash
AI_SERVICE_LANGFUSE_PUBLIC_KEY=pk-lf-...
AI_SERVICE_LANGFUSE_SECRET_KEY=sk-lf-...
AI_SERVICE_LANGFUSE_BASE_URL=https://cloud.langfuse.com   # or https://us.cloud.langfuse.com / self-hosted
```

Each turn gets a Langfuse LangChain `CallbackHandler`, so one trace holds the
agent graph, every model call (tokens and cost; Langfuse prices Gemini models
from its model table, editable under Project Settings → Models), every MCP tool
call with its latency, and errors (level `ERROR`). Traces are named
`chat-turn`, grouped by conversation (session id), tagged `chat` (plus `demo`
for anonymous users and `eval` for eval runs), and get a `turn_status` score
(`complete`, `truncated`, `blocked`, `empty`, `refused`, `error`). Guardrail
refusals, which never reach the model, are recorded as single-span traces.

**Privacy** (`ai-service/app/services/observability/masking.py`): the Langfuse
client's `mask` hook runs on every input, output and metadata payload before
export. It removes configured secrets verbatim (internal token, provider keys,
the database URL) plus bearer/token patterns, masks emails, phone numbers and
"N shares" counts, masks portfolio fields by key (shares, average cost, cost
basis, market value, gain/loss, weights, position-math inputs and results),
including inside JSON tool output, and masks the turn's own portfolio numbers
and position-math results wherever they appear in text (e.g. the answer saying
"your $13,680 position" or "a new average cost of $112.40"). Numbers typed in
the question itself stay visible unless they match those values or a share
count.
Public prices stay visible. User ids are sent as `u_` + HMAC-SHA256 (keyed by
`AI_SERVICE_TRACE_USER_SALT`; plain SHA-256 if unset), never raw ids or emails.
If masking fails, Langfuse drops the payload.

**Failure isolation** (`ai-service/app/services/observability/tracing.py`):
spans are exported by a background thread with a short timeout
(`AI_SERVICE_LANGFUSE_TIMEOUT_SECONDS`, 2); if Langfuse is slow or down, the
turn doesn't wait. Client start-up errors disable tracing with a warning, every
SDK call is guarded, LangChain logs (not raises) callback errors, and shutdown
waits at most 3 seconds. `AI_SERVICE_LANGFUSE_SAMPLE_RATE` (1.0) traces a
fraction of turns. Tests cover the disabled path, a handler that raises on
every callback, an unreachable host, and the masked spans the real SDK would
export (`ai-service/tests/test_tracing.py`, `test_trace_masking.py`).

## Chat evaluation

`ai-service/scripts/eval_chat.py` runs a labeled set of 25 questions
(`scripts/eval/chat_questions.json`) through the real agent — real tools,
transcripts and Gemini — with a fixed demo portfolio, for each model compared:

```bash
cd ai-service
python -m scripts.eval_chat --estimate   # expected cost, no API calls
python -m scripts.eval_chat --yes        # run it (spends Gemini credit)
python -m scripts.eval_chat --yes --cases t01,pm01 --models google_genai:gemini-3.8-flash
```

Categories: transcript facts, multi-quarter trends, portfolio, position math,
buy/sell advice, off-topic, prompt injection and ambiguous companies. Each
answer is scored two ways (`ai-service/app/services/evals/`):

- **Deterministic checks**: expected tools called (and forbidden ones not),
  every `[n]` marker resolves to a returned passage, citations come from the
  right company and enough distinct quarters, refusal or redirect when
  expected, a clarifying question (without searching) for ambiguous names, the
  not-financial-advice note, expected numbers (position math, portfolio
  totals) and expected charts.
- **LLM judge** (rubric 1–5: faithfulness to the answer's own cited passages
  and tool results, relevance, completeness): one call per question sees every
  model's answer labeled only "A"/"B" in a seeded random order, each with its
  evidence. Refusal and clarification cases are scored deterministically only.

The script prints a cost estimate first and refuses to run without `--yes`.
The estimate is deliberately conservative: the 2026-10-02 run cost $0.46
against a $1.13 estimate (turns averaged ~6.4K input / ~0.3K output tokens). The
judge is `gemini-3.1-pro-preview` when the whole run is estimated under
`--budget` ($1.50), otherwise `gemini-3.8-flash`. During the run on-demand
indexing is disabled (no Equibles quota) and the rerank cache is off so models
pay the same retrieval latency; expect ~40–60 Pinecone rerank requests. Results
print as Markdown tables and are saved to `scripts/eval/results/` (git-ignored).
With Langfuse on, eval turns are tagged `eval` and `eval-run:<id>` and get
`eval_checks_passed` and `judge_*` scores.

**Judge bias.** LLM judges favor answers from their own model family
(self-preference), longer and more confident answers (verbosity bias), and
whichever answer comes first (position bias), and they are lenient on numeric
detail. Mitigations here: the deterministic checks are the primary,
bias-free signal; the judge never sees model names and answer order is
shuffled per question; the rubric says length and tone aren't quality and caps
faithfulness at 2 for any unsupported figure; each answer is judged only
against its own evidence. Residual risk: with a Gemini judge grading Gemini
answers, small score gaps (a few tenths of a point) aren't meaningful — read
the judge columns as a sanity check next to the check pass rates, and
spot-check the saved rationales.

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
