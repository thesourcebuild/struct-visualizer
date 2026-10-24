"use client";

import { useState } from "react";
import { platform } from "@sp/platform";
import { TOOL_MANIFESTS } from "@sp/registry";
import { Button, Dialog, cn } from "@sp/ui";
import { APP_VERSION, GITHUB_URL, SITE_TITLE } from "@/lib/constants";
import { useTheme } from "../use-theme";
import type { ThemePreference } from "../theme-constants";

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export function SettingsOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { preference, setPreference } = useTheme();
  const [cleared, setCleared] = useState(false);

  const resetSaved = () => {
    const p = platform();
    for (const key of ["input", "input:go", "input:rust", "input:zig", "lastTool", "sidebar:collapsedFamilies", "sidebar:language"]) {
      p.removeSavedState(key);
    }
    for (const m of TOOL_MANIFESTS) p.removeSavedState(`spec:${m.id}`);
    setCleared(true);
  };

  return (
    <Dialog open={open} onClose={onClose} title="Settings">
      <div className="space-y-6">
        <section>
          <h3 className="mb-2 text-sm font-semibold">Appearance</h3>
          <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-lg border border-gray-300 p-0.5 dark:border-gray-600">
            {THEMES.map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={preference === t.value}
                onClick={() => setPreference(t.value)}
                className={cn(
                  "rounded-md px-3 py-1 text-sm",
                  preference === t.value
                    ? "bg-blue-600 text-white"
                    : "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3 className="mb-1 text-sm font-semibold">Saved state</h3>
          <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
            Your last tool, the editor contents for each language and per-tool options are kept in this browser only.
          </p>
          <Button onClick={resetSaved} disabled={cleared}>
            {cleared ? "Cleared — reload to start fresh" : "Clear saved state"}
          </Button>
        </section>

        <section>
          <h3 className="mb-2 text-sm font-semibold">About</h3>
          {/* An About box says what the thing is first, then the facts about this copy. */}
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{SITE_TITLE}</p>
          <p className="mt-0.5 text-xs text-gray-600 dark:text-gray-400">
            Shows how C/C++, Go, Rust and Zig types are laid out in memory: every offset, the padding between fields,
            alignment, and the field order that wastes the least space.
          </p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-gray-500 dark:text-gray-400">Version</dt>
            <dd className="font-mono text-gray-900 dark:text-gray-100">{APP_VERSION}</dd>
            <dt className="text-gray-500 dark:text-gray-400">Checked against</dt>
            <dd className="text-gray-900 dark:text-gray-100">GCC, MSVC, the Go compiler, rustc and zig, by the test suite</dd>
            <dt className="text-gray-500 dark:text-gray-400">Privacy</dt>
            <dd className="text-gray-900 dark:text-gray-100">
              Runs entirely in this page. Nothing you type is uploaded; a share link holds only what is on screen.
            </dd>
            {GITHUB_URL && (
              <>
                <dt className="text-gray-500 dark:text-gray-400">Source</dt>
                <dd>
                  <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">
                    {GITHUB_URL.replace(/^https?:\/\//, "")}
                  </a>
                </dd>
              </>
            )}
          </dl>
        </section>
      </div>
    </Dialog>
  );
}
