import { useEffect, useState } from "react";
import { ArrowDown, Menu, Plus, X } from "lucide-react";

import { Header } from "@/components/Header";
import { DemoBanner } from "@/components/DemoBanner";
import { ChatBanner } from "@/components/chat/ChatBanner";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { CitationDialog } from "@/components/chat/CitationDialog";
import { ConversationSidebar } from "@/components/chat/ConversationSidebar";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { StarterQuestions } from "@/components/chat/StarterQuestions";
import { useAuth } from "@/context/auth-context";
import { useChat } from "@/hooks/useChat";
import { useStickToBottom } from "@/hooks/useStickToBottom";
import type { Citation } from "@/lib/chatApi";

/** The AI analyst chat: conversation list, streaming thread and composer. */
export function ChatPage() {
  const { isDemo } = useAuth();
  const chat = useChat();
  const [citation, setCitation] = useState<Citation | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const contentKey = [
    chat.activeId,
    chat.messages.length,
    chat.messages.at(-1)?.status,
    chat.streamText.length,
    chat.tools.map((t) => `${t.label}:${t.state}`).join("|"),
  ].join("/");
  const scroll = useStickToBottom<HTMLElement>(contentKey);

  const outOfMessages = chat.usage !== null && chat.usage.remaining <= 0;
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const activeTitle =
    chat.conversations.find((c) => c.id === chat.activeId)?.title ?? "New chat";
  const sidebarProps = {
    conversations: chat.conversations,
    activeId: chat.activeId,
    disabled: chat.streaming,
    onRename: chat.renameConversation,
    onDelete: chat.deleteConversation,
  };
  const selectConversation = (id: string | null) => {
    setDrawerOpen(false);
    void chat.selectConversation(id);
  };

  const send = (content: string) => {
    scroll.scrollToBottom(); // your own message always brings you to the end
    void chat.send(content);
  };

  return (
    <div className="flex h-dvh flex-col">
      {isDemo && <DemoBanner />}
      <Header />
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col md:flex-row">
        {/* Desktop: a persistent sidebar. Mobile: a drawer behind the menu button. */}
        <div className="hidden md:flex">
          <ConversationSidebar {...sidebarProps} onSelect={selectConversation} />
        </div>
        <main className="relative flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b px-2 py-1.5 md:hidden">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open conversations"
              aria-expanded={drawerOpen}
              className="rounded-md p-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Menu aria-hidden="true" className="size-5" />
            </button>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {activeTitle}
            </span>
            <button
              type="button"
              onClick={() => selectConversation(null)}
              disabled={chat.streaming}
              aria-label="New chat"
              className="rounded-md p-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
            >
              <Plus aria-hidden="true" className="size-5" />
            </button>
          </div>
          {chat.banner && (
            <ChatBanner banner={chat.banner} onDismiss={chat.dismissBanner} />
          )}
          <section
            ref={scroll.containerRef}
            onScroll={scroll.onScroll}
            aria-label="Messages"
            aria-live="polite"
            className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4"
          >
            {chat.messages.length === 0 && !chat.loading ? (
              <StarterQuestions
                onPick={send}
                disabled={chat.streaming || outOfMessages}
              />
            ) : (
              chat.messages.map((message, index) => {
                // Only the latest reply can be regenerated (it replaces itself).
                const isLatest = index === chat.messages.length - 1;
                return (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    streamText={chat.streamText}
                    tools={chat.tools}
                    onCite={setCitation}
                    onRetry={isLatest ? () => void chat.retry(message.id) : undefined}
                    retryDisabled={chat.streaming || outOfMessages}
                  />
                );
              })
            )}
            <div ref={scroll.endRef} />
          </section>
          {!scroll.atBottom && chat.messages.length > 0 && (
            <button
              type="button"
              onClick={scroll.scrollToBottom}
              className="absolute bottom-28 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border bg-background px-3 py-1.5 text-xs font-medium shadow-md hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <ArrowDown aria-hidden="true" className="size-3.5" />
              Jump to latest
            </button>
          )}
          {chat.usage && (chat.usage.isDemo || chat.usage.remaining <= 5) && (
            <p className="px-4 text-xs text-muted-foreground" data-testid="chat-usage">
              {chat.usage.remaining > 0
                ? `${chat.usage.remaining} of ${chat.usage.limit} messages left today${chat.usage.isDemo ? " (demo)" : ""}.`
                : `You've used all ${chat.usage.limit} messages for today. They reset at midnight UTC.`}
            </p>
          )}
          <ChatComposer
            streaming={chat.streaming}
            disabled={outOfMessages}
            onSend={send}
            onStop={chat.stop}
          />
        </main>
      </div>
      {drawerOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Conversation list"
          className="fixed inset-0 z-40 md:hidden"
        >
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-background shadow-xl">
            <div className="flex justify-end p-1">
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close conversations"
                className="rounded-md p-2 hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <X aria-hidden="true" className="size-5" />
              </button>
            </div>
            <ConversationSidebar
              {...sidebarProps}
              onSelect={selectConversation}
              className="min-h-0 flex-1 border-r-0 md:w-full"
            />
          </div>
        </div>
      )}
      <CitationDialog
        citation={citation}
        onOpenChange={(open) => !open && setCitation(null)}
      />
    </div>
  );
}
