/** A stored research report as the ai-service writes it (snake_case). */
export function reportContent(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    ticker: "NVDA",
    company_name: "Nvidia Corp",
    quarter: { fiscal_year: 2027, fiscal_quarter: 2, call_date: "2026-08-26" },
    prior_quarter: { fiscal_year: 2027, fiscal_quarter: 1, call_date: "2026-05-28" },
    sections: [
      { key: "summary", title: "Summary", markdown: "Demand led Q2 FY2027 [1]." },
      {
        key: "drivers",
        title: "Demand and business drivers",
        markdown: "- Data center [1].",
      },
      { key: "guidance", title: "Guidance and outlook", markdown: "- Guided up [2]." },
      {
        key: "changes",
        title: "What changed vs last quarter",
        markdown: "### New\n- X [1].",
      },
      { key: "stock", title: "Stock performance", markdown: "- Up 20% [D2]." },
      { key: "risks", title: "Risks", markdown: "- Supply [1]." },
    ],
    citations: [
      {
        id: 1,
        ticker: "NVDA",
        company_name: "Nvidia Corp",
        fiscal_year: 2027,
        fiscal_quarter: 2,
        call_date: "2026-08-26",
        speaker: "Colette Kress",
        role: "CFO",
        section: "prepared_remarks",
        text: "Data center revenue grew.",
      },
    ],
    data_sources: [
      {
        id: "D2",
        kind: "price_history",
        ticker: "NVDA",
        label: "NVDA price history, 6mo (2026-04-01 to 2026-10-06)",
        as_of: "2026-10-06",
        data: { change_percent: 20 },
      },
    ],
    chart: null,
    market_data_available: true,
    comparison_available: true,
    as_of: {
      latest_call: "2026-08-26",
      quote: "2026-10-06 16:00 EDT",
      prices: "2026-10-06",
    },
    disclaimer: "General information, not financial advice.",
    agents: [
      { agent: "writer", model: "gemini-3.8-flash", status: "ok", cost_usd: 0.02 },
    ],
    ...overrides,
  };
}
