param([string]$Distribution = 'Ubuntu-24.04', [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    if (-not $SkipBuild) {
        & fnm exec --using 26.4.0 cmd /c pnpm build
        if ($LASTEXITCODE -ne 0) { throw 'Pi GUI build failed.' }
    }
    $archive = Join-Path $env:TEMP 'pi-gui-next-wsl.tar'
    & tar -cf $archive --exclude=node_modules --exclude=.git -C $projectRoot package.json pnpm-lock.yaml pnpm-workspace.yaml out extensions scripts
    if ($LASTEXITCODE -ne 0) { throw 'Could not create WSL backend archive.' }
    $linuxArchive = & wsl.exe -d $Distribution --exec wslpath -a -u $archive
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the WSL archive path.' }
    $linuxArchive = $linuxArchive.Trim()
    $linuxScript = & wsl.exe -d $Distribution --exec wslpath -a -u (Join-Path $PSScriptRoot 'setup-wsl-host.sh')
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the WSL setup path.' }
    $linuxScript = $linuxScript.Trim()
    & wsl.exe -d $Distribution --exec sh $linuxScript $linuxArchive
    if ($LASTEXITCODE -ne 0) { throw 'WSL backend setup failed.' }
} finally {
    Pop-Location
}
