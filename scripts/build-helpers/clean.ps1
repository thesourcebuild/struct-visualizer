<#
.SYNOPSIS
Deletes the caches and build output that pile up locally, and reports the space freed.

.DESCRIPTION
Everything removed here is regenerated on demand and ignored by git:

  apps\web\.next          Next.js dev and build caches (the dev cache grows every `pnpm web` session)
  apps\web\out            the static export
  .turbo, *\.turbo        Turborepo's task cache, which keeps every run's output and never prunes
  *.tsbuildinfo           TypeScript's incremental build state

The next dev start or build is slower, because it starts from nothing. With -All, node_modules
goes too; `pnpm install` brings it back.

The dev server holds files in apps\web\.next open, so stop `pnpm web` first. The script warns
when port 3000 is in use.

.PARAMETER All
Also remove every node_modules folder. Run `pnpm install` afterwards.

.PARAMETER DryRun
List what would be removed, with sizes, and delete nothing.

.EXAMPLE
pnpm win:clean
Remove the caches and build output.

.EXAMPLE
pnpm win:clean -DryRun
Show what would be removed and how big it is.

.EXAMPLE
pnpm win:clean -All
Also remove node_modules. No `--` separator: pnpm forwards it literally and PowerShell rejects it
as an ambiguous parameter name.
#>
[CmdletBinding()]
param(
    [switch]$All,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\..\lib\common.ps1"

$root = Get-RepoRoot

# Explicit folders rather than a search for every `out` or `.next`: a name match alone could
# reach something that is not ours to delete.
$patterns = @(
    'apps\web\.next'
    'apps\web\out'
    '.turbo'
    'apps\*\.turbo'
    'packages\*\.turbo'
    'packages\tools\*\.turbo'
    'apps\*\*.tsbuildinfo'
    'packages\*\*.tsbuildinfo'
    'packages\tools\*\*.tsbuildinfo'
)
if ($All) {
    $patterns += @(
        'node_modules'
        'apps\*\node_modules'
        'packages\*\node_modules'
        'packages\tools\*\node_modules'
    )
}

$targets = foreach ($pattern in $patterns) {
    Get-Item -Path (Join-Path $root $pattern) -Force -ErrorAction SilentlyContinue
}
$targets = @($targets | Where-Object { $_ } | Sort-Object FullName -Unique)

if ($targets.Count -eq 0) {
    Write-Step 'nothing to clean'
    exit 0
}

if (-not $DryRun -and (Test-PortOpen -Port 3000)) {
    Write-Warn 'port 3000 is in use: if that is `pnpm web`, stop it first, or apps\web\.next stays locked'
}

Write-Step $(if ($DryRun) { 'would remove' } else { 'removing' })
$freed = [long]0
foreach ($target in $targets) {
    $relative = $target.FullName.Substring($root.Length).TrimStart('\')
    $size = Get-PathSize -Path $target.FullName
    $bytes = if ($size) { [long]$size.Bytes } else { [long]0 }
    Write-Note ("{0,-40} {1,9:N1} MB" -f $relative, ($bytes / 1MB))
    if ($DryRun) {
        $freed += $bytes
        continue
    }
    Remove-Item -LiteralPath $target.FullName -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $target.FullName) {
        $left = Get-PathSize -Path $target.FullName
        $leftBytes = if ($left) { [long]$left.Bytes } else { [long]0 }
        $freed += $bytes - $leftBytes
        Write-Warn "could not fully remove $relative (something is holding a file open)"
    } else {
        $freed += $bytes
    }
}

$verb = if ($DryRun) { 'would free' } else { 'freed' }
Write-Host ''
Write-Host ("{0} {1:N1} MB" -f $verb, ($freed / 1MB)) -ForegroundColor Green
if ($All -and -not $DryRun) {
    Write-Note 'run `pnpm install` before the next build'
}
