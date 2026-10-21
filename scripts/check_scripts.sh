#!/usr/bin/env bash
# Checks every script under this folder is ASCII and parses.
#
# The Linux and macOS counterpart of check_scripts.ps1, adapted from cipherworkbench.
#
# ASCII is checked for *every* script here -- .sh, .ps1 and .bat alike -- because the rule applies
# to all of them and a byte scan needs no interpreter. PowerShell 5.1 decodes these BOM-less files
# in the console codepage, so a UTF-8 em-dash in a .ps1 breaks the whole file there; bash has no
# such trap, but a message full of replacement characters is still worth avoiding.
#
# Parsing is checked for what the host can parse: `bash -n` for the .sh files always, and the
# PowerShell files only if pwsh happens to be installed. This cannot stand in for the Windows
# check -- powershell.exe 5.1 exists only there.
#
# Exits non-zero on any failure, so build_all.sh can gate on it.

set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/lib/common.sh"

failures=0
label() { printf '%s' "${1#"$here"/}"; }

# ------------------------------------------------------------------ ASCII

printf '\n%s==> ASCII%s\n' "$C_CYAN" "$C_RESET"
while IFS= read -r -d '' file; do
  # A byte test, not a decode. Written as `[^[:space:] -~]` -- neither whitespace nor a printable
  # ASCII character -- because GNU grep does not interpret \x escapes in a basic expression, and
  # LC_ALL=C is what makes the bracket expression byte-oriented rather than locale-aware.
  count="$(LC_ALL=C grep -c '[^[:space:] -~]' -- "$file" || true)"
  if [[ -z "$count" || "$count" == "0" ]]; then
    write_note "ok    $(label "$file")"
    continue
  fi
  failures=$((failures + 1))
  printf '%s  FAIL  %s -- %s line(s) with non-ASCII bytes%s\n' \
    "$C_RED" "$(label "$file")" "$count" "$C_RESET"
  write_note '      Use -- for an em-dash and ... for an ellipsis.'
done < <(find "$here" -type f \( -name '*.sh' -o -name '*.ps1' -o -name '*.bat' \) -print0 | sort -z)

# ------------------------------------------------------------------ bash

printf '\n%s==> parse under bash%s\n' "$C_CYAN" "$C_RESET"
while IFS= read -r -d '' file; do
  if grep -q $'\r' -- "$file"; then
    failures=$((failures + 1))
    printf '%s  FAIL  %s has CRLF line endings%s\n' "$C_RED" "$(label "$file")" "$C_RESET"
  elif output="$(bash -n -- "$file" 2>&1)"; then
    write_note "ok    $(label "$file")"
  else
    failures=$((failures + 1))
    printf '%s  FAIL  %s -- %s%s\n' "$C_RED" "$(label "$file")" "$output" "$C_RESET"
  fi
done < <(find "$here" -type f -name '*.sh' -print0 | sort -z)

# Executable, because these are invoked by path. A .sh without the bit set fails with
# "Permission denied", which reads like a filesystem problem rather than a missing chmod. Windows
# filesystems have no such bit, so there the git index is what counts and this check is skipped.
if [[ "$(uname -s)" != MINGW* && "$(uname -s)" != MSYS* && "$(uname -s)" != CYGWIN* ]]; then
  printf '\n%s==> executable bit%s\n' "$C_CYAN" "$C_RESET"
  while IFS= read -r -d '' file; do
    if [[ -x "$file" ]]; then
      write_note "ok    $(label "$file")"
    else
      failures=$((failures + 1))
      printf '%s  FAIL  %s is not executable -- chmod +x it%s\n' "$C_RED" "$(label "$file")" "$C_RESET"
    fi
  done < <(find "$here" -type f -name '*.sh' -print0 | sort -z)
fi

# ------------------------------------------------------------------ PowerShell, if present

if command -v pwsh >/dev/null 2>&1; then
  printf '\n%s==> parse under pwsh%s\n' "$C_CYAN" "$C_RESET"
  while IFS= read -r -d '' file; do
    # `cygpath` where it exists, which is Git Bash on Windows: `find` yields a POSIX path there and
    # pwsh is a Windows binary that cannot resolve one.
    native="$file"
    if command -v cygpath >/dev/null 2>&1; then native="$(cygpath -w -- "$file")"; fi
    script="\$e = \$null; [void][System.Management.Automation.Language.Parser]::ParseFile('$native', [ref]\$null, [ref]\$e); if (\$e.Count) { 'FAIL ' + \$e[0].Message } else { 'ok' }"
    result="$(pwsh -NoProfile -Command "$script" 2>&1 | tr -d '\r' | tr '\n' ' ')"
    if [[ "$result" == ok* ]]; then
      write_note "ok    $(label "$file")"
    else
      failures=$((failures + 1))
      printf '%s  FAIL  %s -- %s%s\n' "$C_RED" "$(label "$file")" "$result" "$C_RESET"
    fi
  done < <(find "$here" -type f -name '*.ps1' -print0 | sort -z)
else
  printf '\n%s==> pwsh not installed, skipping the PowerShell parse%s\n' "$C_YELLOW" "$C_RESET"
  write_note 'Run pnpm win:check on Windows to cover those files under 5.1 as well.'
fi

printf '\n'
if ((failures > 0)); then
  printf '%s%s check(s) failed.%s\n' "$C_RED" "$failures" "$C_RESET"
  exit 1
fi
write_ok 'Scripts are ASCII and parse.'
