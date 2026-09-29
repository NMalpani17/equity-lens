# Development

Local setup, running services, and common scripts. For a fast path, see the
[Quick start](../README.md#quick-start) in the README.

## Prerequisites

- Node.js 20+ and npm
- Python 3.12+
- Git
- A **Supabase** project (free tier) for the PostgreSQL database
- A free **Finnhub** API key ([finnhub.io](https://finnhub.io/dashboard))

## Environment files

Copy the example env files, then fill in the secrets:

```bash
cp client/.env.example client/.env
cp api/.env.example api/.env
cp ai-service/.env.example ai-service/.env
```

- `ai-service/.env` → `AI_SERVICE_FINNHUB_API_KEY` (your Finnhub key).
- `api/.env` → `DATABASE_URL` (pooled) and `DIRECT_URL` (direct) from Supabase
  (**Project Settings → Database → Connection string**). Keep `?pgbouncer=true`
  on the pooled URL. Also set `SUPABASE_URL` (**Project Settings → Data API →
  Project URL**), used to verify user JWTs. `DEMO_USER_ID` is only needed to seed
  the demo account (see below).
- `client/.env` → `VITE_SUPABASE_URL` (same Project URL) and
  `VITE_SUPABASE_PUBLISHABLE_KEY` (**Project Settings → API Keys → publishable /
  anon key**). For the "Try demo" button, also set `VITE_DEMO_EMAIL` and
  `VITE_DEMO_PASSWORD`.

> Never commit `.env` files — only `.env.example` is tracked. See `CLAUDE.md`.

## Supabase Auth setup

Authentication uses Supabase Auth. In the Supabase dashboard:

1. **Authentication → Providers → Email:** enable it. For local dev, turn off
   "Confirm email" so a sign-up logs in immediately (otherwise users must click
   the email link before a session is issued).
2. The API verifies access tokens against the project's **JWKS**, so the project
   must use asymmetric JWT signing keys (the default for new projects; legacy
   projects can migrate under **Project Settings → JWT Keys**).
3. **Demo account (optional):** create one user under **Authentication → Users**.
   Put its email/password in `client/.env` (`VITE_DEMO_*`) and its **User UID**
   in `api/.env` as `DEMO_USER_ID`, then run `npm run db:seed` (below) to give it
   sample holdings.

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
npm --prefix api run db:seed                   # optional: demo holdings (needs DEMO_USER_ID)
npm --prefix client install
```

> `prisma:migrate` uses `DIRECT_URL`; the running app uses the pooled
> `DATABASE_URL`. Both must be set in `api/.env` before migrating.
>
> `db:seed` populates the demo account's sample holdings and is idempotent
> (re-running replaces them). It requires `DEMO_USER_ID` in `api/.env`.

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
that calls `api → ai-service` and reports the status of each hop. For health and
API details, see [api.md](./api.md).

## Common scripts

| Service       | Lint           | Format           | Test           | Type-check          |
| ------------- | -------------- | ---------------- | -------------- | ------------------- |
| `client/`     | `npm run lint` | `npm run format` | `npm run test` | `npm run typecheck` |
| `api/`        | `npm run lint` | `npm run format` | `npm run test` | `npm run typecheck` |
| `ai-service/` | `ruff check .` | `ruff format .`  | `pytest`       | (type hints)        |

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
