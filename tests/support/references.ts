import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Compiler references: what the real compilers answered for each case, recorded in
 * tests/references/<suite>.json, so that the engines are checked against compilers even where none
 * is installed. Only a compiler's answer is ever recorded, never the engine's.
 *
 * - With the compiler, a test compares the engine with the compiler, and the recording with the
 *   compiler: a recording that is missing or differs fails, so none outlives what it records.
 *   SP_RECORD_REFERENCES=1 writes the compilers' answers instead (the cases of a compiler that is
 *   not installed keep theirs).
 * - Without it, the test compares the engine with the recording.
 * - SP_USE_REFERENCES=1 compares with the recordings even where the compilers are installed.
 */
export type Answer<T> =
  /** The layout the compiler gave. */
  | { layout: T }
  /** The compiler refused the code. */
  | { rejected: string }
  /** The compiler took it, but its output does not show the layout. */
  | { unmeasurable: string };

export const recording = process.env.SP_RECORD_REFERENCES === "1";
export const useReferences = process.env.SP_USE_REFERENCES === "1" && !recording;

const ROOT = join(__dirname, "..", "references");

/** A short, stable digest of generated source, to tell whether a recording is about it. */
export const digest = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);

/** JSON with object keys sorted, so that key order does not count. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => x.localeCompare(y))) : v,
  );
}

/**
 * Whether two answers agree. A refusal is the same refusal whatever its wording, which changes
 * between compiler versions and names the generated file.
 */
function same<T>(a: Answer<T>, b: Answer<T>): boolean {
  if ("layout" in a && "layout" in b) return canonical(a.layout) === canonical(b.layout);
  return ("rejected" in a && "rejected" in b) || ("unmeasurable" in a && "unmeasurable" in b);
}

export class References<T> {
  private readonly file: string;
  private readonly stored: Map<string, Answer<T>>;
  private readonly answers = new Map<string, Answer<T>>();
  private readonly known = new Set<string>();

  constructor(suite: string) {
    this.file = join(ROOT, `${suite}.json`);
    const data = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Record<string, Answer<T>>) : {};
    this.stored = new Map(Object.entries(data));
  }

  /**
   * A case this suite has, declared where its test is defined: vitest defines the tests a filter
   * skips too, so a filtered recording keeps their answers and drops only the ones no test names.
   */
  declare(key: string): void {
    this.known.add(key);
  }

  /** What the compiler answered when it was recorded. */
  recorded(key: string): Answer<T> | undefined {
    return this.stored.get(key);
  }

  /**
   * The compiler's answer for a case: from the compiler when it ran (`now`), checked against the
   * recording, or else the recording. Throws when there is neither, or when they differ.
   */
  answer(key: string, now?: Answer<T>): Answer<T> {
    this.declare(key);
    const stored = this.stored.get(key);
    // The generated file's name is the case's index, which changes as cases are added.
    if (now && "rejected" in now) now = { rejected: now.rejected.replace(/\bcase_?\d+/g, "case") };
    if (now && "unmeasurable" in now) now = { unmeasurable: now.unmeasurable.replace(/\bcase_?\d+/g, "case") };
    const how = "Record the compilers' answers with SP_RECORD_REFERENCES=1 (with the compiler installed).";
    if (now) {
      this.answers.set(key, now);
      if (!recording) {
        if (!stored) throw new Error(`No reference recorded for '${key}'. ${how}`);
        if (!same(stored, now)) {
          throw new Error(`The reference for '${key}' is stale: recorded ${JSON.stringify(stored)}, the compiler says ${JSON.stringify(now)}. ${how}`);
        }
      }
      return now;
    }
    if (!stored) throw new Error(`No compiler here and no reference recorded for '${key}'. ${how}`);
    return stored;
  }

  /** Write the recordings, in record mode: new answers over the old, for the cases still named. */
  save(): void {
    if (!recording) return;
    const merged: Record<string, Answer<T>> = {};
    for (const key of [...this.known].sort()) {
      const value = this.answers.get(key) ?? this.stored.get(key);
      if (value) merged[key] = value;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    // One case per line, so a change reads as a diff of the cases it touches.
    const body = Object.entries(merged).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    writeFileSync(this.file, `{\n${body.join(",\n")}\n}\n`);
  }
}
