#!/usr/bin/env bash
# Starts the web app's dev server and opens the calculator in the default browser.
#
# The Linux and macOS counterpart of launch_web.ps1. Usage:
#   scripts/launch/launch_web.sh [--port 3000]

set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/../lib/common.sh"

port=3000
while (($#)); do
  case "$1" in
    --) shift ;;
    --port) port="${2:?--port needs a number}"; shift 2 ;;
    --port=*) port="${1#*=}"; shift ;;
    -h | --help) printf 'usage: %s [--port N]\n' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

root="$(repo_root)"
assert_dependencies "$root"

url="http://localhost:$port/tools/"

# xdg-open on Linux, open on macOS, start on Git Bash for Windows, and none in a container --
# where saying so and carrying on is better than failing a dev server over a browser.
open_browser() {
  local target="$1"
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$target" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then
    open "$target" >/dev/null 2>&1 &
  elif command -v cmd.exe >/dev/null 2>&1; then
    cmd.exe /c start "" "$target" >/dev/null 2>&1 &
  else
    write_note "no browser opener here; visit $target yourself"
  fi
}

if test_port_open "$port"; then
  write_warn "Something is already listening on port $port."
  write_note 'That is probably a dev server from an earlier run. Opening it anyway.'
  open_browser "$url"
  exit 0
fi

write_step "Starting the dev server on $url"
write_note 'The browser opens once the server is listening. Press Ctrl+C to stop.'

# Open the browser only once the server accepts connections. A browser does not retry a refused
# connection: opening it first showed ERR_CONNECTION_REFUSED whenever Next took longer to start
# than the browser took to load the page. Gives up after two minutes.
(
  for _ in $(seq 1 240); do
    if test_port_open "$port"; then
      open_browser "$url"
      exit 0
    fi
    sleep 0.5
  done
) &
opener=$!
trap 'kill "$opener" 2>/dev/null || true' EXIT

invoke_pnpm --filter @sp/web dev --port "$port"
