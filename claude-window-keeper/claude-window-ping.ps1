# Get-Help claude-window-ping.ps1 で表示される文字列
# ↓の空行2行は必須。詰めるとコメントベースヘルプと認識されなくなる


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
$logFile   = Join-Path $stateDir "ping.log"

# Ping はいまログイン中のアカウントの 5 時間枠を消費する。枠はアカウントごとに独立して
# いるため、最後に Ping した時刻もアカウント別に持たなければならない。1 つの state を
# 共有すると、アカウントを切り替えた直後に「まだ枠の途中」と誤判定して Ping を送らず、
# 枠の開始時刻を固定するというこのツールの目的が果たせなくなる。
#
# credentials にアカウント固有の識別子(uuid やメールアドレス)は無いため、プラン種別
# subscriptionType で代用する（組織は team、個人は pro / max）。
function Get-ClaudeAccount {
    $cred = Join-Path $env:USERPROFILE ".claude\.credentials.json"
    try {
        $t = (Get-Content $cred -Raw -ErrorAction Stop | ConvertFrom-Json).claudeAiOauth.subscriptionType
        # 値はファイル名の一部になるので、想定外の文字が来たら採用しない
        if ($t -and ($t -match '^[a-zA-Z0-9_-]+$')) { return $t }
    } catch {
        # 未ログイン・権限不足・将来の構造変更のいずれか。判別不能として 1 つにまとめる
    }
    return "unknown"
}

$account   = Get-ClaudeAccount
$stateFile = Join-Path $stateDir ("state-{0}.json" -f $account)

if (-not (Test-Path $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
}

# ログは追記され続けるため、この大きさを超えたら 1 世代だけ退避して作り直す
# （SKIP をファイルに残さない運用なら年に数十行程度で、通常ここには到達しない保険）
$logMaxBytes = 1MB

# ログ記載用func.
# -ConsoleOnly を付けた呼び出しは画面表示だけで、ファイルには残さない
function Write-Log([string]$msg, [switch]$ConsoleOnly) {
    # どのアカウントの枠を消費した Ping なのかを後から追えるようにする
    $line = "{0}  [{1}] {2}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $account, $msg
    Write-Host $line
    if ($ConsoleOnly) { return }

    # 追記前にサイズを見て、超過していれば ping.log.1 へ退避（前世代は破棄）
    if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt $logMaxBytes)) {
        Move-Item -Path $logFile -Destination ($logFile + ".1") -Force
    }
    Add-Content -Path $logFile -Value $line
}

# アカウント分離導入前は state.json（無印）1本だった名残。新パス state-<account>.json が
# 無いのに旧 state.json だけ残っている場合、これを読まずに起動すると $lastPing が $null の
# ままスキップ判定（150行目付近）を素通りしてしまい、次の毎時実行で本物の claude -p Ping が
# 送られて枠が意図しない時刻に張り直る。これはこのツールが防ぐべき事象そのものなので、
# 旧ファイルを読み元として引き継ぐ。
#
# ただしリネームによる「移行」はしない。旧形式にはどのアカウントの記録かが書かれておらず、
# たまたまログイン中だったほうへ移すと、実際に Ping していた側の前回時刻が失われる。
# 失った側は上に書いた素通りを起こし、移された側は打っていない Ping を打った扱いになる。
# どちらのアカウントで走っても読むだけにすれば、記録は消えず判定も働く。
#
# 旧記録はアカウント不明のまま使うので、別アカウントで走った回は「他方の Ping」を自分の
# ものと見て待つ側に倒れる。枠を意図しない時刻に張り直すより、待って次の毎時実行に回す
# ほうが害が小さいという判断。そのアカウントで一度 Ping すれば state-<account>.json が
# でき、以降は旧ファイルを見ない（旧ファイルは残るが、両方が揃えば手で消してよい）。
$legacyStateFile = Join-Path $stateDir "state.json"
$stateSource     = $stateFile
$usingLegacyState = $false
if ((Test-Path $legacyStateFile) -and (-not (Test-Path $stateFile))) {
    $stateSource = $legacyStateFile
    $usingLegacyState = $true
}

# 前回のPing時間をログから復元
$lastPing = $null
if (Test-Path $stateSource) {
    try {
        $state = Get-Content $stateSource -Raw | ConvertFrom-Json
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
    # 枠はアカウントごとに独立しているので、どのアカウントの状態を見ているかを最初に示す
    Write-Host ("Account        : " + $account)
    if ($usingLegacyState) {
        # 旧形式にはアカウントが書かれていない。下に出る前回時刻が、いま表示している
        # アカウントのものとは限らないことを明示する（他方のアカウントの Ping かもしれない）
        Write-Host ("State source   : state.json (legacy; account not recorded)")
    }
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

# アカウントを判別できない回は Ping を送らない。
#
# 枠はアカウントごとに独立しているので、判別できないまま送ると「どのアカウントの枠を
# いつ張り直したか」が追えなくなる。しかも state-unknown.json という別系統に記録が
# 分かれるため、本来のアカウント側は前回時刻を失ったままになる。移行済みで旧
# state.json も無い状況では $lastPing が $null になり、下のスキップ判定を素通りして
# 意図しない時刻に本物の Ping が飛ぶ ― このツールが防ぐべき事象そのものになる。
# -Force でも送らないのは、押し切っても「どの枠を張り直したのか」が分からないため。
# ログインし直せば解消するので、記録を汚さず見送るほうが安い。
if ($account -eq "unknown") {
    Write-Log "WARN  account not identified; ping skipped (log in, then re-run)"
    return
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
#
# 呼び出しの間だけ $ErrorActionPreference を Continue に落とす。
# Windows PowerShell 5.1 は Stop と 2>&1 を併用すると、外部コマンドが stderr に1行出しただけで
# 終了コード0でも NativeCommandError を投げる。それを catch して失敗扱いにすると
# 「送信して枠を消費したのに state を更新しない」状態になり、毎時の実行で再送が続いて
# 枠を数倍消費してしまう。そのため成否は例外ではなく終了コードで判定する。
$prevEap  = $ErrorActionPreference
$exitCode = $null
$reply    = $null
try {
    $ErrorActionPreference = "Continue"
    # ForEach-Object で文字列化するのは、2>&1 で混ざる ErrorRecord をそのまま Out-String に渡すと
    # 「At line:...」を含む複数行に展開され、ログ1行に収まらなくなるため
    $reply = & $claude.Source -p "Reply with only the word: ok" --model $Model 2>&1 |
             ForEach-Object { "$_" } | Out-String
    $exitCode = $LASTEXITCODE
} catch {
    # 実行ファイルが消えている等、終了コードすら得られないケース
    Write-Log ("ERROR ping failed: " + $_.Exception.Message)
    exit 1
} finally {
    $ErrorActionPreference = $prevEap
}

# 出力が空でも .Trim() が落ちないよう文字列に寄せてから整形する
$replyText = (("" + $reply).Trim() -replace '\s+', ' ')

# 非0終了は送信失敗。state を更新しないので次回の実行で再送される。
# ここを見ないと、認証切れやレート超過でも「送信できた」とログに残り、
# ウィンドウを固定できていないことに気づけない。
if ($exitCode -ne 0) {
    Write-Log ("ERROR ping failed (exit={0}): {1}" -f $exitCode, $replyText)
    exit 1
}
Write-Log ("PING  sent (model={0}); reply: {1}" -f $Model, $replyText)

# ログの更新
$now = Get-Date
# 旧 state.json を読み元にしていた回は、ここで初めてこのアカウント用のファイルができる。
# 記録は Ping を実際に送ったときだけなので毎時のログを埋めない（毎回出していた頃は、
# アカウントを判別できない環境では新ファイルが永久にできず、1日24行が延々と積もった）。
if ($usingLegacyState) {
    Write-Log ("STATE was reading legacy state.json (account not recorded); now writing " + (Split-Path $stateFile -Leaf))
}
@{ lastPing = $now.ToString("o") } | ConvertTo-Json | Set-Content -Path $stateFile
$reset = $now.AddMinutes($WindowMinutes)
Write-Log ("STATE lastPing updated; est. window reset at " + $reset.ToString("yyyy-MM-dd HH:mm:ss"))
