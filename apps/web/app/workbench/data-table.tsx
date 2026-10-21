import type { ToolTableColumn } from "@sp/engine";
import { cn } from "@sp/ui";

const ALIGN = { left: "text-left", right: "text-right", center: "text-center" } as const;

interface DataTableProps {
  columns: readonly ToolTableColumn[];
  rows: readonly Record<string, string | number>[];
  caption?: string;
  rowClassName?: (index: number) => string | undefined;
  onRowClick?: (index: number) => void;
  rowTitle?: (index: number) => string | undefined;
}

/** Plain, horizontally scrollable table shared by tool tables and the variants panel. */
export function DataTable({ columns, rows, caption, rowClassName, onRowClick, rowTitle }: DataTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-700/40">
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cn(
                  "whitespace-nowrap px-3 py-2 font-semibold text-gray-700 dark:text-gray-300",
                  ALIGN[c.align ?? "left"],
                )}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              onClick={onRowClick ? () => onRowClick(i) : undefined}
              title={rowTitle?.(i)}
              className={cn(
                "border-b border-gray-100 dark:border-gray-700/50",
                onRowClick && "cursor-pointer hover:bg-blue-50/60 dark:hover:bg-blue-900/20",
                rowClassName?.(i),
              )}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    "whitespace-nowrap px-3 py-1.5 text-gray-800 dark:text-gray-200",
                    ALIGN[c.align ?? "left"],
                    c.mono && "font-mono text-xs",
                  )}
                >
                  {row[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
