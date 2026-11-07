/**
 * Share links: the whole workbench state as base64url JSON in the URL fragment
 * (`#s=...`). The fragment never reaches a server, and static hosting needs no routes.
 */
export const SHARE_VERSION = 1;
/** Inputs longer than this are left out so links stay pasteable. */
export const MAX_SHARED_INPUT = 8192;

export interface SharePayload {
  v: number;
  /** Tool id. */
  t: string;
  /** Spec options. */
  o: Record<string, string | number | boolean>;
  /** Input source, omitted when too long or when the tool reads no input. */
  i?: string;
}

export interface ShareState {
  toolId: string;
  options: Record<string, string | number | boolean>;
  input?: string;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeShareState(state: ShareState): { hash: string; inputOmitted: boolean } {
  const payload: SharePayload = { v: SHARE_VERSION, t: state.toolId, o: state.options };
  const inputOmitted = state.input !== undefined && state.input.length > MAX_SHARED_INPUT;
  if (state.input !== undefined && !inputOmitted) payload.i = state.input;
  return { hash: `#s=${toBase64Url(JSON.stringify(payload))}`, inputOmitted };
}

/** A value a spec option can hold: a string, a boolean or a finite number (JSON parses 1e400 as Infinity). */
function isOptionValue(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}

/**
 * The options in an untrusted JSON object (a share link, saved state), each checked on its own:
 * a value no option can hold is left out and the rest are kept.
 */
export function readOptionValues(raw: unknown): Record<string, string | number | boolean> {
  const options: Record<string, string | number | boolean> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return options;
  for (const [k, v] of Object.entries(raw)) {
    if (isOptionValue(v)) options[k] = v;
  }
  return options;
}

/** Parse a `#s=...` fragment. Returns undefined for anything malformed. */
export function parseShareHash(hash: string): ShareState | undefined {
  const match = /^#?s=([A-Za-z0-9_-]+)$/.exec(hash.trim());
  if (!match) return undefined;
  try {
    const raw: unknown = JSON.parse(fromBase64Url(match[1]!));
    if (!raw || typeof raw !== "object") return undefined;
    const p = raw as Partial<SharePayload>;
    if (p.v !== SHARE_VERSION || typeof p.t !== "string" || !p.o || typeof p.o !== "object") {
      return undefined;
    }
    return {
      toolId: p.t,
      options: readOptionValues(p.o),
      input: typeof p.i === "string" ? p.i : undefined,
    };
  } catch {
    return undefined;
  }
}
