"use client";

import { useId, useState } from "react";
import { groupsInOrder, isAvailableOn } from "@sp/engine";
import type { AnyToolDefinition, OptionDef, OptionGroupMeta, ToolSpecBase } from "@sp/engine";
import type { OptionValue } from "@sp/contracts";
import { cn } from "@sp/ui";
import { ChevronIcon } from "./icons";

interface OptionsFormProps {
  tool: AnyToolDefinition;
  spec: ToolSpecBase;
  tags: string | readonly string[] | undefined;
  /** Option ids referenced by current diagnostics; marked as suggested in the form. */
  highlighted: ReadonlySet<string>;
  onChange: (id: string, value: OptionValue) => void;
}

/** Enums with this many choices or fewer render as a segmented control instead of a select. */
const SEGMENTED_MAX = 3;

function FieldLabel({ htmlFor, def, suggested }: { htmlFor?: string; def: OptionDef; suggested: boolean }) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2">
      <label htmlFor={htmlFor} className="text-xs font-medium text-gray-700 dark:text-gray-300">
        {def.label}
      </label>
      {suggested && (
        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700 ring-1 ring-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-500/30">
          Suggested
        </span>
      )}
    </div>
  );
}

function Select({
  id,
  value,
  choices,
  onChange,
  title,
}: {
  id: string;
  value: string;
  choices: readonly { value: string; label: string; summary?: string }[];
  onChange: (v: string) => void;
  title?: string;
}) {
  // Hovering the closed dropdown explains the current choice; each option carries its own hint.
  const current = choices.find((c) => c.value === value)?.summary;
  return (
    <div className="relative">
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title={current ?? title}
        className="w-full appearance-none rounded-lg border border-gray-200 bg-white py-2 pl-3 pr-9 text-sm text-gray-900 shadow-sm transition-colors hover:border-gray-300 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
      >
        {choices.map((c) => (
          <option key={c.value} value={c.value} title={c.summary}>
            {c.label}
          </option>
        ))}
      </select>
      <ChevronIcon className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 rotate-90 text-gray-400" />
    </div>
  );
}

function Segmented({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: string;
  choices: readonly { value: string; label: string; summary?: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="grid gap-1 rounded-lg bg-gray-100 p-1 dark:bg-gray-900"
      style={{ gridTemplateColumns: `repeat(${choices.length}, minmax(0, 1fr))` }}
    >
      {choices.map((c) => {
        const on = c.value === value;
        return (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={c.summary}
            onClick={() => onChange(c.value)}
            className={cn(
              "truncate rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
              on
                ? "bg-white text-gray-900 shadow-sm dark:bg-gray-700 dark:text-white"
                : "text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200",
            )}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

function Switch({
  def,
  checked,
  suggested,
  onChange,
}: {
  def: OptionDef;
  checked: boolean;
  suggested: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start justify-between gap-3 text-left"
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-200">
          {def.label}
          {suggested && (
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700 ring-1 ring-blue-200 dark:bg-blue-500/10 dark:text-blue-300 dark:ring-blue-500/30">
              Suggested
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-xs leading-snug text-gray-500 dark:text-gray-400">{def.summary}</span>
      </span>
      <span
        aria-hidden
        className={cn(
          "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-blue-600" : "bg-gray-300 dark:bg-gray-600",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-4.5" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
}

function OptionField({
  tool,
  spec,
  def,
  suggested,
  onChange,
}: {
  tool: AnyToolDefinition;
  spec: ToolSpecBase;
  def: OptionDef;
  suggested: boolean;
  onChange: (id: string, value: OptionValue) => void;
}) {
  const id = `opt-${def.id}`;
  const value = spec.options[def.id];
  // A suggested option is marked by the "Suggested" tag alone: no border or tinted box.
  const wrapper = "";

  if (def.kind === "boolean") {
    return (
      <div className={wrapper}>
        <Switch def={def} checked={value === true} suggested={suggested} onChange={(v) => onChange(def.id, v)} />
      </div>
    );
  }

  if (def.kind === "enum") {
    const choices = tool.choicesFor?.(spec, def.id) ?? def.choices ?? [];
    const segmented = def.control !== "select" && choices.length <= SEGMENTED_MAX && choices.length > 1;
    return (
      <div className={wrapper}>
        <FieldLabel htmlFor={segmented ? undefined : id} def={def} suggested={suggested} />
        {segmented ? (
          <Segmented
            label={def.label}
            value={String(value ?? "")}
            choices={choices}
            onChange={(v) => onChange(def.id, v)}
          />
        ) : (
          <Select
            id={id}
            value={String(value ?? "")}
            choices={choices}
            onChange={(v) => onChange(def.id, v)}
            title={def.summary}
          />
        )}
      </div>
    );
  }

  return (
    <div className={wrapper}>
      <FieldLabel htmlFor={id} def={def} suggested={suggested} />
      <input
        id={id}
        type={def.kind === "number" ? "number" : "text"}
        value={String(value ?? "")}
        placeholder={def.arg?.placeholder}
        min={def.arg?.min}
        max={def.arg?.max}
        step={def.arg?.step}
        onChange={(e) => onChange(def.id, def.kind === "number" ? Number(e.target.value) : e.target.value)}
        className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-600 dark:bg-gray-900"
        title={def.summary}
      />
    </div>
  );
}

function Section({
  meta,
  defaultOpen,
  children,
}: {
  meta: OptionGroupMeta;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section className="px-4 py-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">{meta.label}</span>
        <ChevronIcon className={cn("h-4 w-4 text-gray-400 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <div id={bodyId} className="mt-3 space-y-4">
          {meta.summary && <p className="-mt-1.5 text-xs leading-snug text-gray-500 dark:text-gray-400">{meta.summary}</p>}
          {children}
        </div>
      )}
    </section>
  );
}

/** Settings card generated from the tool's option catalogue and groups. */
export function OptionsForm({ tool, spec, tags, highlighted, onChange }: OptionsFormProps) {
  const groups = groupsInOrder(tool.groups)
    .map((g) => ({
      meta: g,
      options: tool.catalogue.inGroup(g.id).filter((def) => isAvailableOn(def, tags)),
    }))
    .filter((g) => g.options.length > 0);

  if (groups.length === 0) return null;

  return (
    <div className="divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:divide-gray-700 dark:border-gray-700 dark:bg-gray-800">
      <div className="px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Settings</h2>
      </div>
      {groups.map(({ meta, options }) => (
        <Section
          key={meta.id}
          meta={meta}
          defaultOpen={!meta.collapsedByDefault || options.some((o) => highlighted.has(o.id))}
        >
          {options.map((def) => (
            <OptionField
              key={def.id}
              tool={tool}
              spec={spec}
              def={def}
              suggested={highlighted.has(def.id)}
              onChange={onChange}
            />
          ))}
        </Section>
      ))}
    </div>
  );
}
