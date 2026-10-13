import { useCallback, useState } from "react";

type Validators<K extends string> = Record<K, () => string | null>;

interface Options<K extends string> {
  /**
   * Fields whose error shows while typing once they have a value (e.g. a
   * confirmation's "Passwords don't match"), not only after leaving them.
   */
  live?: Partial<Record<K, boolean>>;
}

/**
 * Per-field validation for a form: a field's error shows once the user has
 * left it (blur) or tried to submit; `live` fields also show it as they type.
 * Values stay in the caller's state, so nothing is cleared on an error.
 */
export function useFieldValidation<K extends string>(
  validators: Validators<K>,
  { live = {} }: Options<K> = {},
) {
  const [touched, setTouched] = useState<ReadonlySet<K>>(new Set());
  const [submitted, setSubmitted] = useState(false);

  const keys = Object.keys(validators) as K[];

  /** The error to show for a field right now, if any. */
  const errorFor = (key: K, hasValue: boolean): string | null => {
    const error = validators[key]();
    if (!error) return null;
    if (submitted || touched.has(key)) return error;
    return live[key] && hasValue ? error : null;
  };

  const blur = useCallback((key: K) => {
    setTouched((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, []);

  /**
   * Mark the form as submitted (so every error shows) and return the first
   * invalid field in declaration order, or null when the form is valid.
   */
  const validateAll = (): K | null => {
    setSubmitted(true);
    return keys.find((key) => validators[key]() !== null) ?? null;
  };

  const reset = useCallback(() => {
    setTouched(new Set());
    setSubmitted(false);
  }, []);

  return { errorFor, blur, validateAll, reset };
}
