import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { Logo } from "@/components/Logo";
import { Card } from "@/components/ui/card";

const LINK =
  "rounded-sm font-medium underline underline-offset-4 hover:text-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** When the Privacy and Terms pages last changed. */
export const LEGAL_UPDATED = "October 12, 2026";

/**
 * A public, plain-language page (Privacy, Terms): no sign-in needed. The
 * logo links home, which shows the login page to signed-out visitors.
 */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center gap-6 px-4 py-10">
      <Link
        to="/"
        className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Logo />
      </Link>
      <Card className="w-full max-w-2xl">
        <article className="space-y-6 p-6 sm:p-8">
          <header className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="text-sm text-muted-foreground">
              Last updated {LEGAL_UPDATED}
            </p>
          </header>
          <div className="space-y-6 text-sm leading-relaxed">{children}</div>
        </article>
      </Card>
      <LegalLinks />
    </div>
  );
}

/** A titled part of a legal page. */
export function LegalSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/** The small Privacy · Terms footer (login page and the legal pages). */
export function LegalLinks() {
  return (
    <nav
      aria-label="Legal"
      className="flex items-center gap-3 text-xs text-muted-foreground"
    >
      <Link to="/privacy" className={LINK}>
        Privacy
      </Link>
      <span aria-hidden="true">·</span>
      <Link to="/terms" className={LINK}>
        Terms
      </Link>
    </nav>
  );
}
