interface ChartDataProps {
  caption: string;
  columns: string[];
  rows: string[][];
}

/** The chart's numbers as a table, collapsed under "View data". */
export function ChartData({ caption, columns, rows }: ChartDataProps) {
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
        View data
      </summary>
      <div className="mt-1 max-h-48 overflow-y-auto rounded border">
        <table className="w-full tabular-nums">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
            <tr>
              {columns.map((column, i) => (
                <th
                  key={column}
                  scope="col"
                  className={
                    i === 0
                      ? "px-2 py-1 font-medium"
                      : "px-2 py-1 text-right font-medium"
                  }
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.join("|")} className="border-t">
                {row.map((cell, i) => (
                  <td
                    key={i}
                    className={i === 0 ? "px-2 py-1" : "px-2 py-1 text-right"}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
