/**
 * Declarative option catalogue. Each tool lists its options as data; the web app renders
 * the form from it, so tools never ship React code for their settings.
 */
export type OptionKind = "boolean" | "enum" | "number" | "text";

export interface OptionEnumChoice {
  value: string;
  label: string;
  summary?: string;
}

export interface OptionDef<TGroup extends string = string> {
  id: string;
  label: string;
  group: TGroup;
  kind: OptionKind;
  /** For `enum` options. Tools may compute these from the current spec via `choicesFor`. */
  choices?: readonly OptionEnumChoice[];
  arg?: { placeholder?: string; unit?: string; min?: number; max?: number; step?: number };
  summary: string;
  detail?: string;
  /**
   * Only shown when `variantTag(spec)` returns one of these tags. Lets a tool hide options
   * that make no sense for the current selection (e.g. enum overrides when no enum exists).
   */
  availableOn?: readonly string[];
  order: number;
  colSpan?: 1 | 2;
}

export interface OptionCatalogue<TGroup extends string = string> {
  readonly all: readonly OptionDef<TGroup>[];
  get(id: string): OptionDef<TGroup> | undefined;
  require(id: string): OptionDef<TGroup>;
  inGroup(group: TGroup): OptionDef<TGroup>[];
  inDisplayOrder(): OptionDef<TGroup>[];
}

export function createOptionCatalogue<TGroup extends string>(
  options: readonly OptionDef<TGroup>[],
): OptionCatalogue<TGroup> {
  const byId = new Map(options.map((o) => [o.id, o]));
  if (byId.size !== options.length) {
    throw new Error("Duplicate option id in catalogue");
  }
  const ordered = [...options].sort((a, b) => a.order - b.order);
  return {
    all: options,
    get: (id) => byId.get(id),
    require: (id) => {
      const def = byId.get(id);
      if (!def) throw new Error(`Unknown option id: ${id}`);
      return def;
    },
    inGroup: (group) => ordered.filter((o) => o.group === group),
    inDisplayOrder: () => ordered,
  };
}

/** Whether an option is visible for the tags a tool reports for the current spec. */
export function isAvailableOn(
  def: Pick<OptionDef, "availableOn">,
  tags: string | readonly string[] | undefined,
): boolean {
  if (!def.availableOn || def.availableOn.length === 0) return true;
  const active = tags === undefined ? [] : typeof tags === "string" ? [tags] : tags;
  return def.availableOn.some((tag) => active.includes(tag));
}
