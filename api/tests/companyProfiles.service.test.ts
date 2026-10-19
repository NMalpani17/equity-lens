import { afterEach, describe, expect, it, vi } from "vitest";

import { UpstreamError } from "../src/errors.js";
import { getCompanyProfiles } from "../src/services/companyProfiles.service.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getCompanyProfiles", () => {
  it("skips the call for no tickers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    expect(await getCompanyProfiles([])).toEqual({ profiles: {}, pending: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns profiles and pending tickers", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          profiles: {
            VOO: {
              ticker: "VOO",
              name: "Vanguard S&P 500 ETF",
              sector: "Funds",
              industry: "ETF",
              source: "yfinance",
            },
          },
          pending: ["NEW"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await getCompanyProfiles(["VOO", "NEW"]);

    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.pathname).toBe("/profiles");
    expect(url.searchParams.get("symbols")).toBe("VOO,NEW");
    expect(result.profiles.VOO?.sector).toBe("Funds");
    expect(result.pending).toEqual(["NEW"]);
  });

  it("throws UpstreamError when the ai-service fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 502 }));

    await expect(getCompanyProfiles(["AAPL"])).rejects.toBeInstanceOf(UpstreamError);
  });
});
