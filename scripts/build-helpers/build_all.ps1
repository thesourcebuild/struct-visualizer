<#
.SYNOPSIS
Builds everything, optionally behind the full quality gate.

.DESCRIPTION
The release path. With -Verify it runs the full quality gate first - the script check,
typecheck, lint and the test suite - and stops before building if any of them fail, so
a broken tree never produces artifacts that look shippable.

Unlike cipherworkbench there is no desktop bundle or installer: the web static export is
the whole deliverable.

.PARAMETER Clean
Delete build output first and bypass the Turborepo cache.

.PARAMETER Verify
Run the script check, typecheck, lint and tests before building. Use this for a release build.

.PARAMETER Smoke
After building, check the export contains every page a deploy needs (index, /tools/ and one
page per tool).

.PARAMETER BasePath
Forwarded to the build as NEXT_PUBLIC_BASE_PATH, e.g. /struct_padding_calculator.

.EXAMPLE
.\scripts\build-helpers\build_all.ps1
.EXAMPLE
.\scripts\build-helpers\build_all.ps1 -Clean -Verify -Smoke
#>
[CmdletBinding()]
param(
    [switch]$Clean,
    [switch]$Verify,
    [switch]$Smoke,
    [string]$BasePath
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
    if ($Verify) {
        # First because it is instant, and because a script that does not parse under
        # 5.1 makes every other step here unreachable on a machine without pwsh.
        Write-Step 'Checking the scripts are ASCII and parse under both PowerShell versions'
        & "$PSScriptRoot\..\check_scripts.ps1"
        if ($LASTEXITCODE -ne 0) { throw 'Script check failed.' }

        Write-Step 'Checking every manifest agrees with the version file'
        & "$PSScriptRoot\..\package\sync_version.ps1" -Check
        if ($LASTEXITCODE -ne 0) { throw 'Version check failed. Run pnpm win:version.' }

        Write-Step 'Typechecking every package and tests/'
        Invoke-Pnpm typecheck

        Write-Step 'Linting'
        Invoke-Pnpm lint

        Write-Step 'Running tests'
        Invoke-Pnpm test

        Write-Host 'Gate passed.' -ForegroundColor Green
    }

    if ($Clean) {
        Write-Step 'Cleaning previous output'
        Remove-BuildOutput -RepoRoot $root
    }

    if ($BasePath) {
        $env:NEXT_PUBLIC_BASE_PATH = $BasePath.TrimEnd('/')
        Write-Note "NEXT_PUBLIC_BASE_PATH=$($env:NEXT_PUBLIC_BASE_PATH)"
    }

    Write-Step 'Building every package and the web export'
    $turboArgs = @('run', 'build')
    if ($Clean) { $turboArgs += '--force' }
    Invoke-Pnpm exec turbo @turboArgs

    Show-Artifacts -RepoRoot $root -Paths @('apps\web\out')

    if ($Smoke) {
        Write-Step 'Checking the export has every page'
        $out = Join-Path $root 'apps\web\out'
        $required = @('index.html', 'tools\index.html', 'sitemap.xml', 'robots.txt', '404.html')
        # One static page per tool, from generateStaticParams over the registry.
        $toolsDir = Join-Path $out 'tools'
        $toolPages = @(Get-ChildItem -LiteralPath $toolsDir -Directory -ErrorAction SilentlyContinue |
            Where-Object { Test-Path (Join-Path $_.FullName 'index.html') })
        $missing = @($required | Where-Object { -not (Test-Path (Join-Path $out $_)) })
        if ($missing.Count -gt 0) { throw "The export is missing: $($missing -join ', ')" }
        if ($toolPages.Count -eq 0) { throw 'The export has no /tools/<id>/ pages.' }
        Write-Note "tool pages: $(($toolPages | ForEach-Object { $_.Name }) -join ', ')"
        Write-Host 'Smoke check passed.' -ForegroundColor Green
    }
}
finally {
    $env:NEXT_PUBLIC_BASE_PATH = $previousBasePath
    Pop-Location
}
