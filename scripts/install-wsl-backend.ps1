param([string]$Distribution = 'Ubuntu-24.04')
$ErrorActionPreference = 'Stop'
try {
    $wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
    if (-not (Test-Path -LiteralPath $wsl)) {
        throw 'WSL2 is required. Run wsl --install -d Ubuntu-24.04, finish Ubuntu user setup, then run this installer again.'
    }
    $uid = & $wsl -d $Distribution --exec id -u
    if ($LASTEXITCODE -ne 0 -or $uid.Trim() -eq '0') {
        throw 'Ubuntu-24.04 must be initialized with a regular default user. Finish WSL setup before retrying.'
    }
    $kernel = & $wsl -d $Distribution --exec uname -r
    if ($LASTEXITCODE -ne 0 -or $kernel -notmatch 'microsoft.*WSL2') { throw 'Ubuntu-24.04 must use WSL2.' }
    $archive = Join-Path $PSScriptRoot 'backend.tar'
    $script = Join-Path $PSScriptRoot 'setup-wsl-host.sh'
    $linuxArchive = & $wsl -d $Distribution --exec wslpath -a -u $archive
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the WSL backend archive path.' }
    $linuxScript = & $wsl -d $Distribution --exec wslpath -a -u $script
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the WSL installer path.' }
    & $wsl -d $Distribution --exec sh $linuxScript.Trim() $linuxArchive.Trim()
    if ($LASTEXITCODE -ne 0) { throw 'WSL backend installation failed. See the installation details above, close any running Pi GUI WSL window and retry.' }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
