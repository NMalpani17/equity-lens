import { afterEach, describe, expect, it, vi } from "vitest";

const getSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase", () => ({ supabase: { auth: { getSession } } }));

import { API_URL, getApiHealth } from "./api";

const body = { status: "ok", service: "equity-lens-api", version: "0.1.0" };

describe("getApiHealth", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the session token so the API reports the AI service too", async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: "tok-1" } } });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(body)));

    await getApiHealth();

    expect(fetchSpy).toHaveBeenCalledWith(`${API_URL}/api/health`, {
      headers: { Authorization: "Bearer tok-1" },
    });
  });

  it("sends no Authorization header without a session", async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(body)));

    expect(await getApiHealth()).toEqual(body);
    expect(fetchSpy).toHaveBeenCalledWith(`${API_URL}/api/health`, { headers: {} });
  });
});
