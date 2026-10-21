"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { THEME_STORAGE_KEY } from "./theme-constants";
import type { ThemePreference } from "./theme-constants";

const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : "system";
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Switch the theme in a single frame. Controls with `transition-colors` would otherwise fade
 * for 150 ms while everything around them switches at once, so for several frames the page is
 * half light, half dark. Transitions are suspended for the switch: the class flips, a style
 * flush applies the new colours immediately, and transitions come back for hover effects.
 */
function apply(pref: ThemePreference): void {
  const dark = pref === "dark" || (pref === "system" && systemPrefersDark());
  const root = document.documentElement;
  if (root.classList.contains("dark") === dark) return;
  const freeze = document.createElement("style");
  freeze.textContent = "*,*::before,*::after{transition:none!important}";
  document.head.appendChild(freeze);
  root.classList.toggle("dark", dark);
  // Reading a computed style forces the new styles to apply while transitions are off.
  void window.getComputedStyle(root).colorScheme;
  requestAnimationFrame(() => requestAnimationFrame(() => freeze.remove()));
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Light/Dark/System preference, persisted and applied to <html class="dark">. */
export function useTheme(): {
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
} {
  const preference = useSyncExternalStore(subscribe, readPreference, () => "system" as const);

  const setPreference = useCallback((p: ThemePreference) => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(p));
    } catch {
      // storage unavailable: still apply for this session
    }
    apply(p);
    for (const l of listeners) l();
  }, []);

  // Follow OS changes while on "system".
  useEffect(() => {
    if (preference !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [preference]);

  return { preference, setPreference };
}
