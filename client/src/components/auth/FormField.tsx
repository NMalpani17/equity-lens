import type { ReactNode } from "react";

import { Label } from "@/components/ui/label";

/** Props a field's control needs so its label, hint and error are announced. */
export interface FieldControlProps {
  id: string;
  "aria-invalid": boolean;
  "aria-describedby"?: string;
}

interface FormFieldProps {
  id: string;
  label: string;
  /** The current error, shown under the control and linked to it. */
  error?: string | null;
  /** Persistent help under the control (e.g. the password requirement). */
  hint?: ReactNode;
  /** Something under the control, after the hint (e.g. "Forgot password?"). */
  footer?: ReactNode;
  children: (control: FieldControlProps) => ReactNode;
}

/** A label above its control, with an optional hint and an inline error. */
export function FormField({
  id,
  label,
  error,
  hint,
  footer,
  children,
}: FormFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children({
        id,
        "aria-invalid": Boolean(error),
        "aria-describedby": describedBy,
      })}
      {hint && <div id={hintId}>{hint}</div>}
      {error && (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
      {footer}
    </div>
  );
}
