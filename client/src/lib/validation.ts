/**
 * Field rules shared by the auth forms. The password rule is length only
 * (8–64 characters, no composition rules); Supabase's minimum password
 * length must be set to the same 8 (docs/development.md).
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 64;

/** Length in characters as a person counts them (an emoji is one). */
export function passwordLength(password: string): number {
  return [...password].length;
}

export function meetsPasswordRule(password: string): boolean {
  const length = passwordLength(password);
  return length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH;
}

/** The error for a new password, or null when it's acceptable. */
export function newPasswordError(password: string): string | null {
  if (!password) return "Enter a password.";
  const length = passwordLength(password);
  if (length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return `Use no more than ${PASSWORD_MAX_LENGTH} characters.`;
  }
  return null;
}

/** The error for a confirmation field, or null when it matches. */
export function confirmPasswordError(password: string, confirm: string): string | null {
  if (!confirm) return "Confirm your password.";
  return confirm === password ? null : "Passwords don't match.";
}

// Deliberately loose: one @, something on each side, a dot in the domain.
// The real check is the confirmation email.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emailError(email: string): string | null {
  const value = email.trim();
  if (!value) return "Enter your email address.";
  return EMAIL_PATTERN.test(value) ? null : "Enter a valid email address.";
}

/** For an existing password (login, current password): required only. */
export function requiredPasswordError(password: string): string | null {
  return password ? null : "Enter your password.";
}
