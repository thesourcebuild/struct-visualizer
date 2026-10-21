# Shared helpers for the launch_*, build_* and package scripts.
# Dot-source it:  . "$PSScriptRoot\..\lib\common.ps1"
#
# Adapted from cipherworkbench's scripts/lib/common.ps1, trimmed to what a web-only project
# needs (no Electron, installers or release archives). Function names and signatures match
# that file, and the snake_case ones in common.sh, so the three can be read side by side.
#
# Everything here must parse under PowerShell 5.1: the .bat wrappers prefer pwsh but fall
# back to the built-in powershell.exe, so PS7-only syntax (?? and ternaries) is out.
#
# ASCII ONLY. These files have no BOM, so PowerShell 5.1 decodes them as cp1252. A UTF-8
# em-dash becomes three characters ending in 0x94, which maps to U+201D - and PowerShell
# accepts that as a double-quote delimiter. One em-dash inside a comment therefore terminates
# a string early and the whole file fails to parse, only on 5.1. Because every script
# dot-sources this one, that would kill all of them. Run scripts\check_scripts.ps1 after editing.

#Requires -Version 5.1

Set-StrictMode -Version Latest

function Get-RepoRoot {
    # This file lives at scripts\lib\common.ps1, two levels below the repo root.
    Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

function Write-Step {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Note {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "    $Message" -ForegroundColor DarkGray
}

function Write-Warn {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "!!  $Message" -ForegroundColor Yellow
}

<#
.SYNOPSIS
Locates pnpm, falling back to corepack, and fails with instructions if absent.
#>
function Resolve-PackageManager {
    if (Get-Command pnpm -ErrorAction SilentlyContinue) {
        return [pscustomobject]@{ Name = 'pnpm'; Prefix = @() }
    }
    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        Write-Note 'pnpm not on PATH; using "corepack pnpm".'
        return [pscustomobject]@{ Name = 'corepack'; Prefix = @('pnpm') }
    }
    throw @'
pnpm was not found.

Install it with:
    npm install -g pnpm@12

The repo pins 10.x through the "packageManager" field in package.json.
'@
}

<#
.SYNOPSIS
Runs pnpm in the foreground and throws if it exits non-zero.

.DESCRIPTION
Note the splat: `& $exe @all` passes each element as its own argument, while
`& $exe @($all)` builds one array argument and reaches pnpm as a single long string.
#>
function Invoke-Pnpm {
    param([Parameter(Mandatory, ValueFromRemainingArguments)][string[]]$Arguments)

    $pm = Resolve-PackageManager
    $all = @($pm.Prefix) + $Arguments
    Write-Note "$($pm.Name) $($all -join ' ')"

    & $pm.Name @all
    if ($LASTEXITCODE -ne 0) {
        # Ctrl+C on a dev server is how it is meant to stop, not a failure.
        if ($LASTEXITCODE -eq -1073741510 -or $LASTEXITCODE -eq 130 -or $LASTEXITCODE -eq 3221225786) {
            return
        }
        throw "$($pm.Name) $($all -join ' ') failed with exit code $LASTEXITCODE."
    }
}

function Test-PortOpen {
    param(
        [Parameter(Mandatory)][int]$Port,
        [string]$Address = '127.0.0.1',
        [int]$TimeoutMs = 400
    )

    # A raw TcpClient rather than Test-NetConnection: that cmdlet lives in the
    # NetTCPIP module, which is Windows-only and absent from some minimal images.
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connect = $client.ConnectAsync($Address, $Port)
        if ($connect.Wait($TimeoutMs)) { return $client.Connected }
        return $false
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

<#
.SYNOPSIS
Fails early if the workspace has not been installed.
#>
function Assert-Dependencies {
    param([Parameter(Mandatory)][string]$RepoRoot)

    if (Test-Path (Join-Path $RepoRoot 'node_modules')) { return }
    throw 'node_modules is missing. Run "pnpm install" first.'
}

<#
.SYNOPSIS
Deletes build output so the next build cannot reuse anything stale.

.DESCRIPTION
Turborepo will restore removed outputs straight back out of its cache, so callers that
clean must also bypass the cache - every build script here pairs -Clean with turbo's
--force for that reason.
#>
function Remove-BuildOutput {
    param([Parameter(Mandatory)][string]$RepoRoot)

    $targets = @(
        'apps\web\out'
        'apps\web\.next'
        '.turbo'
        'apps\web\.turbo'
    )

    foreach ($relative in $targets) {
        $path = Join-Path $RepoRoot $relative
        if (-not (Test-Path $path)) { continue }
        Write-Note "removing $relative"
        Remove-Item $path -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path $path) {
            # Antivirus or an editor can hold a lock on a freshly written file; that is a
            # warning, not a reason to abandon the build.
            Write-Warn "could not fully remove $relative (something is holding a file open)"
        }
    }
}

function Get-PathSize {
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path $Path)) { return $null }
    $item = Get-Item -LiteralPath $Path
    if (-not $item.PSIsContainer) {
        return [pscustomobject]@{ Files = 1; Bytes = $item.Length }
    }
    $files = Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue
    # Measure-Object returns a null Sum for an empty set. Written longhand rather than
    # with ?? so this still parses under PowerShell 5.1.
    $sum = ($files | Measure-Object -Property Length -Sum).Sum
    if ($null -eq $sum) { $sum = 0 }
    return [pscustomobject]@{
        Files = ($files | Measure-Object).Count
        Bytes = $sum
    }
}

<#
.SYNOPSIS
Reports what a build actually produced, and where.
#>
function Show-Artifacts {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][string[]]$Paths
    )

    Write-Host ''
    Write-Host 'Artifacts' -ForegroundColor Green

    foreach ($path in $Paths) {
        $full = if ([System.IO.Path]::IsPathRooted($path)) { $path } else { Join-Path $RepoRoot $path }

        $size = Get-PathSize -Path $full
        if (-not $size) {
            Write-Host ("  {0,-34} (not produced)" -f $path) -ForegroundColor DarkGray
            continue
        }
        $mb = [math]::Round($size.Bytes / 1MB, 1)
        $label = if ($size.Files -eq 1) { '1 file' } else { "$($size.Files) files" }
        Write-Host ("  {0,-34} {1,8} MB  {2}" -f $path, $mb, $label)
    }
    Write-Host ''
}

<#
.SYNOPSIS
Serves apps/web/out the way the deployed site sees it.

.DESCRIPTION
With a base path the export only works under /<base>/, so it is staged into a temporary
tree at that sub-path rather than served from the root, where every asset URL would 404.
npx rather than a tracked dependency: this is for eyeballing a build, not part of the product.
#>
function Start-ExportServer {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [Parameter(Mandatory)][int]$Port,
        [string]$BasePath
    )

    $dir = Join-Path $RepoRoot 'apps\web\out'
    if ($BasePath) {
        $stage = Join-Path ([System.IO.Path]::GetTempPath()) ("sp-serve-" + [guid]::NewGuid().ToString('N'))
        $target = Join-Path $stage ($BasePath.TrimStart('/') -replace '/', '\')
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Copy-Item -Recurse -LiteralPath $dir -Destination $target
        $dir = $stage
        Write-Note "staged under $BasePath -- open http://localhost:$Port$BasePath/"
    }
    & npx --yes serve@14 $dir --listen $Port
}

<#
.SYNOPSIS
Reads the root `version` file: the single source of truth for the project version.
#>
function Get-ProjectVersion {
    param([Parameter(Mandatory)][string]$RepoRoot)

    $versionFile = Join-Path $RepoRoot 'version'
    if (-not (Test-Path -LiteralPath $versionFile)) {
        throw "No version file at $versionFile. That file is the project version."
    }
    $version = (Get-Content -Raw -LiteralPath $versionFile).Trim()
    if (-not $version) { throw "The version file at $versionFile is empty." }
    if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+') {
        throw "The version file at $versionFile reads '$version', which is not a semver version."
    }
    return $version
}

<#
.SYNOPSIS
Every workspace package.json: the root one plus apps\*, packages\* and packages\tools\*.
#>
function Get-ManifestPaths {
    param([Parameter(Mandatory)][string]$RepoRoot)

    $targets = @(Join-Path $RepoRoot 'package.json')
    foreach ($dir in @('apps', 'packages', 'packages\tools')) {
        $base = Join-Path $RepoRoot $dir
        if (-not (Test-Path -LiteralPath $base)) { continue }
        foreach ($child in Get-ChildItem -LiteralPath $base -Directory) {
            $candidate = Join-Path $child.FullName 'package.json'
            if (Test-Path -LiteralPath $candidate) { $targets += $candidate }
        }
    }
    return $targets
}

<#
.SYNOPSIS
Rewrites the `version` field of every workspace package.json to match the root `version` file.

.DESCRIPTION
Rewritten by regex on the raw text rather than through ConvertFrom-Json/ConvertTo-Json, which
would reorder the keys and reformat the whole file. Anchored to a two-space-indented top-level
field, so it cannot reach a nested `version` inside a dependency block. Only files that differ
are written, so a clean tree stays clean.
#>
function Sync-PackageJsonVersions {
    param(
        [Parameter(Mandatory)][string]$RepoRoot,
        [string]$VersionOverride
    )

    $version = $VersionOverride
    if (-not $version) { $version = Get-ProjectVersion -RepoRoot $RepoRoot }

    $targets = Get-ManifestPaths -RepoRoot $RepoRoot
    $pattern = '(?m)^(  "version"\s*:\s*")[^"]*(")'
    $changed = 0
    foreach ($target in $targets) {
        $raw = [System.IO.File]::ReadAllText($target)
        if ($raw -notmatch $pattern) {
            Write-Warn "No top-level version field in $target, left alone."
            continue
        }
        $updated = [regex]::Replace($raw, $pattern, "`${1}$version`${2}", 1)
        if ($updated -ne $raw) {
            # No BOM: these files are prettier-formatted and diffed.
            [System.IO.File]::WriteAllText($target, $updated, (New-Object System.Text.UTF8Encoding($false)))
            $changed++
            Write-Note ("synced {0} -> {1}" -f $target.Substring($RepoRoot.Length + 1), $version)
        }
    }
    if ($changed -eq 0) { Write-Note "all $(@($targets).Count) manifests already at $version" }
    return $version
}

<#
No script in this folder prompts, pauses, or waits for a keypress. A failure prints its
error and exits non-zero; a shell shows it. If you want a pause for double-clicking a .bat
from Explorer, add `pause` to the end of that one .bat rather than to every script.
#>
