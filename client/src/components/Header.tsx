import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronDown, LogOut, Settings } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/context/auth-context";

/** App header: brand and a user menu (account settings + logout). */
export function Header() {
  const { user, isDemo, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  // Demo users are anonymous (no email); show a generic label and initial.
  const label = isDemo ? "Demo user" : (user?.email ?? "Account");
  const initial = (isDemo ? "D" : (user?.email?.[0] ?? "?")).toUpperCase();

  return (
    <header className="border-b">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 p-4">
        <span className="text-lg font-bold tracking-tight">Equity Lens</span>

        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={`User menu for ${label}`}
            className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-[state=open]:bg-accent"
          >
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground"
            >
              {initial}
            </span>
            <span className="hidden max-w-[16ch] truncate text-muted-foreground sm:inline">
              {label}
            </span>
            <ChevronDown className="size-4 text-muted-foreground" aria-hidden="true" />
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="max-w-[16rem] truncate font-normal text-muted-foreground">
              {label}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {!isDemo && (
              <DropdownMenuItem asChild>
                <Link to="/account">
                  <Settings aria-hidden="true" />
                  Account settings
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => void handleSignOut()}
              disabled={signingOut}
            >
              <LogOut aria-hidden="true" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
