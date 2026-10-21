import type { PlatformApi } from "@sp/contracts";

const PREFIX = "structpadding:";

function storage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    // Private mode / blocked site data.
    return undefined;
  }
}

export const webPlatform: PlatformApi = {
  kind: "web",

  readSavedState<T>(key: string): T | undefined {
    try {
      const raw = storage()?.getItem(PREFIX + key);
      return raw == null ? undefined : (JSON.parse(raw) as T);
    } catch {
      return undefined;
    }
  },

  writeSavedState<T>(key: string, value: T): void {
    try {
      storage()?.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      // Quota exceeded or storage unavailable: persistence is best-effort.
    }
  },

  removeSavedState(key: string): void {
    try {
      storage()?.removeItem(PREFIX + key);
    } catch {
      // ignore
    }
  },

  saveFile(filename: string, data: Blob | string, mimeType = "text/plain"): void {
    const blob = typeof data === "string" ? new Blob([data], { type: mimeType }) : data;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};
