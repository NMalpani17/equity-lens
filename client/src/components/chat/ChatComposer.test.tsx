import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { ChatComposer, MAX_MESSAGE_CHARS } from "@/components/chat/ChatComposer";

function type(value: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value } });
}

describe("ChatComposer", () => {
  it("sends on Enter and clears the input", () => {
    const onSend = vi.fn();
    render(<ChatComposer streaming={false} onSend={onSend} onStop={vi.fn()} />);

    type("What did NVDA say?");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("What did NVDA say?");
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("does not send on Shift+Enter or when empty", () => {
    const onSend = vi.fn();
    render(<ChatComposer streaming={false} onSend={onSend} onStop={vi.fn()} />);

    type("line one");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", shiftKey: true });
    type("   ");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    expect(onSend).not.toHaveBeenCalled();
  });

  it("disables input while streaming and offers Stop", () => {
    const onStop = vi.fn();
    render(<ChatComposer streaming onSend={vi.fn()} onStop={onStop} />);

    expect(screen.getByRole("textbox")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));
    expect(onStop).toHaveBeenCalled();
  });

  it("blocks messages over the limit with a clear error", () => {
    const onSend = vi.fn();
    render(<ChatComposer streaming={false} onSend={onSend} onStop={vi.fn()} />);

    type("x".repeat(MAX_MESSAGE_CHARS + 1));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    expect(screen.getByRole("alert")).toHaveTextContent("limited to 2,000 characters");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(onSend).not.toHaveBeenCalled();
  });
});
