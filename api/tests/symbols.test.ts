import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    marketSymbol: { findMany: vi.fn(), findUnique: vi.fn() },
  },
}));
vi.mock("../src/auth/verifyToken.js", () => ({
  verifySupabaseToken: vi.fn(),
}));

import { createApp } from "../src/app.js";
import { verifySupabaseToken } from "../src/auth/verifyToken.js";
import { prisma } from "../src/db/prisma.js";
import {
  isListedSymbol,
  searchSymbols,
  symbolNames,
} from "../src/services/symbols.service.js";

const app = createApp();
const mockPrisma = vi.mocked(prisma, true);
const verifyTokenMock = vi.mocked(verifySupabaseToken);
const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const MSFT = {
  ticker: "MSFT",
  name: "Microsoft Corp",
  type: "stock",
  exchange: "XNAS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyTokenMock.mockResolvedValue({ userId: USER_ID, isAnonymous: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("searchSymbols", () => {
  it("asks the ai-service and returns its ranked matches", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ results: [MSFT], ready: true }));

    const result = await searchSymbols("mircosoft");

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe("/symbols/search");
    expect(url.searchParams.get("q")).toBe("mircosoft");
    expect(result).toEqual({ results: [MSFT], ready: true });
  });

  it.each([
    ["a non-OK answer", () => Promise.resolve(new Response("", { status: 502 }))],
    ["a malformed body", () => Promise.resolve(jsonResponse({ results: "nope" }))],
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
  ])("answers no matches and not ready on %s", async (_, answer) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(answer);

    expect(await searchSymbols("msft")).toEqual({ results: [], ready: false });
  });
});

describe("symbol lookups", () => {
  it("maps tickers to display names", async () => {
    mockPrisma.marketSymbol.findMany.mockResolvedValue([
      { ticker: "AMD", name: "Advanced Micro Devices" },
    ] as never);

    const names = await symbolNames(["AMD", "ZZZZ"]);

    expect(names.get("AMD")).toBe("Advanced Micro Devices");
    expect(names.has("ZZZZ")).toBe(false);
  });

  it("skips the query for no tickers", async () => {
    expect((await symbolNames([])).size).toBe(0);
    expect(mockPrisma.marketSymbol.findMany).not.toHaveBeenCalled();
  });

  it("tells whether a ticker is listed", async () => {
    mockPrisma.marketSymbol.findUnique.mockResolvedValueOnce({
      ticker: "AMD",
    } as never);
    mockPrisma.marketSymbol.findUnique.mockResolvedValueOnce(null);

    expect(await isListedSymbol("AMD")).toBe(true);
    expect(await isListedSymbol("ZZZZ")).toBe(false);
  });
});

describe("GET /api/symbols/search", () => {
  const get = (path: string) =>
    request(app).get(path).set("Authorization", "Bearer test-token");

  it("returns suggestions", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ results: [MSFT], ready: true }),
    );

    const res = await get("/api/symbols/search?q=%20micro%20");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [MSFT], ready: true });
  });

  it.each(["", "?q=", "?q=%20%20", `?q=${"x".repeat(51)}`])(
    "rejects a bad query (%s) with 422",
    async (query) => {
      const fetchMock = vi.spyOn(globalThis, "fetch");

      const res = await get(`/api/symbols/search${query}`);

      expect(res.status).toBe(422);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("requires a signed-in user", async () => {
    const res = await request(app).get("/api/symbols/search?q=msft");

    expect(res.status).toBe(401);
  });
});
