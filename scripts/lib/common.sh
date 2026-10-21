#!/usr/bin/env bash
# Shared helpers for the Linux and macOS scripts, mirroring scripts/lib/common.ps1.
#
# Adapted from cipherworkbench's scripts/lib/common.sh, trimmed to what a web-only project
# needs (no Electron, installers or release archives). The function names are the PowerShell
# ones in snake_case -- write_step for Write-Step, project_version for Get-ProjectVersion --
# because the two files get read side by side and a helper doing the same job under a
# different name is a tax on every future edit to either.
#
# Two rules for anything added here.
#
# Pure ASCII, like the PowerShell half. These files are read on machines with unknown locales,
# and a UTF-8 em-dash in a message is one more thing that can render as garbage in a terminal
# set to something else. Use -- and ... . check_scripts.sh enforces it.
#
# Quote every path. An unquoted $root in a command substitution or a [[ ]] test will split or
# glob on a path containing spaces or parentheses and fail somewhere far from the mistake.

set -euo pipefail

# ------------------------------------------------------------------ presentation

# Colour only when stdout is a terminal. Piping to a file or a CI log should not collect escape
# codes, and `command -v tput` is checked because a minimal container may have no terminfo.
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  C_CYAN="$(tput setaf 6)"
  C_GREY="$(tput setaf 8 2>/dev/null || tput setaf 7)"
  C_YELLOW="$(tput setaf 3)"
  C_RED="$(tput setaf 1)"
  C_GREEN="$(tput setaf 2)"
  C_RESET="$(tput sgr0)"
else
  C_CYAN="" C_GREY="" C_YELLOW="" C_RED="" C_GREEN="" C_RESET=""
fi

write_step() { printf '\n%s==> %s%s\n' "$C_CYAN" "$1" "$C_RESET"; }
write_note() { printf '%s    %s%s\n' "$C_GREY" "$1" "$C_RESET"; }
write_warn() { printf '%s !! %s%s\n' "$C_YELLOW" "$1" "$C_RESET" >&2; }
write_ok() { printf '%s%s%s\n' "$C_GREEN" "$1" "$C_RESET"; }

# Every failure path goes through here, so a message and a non-zero exit cannot come apart.
die() {
  printf '\n%sERROR: %s%s\n' "$C_RED" "$1" "$C_RESET" >&2
  exit 1
}

# ------------------------------------------------------------------ the repo

# Two levels up from scripts/lib, which is what makes this correct from any working directory.
repo_root() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "$here/../.." && pwd
}

assert_dependencies() {
  local root="$1"
  command -v node >/dev/null 2>&1 || die 'node is not on PATH. Install Node 20 or newer.'
  command -v pnpm >/dev/null 2>&1 ||
    die 'pnpm is not on PATH. Install it with: npm install -g pnpm@12 (or: corepack enable)'
  [[ -d "$root/node_modules" ]] ||
    die "Dependencies are not installed. Run: pnpm install --dir '$root'"
}

# pnpm, run from the repo root whatever the caller's directory. `--dir` rather than a `cd`, so a
# failure leaves the caller where it was.
invoke_pnpm() {
  local root
  root="$(repo_root)"
  pnpm --dir "$root" "$@"
}

# Git Bash on Windows rewrites any argument or environment value that looks like a POSIX path
# into a Windows one -- so NEXT_PUBLIC_BASE_PATH=/repo reaches Next as "C:/Program Files/Git/repo"
# and the build dies with "basePath has to start with a /". Exporting this switches that off for
# every child process. It is a no-op on Linux and macOS.
disable_msys_path_conversion() {
  export MSYS_NO_PATHCONV=1
  export MSYS2_ARG_CONV_EXCL='*'
}

# ------------------------------------------------------------------ ports

# Three probes, because none of them is everywhere: `ss` on modern Linux, `lsof` on macOS and
# older distributions, and bash's own /dev/tcp as the fallback that needs nothing installed.
test_port_open() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -qE "[:.]${port}[[:space:]]" && return 0
    return 1
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN -n -P >/dev/null 2>&1 && return 0
    return 1
  fi
  (exec 3<>"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1 && return 0
  return 1
}

# ------------------------------------------------------------------ build output

remove_build_output() {
  local root="$1"
  local targets=("apps/web/out" "apps/web/.next" ".turbo" "apps/web/.turbo")
  local target
  for target in "${targets[@]}"; do
    if [[ -e "$root/$target" ]]; then
      write_note "removing $target"
      rm -rf -- "$root/$target"
    fi
  done
}

path_size() {
  local target="$1"
  [[ -e "$target" ]] || { printf 'missing'; return; }
  du -sh -- "$target" 2>/dev/null | cut -f1 | tr -d '[:space:]'
}

show_artifacts() {
  local root="$1"
  shift
  write_step 'Artifacts'
  local rel full
  for rel in "$@"; do
    full="$root/$rel"
    if [[ -e "$full" ]]; then
      printf '  %-34s %s\n' "$rel" "$(path_size "$full")"
    else
      write_warn "$rel is missing"
    fi
  done
}

# Serves apps/web/out the way the deployed site sees it. With a base path the export only works
# under /<base>/, so it is staged into a temporary tree at that sub-path rather than served from
# the root, where every asset URL would 404.
serve_export() {
  local root="$1" port="$2" base_path="${3:-}"
  local dir="$root/apps/web/out"
  if [[ -n "$base_path" ]]; then
    local stage
    stage="$(mktemp -d)"
    mkdir -p -- "$stage$(dirname -- "$base_path")"
    cp -R -- "$dir" "$stage$base_path"
    dir="$stage"
    write_note "staged under $base_path -- open http://localhost:$port$base_path/"
  fi
  # npx rather than a tracked dependency: this is for eyeballing a build, not part of the product.
  npx --yes serve@14 "$dir" --listen "$port"
}

# ------------------------------------------------------------------ version

# The root `version` file is the single source of truth. Read with `head -1` and trimmed, so a
# trailing newline -- which that file deliberately has -- is not part of the value.
project_version() {
  local root="$1"
  local file="$root/version"
  [[ -f "$file" ]] || die "The version file is missing: $file"
  local value
  value="$(head -n 1 -- "$file" | tr -d '[:space:]')"
  [[ "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] ||
    die "The version file does not hold a semver version: '$value'"
  printf '%s' "$value"
}

# Every workspace manifest, which is the set sync_version walks.
manifest_paths() {
  local root="$1"
  printf '%s\n' "$root/package.json"
  local base dir
  for base in "apps" "packages" "packages/tools"; do
    [[ -d "$root/$base" ]] || continue
    for dir in "$root/$base"/*/; do
      # The trailing slash comes from the glob, so it is stripped rather than doubled.
      dir="${dir%/}"
      [[ -f "$dir/package.json" ]] && printf '%s\n' "$dir/package.json"
    done
  done
}

# Rewritten by regex on the raw text, anchored to a two-space-indented top-level field -- not
# through a JSON parse and re-serialise, which would reorder the keys and reformat every file.
# The PowerShell half does exactly the same for exactly that reason.
sync_package_json_versions() {
  local root="$1" version="$2" changed=0 file current
  while IFS= read -r file; do
    current="$(sed -n 's/^  "version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$file" | head -n 1)"
    if [[ -z "$current" ]]; then
      write_warn "${file#"$root"/} has no top-level version field"
      continue
    fi
    if [[ "$current" == "$version" ]]; then continue; fi
    # A temporary file then a move, so an interrupted run cannot leave a half-written manifest.
    sed "s/^\(  \"version\"[[:space:]]*:[[:space:]]*\"\)[^\"]*\(\"\)/\1$version\2/" \
      "$file" >"$file.tmp"
    mv -- "$file.tmp" "$file"
    write_note "set ${file#"$root"/} to $version" >&2
    changed=$((changed + 1))
  done < <(manifest_paths "$root")
  printf '%s' "$changed"
}

# ------------------------------------------------------------------ argument parsing

# A bare `--` is dropped rather than treated as a flag. pnpm forwards the separator to the script
# verbatim; here it can simply be ignored, so `pnpm sh:build:web --clean` and
# `pnpm sh:build:web -- --clean` both work.
is_separator() { [[ "$1" == "--" ]]; }
