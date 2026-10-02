import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/context/auth-context", () => ({ useAuth: vi.fn() }));
vi.mock("@/lib/chatApi", () => ({
  listConversations: vi.fn(),
  createConversation: vi.fn(),
  renameConversation: vi.fn(),
  deleteConversation: vi.fn(),
  listMessages: vi.fn(),
  getChatUsage: vi.fn(),
  streamMessage: vi.fn(),
}));

import { useAuth } from "@/context/auth-context";
import { ApiError } from "@/lib/api";
import * as chatApi from "@/lib/chatApi";
import type { ChatMessage, ChatStreamEvent, Citation } from "@/lib/chatApi";
import { ChatPage } from "./ChatPage";

const api = vi.mocked(chatApi);
const CONV = { id: "c1", title: "New chat", createdAt: "x", updatedAt: "x" };

const citation: Citation = {
  id: 1,
  ticker: "NVDA",
  companyName: "Nvidia Corp",
  fiscalYear: 2027,
  fiscalQuarter: 2,
  callDate: "2026-08-26",
  speaker: "Colette Kress",
  role: "CFO",
  section: "prepared_remarks",
  text: "We expect Vera Rubin to be the fastest ramp in our history.",
};

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m",
    role: "assistant",
    content: "",
    status: "complete",
    citations: [],
    toolCalls: [],
    errorCode: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function mockAuth(isDemo = false) {
  vi.mocked(useAuth).mockReturnValue({
    session: null,
    user: { email: "me@example.com" } as never,
    loading: false,
    isDemo,
    isPasswordRecovery: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
    signInWithDemo: vi.fn(),
    sendPasswordReset: vi.fn(),
    updatePassword: vi.fn(),
    signOut: vi.fn(),
  });
}

function renderPage() {
  render(
    <MemoryRouter>
      <ChatPage />
    </MemoryRouter>,
  );
}

function sendViaComposer(text: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth();
  api.listConversations.mockResolvedValue([]);
  api.getChatUsage.mockResolvedValue({
    used: 0,
    limit: 20,
    remaining: 20,
    resetsAt: "2026-10-02T00:00:00.000Z",
    isDemo: false,
  });
  api.createConversation.mockResolvedValue(CONV);
  api.listMessages.mockResolvedValue([]);
});

describe("ChatPage", () => {
  it("shows starter questions in an empty conversation", async () => {
    renderPage();

    expect(await screen.findByText("Ask the AI analyst")).toBeInTheDocument();
    expect(screen.getByText(/Vera Rubin timing last quarter/)).toBeInTheDocument();
  });

  it("streams tool progress and tokens, then shows the cited answer", async () => {
    let emit: (event: ChatStreamEvent) => void = () => {};
    let finish: () => void = () => {};
    api.streamMessage.mockImplementation(async (_id, _content, onEvent) => {
      emit = onEvent;
      await new Promise<void>((resolve) => (finish = resolve));
    });
    renderPage();
    await screen.findByText("Ask the AI analyst");

    sendViaComposer("What did NVDA say about Vera Rubin?");
    await waitFor(() => expect(api.streamMessage).toHaveBeenCalled());
    expect(screen.getByRole("textbox")).toBeDisabled(); // no overlapping turns

    emit({
      type: "turn",
      conversation: { ...CONV, title: "What did NVDA say about Vera Rubin?" },
      userMessage: msg({
        id: "u1",
        role: "user",
        content: "What did NVDA say about Vera Rubin?",
      }),
      assistantMessageId: "a1",
    });
    emit({
      type: "tool_start",
      id: "t1",
      name: "search_transcripts",
      label: "Searching NVDA transcripts…",
      args: {},
    });
    expect(await screen.findByText("Searching NVDA transcripts…")).toBeInTheDocument();
    emit({
      type: "tool_end",
      id: "t1",
      name: "search_transcripts",
      ok: true,
      summary: "Found 5 passages",
    });
    emit({ type: "token", text: "NVIDIA expects " });
    emit({ type: "token", text: "the fastest ramp [1]." });
    expect(
      await screen.findByText(/NVIDIA expects the fastest ramp/),
    ).toBeInTheDocument();

    emit({
      type: "done",
      message: msg({
        id: "a1",
        content: "NVIDIA expects the fastest ramp in its history [1].",
        citations: [citation],
        toolCalls: [
          {
            id: "t1",
            name: "search_transcripts",
            label: "Searching NVDA transcripts…",
            args: {},
            ok: true,
          },
        ],
      }),
    });
    finish();

    const cite = await screen.findByRole("button", {
      name: /Source 1: NVDA Q2 FY2027/,
    });
    await waitFor(() => expect(screen.getByRole("textbox")).not.toBeDisabled());
    const sidebar = screen.getByRole("complementary", { name: "Conversations" });
    expect(
      within(sidebar).getByRole("button", {
        name: "What did NVDA say about Vera Rubin?",
      }),
    ).toBeInTheDocument();

    fireEvent.click(cite);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Nvidia Corp \(NVDA\)/)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Q2 FY2027 earnings call · 2026-08-26/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(citation.text)).toBeInTheDocument();
  });

  it("updates a running tool's label from tool_progress events", async () => {
    let emit: (event: ChatStreamEvent) => void = () => {};
    api.streamMessage.mockImplementation(async (_id, _content, onEvent) => {
      emit = onEvent;
      await new Promise<void>(() => {});
    });
    renderPage();
    await screen.findByText("Ask the AI analyst");

    sendViaComposer("What did Starbucks say about traffic?");
    await waitFor(() => expect(api.streamMessage).toHaveBeenCalled());
    emit({
      type: "tool_start",
      id: "s1",
      name: "search_transcripts",
      label: "Searching SBUX transcripts…",
      args: {},
    });
    expect(await screen.findByText("Searching SBUX transcripts…")).toBeInTheDocument();
    emit({ type: "tool_progress", id: "s1", label: "Indexing Starbucks transcripts…" });

    expect(
      await screen.findByText("Indexing Starbucks transcripts…"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Searching SBUX transcripts…")).not.toBeInTheDocument();
  });

  it("offers Retry on stopped and failed replies and re-sends the question", async () => {
    api.listConversations.mockResolvedValue([{ ...CONV, title: "Earlier chat" }]);
    api.listMessages.mockResolvedValue([
      msg({ id: "u1", role: "user", content: "What did NVDA say about demand?" }),
      msg({ id: "a1", status: "interrupted", content: "Demand was" }),
      msg({ id: "u2", role: "user", content: "And AMD?" }),
      msg({ id: "a2", status: "error", errorCode: "ai_rate_limited" }),
      msg({ id: "u3", role: "user", content: "Thanks" }),
      msg({ id: "a3", status: "complete", content: "You're welcome." }),
    ]);
    api.streamMessage.mockResolvedValue(undefined);
    renderPage();
    const sidebar = screen.getByRole("complementary", { name: "Conversations" });
    fireEvent.click(
      await within(sidebar).findByRole("button", { name: "Earlier chat" }),
    );
    await screen.findByText("You're welcome.");

    const retries = screen.getAllByRole("button", { name: "Retry" });
    expect(retries).toHaveLength(2); // not on the complete reply

    fireEvent.click(retries[0]!);
    await waitFor(() => expect(api.streamMessage).toHaveBeenCalledTimes(1));
    expect(api.streamMessage.mock.calls[0]![1]).toBe("What did NVDA say about demand?");

    await waitFor(() => expect(screen.getByRole("textbox")).not.toBeDisabled());
    fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[1]!);
    await waitFor(() => expect(api.streamMessage).toHaveBeenCalledTimes(2));
    expect(api.streamMessage.mock.calls[1]![1]).toBe("And AMD?");
  });

  it("shows a rate-limit banner when the daily cap is reached", async () => {
    api.streamMessage.mockRejectedValue(
      new ApiError(
        429,
        "You've reached today's limit of 20 messages.",
        "chat_limit_reached",
      ),
    );
    renderPage();
    await screen.findByText("Ask the AI analyst");

    sendViaComposer("NVDA outlook?");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "today's limit of 20 messages",
    );
  });

  it("shows a credits banner for an upstream credit error and never a blank bubble", async () => {
    api.streamMessage.mockImplementation(async (_id, _content, onEvent) => {
      onEvent({
        type: "error",
        code: "ai_credits_exhausted",
        message: "The AI analyst is out of credits right now.",
        retryable: false,
      });
      onEvent({
        type: "done",
        message: msg({ id: "a1", status: "error", errorCode: "ai_credits_exhausted" }),
      });
    });
    renderPage();
    await screen.findByText("Ask the AI analyst");

    sendViaComposer("NVDA outlook?");

    expect(await screen.findByRole("alert")).toHaveTextContent("out of credits");
    expect(
      await screen.findByText("This reply failed. Please try again."),
    ).toBeInTheDocument();
  });

  it("stops a streaming reply and keeps it as interrupted", async () => {
    let signal: AbortSignal | undefined;
    api.streamMessage.mockImplementation(async (_id, _content, onEvent, s) => {
      signal = s;
      onEvent({ type: "token", text: "Demand was strong" });
      await new Promise<void>((_, reject) =>
        s?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      );
    });
    renderPage();
    await screen.findByText("Ask the AI analyst");

    sendViaComposer("NVDA outlook?");
    await screen.findByText("Demand was strong");
    fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));

    await waitFor(() => expect(signal?.aborted).toBe(true));
    expect(await screen.findByText("Stopped")).toBeInTheDocument();
    expect(screen.getByText("Demand was strong")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows remaining demo messages and disables input when they run out", async () => {
    mockAuth(true);
    api.getChatUsage.mockResolvedValue({
      used: 5,
      limit: 5,
      remaining: 0,
      resetsAt: "2026-10-02T00:00:00.000Z",
      isDemo: true,
    });
    renderPage();

    expect(await screen.findByTestId("chat-usage")).toHaveTextContent(
      "used all 5 messages",
    );
    expect(screen.getByRole("textbox")).toBeDisabled();
  });

  it("renders model markdown without raw HTML and opens links safely", async () => {
    api.listConversations.mockResolvedValue([{ ...CONV, title: "Earlier chat" }]);
    api.listMessages.mockResolvedValue([
      msg({ id: "u1", role: "user", content: "hi" }),
      msg({
        id: "a1",
        content:
          'See <img src=x onerror="alert(1)"> **bold** [docs](https://example.com) and [bad](javascript:alert(1)).',
      }),
    ]);
    renderPage();

    const sidebar = screen.getByRole("complementary", { name: "Conversations" });
    fireEvent.click(
      await within(sidebar).findByRole("button", { name: "Earlier chat" }),
    );
    expect(await screen.findByText("bold")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
    const bad = screen.queryByRole("link", { name: "bad" });
    expect(bad?.getAttribute("href") ?? "").not.toContain("javascript:");
  });
});
