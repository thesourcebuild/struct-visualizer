#!/usr/bin/env bash
# Deletes the caches and build output that pile up locally, and reports the space freed.
#
# The Linux and macOS counterpart of clean.ps1. Everything removed is regenerated on demand and
# ignored by git: apps/web/.next (Next.js dev and build caches), apps/web/out (the static export),
# .turbo folders (Turborepo's task cache, which never prunes) and *.tsbuildinfo files. The next dev
# start or build is slower, because it starts from nothing.
#
# Usage:
#   scripts/build-helpers/clean.sh            remove the caches and build output
#   scripts/build-helpers/clean.sh --dry-run  list what would go, with sizes; delete nothing
#   scripts/build-helpers/clean.sh --all      also remove node_modules (then run pnpm install)
#
# Stop `pnpm web` first: the dev server writes to apps/web/.next while it runs.

set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)"
. "$here/../lib/common.sh"

all=0
dry_run=0
while (($#)); do
  case "$1" in
    --) shift ;;
    --all) all=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h | --help) printf 'usage: %s [--all] [--dry-run]\n' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

root="$(repo_root)"

# Explicit folders rather than a search for every `out` or `.next`: a name match alone could
# reach something that is not ours to delete.
patterns=(
  "apps/web/.next" "apps/web/out"
  ".turbo" apps/*/.turbo packages/*/.turbo packages/tools/*/.turbo
  apps/*/*.tsbuildinfo packages/*/*.tsbuildinfo packages/tools/*/*.tsbuildinfo
)
if ((all)); then
  patterns+=("node_modules" apps/*/node_modules packages/*/node_modules packages/tools/*/node_modules)
fi

targets=()
cd "$root"
shopt -s nullglob dotglob
for pattern in "${patterns[@]}"; do
  for match in $pattern; do
    [[ -e "$match" ]] && targets+=("$match")
  done
done
shopt -u nullglob dotglob

if ((${#targets[@]} == 0)); then
  write_step 'nothing to clean'
  exit 0
fi

if ((!dry_run)) && test_port_open 3000; then
  write_warn 'port 3000 is in use: if that is `pnpm web`, stop it first'
fi

# Sizes in KiB from du -sk, which every du supports (GNU and BSD).
kib() { du -sk -- "$1" 2>/dev/null | cut -f1; }

if ((dry_run)); then write_step 'would remove'; else write_step 'removing'; fi
freed=0
for target in "${targets[@]}"; do
  size="$(kib "$target")"
  write_note "$(printf '%-40s %9s MB' "$target" "$(awk -v k="$size" 'BEGIN { printf "%.1f", k / 1024 }')")"
  if ((dry_run)); then
    freed=$((freed + size))
    continue
  fi
  rm -rf -- "$target" || true
  if [[ -e "$target" ]]; then
    freed=$((freed + size - $(kib "$target")))
    write_warn "could not fully remove $target (something is holding a file open)"
  else
    freed=$((freed + size))
  fi
done

if ((dry_run)); then verb='would free'; else verb='freed'; fi
write_ok "$(printf '\n%s %s MB' "$verb" "$(awk -v k="$freed" 'BEGIN { printf "%.1f", k / 1024 }')")"
if ((all && !dry_run)); then
  write_note 'run `pnpm install` before the next build'
fi
