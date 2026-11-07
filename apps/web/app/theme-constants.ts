export type ThemePreference = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "structpadding:theme";

/**
 * Runs before hydration (inlined in <head>) so the page never flashes the wrong theme.
 * Kept dependency-free and tiny; mirrors readPreference() in use-theme.ts: a saved value that is
 * not "light" or "dark" (missing, unreadable, not JSON) is "system".
 */
export const THEME_INIT_SCRIPT = `(function(){var p;try{p=JSON.parse(localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)}))}catch(e){}try{var d=p==="dark"||(p!=="light"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;
