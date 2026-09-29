/**
 * Supabase Admin client (service-role). SERVER-SIDE ONLY — the service-role key
 * bypasses row-level security and can manage auth users, so it must never reach
 * the browser. Used here to delete a user's auth account.
 */
import { createClient } from "@supabase/supabase-js";

import { config } from "../config.js";

const admin = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Permanently delete a Supabase auth user by id. Throws on failure. */
export async function deleteAuthUser(userId: string): Promise<void> {
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    throw new Error(error.message);
  }
}
