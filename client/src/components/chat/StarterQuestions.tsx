import { MessageSquareText } from "lucide-react";

import { STARTER_QUESTIONS } from "@/lib/chatFormat";

interface StarterQuestionsProps {
  onPick: (question: string) => void;
  disabled?: boolean;
}

/** Shown in an empty conversation to suggest what the analyst can do. */
export function StarterQuestions({ onPick, disabled = false }: StarterQuestionsProps) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-10 text-center">
      <MessageSquareText aria-hidden="true" className="size-8 text-muted-foreground" />
      <div>
        <h2 className="text-lg font-semibold">Ask the AI analyst</h2>
        <p className="text-sm text-muted-foreground">
          Answers cite earnings call transcripts and use live market data and your
          portfolio.
        </p>
      </div>
      <div className="grid w-full gap-2 sm:grid-cols-2">
        {STARTER_QUESTIONS.map((question) => (
          <button
            key={question}
            type="button"
            disabled={disabled}
            onClick={() => onPick(question)}
            className="rounded-lg border bg-card p-3 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          >
            {question}
          </button>
        ))}
      </div>
    </div>
  );
}
