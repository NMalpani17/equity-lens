import { HealthStatus } from "@/components/HealthStatus";

function App() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-6">
      <header className="text-center">
        <h1 className="text-3xl font-bold tracking-tight">Equity Lens</h1>
        <p className="text-muted-foreground">AI investment research platform</p>
      </header>
      <HealthStatus />
    </main>
  );
}

export default App;
