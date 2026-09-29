import { useState } from "react";
import { Link } from "react-router-dom";
import { LogOut, Settings } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuth } from "@/context/auth-context";

/** App header: brand and an avatar user menu (account settings + logout). */
export function Header() {
  const { user, isDemo, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      // signOut() clears the session and returns to /login with no return-to.
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
        <Link
          to="/"
          className="rounded-sm text-lg font-bold tracking-tight transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Equity Lens
        </Link>

        <TooltipProvider>
          <Tooltip>
            <DropdownMenu>
              {/* One avatar button acts as both the tooltip and menu trigger. */}
              <TooltipTrigger asChild>
                <DropdownMenuTrigger
                  aria-label={`User menu for ${label}`}
                  className="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 data-[state=open]:ring-2 data-[state=open]:ring-ring data-[state=open]:ring-offset-2"
                >
                  {initial}
                </DropdownMenuTrigger>
              </TooltipTrigger>

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

            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </header>
  );
}
