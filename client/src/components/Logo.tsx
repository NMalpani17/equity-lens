import { cn } from "@/lib/utils";

/**
 * The Equity Lens mark: a navy lens with a sky-blue rising chart line inside.
 * Same geometry as public/favicon.svg, which uses heavier strokes so it
 * still reads at 16 px.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={cn("size-7 shrink-0", className)}
    >
      <circle cx="13.5" cy="13.5" r="9.5" stroke="var(--primary)" strokeWidth="3" />
      <path
        d="M20.5 20.5 27.5 27.5"
        stroke="var(--primary)"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path
        d="M8.5 17 12 13.5 14.5 15.5 18.5 10"
        stroke="var(--brand)"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Mark plus the "Equity Lens" wordmark. `compact` shows only the mark on
 * phones (the name stays available to screen readers).
 */
export function Logo({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark />
      <span
        className={cn(
          "text-lg font-bold tracking-tight text-primary",
          compact && "sr-only sm:not-sr-only",
        )}
      >
        Equity Lens
      </span>
    </span>
  );
}
