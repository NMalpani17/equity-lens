import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { HealthStatus } from "@/components/HealthStatus";

const healthyBody = {
  status: "ok",
  service: "equity-lens-api",
  version: "0.1.0",
  dependencies: {
    aiService: { status: "ok", service: "equity-lens-ai-service" },
  },
};

const degradedBody = {
  status: "degraded",
  service: "equity-lens-api",
  version: "0.1.0",
  dependencies: {
    aiService: { status: "unreachable", service: "ai-service" },
  },
};

describe("HealthStatus", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders both services as ok when the API reports healthy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(healthyBody), { status: 200 }),
    );

    render(<HealthStatus />);

    await waitFor(() => {
      expect(screen.getByText("API (Express)")).toBeInTheDocument();
    });
    expect(screen.getByText("AI service (FastAPI)")).toBeInTheDocument();
    expect(screen.getAllByText("ok")).toHaveLength(2);
  });

  it("shows 'waking up' (not degraded) while the ai-service is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(degradedBody), { status: 503 }),
    );

    render(<HealthStatus pollMs={60_000} />);

    expect(await screen.findByText("waking up")).toBeInTheDocument();
    // The API answered, so it's up; nothing reads "degraded" or "down".
    expect(screen.queryByText(/API unreachable/)).not.toBeInTheDocument();
    expect(screen.queryByText("degraded")).not.toBeInTheDocument();
    expect(screen.queryByText("down")).not.toBeInTheDocument();
    expect(screen.getAllByText("ok")).toHaveLength(1);
  });

  it("keeps re-checking while waking and shows ok once the ai-service is up", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify(degradedBody), { status: 503 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(degradedBody), { status: 503 }),
      )
      .mockResolvedValue(new Response(JSON.stringify(healthyBody), { status: 200 }));

    render(<HealthStatus pollMs={20} />);

    expect(await screen.findByText("waking up")).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("ok")).toHaveLength(2));
    expect(screen.queryByText("waking up")).not.toBeInTheDocument();
    const calls = fetchSpy.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fetchSpy.mock.calls.length).toBe(calls); // stops polling when healthy
  });

  it("still shows the API as degraded for other API problems", async () => {
    const otherDegraded = {
      ...healthyBody,
      status: "degraded",
      dependencies: { aiService: { status: "error", service: "ai-service" } },
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(otherDegraded), { status: 503 }),
    );

    render(<HealthStatus />);

    expect(await screen.findByText("degraded")).toBeInTheDocument();
    expect(screen.getByText("down")).toBeInTheDocument();
  });

  it("shows an error when the API is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    render(<HealthStatus />);

    await waitFor(() => {
      expect(screen.getByText(/API unreachable/)).toBeInTheDocument();
    });
  });
});
