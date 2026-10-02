/**
 * Auto-scroll that respects the reader: new content scrolls into view only
 * while the list is already near the bottom. If the user scrolls up (e.g. to
 * reread while a reply streams), they stay put and `atBottom` turns false so
 * the UI can offer "Jump to latest".
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** How close (px) to the bottom still counts as "at the bottom". */
export const NEAR_BOTTOM_PX = 80;

export function useStickToBottom<T extends HTMLElement>(contentKey: string) {
  const containerRef = useRef<T>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    atBottomRef.current = near;
    setAtBottom(near);
  }, []);

  const scrollToBottom = useCallback(() => {
    atBottomRef.current = true;
    setAtBottom(true);
    endRef.current?.scrollIntoView({ block: "end" });
  }, []);

  // Follow new content (tokens, tool progress, messages) only when at the bottom.
  useEffect(() => {
    if (atBottomRef.current) {
      endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [contentKey]);

  return { containerRef, endRef, atBottom, onScroll, scrollToBottom };
}
