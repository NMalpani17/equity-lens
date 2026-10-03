import { useEffect, useState } from "react";
import { X } from "lucide-react";

import { Header } from "@/components/Header";
import { DemoBanner } from "@/components/DemoBanner";
import { Dashboard } from "@/components/portfolio/Dashboard";
import { useAuth } from "@/context/auth-context";
import { consumeAuthFlash } from "@/lib/authFlash";

/** The authenticated home page: header and portfolio dashboard. */
export function DashboardPage() {
  const { isDemo } = useAuth();
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    // Show a one-shot handoff message (e.g. after a password reset) once.
    const message = consumeAuthFlash();
    if (message) {
      setFlash(message);
    }
  }, []);

  return (
    <div className="min-h-screen">
      {isDemo && <DemoBanner />}
      {flash && (
        <div
          role="status"
          className="flex items-center justify-center gap-3 bg-emerald-500/15 px-4 py-2 text-center text-sm text-emerald-900 dark:text-emerald-200"
        >
          <span>{flash}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setFlash(null)}
            className="rounded-sm p-0.5 transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      )}
      <Header />
      <main>
        <Dashboard />
      </main>
    </div>
  );
}
