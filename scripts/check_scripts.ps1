<#
.SYNOPSIS
Checks every script under this folder, subfolders included, is ASCII and parses under both PowerShell versions.

.DESCRIPTION
Adapted from cipherworkbench's scripts/check_scripts.ps1.

The .bat wrappers prefer pwsh and fall back to the built-in powershell.exe, so a script that
only parses under PowerShell 7 works on the machine it was written on and breaks on one without
pwsh installed. Testing under 7 alone cannot catch that.

Two classes of problem:

  * Non-ASCII characters. These files carry no BOM, so 5.1 decodes them in the console codepage
    rather than as UTF-8. A UTF-8 em-dash is three bytes ending 0x94, which cp1252 maps to
    U+201D -- a right double quote, which PowerShell treats as a string delimiter. One em-dash in
    a comment therefore terminates a string early and the whole file fails to parse.
  * PS7-only syntax -- null-coalescing (??), ternaries (? :), and the like.

Exits non-zero on any failure, so `build_all.ps1` can gate on it.

.EXAMPLE
pnpm win:check
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# -Recurse, because the scripts live in lib/, launch/, build-helpers/ and package/. Without it
# this check silently narrows to the one file left at the top: itself.
$files = @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Recurse | Where-Object { $_.Extension -in '.ps1', '.bat', '.sh' } | Sort-Object FullName)
$failures = 0

# Shown instead of the bare name: two folders may hold a file of the same name, and a failure has to
# say which one.
function Get-ScriptLabel {
    param([Parameter(Mandatory)][string]$FullName)
    $prefix = $PSScriptRoot + [System.IO.Path]::DirectorySeparatorChar
    if ($FullName.StartsWith($prefix)) { return $FullName.Substring($prefix.Length) }
    return [System.IO.Path]::GetFileName($FullName)
}

Write-Host ''
Write-Host '==> ASCII' -ForegroundColor Cyan
foreach ($file in $files) {
    # Read as bytes, not as text: reading as text would decode the very characters being hunted.
    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
    $offenders = @($bytes | Where-Object { $_ -gt 0x7F })
    if ($offenders.Count -eq 0) {
        Write-Host ("  ok    {0}" -f (Get-ScriptLabel -FullName $file.FullName)) -ForegroundColor DarkGray
        continue
    }
    $failures++
    $hex = (($offenders | Select-Object -Unique | ForEach-Object { '0x{0:X2}' -f $_ }) -join ' ')
    Write-Host ("  FAIL  {0} -- {1} non-ASCII byte(s): {2}" -f (Get-ScriptLabel -FullName $file.FullName), $offenders.Count, $hex) -ForegroundColor Red
    Write-Host '        Use -- for an em-dash and ... for an ellipsis.' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '==> line endings of .sh files' -ForegroundColor Cyan
foreach ($file in $files | Where-Object { $_.Extension -eq '.sh' }) {
    # A CR in a shell script makes bash fail with "$'\r': command not found". .gitattributes
    # pins *.sh to LF; this catches an editor that rewrote one anyway.
    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
    if ($bytes -contains 0x0D) {
        $failures++
        Write-Host ("  FAIL  {0} has CRLF line endings" -f (Get-ScriptLabel -FullName $file.FullName)) -ForegroundColor Red
    } else {
        Write-Host ("  ok    {0}" -f (Get-ScriptLabel -FullName $file.FullName)) -ForegroundColor DarkGray
    }
}

foreach ($exe in @('pwsh', 'powershell')) {
    $resolved = Get-Command $exe -ErrorAction SilentlyContinue
    Write-Host ''
    if (-not $resolved) {
        Write-Host ("==> {0} not installed, skipping" -f $exe) -ForegroundColor DarkYellow
        continue
    }
    Write-Host ("==> parse under {0}" -f $exe) -ForegroundColor Cyan
    foreach ($file in $files | Where-Object { $_.Extension -eq '.ps1' }) {
        # Parsed in a child process of that shell, because the point is how *it* decodes the file.
        $command = "`$e = `$null; [void][System.Management.Automation.Language.Parser]::ParseFile('$($file.FullName)', [ref]`$null, [ref]`$e); if (`$e.Count) { 'FAIL ' + `$e[0].Message } else { 'ok' }"
        $result = (& $exe -NoProfile -Command $command 2>&1) -join ' '
        if ($result -like 'ok*') {
            Write-Host ("  ok    {0}" -f (Get-ScriptLabel -FullName $file.FullName)) -ForegroundColor DarkGray
        } else {
            $failures++
            Write-Host ("  {0}  {1}" -f (Get-ScriptLabel -FullName $file.FullName), $result) -ForegroundColor Red
        }
    }
}

Write-Host ''
if ($failures -gt 0) {
    Write-Host ("{0} check(s) failed." -f $failures) -ForegroundColor Red
    exit 1
}
Write-Host 'Scripts are ASCII and parse under every installed PowerShell.' -ForegroundColor Green
