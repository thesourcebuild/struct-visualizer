import type { ZodType } from "zod";
import type { Diagnostic, LintRule, OptionValue, OptionValues } from "@sp/contracts";
import type { OptionCatalogue } from "./catalogue/options";
import type { OptionGroupMeta } from "./catalogue/groups";

export type ToolFamily = "layout" | "go" | "rust" | "reference";

/** Language of a tool's source input. Tools of one language share the editor contents. */
export type InputLanguage = "c" | "go" | "rust";

export interface ToolSpecBase {
  specVersion: number;
  options: OptionValues;
}

/**
 * Cheap, eagerly bundled metadata: everything the sidebar, sitemap and per-tool pages need.
 * Must stay free of heavy imports; behaviour lives in the lazily loaded ToolDefinition.
 */
export interface ToolManifest {
  id: string;
  label: string;
  family: ToolFamily;
  /** Sidebar sub-group within the family. */
  category: string;
  tags: readonly string[];
  summary: string;
  /** False for reference tools that compute from options alone. */
  readsInput: boolean;
  /** Language of the input, when the tool reads one. */
  inputLanguage?: InputLanguage;
  supportsVariants: boolean;
}

export interface ToolResultField {
  label: string;
  value: string;
  mono?: boolean;
}

export interface ToolTableColumn {
  key: string;
  label: string;
  align?: "left" | "right" | "center";
  mono?: boolean;
}

export interface ToolTable {
  id: string;
  title: string;
  summary?: string;
  columns: readonly ToolTableColumn[];
  rows: readonly Record<string, string | number>[];
}

export interface ToolVariantRow {
  cells: Record<string, string | number>;
  /** Option patch that switches the spec to this row's configuration. */
  options: OptionValues;
  current: boolean;
  error?: string;
}

export interface ToolVariantTable {
  title: string;
  summary?: string;
  columns: readonly ToolTableColumn[];
  rows: readonly ToolVariantRow[];
  /** Column whose value splits the rows into sections (shown as a header, not repeated per row). */
  groupBy?: string;
  /** Numeric column to show as a +/- delta against the current row. */
  compareKey?: string;
}

export interface ToolExportFile {
  filename: string;
  content: string;
  mimeType: string;
  /** Short label for the file in the UI, e.g. "C verification program". */
  label?: string;
}

export interface ToolSample {
  id: string;
  label: string;
  input: string;
}

export interface ToolResult<TData = unknown> {
  /** Tool-specific payload rendered by a bespoke result view. */
  data?: TData;
  text?: string;
  fields?: readonly ToolResultField[];
  /** Step-by-step explanation. */
  working?: string;
  workingFormat?: "monospace" | "markdown";
  tables?: readonly ToolTable[];
  files?: readonly ToolExportFile[];
  error?: string;
}

export interface LintContext<TSpec, TData = unknown> {
  spec: TSpec;
  input: string;
  result: ToolResult<TData>;
}

export interface ToolDefinition<TSpec extends ToolSpecBase = ToolSpecBase, TData = unknown>
  extends ToolManifest {
  groups: Record<string, OptionGroupMeta>;
  catalogue: OptionCatalogue;
  lintRules: readonly LintRule<LintContext<TSpec, TData>, TSpec>[];
  createSpec(options?: Partial<OptionValues>): TSpec;
  specSchema: ZodType<TSpec>;
  /** One human sentence describing what the spec computes. */
  describe(spec: TSpec): string;
  /** Spec-derived facts (e.g. resolved pointer size) shown without computing. */
  info?(spec: TSpec): readonly ToolResultField[];
  samples?: readonly ToolSample[];
  /** Layout work is cheap and synchronous; no worker needed. */
  compute(spec: TSpec, input: string): ToolResult<TData>;
  /** The same input computed across every sibling configuration (e.g. every ABI). */
  variants?(spec: TSpec, input: string): ToolVariantTable;
  /** Tags that drive option visibility (`OptionDef.availableOn`). May depend on the input. */
  variantTag?(spec: TSpec, input: string): string | readonly string[] | undefined;
  /** Per-option choice lists that depend on other options (e.g. data models valid for a target). */
  choicesFor?(spec: TSpec, optionId: string): readonly { value: string; label: string }[] | undefined;
  /** Hook to keep dependent options consistent when one changes. */
  onOptionChange?(spec: TSpec, id: string, value: OptionValue): TSpec;
}

export type AnyToolDefinition = ToolDefinition<ToolSpecBase, unknown>;

export type { Diagnostic };
