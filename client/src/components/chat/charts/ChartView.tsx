import { AllocationChart } from "@/components/chat/charts/AllocationChart";
import { PriceHistoryChart } from "@/components/chat/charts/PriceHistoryChart";
import type { ChatChart } from "@/lib/chatApi";

/** One inline chart. Default export so ChatCharts can lazy-load Recharts. */
export default function ChartView({ chart }: { chart: ChatChart }) {
  switch (chart.kind) {
    case "price_history":
      return <PriceHistoryChart chart={chart} />;
    case "portfolio_allocation":
      return <AllocationChart chart={chart} />;
    default:
      return null;
  }
}
