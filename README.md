# Equity Lens

[![CI](https://github.com/NMalpani17/equity-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/NMalpani17/equity-lens/actions/workflows/ci.yml)

AI-powered investment research platform. Equity Lens ingests market and company
data and uses LLM-driven analysis to help users research equities.

This is a **monorepo** with three independently runnable services that talk to
each other over HTTP.

```
Browser ──▶ client/ (React) ──▶ api/ (Express) ──▶ ai-service/ (FastAPI)
```

- **client** talks only to the API.
- **api** is the gateway; it orchestrates, persists holdings (Supabase/Prisma),
  and calls the AI service.
- **ai-service** owns market data (Finnhub + yfinance fallback) and all LLM /
  LangChain / MCP logic (added in later phases).

## Features

- **Portfolio tracking** — add, edit, and delete equity holdings and see a live
  dashboard with market value, gain/loss, and today's change per holding plus
  portfolio totals. (No login yet — auth comes in a later phase.)
- **Market data** — the AI service fetches quotes from **Finnhub** (primary) and
  automatically falls back to **yfinance** on failure or rate limiting, with a
  60-second cache and graceful handling of invalid tickers.

## Tech stack

| Part          | Stack                                                          | Port   |
| ------------- | -------------------------------------------------------------- | ------ |
| `client/`     | React 19, TypeScript, Vite, Tailwind CSS v4, shadcn/ui         | `5173` |
| `api/`        | Node.js, TypeScript, Express, Zod, Pino, Prisma (Supabase PG)  | `3001` |
| `ai-service/` | Python 3.12, FastAPI, Pydantic, Uvicorn, Finnhub + yfinance    | `8000` |

## Prerequisites

- Node.js 20+ and npm
- Python 3.12+
- Git
- A **Supabase** project (free tier) for the PostgreSQL database
- A free **Finnhub** API key ([finnhub.io](https://finnhub.io/dashboard))

## Setup & running locally

Each service runs in its own terminal. Copy the example env files first:

```bash
cp client/.env.example client/.env
cp api/.env.example api/.env
cp ai-service/.env.example ai-service/.env
```

> Never commit `.env` files — only `.env.example` is tracked. See `CLAUDE.md`.

Then fill in the required secrets in your new `.env` files:

- `ai-service/.env` → `AI_SERVICE_FINNHUB_API_KEY` (your Finnhub key).
- `api/.env` → `DATABASE_URL` (pooled) and `DIRECT_URL` (direct) from Supabase
  (**Project Settings → Database → Connection string**). Keep
  `?pgbouncer=true` on the pooled URL.

First-time setup (install dependencies once per service):

```bash
npm install                                   # repo root — Husky + concurrently

cd ai-service && python -m venv .venv         # create the Python virtualenv
.venv\Scripts\activate                        # Windows (PowerShell/cmd)
# source .venv/bin/activate                    # macOS/Linux
pip install -r requirements-dev.txt
deactivate && cd ..

npm --prefix api install                      # also runs `prisma generate`
npm --prefix api run prisma:migrate           # creates the holdings table (first run)
npm --prefix client install
```

### Run everything with one command

From the repo root, start all three services together:

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

You can also run a single service: `npm run dev:ai`, `npm run dev:api`, or
`npm run dev:client`.

### Running services individually

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

> `prisma:migrate` uses `DIRECT_URL`; the running app uses the pooled
> `DATABASE_URL`. Both must be set in `api/.env` before migrating.

### 3. client (React) — port 5173

```bash
cd client
npm install
npm run dev
```

Open http://localhost:5173. The home page shows the **portfolio dashboard**
(holdings, summary cards, and add/edit/delete), plus a **System health** card
that calls `api → ai-service` and reports the status of each hop.

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

## API reference

All API routes are served by the Express gateway under `http://localhost:3001`.

| Method   | Path                      | Description                                      |
| -------- | ------------------------- | ------------------------------------------------ |
| `GET`    | `/api/health`             | Health of the API and downstream AI service.     |
| `GET`    | `/api/holdings`           | List all holdings.                               |
| `POST`   | `/api/holdings`           | Create a holding (`ticker`, `shares`, `buyPrice`).|
| `GET`    | `/api/holdings/:id`       | Get one holding.                                 |
| `PATCH`  | `/api/holdings/:id`       | Update a holding.                                |
| `DELETE` | `/api/holdings/:id`       | Delete a holding.                                |
| `GET`    | `/api/portfolio/summary`  | Holdings enriched with live prices and totals.   |

The AI service (`http://localhost:8000`) exposes the market-data endpoints the
API consumes:

| Method | Path                     | Description                                    |
| ------ | ------------------------ | ---------------------------------------------- |
| `GET`  | `/quotes/{ticker}`       | One quote (`404` unknown, `502` unavailable).  |
| `GET`  | `/quotes?symbols=A,B`    | Batch quotes; per-ticker failures in `errors`. |

## Common scripts

| Service       | Lint            | Format             | Test            | Type-check          |
| ------------- | --------------- | ------------------ | --------------- | ------------------- |
| `client/`     | `npm run lint`  | `npm run format`   | `npm run test`  | `npm run typecheck` |
| `api/`        | `npm run lint`  | `npm run format`   | `npm run test`  | `npm run typecheck` |
| `ai-service/` | `ruff check .`  | `ruff format .`    | `pytest`        | (type hints)        |

## Repository layout

```
equity-lens/
├── CLAUDE.md          # project guide, rules, and code quality standards
├── README.md
├── client/            # React + TypeScript front end
├── api/               # Express + TypeScript API gateway
└── ai-service/        # FastAPI (Python) AI service
```

## Contributing

- **Branch per feature** (`feat/…`, `fix/…`, `chore/…`); never commit directly
  to `main`. Open a PR (a template is provided) and merge once **CI is green**.
- **Pre-commit hooks** run automatically. Set them up once:
  ```bash
  npm install            # repo root — installs Husky hooks + lint-staged
  pip install pre-commit # for the Python (Ruff) hook
  ```
  Husky + lint-staged format/lint staged JS/TS; Ruff handles Python.
- **CI** runs lint, typecheck, and tests for all three services on every push
  and PR.

## Conventions

- **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`), small commits.
- **No secrets in git** — only `.env.example` is tracked.
- Full engineering standards live in [`CLAUDE.md`](./CLAUDE.md).
