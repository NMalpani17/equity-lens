# Equity Lens

[![CI](https://github.com/NMalpani17/equity-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/NMalpani17/equity-lens/actions/workflows/ci.yml)

AI investment research: track a portfolio and ask an analyst agent about
companies, earnings calls and your holdings, with every claim cited.

**Live demo: [equitylens-research.vercel.app](https://equitylens-research.vercel.app)**.
Click **Try demo**; no sign-up needed.

<p align="center">
  <img src="docs/images/dashboard.png" width="63%" alt="Portfolio dashboard in demo mode: total value, total gain/loss, today's change and holdings count above a table of AAPL, MSFT, TSLA and NVDA positions with expandable lots, average buy price, live price, market value and gains in green or red">
  <img src="docs/images/chat-answer.png" width="34%" alt="AI analyst answer to how NVIDIA's stock did over six months and what management said about data center demand: price figures, bullet points with inline citation markers from the latest earnings call, and a six-month NVDA price chart">
</p>

## Features

- **AI analyst chat.** Streamed answers about companies, earnings calls,
  markets and your portfolio, with inline citations that open the exact
  transcript passage. A LangGraph agent calls read-only tools over MCP:
  transcript search, quotes, price history, portfolio, company and fiscal-period
  resolution, and exact position math. It gives facts and trade-offs, never
  buy/sell advice.

  <p>
    <img src="docs/images/citation-source.png" width="44%" alt="Citation popover over a chat answer showing source [1]: the Nvidia Q2 FY2027 earnings call, dated 2026-08-26, prepared remarks by CFO Colette Kress, with the full quoted transcript passage">
    <img src="docs/images/guardrail.png" width="53%" alt="The analyst answering 'Should I sell my TSLA and buy more NVDA?' without a recommendation: a table of both positions, the concentration, realized-loss and reallocation figures, an allocation chart, and a not-financial-advice note">
  </p>

- **Earnings-call search (RAG).** Hybrid dense + keyword search over each
  company's last four earnings calls, reranked, with speaker and quarter on
  every passage. New tickers are indexed on demand, and a stale ticker picks
  up its newest call in the background without slowing the answer.
- **"What changed?" comparisons.** Compares a company's latest earnings call
  with the previous one (or any two indexed quarters), theme by theme:
  guidance, demand, margins, capital allocation, risks and new initiatives,
  plus an optional focus. Each claim is cited to the quarter it describes,
  and each comparison costs at most two rerank calls.
- **Charts in answers.** Price and allocation charts built only from tool data,
  never from numbers the model wrote. They stream in with the answer and are
  saved with the conversation.

  <img src="docs/images/portfolio-chat.png" width="600" alt="The analyst answering 'How is my portfolio allocated?' with a table of each holding's shares, market value, weight, gain/loss and return, a one-line insight, and a horizontal bar chart of portfolio weights">

- **Portfolio tracking.** Lots grouped into positions with average cost,
  gain/loss and today's change. Live quotes come from Finnhub, with a yfinance
  fallback.
- **Accounts and instant demo.** Supabase Auth with password reset and account
  deletion. "Try demo" gives each visitor a private sample portfolio.
- **Graceful degradation.** A status dot shows when the AI service is waking
  from a cold start. One failing ticker or service never breaks the page.

## Architecture

```mermaid
flowchart LR
  B[Browser] --> C["client<br/>React on Vercel"]
  C -->|HTTPS + Supabase JWT| A["api<br/>Express on Cloud Run"]
  A -->|Google ID token + internal token| S["ai-service<br/>FastAPI on Cloud Run, private"]
  A --> DB[(Supabase Postgres)]
  S --> DB
  S --> P[Pinecone]
  S --> G[Gemini]
  S --> F[Finnhub]
  S --> E[Equibles]
  S -.->|traces| L[Langfuse]
```

The React client talks only to the **api**, a public Express gateway that
verifies Supabase sessions, enforces daily limits, stores portfolios and
conversations, and streams chat over SSE. The **ai-service** owns all LLM, RAG
and market-data logic. It runs as a private Cloud Run service that only the
api's service account can invoke.

## Tech stack

| Area           | Technologies                                                         |
| -------------- | -------------------------------------------------------------------- |
| Client         | React 19, TypeScript, Vite, Tailwind CSS v4, shadcn/ui, Recharts     |
| API            | Node.js 22, Express, TypeScript, Zod, Prisma, Pino                   |
| AI service     | Python 3.12, FastAPI, LangGraph, FastMCP, Gemini, Pinecone, Pydantic |
| Data           | Supabase (Postgres, Auth), Pinecone, Equibles, Finnhub, yfinance     |
| Infrastructure | Vercel, Google Cloud Run, Artifact Registry, Secret Manager, Docker  |
| Quality        | Vitest, Pytest, ESLint, Ruff, GitHub Actions CI, Langfuse            |

## Engineering highlights

- **Grounded answers.** Every company claim must cite a passage retrieved in the
  same turn; citation markers that don't match a retrieved passage are dropped
  before the answer is saved. Every figure comes from a tool result, and
  position math goes through a calculator tool, never the model. On a labelled
  20-question retrieval set, the production setup (hybrid search + rerank over
  chunks with context headers) puts the right earnings call in the top 5 for
  all 20 questions, with MRR 0.94, vs hit@5 0.90 and MRR 0.71 for plain dense
  search. [Results](docs/evaluation.md#retrieval-results).
- **Evaluated with checks and a blind LLM judge.** 25 labelled questions run
  through the real agent. Each answer gets deterministic checks plus a rubric
  score from a judge that sees the answers anonymised and in shuffled order. In
  the recorded run (judge `gemini-3.1-pro-preview`), `gemini-3.8-flash` and
  `gemini-3.5-flash-lite` both passed 25/25 checks. Flash was more complete
  (5.00 vs 4.67) and was preferred 6 to 1 (11 ties); Flash-Lite cost about half
  per turn ($0.0028 vs $0.0059). Flash stays the default. Method and the
  judge-bias note are in [docs/evaluation.md](docs/evaluation.md#chat-evaluation).
- **Privacy-aware tracing.** Every chat turn is traced in Langfuse, including
  agent steps, tool calls with latency, and model calls with tokens and cost.
  User ids are hashed, and portfolio values, contact details and secrets are
  masked before export. Tracing is optional and can't slow or break a turn.

  <img src="docs/images/langfuse-trace.png" width="600" alt="Langfuse trace of one chat turn: the LangGraph tree of model calls and tool calls (resolve_company, get_price_history, search_transcripts) with per-step latency and cost, total latency, cost and tokens, a hashed user id, and the arguments and response of each tool call">

- **Guardrails.** Off-topic and prompt-injection requests are refused before
  the model runs. The agent gives facts rather than buy/sell advice, and daily
  per-user and global caps bound the spend.
- **Service-to-service auth.** The ai-service is deployed with
  `--no-allow-unauthenticated`. The api calls it with a cached Google ID token
  from the Cloud Run metadata server plus a separate internal-token header, and
  only the api's service account holds `roles/run.invoker`; direct calls get a 403.
- **Keyless continuous deployment.** After CI passes on `main`, GitHub
  Actions deploys only the service whose folder changed (ai-service before
  api), runs pending Prisma migrations first as a Cloud Run job, updates only
  the image, and fails unless `/api/live` returns 200. It signs in through
  Workload Identity Federation as a deployer limited to these two services, so
  there are no service account keys.
  [How it works and how to roll back](docs/deployment.md#continuous-deployment).
- **Cold-start handling.** The ai-service scales to zero. A rate-limited
  warm-up fires after sign-in, chat streams start immediately with SSE
  keepalives and a connect timeout, and both services shut down within Cloud
  Run's 10-second grace period.

## Run locally

Prerequisites: Node.js 22+, Python 3.12+, a Supabase project, and API keys for
Finnhub, Gemini, Pinecone and Equibles.

```bash
cp client/.env.example client/.env      # then fill in each .env
cp api/.env.example api/.env
cp ai-service/.env.example ai-service/.env

npm install                             # root: Husky + concurrently
cd ai-service && python -m venv .venv && .venv/Scripts/pip install -r requirements-dev.txt && cd ..
npm --prefix api install            # tables already exist; never migrate locally
npm --prefix client install

npm run dev                             # client :5173, api :3001, ai-service :8000
```

On macOS/Linux the venv's pip is `.venv/bin/pip`. The environment variables,
Supabase setup, transcript seeding and per-service commands are in
[docs/development.md](docs/development.md).

## Documentation

- [docs/development.md](docs/development.md): local setup, configuration,
  running the services, tests and scripts
- [docs/architecture.md](docs/architecture.md): how it works: request flow,
  agent and MCP tools, RAG pipeline, citations, guardrails, tracing and security
- [docs/evaluation.md](docs/evaluation.md): retrieval and chat evals: methods,
  how to run them, and results
- [docs/api.md](docs/api.md): API reference (gateway and ai-service)
- [docs/deployment.md](docs/deployment.md): Docker images, the Vercel, Cloud
  Run and Supabase setup, and continuous deployment
