import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// Mock the service layer so route tests cover auth, validation and status codes.
vi.mock("../src/services/watchlist.service.js", () => ({
  watchTicker: vi.fn(),
  removeItem: vi.fn(),
  ensureDemoWatchlist: vi.fn(),
}));
vi.mock("../src/services/watchlistView.service.js", () => ({ getWatchlist: vi.fn() }));
vi.mock("../src/services/earnings.service.js", () => ({
  getUserUpcomingEarnings: vi.fn(),
}));
vi.mock("../src/auth/verifyToken.js", () => ({
  verifySupabaseToken: vi.fn(),
}));

import { createApp } from "../src/app.js";
import { verifySupabaseToken } from "../src/auth/verifyToken.js";
import { getUserUpcomingEarnings } from "../src/services/earnings.service.js";
import { getWatchlist } from "../src/services/watchlistView.service.js";
import {
  AlreadyWatchingError,
  NotFoundError,
  WatchlistLimitError,
} from "../src/errors.js";
import * as watchlist from "../src/services/watchlist.service.js";

const app = createApp();
const service = vi.mocked(watchlist);
const verifyTokenMock = vi.mocked(verifySupabaseToken);
const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AUTH = "Bearer test-token";

const added = {
  ticker: "AMD",
  name: "Advanced Micro Devices",
  addedPrice: 153,
  addedPriceAt: "2026-10-19T15:00:00.000Z",
  addedAt: "2026-10-19T15:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  verifyTokenMock.mockResolvedValue({ userId: USER_ID, isAnonymous: false });
  service.watchTicker.mockResolvedValue(added);
});

describe("GET /api/watchlist", () => {
  const get = () => request(app).get("/api/watchlist").set("Authorization", AUTH);

  it("returns the user's rows", async () => {
    vi.mocked(getWatchlist).mockResolvedValue({ items: [], limit: 50 });

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], limit: 50 });
    expect(getWatchlist).toHaveBeenCalledWith(USER_ID, false);
    expect(service.ensureDemoWatchlist).not.toHaveBeenCalled();
  });

  it("seeds and reads as a demo user", async () => {
    verifyTokenMock.mockResolvedValue({ userId: USER_ID, isAnonymous: true });
    vi.mocked(getWatchlist).mockResolvedValue({ items: [], limit: 50 });

    await get();

    expect(service.ensureDemoWatchlist).toHaveBeenCalledWith(USER_ID);
    expect(getWatchlist).toHaveBeenCalledWith(USER_ID, true);
  });

  it("requires a signed-in user", async () => {
    expect((await request(app).get("/api/watchlist")).status).toBe(401);
  });
});

describe("GET /api/earnings/upcoming", () => {
  it("returns holdings and watchlist earnings", async () => {
    const body = {
      earnings: [],
      unscheduled: [],
      windowStart: "2026-10-20",
      windowEnd: "2026-12-19",
      refreshedAt: null,
      refreshing: true,
      available: true,
    };
    vi.mocked(getUserUpcomingEarnings).mockResolvedValue(body);

    const res = await request(app)
      .get("/api/earnings/upcoming")
      .set("Authorization", AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(body);
    expect(getUserUpcomingEarnings).toHaveBeenCalledWith(USER_ID);
  });

  it("requires a signed-in user", async () => {
    expect((await request(app).get("/api/earnings/upcoming")).status).toBe(401);
  });
});

describe("POST /api/watchlist", () => {
  const post = (body: unknown) =>
    request(app)
      .post("/api/watchlist")
      .set("Authorization", AUTH)
      .send(body as object);

  it("adds a normalized ticker", async () => {
    const res = await post({ ticker: " amd " });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(added);
    expect(service.watchTicker).toHaveBeenCalledWith(USER_ID, "AMD");
    expect(service.ensureDemoWatchlist).not.toHaveBeenCalled();
  });

  it.each([
    [{}],
    [{ ticker: "" }],
    [{ ticker: "not a ticker" }],
    [{ ticker: "TOOLONGTICKER" }],
    [{ ticker: 42 }],
    // Ticker only: no shares or price on a watchlist.
    [{ ticker: "AMD", shares: 10 }],
  ])("rejects %j with 422", async (body) => {
    const res = await post(body);

    expect(res.status).toBe(422);
    expect(service.watchTicker).not.toHaveBeenCalled();
  });

  it("is a 409 with the limit when the watchlist is full", async () => {
    service.watchTicker.mockRejectedValue(new WatchlistLimitError(50));

    const res = await post({ ticker: "AMD" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "watchlist_limit_reached", limit: 50 });
  });

  it("is a 409 for a ticker already watched", async () => {
    service.watchTicker.mockRejectedValue(new AlreadyWatchingError("AMD"));

    const res = await post({ ticker: "AMD" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_watching");
  });

  it("seeds the demo watchlist first for demo users", async () => {
    verifyTokenMock.mockResolvedValue({ userId: USER_ID, isAnonymous: true });

    await post({ ticker: "NVDA" });

    expect(service.ensureDemoWatchlist).toHaveBeenCalledWith(USER_ID);
  });

  it("requires a signed-in user", async () => {
    const res = await request(app).post("/api/watchlist").send({ ticker: "AMD" });

    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/watchlist/:ticker", () => {
  const del = (ticker: string) =>
    request(app).delete(`/api/watchlist/${ticker}`).set("Authorization", AUTH);

  it("removes a ticker", async () => {
    const res = await del("amd");

    expect(res.status).toBe(204);
    expect(service.removeItem).toHaveBeenCalledWith(USER_ID, "AMD");
  });

  it("is a 404 when it isn't on the list", async () => {
    service.removeItem.mockRejectedValue(
      new NotFoundError("AMD is not on your watchlist"),
    );

    expect((await del("AMD")).status).toBe(404);
  });

  it("rejects an invalid ticker with 422", async () => {
    const res = await del("no%20way");

    expect(res.status).toBe(422);
    expect(service.removeItem).not.toHaveBeenCalled();
  });
});
