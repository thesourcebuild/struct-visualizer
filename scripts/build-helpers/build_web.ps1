<#
.SYNOPSIS
Builds the web app.

.DESCRIPTION
Produces the Next.js static export in apps/web/out. That directory is the entire web
deliverable - drop it on any static host.

.PARAMETER Clean
Delete build output first and bypass the Turborepo cache.

.PARAMETER BasePath
Sub-path the site will be served from, e.g. /struct_padding_calculator for a GitHub Pages
project site. Sets NEXT_PUBLIC_BASE_PATH for the build. Omit for a site at the domain root.

.PARAMETER Serve
Serve the finished export so you can check it before deploying.

.PARAMETER Port
Port for -Serve. Default 3000.

.EXAMPLE
.\scripts\build-helpers\build_web.ps1
.EXAMPLE
.\scripts\build-helpers\build_web.ps1 -Clean
.EXAMPLE
.\scripts\build-helpers\build_web.ps1 -BasePath /struct_padding_calculator -Serve
#>
[CmdletBinding()]
param(
    [switch]$Clean,
    [string]$BasePath,
    [switch]$Serve,
    [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\lib\common.ps1"

$root = Get-RepoRoot
Assert-Dependencies -RepoRoot $root

if ($BasePath -and -not $BasePath.StartsWith('/')) {
    throw "-BasePath must start with a slash, e.g. /$BasePath"
}

Push-Location $root
$previousBasePath = $env:NEXT_PUBLIC_BASE_PATH
try {
    if ($Clean) {
        Write-Step 'Cleaning previous output'
        Remove-BuildOutput -RepoRoot $root
    }

    if ($BasePath) {
        $env:NEXT_PUBLIC_BASE_PATH = $BasePath.TrimEnd('/')
        Write-Note "NEXT_PUBLIC_BASE_PATH=$($env:NEXT_PUBLIC_BASE_PATH)"
    }

    Write-Step 'Building the static export'
    # --filter=@sp/web... also builds everything web depends on, which here is the
    # whole packages/ tree.
    $turboArgs = @('run', 'build', '--filter=@sp/web...')
    if ($Clean) { $turboArgs += '--force' }
    Invoke-Pnpm exec turbo @turboArgs

    Show-Artifacts -RepoRoot $root -Paths @('apps\web\out')
    Write-Host 'Deploy apps/web/out to any static host.' -ForegroundColor Green

    if ($Serve) {
        if (Test-PortOpen -Port $Port) {
            Write-Warn "Port $Port is already in use; not serving."
            return
        }
        Write-Step "Serving apps/web/out on http://localhost:$Port"
        Write-Note 'Press Ctrl+C to stop.'
        # Serving it rather than opening the file is not a nicety: under file:// the export
        # resolves its asset paths against the filesystem root and loads dead.
        Start-ExportServer -RepoRoot $root -Port $Port -BasePath $env:NEXT_PUBLIC_BASE_PATH
    }
}
finally {
    $env:NEXT_PUBLIC_BASE_PATH = $previousBasePath
    Pop-Location
}
