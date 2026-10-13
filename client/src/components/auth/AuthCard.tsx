import type { ReactNode } from "react";

import { Logo } from "@/components/Logo";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";

interface AuthCardProps {
  title: string;
  description?: ReactNode;
  /** Above the title inside the card (e.g. the log in / sign up switch). */
  top?: ReactNode;
  /** One muted line under the logo (the login / sign-up page only). */
  tagline?: string;
  /** Small print under the card (e.g. the Privacy and Terms links). */
  footer?: ReactNode;
  children: ReactNode;
}

/** The centered, bordered card every auth screen uses, with the logo above it. */
export function AuthCard({
  title,
  description,
  top,
  tagline,
  footer,
  children,
}: AuthCardProps) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-10">
      <div className="flex flex-col items-center gap-2 text-center">
        <Logo />
        {tagline && <p className="text-sm text-muted-foreground">{tagline}</p>}
      </div>
      <Card className="w-full max-w-md">
        {top && <div className="px-6 pt-6">{top}</div>}
        <CardHeader className="gap-1.5 pb-4">
          <h1 className="text-xl font-semibold leading-tight tracking-tight">
            {title}
          </h1>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent className="flex flex-col gap-5">{children}</CardContent>
      </Card>
      {footer}
    </div>
  );
}
