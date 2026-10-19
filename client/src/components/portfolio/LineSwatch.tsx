/** A short line sample identifying a series: solid navy, or the dashed gray benchmark. */
export function LineSwatch({ benchmark = false }: { benchmark?: boolean }) {
  return (
    <svg width="20" height="8" aria-hidden="true" className="shrink-0">
      <line
        x1="0"
        y1="4"
        x2="20"
        y2="4"
        strokeWidth="2"
        stroke={benchmark ? "var(--chart-benchmark)" : "var(--chart-1)"}
        strokeDasharray={benchmark ? "5 3" : undefined}
      />
    </svg>
  );
}
