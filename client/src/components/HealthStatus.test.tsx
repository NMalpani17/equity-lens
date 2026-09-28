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

  it("shows an error when the API is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    render(<HealthStatus />);

    await waitFor(() => {
      expect(screen.getByText(/API unreachable/)).toBeInTheDocument();
    });
  });
});
