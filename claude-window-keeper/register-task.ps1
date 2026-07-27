# Get-Help register-task.ps1 で表示される文字列
# ↓の空行2行は必須。詰めるとコメントベースヘルプと認識されなくなる


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

# 実行時のパラメータ（WindowMinutes と Model は ping スクリプトへそのまま渡す）
[CmdletBinding()]
param(
    [string]$TaskName = "ClaudeWindowKeeper",
    [int]$IntervalHours = 1,
    [int]$WindowMinutes = 300,
    [string]$Model = "haiku",
    [switch]$Unregister
)

# エラーで処理中断
$ErrorActionPreference = "Stop"

# タスクの登録・削除には管理者権限が必要
# 昇格していなければ UAC 経由で自分自身を起動し直し、この実行はここで終了する
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Administrator rights required. Requesting elevation (UAC prompt)..."

    # 昇格後の実行に引数を引き継ぐ。-NoExit は結果を読めるように昇格側の窓を残すため
    $fwd = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-NoExit', '-File', ('"{0}"' -f $PSCommandPath))

    # 明示的に指定された引数だけを転送する（switch は値ではなく名前だけを渡す）
    # $PSBoundParametersが実行時のオプション Key Value を自動格納する特殊変数
    foreach ($kv in $PSBoundParameters.GetEnumerator()) {
        # [switch]の場合は -key の形式
        if ($kv.Value -is [switch]) {
            if ($kv.Value.IsPresent) { 
                $fwd += ('-{0}' -f $kv.Key) 
            }
        # [switch]の以外は -key value の形式
        } else {
            $fwd += @(('-{0}' -f $kv.Key), ('{0}' -f $kv.Value))
        }
    }

    try {
        Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $fwd
        Write-Host "Elevated window launched. Check its output there, then close it."
    } catch {
        # UAC で「いいえ」を選んだ場合もここに来る。異常終了ではないのでメッセージのみ
        Write-Host "Elevation cancelled or failed: $($_.Exception.Message)"
    }
    return # 実処理は昇格した側で行うため、この実行はここで終わり
    # 昇格側は $isAdmin が True なので飛ばされる
}

# タスクの削除（実行時に -Unregister がつけられたとき）
if ($Unregister) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task '$TaskName'."
    } else {
        Write-Host "No scheduled task named '$TaskName' found."
    }
    return # 削除のみでこれ以降の処理（登録）は行わない
}

# ping スクリプトは同一フォルダにある前提で解決する
# タスクには絶対パスが埋め込まれるため、後でフォルダを移動したら再登録が必要
$scriptPath = Join-Path $PSScriptRoot "claude-window-ping.ps1"
if (-not (Test-Path $scriptPath)) {
    throw "Cannot find ping script at: $scriptPath"
}

# タスクが実行するコマンドライン
# -NoProfile はプロファイル読み込みによる遅延と副作用を避けるため
$argLine = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -WindowMinutes {1} -Model {2}' -f `
    $scriptPath, $WindowMinutes, $Model

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argLine

# 起動直後にウィンドウを開き直すためのログオン時トリガー
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn

# PC を点けたままウィンドウが明けた場合に拾うための定期トリガー
# 「今日の 0:01 に1回」を起点に指定間隔で無期限（10年）繰り返す形にしている
$periodicTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Hours $IntervalHours) `
    -RepetitionDuration (New-TimeSpan -Days 3650)

# StartWhenAvailable: PC が停止・スリープ中に逃したトリガーを復帰後に実行する
# バッテリー関連の2つ: ノート PC で電源に繋いでいなくても動かすため
# ExecutionTimeLimit: claude が応答しない場合にタスクが居座らないよう10分で打ち切る
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

# S4U（「ユーザーがログオンしているかどうかにかかわらず実行する」）で動かす
# 非対話セッションで実行されるためコンソール窓が一切出ず
# -WindowStyle Hidden だけでは消せない PowerShell/conhost の一瞬のちらつきを解消できる
# S4U はパスワードの保存が不要（RunLevel Limited なので権限も昇格しない）
$principal = New-ScheduledTaskPrincipal `
    -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) `
    -LogonType S4U `
    -RunLevel Limited

# -Force で同名タスクを上書き登録する（設定変更後の再実行やパス変更時の再登録に対応）
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
