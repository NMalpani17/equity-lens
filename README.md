# Equity Lens

AI-powered investment research platform. Equity Lens ingests market and company
data and uses LLM-driven analysis to help users research equities.

This is a **monorepo** with three independently runnable services that talk to
each other over HTTP.

```
Browser ──▶ client/ (React) ──▶ api/ (Express) ──▶ ai-service/ (FastAPI)
```

- **client** talks only to the API.
- **api** is the gateway; it orchestrates and calls the AI service.
- **ai-service** owns all LLM / LangChain / MCP logic (added in later phases).

## Tech stack

| Part          | Stack                                                       | Port   |
| ------------- | ----------------------------------------------------------- | ------ |
| `client/`     | React 19, TypeScript, Vite, Tailwind CSS v4, shadcn/ui      | `5173` |
| `api/`        | Node.js, TypeScript, Express, Zod, Pino                     | `3001` |
| `ai-service/` | Python 3.12, FastAPI, Pydantic, Uvicorn                     | `8000` |

## Prerequisites

- Node.js 20+ and npm
- Python 3.12+
- Git

## Setup & running locally

Each service runs in its own terminal. Copy the example env files first:

```bash
cp client/.env.example client/.env
cp api/.env.example api/.env
cp ai-service/.env.example ai-service/.env
```

> Never commit `.env` files — only `.env.example` is tracked. See `CLAUDE.md`.

Start the services **bottom-up** (ai-service → api → client).

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
npm install
npm run dev
```

### 3. client (React) — port 5173

```bash
cd client
npm install
npm run dev
```

Open http://localhost:5173. The home page shows a **System health** card that
calls `api → ai-service` and reports the status of each hop.

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

## Conventions

- **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`), small commits.
- **No secrets in git** — only `.env.example` is tracked.
- Full engineering standards live in [`CLAUDE.md`](./CLAUDE.md).
