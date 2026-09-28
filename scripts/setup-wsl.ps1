param([string]$Distribution = 'Ubuntu-24.04', [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    if ((& node --version) -ne 'v26.4.0') { throw 'Use Node 26.4.0 before running WSL setup.' }
    if (-not $SkipBuild) {
        & node scripts/build.mjs
        if ($LASTEXITCODE -ne 0) { throw 'Pi GUI build failed.' }
    }
    $archive = Join-Path $env:TEMP ('pi-gui-next-wsl-' + [guid]::NewGuid().ToString('N') + '.tar')
    & node scripts/verify-build.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Build manifest validation failed.' }
    & tar -cf $archive --exclude=node_modules --exclude=.git -C $projectRoot package.json pnpm-lock.yaml pnpm-workspace.yaml out extensions scripts src/main/build-identity.ts
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
    if ($archive -and (Test-Path -LiteralPath $archive)) { Remove-Item -LiteralPath $archive }
    Pop-Location
}
