"use client";

import { Fragment, useMemo, useState } from "react";
import type { AnyToolDefinition, ToolSpecBase, ToolVariantRow, ToolVariantTable } from "@sp/engine";
import type { OptionValues } from "@sp/contracts";
import { Panel, cn } from "@sp/ui";
import { ChevronIcon } from "./icons";

interface VariantsPanelProps {
  tool: AnyToolDefinition;
  spec: ToolSpecBase;
  input: string;
  onSelect: (options: OptionValues) => void;
}

const ALIGN = { left: "text-left", right: "text-right", center: "text-center" } as const;

interface Group {
  key: string;
  rows: ToolVariantRow[];
}

function groupRows(table: ToolVariantTable): Group[] {
  if (!table.groupBy) return [{ key: "", rows: [...table.rows] }];
  const groups: Group[] = [];
  for (const row of table.rows) {
    const key = String(row.cells[table.groupBy] ?? "");
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else groups.push({ key, rows: [row] });
  }
  return groups;
}

function numeric(v: string | number | undefined): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** "16-24 bytes" style range of the compare column within a group. */
function rangeLabel(rows: ToolVariantRow[], key: string | undefined): string | undefined {
  if (!key) return undefined;
  const values = rows.map((r) => numeric(r.cells[key])).filter((v): v is number => v !== undefined);
  if (values.length === 0) return undefined;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? `${min} bytes` : `${min}–${max} bytes`;
}

function Delta({ value, current }: { value: number | undefined; current: number | undefined }) {
  if (value === undefined || current === undefined) return null;
  const d = value - current;
  if (d === 0) return <span className="ml-1.5 inline-block w-9 text-right text-[11px] text-gray-300 dark:text-gray-600">=</span>;
  return (
    <span
      className={cn(
        "ml-1.5 inline-block w-9 text-right text-[11px] font-medium",
        d > 0 ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400",
      )}
    >
      {d > 0 ? `+${d}` : `−${-d}`}
    </span>
  );
}

/**
 * The same input across every sibling configuration, grouped into sections (one per
 * architecture). Computed only while expanded: it runs the full pipeline once per platform.
 */
export function VariantsPanel({ tool, spec, input, onSelect }: VariantsPanelProps) {
  const [open, setOpen] = useState(false);
  const table = useMemo(
    () => (open && tool.variants ? tool.variants(spec, input) : undefined),
    [open, tool, spec, input],
  );

  if (!tool.variants) return null;

  const columns = table ? table.columns.filter((c) => c.key !== table.groupBy) : [];
  const groupColumn = table?.columns.find((c) => c.key === table.groupBy);
  const currentValue = table?.compareKey
    ? numeric(table.rows.find((r) => r.current)?.cells[table.compareKey])
    : undefined;

  return (
    <Panel
      title={table?.title ?? "Across targets"}
      subtitle={table?.summary ?? "Compare this layout on every supported target."}
      actions={
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-500/10"
        >
          {open ? "Hide table" : "Show table"}
          <ChevronIcon className={cn("h-3.5 w-3.5 transition-transform", open ? "-rotate-90" : "rotate-90")} />
        </button>
      }
      bodyClassName={open ? "p-0" : "hidden"}
    >
      {table && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{table.title}</caption>
            <thead>
              <tr className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400">
                {columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className={cn("whitespace-nowrap px-4 py-2.5 font-semibold", ALIGN[c.align ?? "left"])}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groupRows(table).map((group) => (
                <Fragment key={group.key}>
                  {table.groupBy && (
                    <tr className="border-y border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-900/60">
                      <th
                        scope="rowgroup"
                        colSpan={columns.length}
                        className="px-4 py-2 text-left"
                        aria-label={`${groupColumn?.label ?? ""} ${group.key}`}
                      >
                        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{group.key}</span>
                        <span className="ml-3 text-xs font-normal text-gray-500 dark:text-gray-400">
                          {group.rows.length} configuration{group.rows.length === 1 ? "" : "s"}
                          {rangeLabel(group.rows, table.compareKey) && ` · ${rangeLabel(group.rows, table.compareKey)}`}
                        </span>
                      </th>
                    </tr>
                  )}
                  {group.rows.map((row, i) => (
                    <tr
                      key={i}
                      onClick={() => onSelect(row.options)}
                      title={row.error ?? (row.current ? "Current selection" : "Switch to this platform")}
                      className={cn(
                        "cursor-pointer border-b border-gray-100 transition-colors last:border-b-0 dark:border-gray-700/50",
                        row.current
                          ? "bg-blue-50 dark:bg-blue-500/10"
                          : "hover:bg-gray-50 dark:hover:bg-gray-700/40",
                        row.error && "text-gray-400",
                      )}
                    >
                      {columns.map((c, ci) => (
                        <td
                          key={c.key}
                          className={cn(
                            "whitespace-nowrap px-4 py-2 text-gray-800 dark:text-gray-200",
                            ALIGN[c.align ?? "left"],
                            c.mono && "font-mono text-xs",
                            ci === 0 && row.current && "border-l-2 border-blue-500 font-semibold",
                            ci === 0 && !row.current && "border-l-2 border-transparent",
                          )}
                        >
                          {row.cells[c.key]}
                          {ci === 0 && row.current && (
                            <span className="ml-2 rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                              Current
                            </span>
                          )}
                          {c.key === table.compareKey && (
                            <Delta value={numeric(row.cells[c.key])} current={currentValue} />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
