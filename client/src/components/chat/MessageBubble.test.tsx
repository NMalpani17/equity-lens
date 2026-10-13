import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { AllocationChart, ChatMessage } from "@/lib/chatApi";
import { MessageBubble } from "./MessageBubble";

// Stand-in for the lazy Recharts view: only *whether* charts render matters here.
vi.mock("@/components/chat/ChatCharts", () => ({
  ChatCharts: ({ charts }: { charts: { id: string }[] }) =>
    charts.length > 0 ? (
      <div data-testid="charts">{charts.map((c) => c.id).join(",")}</div>
    ) : null,
}));

const chart: AllocationChart = {
  id: "chart-p1",
  kind: "portfolio_allocation",
  currency: "USD",
  slices: [{ ticker: "NVDA", name: null, marketValue: 1000, weightPercent: 100 }],
  totalMarketValue: 1000,
  partial: false,
  asOf: null,
};

function reply(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "Your portfolio is all Nvidia.",
    status: "complete",
    citations: [],
    charts: [chart],
    toolCalls: [],
    errorCode: null,
    createdAt: "2026-10-04T12:00:00Z",
    ...overrides,
  };
}

describe("MessageBubble charts", () => {
  it("holds a streaming reply's charts back until the answer finishes", () => {
    const { rerender } = render(
      <MessageBubble
        message={reply({ status: "streaming", content: "" })}
        streamText="Your portfolio is"
      />,
    );

    expect(screen.getByText("Your portfolio is")).toBeInTheDocument();
    expect(screen.queryByTestId("charts")).not.toBeInTheDocument();

    rerender(<MessageBubble message={reply()} />);

    expect(screen.getByTestId("charts")).toHaveTextContent("chart-p1");
    // Charts come after the text.
    const text = screen.getByText("Your portfolio is all Nvidia.");
    expect(
      text.compareDocumentPosition(screen.getByTestId("charts")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("shows charts on a reply that stopped mid-stream", () => {
    render(<MessageBubble message={reply({ status: "interrupted" })} />);

    expect(screen.getByTestId("charts")).toBeInTheDocument();
  });

  it("shows a saved message's charts right away", () => {
    render(<MessageBubble message={reply()} />);

    expect(screen.getByTestId("charts")).toHaveTextContent("chart-p1");
  });
});

describe("MessageBubble research steps", () => {
  const step = (id: string, label: string) => ({
    id,
    name: "get_quote",
    label,
    args: {},
  });

  it("counts the steps behind a reply in plain words, listing them on hover", () => {
    render(
      <MessageBubble
        message={reply({
          charts: [],
          toolCalls: [
            step("t1", "Getting NVDA quote…"),
            step("t2", "Reading your portfolio…"),
          ],
        })}
      />,
    );

    expect(screen.getByText("2 research steps")).toHaveAttribute(
      "title",
      "Getting NVDA quote…\nReading your portfolio…",
    );
    expect(screen.queryByText(/tool call/)).not.toBeInTheDocument();
  });

  it("uses the singular for one step", () => {
    render(
      <MessageBubble
        message={reply({ charts: [], toolCalls: [step("t1", "Getting NVDA quote…")] })}
      />,
    );

    expect(screen.getByText("1 research step")).toBeInTheDocument();
  });
});
