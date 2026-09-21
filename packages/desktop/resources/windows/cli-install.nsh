!macro customInstall
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\cli\register-path.ps1" -Action Install -OwnedPath "$INSTDIR\resources\cli" -CliPath "$INSTDIR\resources\cli\opencode.exe"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    MessageBox MB_OK|MB_ICONSTOP "CookieMonster could not install the opencode command.$\r$\n$\r$\n$1"
    Abort
  ${EndIf}
!macroend

!macro customUnInstall
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\cli\register-path.ps1" -Action Uninstall -OwnedPath "$INSTDIR\resources\cli"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    MessageBox MB_OK|MB_ICONSTOP "CookieMonster could not remove its opencode command registration.$\r$\n$\r$\n$1"
    Abort
  ${EndIf}
!macroend
