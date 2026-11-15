<#
.SYNOPSIS
    Installs or updates Antigravity-ESPRemoteSerial in Antigravity's global plugins
    directory (`~/.gemini/config/plugins/serial-monitor`).

.DESCRIPTION
    By default, copies a complete, self-contained bundle (manifest, assets, tools, skill,
    and sidecar) into `$HOME\.gemini\config\plugins\serial-monitor` and stamps `sidecar.json`
    so Antigravity reloads the running sidecar automatically.

    Pass `-LinkSource` during active UI/broker development in a worktree to point the
    registered sidecar directly at this checkout's `sidecars/monitor/main.mjs` and `tools/`.

    Note: If you cloned this repository directly into `$HOME\.gemini\config\plugins\serial-monitor`,
    you do NOT need to run this script — Antigravity discovers it automatically.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$PluginDir = (Join-Path $HOME ".gemini\config\plugins\serial-monitor"),

    [Parameter(Mandatory = $false)]
    [switch]$LinkSource
)

$ErrorActionPreference = "Stop"

$srcRoot = (Resolve-Path (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$regDir  = [System.IO.Path]::GetFullPath($PluginDir)

if ($srcRoot.TrimEnd('\', '/').Equals($regDir.TrimEnd('\', '/'), [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "Repository is already located at '$regDir'; no registration copy required." -ForegroundColor Green
    exit 0
}

New-Item -ItemType Directory -Path `
    "$regDir\assets", `
    "$regDir\tools", `
    "$regDir\skills\esp-remote-serial", `
    "$regDir\sidecars\monitor" -Force | Out-Null

Copy-Item "$srcRoot\plugin.json" "$regDir\plugin.json" -Force
Copy-Item "$srcRoot\assets\logo.svg" "$regDir\assets\logo.svg" -Force
Copy-Item "$srcRoot\tools\pio_hub4com_rfc2217.py" "$regDir\tools\pio_hub4com_rfc2217.py" -Force
Copy-Item "$srcRoot\tools\serial_monitor.py" "$regDir\tools\serial_monitor.py" -Force
Copy-Item "$srcRoot\skills\esp-remote-serial\SKILL.md" "$regDir\skills\esp-remote-serial\SKILL.md" -Force
if (Test-Path "$srcRoot\README.md") {
    Copy-Item "$srcRoot\README.md" "$regDir\README.md" -Force
}

if ($LinkSource) {
    $normSrcRoot = $srcRoot -replace '\\', '/'
    $sidecarArgs = @("$normSrcRoot/sidecars/monitor/main.mjs")
    $sidecarEnv  = [ordered]@{
        SERIAL_MONITOR_SCRIPT    = "$normSrcRoot/tools/serial_monitor.py"
        SERIAL_MONITOR_SYNCED_AT = [DateTime]::UtcNow.ToString("o")
    }
    $targetDesc = "$normSrcRoot/sidecars/monitor/main.mjs (linked)"
}
else {
    foreach ($f in @("package.json", "main.mjs", "broker_client.mjs", "index.html", "styles.css", "app.js")) {
        Copy-Item "$srcRoot\sidecars\monitor\$f" "$regDir\sidecars\monitor\$f" -Force
    }
    $sidecarArgs = @("main.mjs")
    $sidecarEnv  = [ordered]@{
        SERIAL_MONITOR_SYNCED_AT = [DateTime]::UtcNow.ToString("o")
    }
    $targetDesc = "$regDir\sidecars\monitor\main.mjs (self-contained)"
}

$sidecarObj = [ordered]@{
    command        = "node"
    args           = $sidecarArgs
    restart_policy = "always"
    env            = $sidecarEnv
    display_name   = "Serial Monitor"
    description    = "Live multi-target client for shared RFC2217 and COM serial monitor brokers."
    has_web_ui     = $true
    ui_config      = [ordered]@{
        display_name = "Serial Monitor"
        views        = @(
            [ordered]@{
                path       = "/"
                entrypoint = "SIDECAR_UI_ENTRYPOINT_AUX_PANE"
                title      = "Serial Monitor"
            }
        )
    }
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
    "$regDir\sidecars\monitor\sidecar.json",
    ($sidecarObj | ConvertTo-Json -Depth 6),
    $utf8NoBom
)

Write-Host "Registered plugin 'serial-monitor' -> $targetDesc" -ForegroundColor Green
