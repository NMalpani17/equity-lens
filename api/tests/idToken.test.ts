import { afterEach, describe, expect, it, vi } from "vitest";

import {
  REFRESH_MARGIN_MS,
  createIdTokenProvider,
  tokenExpiry,
} from "../src/services/idToken.js";
import {
  aiServiceFetch,
  aiServiceUrl,
  INTERNAL_TOKEN_HEADER,
  setIdTokenProvider,
} from "../src/services/aiServiceClient.js";
import { getAiServiceHealth } from "../src/services/aiService.js";
import { openChatStream } from "../src/services/chatStream.service.js";
import { ServiceUnavailableError } from "../src/errors.js";

/** An unsigned JWT-shaped token expiring at `expSeconds`. */
function jwt(expSeconds: number, tag = "a"): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256" })}.${encode({ exp: expSeconds, tag })}.sig`;
}

const REQUEST = {
  userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  isAnonymous: false,
  conversationId: "c1",
  message: "hi",
  history: [],
  portfolio: null,
};

function sentHeaders(spy: { mock: { calls: unknown[][] } }, call = 0): Headers {
  return new Headers((spy.mock.calls[call]?.[1] as RequestInit | undefined)?.headers);
}

afterEach(() => {
  setIdTokenProvider(null);
  vi.restoreAllMocks();
});

describe("aiServiceFetch ID token", () => {
  it("sends no Authorization header when IAM isn't configured (local dev, tests)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    await aiServiceFetch(aiServiceUrl("/health"), {
      headers: { Authorization: "Bearer user-supabase-token" },
    });

    const headers = sentHeaders(spy);
    expect(headers.get("Authorization")).toBeNull(); // a caller's token is never forwarded
    expect(headers.get(INTERNAL_TOKEN_HEADER)).toBe("test-internal-token");
  });

  it("sends the ID token as a bearer token and the internal token separately", async () => {
    setIdTokenProvider({ getToken: async () => "google-id-token" });
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));

    await aiServiceFetch(aiServiceUrl("/quotes"));

    const headers = sentHeaders(spy);
    expect(headers.get("Authorization")).toBe("Bearer google-id-token");
    expect(headers.get(INTERNAL_TOKEN_HEADER)).toBe("test-internal-token");
  });

  it("covers chat streaming and the health/warm-up ping", async () => {
    setIdTokenProvider({ getToken: async () => "google-id-token" });
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("event: done\ndata: {}\n\n"));

    await openChatStream(REQUEST, new AbortController().signal);
    await getAiServiceHealth();

    expect(sentHeaders(spy, 0).get("Authorization")).toBe("Bearer google-id-token");
    expect(sentHeaders(spy, 1).get("Authorization")).toBe("Bearer google-id-token");
  });
});

describe("ID token failures", () => {
  it("turns a chat request into the friendly 'unavailable' error", async () => {
    setIdTokenProvider({
      getToken: () => Promise.reject(new Error("metadata server down")),
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const error = await openChatStream(REQUEST, new AbortController().signal).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect((error as ServiceUnavailableError).code).toBe("chat_unavailable");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports the ai-service as unreachable on health checks (never throws)", async () => {
    setIdTokenProvider({ getToken: () => Promise.reject(new Error("no credentials")) });

    await expect(getAiServiceHealth()).resolves.toMatchObject({
      status: "unreachable",
    });
  });
});

describe("createIdTokenProvider", () => {
  it("reuses a token until it nears expiry, then fetches a new one", async () => {
    let clock = 1_000_000_000_000;
    const expiry = clock + 60 * 60_000; // one hour
    const fetchToken = vi
      .fn()
      .mockResolvedValueOnce(jwt(expiry / 1000, "first"))
      .mockResolvedValueOnce(jwt(expiry / 1000 + 3600, "second"));
    const provider = createIdTokenProvider(
      "https://ai.example.run.app",
      fetchToken,
      () => clock,
    );

    const first = await provider.getToken();
    clock = expiry - REFRESH_MARGIN_MS - 1;
    expect(await provider.getToken()).toBe(first);
    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(fetchToken).toHaveBeenCalledWith("https://ai.example.run.app");

    clock = expiry - REFRESH_MARGIN_MS;
    expect(await provider.getToken()).not.toBe(first);
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it("shares one fetch between concurrent requests", async () => {
    let resolve: (token: string) => void = () => {};
    const fetchToken = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const provider = createIdTokenProvider("aud", fetchToken);

    const both = Promise.all([provider.getToken(), provider.getToken()]);
    resolve(jwt(Date.now() / 1000 + 3600));

    const [a, b] = await both;
    expect(a).toBe(b);
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("doesn't cache a failure: the next call tries again", async () => {
    const fetchToken = vi
      .fn()
      .mockRejectedValueOnce(new Error("metadata hiccup"))
      .mockResolvedValueOnce(jwt(Date.now() / 1000 + 3600));
    const provider = createIdTokenProvider("aud", fetchToken);

    await expect(provider.getToken()).rejects.toThrow("metadata hiccup");
    await expect(provider.getToken()).resolves.toMatch(/\./);
  });

  it("gives up on a fetch that hangs", async () => {
    vi.useFakeTimers();
    try {
      const provider = createIdTokenProvider(
        "aud",
        () => new Promise<string>(() => {}),
      );

      const pending = provider.getToken();
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads exp from a JWT, and falls back when it can't", () => {
    expect(tokenExpiry(jwt(2_000_000_000))).toBe(2_000_000_000_000);
    expect(tokenExpiry("not-a-jwt")).toBeNull();
    expect(tokenExpiry("a.%%%.c")).toBeNull();
  });
});
