import { useState, type FormEvent } from "react";
import { Loader2, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Conversation } from "@/lib/chatApi";
import { cn } from "@/lib/utils";

interface ConversationSidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  disabled: boolean;
  onSelect: (id: string | null) => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export function ConversationSidebar({
  conversations,
  activeId,
  disabled,
  onSelect,
  onRename,
  onDelete,
}: ConversationSidebarProps) {
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>, close: () => void) {
    setBusy(true);
    setError(null);
    try {
      await action();
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  function submitRename(event: FormEvent) {
    event.preventDefault();
    if (!renaming || !title.trim()) return;
    void run(
      () => onRename(renaming.id, title.trim()),
      () => setRenaming(null),
    );
  }

  return (
    <aside aria-label="Conversations" className="flex w-full flex-col border-r md:w-64">
      <div className="p-3">
        <Button
          className="w-full"
          variant="outline"
          onClick={() => onSelect(null)}
          disabled={disabled}
        >
          <Plus aria-hidden="true" />
          New chat
        </Button>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        {conversations.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">No conversations yet.</p>
        ) : (
          <ul className="space-y-1">
            {conversations.map((c) => (
              <li key={c.id} className="group flex items-center">
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  disabled={disabled}
                  aria-current={c.id === activeId ? "page" : undefined}
                  className={cn(
                    "flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60",
                    c.id === activeId && "bg-accent font-medium",
                  )}
                >
                  {c.title}
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={`Options for ${c.title}`}
                    disabled={disabled}
                    className="rounded-md p-1 opacity-60 hover:bg-accent hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <MoreHorizontal aria-hidden="true" className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => {
                        setTitle(c.title);
                        setError(null);
                        setRenaming(c);
                      }}
                    >
                      <Pencil aria-hidden="true" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => {
                        setError(null);
                        setDeleting(c);
                      }}
                      className="text-destructive"
                    >
                      <Trash2 aria-hidden="true" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </nav>

      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
      >
        <DialogContent>
          <form onSubmit={submitRename}>
            <DialogHeader>
              <DialogTitle>Rename conversation</DialogTitle>
              <DialogDescription>
                Give this conversation a short title.
              </DialogDescription>
            </DialogHeader>
            <div className="my-4 space-y-2">
              <Label htmlFor="conversation-title">Title</Label>
              <Input
                id="conversation-title"
                value={title}
                maxLength={100}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
              />
            </div>
            {error && (
              <p role="alert" className="mb-2 text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !title.trim()}>
                {busy && <Loader2 aria-hidden="true" className="animate-spin" />}
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete conversation</DialogTitle>
            <DialogDescription>
              Delete “{deleting?.title}” and all of its messages? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                deleting &&
                void run(
                  () => onDelete(deleting.id),
                  () => setDeleting(null),
                )
              }
            >
              {busy && <Loader2 aria-hidden="true" className="animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
