#!/usr/bin/env bash
# Builds everything, optionally behind the full quality gate.
#
# The Linux and macOS counterpart of build_all.ps1. There is no desktop bundle or installer:
# the web static export is the whole deliverable.
#
# Usage: scripts/build-helpers/build_all.sh [--clean] [--verify] [--smoke] [--base-path /repo]

set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../lib/common.sh"

clean=0
verify=0
smoke=0
base_path=""
while (($#)); do
  case "$1" in
    --) shift ;;
    --clean) clean=1; shift ;;
    --verify) verify=1; shift ;;
    --smoke) smoke=1; shift ;;
    --base-path) base_path="${2:?--base-path needs a path like /repo}"; shift 2 ;;
    --base-path=*) base_path="${1#*=}"; shift ;;
    -h | --help)
      printf 'usage: %s [--clean] [--verify] [--smoke] [--base-path /repo]\n' "$0"
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

root="$(repo_root)"
assert_dependencies "$root"
disable_msys_path_conversion

if ((verify)); then
  # First because it is instant, and because a script that does not parse makes every other step
  # here unreachable.
  write_step 'Checking the scripts are ASCII and parse'
  bash "$here/../check_scripts.sh"

  write_step 'Checking every manifest agrees with the version file'
  bash "$here/../package/sync_version.sh" --check

  write_step 'Typechecking every package and tests/'
  invoke_pnpm typecheck

  write_step 'Linting'
  invoke_pnpm lint

  write_step 'Running tests'
  invoke_pnpm test

  write_ok 'Gate passed.'
fi

if ((clean)); then
  write_step 'Cleaning previous output'
  remove_build_output "$root"
fi

if [[ -n "$base_path" ]]; then
  [[ "$base_path" == /* ]] || die "--base-path must start with a slash, e.g. /$base_path"
  export NEXT_PUBLIC_BASE_PATH="${base_path%/}"
  write_note "NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH"
fi

write_step 'Building every package and the web export'
turbo_args=(run build)
((clean)) && turbo_args+=(--force)
invoke_pnpm exec turbo "${turbo_args[@]}"

show_artifacts "$root" "apps/web/out"

if ((smoke)); then
  write_step 'Checking the export has every page'
  out="$root/apps/web/out"
  for required in index.html tools/index.html sitemap.xml robots.txt 404.html; do
    [[ -f "$out/$required" ]] || die "The export is missing $required"
  done
  # One static page per tool, from generateStaticParams over the registry.
  pages=()
  for dir in "$out"/tools/*/; do
    [[ -f "$dir/index.html" ]] && pages+=("$(basename -- "$dir")")
  done
  ((${#pages[@]} > 0)) || die 'The export has no /tools/<id>/ pages.'
  write_note "tool pages: ${pages[*]}"
  write_ok 'Smoke check passed.'
fi
