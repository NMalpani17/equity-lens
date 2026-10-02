import { Wrench } from "lucide-react";

import { ChatMarkdown } from "@/components/chat/ChatMarkdown";
import { ToolProgress } from "@/components/chat/ToolProgress";
import type { ToolProgressItem } from "@/hooks/useChat";
import type { ChatMessage, Citation } from "@/lib/chatApi";
import { fallbackText } from "@/lib/chatFormat";
import { cn } from "@/lib/utils";

const STATUS_NOTES: Partial<Record<ChatMessage["status"], string>> = {
  interrupted: "Stopped",
  truncated: "Cut off at the length limit",
  error: "Failed",
};

interface MessageBubbleProps {
  message: ChatMessage;
  /** Live state for the reply that is currently streaming. */
  streamText?: string;
  tools?: ToolProgressItem[];
  onCite?: (citation: Citation) => void;
}

export function MessageBubble({
  message,
  streamText,
  tools = [],
  onCite,
}: MessageBubbleProps) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm text-primary-foreground">
          {message.content}
        </div>
      </div>
    );
  }

  const isStreaming = message.status === "streaming";
  const content = isStreaming ? (streamText ?? "") : message.content;
  const fallback = isStreaming ? null : fallbackText(message);
  const note = STATUS_NOTES[message.status];
  const usedTools = !isStreaming ? message.toolCalls : [];

  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "max-w-[85%] rounded-2xl rounded-bl-sm border bg-card px-4 py-3",
          message.status === "error" && "border-destructive/40",
        )}
        aria-busy={isStreaming}
      >
        {isStreaming && <ToolProgress items={tools} />}
        {content ? (
          <ChatMarkdown
            content={content}
            citations={message.citations}
            onCite={onCite}
          />
        ) : fallback ? (
          <p className="text-sm italic text-muted-foreground">{fallback}</p>
        ) : (
          isStreaming &&
          tools.length === 0 && (
            <p className="text-sm text-muted-foreground" role="status">
              Thinking…
            </p>
          )
        )}
        {(note || usedTools.length > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {note && <span className="rounded bg-muted px-1.5 py-0.5">{note}</span>}
            {usedTools.length > 0 && (
              <span
                className="inline-flex items-center gap-1"
                title={usedTools.map((t) => t.label).join("\n")}
              >
                <Wrench aria-hidden="true" className="size-3" />
                {usedTools.length} tool {usedTools.length === 1 ? "call" : "calls"}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
