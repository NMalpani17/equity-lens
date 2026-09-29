import { Header } from "@/components/Header";
import { Dashboard } from "@/components/portfolio/Dashboard";
import { HealthStatus } from "@/components/HealthStatus";

/** The authenticated home page: header, portfolio dashboard, and health card. */
export function DashboardPage() {
  return (
    <div className="min-h-screen">
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
