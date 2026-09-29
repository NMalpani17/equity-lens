# API reference

All application routes are served by the Express gateway at
`http://localhost:3001`. The client only ever talks to this gateway.

## API gateway (`http://localhost:3001`)

| Method   | Path                     | Description                                                     |
| -------- | ------------------------ | --------------------------------------------------------------- |
| `GET`    | `/api/health`            | Health of the API and downstream AI service.                    |
| `GET`    | `/api/holdings`          | List all holdings (lots).                                       |
| `POST`   | `/api/holdings`          | Create a lot (`ticker`, `shares`, `buyPrice`, `purchaseDate?`). |
| `GET`    | `/api/holdings/:id`      | Get one holding.                                                |
| `PATCH`  | `/api/holdings/:id`      | Update a holding.                                               |
| `DELETE` | `/api/holdings/:id`      | Delete one lot.                                                 |
| `DELETE` | `/api/holdings?ticker=X` | Delete a whole position (every lot for a ticker).               |
| `GET`    | `/api/portfolio/summary` | Positions (lots grouped by ticker) with live prices + totals.   |

### Authentication

All `/api/holdings` and `/api/portfolio` routes require a **Supabase access
token** sent as a bearer header:

```
Authorization: Bearer <supabase-access-token>
```

The gateway verifies the token against the Supabase project's JWKS (configured
via `SUPABASE_URL`) and scopes every query to the token's user. A missing or
invalid token returns `401` `unauthorized`. Every holding is owned by a user;
requesting or editing another user's holding returns `404` (never `403`, so the
existence of others' data isn't revealed). `/api/health` is public.

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

## AI service (`http://localhost:8000`)

The market-data endpoints the API consumes directly:

| Method | Path                  | Description                                    |
| ------ | --------------------- | ---------------------------------------------- |
| `GET`  | `/health`             | Service health.                                |
| `GET`  | `/quotes/{ticker}`    | One quote (`404` unknown, `502` unavailable).  |
| `GET`  | `/quotes?symbols=A,B` | Batch quotes; per-ticker failures in `errors`. |

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
