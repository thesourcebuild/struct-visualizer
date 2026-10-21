# Scripts

Run everything from the repo root.

| Command | What it does |
|---|---|
| `pnpm install` | Install all workspace packages. |
| `pnpm web` | Next dev server for `apps/web` (http://localhost:3000). |
| `pnpm dev` | Same, through turbo. |
| `pnpm test` | vitest, run once: everything under `tests/`. |
| `pnpm test:watch` | vitest in watch mode. |
| `pnpm test:print` | Golden suite with every layout printed (`PRINT_LAYOUTS=1`). |
| `pnpm typecheck` | `tsc --noEmit` in every package (turbo), then the `tests/` project. |
| `pnpm lint` | ESLint over the whole repo. |
| `pnpm format` / `pnpm format:check` | Prettier write / check. |
| `pnpm build` | typecheck, lint, then `turbo run build` (static export to `apps/web/out`). |
| `pnpm build:pages` | Only the web static export. Set `NEXT_PUBLIC_BASE_PATH=/<repo>` for a GitHub Pages project site. |

## Script wrappers (`scripts/`)

Every script comes as a triplet: a `.bat` that forwards to a `.ps1` (Windows) and a `.sh` (Linux, macOS, Git Bash). The shared helpers live in `scripts/lib/common.{ps1,sh}`. Windows flags are PowerShell-style (`-Clean`); shell flags are long options (`--clean`). There is no `--` separator on the Windows side.

| Windows | Linux / macOS | What it does |
|---|---|---|
| `pnpm win:web` | `pnpm sh:web` | Start the dev server and open `/tools/` (`-Port` / `--port`). |
| `pnpm win:build:web` | `pnpm sh:build:web` | Static export. Options: `-Clean`, `-BasePath /repo`, `-Serve`, `-Port`. |
| `pnpm win:build` | `pnpm sh:build` | Build every package. Options: `-Clean`, `-Verify`, `-Smoke`, `-BasePath`. |
| `pnpm win:verify` | `pnpm sh:verify` | The full gate (script check, version check, typecheck, lint, test), then build and smoke-check the export. |
| `pnpm win:version` | `pnpm sh:version` | Sync every `package.json` to the `version` file. `-Set 0.2.0` bumps, `-Check` only reports. |
| `pnpm win:clean` | `pnpm sh:clean` | Delete the local caches and build output (`.next`, `out`, `.turbo`, `*.tsbuildinfo`) and report the space freed. `-DryRun` / `--dry-run` only lists; `-All` / `--all` also removes `node_modules`. Stop `pnpm web` first. |
| `pnpm win:check` | `pnpm sh:check` | Every script is ASCII, uses the right line endings, and parses (PowerShell 5.1 included). |

## Environment variables (web)

| Variable | Used for | Default |
|---|---|---|
| `NEXT_PUBLIC_BASE_PATH` | Sub-path the site is served from (`/<repo>` on GitHub Pages). | empty |
| `NEXT_PUBLIC_SITE_URL` | Canonical origin for metadata, sitemap and robots. | `https://struct-padding.dev` |
| `NEXT_PUBLIC_GITHUB_URL` | Header and settings "source" link. | `https://github.com` |

`NEXT_PUBLIC_APP_VERSION` is filled in from the root `version` file by `next.config.ts`; don't set it by hand.

## Serving the export locally

```bash
NEXT_PUBLIC_BASE_PATH=/struct_padding_calculator pnpm build:pages
# serve apps/web/out so that /struct_padding_calculator/ maps to it, e.g.:
mkdir -p /tmp/site && cp -r apps/web/out /tmp/site/struct_padding_calculator
npx serve /tmp/site
```
