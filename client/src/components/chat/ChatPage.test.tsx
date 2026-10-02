import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
  streamRetry: vi.fn(),
}));

import { useAuth } from "@/context/auth-context";
import { ApiError } from "@/lib/api";
import * as chatApi from "@/lib/chatApi";
import type { ChatMessage, ChatStreamEvent, Citation, PriceChart } from "@/lib/chatApi";
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

const priceChart: PriceChart = {
  id: "chart-h1",
  kind: "price_history",
  ticker: "NVDA",
  period: "6mo",
  currency: "USD",
  points: [
    { date: "2026-04-01", close: 100 },
    { date: "2026-10-01", close: 120 },
  ],
  firstClose: 100,
  lastClose: 120,
  change: 20,
  changePercent: 20,
  high: 120,
  low: 100,
  asOf: null,
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

// Stream events are pushed from test code, outside React; tests wrap them in
// act() (emit = (event) => act(() => onEvent(event))) so updates flush cleanly.
function sendViaComposer(text: string) {
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
}

// Charts are lazy-loaded; load the chunk once so findBy timeouts don't race it.
beforeAll(async () => {
  await import("./charts/ChartView");
});

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
      emit = (event) => act(() => onEvent(event));
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
    await act(async () => finish());

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
      emit = (event) => act(() => onEvent(event));
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

  async function openEarlierChat(messages: ChatMessage[]) {
    api.listConversations.mockResolvedValue([{ ...CONV, title: "Earlier chat" }]);
    api.listMessages.mockResolvedValue(messages);
    renderPage();
    const sidebar = screen.getByRole("complementary", { name: "Conversations" });
    fireEvent.click(
      await within(sidebar).findByRole("button", { name: "Earlier chat" }),
    );
  }

  it("shows a chart as soon as its tool returns and keeps the saved one", async () => {
    let emit: (event: ChatStreamEvent) => void = () => {};
    let finish: () => void = () => {};
    api.streamMessage.mockImplementation(async (_id, _content, onEvent) => {
      emit = (event) => act(() => onEvent(event));
      await new Promise<void>((resolve) => (finish = resolve));
    });
    renderPage();
    await screen.findByText("Ask the AI analyst");

    sendViaComposer("How has NVDA traded over 6 months?");
    await waitFor(() => expect(api.streamMessage).toHaveBeenCalled());
    emit({ type: "chart", chart: priceChart });

    expect(await screen.findByText("NVDA · 6 months")).toBeInTheDocument();

    emit({
      type: "done",
      message: msg({
        id: "a1",
        content: "NVDA rose 20% over six months.",
        charts: [priceChart],
      }),
    });
    await act(async () => finish());

    expect(
      await screen.findByText("NVDA rose 20% over six months."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("NVDA · 6 months")).toHaveLength(1);
  });

  it("shows saved charts when an earlier conversation is reopened", async () => {
    await openEarlierChat([
      msg({ id: "u1", role: "user", content: "How has NVDA traded?" }),
      msg({ id: "a1", content: "NVDA rose 20%.", charts: [priceChart] }),
      // Messages saved before charts existed have no charts field.
      msg({ id: "u2", role: "user", content: "Thanks" }),
      { ...msg({ id: "a2", content: "You're welcome." }), charts: undefined },
    ]);

    expect(await screen.findByText("NVDA · 6 months")).toBeInTheDocument();
    expect(screen.getByText("You're welcome.")).toBeInTheDocument();
  });

  it("offers Retry only on the latest stopped or failed reply", async () => {
    await openEarlierChat([
      msg({ id: "u1", role: "user", content: "What did NVDA say about demand?" }),
      msg({ id: "a1", status: "interrupted", content: "Demand was" }),
      msg({ id: "u2", role: "user", content: "And AMD?" }),
      msg({ id: "a2", status: "error", errorCode: "ai_rate_limited" }),
    ]);
    await screen.findByText("Demand was");

    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
  });

  it("does not offer Retry on a complete reply", async () => {
    await openEarlierChat([
      msg({ id: "u1", role: "user", content: "Thanks" }),
      msg({ id: "a1", status: "complete", content: "You're welcome." }),
    ]);
    await screen.findByText("You're welcome.");

    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("retries in place: no repeated question and only one answer", async () => {
    await openEarlierChat([
      msg({ id: "u1", role: "user", content: "What did NVDA say about demand?" }),
      msg({ id: "a1", status: "interrupted", content: "Demand was" }),
    ]);
    let emit: (event: ChatStreamEvent) => void = () => {};
    let finish: () => void = () => {};
    api.streamRetry.mockImplementation(async (_id, _messageId, onEvent) => {
      emit = (event) => act(() => onEvent(event));
      await new Promise<void>((resolve) => (finish = resolve));
    });
    await screen.findByText("Demand was");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.streamRetry).toHaveBeenCalled());
    expect(api.streamRetry.mock.calls[0]!.slice(0, 2)).toEqual(["c1", "a1"]);
    expect(api.streamMessage).not.toHaveBeenCalled();
    // The stopped text is replaced by the new stream, not kept alongside it.
    expect(screen.queryByText("Demand was")).not.toBeInTheDocument();

    emit({
      type: "turn",
      conversation: CONV,
      userMessage: msg({
        id: "u1",
        role: "user",
        content: "What did NVDA say about demand?",
      }),
      assistantMessageId: "a1",
    });
    emit({ type: "token", text: "Demand stayed strong." });
    expect(await screen.findByText("Demand stayed strong.")).toBeInTheDocument();
    emit({
      type: "done",
      message: msg({ id: "a1", content: "Demand stayed strong." }),
    });
    await act(async () => finish());

    await waitFor(() => expect(screen.getByRole("textbox")).not.toBeDisabled());
    expect(screen.getAllByText("What did NVDA say about demand?")).toHaveLength(1);
    expect(screen.getAllByText("Demand stayed strong.")).toHaveLength(1);
    // One question bubble and one reply bubble (plus the scroll anchor).
    const region = screen.getByRole("region", { name: "Messages" });
    expect(region.querySelectorAll(":scope > div.flex")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("reloads the thread if a retry is refused", async () => {
    const thread = [
      msg({ id: "u1", role: "user", content: "What did NVDA say?" }),
      msg({ id: "a1", status: "error" }),
    ];
    await openEarlierChat(thread);
    api.streamRetry.mockRejectedValue(
      new ApiError(
        409,
        "Only the latest stopped or failed reply can be retried.",
        "retry_not_allowed",
      ),
    );
    await screen.findByText("This reply failed. Please try again.");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only the latest stopped or failed reply",
    );
    expect(api.listMessages).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("What did NVDA say?")).toHaveLength(1);
  });

  describe("Stop, errors and Retry never get stuck", () => {
    const SAVED = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    const question = msg({ id: "u1", role: "user", content: "What did NVDA say?" });
    const untilAborted = (signal?: AbortSignal) =>
      new Promise<void>((_, reject) =>
        signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        ),
      );
    // Re-query each time: the re-sync swaps the bubble for the saved message.
    const enabledRetry = () =>
      waitFor(() => {
        const button = screen.getByRole("button", { name: "Retry" });
        expect(button).not.toBeDisabled(); // re-sync done
        return button;
      });

    it("Stop then Retry retries the saved reply id, not the browser placeholder", async () => {
      api.streamMessage.mockImplementation(async (_id, _content, onEvent, signal) => {
        onEvent({
          type: "turn",
          conversation: { ...CONV, title: "What did NVDA say?" },
          userMessage: question,
          assistantMessageId: SAVED,
        });
        onEvent({ type: "token", text: "Demand was" });
        await untilAborted(signal);
      });
      api.listMessages.mockResolvedValue([
        question,
        msg({ id: SAVED, status: "interrupted", content: "Demand was" }),
      ]);
      api.streamRetry.mockImplementation(async (_id, messageId, onEvent) => {
        onEvent({ type: "done", message: msg({ id: messageId, content: "Strong." }) });
      });
      renderPage();
      await screen.findByText("Ask the AI analyst");

      sendViaComposer("What did NVDA say?");
      await screen.findByText("Demand was");
      fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));
      fireEvent.click(await enabledRetry());

      await waitFor(() => expect(api.streamRetry).toHaveBeenCalled());
      expect(api.streamRetry.mock.calls[0]!.slice(0, 2)).toEqual(["c1", SAVED]);
      expect(await screen.findByText("Strong.")).toBeInTheDocument();
      expect(
        screen.getAllByText("What did NVDA say?", { selector: "div" }),
      ).toHaveLength(1);
    });

    it("Stop before the reply starts: no Thinking…, the title and saved id arrive", async () => {
      api.streamMessage.mockImplementation(async (_id, _content, _onEvent, signal) => {
        await untilAborted(signal); // stopped before the server's turn event
      });
      api.listConversations
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ ...CONV, title: "What did NVDA say?" }]);
      api.listMessages.mockResolvedValue([
        question,
        msg({ id: SAVED, status: "interrupted" }),
      ]);
      api.streamRetry.mockResolvedValue(undefined);
      renderPage();
      await screen.findByText("Ask the AI analyst");

      sendViaComposer("What did NVDA say?");
      expect(await screen.findByText("Thinking…")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));
      const retry = await enabledRetry(); // re-synced with the server
      expect(
        screen.getByText("Stopped before an answer was written."),
      ).toBeInTheDocument();
      expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
      const sidebar = screen.getByRole("complementary", { name: "Conversations" });
      expect(
        await within(sidebar).findByRole("button", { name: "What did NVDA say?" }),
      ).toBeInTheDocument();
      fireEvent.click(retry);
      await waitFor(() => expect(api.streamRetry).toHaveBeenCalled());
      expect(api.streamRetry.mock.calls[0]![1]).toBe(SAVED);
    });

    it("a failed retry shows a friendly message and the failed reply with Retry", async () => {
      await openEarlierChat([question, msg({ id: SAVED, status: "error" })]);
      api.streamRetry.mockRejectedValue(
        new ApiError(422, "invalid message id", "validation_error"),
      );
      fireEvent.click(await enabledRetry());

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Couldn't retry that message. Please try again.",
      );
      expect(screen.getByRole("alert")).not.toHaveTextContent(/422|Request failed/);
      expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
      expect(
        screen.getByText("This reply failed. Please try again."),
      ).toBeInTheDocument();
      expect(await enabledRetry()).toBeInTheDocument();
    });

    it("a dropped connection marks the reply failed instead of Thinking…", async () => {
      api.streamMessage.mockImplementation(async (_id, _content, onEvent) => {
        onEvent({
          type: "turn",
          conversation: CONV,
          userMessage: question,
          assistantMessageId: SAVED,
        });
        onEvent({ type: "token", text: "Demand was" });
        // The stream ends without a done event.
      });
      api.listMessages.mockResolvedValue([
        question,
        msg({ id: SAVED, status: "error", content: "Demand was" }),
      ]);
      renderPage();
      await screen.findByText("Ask the AI analyst");

      sendViaComposer("What did NVDA say?");

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "The connection dropped before the reply finished.",
      );
      expect(screen.queryByText("Thinking…")).not.toBeInTheDocument();
      expect(await enabledRetry()).toBeInTheDocument();
    });

    it("waits out a 409 while the stopped turn is still saving", async () => {
      await openEarlierChat([question, msg({ id: SAVED, status: "interrupted" })]);
      api.streamRetry
        .mockRejectedValueOnce(new ApiError(409, "busy", "turn_in_progress"))
        .mockImplementation(async (_id, messageId, onEvent) => {
          onEvent({
            type: "done",
            message: msg({ id: messageId, content: "Strong." }),
          });
        });

      fireEvent.click(await enabledRetry());

      expect(await screen.findByText("Strong.")).toBeInTheDocument();
      expect(api.streamRetry).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("keeps a question the server never saved, and Retry sends it again", async () => {
      api.streamMessage
        .mockRejectedValueOnce(
          new ApiError(0, "Could not reach the API. Is it running?"),
        )
        .mockImplementation(async (_id, content, onEvent) => {
          onEvent({
            type: "turn",
            conversation: CONV,
            userMessage: msg({ id: "u9", role: "user", content }),
            assistantMessageId: SAVED,
          });
          onEvent({ type: "done", message: msg({ id: SAVED, content: "Strong." }) });
        });
      api.listMessages.mockResolvedValue([]); // nothing was saved
      renderPage();
      await screen.findByText("Ask the AI analyst");

      sendViaComposer("What did NVDA say?");

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Couldn't reach Equity Lens",
      );
      expect(
        await screen.findByText("This reply failed. Please try again."),
      ).toBeInTheDocument();
      fireEvent.click(await enabledRetry());

      expect(await screen.findByText("Strong.")).toBeInTheDocument();
      expect(api.streamMessage).toHaveBeenCalledTimes(2);
      expect(api.streamMessage.mock.calls[1]![1]).toBe("What did NVDA say?");
      expect(
        screen.getAllByText("What did NVDA say?", { selector: "div" }),
      ).toHaveLength(1);
    });
  });

  it("auto-scrolls only near the bottom and offers Jump to latest", async () => {
    const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView");
    let emit: (event: ChatStreamEvent) => void = () => {};
    api.streamMessage.mockImplementation(async (_id, _content, onEvent) => {
      emit = (event) => act(() => onEvent(event));
      await new Promise<void>(() => {});
    });
    renderPage();
    await screen.findByText("Ask the AI analyst");
    sendViaComposer("Summarize NVDA's last call");
    await waitFor(() => expect(api.streamMessage).toHaveBeenCalled());

    const list = screen.getByRole("region", { name: "Messages" });
    const setScroll = (scrollTop: number) => {
      Object.defineProperty(list, "scrollHeight", { value: 2000, configurable: true });
      Object.defineProperty(list, "clientHeight", { value: 500, configurable: true });
      Object.defineProperty(list, "scrollTop", {
        value: scrollTop,
        configurable: true,
      });
      fireEvent.scroll(list);
    };

    // At the bottom: streaming text keeps the view pinned to the end.
    setScroll(1500);
    scrollSpy.mockClear();
    emit({ type: "token", text: "NVIDIA said " });
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();

    // Scrolled up to reread: new tokens don't move the view.
    setScroll(200);
    scrollSpy.mockClear();
    emit({ type: "token", text: "demand stayed strong" });
    await screen.findByText(/demand stayed strong/);
    expect(scrollSpy).not.toHaveBeenCalled();
    const jump = screen.getByRole("button", { name: "Jump to latest" });

    fireEvent.click(jump);
    expect(scrollSpy).toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Jump to latest" }),
    ).not.toBeInTheDocument();
    scrollSpy.mockRestore();
  });

  describe("mobile layout", () => {
    it("opens the conversation drawer from the menu and closes it on select", async () => {
      api.listConversations.mockResolvedValue([{ ...CONV, title: "NVDA demand" }]);
      api.listMessages.mockResolvedValue([
        msg({ id: "u1", role: "user", content: "hi" }),
      ]);
      renderPage();
      await screen.findByText("Ask the AI analyst");

      fireEvent.click(screen.getByRole("button", { name: "Open conversations" }));
      const drawer = screen.getByRole("dialog", { name: "Conversation list" });
      fireEvent.click(within(drawer).getByRole("button", { name: "NVDA demand" }));

      expect(
        screen.queryByRole("dialog", { name: "Conversation list" }),
      ).not.toBeInTheDocument();
      await waitFor(() => expect(api.listMessages).toHaveBeenCalledWith("c1"));
      expect(screen.getByText("NVDA demand", { selector: "span" })).toBeInTheDocument();
    });

    it("closes the drawer with Escape, the backdrop or the close button", async () => {
      renderPage();
      await screen.findByText("Ask the AI analyst");
      const open = () =>
        fireEvent.click(screen.getByRole("button", { name: "Open conversations" }));
      const isOpen = () =>
        screen.queryByRole("dialog", { name: "Conversation list" }) !== null;

      open();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(isOpen()).toBe(false);

      open();
      fireEvent.click(screen.getByRole("button", { name: "Close conversations" }));
      expect(isOpen()).toBe(false);

      open();
      const backdrop = screen
        .getByRole("dialog", { name: "Conversation list" })
        .querySelector('[aria-hidden="true"]')!;
      fireEvent.click(backdrop);
      expect(isOpen()).toBe(false);
    });

    it("keeps the input full-size on phones (no zoom) and above the safe area", async () => {
      renderPage();
      await screen.findByText("Ask the AI analyst");

      const input = screen.getByRole("textbox");
      expect(input.className).toContain("text-base");
      expect(input.className).toContain("md:text-sm");
      expect(input.closest("form")!.className).toContain("safe-area-inset-bottom");
    });
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
    // Fake only the clock (timers stay real for findBy/waitFor). Tests run in
    // America/New_York (vitest.config.ts), where midnight UTC is 8 PM EDT.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T15:00:00.000Z"));
    try {
      renderPage();

      expect(await screen.findByTestId("chat-usage")).toHaveTextContent(
        "You've used all 5 messages for today. They reset at 8:00 PM EDT.",
      );
      expect(screen.getByRole("textbox")).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
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
