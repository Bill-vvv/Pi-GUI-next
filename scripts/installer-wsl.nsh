!macro customInstall
  SetDetailsPrint both
  DetailPrint "Installing the matching Pi backend in Ubuntu-24.04 (WSL2). Internet access is required."
  ${DisableX64FSRedirection}
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\wsl\install-wsl-backend.ps1"'
  ${EnableX64FSRedirection}
  Pop $0
  ${If} $0 != 0
    SetErrorLevel 1
    MessageBox MB_OK|MB_ICONSTOP "WSL backend setup failed. Read the installation details, fix the reported issue, then run this installer again." /SD IDOK
    Abort
  ${EndIf}
!macroend
