import { useState, type FormEvent, type KeyboardEvent } from "react";
import { SendHorizontal, Square } from "lucide-react";

import { Button } from "@/components/ui/button";

export const MAX_MESSAGE_CHARS = 2000;

interface ChatComposerProps {
  streaming: boolean;
  disabled?: boolean;
  onSend: (content: string) => void;
  onStop: () => void;
}

/** Message input: Enter sends, Shift+Enter adds a line; disabled while streaming. */
export function ChatComposer({
  streaming,
  disabled = false,
  onSend,
  onStop,
}: ChatComposerProps) {
  const [value, setValue] = useState("");
  const tooLong = value.length > MAX_MESSAGE_CHARS;
  const canSend = !streaming && !disabled && value.trim().length > 0 && !tooLong;

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSend) return;
    onSend(value);
    setValue("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form
      onSubmit={submit}
      className="border-t bg-background p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
    >
      <div className="flex items-end gap-2">
        <label htmlFor="chat-input" className="sr-only">
          Ask about a stock, earnings call, or your portfolio
        </label>
        <textarea
          id="chat-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={streaming || disabled}
          rows={2}
          placeholder={
            streaming
              ? "Waiting for the reply…"
              : "Ask about a stock, earnings call, or your portfolio"
          }
          aria-invalid={tooLong}
          aria-describedby="chat-input-help"
          className="max-h-40 min-h-[2.5rem] flex-1 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm md:text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        />
        {streaming ? (
          <Button
            type="button"
            variant="outline"
            onClick={onStop}
            aria-label="Stop generating"
          >
            <Square aria-hidden="true" />
            Stop
          </Button>
        ) : (
          <Button type="submit" disabled={!canSend} aria-label="Send message">
            <SendHorizontal aria-hidden="true" />
            Send
          </Button>
        )}
      </div>
      <p
        id="chat-input-help"
        className={
          tooLong
            ? "mt-1 text-xs text-destructive"
            : "mt-1 text-xs text-muted-foreground"
        }
        role={tooLong ? "alert" : undefined}
      >
        {tooLong
          ? `Messages are limited to ${MAX_MESSAGE_CHARS.toLocaleString()} characters (${value.length.toLocaleString()} now).`
          : `${value.length.toLocaleString()}/${MAX_MESSAGE_CHARS.toLocaleString()} · AI answers can be wrong; check the cited sources. Not financial advice.`}
      </p>
    </form>
  );
}
