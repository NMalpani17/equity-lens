import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { HealthIndicator } from "@/components/HealthIndicator";

const healthy = {
  status: "ok",
  service: "equity-lens-api",
  version: "0.1.0",
  dependencies: { aiService: { status: "ok", service: "equity-lens-ai-service" } },
};
const waking = {
  status: "degraded",
  service: "equity-lens-api",
  version: "0.1.0",
  dependencies: { aiService: { status: "unreachable", service: "ai-service" } },
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function dot() {
  return screen.getByRole("button", { name: /System status/ });
}

function dotState() {
  return dot().querySelector("[data-status]")!.getAttribute("data-status");
}

describe("HealthIndicator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is green with an accessible description when everything is ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(healthy));

    render(<HealthIndicator />);

    await waitFor(() => expect(dotState()).toBe("ok"));
    expect(dot()).toHaveAccessibleName(
      "System status: All systems ok. API: ok. AI service: ok.",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "System status: All systems ok",
    );
  });

  it("is amber while the ai-service wakes, keeps polling, then turns green", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(respond(waking, 503))
      .mockResolvedValueOnce(respond(waking, 503))
      .mockResolvedValue(respond(healthy));

    render(<HealthIndicator pollMs={20} />);

    await waitFor(() => expect(dotState()).toBe("waking"));
    expect(dot()).toHaveAccessibleName(
      "System status: AI service waking up. API: ok. AI service: waking up.",
    );
    await waitFor(() => expect(dotState()).toBe("ok"));
    const calls = fetchSpy.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fetchSpy.mock.calls.length).toBe(calls); // stops polling once healthy
  });

  it("is red when the API can't be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    render(<HealthIndicator />);

    await waitFor(() => expect(dotState()).toBe("degraded"));
    expect(dot()).toHaveAccessibleName(
      "System status: Degraded. API: unreachable. AI service: unreachable.",
    );
  });

  it("is red for any other unhealthy answer, and survives a malformed body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond({ holdings: [] }));

    render(<HealthIndicator />);

    await waitFor(() => expect(dotState()).toBe("degraded"));
  });

  it("shows per-service status in a tooltip on keyboard focus", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(waking, 503));
    render(<HealthIndicator pollMs={60_000} />);
    await waitFor(() => expect(dotState()).toBe("waking"));

    fireEvent.focus(dot());

    const tooltip = await screen.findByRole("tooltip");
    expect(within(tooltip).getByText("API")).toBeInTheDocument();
    expect(within(tooltip).getByText("AI service")).toBeInTheDocument();
    expect(within(tooltip).getByText("waking up")).toBeInTheDocument();
  });

  it("is a focusable button", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respond(healthy));
    render(<HealthIndicator />);

    dot().focus();

    expect(dot()).toHaveFocus();
    expect(dot()).toHaveAttribute("type", "button");
  });
});
