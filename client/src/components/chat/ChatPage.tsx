import { useEffect, useRef, useState } from "react";

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
import type { ChatMessage, Citation } from "@/lib/chatApi";

/** The user question an assistant reply answered (for Retry). */
function questionBefore(messages: ChatMessage[], index: number): string | null {
  if (messages[index]?.role !== "assistant") return null;
  for (let i = index - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return messages[i]!.content;
  }
  return null;
}

/** The AI analyst chat: conversation list, streaming thread and composer. */
export function ChatPage() {
  const { isDemo } = useAuth();
  const chat = useChat();
  const [citation, setCitation] = useState<Citation | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [chat.messages, chat.streamText, chat.tools]);

  const outOfMessages = chat.usage !== null && chat.usage.remaining <= 0;

  return (
    <div className="flex h-screen flex-col">
      {isDemo && <DemoBanner />}
      <Header />
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col md:flex-row">
        <ConversationSidebar
          conversations={chat.conversations}
          activeId={chat.activeId}
          disabled={chat.streaming}
          onSelect={(id) => void chat.selectConversation(id)}
          onRename={chat.renameConversation}
          onDelete={chat.deleteConversation}
        />
        <main className="flex min-h-0 flex-1 flex-col">
          {chat.banner && (
            <ChatBanner banner={chat.banner} onDismiss={chat.dismissBanner} />
          )}
          <section
            aria-label="Messages"
            aria-live="polite"
            className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4"
          >
            {chat.messages.length === 0 && !chat.loading ? (
              <StarterQuestions
                onPick={(q) => void chat.send(q)}
                disabled={chat.streaming || outOfMessages}
              />
            ) : (
              chat.messages.map((message, index) => {
                const question = questionBefore(chat.messages, index);
                return (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    streamText={chat.streamText}
                    tools={chat.tools}
                    onCite={setCitation}
                    onRetry={question ? () => void chat.send(question) : undefined}
                    retryDisabled={chat.streaming || outOfMessages}
                  />
                );
              })
            )}
            <div ref={bottomRef} />
          </section>
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
            onSend={(content) => void chat.send(content)}
            onStop={chat.stop}
          />
        </main>
      </div>
      <CitationDialog
        citation={citation}
        onOpenChange={(open) => !open && setCitation(null)}
      />
    </div>
  );
}
