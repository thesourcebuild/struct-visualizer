import { TOOL_MANIFESTS, loadTool } from "@sp/registry";
import type { AnyToolDefinition } from "@sp/engine";

/**
 * Loaded tool definitions, kept for the life of the page.
 *
 * `loadTool` is an async `import()`, so a component that awaits it renders at least one frame
 * without the tool -- just a header -- and then the editor, settings and results pop in. That
 * was the flash and layout jump on every sidebar click. With the definition cached, the
 * workbench can initialise synchronously and a tool switch is a single render.
 */
const cache = new Map<string, AnyToolDefinition>();
const pending = new Map<string, Promise<AnyToolDefinition>>();

export function cachedTool(id: string): AnyToolDefinition | undefined {
  return cache.get(id);
}

export function loadToolCached(id: string): Promise<AnyToolDefinition> {
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit);
  let p = pending.get(id);
  if (!p) {
    p = loadTool(id).then((t) => {
      cache.set(id, t);
      pending.delete(id);
      return t;
    });
    pending.set(id, p);
  }
  return p;
}

/**
 * Warm every tool once the shell is idle. The definitions share one lazily loaded chunk, so
 * this is a single small download, and it means the first click on any tool is instant too.
 */
export function preloadAllTools(): void {
  for (const m of TOOL_MANIFESTS) {
    loadToolCached(m.id).catch(() => {
      // A failed preload is retried, with its error shown, when the tool is actually opened.
      pending.delete(m.id);
    });
  }
}
