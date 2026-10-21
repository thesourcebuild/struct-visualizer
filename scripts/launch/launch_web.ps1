<#
.SYNOPSIS
Starts the web app's dev server and opens the calculator in the default browser.

.PARAMETER Port
Port for the dev server. Default 3000.

.EXAMPLE
.\scripts\launch\launch_web.ps1
#>
[CmdletBinding()]
param(
    [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\lib\common.ps1"

$root = Get-RepoRoot
Assert-Dependencies -RepoRoot $root

$url = "http://localhost:$Port/tools/"

Push-Location $root
try {
    if (Test-PortOpen -Port $Port) {
        Write-Warn "Something is already listening on port $Port."
        Write-Note 'That is probably a dev server from an earlier run. Opening it anyway.'
        Start-Process $url
        return
    }

    Write-Step "Starting the dev server on $url"
    Write-Note 'The browser opens once the server is listening. Press Ctrl+C to stop.'

    # Open the browser only once the server accepts connections. A browser does not retry a
    # refused connection: opening it first showed ERR_CONNECTION_REFUSED whenever Next took
    # longer to start than the browser took to load the page.
    $opener = Start-Job -ArgumentList "$PSScriptRoot\..\lib\common.ps1", $Port, $url -ScriptBlock {
        param($Common, $Port, $Url)
        . $Common
        $deadline = (Get-Date).AddMinutes(2)
        while ((Get-Date) -lt $deadline) {
            if (Test-PortOpen -Port $Port) {
                Start-Process $Url
                return
            }
            Start-Sleep -Milliseconds 500
        }
    }

    try {
        Invoke-Pnpm --filter '@sp/web' dev --port $Port
    }
    finally {
        Remove-Job -Job $opener -Force -ErrorAction SilentlyContinue
    }
}
finally {
    Pop-Location
}
