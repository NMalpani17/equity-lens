/**
 * Supabase auth failures mapped to messages that never reveal whether an
 * email is registered: every credential-type failure on a form reads the
 * same. Only rate limits, network failures and password-rule failures (which
 * say nothing about the account) get their own message.
 */

/** An auth failure that keeps Supabase's error code and HTTP status. */
export class AuthFailure extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AuthFailure";
  }
}

export type AuthAction = "login" | "signup" | "reset" | "update" | "redirect";

const GENERIC: Record<AuthAction, string> = {
  login:
    "Incorrect email or password. If you just signed up, confirm your email first.",
  signup:
    "We couldn't create an account with those details. If you already have one, log in or reset your password.",
  reset: "We couldn't send the reset link right now. Try again in a moment.",
  update: "We couldn't update your password. Try again in a moment.",
  // A Google sign-in or email link that came back with an error.
  redirect:
    "Sign-in didn't complete, or the link has expired. Try again, or log in another way.",
};

export const RATE_LIMITED = "Too many attempts. Wait a minute and try again.";
export const OFFLINE =
  "We couldn't reach the server. Check your connection and try again.";
export const WEAK_PASSWORD = "Choose a password of 8 to 64 characters.";
export const SAME_PASSWORD =
  "New password must be different from your current password.";

function parts(error: unknown): { code?: string; status?: number; message: string } {
  if (error instanceof AuthFailure) {
    return { code: error.code, status: error.status, message: error.message };
  }
  return { message: error instanceof Error ? error.message : "" };
}

/** The message to show for a failed auth action. */
export function authErrorMessage(action: AuthAction, error: unknown): string {
  const { code, status, message } = parts(error);

  if (status === 429 || code?.startsWith("over_") || /rate limit/i.test(message)) {
    return RATE_LIMITED;
  }
  if (status === 0 || /failed to fetch|network/i.test(message)) {
    return OFFLINE;
  }
  if (action === "signup" || action === "update") {
    if (code === "weak_password") return WEAK_PASSWORD;
  }
  if (action === "update") {
    if (code === "same_password" || /different from the old password/i.test(message)) {
      return SAME_PASSWORD;
    }
  }
  return GENERIC[action];
}
