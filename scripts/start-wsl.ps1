param([string]$Distribution = 'Ubuntu-24.04')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$linuxBase = & wsl.exe -d $Distribution --exec sh -c 'printf "%s/pi-gui-next-wsl" "${XDG_DATA_HOME:-$HOME/.local/share}"'
if ($LASTEXITCODE -ne 0) { throw 'Cannot read the WSL user directory.' }
$linuxBase = $linuxBase.Trim()
$env:PI_GUI_WSL_DISTRO = $Distribution
$env:PI_GUI_WSL_LAUNCHER = "$linuxBase/start-host.sh"
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:PI_GUI_PROBE_ONLY -ErrorAction SilentlyContinue
Remove-Item Env:NODE_ENV_ELECTRON_VITE -ErrorAction SilentlyContinue
Remove-Item Env:ELECTRON_RENDERER_URL -ErrorAction SilentlyContinue
Push-Location -LiteralPath $projectRoot
try {
    & fnm exec --using 26.4.0 cmd /c pnpm exec electron .
    if ($LASTEXITCODE -ne 0) { throw 'Pi GUI WSL client exited unsuccessfully.' }
} finally {
    Pop-Location
}
