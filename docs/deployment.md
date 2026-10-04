# Deployment

Production layout:

```
Browser ──▶ client (Vercel, static) ──▶ api (Cloud Run) ──▶ ai-service (Cloud Run)
                                            │                    │
                                     Supabase Postgres ◀─────────┘ (+ Pinecone, Gemini, Equibles, Finnhub)
```

- **client** — static Vite build on Vercel.
- **api** — Docker image on Cloud Run, **request-based billing**, startup CPU
  boost.
- **ai-service** — Docker image on Cloud Run, **instance-based billing**,
  min instances 0, startup CPU boost.
- **Database** — the existing Supabase project; tables are owned by the api's
  Prisma migrations.

Deploy order for a release that changes the schema: **migrations → ai-service →
api → client**. Otherwise any order works; the api tolerates a missing or cold
ai-service.

## Docker images

Both Dockerfiles are multi-stage, use digest-pinned `bookworm-slim` base
images, and run as a non-root user. Build contexts are allow-listed by each
`.dockerignore`, so `.env` files never enter an image.

```bash
# from the repo root
docker build -t equity-lens-ai-service ai-service
docker build -t equity-lens-api api
docker build -t equity-lens-api-migrate --target migrate api   # migrations job

# run locally (the containers read PORT; defaults are 8000 / 3001)
docker network create el-net
docker run --rm --name el-ai --network el-net -p 8000:8000 --env-file ai-service/.env equity-lens-ai-service
docker run --rm --name el-api --network el-net -p 3001:3001 --env-file api/.env \
  -e AI_SERVICE_URL=http://el-ai:8000 equity-lens-api
curl localhost:3001/api/live && curl localhost:3001/api/health
```

| Image       | Size    | Notes                                                                                                                                                 |
| ----------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| ai-service  | ~543 MB | Python 3.12. Dependencies from `requirements.lock` with `--no-deps` (no resolver drift). Most of the size is pandas/numpy (yfinance).                 |
| api         | ~368 MB | Node 22. Built with dev dependencies; ships production dependencies and the generated Prisma client only (the Prisma CLI and TypeScript are dropped). |
| api migrate | ~703 MB | Full dev dependencies, including the Prisma CLI; run as a one-off job, never serves traffic.                                                          |

Measured locally (Docker Desktop): the ai-service container is healthy ~4 s
after start, uses ~172 MiB idle and ~202 MiB after a chat turn, and stops in
~1 s on SIGTERM; the api stops in under 1 s.

**Updating Python dependencies**: edit `ai-service/requirements.txt`, then
regenerate the lock inside the base image (Linux wheels):

```bash
cd ai-service
docker run --rm -v "$PWD/requirements.txt:/tmp/requirements.txt:ro" \
  python:3.12-slim-bookworm sh -c \
  "pip install -q -r /tmp/requirements.txt >/dev/null && pip freeze" > requirements.lock.new
# keep the 3 header comment lines from requirements.lock, then replace it
```

## Environment variables

Secrets belong in Secret Manager (Cloud Run `--set-secrets`) and Vercel's
encrypted env vars, never in an image or the repo. "Secret" below means it must
be stored that way.

### api (Cloud Run)

| Name                           | Purpose                                                                                                  | Required                         | Secret  | Production value / source                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                     | Runtime mode                                                                                             | Yes                              | No      | `production` (set in the image)                                                                                             |
| `PORT`                         | Listen port                                                                                              | Set by Cloud Run                 | No      | Injected by Cloud Run (`8080`); do not set                                                                                  |
| `LOG_LEVEL`                    | Pino log level                                                                                           | No (`info`)                      | No      | `info`                                                                                                                      |
| `AI_SERVICE_URL`               | ai-service base URL                                                                                      | Yes                              | No      | The ai-service Cloud Run URL, `https://equity-lens-ai-service-….run.app`                                                    |
| `AI_SERVICE_INTERNAL_TOKEN`    | Shared secret on every api → ai-service call (`X-Internal-Token`)                                        | Yes                              | **Yes** | `python -c "import secrets; print(secrets.token_urlsafe(48))"`; same value in both                                          |
| `AI_SERVICE_ID_TOKEN_AUDIENCE` | Audience of the Google ID token sent as `Authorization: Bearer` on every ai-service call (Cloud Run IAM) | Yes in production; empty locally | No      | The ai-service's Cloud Run URL, exactly as `AI_SERVICE_URL` (`https://equity-lens-ai-service-….run.app`)                    |
| `CLIENT_ORIGIN`                | CORS: comma-separated exact origins (no wildcards)                                                       | Yes                              | No      | `https://equitylens-research.vercel.app,http://localhost:5173` (production client, plus local dev against the deployed api) |
| `DATABASE_URL`                 | Supabase **pooled** URL (port 6543, `?pgbouncer=true`)                                                   | Yes                              | **Yes** | Supabase → Project Settings → Database → Connection string (Transaction pooler)                                             |
| `DIRECT_URL`                   | Supabase direct/session URL (port 5432), used by migrations                                              | Yes (validated at start)         | **Yes** | Supabase → Connection string (Session pooler or direct)                                                                     |
| `SUPABASE_URL`                 | Verifies user JWTs (JWKS, issuer)                                                                        | Yes                              | No      | `https://<project-ref>.supabase.co`                                                                                         |
| `SUPABASE_SERVICE_ROLE_KEY`    | Admin key (deletes auth users on account deletion)                                                       | Yes                              | **Yes** | Supabase → Project Settings → API Keys → `service_role`                                                                     |
| `CHAT_DAILY_LIMIT`             | Turns per signed-in user per UTC day                                                                     | No (`20`)                        | No      | `20`                                                                                                                        |
| `CHAT_DAILY_LIMIT_ANON`        | Turns per demo (anonymous) user per UTC day                                                              | No (`5`)                         | No      | `5`                                                                                                                         |
| `CHAT_GLOBAL_DAILY_LIMIT`      | Turns across all users per UTC day (Gemini budget)                                                       | No (`60`)                        | No      | `60`                                                                                                                        |
| `CHAT_MAX_MESSAGE_CHARS`       | Max characters per message                                                                               | No (`2000`)                      | No      | `2000`                                                                                                                      |
| `CHAT_HISTORY_MESSAGES`        | Prior final answers sent as context                                                                      | No (`6`)                         | No      | `6`                                                                                                                         |
| `CHAT_HISTORY_TOKENS`          | Token budget for that context                                                                            | No (`3000`)                      | No      | `3000`                                                                                                                      |
| `CHAT_CONNECT_TIMEOUT_MS`      | Wait for the ai-service to start answering (covers a cold start)                                         | No (`30000`)                     | No      | `30000`                                                                                                                     |
| `CHAT_KEEPALIVE_MS`            | SSE keepalive comment interval during a turn                                                             | No (`10000`)                     | No      | `10000`                                                                                                                     |

### ai-service (Cloud Run)

Required and production-relevant settings:

| Name                             | Purpose                                                          | Required                           | Secret  | Production value / source                   |
| -------------------------------- | ---------------------------------------------------------------- | ---------------------------------- | ------- | ------------------------------------------- |
| `PORT`                           | Listen port (read by the container's uvicorn command)            | Set by Cloud Run                   | No      | Injected (`8080`); do not set               |
| `AI_SERVICE_INTERNAL_TOKEN`      | Required on every route except `/health` (fails closed if unset) | **Yes**                            | **Yes** | Same value as the api's                     |
| `AI_SERVICE_GEMINI_API_KEY`      | Chat model and embeddings                                        | **Yes**                            | **Yes** | Google AI Studio (billing enabled)          |
| `DATABASE_URL`                   | RAG tables (pooled URL; `AI_SERVICE_DATABASE_URL` also works)    | **Yes**                            | **Yes** | Same pooled URL as the api's `DATABASE_URL` |
| `AI_SERVICE_PINECONE_API_KEY`    | Vector index and reranking                                       | **Yes**                            | **Yes** | app.pinecone.io                             |
| `AI_SERVICE_EQUIBLES_API_KEY`    | Transcripts for indexing new tickers                             | Yes (on-demand indexing)           | **Yes** | equibles.com dashboard                      |
| `AI_SERVICE_FINNHUB_API_KEY`     | Quotes (yfinance fallback) and company-name search               | Yes (name lookups degrade without) | **Yes** | finnhub.io dashboard                        |
| `AI_SERVICE_ENVIRONMENT`         | Environment label in logs and traces                             | No (`production` in the image)     | No      | `production`                                |
| `AI_SERVICE_LOG_LEVEL`           | Log level                                                        | No (`INFO`)                        | No      | `INFO`                                      |
| `AI_SERVICE_CORS_ORIGINS`        | CORS (only the api calls this service, server to server)         | No                                 | No      | Not set (server-to-server calls skip CORS)  |
| `AI_SERVICE_LANGFUSE_PUBLIC_KEY` | Tracing (off unless both keys are set)                           | No                                 | No      | Langfuse → Project Settings → API Keys      |
| `AI_SERVICE_LANGFUSE_SECRET_KEY` | Tracing                                                          | No                                 | **Yes** | Same                                        |
| `AI_SERVICE_LANGFUSE_BASE_URL`   | Langfuse host                                                    | No (`https://cloud.langfuse.com`)  | No      | Your Langfuse region URL                    |
| `AI_SERVICE_TRACE_USER_SALT`     | HMAC key for hashed user ids in traces                           | No (recommended with tracing)      | **Yes** | Any random string; keep it stable           |

Tuning settings (all optional; defaults shown):

| Name                                                                                                 | Default                                                       |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `AI_SERVICE_CHAT_MODEL`                                                                              | `google_genai:gemini-3.8-flash`                               |
| `AI_SERVICE_CHAT_THINKING_LEVEL`                                                                     | `low`                                                         |
| `AI_SERVICE_CHAT_MAX_OUTPUT_TOKENS` / `_TIMEOUT_SECONDS`                                             | `2048` / `60`                                                 |
| `AI_SERVICE_CHAT_MAX_MODEL_CALLS` / `_MAX_TOOL_CALLS`                                                | `6` / `8`                                                     |
| `AI_SERVICE_CHAT_MAX_MESSAGE_CHARS`                                                                  | `2000`                                                        |
| `AI_SERVICE_CHAT_HISTORY_MAX_MESSAGES` / `_HISTORY_MAX_TOKENS`                                       | `6` / `3000`                                                  |
| `AI_SERVICE_CHAT_SEARCH_TOP_K` / `_INDEX_WAIT_SECONDS`                                               | `5` / `45`                                                    |
| `AI_SERVICE_LANGFUSE_SAMPLE_RATE` / `_TIMEOUT_SECONDS` / `_FLUSH_INTERVAL_SECONDS`                   | `1.0` / `2` / `5`                                             |
| `AI_SERVICE_SHUTDOWN_INGESTION_TIMEOUT_SECONDS` / `_SHUTDOWN_TRACING_TIMEOUT_SECONDS`                | `3` / `2`                                                     |
| `AI_SERVICE_FINNHUB_BASE_URL`, `_MARKET_CACHE_TTL_SECONDS`, `_MARKET_HTTP_TIMEOUT_SECONDS`           | `https://finnhub.io/api/v1`, `60`, `5`                        |
| `AI_SERVICE_EQUIBLES_BASE_URL`, `_EQUIBLES_TIMEOUT_SECONDS`                                          | `https://api.equibles.com/v1`, `20`                           |
| `AI_SERVICE_DB_POOL_MAX_SIZE`                                                                        | `5`                                                           |
| `AI_SERVICE_GEMINI_EMBEDDING_MODEL`, `_EMBEDDING_DIMENSION`, `_EMBEDDING_BATCH_SIZE`                 | `gemini-embedding-001`, `768`, `100`                          |
| `AI_SERVICE_GEMINI_EMBED_TEXTS_PER_MINUTE`, `_GEMINI_EMBED_TOKENS_PER_MINUTE`                        | `100`, `24000`                                                |
| `AI_SERVICE_PINECONE_INDEX_NAME`, `_CLOUD`, `_REGION`                                                | `equity-lens-transcripts`, `aws`, `us-east-1`                 |
| `AI_SERVICE_PINECONE_NAMESPACE`, `_PLAIN_NAMESPACE`                                                  | `transcripts`, `transcripts-noctx`                            |
| `AI_SERVICE_PINECONE_SPARSE_MODEL`, `_RERANK_MODEL`                                                  | `pinecone-sparse-english-v0`, `bge-reranker-v2-m3`            |
| `AI_SERVICE_SPARSE_BATCH_SIZE`, `_UPSERT_BATCH_SIZE`                                                 | `96`, `100`                                                   |
| `AI_SERVICE_RAG_QUARTERS`, `_CHUNK_TOKENS`, `_CHUNK_OVERLAP_TOKENS`, `_CANDIDATE_K`, `_HYBRID_ALPHA` | `4`, `400`, `60`, `25`, `0.75`                                |
| `AI_SERVICE_RAG_DAILY_INGESTION_CAP`, `_STALE_JOB_MINUTES`, `_INGESTION_WORKERS`                     | `8`, `30`, `2`                                                |
| `AI_SERVICE_RAG_QUERY_CACHE_SIZE`, `_QUERY_CACHE_TTL_SECONDS`                                        | `512`, `3600`                                                 |
| `AI_SERVICE_RAG_MAX_RETRIES`, `_RETRY_BASE_SECONDS`, `_RETRY_MAX_SECONDS`                            | `5`, `1.0`, `30`                                              |
| `AI_SERVICE_APP_NAME`, `AI_SERVICE_HOST`, `AI_SERVICE_PORT`                                          | Not used by the container (uvicorn's flags and `PORT` decide) |

### client (Vercel)

All are build-time (Vite inlines them), so **redeploy after changing one**.
None is secret: they end up in the browser bundle by design.

| Name                            | Purpose              | Required                                        | Production value / source                                |
| ------------------------------- | -------------------- | ----------------------------------------------- | -------------------------------------------------------- |
| `VITE_API_URL`                  | api base URL         | **Yes** (falls back to `http://localhost:3001`) | The api Cloud Run URL, no trailing slash                 |
| `VITE_SUPABASE_URL`             | Supabase project URL | Yes                                             | `https://<project-ref>.supabase.co`                      |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Supabase public key  | Yes                                             | Supabase → API Keys → publishable (never `service_role`) |

## Cloud Run

**Region**: `us-east4` (Northern Virginia) for both services. It's the closest
Google region to Pinecone (AWS `us-east-1`) and ~10–15 ms from the Supabase
database (AWS `ca-central-1`, Montréal). `northamerica-northeast1` (Montréal) is
closest to the database but priced higher. Keep both services in the same
region.

| Setting               | api                                                                                    | ai-service                                                                                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Billing               | **Request-based** (CPU only during requests)                                           | **Instance-based** (CPU always allocated while an instance runs)                                                                                                                                                                     |
| Why                   | Pure request/response; idle costs nothing                                              | Background work after a response: on-demand ingestion, trace export                                                                                                                                                                  |
| CPU / memory          | 1 vCPU / 512 MiB                                                                       | 1 vCPU / 1 GiB (measured ~200 MiB; headroom for ingestion and bursts)                                                                                                                                                                |
| Min instances         | 0                                                                                      | 0 (a cold start is ~5–15 s; the client warms it once a user is signed in, never for anonymous page views)                                                                                                                            |
| Max instances         | 2 (cost cap)                                                                           | 1 (cost cap; one instance handles this traffic)                                                                                                                                                                                      |
| Concurrency           | 80                                                                                     | 20 (one async worker; chat turns are I/O-bound)                                                                                                                                                                                      |
| Request timeout       | 600 s (chat streams are one long request)                                              | 600 s                                                                                                                                                                                                                                |
| Startup CPU boost     | **On** (shorter cold starts; only adds CPU while an instance starts)                   | **On** (import-heavy startup)                                                                                                                                                                                                        |
| Startup probe         | HTTP `GET /api/live` (port 8080)                                                       | HTTP `GET /health` (port 8080), period 2 s, failure threshold 30                                                                                                                                                                     |
| Liveness probe        | HTTP `GET /api/live`                                                                   | HTTP `GET /health`                                                                                                                                                                                                                   |
| Service account       | Dedicated `equity-lens-api@PROJECT.iam.gserviceaccount.com`                            | Dedicated `equity-lens-ai-service@PROJECT.iam.gserviceaccount.com`                                                                                                                                                                   |
| Ingress / auth        | All; allow unauthenticated (`--allow-unauthenticated`; it authenticates users itself)  | All; **require authentication** (`--no-allow-unauthenticated`). Only the api's service account has `roles/run.invoker`. Every route but `/health` also requires `X-Internal-Token` (defense in depth)                                |
| Execution environment | Default (gen2)                                                                         | Default (gen2)                                                                                                                                                                                                                       |
| Secrets               | `AI_SERVICE_INTERNAL_TOKEN`, `DATABASE_URL`, `DIRECT_URL`, `SUPABASE_SERVICE_ROLE_KEY` | `AI_SERVICE_INTERNAL_TOKEN`, `AI_SERVICE_GEMINI_API_KEY`, `DATABASE_URL`, `AI_SERVICE_PINECONE_API_KEY`, `AI_SERVICE_EQUIBLES_API_KEY`, `AI_SERVICE_FINNHUB_API_KEY`, `AI_SERVICE_LANGFUSE_SECRET_KEY`, `AI_SERVICE_TRACE_USER_SALT` |

Never use `/api/health` as the api's health check: it returns `503` whenever the
ai-service is asleep, which would fail deploys and restart healthy instances.
It's for the client's status dot in the top bar.

With instance-based billing and min instances 0, the ai-service bills for each
instance from start until Cloud Run scales it in after it has been idle (up to
about 15 minutes). The max-instances cap of 1 bounds the cost.

Only the api can start it: Cloud Run rejects any request without a valid ID
token for the api's service account before an instance is started. The api
calls the ai-service only for signed-in users (real or anonymous demo): chat,
quotes, transcript search, warm-up (once per minute per user) and the
ai-service part of `/api/health`. Anonymous traffic never reaches it.

**How the api authenticates** (`api/src/services/idToken.ts`): with
`AI_SERVICE_ID_TOKEN_AUDIENCE` set, the api gets a Google ID token for that
audience from the Cloud Run metadata server (google-auth-library), reuses it
until 5 minutes before it expires, and sends it as `Authorization: Bearer` on
every ai-service request, including chat streams and warm-ups. The internal
token travels separately as `X-Internal-Token` and the ai-service keeps
checking it. If a token can't be fetched, the user sees the usual "The AI
analyst is unavailable right now" message. Locally the variable is empty and
no token is fetched. Cloud Run's startup and liveness probes don't need a token.

Shutdown: Cloud Run sends SIGTERM and kills the instance ~10 s later. The api
stops accepting connections and exits within 8 s. The ai-service drains open
requests for 3 s (`--timeout-graceful-shutdown 3`), stops background ingestion
(3 s), and flushes traces (2 s). An interrupted ingestion job is left as
`indexing` and is reclaimed after 30 minutes (`AI_SERVICE_RAG_STALE_JOB_MINUTES`).

### First deployment, step by step

This is the sequence used for the first production deploy. Replace `PROJECT`
with the project id and `TAG` with the git short SHA being deployed. Every
command takes `--project PROJECT`; it's omitted below for readability.

**1. Enable the APIs**

```bash
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com iam.googleapis.com
```

**2. Artifact Registry repo, cleanup policy, Docker login**

```bash
gcloud artifacts repositories create equity-lens --repository-format=docker \
  --location=us-east4 --description="Equity Lens images"
gcloud artifacts repositories set-cleanup-policies equity-lens --location=us-east4 \
  --policy=cleanup-policy.json --no-dry-run
gcloud auth configure-docker us-east4-docker.pkg.dev --quiet
```

`cleanup-policy.json` keeps the 2 most recent images per package (the
running revision and one to roll back to) and deletes everything else,
untagged images included. Keep rules always win over delete rules, and
Artifact Registry applies the policy periodically, not on every push.

```json
[
  {
    "name": "delete-untagged",
    "action": { "type": "Delete" },
    "condition": { "tagState": "UNTAGGED" }
  },
  {
    "name": "delete-old-versions",
    "action": { "type": "Delete" },
    "condition": { "tagState": "ANY" }
  },
  {
    "name": "keep-2-most-recent",
    "action": { "type": "Keep" },
    "mostRecentVersions": { "keepCount": 2 }
  }
]
```

`docker push` calls the `docker-credential-gcloud` helper from the Cloud SDK's
`bin` directory, so that directory must be on `PATH` in the shell that pushes
(open a new terminal after installing the SDK).

**3. One service account per service** (no project-level roles)

```bash
gcloud iam service-accounts create equity-lens-api --display-name="Equity Lens api (Cloud Run)"
gcloud iam service-accounts create equity-lens-ai-service --display-name="Equity Lens ai-service (Cloud Run)"
```

**4. Secrets**, each readable only by the service(s) that need it. Create
every secret from a temporary file and delete the file afterwards, so values
never appear in shell history or output:

```bash
gcloud secrets create NAME --replication-policy=automatic --data-file=TMPFILE
gcloud secrets add-iam-policy-binding NAME \
  --member=serviceAccount:SA@PROJECT.iam.gserviceaccount.com \
  --role=roles/secretmanager.secretAccessor
```

| Secret                      | Value                                                         | Readable by     |
| --------------------------- | ------------------------------------------------------------- | --------------- |
| `internal-token`            | New random value for production (`secrets.token_urlsafe(48)`) | api, ai-service |
| `database-url`              | Supabase pooled URL (the same value both services use)        | api, ai-service |
| `direct-url`                | Supabase session/direct URL                                   | api             |
| `supabase-service-role-key` | Supabase `service_role` key                                   | api             |
| `gemini-api-key`            | Gemini API key                                                | ai-service      |
| `pinecone-api-key`          | Pinecone API key                                              | ai-service      |
| `equibles-api-key`          | Equibles API key                                              | ai-service      |
| `finnhub-api-key`           | Finnhub API key                                               | ai-service      |
| `langfuse-secret-key`       | Langfuse secret key                                           | ai-service      |
| `trace-user-salt`           | HMAC key for hashed user ids in traces                        | ai-service      |

**5. Build and push the images**

```bash
IMG=us-east4-docker.pkg.dev/PROJECT/equity-lens
docker build --provenance=false --sbom=false -t $IMG/ai-service:TAG ai-service
docker build --provenance=false --sbom=false -t $IMG/api:TAG api
docker push $IMG/ai-service:TAG
docker push $IMG/api:TAG
```

`--provenance=false --sbom=false` pushes a single image manifest instead of an
index with attestations, which the "delete untagged" cleanup rule would treat as
clutter.

**6. Deploy the ai-service (private) and let only the api invoke it**

Non-secret settings go in a temporary `--env-vars-file` (YAML `KEY: "value"`
lines): `AI_SERVICE_ENVIRONMENT: "production"`,
`AI_SERVICE_LANGFUSE_PUBLIC_KEY`, `AI_SERVICE_LANGFUSE_BASE_URL`.

```bash
gcloud run deploy equity-lens-ai-service --image $IMG/ai-service:TAG --region us-east4 \
  --service-account equity-lens-ai-service@PROJECT.iam.gserviceaccount.com \
  --no-allow-unauthenticated --no-cpu-throttling --cpu-boost --cpu 1 --memory 1Gi \
  --min-instances 0 --max-instances 1 --concurrency 20 --timeout 600 \
  --execution-environment gen2 --env-vars-file ai-env.yaml \
  --set-secrets AI_SERVICE_INTERNAL_TOKEN=internal-token:latest,DATABASE_URL=database-url:latest,AI_SERVICE_GEMINI_API_KEY=gemini-api-key:latest,AI_SERVICE_PINECONE_API_KEY=pinecone-api-key:latest,AI_SERVICE_EQUIBLES_API_KEY=equibles-api-key:latest,AI_SERVICE_FINNHUB_API_KEY=finnhub-api-key:latest,AI_SERVICE_LANGFUSE_SECRET_KEY=langfuse-secret-key:latest,AI_SERVICE_TRACE_USER_SALT=trace-user-salt:latest \
  --startup-probe=httpGet.path=/health,periodSeconds=2,timeoutSeconds=2,failureThreshold=30 \
  --liveness-probe=httpGet.path=/health,periodSeconds=30,timeoutSeconds=5,failureThreshold=3

gcloud run services add-iam-policy-binding equity-lens-ai-service --region us-east4 \
  --member=serviceAccount:equity-lens-api@PROJECT.iam.gserviceaccount.com \
  --role=roles/run.invoker
```

Cloud Run gives each service two URLs (`https://SERVICE-PROJECTNUMBER.REGION.run.app`
and a hash-based `…a.run.app`); either works as the ID-token audience. Use the
project-number URL for both `AI_SERVICE_URL` and `AI_SERVICE_ID_TOKEN_AUDIENCE`.
The probes need no token: Cloud Run runs them inside the instance.

**7. Deploy the api (public)**

`api-env.yaml`: `NODE_ENV: "production"`, `AI_SERVICE_URL` and
`AI_SERVICE_ID_TOKEN_AUDIENCE` (both the ai-service URL), `CLIENT_ORIGIN`,
`SUPABASE_URL`.

**Production client origin**: the client is served from
`https://equitylens-research.vercel.app`, so the api runs with
`CLIENT_ORIGIN=https://equitylens-research.vercel.app,http://localhost:5173`. To
change only this variable on the running service, use a flags file. The comma
in the value would otherwise split `--update-env-vars`, and on Windows `cmd.exe`
strips gcloud's `^DELIM^` escape:

```yaml
# client-origin-flags.yaml
--update-env-vars:
  CLIENT_ORIGIN: "https://equitylens-research.vercel.app,http://localhost:5173"
```

```bash
gcloud run services update equity-lens-api --region us-east4 --flags-file client-origin-flags.yaml
```

Check it with a preflight from each origin. An allowed origin gets
`Access-Control-Allow-Origin` echoed back; any other origin gets no
`Access-Control-Allow-Origin` header (the preflight still answers `204`), so
the browser blocks it:

```bash
curl -s -D - -o /dev/null -X OPTIONS https://API_URL/api/holdings \
  -H "Origin: https://equitylens-research.vercel.app" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type"
```

```bash
gcloud run deploy equity-lens-api --image $IMG/api:TAG --region us-east4 \
  --service-account equity-lens-api@PROJECT.iam.gserviceaccount.com \
  --allow-unauthenticated --cpu-throttling --cpu-boost --cpu 1 --memory 512Mi \
  --min-instances 0 --max-instances 2 --concurrency 80 --timeout 600 \
  --execution-environment gen2 --env-vars-file api-env.yaml \
  --set-secrets AI_SERVICE_INTERNAL_TOKEN=internal-token:latest,DATABASE_URL=database-url:latest,DIRECT_URL=direct-url:latest,SUPABASE_SERVICE_ROLE_KEY=supabase-service-role-key:latest \
  --startup-probe=httpGet.path=/api/live,periodSeconds=2,timeoutSeconds=2,failureThreshold=15 \
  --liveness-probe=httpGet.path=/api/live,periodSeconds=30,timeoutSeconds=5,failureThreshold=3
```

Startup CPU boost is on for the api too (gcloud's default for new services).
The api starts quickly anyway, but with min instances 0 the first request after
an idle period waits for a cold start, and the boost only adds CPU while an
instance starts, so it shortens that wait for very little cost.

**8. Verify**

```bash
curl -s -o /dev/null -w "%{http_code}" https://API_URL/api/live   # 200
curl -s -o /dev/null -w "%{http_code}" https://AI_URL/health      # 403: Google rejects it
curl -s https://API_URL/api/health                                # api status only
```

With a signed-in (or anonymous demo) user's access token, `/api/health` also
returns `"aiService": {"status": "ok", "environment": "production"}`, which
proves the ID token, the invoker binding and the internal token work together.

Check that nothing else can invoke the ai-service: `gcloud run services
get-iam-policy equity-lens-ai-service --region us-east4` should list
`roles/run.invoker` for the api's service account only (no `allUsers`).

## Vercel (client)

| Setting          | Value                                                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Root Directory   | `client`                                                                                                               |
| Framework Preset | Vite                                                                                                                   |
| Install Command  | `npm ci`                                                                                                               |
| Build Command    | `npm run build`                                                                                                        |
| Output Directory | `dist`                                                                                                                 |
| Node.js Version  | 22.x                                                                                                                   |
| Env vars         | `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (Production; add Preview too if you use previews) |

`client/vercel.json` rewrites every path to `index.html`, so client-side
routes (`/chat`, `/account`) and the password-reset link (`/reset-password`)
load on refresh. Static assets are served first.

Preview deployments get their own URLs. The api only allows the exact origins
in `CLIENT_ORIGIN`, so either add a stable preview alias there (and to
Supabase's redirect URLs) or test against production only.

## Supabase

Authentication → URL Configuration:

| Setting       | Value                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Site URL      | `https://equitylens-research.vercel.app` (or your custom domain)                                                           |
| Redirect URLs | `https://equitylens-research.vercel.app/reset-password`, plus `http://localhost:5173/reset-password` for local development |

Also keep: Email provider enabled, **Anonymous sign-ins** enabled ("Try
demo"), and asymmetric JWT signing keys (the api verifies tokens against the
project's JWKS).

## Prisma migrations

The api's Prisma schema owns every table (chat, holdings, RAG state). Apply
migrations **before** deploying an api or ai-service revision that needs them,
never from a serving container (the runtime image has no Prisma CLI).

```bash
# Option A: from a workstation (needs DIRECT_URL and DATABASE_URL in api/.env)
npm --prefix api run prisma:deploy           # = prisma migrate deploy

# Option B: as a Cloud Run job using the migrate image
docker build -t us-east4-docker.pkg.dev/PROJECT/equity-lens/api-migrate:TAG --target migrate api
gcloud run jobs deploy equity-lens-migrate --region us-east4 \
  --image us-east4-docker.pkg.dev/PROJECT/equity-lens/api-migrate:TAG \
  --set-secrets DATABASE_URL=database-url:latest,DIRECT_URL=direct-url:latest
gcloud run jobs execute equity-lens-migrate --region us-east4 --wait
```

`migrate deploy` only applies committed migrations from
`api/prisma/migrations` and never creates new ones (that's `prisma:migrate`,
for development). It's safe to run when nothing is pending. `DIRECT_URL`
must be a session/direct connection: migrations can't run through the
transaction pooler.

## Cold starts and warm-up

- Once a session exists (on load when signed in, or right after login or demo
  sign-in) the client fires `POST /api/warmup`. The api pings the ai-service's
  `/health` and waits up to 20 s, so the ai-service is usually up before the
  first question. Each user can trigger it at most once per minute.
- While the ai-service is unreachable, the top-bar status dot is amber
  (**waking up**) and re-checks every 5 s.
- A chat turn starts streaming immediately (`turn` event plus keepalive
  comments). The api waits up to `CHAT_CONNECT_TIMEOUT_MS` (30 s) for the
  ai-service to start answering, then shows "The AI analyst is unavailable
  right now. Please try again shortly."
- Dashboard prices time out after 8 s and show "price unavailable" until the
  next refresh.
