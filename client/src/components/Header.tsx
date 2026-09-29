import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/context/auth-context";

/** App header: brand, the signed-in user's email, and account/logout actions. */
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

  return (
    <header className="border-b">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 p-4">
        <span className="text-lg font-bold tracking-tight">Equity Lens</span>
        <div className="flex items-center gap-3">
          {user?.email && (
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {user.email}
            </span>
          )}
          {/* Demo users are anonymous and have no password to manage. */}
          {!isDemo && (
            <Button variant="ghost" size="sm" asChild>
              <Link to="/account">Account</Link>
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleSignOut()}
            disabled={signingOut}
          >
            {signingOut && <Loader2 className="animate-spin" />}
            Log out
          </Button>
        </div>
      </div>
    </header>
  );
}
