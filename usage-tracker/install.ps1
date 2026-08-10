# usage-tracker の収集フックを statusline.js に組み込む。
#
# 使用率(5h/7d)は statusline に渡される JSON にしか現れないため、収集は statusline に
# 相乗りするしかない。ただし claude-statusline は独立したツールなので、そちら側の
# ソースには手を入れず「配置済みの statusline.js の末尾に追記する」形を取る。
# 末尾に置くのは、表示を出し切ったあとに副作用を走らせるためと、追記位置の特定が
# 不要でインストールが壊れにくいため。
#
# 冪等。既に入っていれば何もしない。-Force で古いブロックを消して入れ直す。
# claude-statusline を再デプロイするとこのブロックは消えるので、そのときは再実行する。

[CmdletBinding()]
param(
  # 既定は Claude Code が実際に起動する配置済みファイル。リポジトリ側のソースではない。
  [string]$StatuslinePath = (Join-Path $env:USERPROFILE '.claude\statusline.js'),
  [switch]$Force,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

# collect.js はこのスクリプトと同じディレクトリにある。require はスラッシュ区切りを要求する。
$collector = (Join-Path $PSScriptRoot 'collect.js')
if (-not (Test-Path $collector)) { throw "collector not found: $collector" }
$collectorForRequire = (Resolve-Path $collector).Path.Replace('\', '/')

if (-not (Test-Path $StatuslinePath)) { throw "statusline not found: $StatuslinePath" }

# ブロックの境界。アンインストールと再インストールで同じ目印を使う。
$beginMark = '// --- usage-tracker hook (begin) ---'
$endMark   = '// --- usage-tracker hook (end) ---'

$hook = @"
$beginMark
// プラン利用枠(5h/7d)の使用率は statusline の入力にしか現れず、transcript にも残らないため
// 後から復元できない。表示を出し終えたこの位置で時系列として書き出しておく。
// 表示とは無関係な副作用なので、収集側が壊れていても statusline の出力には影響しない。
try {
  require(process.env.CLAUDE_STATUSLINE_HOOK || '$collectorForRequire').record(d);
} catch (e) {
  /* 収集は捨てて表示を優先する */
}
$endMark
"@

# -Raw は空ファイルに対して $null を返す。そのまま .Contains() を呼ぶと
# 「null 値の式でメソッドを呼び出せません」で落ちるので、ここで空文字に正規化する。
$content = (Get-Content -Path $StatuslinePath -Raw -Encoding utf8)
if ($null -eq $content) { $content = '' }

# 既存ブロックを取り除いた本体。マーカー前の改行も一緒に落として空行が増えないようにする。
function Remove-HookBlock([string]$text) {
  $pattern = "(\r?\n)*" + [regex]::Escape($beginMark) + "[\s\S]*?" + [regex]::Escape($endMark) + "(\r?\n)*"
  return [regex]::Replace($text, $pattern, "`n")
}

# 過去バージョンのマーカー(begin/end で囲っていなかった頃のもの)も掃除対象にする。
# StrictMode 下でも未定義参照にならないよう明示的に初期化しておく。
$legacyFound = $false
$legacyMark = '// --- usage-tracker hook (installed by'
if ($content -like "*$legacyMark*") {
  $legacyPattern = "(\r?\n)*" + [regex]::Escape($legacyMark) + "[\s\S]*?\}\s*$"
  $content = [regex]::Replace($content, $legacyPattern, "`n")
  $legacyFound = $true
}

# マーカーの有無だけを見ると、claude-statusline に同梱されたフォールバック版フック
# (絶対パスを焼き込まず __dirname 相対 → CLAUDE_PROJECT_DIR にフォールバックするだけの版)
# も「インストール済み」と誤判定してしまう。同梱版は他プロジェクトで動かした回の
# usage.jsonl 記録が欠落するので、ここでは自分がこれから焼き込む絶対パス
# ($collectorForRequire)がブロック中に実在するかまで確認し、それが無ければ
# 「未インストール」とみなして本来のブロックへ置き換える。
# パスには `[` `]` などの -like ワイルドカード扱いされる文字が入り得るため、
# パターンマッチではなく厳密な部分文字列一致の .Contains() を使う。
$hasBeginMark = $content.Contains($beginMark)
$installed = $hasBeginMark -and $content.Contains($collectorForRequire)

if ($Uninstall) {
  # アンインストールはマーカーの有無だけで判断する。同梱フォールバック版であっても
  # begin/end で囲まれている以上 Remove-HookBlock で構造的に除去できるため。
  if (-not $hasBeginMark -and -not $legacyFound) { Write-Host 'not installed; nothing to do'; exit 0 }
  $backup = "$StatuslinePath.bak-usage-tracker"
  Copy-Item -Path $StatuslinePath -Destination $backup -Force
  $out = (Remove-HookBlock $content).TrimEnd() + "`n"
  Set-Content -Path $StatuslinePath -Value $out -Encoding utf8 -NoNewline
  Write-Host "uninstalled. backup: $backup"
  exit 0
}

if ($installed -and -not $Force) {
  Write-Host "already installed: $StatuslinePath"
  Write-Host "  collector: $collectorForRequire"
  Write-Host '  use -Force to reinstall (e.g. after redeploying statusline.js)'
  exit 0
}

$backup = "$StatuslinePath.bak-usage-tracker"
Copy-Item -Path $StatuslinePath -Destination $backup -Force

$body = (Remove-HookBlock $content).TrimEnd()
$out = "$body`n`n$hook`n"
# -NoNewline は「末尾に余計な改行を足さない」意味。$out 自身が改行で終わっている。
Set-Content -Path $StatuslinePath -Value $out -Encoding utf8 -NoNewline

# 構文が壊れていないかだけは必ず確かめる。ここを通さないと毎ターン statusline が消える。
& node --check $StatuslinePath
if ($LASTEXITCODE -ne 0) {
  Copy-Item -Path $backup -Destination $StatuslinePath -Force
  throw 'syntax check failed; restored from backup'
}

Write-Host "installed: $StatuslinePath"
Write-Host "  collector: $collectorForRequire"
Write-Host "  backup:    $backup"
Write-Host "  log:       $(Join-Path $env:USERPROFILE '.claude\usage-tracker\usage.jsonl')"
