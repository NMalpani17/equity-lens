import { Check, Circle } from "lucide-react";

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  meetsPasswordRule,
  passwordLength,
} from "@/lib/validation";

/**
 * The password requirement, updated as the user types: a check once the
 * password is 8–64 characters. Screen readers hear it only when the state
 * changes (the text changes then, not on every keystroke).
 */
export function PasswordRequirement({ password }: { password: string }) {
  const met = meetsPasswordRule(password);
  const tooLong = passwordLength(password) > PASSWORD_MAX_LENGTH;
  const Icon = met ? Check : Circle;

  return (
    <p
      aria-live="polite"
      className={`flex items-center gap-1.5 text-xs ${met ? "text-foreground" : "text-muted-foreground"}`}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span>
        {PASSWORD_MIN_LENGTH}–{PASSWORD_MAX_LENGTH} characters
        <span className="sr-only">
          {met ? " (met)" : tooLong ? " (too long)" : " (not met yet)"}
        </span>
      </span>
    </p>
  );
}
