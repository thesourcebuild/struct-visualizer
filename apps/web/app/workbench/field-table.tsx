import type { ToolResultField } from "@sp/engine";
import { cn } from "@sp/ui";

/** Label/value facts (result fields or spec-derived info). */
export function FieldTable({ fields }: { fields: readonly ToolResultField[] }) {
  if (fields.length === 0) return null;
  return (
    <dl className="divide-y divide-gray-100 text-sm dark:divide-gray-700">
      {fields.map((f) => (
        <div key={f.label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-1.5">
          <dt className="text-gray-500 dark:text-gray-400">{f.label}</dt>
          <dd className={cn("text-right text-gray-900 dark:text-gray-100", f.mono && "font-mono text-xs")}>
            {f.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
