/**
 * Rust source generation: a verification program printing what rustc chose, and a repr(C)
 * struct rewritten with its fields in the suggested order.
 */
import { formatRustType } from './parser';
import type { RustField, RustFile, RustStruct } from './parser';

function rootFields(file: RustFile, rootName: string): RustField[] | null {
  const item = file.items.get(rootName);
  return item && (item.kind === 'struct' || item.kind === 'union') ? item.fields : null;
}

/**
 * Lines of a function body printing size, align, every field's offset and size (structs and
 * unions) and the size of Option<Root>. The format matches the C and Go programs.
 */
function reportBody(file: RustFile, rootName: string, mem: string): string[] {
  const fields = rootFields(file, rootName) ?? [];
  const width = Math.max(4, ...fields.map((f) => f.name.length));
  return [
    `    use ${mem}::{align_of, offset_of, size_of};`,
    `    println!("type ${rootName}: size {}, align {}", size_of::<${rootName}>(), align_of::<${rootName}>());`,
    ...fields.map(
      (f) =>
        `    println!("  {:<${width}} offset: {:>3}  size: {:>3}", "${f.name}", offset_of!(${rootName}, ${f.name}), size_of::<${formatRustType(f.type)}>());`,
    ),
    `    println!("  Option<${rootName}>: size {}", size_of::<Option<${rootName}>>());`,
  ];
}

/** A program printing the layout of `rootName` as compiled. */
export function generateRustVerificationCode(source: string, rootName: string, file: RustFile): string {
  return [
    source.trimEnd(),
    '',
    '// Added for verification: prints the layout rustc chose.',
    '#[allow(unused_imports)]',
    'fn main() {',
    ...reportBody(file, rootName, 'std::mem'),
    '}',
    '',
  ].join('\n');
}

/** The same report as a public function in a module, so many cases share one crate (tests). */
export function generateRustVerificationModule(source: string, rootName: string, file: RustFile, moduleName: string): string {
  return [
    `#[allow(dead_code, unused_imports, non_camel_case_types)]`,
    `pub mod ${moduleName} {`,
    source.trimEnd(),
    '',
    '#[allow(unused_imports)]',
    'pub fn report() {',
    ...reportBody(file, rootName, 'std::mem'),
    '}',
    '}',
    '',
  ].join('\n');
}

/** Whether the input declares `fn main`, which the verification program adds. */
export function declaresRustMain(source: string): boolean {
  return /\bfn\s+main\s*\(/.test(source.replace(/\/\/[^\n]*/g, ''));
}

/** Suffix for the reordered copy, so it can sit next to the original in one file. */
export const RUST_OPTIMIZED_SUFFIX = 'Optimized';

/** A struct with its fields in a new order, keeping its repr; optionally renamed. */
export function formatRustStruct(item: RustStruct, order: readonly string[], name = item.name): string {
  const reprs: string[] = [];
  if (item.repr.c) reprs.push('C');
  if (item.repr.packed !== undefined) reprs.push(item.repr.packed === 1 ? 'packed' : `packed(${item.repr.packed})`);
  if (item.repr.align !== undefined) reprs.push(`align(${item.repr.align})`);
  const head = reprs.length ? `#[repr(${reprs.join(', ')})]\n` : '';
  const fields = order.map((n) => item.fields.find((f) => f.name === n)!);
  if (item.shape === 'tuple') {
    return `${head}struct ${name}(${fields.map((f) => formatRustType(f.type)).join(', ')});`;
  }
  return `${head}struct ${name} {\n${fields.map((f) => `    ${f.name}: ${formatRustType(f.type)},`).join('\n')}\n}`;
}
