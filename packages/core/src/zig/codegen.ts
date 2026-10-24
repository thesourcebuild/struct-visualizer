/**
 * Zig source generation: a verification program printing what the compiler chose, and an extern
 * struct rewritten with its fields in the suggested order.
 */
import type { ZigAnalysis } from './layout';
import type { ContainerDecl } from './parser';

const PRINT = '@import("std").debug.print';

/**
 * Lines of a function body printing size, align, each field's offset and size (structs; bit
 * offset and bit size for packed structs; size for unions) and the size of ?Root. The format
 * matches the C, Go and Rust programs.
 */
function reportBody(root: string, a: ZigAnalysis): string[] {
  const def = a.definition!;
  const fields = def.kind === 'enum' ? [] : def.decl.fields.filter((f) => !f.comptime).map((f, i) => f.name ?? String(i));
  const width = Math.max(4, ...fields.map((n) => n.length));
  const lines = [`    ${PRINT}("type ${def.name}: size {d}, align {d}\\n", .{ @sizeOf(${root}), @alignOf(${root}) });`];
  for (const name of fields) {
    const label = JSON.stringify(name);
    const type = `@FieldType(${root}, ${label})`;
    if (def.kind === 'union') {
      lines.push(`    ${PRINT}("  {s:<${width}} size: {d:>3}\\n", .{ ${label}, @sizeOf(${type}) });`);
    } else if (def.layout === 'packed') {
      lines.push(`    ${PRINT}("  {s:<${width}} bit offset: {d:>3}  bits: {d:>3}\\n", .{ ${label}, @bitOffsetOf(${root}, ${label}), @bitSizeOf(${type}) });`);
    } else {
      lines.push(`    ${PRINT}("  {s:<${width}} offset: {d:>3}  size: {d:>3}\\n", .{ ${label}, @offsetOf(${root}, ${label}), @sizeOf(${type}) });`);
    }
  }
  lines.push(`    ${PRINT}("  ?${def.name}: size {d}\\n", .{@sizeOf(?${root})});`);
  return lines;
}

/** A program printing the layout of the analysed type as compiled. */
export function generateZigVerificationCode(source: string, a: ZigAnalysis, root = a.definition!.name): string {
  return [source.trimEnd(), '', '// Added for verification: prints the layout Zig chose.', 'pub fn main() void {', ...reportBody(root, a), '}', ''].join('\n');
}

/** The same report as a function in a namespace, so many cases share one program (tests). */
export function generateZigVerificationModule(source: string, a: ZigAnalysis, namespace: string): string {
  return [`const ${namespace} = struct {`, source.trimEnd(), '', 'pub fn report() void {', ...reportBody(a.definition!.name, a), '}', '};', ''].join('\n');
}

/** Whether the input declares `main`, which the verification program adds. */
export function declaresZigMain(source: string): boolean {
  return /\bfn\s+main\s*\(/.test(source.replace(/\/\/[^\n]*/g, ''));
}

/** Suffix for the reordered copy, so it can sit next to the original in one file. */
export const ZIG_OPTIMIZED_SUFFIX = 'Optimized';

/** An extern struct with its fields in a new order (declarations inside it are left out). */
export function formatZigStruct(source: string, decl: ContainerDecl, order: readonly string[], name: string): string {
  const head = source.slice(decl.start, decl.bodyStart).trim();
  const fields = order.map((n) => {
    const f = decl.fields.find((x) => x.name === n)!;
    return `    ${source.slice(f.start, f.end).replace(/\s*\n\s*/g, ' ')},`;
  });
  return `const ${name} = ${head} {\n${fields.join('\n')}\n};`;
}
