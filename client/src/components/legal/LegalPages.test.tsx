import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import App from "@/App";

/**
 * Rendered through the real routes with no AuthProvider: these pages must
 * never need a session (a protected route would throw without one).
 */
function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("Privacy page", () => {
  it("is public and covers what is collected, where, why, and deletion", () => {
    renderAt("/privacy");

    expect(screen.getByRole("heading", { level: 1, name: "Privacy" })).toBeVisible();
    for (const item of [/email address/i, /portfolio holdings/i, /chat history/i]) {
      expect(screen.getAllByText(item).length).toBeGreaterThan(0);
    }
    expect(screen.getByText(/stored in Supabase/)).toBeVisible();
    expect(screen.getByText(/Only to run the app/)).toBeVisible();
    expect(screen.getByText(/never sell your data/i)).toBeVisible();
    expect(screen.getByText(/Account settings → Delete account/)).toBeVisible();
    // Traces outlive account deletion; the page must say so.
    expect(screen.getByText(/aren't deleted with your account/)).toBeVisible();
  });
});

describe("Terms page", () => {
  it("is public and says personal project, not financial advice, as is", () => {
    renderAt("/terms");

    expect(screen.getByRole("heading", { level: 1, name: "Terms" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "A personal project" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Not financial advice" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Provided as is" })).toBeVisible();
  });

  it("links to the privacy page", () => {
    renderAt("/terms");

    fireEvent.click(screen.getAllByRole("link", { name: "Privacy" })[0]!);
    expect(screen.getByRole("heading", { level: 1, name: "Privacy" })).toBeVisible();
  });
});
