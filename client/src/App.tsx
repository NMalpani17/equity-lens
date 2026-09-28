import { Dashboard } from "@/components/portfolio/Dashboard";
import { HealthStatus } from "@/components/HealthStatus";

function App() {
  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between p-4">
          <span className="text-lg font-bold tracking-tight">Equity Lens</span>
          <span className="text-sm text-muted-foreground">AI investment research</span>
        </div>
      </header>

      <main>
        <Dashboard />
        <div className="mx-auto w-full max-w-6xl px-6 pb-10">
          <HealthStatus />
        </div>
      </main>
    </div>
  );
}

export default App;
