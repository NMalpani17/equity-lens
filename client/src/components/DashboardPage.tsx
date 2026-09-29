import { Header } from "@/components/Header";
import { DemoBanner } from "@/components/DemoBanner";
import { Dashboard } from "@/components/portfolio/Dashboard";
import { HealthStatus } from "@/components/HealthStatus";
import { useAuth } from "@/context/auth-context";

/** The authenticated home page: header, portfolio dashboard, and health card. */
export function DashboardPage() {
  const { isDemo } = useAuth();

  return (
    <div className="min-h-screen">
      {isDemo && <DemoBanner />}
      <Header />
      <main>
        <Dashboard />
        <div className="mx-auto w-full max-w-6xl px-6 pb-10">
          <HealthStatus />
        </div>
      </main>
    </div>
  );
}
