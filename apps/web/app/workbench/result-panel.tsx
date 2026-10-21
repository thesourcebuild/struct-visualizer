"use client";

import type { ToolResult } from "@sp/engine";
import { Button, CopyButton, Panel } from "@sp/ui";
import { platform } from "@sp/platform";
import { DataTable } from "./data-table";
import { FieldTable } from "./field-table";

/** Renders `code` spans; the only markdown tools emit in `working` today. */
function InlineCode({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") ? (
          <code key={i} className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs dark:bg-gray-700">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** Generic rendering of a ToolResult: fields, tables, text, files and working. */
export function ResultPanel({ result }: { result: ToolResult }) {
  return (
    <div className="space-y-4">
      {result.fields && result.fields.length > 0 && (
        <Panel title="Result">
          <FieldTable fields={result.fields} />
        </Panel>
      )}

      {result.tables?.map((t) => (
        <Panel key={t.id} title={t.title} subtitle={t.summary} bodyClassName="p-0">
          <DataTable caption={t.title} columns={t.columns} rows={t.rows} />
        </Panel>
      ))}

      {result.text !== undefined && (
        <Panel
          title={result.files?.[0]?.label ?? "Output"}
          subtitle={result.files?.[0]?.filename}
          actions={
            <>
              <CopyButton value={result.text} />
              {result.files?.map((f) => (
                <Button
                  key={f.filename}
                  variant="primary"
                  onClick={() => platform().saveFile(f.filename, f.content, f.mimeType)}
                >
                  Download {f.filename}
                </Button>
              ))}
            </>
          }
          bodyClassName="p-0"
        >
          <pre className="max-h-128 overflow-auto rounded-b-lg bg-gray-900 p-4 text-sm leading-relaxed text-gray-100">
            <code>{result.text}</code>
          </pre>
        </Panel>
      )}

      {result.working && (
        <Panel title="How to use">
          <div className="space-y-1 text-sm text-gray-700 dark:text-gray-300">
            {result.working.split("\n").map((line, i) => (
              <p key={i}>
                {result.workingFormat === "markdown" ? <InlineCode text={line} /> : line}
              </p>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}
