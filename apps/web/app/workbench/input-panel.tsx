"use client";

import type { InputLanguage, ToolSample } from "@sp/engine";
import { CopyButton, Panel } from "@sp/ui";
import CodeEditor from "@/components/tools/editor/CodeEditor";
import { INPUT_COPY } from "./default-input";

interface InputPanelProps {
  value: string;
  onChange: (value: string) => void;
  samples?: readonly ToolSample[];
  pending: boolean;
  language: InputLanguage;
}

export function InputPanel({ value, onChange, samples, pending, language }: InputPanelProps) {
  const copy = INPUT_COPY[language];
  return (
    <Panel
      title={copy.title}
      subtitle={copy.subtitle}
      actions={
        <>
          {pending && <span className="text-xs text-gray-400">updating…</span>}
          {samples && samples.length > 0 && (
            <select
              aria-label="Load an example"
              value=""
              onChange={(e) => {
                const sample = samples.find((s) => s.id === e.target.value);
                if (sample) onChange(sample.input);
              }}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
            >
              <option value="">Load example…</option>
              {samples.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          )}
          <CopyButton value={value} />
        </>
      }
      bodyClassName="p-3"
    >
      <div className="h-72">
        <CodeEditor value={value} onChange={onChange} placeholder={copy.placeholder} />
      </div>
    </Panel>
  );
}
