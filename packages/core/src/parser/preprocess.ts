/**
 * A small C preprocessor: enough of translation phases 1-4 to lay out struct declarations.
 *
 * - Comments are removed and line continuations joined, keeping every line number intact.
 * - #if / #ifdef / #ifndef / #elif / #else / #endif are evaluated; inactive lines are blanked.
 * - #define / #undef maintain the macro table. Object-like macros are expanded at token level
 *   (see expandMacros). Function-like macros are recorded; using one is reported as an error,
 *   because they are not expanded.
 * - #pragma pack(...) is recorded by line so each definition gets the packing in effect where
 *   it starts. #pragma once is accepted; other pragmas are reported as ignored.
 * - #include is accepted and skipped: the fixed-width and size types it would bring in are
 *   built in.
 */
import type { ParseError } from '../types';
import { evaluateConstExpr, ConstExprError } from './const-expr';
import { tokenize } from './tokens';
import type { Token } from './tokens';

export type PackEvent =
  | { line: number; kind: 'set'; value: number | undefined }
  | { line: number; kind: 'push'; id?: string; value?: number }
  | { line: number; kind: 'pop'; id?: string; value?: number };

export interface Preprocessed {
  /** Source with comments and directives blanked; same number of lines as the input. */
  text: string;
  objectMacros: Map<string, Token[]>;
  functionMacros: Set<string>;
  packEvents: PackEvent[];
  errors: ParseError[];
  warnings: ParseError[];
}

const VALID_PACK = new Set([1, 2, 4, 8, 16]);

/** Remove comments, keeping newlines so line numbers survive. String literals are respected. */
export function stripComments(code: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '`') {
      // Go raw string (e.g. a struct tag): may contain "//" and span lines.
      const end = code.indexOf('`', i + 1);
      const stop = end === -1 ? code.length : end + 1;
      out += code.slice(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== c && code[j] !== '\n') j += code[j] === '\\' ? 2 : 1;
      out += code.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i += 1;
    } else if (c === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      const stop = end === -1 ? code.length : end + 2;
      out += ' ' + code.slice(i, stop).replace(/[^\n]/g, '');
      i = stop;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

export function preprocess(code: string): Preprocessed {
  const result: Preprocessed = {
    text: '',
    objectMacros: new Map(),
    functionMacros: new Set(),
    packEvents: [],
    errors: [],
    warnings: [],
  };

  // Physical lines after comment removal. A logical line may span several physical ones
  // (backslash-newline); its continuation lines are output as blank lines.
  const physical = stripComments(code).replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = new Array(physical.length).fill('');

  // Conditional-inclusion stack: active = this branch is being compiled; taken = some branch
  // of this #if group already was.
  const conds: Array<{ active: boolean; taken: boolean; parentActive: boolean }> = [];
  const isActive = () => conds.length === 0 || conds[conds.length - 1].active;

  const evalCondition = (expr: string, line: number): boolean => {
    // defined(X) / defined X first, then macro-expand, then unknown identifiers are 0.
    const replaced = expr.replace(/\bdefined\s*(?:\(\s*([A-Za-z_]\w*)\s*\)|([A-Za-z_]\w*))/g, (_, a, b) =>
      result.objectMacros.has(a ?? b) || result.functionMacros.has(a ?? b) ? '1' : '0',
    );
    const tokens = expandMacros(tokenize(replaced), result.objectMacros, new Set(), [], line);
    try {
      return evaluateConstExpr(tokens, () => 0) !== 0;
    } catch (err) {
      result.errors.push({ message: `Cannot evaluate '#if ${expr.trim()}': ${(err as Error).message}.`, line, type: 'syntax' });
      return false;
    }
  };

  for (let i = 0; i < physical.length; i++) {
    const startLine = i + 1;
    let logical = physical[i];
    while (logical.endsWith('\\') && i + 1 < physical.length) {
      logical = logical.slice(0, -1) + ' ' + physical[i + 1];
      i += 1;
    }

    const directive = /^\s*#\s*([A-Za-z_]\w*)?(.*)$/.exec(logical);
    if (!directive) {
      if (isActive()) out[startLine - 1] = logical;
      continue;
    }

    const name = directive[1] ?? '';
    const rest = directive[2].trim();

    // Conditionals are processed even in inactive regions, to keep the nesting right.
    if (name === 'if' || name === 'ifdef' || name === 'ifndef') {
      const parentActive = isActive();
      let cond = false;
      if (parentActive) {
        if (name === 'if') cond = evalCondition(rest, startLine);
        else {
          const id = /^[A-Za-z_]\w*/.exec(rest)?.[0] ?? '';
          const defined = result.objectMacros.has(id) || result.functionMacros.has(id);
          cond = name === 'ifdef' ? defined : !defined;
        }
      }
      conds.push({ active: parentActive && cond, taken: parentActive && cond, parentActive });
      continue;
    }
    if (name === 'elif' || name === 'else') {
      const top = conds[conds.length - 1];
      if (!top) {
        result.errors.push({ message: `#${name} without a matching #if.`, line: startLine, type: 'syntax' });
        continue;
      }
      const cond = !top.taken && top.parentActive && (name === 'else' || evalCondition(rest, startLine));
      top.active = cond;
      top.taken = top.taken || cond;
      continue;
    }
    if (name === 'endif') {
      if (!conds.pop()) result.errors.push({ message: '#endif without a matching #if.', line: startLine, type: 'syntax' });
      continue;
    }

    if (!isActive()) continue;

    if (name === 'define') {
      const m = /^([A-Za-z_]\w*)(\()?(.*)$/.exec(rest);
      if (!m) {
        result.errors.push({ message: `Malformed #define: '${logical.trim()}'.`, line: startLine, type: 'syntax' });
        continue;
      }
      // A '(' immediately after the name (no space) makes it function-like.
      if (m[2]) {
        result.functionMacros.add(m[1]);
        result.objectMacros.delete(m[1]);
      } else {
        result.objectMacros.set(m[1], tokenize(m[3]));
        result.functionMacros.delete(m[1]);
      }
    } else if (name === 'undef') {
      const id = rest.split(/\s+/)[0];
      result.objectMacros.delete(id);
      result.functionMacros.delete(id);
    } else if (name === 'pragma') {
      handlePragma(rest, startLine, result);
    } else if (name === 'error') {
      result.errors.push({ message: `#error ${rest}`, line: startLine, type: 'semantic' });
    } else if (name === 'include' || name === 'warning' || name === 'line' || name === '') {
      // #include: built-in types cover the standard headers. Null directive '#': no effect.
    } else {
      result.warnings.push({ message: `Unknown directive '#${name}' is ignored.`, line: startLine, type: 'warning' });
    }
  }

  if (conds.length > 0) {
    result.errors.push({ message: 'Unterminated #if: missing #endif.', type: 'syntax' });
  }

  result.text = out.join('\n');
  return result;
}

function handlePragma(rest: string, line: number, result: Preprocessed): void {
  const pragma = /^([A-Za-z_]\w*)\s*(.*)$/.exec(rest);
  const kind = pragma?.[1] ?? '';
  if (kind === 'once') return;
  if (kind !== 'pack') {
    result.warnings.push({
      message: `#pragma ${kind || rest} is ignored: only #pragma pack affects layout here.`,
      line,
      type: 'warning',
    });
    return;
  }

  const args = /^\((.*)\)\s*$/.exec(pragma?.[2] ?? '')?.[1];
  if (args === undefined) {
    result.errors.push({ message: `Malformed #pragma pack: '#pragma ${rest}'.`, line, type: 'syntax' });
    return;
  }
  const parts = args.split(',').map((p) => p.trim()).filter(Boolean);
  const readValue = (text: string): number | undefined => {
    let value: number;
    try {
      value = evaluateConstExpr(expandMacros(tokenize(text), result.objectMacros, new Set(), [], line), () => undefined);
    } catch (err) {
      result.errors.push({ message: `#pragma pack value '${text}' ${err instanceof ConstExprError ? `is invalid: ${err.message}` : 'is invalid'}.`, line, type: 'syntax' });
      return undefined;
    }
    if (!VALID_PACK.has(value)) {
      result.warnings.push({ message: `#pragma pack(${value}) is ignored: the value must be 1, 2, 4, 8 or 16.`, line, type: 'warning' });
      return undefined;
    }
    return value;
  };
  const isNumberish = (p: string) => !/^[A-Za-z_]\w*$/.test(p) || result.objectMacros.has(p);

  if (parts.length === 0) {
    result.packEvents.push({ line, kind: 'set', value: undefined });
  } else if (parts[0] === 'push' || parts[0] === 'pop') {
    const op = parts[0];
    let id: string | undefined;
    let value: number | undefined;
    for (const p of parts.slice(1)) {
      if (isNumberish(p)) value = readValue(p);
      else id = p;
    }
    result.packEvents.push({ line, kind: op, id, value });
  } else if (parts[0] === 'show') {
    // Reports the current value in MSVC; no layout effect.
  } else {
    const value = readValue(parts[0]);
    if (value !== undefined) result.packEvents.push({ line, kind: 'set', value });
  }
}

/** The #pragma pack value in effect at `line`, by replaying the events before it. */
export function packAt(events: readonly PackEvent[], line: number): number | undefined {
  let current: number | undefined;
  const stack: Array<{ id?: string; value: number | undefined }> = [];
  for (const e of events) {
    if (e.line >= line) break;
    if (e.kind === 'set') current = e.value;
    else if (e.kind === 'push') {
      stack.push({ id: e.id, value: current });
      if (e.value !== undefined) current = e.value;
    } else {
      if (e.id !== undefined) {
        const at = stack.map((s) => s.id).lastIndexOf(e.id);
        if (at >= 0) {
          current = stack[at].value;
          stack.length = at;
        }
      } else if (stack.length > 0) {
        current = stack.pop()!.value;
      }
      if (e.value !== undefined) current = e.value;
    }
  }
  return current;
}

/**
 * Replace object-like macro names with their definitions, recursively, never re-expanding a
 * macro inside its own expansion (C11 6.10.3.4). A function-like macro invocation is reported,
 * because those are not expanded.
 */
export function expandMacros(
  tokens: readonly Token[],
  macros: ReadonlyMap<string, Token[]>,
  functionMacros: ReadonlySet<string>,
  errors: ParseError[],
  lineOverride?: number,
  active: ReadonlySet<string> = new Set(),
): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const line = lineOverride ?? t.line;
    if (t.kind === 'id' && macros.has(t.value) && !active.has(t.value)) {
      const nested = new Set(active).add(t.value);
      const body = macros.get(t.value)!.map((b) => ({ ...b, line }));
      out.push(...expandMacros(body, macros, functionMacros, errors, line, nested));
      continue;
    }
    if (t.kind === 'id' && functionMacros.has(t.value) && tokens[i + 1]?.value === '(') {
      errors.push({
        message: `Function-like macro '${t.value}(...)' is not expanded. Write the expanded code instead.`,
        line,
        type: 'semantic',
      });
    }
    out.push(lineOverride === undefined ? t : { ...t, line });
  }
  return out;
}
