/**
 * Account lifecycle logic. Owns deleting a user's data and auth account.
 */
import { prisma } from "../db/prisma.js";
import { deleteAuthUser } from "../auth/supabaseAdmin.js";

/**
 * Permanently delete a user's account. Removes their holdings, chat
 * conversations (messages cascade) and DemoSeed marker in a single
 * transaction, then deletes the Supabase auth user. The DB
 * rows are removed first so a later auth-deletion failure never leaves orphaned
 * holdings behind a still-usable login.
 */
export async function deleteAccount(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.holding.deleteMany({ where: { userId } }),
    prisma.chatConversation.deleteMany({ where: { userId } }),
    prisma.demoSeed.deleteMany({ where: { userId } }),
  ]);
  await deleteAuthUser(userId);
}
