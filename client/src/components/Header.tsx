import { useState } from "react";
import { Link, NavLink } from "react-router-dom";
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
import { Logo } from "@/components/Logo";
import { useAuth } from "@/context/auth-context";

const NAV_ITEMS = [
  { to: "/", label: "Portfolio", end: true },
  { to: "/chat", label: "AI analyst", end: false },
  { to: "/reports", label: "Reports", end: false },
];

/** App header: brand, main navigation, and user menu. */
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
    <header className="border-b bg-card">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-stretch justify-between gap-2 px-4 sm:gap-6 sm:px-6">
        <Link
          to="/"
          className="flex items-center whitespace-nowrap rounded-sm transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Logo compact />
        </Link>

        <nav
          aria-label="Main"
          className="mr-auto flex min-w-0 items-stretch gap-1 overflow-x-auto sm:gap-2"
        >
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `-mb-px flex items-center whitespace-nowrap border-b-2 px-2 text-sm transition-colors sm:px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                  isActive
                    ? "border-brand font-semibold text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="flex shrink-0 items-center">
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
      </div>
    </header>
  );
}
