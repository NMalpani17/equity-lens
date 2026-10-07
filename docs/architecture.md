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
  to the user, enforces chat and report limits, stores holdings and conversations
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
read-only: `search_transcripts`, `compare_quarters` (quarter-over-quarter
"what changed", below), `get_quote`, `get_price_history`, `get_portfolio`,
`resolve_company` (name → ticker, period phrase → fiscal quarter) and
`calculate_position` (exact position math, so the model never does
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

**Freshness refresh.** Companies report every quarter, so an indexed ticker
slowly goes stale. When a search (the chat tool or `/rag/search`) hits a ticker
whose newest indexed call is older than `AI_SERVICE_RAG_FRESHNESS_DAYS` (90), a
background task asks Equibles for a newer call. Each ticker is checked at most
once per UTC day (`rag_tickers.freshness_checked_at`, claimed with one atomic
`UPDATE`, so concurrent searches and instances check once), and every check is
logged as a `rag_freshness_check` event with its outcome (`up_to_date`,
`refresh_started`, `refresh_cap_reached`, `already_indexing`, `error`, ...). If
a newer call exists, a `refresh` job goes through the same claim, advisory lock
and stale-job handling as any ingestion, but counts against its own daily cap
(`AI_SERVICE_RAG_DAILY_REFRESH_CAP`, default 3), so refreshes never use up the
new-ticker cap. The job is incremental: it fetches and embeds only the new
call, then deletes the vectors of the quarter that falls out of the latest
`AI_SERVICE_RAG_QUARTERS` (4) by its id prefix (`TICKER#FY2025Q1#`), after the
new ones are written. The search that triggered the check never waits for it:
a ticker that was indexed before is always searched from its existing vectors,
also while it shows `indexing` during a refresh. A failed refresh leaves the
ticker `indexed` (with `last_error`), and the next day's check tries again.

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

## Quarter-over-quarter comparison

"What changed in NVIDIA's latest call?" questions go to the `compare_quarters`
tool, backed by `QuarterComparisonService`
(`ai-service/app/services/rag/comparison.py`). The service has no chat
concepts (it returns passages grouped by theme and quarter as plain models in
`app/models/comparison.py`), so other consumers, such as a future multi-agent
report, can call it directly; the chat tool
(`app/services/chat/comparison.py`) adds share-class mapping, the usual
wait-for-indexing, turn citation ids and the model-facing text.

- **Quarters.** By default the latest indexed call is compared with the one
  before it; a requested pair (or one quarter, compared with the indexed call
  before it) is supported. If a transcript is missing, the previous indexed
  call is used and a note says so. A ticker that isn't indexed goes through the
  normal on-demand flow; one indexed quarter only, a quarter that isn't
  indexed, or the same quarter twice come back as clear statuses listing the
  indexed quarters.
- **Themes.** Guidance/outlook, demand and growth drivers, margins and costs,
  capital allocation, risks/headwinds and new initiatives, plus the user's
  focus (first, with more passages). Each theme gets its own filtered hybrid
  query **per quarter**, so neither quarter nor any theme crowds out another.
  The theme queries carry no company name, so their embeddings come from the
  query caches for every ticker and quarter. A passage belongs to the theme
  whose query ranked it highest.
- **Rerank budget.** Pinecone Starter allows 500 reranks a month, so each
  quarter's candidates (at most 7 themes × 6, under the reranker's 100-document
  limit) are reranked in **one** call against a combined query: at most two
  calls per comparison, none for a repeat within the rerank cache's TTL, and a
  hybrid-order fallback if the reranker is unavailable. Two passages are kept
  per theme per quarter (with a focus: three for the focus, one for the others).
- **No relevance cut.** Single-topic searches drop reranked passages scoring
  under 0.02, but against one combined multi-topic query the reranker scores
  everything low: in a live check on NVDA's FY2027 Q1 and Q2 calls, the best
  of 17 and 21 candidates scored 0.044 and 0.011, and substantive passages
  (margin guidance, demand commentary) scored 0.001–0.007. A 0.02 cut would
  have emptied whole quarters, so comparisons rely on the rerank order within
  each theme and the per-theme limits instead (boilerplate such as the IR
  welcome ranked below the kept passages).
- **Answer rules.** The system prompt routes "what changed" questions to the
  tool and asks for the headings New, Raised / improved, Lowered / worse, No
  longer mentioned and Unchanged, then Results vs guidance, in that order,
  using only those with content. Changes compare like with like: guidance
  with the earlier guidance for the same metric and period (next-quarter
  growth guided 14–17%, then 9–11%, is Lowered / worse), results with earlier
  results. A result measured against its guidance is never Raised or Lowered;
  it goes under Results vs guidance, worded met, beat or missed. Raised /
  improved and Lowered / worse are only for a value that itself changed
  between the quarters; a value that is the same in both (a reaffirmed tax
  rate) goes under Unchanged. A closing line names the empty change
  categories first, then the status ("Lowered / worse, No longer mentioned:
  nothing found in the retrieved passages."), and is left out when every
  change category has content. The rules live in one module
  (`ai-service/app/services/chat/comparison_rules.py`) shared with the
  research report's writer. Every claim cites a
  passage from the quarter it describes (a change cites both). A theme with no
  retrieved passage for a quarter is marked `NOT DISCUSSED IN THE RETRIEVED
PASSAGES`, and the model must say "not discussed in the retrieved passages",
  never that management dropped a topic. Likewise, items under "New" are
  described only as newly discussed in the retrieved passages, never as
  something that didn't happen or wasn't said in the earlier call. Forecasts
  keep management's wording.

## Research reports

A report is written by three specialized agents in a **fixed orchestration**,
a custom LangGraph `StateGraph` (`ai-service/app/services/report/graph.py`),
not a free-form supervisor: the edges never change and no model decides who
runs next.

```
            ┌─▶ transcript_researcher (Flash-Lite) ─┐
START ──────┤                                       ├──▶ writer (Flash, no tools) ──▶ END
            └─▶ market_analyst (Flash-Lite) ────────┘
```

| Agent                 | Model                   | Tools                                                                                  | Step limits (model / tool calls) | Output                                                                   |
| --------------------- | ----------------------- | -------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| Transcript researcher | `gemini-3.5-flash-lite` | `QuarterComparisonService` (no LLM step), then an agent loop with `search_transcripts` | 5 / 4                            | Notes on drivers, guidance, changes and risks, citing passage ids        |
| Market-data analyst   | `gemini-3.5-flash-lite` | `get_quote`, `get_price_history`                                                       | 3 / 3                            | Price notes; each tool result becomes a `[Dn]` data source and the chart |
| Writer                | `gemini-3.8-flash`      | none (structured output: six sections)                                                 | 1 model call                     | Summary, drivers, guidance, what changed, stock performance, risks       |

The two researchers start together; the writer waits for both. Each agent has
its own prompt (`ai-service/app/services/report/prompts.py`), its own tools
from the same MCP server as chat, and its own step limits. The writer sees
the researchers' notes, only the passages the notes cite (at most 24), and
the market data, and is told every number must appear in a source it cites.

**Validation.** Citations go through the chat's citation logic across all six
sections at once (one numbering for the whole report); a passage the writer
was never shown can't be cited, and unknown `[Dn]` refs are dropped. If the
market analyst fails, the report still ships with "Price data was unavailable
when this report was generated." in Stock performance; if the latest call has
no comparable earlier call, "What changed" says no comparable prior quarter is
available. Transcript research with no citable passages fails the report.

**One generation at a time.** `research_reports` has one row per ticker and
fiscal quarter. The ai-service claims the row before generating
(`generating_since`, `generation_id`), so two requests never run the same
report, even on different instances; the claim also refuses a report newer
than the 7-day regenerate window. The generation then runs as a background
task; the request's stream only relays its events, so a client that leaves
doesn't stop it (the ai-service runs with CPU always allocated, so the work
isn't throttled once the request ends). It saves the content, or releases the
claim as soon as a run fails or times out (240 s), or is cancelled when the
instance shuts down. A claim that lands after the client has already left
(during the claim itself) is released at once. A claim older than 10 minutes
(a crashed instance) can be taken over, and the old run can no longer save
over it.

**Caching and freshness.** A report is keyed by the newest indexed quarter
(`rag_tickers.quarters[0]`). Viewing a cached report reads one row; nothing
is generated. When a freshness refresh indexes a newer call, the key changes:
the api shows the previous report marked as covering an older quarter, and the
next generate request writes the new one. Reports are shared by every user, so
the content holds nothing user-specific: no portfolio, no user id, and times
in US market time.

**Who may generate** (the api, `api/src/services/reports.service.ts`): signed-in
users only (demo users view), not while a generation runs, not within 7 days
of the current report, 2 per user per UTC day (failed generations count),
and 3 units of the global daily cap (a chat turn is 1).
The caps are checked and the usage event written under one advisory lock. The
event is refunded only when nothing was generated: the ai-service couldn't be
reached, or refused because another generation won the race or the report had
just become fresh.

**Streaming.** The browser POSTs to the api, which streams `start`, then
`agent` events (`transcripts` / `market` / `writer`, each running then done or
failed, with a summary such as "13 passages from Q2 FY2027 and Q1 FY2027"),
then `done` with the report or `error`. A generation always finishes: if
the user leaves, the api keeps reading the ai-service's stream until the
report is saved, and the page says the report will be ready when they return.
When the tab becomes visible or regains focus the page refetches the list and
the open report, and while any report is generating it checks again every
10 s.

**Tracing.** Each report is one Langfuse trace (`research-report`, tagged
`report` and the ticker) with a span per agent (`transcript_researcher`,
`market_analyst`, `writer`) and one for `compare_quarters`, each holding its
model calls with tokens, cost and latency. The requester is a hashed user id,
the usual masking applies, and a `report_status` score records how it ended.

**Cost.** Measured on 2026-10-07: $0.018–0.025 per report (21–35K input, ~3K
output tokens across the three agents; 19–28 s). The pre-generate script and
the eval print a more conservative estimate ($0.053 typical, $0.124 at most)
before spending anything.

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
client renders them below the answer once it has finished streaming (so the
growing text never pushes a drawn chart down), with Recharts lazy-loaded in its
own chunk and a "View data" table for each. Chart shapes are in [api.md](api.md#ai-analyst-chat).

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
- **Row level security.** Supabase's Data API serves the `public` schema to
  anyone with the publishable key (it ships in the browser bundle). Every table
  there has RLS enabled with no policies, so the `anon` and `authenticated`
  roles can never read or write a row. The api and ai-service connect as the
  tables' owner, which bypasses RLS, and the browser never queries tables
  directly. Each new table's migration must enable RLS
  (`api/tests/repoPolicy.test.ts`).
- **Secrets** live in Secret Manager in production and in git-ignored `.env`
  files locally; images never contain them.
