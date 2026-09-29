import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// Mock the service layer so route tests exercise validation, status codes,
// and error mapping without a database.
vi.mock("../src/services/holdings.service.js", () => ({
  listHoldings: vi.fn(),
  getHolding: vi.fn(),
  createHolding: vi.fn(),
  updateHolding: vi.fn(),
  deleteHolding: vi.fn(),
  deleteHoldingsByTicker: vi.fn(),
  ensureDemoHoldings: vi.fn(),
}));

// The controller validates the ticker against the market-data service; mock it
// so route tests don't perform real network calls.
vi.mock("../src/services/quotes.service.js", () => ({
  verifyTicker: vi.fn(),
}));

// Mock JWT verification so protected routes accept a fixed test user without
// contacting Supabase's JWKS endpoint.
vi.mock("../src/auth/verifyToken.js", () => ({
  verifySupabaseToken: vi.fn(),
}));

import { createApp } from "../src/app.js";
import * as holdingsService from "../src/services/holdings.service.js";
import { verifyTicker } from "../src/services/quotes.service.js";
import { verifySupabaseToken } from "../src/auth/verifyToken.js";
import { NotFoundError } from "../src/errors.js";

const app = createApp();
const service = vi.mocked(holdingsService);
const verifyTickerMock = vi.mocked(verifyTicker);
const verifyTokenMock = vi.mocked(verifySupabaseToken);

const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AUTH = "Bearer test-token";

// Request helpers that attach the auth header, since every route here is
// protected. Auth-specific tests below use `request(app)` directly.
const get = (path: string) => request(app).get(path).set("Authorization", AUTH);
const post = (path: string) => request(app).post(path).set("Authorization", AUTH);
const patch = (path: string) => request(app).patch(path).set("Authorization", AUTH);
const del = (path: string) => request(app).delete(path).set("Authorization", AUTH);

const sample = {
  id: "11111111-1111-1111-1111-111111111111",
  ticker: "AAPL",
  shares: 10,
  buyPrice: 150.25,
  purchaseDate: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  // Default to a recognized ticker; individual tests override as needed.
  verifyTickerMock.mockResolvedValue("ok");
  // Default to an authenticated, non-anonymous user; tests override as needed.
  verifyTokenMock.mockResolvedValue({ userId: USER_ID, isAnonymous: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authentication", () => {
  it("returns 401 when the Authorization header is missing", async () => {
    const res = await request(app).get("/api/holdings");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
    expect(service.listHoldings).not.toHaveBeenCalled();
  });

  it("returns 401 when the token is invalid", async () => {
    verifyTokenMock.mockRejectedValue(new Error("bad signature"));

    const res = await request(app)
      .get("/api/holdings")
      .set("Authorization", "Bearer nope");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
    expect(service.listHoldings).not.toHaveBeenCalled();
  });

  it("returns 401 when the scheme is not Bearer", async () => {
    const res = await request(app)
      .get("/api/holdings")
      .set("Authorization", "Basic test-token");

    expect(res.status).toBe(401);
    expect(service.listHoldings).not.toHaveBeenCalled();
  });
});

describe("GET /api/holdings", () => {
  it("returns 200 with the list of the user's holdings", async () => {
    service.listHoldings.mockResolvedValue([sample]);

    const res = await get("/api/holdings");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([sample]);
    expect(service.listHoldings).toHaveBeenCalledWith(USER_ID);
    // A normal user is never auto-seeded.
    expect(service.ensureDemoHoldings).not.toHaveBeenCalled();
  });

  it("seeds demo holdings before listing for an anonymous user", async () => {
    verifyTokenMock.mockResolvedValue({ userId: USER_ID, isAnonymous: true });
    service.listHoldings.mockResolvedValue([sample]);

    const res = await get("/api/holdings");

    expect(res.status).toBe(200);
    expect(service.ensureDemoHoldings).toHaveBeenCalledWith(USER_ID);
  });
});

describe("POST /api/holdings", () => {
  it("creates a holding scoped to the user and returns 201", async () => {
    service.createHolding.mockResolvedValue(sample);

    const res = await post("/api/holdings").send({
      ticker: "aapl",
      shares: 10,
      buyPrice: 150.25,
    });

    expect(res.status).toBe(201);
    // Ticker is normalized to uppercase and the holding is owned by the user.
    expect(service.createHolding).toHaveBeenCalledWith(
      { ticker: "AAPL", shares: 10, buyPrice: 150.25 },
      USER_ID,
    );
  });

  it("returns 422 for invalid input", async () => {
    const res = await post("/api/holdings").send({
      ticker: "AAPL",
      shares: -5,
      buyPrice: 150,
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("validation_error");
    expect(service.createHolding).not.toHaveBeenCalled();
  });

  it("passes an optional purchase date through to the service", async () => {
    service.createHolding.mockResolvedValue(sample);

    const res = await post("/api/holdings").send({
      ticker: "AAPL",
      shares: 10,
      buyPrice: 150.25,
      purchaseDate: "2026-01-15",
    });

    expect(res.status).toBe(201);
    expect(service.createHolding).toHaveBeenCalledWith(
      expect.objectContaining({ purchaseDate: "2026-01-15" }),
      USER_ID,
    );
  });

  it("returns 422 for a malformed purchase date", async () => {
    const res = await post("/api/holdings").send({
      ticker: "AAPL",
      shares: 10,
      buyPrice: 150,
      purchaseDate: "01/15/2026",
    });

    expect(res.status).toBe(422);
    expect(service.createHolding).not.toHaveBeenCalled();
  });

  it("returns 422 for a future purchase date", async () => {
    const future = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

    const res = await post("/api/holdings").send({
      ticker: "AAPL",
      shares: 10,
      buyPrice: 150,
      purchaseDate: future,
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("validation_error");
    expect(service.createHolding).not.toHaveBeenCalled();
  });

  it("accepts today as a purchase date", async () => {
    service.createHolding.mockResolvedValue(sample);
    const today = new Date().toISOString().slice(0, 10);

    const res = await post("/api/holdings").send({
      ticker: "AAPL",
      shares: 10,
      buyPrice: 150,
      purchaseDate: today,
    });

    expect(res.status).toBe(201);
  });

  it("returns 422 and does not persist when the ticker is unknown", async () => {
    verifyTickerMock.mockResolvedValue("not_found");

    const res = await post("/api/holdings").send({
      ticker: "ASDASD",
      shares: 10,
      buyPrice: 150,
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_ticker");
    expect(res.body.message).toContain("ASDASD");
    expect(service.createHolding).not.toHaveBeenCalled();
  });

  it("creates the holding when the market service can't verify the ticker", async () => {
    // A transient market-data outage should not block the user.
    verifyTickerMock.mockResolvedValue("unavailable");
    service.createHolding.mockResolvedValue(sample);

    const res = await post("/api/holdings").send({
      ticker: "AAPL",
      shares: 10,
      buyPrice: 150.25,
    });

    expect(res.status).toBe(201);
    expect(service.createHolding).toHaveBeenCalled();
  });
});

describe("PATCH /api/holdings/:id", () => {
  it("returns 404 when the holding does not exist", async () => {
    service.updateHolding.mockRejectedValue(new NotFoundError());

    const res = await patch("/api/holdings/22222222-2222-2222-2222-222222222222").send({
      shares: 5,
    });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 422 for a malformed id", async () => {
    const res = await patch("/api/holdings/not-a-uuid").send({ shares: 5 });

    expect(res.status).toBe(422);
  });

  it("does not re-verify the ticker when it is unchanged", async () => {
    service.getHolding.mockResolvedValue(sample); // stored ticker is AAPL
    service.updateHolding.mockResolvedValue(sample);

    const res = await patch(`/api/holdings/${sample.id}`).send({
      ticker: "AAPL",
      shares: 5,
    });

    expect(res.status).toBe(200);
    expect(verifyTickerMock).not.toHaveBeenCalled();
    expect(service.updateHolding).toHaveBeenCalledWith(
      sample.id,
      { ticker: "AAPL", shares: 5 },
      USER_ID,
    );
  });

  it("verifies the ticker only when it changes, rejecting unknown ones", async () => {
    service.getHolding.mockResolvedValue(sample); // stored ticker is AAPL
    verifyTickerMock.mockResolvedValue("not_found");

    const res = await patch(`/api/holdings/${sample.id}`).send({ ticker: "ASDASD" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("invalid_ticker");
    expect(verifyTickerMock).toHaveBeenCalledWith("ASDASD");
    expect(service.updateHolding).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/holdings/:id", () => {
  it("returns 204 on success", async () => {
    service.deleteHolding.mockResolvedValue(undefined);

    const res = await del("/api/holdings/11111111-1111-1111-1111-111111111111");

    expect(res.status).toBe(204);
    expect(service.deleteHolding).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      USER_ID,
    );
  });
});

describe("DELETE /api/holdings?ticker=", () => {
  it("deletes all lots for a ticker and returns 204", async () => {
    service.deleteHoldingsByTicker.mockResolvedValue(2);

    const res = await del("/api/holdings").query({ ticker: "aapl" });

    expect(res.status).toBe(204);
    // Ticker is normalized to uppercase and scoped to the user.
    expect(service.deleteHoldingsByTicker).toHaveBeenCalledWith("AAPL", USER_ID);
  });

  it("returns 404 when the ticker has no lots", async () => {
    service.deleteHoldingsByTicker.mockResolvedValue(0);

    const res = await del("/api/holdings").query({ ticker: "AAPL" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 422 when the ticker query is missing", async () => {
    const res = await del("/api/holdings");

    expect(res.status).toBe(422);
    expect(service.deleteHoldingsByTicker).not.toHaveBeenCalled();
  });

  it("returns 422 for a malformed ticker", async () => {
    const res = await del("/api/holdings").query({ ticker: "!!!" });

    expect(res.status).toBe(422);
    expect(service.deleteHoldingsByTicker).not.toHaveBeenCalled();
  });
});
