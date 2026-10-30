; Favor Printer Windows installer hooks (issue #42).
;
; The printer helpers are PowerShell scripts run with -File, so Windows
; execution policy applies to them. Stock Windows client policy is Restricted,
; which blocks every script, signed or not. With the operator's explicit consent
; this per-user installer sets ONLY the CurrentUser scope to RemoteSigned:
;   - never when Group Policy (MachinePolicy/UserPolicy) manages the setting,
;   - never when the effective policy is already AllSigned, RemoteSigned or looser,
;   - never in a silent install or update (/S answers No),
;   - never with -ExecutionPolicy Bypass.
; Uninstall restores the previous CurrentUser value, but only if the installer
; made the change and the value is still the one it set. Updates leave it alone.

!define FAVOR_POLICY_KEY "Software\Favor Printer"
!define FAVOR_POLICY_VALUE "PowerShellPolicyPrevious"

!macro favorPowerShell _OUT
  ${If} ${FileExists} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    StrCpy ${_OUT} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${Else}
    StrCpy ${_OUT} "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
!macroend

!macro customInstall
  ; Auto-updates run the installer non-silently (quitAndInstall), so /SD alone
  ; would not stop the prompt. Ask only on a fresh install or manual reinstall.
  ${IfNot} ${isUpdated}
  !insertmacro favorPowerShell $R9
  ; Prints gpo | ok | allsigned | needs:<current CurrentUser value>, with no newline.
  nsExec::ExecToStack `"$R9" -NoLogo -NoProfile -NonInteractive -Command "$$m = Get-ExecutionPolicy -Scope MachinePolicy; $$u = Get-ExecutionPolicy -Scope UserPolicy; $$e = Get-ExecutionPolicy; if ($$m -ne 'Undefined' -or $$u -ne 'Undefined') { $$r = 'gpo' } elseif ($$e -eq 'Restricted' -or $$e -eq 'Undefined') { $$r = 'needs:' + (Get-ExecutionPolicy -Scope CurrentUser) } elseif ($$e -eq 'AllSigned') { $$r = 'allsigned' } else { $$r = 'ok' }; [Console]::Out.Write($$r)"`
  Pop $R0 ; exit code
  Pop $R1 ; output
  StrCpy $R2 $R1 6
  ${If} $R0 == 0
  ${AndIf} $R2 == "needs:"
    StrCpy $R3 $R1 "" 6
    MessageBox MB_YESNO|MB_ICONQUESTION "Favor Printer finds and prints to your Zebra printer with two small PowerShell scripts that it installs.$\r$\n$\r$\nWindows currently blocks all PowerShell scripts for your account, so printing would stay off.$\r$\n$\r$\nAllow locally installed PowerShell scripts for your Windows account only (execution policy RemoteSigned, current user)?$\r$\n$\r$\nChoose No if your IT team has not approved this. You can change it later, and uninstalling Favor Printer puts it back." /SD IDNO IDNO favorPolicyDone
    nsExec::ExecToStack `"$R9" -NoLogo -NoProfile -NonInteractive -Command "Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force; [Console]::Out.Write((Get-ExecutionPolicy).ToString())"`
    Pop $R0
    Pop $R1
    ${If} $R0 == 0
    ${AndIf} $R1 == "RemoteSigned"
      WriteRegStr HKCU "${FAVOR_POLICY_KEY}" "${FAVOR_POLICY_VALUE}" "$R3"
    ${Else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Windows did not accept the PowerShell setting. Favor Printer will show that printing is off. Ask your IT team for help." /SD IDOK
    ${EndIf}
  ${EndIf}
  favorPolicyDone:
  ${EndIf}
!macroend

!macro customUnInstall
  ${IfNot} ${isUpdated}
    ReadRegStr $R3 HKCU "${FAVOR_POLICY_KEY}" "${FAVOR_POLICY_VALUE}"
    ${If} $R3 == "Undefined"
    ${OrIf} $R3 == "Restricted"
      !insertmacro favorPowerShell $R9
      nsExec::ExecToStack `"$R9" -NoLogo -NoProfile -NonInteractive -Command "if ((Get-ExecutionPolicy -Scope CurrentUser) -eq 'RemoteSigned') { Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy $R3 -Force }"`
      Pop $R0
      Pop $R1
    ${EndIf}
    DeleteRegValue HKCU "${FAVOR_POLICY_KEY}" "${FAVOR_POLICY_VALUE}"
    DeleteRegKey /ifempty HKCU "${FAVOR_POLICY_KEY}"
  ${EndIf}
!macroend
