# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## Project

**Equity Lens** is an AI-powered investment research platform. It ingests
market and company data and uses LLM-driven analysis to help users research
equities. This repo is a **monorepo** with three independently runnable parts
that talk to each other over HTTP.

## Architecture

```
Browser ──HTTP──▶ client/ (React)
                     │  fetch
                     ▼
                  api/ (Express)  ──HTTP──▶ ai-service/ (FastAPI)
```

- The **client** never calls the AI service directly. It only talks to the API.
- The **API** is the gateway/orchestrator. It calls the AI service.
- The **AI service** owns all LLM / LangChain / MCP logic.

The Phase 1 skeleton wires this up with a single health-check chain:
`client → GET /api/health → (Express) → GET /health → (FastAPI)`.

## Folder structure

```
equity-lens/
├── CLAUDE.md          # this file
├── README.md          # project overview + how to run locally
├── client/            # React + Vite + Tailwind + shadcn/ui  (port 5173)
├── api/               # Express, Node                        (port 3001)
└── ai-service/        # FastAPI, Python 3.12                 (port 8000)
```

## Tech stack

| Part         | Stack                                                                  |
| ------------ | ---------------------------------------------------------------------- |
| `client/`    | React 19, **TypeScript**, Vite, Tailwind CSS v4, shadcn/ui, Vitest      |
| `api/`       | Node.js, **TypeScript**, Express, Zod, Pino, Vitest                     |
| `ai-service/`| Python 3.12, FastAPI, Pydantic, Uvicorn, Pytest (LangChain/FastMCP later)|

## Ports

| Service      | URL                     |
| ------------ | ----------------------- |
| client       | http://localhost:5173   |
| api          | http://localhost:3001   |
| ai-service   | http://localhost:8000   |

## Running locally

Each service runs in its own terminal. Full details are in `README.md`.

```bash
# ai-service/
python -m venv .venv && .venv\Scripts\activate   # Windows
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# api/
npm install
npm run dev

# client/
npm install
npm run dev
```

## Rules

1. **Conventional Commits.** Use `feat:`, `fix:`, `chore:`, `docs:` (and scopes
   like `feat(client):`, `feat(api):`, `feat(ai-service):`). One logical change
   per commit.
2. **Commit after each small working step.** Prefer many small, working commits
   over one large one. Don't leave the tree broken between commits.
3. **Never commit secrets.** No `.env` files, API keys, or credentials are ever
   committed. Only `.env.example` (with placeholder values) is tracked. `.env`
   is already in `.gitignore` — keep it that way.

## Code Quality Standards

These apply to all code in this repo. If existing code violates them, refactor it.

- **Clean, modular structure.** Keep `routes`, `controllers`, `services`, and
  `models` in separate files/folders. Each layer has one responsibility.
- **Typed everywhere.** TypeScript for `client/` and `api/`; type hints and
  Pydantic models for `ai-service/`. No implicit `any`.
- **Lint & format.** ESLint + Prettier for JS/TS; Ruff for Python. Code must be
  clean before commit.
- **Environment-based config.** No hardcoded URLs, ports, or secrets — read them
  from env vars with sensible defaults in one config module per service.
- **Centralized error handling + input validation.** One error-handling layer
  per service. Validate all external input: **Zod** in Express, **Pydantic** in
  FastAPI.
- **Structured logging.** JSON-friendly structured logs (Pino in Node, stdlib
  `logging`/structured logs in Python). No stray `console.log` / `print` in app code.
- **Readable code.** Meaningful names, small single-purpose functions, comments
  only where the logic isn't self-evident.
- **Tests for key logic.** Vitest for JS/TS, Pytest for Python. Cover the
  important paths, not trivia.
- **Principles.** Follow SOLID and REST API best practices (proper verbs, status
  codes, resource-oriented routes).

## Conventions

- The client reads the API base URL from `VITE_API_URL`.
- The API reads the AI service base URL from `AI_SERVICE_URL`.
- Every service exposes `GET /health` returning JSON `{ "status": "ok", ... }`.
- Config lives in a single module per service (`api/src/config.ts`,
  `ai-service/app/config.py`); nothing reads `process.env` / `os.environ` directly
  elsewhere.
