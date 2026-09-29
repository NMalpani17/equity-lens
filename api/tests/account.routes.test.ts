import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/services/account.service.js", () => ({
  deleteAccount: vi.fn(),
}));

vi.mock("../src/auth/verifyToken.js", () => ({
  verifySupabaseToken: vi.fn(),
}));

import { createApp } from "../src/app.js";
import * as accountService from "../src/services/account.service.js";
import { verifySupabaseToken } from "../src/auth/verifyToken.js";

const app = createApp();
const service = vi.mocked(accountService);
const verifyTokenMock = vi.mocked(verifySupabaseToken);

const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

beforeEach(() => {
  vi.clearAllMocks();
  verifyTokenMock.mockResolvedValue({ userId: USER_ID, isAnonymous: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DELETE /api/account", () => {
  it("returns 401 without a token", async () => {
    const res = await request(app).delete("/api/account");

    expect(res.status).toBe(401);
    expect(service.deleteAccount).not.toHaveBeenCalled();
  });

  it("deletes the authenticated user's account and returns 204", async () => {
    service.deleteAccount.mockResolvedValue(undefined);

    const res = await request(app)
      .delete("/api/account")
      .set("Authorization", "Bearer test-token");

    expect(res.status).toBe(204);
    expect(service.deleteAccount).toHaveBeenCalledWith(USER_ID);
  });
});
