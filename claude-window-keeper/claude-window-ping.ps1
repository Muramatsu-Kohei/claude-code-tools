<#
.SYNOPSIS
  Keeps the Claude Code rate-limit window at a predictable start time.

.DESCRIPTION
  Claude Code's 5-hour usage window starts on the FIRST prompt of a session.
  By sending a tiny prompt at regular, controlled moments (e.g. at logon, or
  once the previous window has elapsed) the window start — and therefore the
  reset time — becomes predictable.

  This script records the timestamp of the last ping in a state file and only
  sends a new minimal prompt once at least -WindowMinutes have passed since the
  last one. It is safe to run frequently (e.g. hourly from Task Scheduler);
  it will skip until the window has actually elapsed.

.PARAMETER WindowMinutes
  Length of the rate-limit window in minutes. Default 300 (5 hours).

.PARAMETER Model
  Model passed to `claude -p`. Default "haiku" (cheapest).

.PARAMETER Force
  Send the ping regardless of how much time has passed.

.PARAMETER Status
  Print current state (last ping / elapsed / estimated reset) and exit.
  Does not send anything and does not modify state.

.PARAMETER DryRun
  Go through the logic and logging but do NOT call claude and do NOT update
  state. Useful for verifying behaviour without consuming any quota.

.EXAMPLE
  .\claude-window-ping.ps1 -Status
  .\claude-window-ping.ps1 -DryRun
  .\claude-window-ping.ps1            # real ping if window elapsed
  .\claude-window-ping.ps1 -Force     # real ping now
#>
[CmdletBinding()]
param(
    [int]$WindowMinutes = 300,
    [string]$Model = "haiku",
    [switch]$Force,
    [switch]$Status,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$stateDir  = Join-Path $env:USERPROFILE ".claude\window-keeper"
$stateFile = Join-Path $stateDir "state.json"
$logFile   = Join-Path $stateDir "ping.log"

if (-not (Test-Path $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
}

function Write-Log([string]$msg) {
    $line = "{0}  {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -Path $logFile -Value $line
    Write-Host $line
}

# --- Load previous state ---------------------------------------------------
$lastPing = $null
if (Test-Path $stateFile) {
    try {
        $state = Get-Content $stateFile -Raw | ConvertFrom-Json
        if ($state.lastPing) { $lastPing = [datetime]$state.lastPing }
    } catch {
        Write-Log ("WARN  could not read state file: " + $_.Exception.Message)
    }
}

$now = Get-Date

# --- Status-only mode ------------------------------------------------------
if ($Status) {
    if ($lastPing) {
        $elapsed = $now - $lastPing
        $reset   = $lastPing.AddMinutes($WindowMinutes)
        Write-Host ("Last ping      : " + $lastPing.ToString('yyyy-MM-dd HH:mm:ss'))
        Write-Host ("Elapsed        : {0} min" -f [math]::Floor($elapsed.TotalMinutes))
        Write-Host ("Window length  : {0} min" -f $WindowMinutes)
        Write-Host ("Est. reset at  : " + $reset.ToString('yyyy-MM-dd HH:mm:ss'))
        if ($now -ge $reset) {
            Write-Host "State          : window elapsed -> next run will send a ping"
        } else {
            $remain = $reset - $now
            Write-Host ("State          : {0} min until next ping is due" -f [math]::Ceiling($remain.TotalMinutes))
        }
    } else {
        Write-Host "No previous ping recorded yet."
    }
    return
}

# --- Decide whether to ping ------------------------------------------------
if (-not $Force -and $lastPing) {
    $elapsed = $now - $lastPing
    if ($elapsed.TotalMinutes -lt $WindowMinutes) {
        $remain = [math]::Ceiling($WindowMinutes - $elapsed.TotalMinutes)
        Write-Log ("SKIP  {0} min since last ping (need {1}); {2} min to go" -f `
            [math]::Floor($elapsed.TotalMinutes), $WindowMinutes, $remain)
        return
    }
}

# --- Send the ping ---------------------------------------------------------
if ($DryRun) {
    Write-Log ("DRYRUN would run: claude -p '<minimal>' --model {0} (state NOT updated)" -f $Model)
    return
}

$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
    # S4U 実行時は対話ログオン時のシェルプロファイルによる PATH 追加が読み込まれない
    # ことがあるため、claude の代表的なインストール先を順に探してからエラーにする。
    # 通常はレジストリの永続 User PATH に .local\bin が入っており PATH 解決できるが、
    # 保険としてフルパスを直接叩けるようにしておく。
    $candidates = @(
        (Join-Path $env:USERPROFILE ".local\bin\claude.exe"),  # ネイティブインストーラ
        (Join-Path $env:APPDATA "npm\claude.cmd")              # npm グローバル
    )
    $found = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($found) {
        $claude = Get-Command $found
    } else {
        Write-Log "ERROR 'claude' command not found in PATH."
        exit 1
    }
}

try {
    $reply = & $claude.Source -p "Reply with only the word: ok" --model $Model 2>&1 | Out-String
    Write-Log ("PING  sent (model={0}); reply: {1}" -f $Model, ($reply.Trim() -replace '\s+', ' '))
} catch {
    Write-Log ("ERROR ping failed: " + $_.Exception.Message)
    exit 1
}

# --- Update state ----------------------------------------------------------
$now = Get-Date
@{ lastPing = $now.ToString("o") } | ConvertTo-Json | Set-Content -Path $stateFile
$reset = $now.AddMinutes($WindowMinutes)
Write-Log ("STATE lastPing updated; est. window reset at " + $reset.ToString("yyyy-MM-dd HH:mm:ss"))
