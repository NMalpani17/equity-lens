import { AlertTriangle, Clock, CreditCard, X } from "lucide-react";

import type { ChatBannerState } from "@/hooks/useChat";
import { cn } from "@/lib/utils";

const ICONS = {
  limit: Clock,
  busy: Clock,
  credits: CreditCard,
  error: AlertTriangle,
};

/** Error, rate-limit and capacity states for the chat. */
export function ChatBanner({
  banner,
  onDismiss,
}: {
  banner: ChatBannerState;
  onDismiss: () => void;
}) {
  const Icon = ICONS[banner.kind];
  return (
    <div
      role="alert"
      className={cn(
        "mx-3 mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
        banner.kind === "error"
          ? "border-destructive/40 bg-destructive/5 text-destructive"
          : "border-amber-300 bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100",
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <p className="flex-1">{banner.message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss message"
        className="rounded-sm opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}
