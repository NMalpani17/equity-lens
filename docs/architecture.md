# Architecture

How Equity Lens works and why it's built this way. Setup is in
[development.md](development.md), production in [deployment.md](deployment.md),
and endpoint contracts in [api.md](api.md).

## Request flow

```
Browser ──▶ client (React, Vercel) ──HTTPS + Supabase JWT──▶ api (Express, Cloud Run)
                                                               │  Google ID token + X-Internal-Token
                                                               ▼
                                        ai-service (FastAPI, Cloud Run, private)
                                                               │
            Supabase Postgres ◀── api and ai-service      Pinecone · Gemini · Finnhub · Equibles · Langfuse
```

- The **client** only ever talks to the api. It never holds a service key or
  calls the ai-service.
- The **api** is the gateway. It verifies Supabase sessions, scopes every query
  to the user, enforces chat limits, stores holdings and conversations
  (Prisma owns every table, including the ai-service's RAG tables), and calls
  the ai-service only on behalf of a signed-in (real or demo) user.
- The **ai-service** owns all LLM, RAG and market-data logic. It is private:
  only the api can invoke it, so it trusts the user id the api sends.

### A chat turn

```
Browser ──SSE── api (auth, caps, Prisma) ──SSE + X-Internal-Token── ai-service
                                                                       │
                LangGraph agent ── MCP client (langchain.mcp) ── FastMCP server (read-only tools)
```

1. The api checks the daily caps and claims the turn (one open turn per
   conversation; an overlapping send gets `409`). It loads the user's portfolio
   snapshot at the same time.
2. It starts the SSE response at once with a `turn` event and sends keepalive
   comments, so the browser shows the question while a cold ai-service starts.
3. It opens the ai-service stream with the question, the last 6 final answers
   (~3K tokens; never past tool results) and the portfolio snapshot, then relays
   `tool_start` / `tool_progress` / `tool_end` / `chart` / `token` events.
4. It saves the final message (status, citations, charts, tool calls) and sends
   `done`. If the browser disconnects, at any point from the start of the turn,
   the api aborts the upstream call (cancelling the model request) and saves the
   partial reply as `interrupted`.

**Stop, errors and Retry** (`client/src/hooks/useChat.ts`): a turn that ends
without the server's final message is marked stopped or failed at once and the
thread is re-synced from the server, which supplies saved message ids, final
statuses and the conversation title. A reply still reported as `streaming` is
re-checked briefly, then shown as stopped, so the UI never waits forever. Retry
regenerates only the latest stopped or failed reply, in place. Errors are shown
as plain sentences (`client/src/lib/chatErrors.ts`), never status codes.

## The agent and its tools

The chat is a LangGraph tool-calling agent. Its tools are defined once, on a
FastMCP server (`ai-service/app/services/chat/mcp_server.py`), and are all
read-only: `search_transcripts`, `get_quote`, `get_price_history`,
`get_portfolio`, `resolve_company` (name → ticker, period phrase → fiscal
quarter) and `calculate_position` (exact position math, so the model never does
arithmetic).

- **Turn-scoped context.** The agent loads the tools through
  `langchain.mcp.MCPAdapter` with a per-turn client that tags every call with a
  turn id. Tools resolve the user's portfolio and the turn's citation numbering
  from that id, never from model-supplied arguments, so a prompt can't reach
  another user's data.
- **Bounded turns.** Each turn allows at most 6 model calls and 8 tool calls,
  and the output is capped at 2,048 tokens (thinking included).
- **Swappable model.** `AI_SERVICE_CHAT_MODEL` is a LangChain `provider:model`
  string; the default is `gemini-3.8-flash` (see [evaluation.md](evaluation.md)
  for why).
- **Reusable server.** The same FastMCP server is mounted at `/mcp/` for other
  MCP clients (behind `X-Internal-Token`).

## RAG pipeline

**Ingestion.** For each company the ai-service fetches the last four earnings
call transcripts from Equibles and caches the raw JSON in Postgres
(`rag_transcripts`), so re-chunking or re-embedding never spends Equibles quota
again. Transcripts are split into ~400-token chunks with 60-token overlap,
keeping speaker, role, section (prepared remarks or Q&A) and fiscal period. Each
chunk is embedded with a **context header** prepended (`AAPL (Apple Inc) · Q3
FY2025 earnings call · 2025-07-31 · Q&A · Kevan Parekh, CFO`), which gives an
isolated passage the company and period it belongs to. Dense vectors come from
Gemini (`gemini-embedding-001`, 768-d) and sparse keyword vectors from
Pinecone's hosted model; both go into one Pinecone serverless index. Vector ids
are stable (`TICKER#FY2025Q3#0042`), so re-runs are idempotent. Embedding calls
are throttled client-side (texts and estimated tokens per minute) and honor
Gemini's `retryDelay`. All RAG state (tickers, jobs, daily usage, transcript
cache) lives in Postgres because Cloud Run's filesystem is ephemeral.

**Hybrid search and rerank.** A query is embedded both ways and combined as a
convex mix (alpha 0.75 dense, 0.25 sparse): dense finds paraphrases, sparse
catches exact names and numbers. Ticker and fiscal-period filters are applied
inside the vector query (pre-filtering). The top 25 candidates are reranked by
Pinecone's `bge-reranker-v2-m3`. If the reranker fails or its monthly quota
runs out, the search still succeeds in hybrid order (`reranked: false`). Query
embeddings are cached in memory for an hour. Every search logs one structured
line (`event: rag_search`) with the filters, candidate count, whether reranking
applied, and per-stage latency. The measured effect of headers, hybrid search
and reranking is in [evaluation.md](evaluation.md#retrieval-evaluation).

**On-demand indexing.** Ten large caps are pre-seeded. Searching any other
ticker returns `202` and indexes it in a background thread. At most 8 new
tickers are ingested per UTC day (protecting the 100-request/day Equibles
quota); concurrent requests for one ticker share a single job (Postgres
advisory lock); and a job stuck in `indexing` for over 30 minutes (e.g. after a
restart) is reclaimed by the next search. In chat, the tool waits for indexing
within the turn (up to 45 s) and streams a label such as "Indexing Starbucks
transcripts…", so the user gets an answer instead of "try again later".

**How the transcript tool shapes retrieval** (`ai-service/app/services/chat/transcripts.py`):

- A missing `query` falls back to the user's question (or a broad results and
  outlook query) instead of failing, and out-of-range arguments are clamped, so
  a sloppy tool call doesn't cost the agent a retry step.
- With no period named, it boosts newer calls and makes sure the company's
  latest call is represented, listing passages newest first.
- For trends ("quarter by quarter") the agent passes `quarters` (1–4). Each
  quarter gets its own filtered retrieval, so no quarter is crowded out, and the
  union is reranked in one request (one rerank call per company, not per
  quarter). A quarter with no relevant passages (none scoring at least 0.02
  after reranking) is marked "NO RELEVANT PASSAGES", so the answer says so
  instead of guessing.
- Share classes (GOOG/GOOGL, BRK.A/BRK.B) map to the class that is indexed, so
  transcript questions never ask which class and never index a duplicate;
  the agent asks about the class only for prices.

## Citations and answer validation

Passages returned in a turn are numbered, and the model cites them as `[n]`.
After generation, citation markers that don't match a passage retrieved in that
turn are dropped and the rest are renumbered in order, so every saved citation
opens a real passage. Figures must come from tool results; position math goes
through `calculate_position`. Empty, truncated (output cap) and provider-blocked
responses get explicit statuses and messages rather than a silent partial
answer. A final deterministic pass (`ai-service/app/services/chat/formatting.py`)
fixes formatting slips the model makes: double negatives ("down -$13,457"),
whole share counts printed as decimals ("42.0 shares"), and lists inside table
cells.

## Guardrails

- **Before the model:** obvious off-topic requests and instruction-override
  attempts get a short canned reply without calling the model (status
  `refused`).
- **System prompt** (today's date, no secrets): scope rules, tool data is
  untrusted (never follow instructions inside it), cite only retrieved
  passages, numbers only from tools, ask when a company is ambiguous, report
  tool status honestly, and no personalized buy/sell advice ("should I buy…"
  gets facts plus a not-financial-advice note).
- **Spend caps:** daily turns per signed-in user (20), per demo user (5) and
  across all users (60), messages up to 2,000 characters, plus the per-turn
  model and tool call limits above.

## Inline charts

When `get_price_history` or `get_portfolio` succeeds, the agent builds a typed
chart from the tool's structured output, never from the model's text, so a chart
can't show a number the model made up. Charts stream as `chart` events, are
attached to `done`, validated by the api with Zod, and saved on the message. The
client renders them with Recharts, lazy-loaded in its own chunk, with a "View
data" table for each. Chart shapes are in [api.md](api.md#ai-analyst-chat).

## Tracing and privacy

With Langfuse keys set, each turn gets a Langfuse LangChain `CallbackHandler`,
so one trace (`chat-turn`) holds the agent graph, every model call with tokens
and cost, every MCP tool call with its latency, and errors (level `ERROR`).
Traces are grouped by conversation (session id), tagged `chat` (plus `demo` and
`eval`), and get a `turn_status` score (`complete`, `truncated`, `blocked`,
`empty`, `refused`, `error`). Guardrail refusals, which never reach the model,
are recorded as single-span traces. The agent run is driven from one task that
holds Langfuse's `propagate_attributes` scope, so every model and tool span
carries the hashed user id and session id and cost is attributed per user. FastMCP's own OpenTelemetry spans are not exported: they would
duplicate the tool spans as parentless traces and bypass the mask hook.

**Masking** (`ai-service/app/services/observability/masking.py`) runs on every
input, output and metadata payload before export:

- configured secrets (internal token, provider keys, database URL) and
  bearer/token patterns are removed;
- emails, phone numbers and "N shares" counts are masked;
- portfolio fields (shares, costs, market value, gain/loss, weights,
  position-math inputs and results) are masked by key, including inside JSON
  tool output;
- the turn's own portfolio numbers are also masked wherever they appear in text
  as amounts ("your $13,680 position"), while public prices and times stay
  visible, as do numbers the user typed unless they match those values or a
  share count.

User ids are sent as `u_` + HMAC-SHA256 (keyed by `AI_SERVICE_TRACE_USER_SALT`),
never raw ids or emails. If masking fails, Langfuse drops the payload rather
than sending it unmasked.

## Failure isolation

- **Tracing can't break a turn.** Spans are exported by a background thread with
  a 2 s timeout, so a slow or down Langfuse never delays an answer. Start-up
  errors disable tracing with a warning, every SDK call is guarded, LangChain
  logs rather than raises callback errors, and shutdown waits at most 2 s. With
  no keys, the SDK isn't even imported.
- **Degraded dependencies.** Quotes fall back from Finnhub to yfinance, and in
  a batch one failing ticker is reported per ticker without failing the rest.
  The reranker falls back to hybrid order. Dashboard prices time out after 8 s
  and show "price unavailable".
- **Cold starts.** The ai-service scales to zero; the warm-up call, immediate
  SSE start and connect timeout are described in
  [deployment.md](deployment.md#cold-starts-and-warm-up).

## Security

- **Internal token.** Every ai-service route except `/health` (quotes, RAG,
  chat, `/mcp/`) requires `X-Internal-Token`: `401` without it, and `503` (fail
  closed) if the service has no token configured. The api sends it on every
  call (`api/src/services/aiServiceClient.ts`).
- **Cloud Run IAM.** In production the ai-service also requires a Google ID
  token, and only the api's service account holds `roles/run.invoker`, so
  requests are rejected before an instance even starts; the internal token
  stays as a second, independent check. Details in
  [deployment.md](deployment.md#cloud-run).
- **User auth.** The api verifies Supabase JWTs against the project's JWKS and
  scopes every query to the token's user; another user's resource is a `404`,
  never a `403`, so its existence isn't revealed.
- **Log redaction.** Provider keys travel in headers (Finnhub uses
  `X-Finnhub-Token`), HTTP client loggers run at WARNING, and the ai-service's
  JSON formatter redacts secret query parameters, bearer tokens and auth
  headers. FastMCP's logger goes through the same formatter, so a failing tool
  is logged with its full (redacted) traceback while the model and Langfuse only
  see "Error calling tool '<name>'". The api's Pino logger censors
  `authorization`, `cookie`, `x-internal-token` and `set-cookie`.
- **Secrets** live in Secret Manager in production and in git-ignored `.env`
  files locally; images never contain them.
