import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/prisma.js", () => ({
  prisma: {
    holding: { deleteMany: vi.fn() },
    chatConversation: { deleteMany: vi.fn() },
    demoSeed: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("../src/auth/supabaseAdmin.js", () => ({ deleteAuthUser: vi.fn() }));

import { prisma } from "../src/db/prisma.js";
import { deleteAuthUser } from "../src/auth/supabaseAdmin.js";
import { deleteAccount } from "../src/services/account.service.js";

const mockPrisma = vi.mocked(prisma, true);
const deleteAuthUserMock = vi.mocked(deleteAuthUser);

const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.$transaction.mockResolvedValue([{ count: 0 }, { count: 0 }]);
  deleteAuthUserMock.mockResolvedValue(undefined);
});

describe("account.service.deleteAccount", () => {
  it("removes holdings, chats + demo marker in a transaction, then the auth user", async () => {
    await deleteAccount(USER_ID);

    expect(mockPrisma.holding.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
    });
    expect(mockPrisma.demoSeed.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
    });
    expect(mockPrisma.chatConversation.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
    });
    expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
    expect(deleteAuthUserMock).toHaveBeenCalledWith(USER_ID);
  });

  it("does not delete the auth user if the database transaction fails", async () => {
    mockPrisma.$transaction.mockRejectedValue(new Error("db down"));

    await expect(deleteAccount(USER_ID)).rejects.toThrow("db down");
    expect(deleteAuthUserMock).not.toHaveBeenCalled();
  });
});
