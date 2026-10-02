/**
 * Chat state: conversations, the active thread, the streaming reply (text and
 * tool progress), banners, and the user's daily allowance.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "@/lib/api";
import {
  createConversation,
  deleteConversation as apiDeleteConversation,
  getChatUsage,
  listConversations,
  listMessages,
  renameConversation as apiRenameConversation,
  streamMessage,
  type ChatMessage,
  type ChatStreamEvent,
  type ChatUsage,
  type Conversation,
} from "@/lib/chatApi";

export interface ToolProgressItem {
  id: string;
  label: string;
  state: "running" | "ok" | "failed";
  summary?: string;
}

export interface ChatBannerState {
  kind: "limit" | "credits" | "busy" | "error";
  message: string;
}

const STREAMING_ID = "streaming-reply";

function bannerFor(error: unknown): ChatBannerState {
  if (error instanceof ApiError) {
    if (error.status === 429) return { kind: "limit", message: error.message };
    if (error.status === 409) {
      return { kind: "busy", message: "A reply is still being written. Please wait." };
    }
    return { kind: "error", message: error.message };
  }
  return { kind: "error", message: "Something went wrong. Please try again." };
}

function bannerForCode(code: string, message: string): ChatBannerState {
  if (code === "ai_credits_exhausted") return { kind: "credits", message };
  if (code === "ai_rate_limited") return { kind: "busy", message };
  return { kind: "error", message };
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

export function useChat() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [tools, setTools] = useState<ToolProgressItem[]>([]);
  const [banner, setBanner] = useState<ChatBannerState | null>(null);
  const [usage, setUsage] = useState<ChatUsage | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Mirrors streamText so stop() can read it without re-creating per token.
  const streamTextRef = useRef("");

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
        if (!cancelled) setBanner(bannerFor(error));
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

  const selectConversation = useCallback(async (id: string | null) => {
    if (abortRef.current) return; // can't switch threads mid-stream
    setActiveId(id);
    setBanner(null);
    setMessages([]);
    if (!id) return;
    try {
      setMessages(await listMessages(id));
    } catch (error) {
      setBanner(bannerFor(error));
    }
  }, []);

  const renameConversation = useCallback(async (id: string, title: string) => {
    const updated = await apiRenameConversation(id, title);
    setConversations((list) => list.map((c) => (c.id === id ? updated : c)));
  }, []);

  const deleteConversation = useCallback(
    async (id: string) => {
      await apiDeleteConversation(id);
      setConversations((list) => list.filter((c) => c.id !== id));
      if (activeId === id) {
        setActiveId(null);
        setMessages([]);
      }
    },
    [activeId],
  );

  const handleEvent = useCallback((event: ChatStreamEvent) => {
    switch (event.type) {
      case "turn":
        setMessages((list) =>
          list.map((m) => (m.id === "pending-user" ? event.userMessage : m)),
        );
        setConversations((list) => [
          event.conversation,
          ...list.filter((c) => c.id !== event.conversation.id),
        ]);
        break;
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
        setBanner(bannerForCode(event.code, event.message));
        break;
      case "done":
        setMessages((list) =>
          list.map((m) => (m.id === STREAMING_ID ? event.message : m)),
        );
        break;
    }
  }, []);

  const send = useCallback(
    async (content: string) => {
      const text = content.trim();
      if (!text || abortRef.current) return;
      setBanner(null);
      let conversationId = activeId;
      try {
        if (!conversationId) {
          const created = await createConversation();
          conversationId = created.id;
          setConversations((list) => [created, ...list]);
          setActiveId(created.id);
        }
      } catch (error) {
        setBanner(bannerFor(error));
        return;
      }

      const pendingUser: ChatMessage = {
        ...placeholder(text),
        id: "pending-user",
        role: "user",
        status: "complete",
      };
      setMessages((list) => [...list, pendingUser, placeholder()]);
      streamTextRef.current = "";
      setStreamText("");
      setTools([]);
      setStreaming(true);
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        await streamMessage(conversationId, text, handleEvent, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          setBanner(bannerFor(error));
          // The server is the source of truth (it may not have saved anything).
          try {
            setMessages(await listMessages(conversationId));
          } catch {
            setMessages((list) =>
              list.filter((m) => m.id !== STREAMING_ID && m.id !== "pending-user"),
            );
          }
        }
      } finally {
        abortRef.current = null;
        setStreaming(false);
        setStreamText("");
        setTools([]);
        void refreshUsage();
      }
    },
    [activeId, handleEvent, refreshUsage],
  );

  /** Stop generating. The server keeps the partial reply as "interrupted". */
  const stop = useCallback(() => {
    const controller = abortRef.current;
    if (!controller) return;
    setMessages((list) =>
      list.map((m) =>
        m.id === STREAMING_ID
          ? { ...m, status: "interrupted", content: streamTextRef.current }
          : m,
      ),
    );
    controller.abort();
  }, []);

  return {
    conversations,
    activeId,
    messages,
    loading,
    streaming,
    streamText,
    tools,
    banner,
    usage,
    dismissBanner: () => setBanner(null),
    selectConversation,
    renameConversation,
    deleteConversation,
    send,
    stop,
  };
}
