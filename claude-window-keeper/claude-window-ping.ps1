# Get-Help claude-window-ping.ps1 で表示される文字列
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

  Logging: only meaningful events (PING / STATE / WARN / ERROR / DRYRUN) are
  written to ping.log. The routine "SKIP" lines are printed to the console
  only, so the log stays short. The log is rotated to ping.log.1 once it
  exceeds 1 MB (one generation kept).

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

# 実行時のパラメータ
[CmdletBinding()]
param(
    [int]$WindowMinutes = 300,
    [string]$Model = "haiku",
    [switch]$Force,
    [switch]$Status,
    [switch]$DryRun
)

# エラーで処理中断
$ErrorActionPreference = "Stop"

$stateDir  = Join-Path $env:USERPROFILE ".claude\window-keeper"
$stateFile = Join-Path $stateDir "state.json"
$logFile   = Join-Path $stateDir "ping.log"

if (-not (Test-Path $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
}

# ログは追記され続けるため、この大きさを超えたら 1 世代だけ退避して作り直す
# （SKIP をファイルに残さない運用なら年に数十行程度で、通常ここには到達しない保険）
$logMaxBytes = 1MB

# ログ記載用func.
# -ConsoleOnly を付けた呼び出しは画面表示だけで、ファイルには残さない
function Write-Log([string]$msg, [switch]$ConsoleOnly) {
    $line = "{0}  {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $msg
    Write-Host $line
    if ($ConsoleOnly) { return }

    # 追記前にサイズを見て、超過していれば ping.log.1 へ退避（前世代は破棄）
    if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt $logMaxBytes)) {
        Move-Item -Path $logFile -Destination ($logFile + ".1") -Force
    }
    Add-Content -Path $logFile -Value $line
}

# 前回のPing時間をログから復元
$lastPing = $null
if (Test-Path $stateFile) {
    try {
        $state = Get-Content $stateFile -Raw | ConvertFrom-Json
        if ($state.lastPing) { 
            $lastPing = [datetime]$state.lastPing 
        }
    } catch {
        Write-Log ("WARN  could not read state file: " + $_.Exception.Message)
    }
}

$now = Get-Date

# 状況確認のみ（実行時に -Status がつけられたとき）
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
    return # 確認のみでこれ以降の処理（Ping送信）は行わない
    
}

# スキップ判定（-Force がある場合は前回からの時間に関係なくPing）
if (-not $Force -and $lastPing) {
    $elapsed = $now - $lastPing
    if ($elapsed.TotalMinutes -lt $WindowMinutes) {
        $remain = [math]::Ceiling($WindowMinutes - $elapsed.TotalMinutes)
        # SKIP は毎時発生してログの大半を占めるうえ後から読む価値がないため、画面のみ
        Write-Log -ConsoleOnly ("SKIP  {0} min since last ping (need {1}); {2} min to go" -f `
            [math]::Floor($elapsed.TotalMinutes), $WindowMinutes, $remain)
        return # 前回から指定時間（5h = 300min）経っていなければ以降をスキップ
    }
}

# 時限発火のシミュレーション（実行時に -DryRun がつけられたとき）
if ($DryRun) {
    Write-Log ("DRYRUN would run: claude -p '<minimal>' --model {0} (state NOT updated)" -f $Model)
    return # シミュレーションなのでログに残すだけでこれ以降の処理は行わない
}

# claudeコマンドの捜索
$claude = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claude) {
    # S4U 実行時は対話ログオン時のシェルプロファイルによる PATH 追加が読み込まれない可能性あり
    # claude の代表的なインストール先を順に探してからエラーにする
    # 通常はレジストリの永続 User PATH に .local\bin が入っており PATH 解決できるはず
    # 保険としてフルパスを直接叩けるようにしておく
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

# ClaudeにPing（デフォルトではhaikuで最小限の応答で済むプロンプト）を送信
try {
    $reply = & $claude.Source -p "Reply with only the word: ok" --model $Model 2>&1 | Out-String
    Write-Log ("PING  sent (model={0}); reply: {1}" -f $Model, ($reply.Trim() -replace '\s+', ' '))
} catch {
    Write-Log ("ERROR ping failed: " + $_.Exception.Message)
    exit 1
}

# ログの更新
$now = Get-Date
@{ lastPing = $now.ToString("o") } | ConvertTo-Json | Set-Content -Path $stateFile
$reset = $now.AddMinutes($WindowMinutes)
Write-Log ("STATE lastPing updated; est. window reset at " + $reset.ToString("yyyy-MM-dd HH:mm:ss"))
