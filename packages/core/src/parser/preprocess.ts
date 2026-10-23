/**
 * A small C preprocessor: enough of translation phases 1-4 to lay out struct declarations.
 *
 * - Comments are removed and line continuations joined, keeping every line number intact.
 * - #if / #ifdef / #ifndef / #elif / #else / #endif are evaluated; inactive lines are blanked.
 * - #define / #undef maintain the macro table. Object-like and function-like macros are expanded
 *   at token level as C11 6.10.3 says (see expandMacros), with `#`, `##`, `__VA_ARGS__`,
 *   `__VA_OPT__` and GNU's `, ## __VA_ARGS__`.
 * - #pragma pack(...) is recorded by line so each definition gets the packing in effect where
 *   it starts. #pragma once is accepted; other pragmas are reported as ignored.
 * - #include is accepted and skipped: the fixed-width and size types it would bring in are
 *   built in.
 */
import type { ParseError } from '../types';
import { evaluateConstExpr, ConstExprError } from './const-expr';
import { findClosing, tokenize } from './tokens';
import type { Token } from './tokens';

export type PackEvent =
  | { line: number; kind: 'set'; value: number | undefined }
  | { line: number; kind: 'push'; id?: string; value?: number }
  | { line: number; kind: 'pop'; id?: string; value?: number };

export type Macro =
  | { kind: 'object'; body: Token[] }
  /** `params` ends with the variadic one (`__VA_ARGS__`, or GNU's `name...`) when `variadic`. */
  | { kind: 'function'; params: string[]; variadic: boolean; body: Token[] };

export interface Preprocessed {
  /** Source with comments and directives blanked; same number of lines as the input. */
  text: string;
  macros: Map<string, Macro>;
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

/** Run the directives of `code`. No macro is predefined. */
export function preprocess(code: string): Preprocessed {
  const result: Preprocessed = {
    text: '',
    macros: new Map(),
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
    // `defined X` is resolved before expansion (C11 6.10.1p4); then identifiers left are 0.
    const tokens = tokenize(expr);
    const resolved: Token[] = [];
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.kind !== 'id' || t.value !== 'defined') {
        resolved.push(t);
        continue;
      }
      const paren = tokens[k + 1]?.value === '(';
      const id = tokens[k + (paren ? 2 : 1)];
      if (id?.kind !== 'id' || (paren && tokens[k + 3]?.value !== ')')) {
        result.errors.push({ message: `'defined' in '#if ${expr.trim()}' needs a macro name.`, line, type: 'syntax' });
        return false;
      }
      resolved.push({ kind: 'num', value: result.macros.has(id.value) ? '1' : '0', line });
      k += paren ? 3 : 1;
    }
    const errors: ParseError[] = [];
    const expanded = expandMacros(resolved, result.macros, errors, line);
    if (errors.length > 0) {
      result.errors.push(...errors);
      return false;
    }
    try {
      return evaluateConstExpr(expanded, { identifier: () => 0, context: '#if' }) !== 0;
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
          const defined = result.macros.has(id);
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
      const parsed = parseDefine(rest, startLine, result.errors);
      if (!parsed) continue;
      const previous = result.macros.get(parsed.name);
      if (previous && !sameMacro(previous, parsed.macro)) {
        result.warnings.push({ message: `Macro '${parsed.name}' is redefined; the new definition is used.`, line: startLine, type: 'warning' });
      }
      result.macros.set(parsed.name, parsed.macro);
    } else if (name === 'undef') {
      result.macros.delete(rest.split(/\s+/)[0]);
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

/** `NAME body` or `NAME(params) body`: function-like only when '(' follows the name directly. */
function parseDefine(rest: string, line: number, errors: ParseError[]): { name: string; macro: Macro } | null {
  const head = /^([A-Za-z_]\w*)(\()?/.exec(rest);
  if (!head) {
    errors.push({ message: `Malformed #define: '#define ${rest}'.`, line, type: 'syntax' });
    return null;
  }
  const name = head[1];
  const withLine = (tokens: Token[]) => tokens.map((t) => ({ ...t, line }));
  const pasteAtEnd = (body: Token[]) => {
    if (body[0]?.value !== '##' && body[body.length - 1]?.value !== '##') return false;
    errors.push({ message: `'##' cannot be at either end of macro '${name}'.`, line, type: 'syntax' });
    return true;
  };
  if (!head[2]) {
    const body = withLine(tokenize(rest.slice(name.length)));
    return pasteAtEnd(body) ? null : { name, macro: { kind: 'object', body } };
  }

  const tokens = withLine(tokenize(rest.slice(name.length)));
  const close = findClosing(tokens, 0);
  if (close === -1) {
    errors.push({ message: `Missing ')' in the parameter list of macro '${name}'.`, line, type: 'syntax' });
    return null;
  }
  const params: string[] = [];
  let variadic = false;
  const list = tokens.slice(1, close);
  for (let k = 0; k < list.length; k++) {
    const t = list[k];
    const next = list[k + 1];
    const bad = () => errors.push({ message: `Malformed parameter list in macro '${name}'.`, line, type: 'syntax' });
    if (variadic) return bad(), null;
    if (t.value === '...') {
      params.push('__VA_ARGS__');
      variadic = true;
    } else if (t.kind === 'id' && next?.value === '...') {
      // GNU named variadic parameter: `args...`.
      params.push(t.value);
      variadic = true;
      k += 1;
    } else if (t.kind === 'id') {
      if (params.includes(t.value)) {
        errors.push({ message: `Duplicate parameter '${t.value}' in macro '${name}'.`, line, type: 'syntax' });
        return null;
      }
      params.push(t.value);
    } else {
      return bad(), null;
    }
    if (list[k + 1] !== undefined) {
      if (list[k + 1].value !== ',' || list[k + 2] === undefined) return bad(), null;
      k += 1;
    }
  }

  const body = tokens.slice(close + 1);
  if (pasteAtEnd(body)) return null;
  for (let k = 0; k < body.length; k++) {
    if (body[k].value === '#' && body[k].kind === 'punct' && !params.includes(body[k + 1]?.value ?? '') && body[k + 1]?.value !== '__VA_OPT__') {
      errors.push({ message: `'#' in macro '${name}' must be followed by a parameter.`, line, type: 'syntax' });
      return null;
    }
  }
  return { name, macro: { kind: 'function', params, variadic, body } };
}

function sameMacro(a: Macro, b: Macro): boolean {
  const spell = (m: Macro) => m.body.map((t) => `${t.space ? ' ' : ''}${t.value}`).join('').trim();
  if (a.kind !== b.kind || spell(a) !== spell(b)) return false;
  return a.kind === 'object' || (b.kind === 'function' && a.variadic === b.variadic && a.params.join() === b.params.join());
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
      value = evaluateConstExpr(expandMacros(tokenize(text), result.macros, result.errors, line), { context: '#pragma pack' });
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
  const isNumberish = (p: string) => !/^[A-Za-z_]\w*$/.test(p) || result.macros.has(p);

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

// ------------------------------------------------------------------ macro expansion

/** A token with its hide set: the macros it came out of, which it must not expand again. */
interface PPToken extends Token {
  hide: ReadonlySet<string>;
}

class ExpansionError extends Error {}

/** More than this many tokens out of one expansion is a runaway macro, not a header. */
const MAX_EXPANDED_TOKENS = 1_000_000;

/**
 * Expand every macro in `tokens`, as C11 6.10.3 specifies, by Prosser's algorithm: each token
 * carries the set of macros it was produced by, and a macro name in its own set is not expanded
 * again (6.10.3.4p2). A function-like macro is invoked only when '(' follows its name. Arguments
 * are fully expanded before substitution, except as operands of `#` and `##`.
 *
 * Errors (a wrong argument count, an unterminated invocation, an invalid paste) are added to
 * `errors`, at `line` if given, else at the macro name's line; expanded tokens take the line of
 * the macro name they came from.
 */
export function expandMacros(
  tokens: readonly Token[],
  macros: ReadonlyMap<string, Macro>,
  errors: ParseError[],
  line?: number,
): Token[] {
  const expander = new Expander(macros, line);
  try {
    return expander.expand(tokens.map((t) => ({ ...t, hide: NO_HIDE }))).map(({ hide: _hide, ...t }) => t);
  } catch (err) {
    if (!(err instanceof ExpansionError)) throw err;
    errors.push({ message: err.message, line: expander.errorLine ?? line, type: 'syntax' });
    return tokens.slice();
  }
}

const NO_HIDE: ReadonlySet<string> = new Set();

class Expander {
  private produced = 0;
  private counter = 0;
  errorLine: number | undefined;

  constructor(
    private readonly macros: ReadonlyMap<string, Macro>,
    private readonly lineOverride: number | undefined,
  ) {}

  private fail(message: string, line: number): never {
    this.errorLine = line;
    throw new ExpansionError(message);
  }

  /** Expand a token list to the end. */
  expand(input: PPToken[]): PPToken[] {
    // Tokens still to scan, last one first, so an expansion is pushed back in front cheaply.
    const pending = input.slice().reverse();
    const out: PPToken[] = [];
    while (pending.length > 0) {
      const t = pending.pop()!;
      const macro = t.kind === 'id' && !t.hide.has(t.value) ? this.macros.get(t.value) : undefined;
      const line = this.lineOverride ?? t.line;

      if (t.kind === 'id' && !t.hide.has(t.value) && (t.value === '__LINE__' || t.value === '__COUNTER__') && !macro) {
        const value = t.value === '__LINE__' ? line : this.counter++;
        out.push({ kind: 'num', value: String(value), line, hide: t.hide, ...(t.space && { space: true }) });
        continue;
      }
      if (!macro) {
        out.push(t);
        continue;
      }

      let replacement: PPToken[];
      if (macro.kind === 'object') {
        replacement = this.subst(macro.body, [], [], union(t.hide, t.value), line, false);
      } else {
        if (pending[pending.length - 1]?.value !== '(') {
          // A function-like macro name without '(' is an ordinary identifier.
          out.push(t);
          continue;
        }
        const { args, close } = this.collectArgs(pending, t.value, line);
        const actuals = this.matchArgs(macro, args, t.value, line);
        // The hide set of the invocation: what the name and the ')' share, plus the macro itself.
        const hide = union(intersect(t.hide, close.hide), t.value);
        replacement = this.subst(macro.body, macro.params, actuals, hide, line, macro.variadic);
      }
      this.produced += replacement.length;
      if (this.produced > MAX_EXPANDED_TOKENS) this.fail(`Expanding macro '${t.value}' produces more than ${MAX_EXPANDED_TOKENS} tokens.`, line);
      // The replacement stands where the invocation stood, so it is spaced as the invocation was.
      if (replacement[0]) {
        const { space: _space, ...first } = replacement[0];
        replacement[0] = t.space ? { ...first, space: true } : first;
      }
      for (let k = replacement.length - 1; k >= 0; k--) pending.push(replacement[k]);
    }
    return out;
  }

  /** The arguments of an invocation whose '(' is next in `pending`, split at top-level commas. */
  private collectArgs(pending: PPToken[], name: string, line: number): { args: PPToken[][]; close: PPToken } {
    pending.pop(); // '('
    const args: PPToken[][] = [[]];
    let depth = 0;
    while (pending.length > 0) {
      const t = pending.pop()!;
      if (t.kind === 'punct' && t.value === ')' && depth === 0) return { args, close: t };
      if (t.kind === 'punct' && t.value === '(') depth += 1;
      if (t.kind === 'punct' && t.value === ')') depth -= 1;
      if (t.kind === 'punct' && t.value === ',' && depth === 0) args.push([]);
      else args[args.length - 1].push(t);
    }
    return this.fail(`Unterminated invocation of macro '${name}': missing ')'.`, line);
  }

  /** One token list per parameter; a variadic macro's extra arguments go, commas included, into the last. */
  private matchArgs(macro: Extract<Macro, { kind: 'function' }>, args: PPToken[][], name: string, line: number): PPToken[][] {
    const fixed = macro.variadic ? macro.params.length - 1 : macro.params.length;
    // `F()` passes one empty argument, which is no argument for a macro without parameters.
    if (macro.params.length === 0 && args.length === 1 && args[0].length === 0) return [];
    if (macro.variadic) {
      if (args.length < fixed) {
        this.fail(`Macro '${name}' needs at least ${fixed} argument${fixed === 1 ? '' : 's'}, but ${args.length} ${args.length === 1 ? 'was' : 'were'} given.`, line);
      }
      const rest = args.slice(fixed);
      const variadic = rest.flatMap((a, k) => (k === 0 ? a : [{ kind: 'punct' as const, value: ',', line, hide: NO_HIDE }, ...a]));
      return [...args.slice(0, fixed), variadic];
    }
    if (args.length !== fixed) {
      this.fail(`Macro '${name}' takes ${fixed} argument${fixed === 1 ? '' : 's'}, but ${args.length} ${args.length === 1 ? 'was' : 'were'} given.`, line);
    }
    return args;
  }

  /**
   * The replacement list with parameters substituted (Prosser's subst): `#p` stringizes p's
   * argument as written; an operand of `##` is the argument as written and is pasted to its
   * neighbour; any other parameter is replaced by its fully expanded argument.
   */
  private subst(body: readonly Token[], params: readonly string[], actuals: PPToken[][], hide: ReadonlySet<string>, line: number, variadic: boolean): PPToken[] {
    const out: PPToken[] = [];
    const paramIndex = (t: Token | undefined) => (t?.kind === 'id' ? params.indexOf(t.value) : -1);
    const vaIndex = variadic ? params.length - 1 : -1;
    const at = (t: Token): PPToken => ({ kind: t.kind, value: t.value, line, hide, ...(t.space && { space: true }) });
    const asWritten = (k: number) => actuals[k].map((t) => ({ ...t, line, hide }));

    for (let k = 0; k < body.length; k++) {
      const t = body[k];
      const next = body[k + 1];

      if (variadic && t.kind === 'id' && t.value === '__VA_OPT__' && next?.value === '(') {
        // C23 / C++20: the parenthesized tokens, only when the variable arguments are not empty.
        const close = findClosing(body, k + 1);
        if (close === -1) this.fail("Missing ')' after __VA_OPT__.", line);
        if (this.expand(asWritten(vaIndex)).length > 0) {
          out.push(...this.subst(body.slice(k + 2, close), params, actuals, hide, line, variadic));
        }
        k = close;
        continue;
      }
      if (t.kind === 'punct' && t.value === '#' && paramIndex(next) >= 0) {
        out.push({ kind: 'str', value: stringize(actuals[paramIndex(next)]), line, hide, ...(t.space && { space: true }) });
        k += 1;
        continue;
      }
      if (t.kind === 'punct' && t.value === '##') {
        const p = paramIndex(next);
        k += 1;
        if (p >= 0) {
          const arg = asWritten(p);
          // GNU: `, ## __VA_ARGS__` drops the comma when there are no variable arguments, and
          // otherwise does not paste.
          if (p === vaIndex && out[out.length - 1]?.value === ',') {
            if (arg.length === 0) out.pop();
            else out.push(...arg);
            continue;
          }
          if (arg.length > 0) this.glue(out, arg, line);
          continue;
        }
        this.glue(out, [at(next)], line);
        continue;
      }
      const p = paramIndex(t);
      if (p >= 0 && next?.kind === 'punct' && next.value === '##') {
        const arg = asWritten(p);
        if (arg.length > 0) {
          out.push(...arg);
          continue;
        }
        // An empty left operand: the right one stands alone, as written if it is a parameter.
        const q = paramIndex(body[k + 2]);
        if (q >= 0) {
          out.push(...asWritten(q));
          k += 2;
        } else {
          k += 1;
        }
        continue;
      }
      if (p >= 0) {
        const expanded = this.expand(actuals[p].map((a) => ({ ...a, line })));
        expanded.forEach((e, n) => out.push({ ...e, line, ...(n === 0 && t.space && { space: true }) }));
        continue;
      }
      out.push(at(t));
    }
    // Everything the replacement produced is hidden from the macros that produced it.
    return out.map((o) => ({ ...o, hide: o.hide === hide ? hide : union(o.hide, ...hide) }));
  }

  /** Paste the last token of `out` and the first of `right` into one token (6.10.3.3). */
  private glue(out: PPToken[], right: PPToken[], line: number): void {
    const left = out.pop();
    if (!left) {
      out.push(...right);
      return;
    }
    const spelled = left.value + right[0].value;
    const pasted = tokenize(spelled);
    if (pasted.length !== 1) {
      this.fail(`Pasting '${left.value}' and '${right[0].value}' does not give a valid token.`, line);
    }
    out.push({ kind: pasted[0].kind, value: pasted[0].value, line, hide: intersect(left.hide, right[0].hide), ...(left.space && { space: true }) });
    out.push(...right.slice(1));
  }
}

/** `#arg`: the argument's spelling as a string literal, one space where it had whitespace. */
function stringize(arg: readonly Token[]): string {
  const text = arg
    .map((t, k) => {
      const spelled = t.kind === 'str' || t.kind === 'char' ? t.value.replace(/[\\"]/g, '\\$&') : t.value;
      return k > 0 && t.space ? ` ${spelled}` : spelled;
    })
    .join('');
  return `"${text}"`;
}

function union(set: ReadonlySet<string>, ...names: string[]): ReadonlySet<string> {
  if (names.every((n) => set.has(n))) return set;
  return new Set([...set, ...names]);
}

function intersect(a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> {
  if (a.size === 0 || b.size === 0) return NO_HIDE;
  return new Set([...a].filter((n) => b.has(n)));
}
