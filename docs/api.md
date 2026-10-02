# API reference

All application routes are served by the Express gateway at
`http://localhost:3001`. The client only ever talks to this gateway.

## API gateway (`http://localhost:3001`)

| Method   | Path                              | Description                                                     |
| -------- | --------------------------------- | --------------------------------------------------------------- |
| `GET`    | `/api/health`                     | Health of the API and downstream AI service.                    |
| `GET`    | `/api/holdings`                   | List all holdings (lots).                                       |
| `POST`   | `/api/holdings`                   | Create a lot (`ticker`, `shares`, `buyPrice`, `purchaseDate?`). |
| `GET`    | `/api/holdings/:id`               | Get one holding.                                                |
| `PATCH`  | `/api/holdings/:id`               | Update a holding.                                               |
| `DELETE` | `/api/holdings/:id`               | Delete one lot.                                                 |
| `DELETE` | `/api/holdings?ticker=X`          | Delete a whole position (every lot for a ticker).               |
| `GET`    | `/api/portfolio/summary`          | Positions (lots grouped by ticker) with live prices + totals.   |
| `DELETE` | `/api/account`                    | Delete the authenticated user's account and all their data.     |
| `POST`   | `/api/rag/search`                 | Search earnings call transcripts (hybrid + rerank).             |
| `GET`    | `/api/conversations`              | The user's chat conversations, most recent first.               |
| `POST`   | `/api/conversations`              | Start a conversation (`title?`).                                |
| `PATCH`  | `/api/conversations/:id`          | Rename a conversation (`title`).                                |
| `DELETE` | `/api/conversations/:id`          | Delete a conversation and its messages.                         |
| `GET`    | `/api/conversations/:id/messages` | Messages with citations and tool calls.                         |
| `POST`   | `/api/conversations/:id/messages` | Send a message; the reply streams as SSE.                       |
| `GET`    | `/api/chat/usage`                 | Today's message allowance (`used`, `limit`, `remaining`).       |
| `GET`    | `/api/rag/tickers`                | Every ticker indexed (or attempted) for transcript search.      |
| `GET`    | `/api/rag/tickers/:ticker`        | Indexing status for one ticker (poll while `indexing`).         |

### Authentication

All `/api/holdings`, `/api/portfolio`, `/api/account` and `/api/rag` routes require a **Supabase access
token** sent as a bearer header:

```
Authorization: Bearer <supabase-access-token>
```

The gateway verifies the token against the Supabase project's JWKS (configured
via `SUPABASE_URL`) and scopes every query to the token's user. A missing or
invalid token returns `401` `unauthorized`. Every holding is owned by a user;
requesting or editing another user's holding returns `404` (never `403`, so the
existence of others' data isn't revealed). `/api/health` is public.

**Account deletion:** `DELETE /api/account` removes the user's holdings and
`demo_seeds` row in a transaction, then deletes the Supabase auth user via the
Admin API (using the server-only `SUPABASE_SERVICE_ROLE_KEY`). It returns `204`.

**Demo users:** anonymous ("Try demo") tokens carry an `is_anonymous` claim. The
first time such a user lists holdings or loads the portfolio summary, the API
seeds a sample portfolio for them, so the demo dashboard is never empty. Seeding
happens exactly once per user (tracked in a `demo_seeds` table), so a demo user
who deletes every holding is not re-seeded on the next load.

Notes:

- `purchaseDate` is an optional ISO date (`YYYY-MM-DD`) and must not be in the
  future.
- Ticker symbols are normalized to uppercase. Creating (or changing) a ticker
  validates it against the market data service; unknown symbols return `422`
  `invalid_ticker`. A transient market-data outage does not block the write.
- Validation failures return `422`; unknown resources return `404`; missing or
  invalid auth returns `401`.

## Transcript search (RAG)

Searches the last four earnings call transcripts of indexed tickers. Ten large
caps (AAPL, MSFT, NVDA, AMZN, GOOGL, META, TSLA, JPM, NFLX, AMD) are pre-seeded.

### `POST /api/rag/search`

```json
{
  "query": "What did management say about EBITDA margins?",
  "ticker": "AAPL",
  "fiscalYear": 2025,
  "fiscalQuarter": 3,
  "topK": 5
}
```

Only `query` is required. `ticker`, `fiscalYear` and `fiscalQuarter` are
applied as metadata filters inside the vector query (pre-filtering). `topK` is
1–20 (default 5). Fiscal years/quarters follow each company's own fiscal
calendar.

**`200`** — results, best first:

```json
{
  "status": "ok",
  "query": "What did management say about EBITDA margins?",
  "filters": { "ticker": "AAPL", "fiscalYear": 2025, "fiscalQuarter": 3 },
  "reranked": true,
  "candidateCount": 25,
  "latencyMs": 412.7,
  "results": [
    {
      "id": "AAPL#FY2025Q3#0042",
      "text": "…original transcript text…",
      "score": 0.91,
      "retrievalScore": 0.63,
      "rerankScore": 0.91,
      "ticker": "AAPL",
      "companyName": "Apple Inc",
      "fiscalYear": 2025,
      "fiscalQuarter": 3,
      "callDate": "2025-07-31",
      "speaker": "Kevan Parekh",
      "role": "CFO",
      "section": "qa",
      "chunkIndex": 42,
      "contextHeader": "AAPL (Apple Inc) · Q3 FY2025 earnings call · 2025-07-31 · Q&A · Kevan Parekh, CFO"
    }
  ]
}
```

- `score` is the rerank score when `reranked` is `true`, otherwise the hybrid
  retrieval score. If the reranker fails or its monthly quota is exhausted the
  search still succeeds in hybrid order with `reranked: false`.
- `section` is `prepared_remarks` or `qa`. `speaker` falls back to the role
  (e.g. `Analyst`) when Equibles does not identify the speaker by name.

**`202`** — the ticker is not indexed yet. Ingestion has started in the
background (or was already running); poll `pollUrl` and search again once it
reports `indexed` (typically well under a minute):

```json
{
  "status": "indexing",
  "ticker": "CRM",
  "jobId": "1b0c…",
  "message": "CRM transcripts are being indexed; …",
  "pollUrl": "/api/rag/tickers/CRM"
}
```

Errors: `422` validation; `404` `transcripts_unavailable` (no transcripts exist
for the ticker; not retried automatically); `429` `ingestion_cap_reached` (the
daily cap on new tickers — default 8 per UTC day — is used up; the body includes
`cap` and `resetsAt`); `503` `rag_not_configured`; `502` upstream failure.

### `GET /api/rag/tickers/:ticker`

```json
{
  "ticker": "CRM",
  "status": "indexing",
  "companyName": null,
  "chunkCount": 0,
  "quarters": [],
  "indexedAt": null,
  "lastError": null,
  "job": {
    "id": "1b0c…",
    "status": "running",
    "trigger": "on_demand",
    "error": null,
    "createdAt": "2026-09-30T18:02:11.120",
    "startedAt": "2026-09-30T18:02:11.480",
    "finishedAt": null
  }
}
```

`status` is one of `not_indexed`, `indexing`, `indexed`, `failed` (a later
search retries) or `unavailable`. `GET /api/rag/tickers` returns
`{ "tickers": [...] }` with the same shape (without `job`).

## AI analyst chat

All chat routes require auth and are scoped to the user (another user's
conversation is a `404`). Deleting an account deletes its conversations.

### `POST /api/conversations/:id/messages`

Body: `{ "content": "What did NVIDIA say about Vera Rubin timing last quarter?" }`
(1–2,000 characters).

Errors before streaming starts are normal JSON errors:

| Status | `error`                                    | When                                                                          |
| ------ | ------------------------------------------ | ----------------------------------------------------------------------------- |
| `422`  | `validation_error`                         | Empty, or over 2,000 characters ("Messages are limited to 2000 characters."). |
| `404`  | `not_found`                                | Not the user's conversation.                                                  |
| `409`  | `turn_in_progress`                         | A reply is still streaming in this conversation (no overlapping turns).       |
| `429`  | `chat_limit_reached`                       | Daily cap reached; body has `scope` (`user`/`global`), `limit`, `resetsAt`.   |
| `503`  | `chat_unavailable` / `chat_not_configured` | The ai-service is down or not configured.                                     |

Daily caps (user messages per UTC day, configurable): **20** for signed-in users,
**5** for demo (anonymous) users, and **60** across all users.

On success the response is `text/event-stream`:

| Event        | Data                                                                            |
| ------------ | ------------------------------------------------------------------------------- |
| `turn`       | `{ conversation, userMessage, assistantMessageId }` (the saved user message).   |
| `tool_start` | `{ id, name, label, args }`, e.g. label `"Searching NVDA transcripts…"`.        |
| `tool_end`   | `{ id, name, ok, summary }`, e.g. `"Found 5 passages"`.                         |
| `token`      | `{ text }` — answer text as it is generated (reset by the next `tool_start`).   |
| `error`      | `{ code, message, retryable }`, e.g. `ai_credits_exhausted`, `ai_rate_limited`. |
| `done`       | `{ message }` — the saved assistant message (always last).                      |

A saved assistant message:

```json
{
  "id": "…",
  "role": "assistant",
  "content": "NVIDIA expects Vera Rubin to be the fastest ramp in its history [1].",
  "status": "complete",
  "citations": [
    {
      "id": 1,
      "ticker": "NVDA",
      "companyName": "Nvidia Corp",
      "fiscalYear": 2027,
      "fiscalQuarter": 2,
      "callDate": "2026-08-26",
      "speaker": "Colette Kress",
      "role": "CFO",
      "section": "prepared_remarks",
      "text": "…the retrieved passage…"
    }
  ],
  "toolCalls": [
    {
      "id": "…",
      "name": "search_transcripts",
      "label": "Searching NVDA transcripts…",
      "ok": true,
      "summary": "Found 5 passages"
    }
  ],
  "errorCode": null,
  "createdAt": "…"
}
```

- `status`: `complete`, `truncated` (hit the output-token cap), `blocked`
  (provider safety block), `empty` (no answer produced), `refused` (off-topic or
  instruction-override attempt, answered with a short redirect), `interrupted`
  (the client disconnected or pressed Stop; the partial text is kept) or `error`.
- Citations only reference passages retrieved in that turn; markers the model
  invents are dropped and the rest are renumbered in order.
- If the client disconnects mid-stream, the gateway aborts the upstream call
  (cancelling the model request) and saves the partial reply as `interrupted`.

## AI service (`http://localhost:8000`)

Internal only: every route except `/health` requires the gateway's
`X-Internal-Token` header (`/mcp/` takes it as a bearer token). Missing or
wrong tokens get `401` `unauthorized`; if the service has no token
configured it fails closed with `503`.

The market-data endpoints the API consumes directly:

| Method | Path                  | Description                                    |
| ------ | --------------------- | ---------------------------------------------- |
| `GET`  | `/health`             | Service health.                                |
| `GET`  | `/quotes/{ticker}`    | One quote (`404` unknown, `502` unavailable).  |
| `GET`  | `/quotes?symbols=A,B` | Batch quotes; per-ticker failures in `errors`. |

Transcript search (same semantics as the gateway routes above, snake_case JSON):

| Method | Path                    | Description                                                               |
| ------ | ----------------------- | ------------------------------------------------------------------------- |
| `POST` | `/rag/search`           | `{query, ticker?, fiscal_year?, fiscal_quarter?, top_k}` → `200` / `202`. |
| `GET`  | `/rag/tickers`          | All tracked tickers and their status.                                     |
| `GET`  | `/rag/tickers/{ticker}` | One ticker's status and latest ingestion job.                             |

Chat and MCP:

| Method | Path           | Description                                                                                              |
| ------ | -------------- | -------------------------------------------------------------------------------------------------------- |
| `POST` | `/chat/stream` | One chat turn as SSE (`X-Internal-Token`). Body: `{user_id, is_anonymous, message, history, portfolio}`. |
| any    | `/mcp/`        | The analyst tools over MCP (streamable HTTP), `Authorization: Bearer <internal token>`.                  |

`/chat/stream` emits `token`, `tool_start`, `tool_end`, `done` (`content`,
`status`, `citations`, `tool_calls`, `usage`, `model`) and `error` events. The
user id comes from the gateway's verified JWT; the ai-service never accepts one
from a browser. History is trimmed to the last 6 final answers (~3K tokens) and
never includes past tool results.

Quotes come from Finnhub with an automatic yfinance fallback. In a batch, a
single failing ticker is isolated: valid tickers still return quotes, and the
failures are reported per-ticker in the `errors` map.

## Health check

The health endpoint exercises the full chain:

```
client → GET http://localhost:3001/api/health → GET http://localhost:8000/health
```

```bash
curl http://localhost:3001/api/health
# {"status":"ok","service":"equity-lens-api","version":"0.1.0",
#  "dependencies":{"aiService":{"status":"ok", ...}}}
```

If the AI service is down, the API responds `503` with `status: "degraded"`.
