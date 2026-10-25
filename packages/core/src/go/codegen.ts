/**
 * Go source generation: a verification program that prints what the real compiler does, and
 * the struct rewritten in the suggested field order.
 */
import { stripComments } from '../parser/preprocess';
import { tokenize } from '../parser/tokens';
import { formatGoType } from './parser';
import type { GoField } from './parser';

/** Suffix for the reordered copy, so it can sit next to the original in one file. */
export const GO_OPTIMIZED_SUFFIX = 'Optimized';

/**
 * Rows of cells in aligned columns, the way gofmt's tabwriter does it: column c is aligned
 * across each run of consecutive rows that have a cell after column c, one space apart.
 */
export function alignColumns(rows: readonly string[][]): string[] {
  const out = rows.map(() => '');
  const columns = Math.max(0, ...rows.map((r) => r.length));
  for (let c = 0; c < columns; c++) {
    let start = 0;
    while (start < rows.length) {
      if (rows[start].length <= c + 1) {
        if (rows[start].length === c + 1) out[start] += rows[start][c];
        start += 1;
        continue;
      }
      let end = start;
      while (end < rows.length && rows[end].length > c + 1) end += 1;
      const width = Math.max(...rows.slice(start, end).map((r) => r[c].length));
      for (let i = start; i < end; i++) out[i] += rows[i][c].padEnd(width + 1);
      start = end;
    }
  }
  return out;
}

/** A struct type declaration as gofmt prints it. */
export function formatGoStruct(name: string, fields: readonly GoField[]): string {
  const rows = fields.map((f) => {
    const cells = f.embedded ? [formatGoType(f.type)] : [f.name, formatGoType(f.type)];
    return f.tag ? [...cells, f.tag] : cells;
  });
  return `type ${name} struct {\n${alignColumns(rows).map((l) => `\t${l}`).join('\n')}\n}`;
}

/** The original source plus the reordered struct, named `<Root>Optimized`. */
export function generateGoOptimizedCode(source: string, rootName: string, ordered: readonly GoField[]): string {
  return `${source.trimEnd()}\n\n// ${rootName} with its fields in the order the fieldalignment analyzer suggests.\n${formatGoStruct(rootName + GO_OPTIMIZED_SUFFIX, ordered)}\n`;
}

/**
 * A `package main` program printing unsafe.Sizeof, Alignof and every Offsetof for `rootName`,
 * built from the input as written. The output format matches the C verification program.
 */
export function generateGoVerificationCode(
  source: string,
  rootName: string,
  fields: readonly GoField[],
  /** Emit a library package with this name and a `Report()` function instead of a program. */
  asPackage?: string,
): string {
  const packageName = asPackage ?? 'main';
  const funcName = asPackage ? 'Report' : 'main';
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const first = tokenize(stripComments(source))[0];
  const imports = 'import (\n\tspfmt "fmt"\n\tspunsafe "unsafe"\n)';

  let head: string[];
  let body: string[];
  if (first?.value === 'package') {
    const at = first.line - 1;
    head = [...lines.slice(0, at), lines[at].replace(/\bpackage\s+\w+/, `package ${packageName}`)];
    body = lines.slice(at + 1);
  } else {
    head = [`package ${packageName}`];
    body = lines;
  }

  const width = Math.max(4, ...fields.map((f) => f.name.length));
  const prints = fields
    // A blank field cannot be selected; embedded fields are selected by their type name.
    .filter((f) => f.name !== '_')
    .map(
      (f) =>
        `\tspfmt.Printf("  %-${width}s offset: %3d  size: %3d\\n", "${f.name}", spunsafe.Offsetof(v.${f.name}), spunsafe.Sizeof(v.${f.name}))`,
    );

  return [
    ...head,
    '',
    '// Added for verification: prints the layout the compiler chose.',
    imports,
    ...body,
    '',
    `func ${funcName}() {`,
    `\tvar v ${rootName}`,
    `\tspfmt.Printf("type ${rootName}: size %d, align %d\\n", spunsafe.Sizeof(v), spunsafe.Alignof(v))`,
    ...prints,
    '}',
    '',
  ].join('\n');
}

/** Whether the input already declares `func main`, which the verification program adds. */
export function declaresGoMain(source: string): boolean {
  const tokens = tokenize(stripComments(source));
  return tokens.some((t, i) => t.value === 'func' && tokens[i + 1]?.value === 'main' && tokens[i + 2]?.value === '(');
}
