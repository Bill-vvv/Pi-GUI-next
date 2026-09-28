param([string]$Distribution = 'Ubuntu-24.04')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$linuxBase = & wsl.exe -d $Distribution --exec sh -c 'printf "%s/pi-gui-next-wsl" "${XDG_DATA_HOME:-$HOME/.local/share}"'
if ($LASTEXITCODE -ne 0) { throw 'Cannot read the WSL user directory.' }
$linuxBase = $linuxBase.Trim()
$environmentNames = @('PI_GUI_WSL_DISTRO', 'PI_GUI_WSL_LAUNCHER', 'ELECTRON_RUN_AS_NODE', 'PI_GUI_PROBE_ONLY', 'NODE_ENV_ELECTRON_VITE', 'ELECTRON_RENDERER_URL')
$previousEnvironment = @{}
foreach ($name in $environmentNames) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
Push-Location -LiteralPath $projectRoot
try {
$env:PI_GUI_WSL_DISTRO = $Distribution
$env:PI_GUI_WSL_LAUNCHER = "$linuxBase/start-host.sh"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:PI_GUI_PROBE_ONLY -ErrorAction SilentlyContinue
Remove-Item Env:NODE_ENV_ELECTRON_VITE -ErrorAction SilentlyContinue
Remove-Item Env:ELECTRON_RENDERER_URL -ErrorAction SilentlyContinue
    if ((& node --version) -ne 'v26.4.0') { throw 'Use Node 26.4.0 before starting WSL.' }
    & node node_modules/electron/cli.js .
    if ($LASTEXITCODE -ne 0) { throw 'Pi GUI WSL client exited unsuccessfully.' }
} finally {
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
    Pop-Location
}
