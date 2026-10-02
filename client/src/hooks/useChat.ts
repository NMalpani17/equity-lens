/**
 * Chat state: conversations, the active thread, the streaming reply (text and
 * tool progress), banners, and the user's daily allowance.
 *
 * A turn never leaves the UI stuck: if it ends without the server's final
 * message (Stop, an error, a dropped connection), the reply is marked as
 * stopped/failed right away and the thread is then re-synced from the server,
 * which supplies real message ids (for Retry), final statuses and the title.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  createConversation,
  deleteConversation as apiDeleteConversation,
  getChatUsage,
  listConversations,
  listMessages,
  renameConversation as apiRenameConversation,
  streamMessage,
  streamRetry,
  type ChatMessage,
  type ChatStreamEvent,
  type ChatUsage,
  type Conversation,
} from "@/lib/chatApi";
import {
  bannerForError,
  bannerForStreamError,
  DROPPED_MESSAGE,
  isTurnInProgress,
  type ChatAction,
  type ChatBannerState,
} from "@/lib/chatErrors";

export type { ChatBannerState } from "@/lib/chatErrors";

export interface ToolProgressItem {
  id: string;
  label: string;
  state: "running" | "ok" | "failed";
  summary?: string;
}

// Browser-only ids for a turn's bubbles until the server's `turn` event
// supplies the saved ids. They are never sent to the API.
const STREAMING_ID = "streaming-reply";
const PENDING_USER_ID = "pending-user";
// Just after Stop the server may still be saving the stopped turn (409);
// a new turn waits briefly and tries again.
const BUSY_RETRY_DELAYS_MS = [300, 800, 1500];
// How long to wait for the server to finish saving a stopped turn.
const SETTLE_DELAYS_MS = [300, 800, 1500, 3000];

type StartStream = (
  onEvent: (event: ChatStreamEvent) => void,
  signal: AbortSignal,
) => Promise<void>;

/** True for a bubble that exists only in the browser (not saved yet). */
export function isClientOnlyId(id: string): boolean {
  return id === STREAMING_ID || id === PENDING_USER_ID;
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function withBusyRetry(start: () => Promise<void>, signal: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await start();
    } catch (error) {
      const delay = BUSY_RETRY_DELAYS_MS[attempt];
      if (!isTurnInProgress(error) || delay === undefined || signal.aborted)
        throw error;
      await wait(delay, signal);
    }
  }
}

function placeholder(content = ""): ChatMessage {
  return {
    id: STREAMING_ID,
    role: "assistant",
    content,
    status: "streaming",
    citations: [],
    toolCalls: [],
    errorCode: null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Load a thread, waiting briefly while the server finishes a turn (a reply
 * still "streaming", or a just-stopped turn not saved yet). Anything still
 * unfinished after that is shown as stopped, never as an endless "Thinking…".
 */
export async function loadSettled(
  conversationId: string,
  expectMoreThan: number | null = null,
): Promise<ChatMessage[]> {
  const unsettled = (list: ChatMessage[]) =>
    list.some((m) => m.status === "streaming") ||
    (expectMoreThan !== null && list.length <= expectMoreThan);
  let list = await listMessages(conversationId);
  for (const delay of SETTLE_DELAYS_MS) {
    if (!unsettled(list)) break;
    await wait(delay);
    list = await listMessages(conversationId);
  }
  return list.map((m) =>
    m.status === "streaming" ? { ...m, status: "interrupted" as const } : m,
  );
}

export function useChat() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [tools, setTools] = useState<ToolProgressItem[]>([]);
  const [banner, setBanner] = useState<ChatBannerState | null>(null);
  const [usage, setUsage] = useState<ChatUsage | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Mirrors streamText so stop() can read it without re-creating per token.
  const streamTextRef = useRef("");
  // The id of the reply bubble being streamed (STREAMING_ID until `turn`).
  const replyIdRef = useRef(STREAMING_ID);
  const gotTurnRef = useRef(false);
  const gotDoneRef = useRef(false);
  // Bumped per turn so a late re-sync never overwrites a newer turn.
  const turnSeqRef = useRef(0);
  const activeIdRef = useRef<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const activate = useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveId(id);
  }, []);

  const refreshUsage = useCallback(async () => {
    try {
      setUsage(await getChatUsage());
    } catch {
      // Usage is informational; the server still enforces limits.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listConversations();
        if (!cancelled) setConversations(list);
      } catch (error) {
        if (!cancelled) setBanner(bannerForError(error, "load"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    void refreshUsage();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
    };
  }, [refreshUsage]);

  const selectConversation = useCallback(
    async (id: string | null) => {
      if (abortRef.current) return; // can't switch threads mid-stream
      activate(id);
      setBanner(null);
      setMessages([]);
      if (!id) return;
      try {
        const list = await loadSettled(id);
        if (activeIdRef.current === id) setMessages(list);
      } catch (error) {
        setBanner(bannerForError(error, "load"));
      }
    },
    [activate],
  );

  const renameConversation = useCallback(async (id: string, title: string) => {
    const updated = await apiRenameConversation(id, title);
    setConversations((list) => list.map((c) => (c.id === id ? updated : c)));
  }, []);

  const deleteConversation = useCallback(
    async (id: string) => {
      await apiDeleteConversation(id);
      setConversations((list) => list.filter((c) => c.id !== id));
      if (activeIdRef.current === id) {
        activate(null);
        setMessages([]);
      }
    },
    [activate],
  );

  const handleEvent = useCallback((event: ChatStreamEvent) => {
    switch (event.type) {
      case "turn": {
        // Swap browser-only ids for the saved ones so Stop -> Retry works.
        gotTurnRef.current = true;
        const from = replyIdRef.current;
        const to = event.assistantMessageId;
        replyIdRef.current = to;
        setMessages((list) =>
          list.map((m) => {
            if (m.id === PENDING_USER_ID) return event.userMessage;
            return m.id === from ? { ...m, id: to } : m;
          }),
        );
        setConversations((list) => [
          event.conversation,
          ...list.filter((c) => c.id !== event.conversation.id),
        ]);
        break;
      }
      case "token":
        streamTextRef.current += event.text;
        setStreamText(streamTextRef.current);
        break;
      case "tool_start":
        // The model is turning to tools; drop any "let me check" preamble.
        streamTextRef.current = "";
        setStreamText("");
        setTools((list) => [
          ...list,
          { id: event.id, label: event.label, state: "running" },
        ]);
        break;
      case "tool_progress":
        // Live status for a long-running tool, e.g. waiting for indexing.
        setTools((list) =>
          list.map((t) => (t.id === event.id ? { ...t, label: event.label } : t)),
        );
        break;
      case "tool_end":
        setTools((list) =>
          list.map((t) =>
            t.id === event.id
              ? { ...t, state: event.ok ? "ok" : "failed", summary: event.summary }
              : t,
          ),
        );
        break;
      case "error":
        setBanner(bannerForStreamError(event.code, event.message));
        break;
      case "done": {
        gotDoneRef.current = true;
        const id = replyIdRef.current;
        setMessages((list) => list.map((m) => (m.id === id ? event.message : m)));
        break;
      }
    }
  }, []);

  /** Mark the streaming reply as stopped or failed (keeping any text). */
  const settleReply = useCallback((status: "interrupted" | "error") => {
    const id = replyIdRef.current;
    const text = streamTextRef.current;
    setMessages((list) =>
      list.map((m) =>
        m.id === id && m.status === "streaming"
          ? { ...m, status, content: text || m.content }
          : m,
      ),
    );
  }, []);

  /**
   * Re-sync the thread after a turn that ended without the final message.
   * `baseCount` is the number of saved messages before a new question: if the
   * server never saved the turn, the local question and failed reply stay
   * (with browser-only ids, so Retry sends the question again).
   */
  const resync = useCallback(
    async (
      conversationId: string,
      opts: { baseCount: number | null; waitForTurn: boolean; refreshList: boolean },
    ) => {
      const seq = turnSeqRef.current;
      setSyncing(true);
      try {
        if (opts.refreshList) {
          void listConversations()
            .then(setConversations)
            .catch(() => undefined);
        }
        const list = await loadSettled(
          conversationId,
          opts.waitForTurn ? opts.baseCount : null,
        );
        if (seq !== turnSeqRef.current || activeIdRef.current !== conversationId)
          return;
        const { baseCount } = opts;
        setMessages((local) =>
          baseCount !== null && list.length <= baseCount
            ? [...list, ...local.filter((m) => isClientOnlyId(m.id))]
            : list,
        );
      } catch {
        // Offline: keep the local state (the reply is already marked failed).
      } finally {
        if (seq === turnSeqRef.current) setSyncing(false);
      }
    },
    [],
  );

  /** Stream one turn into the reply bubble identified by replyIdRef. */
  const runTurn = useCallback(
    async (
      conversationId: string,
      action: ChatAction,
      start: StartStream,
      baseCount: number | null,
    ) => {
      turnSeqRef.current += 1;
      setSyncing(false);
      streamTextRef.current = "";
      setStreamText("");
      setTools([]);
      setStreaming(true);
      gotTurnRef.current = false;
      gotDoneRef.current = false;
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await withBusyRetry(
          () => start(handleEvent, controller.signal),
          controller.signal,
        );
        if (!gotDoneRef.current && !controller.signal.aborted) {
          setBanner({ kind: "error", message: DROPPED_MESSAGE });
        }
      } catch (error) {
        if (!controller.signal.aborted) setBanner(bannerForError(error, action));
      } finally {
        const finished = gotDoneRef.current;
        const stopped = controller.signal.aborted;
        if (!finished) settleReply(stopped ? "interrupted" : "error");
        abortRef.current = null;
        setStreaming(false);
        setStreamText("");
        setTools([]);
        if (!finished) {
          void resync(conversationId, {
            baseCount,
            // A Stop before `turn` may still be saving on the server.
            waitForTurn: stopped && !gotTurnRef.current,
            refreshList: !gotTurnRef.current,
          });
        }
        void refreshUsage();
      }
    },
    [handleEvent, refreshUsage, resync, settleReply],
  );

  const send = useCallback(
    async (content: string) => {
      const text = content.trim();
      if (!text || abortRef.current) return;
      setBanner(null);
      let conversationId = activeIdRef.current;
      try {
        if (!conversationId) {
          const created = await createConversation();
          conversationId = created.id;
          setConversations((list) => [created, ...list]);
          activate(created.id);
        }
      } catch (error) {
        setBanner(bannerForError(error, "send"));
        return;
      }

      const baseCount = messagesRef.current.filter((m) => !isClientOnlyId(m.id)).length;
      const pendingUser: ChatMessage = {
        ...placeholder(text),
        id: PENDING_USER_ID,
        role: "user",
        status: "complete",
      };
      replyIdRef.current = STREAMING_ID;
      setMessages((list) => [
        ...list.filter((m) => !isClientOnlyId(m.id)),
        pendingUser,
        placeholder(),
      ]);
      const id = conversationId;
      await runTurn(
        id,
        "send",
        (onEvent, signal) => streamMessage(id, text, onEvent, signal),
        baseCount,
      );
    },
    [activate, runTurn],
  );

  /**
   * Regenerate a stopped/failed reply in place ("Regenerate"): the reply is
   * replaced by the new stream; the question is not sent or shown again. A
   * reply the server never saved (browser-only id) re-sends its question.
   */
  const retry = useCallback(
    async (messageId: string) => {
      const conversationId = activeIdRef.current;
      if (!conversationId || abortRef.current) return;
      setBanner(null);
      if (isClientOnlyId(messageId)) {
        const local = messagesRef.current;
        const index = local.findIndex((m) => m.id === messageId);
        const question = local
          .slice(0, index)
          .reverse()
          .find((m) => m.role === "user");
        if (question) await send(question.content);
        return;
      }
      replyIdRef.current = messageId;
      setMessages((list) =>
        list.map((m) => (m.id === messageId ? { ...placeholder(), id: messageId } : m)),
      );
      await runTurn(
        conversationId,
        "retry",
        (onEvent, signal) => streamRetry(conversationId, messageId, onEvent, signal),
        null,
      );
    },
    [runTurn, send],
  );

  /** Stop generating. The server keeps the partial reply as "interrupted". */
  const stop = useCallback(() => {
    const controller = abortRef.current;
    if (!controller) return;
    settleReply("interrupted");
    controller.abort();
  }, [settleReply]);

  return {
    conversations,
    activeId,
    messages,
    loading,
    streaming,
    syncing,
    streamText,
    tools,
    banner,
    usage,
    dismissBanner: () => setBanner(null),
    selectConversation,
    renameConversation,
    deleteConversation,
    send,
    retry,
    stop,
  };
}
