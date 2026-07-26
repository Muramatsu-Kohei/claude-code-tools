<#
.SYNOPSIS
  Register (or update) a Windows Scheduled Task that runs claude-window-ping.ps1
  at logon and periodically, keeping the Claude Code rate-limit window
  at a predictable start time.

.DESCRIPTION
  Creates a task named -TaskName that runs for the current user with two
  triggers:
    * At logon (so the window is re-anchored right after PC startup)
    * Every -IntervalHours hours (so a window that elapses while the PC is on
      is picked up promptly)
  The task uses -StartWhenAvailable, so a trigger missed while the PC was off
  or asleep runs shortly after the machine comes back.

  The ping script itself decides whether to actually send anything (it skips
  until the window has elapsed), so running hourly is cheap.

.PARAMETER TaskName
  Scheduled task name. Default "ClaudeWindowKeeper".

.PARAMETER IntervalHours
  How often the periodic check fires. Default 1.

.PARAMETER WindowMinutes
  Passed through to the ping script. Default 300 (5 hours).

.PARAMETER Model
  Passed through to the ping script. Default "haiku".

.PARAMETER Unregister
  Remove the task instead of creating it.

.EXAMPLE
  .\register-task.ps1
  .\register-task.ps1 -IntervalHours 2 -WindowMinutes 300
  .\register-task.ps1 -Unregister
#>
[CmdletBinding()]
param(
    [string]$TaskName = "ClaudeWindowKeeper",
    [int]$IntervalHours = 1,
    [int]$WindowMinutes = 300,
    [string]$Model = "haiku",
    [switch]$Unregister
)

$ErrorActionPreference = "Stop"

# Registering/unregistering a scheduled task needs admin rights on this
# machine. If we are not elevated, relaunch this script via UAC and stop.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Administrator rights required. Requesting elevation (UAC prompt)..."
    $fwd = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', ('"{0}"' -f $PSCommandPath))
    foreach ($kv in $PSBoundParameters.GetEnumerator()) {
        if ($kv.Value -is [switch]) {
            if ($kv.Value.IsPresent) { $fwd += ('-{0}' -f $kv.Key) }
        } else {
            $fwd += @(('-{0}' -f $kv.Key), ('{0}' -f $kv.Value))
        }
    }
    try {
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $fwd
        Write-Host "Elevated window launched. Check its output there, then close it."
    } catch {
        Write-Host "Elevation cancelled or failed: $($_.Exception.Message)"
    }
    return
}

if ($Unregister) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'."
    } else {
        Write-Host "No scheduled task named '$TaskName' found."
    }
    return
}

$scriptPath = Join-Path $PSScriptRoot "claude-window-ping.ps1"
if (-not (Test-Path $scriptPath)) {
    throw "Cannot find ping script at: $scriptPath"
}

$argLine = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -WindowMinutes {1} -Model {2}' -f `
    $scriptPath, $WindowMinutes, $Model

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argLine

$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
$periodicTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Hours $IntervalHours) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

# Run as S4U ("whether the user is logged on or not"). The task then executes in
# a non-interactive background session, so no console window ever appears on the
# desktop -- this is what eliminates the brief PowerShell/conhost flash that
# -WindowStyle Hidden alone cannot suppress. S4U needs no stored password.
$principal = New-ScheduledTaskPrincipal `
    -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) `
    -LogonType S4U `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger @($logonTrigger, $periodicTrigger) `
    -Settings $settings `
    -Principal $principal `
    -Description "Sends a minimal Claude Code prompt to keep the rate-limit window start predictable." `
    -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName':"
Write-Host "  - runs at logon"
Write-Host ("  - runs every {0} hour(s)" -f $IntervalHours)
Write-Host ("  - window length : {0} min" -f $WindowMinutes)
Write-Host ("  - model         : {0}" -f $Model)
Write-Host ("  - script        : {0}" -f $scriptPath)
Write-Host ""
Write-Host "Check state anytime with:"
Write-Host ("  powershell -File `"{0}`" -Status" -f $scriptPath)
