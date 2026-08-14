# 運用ドキュメント（Claude Window Keeper）

このファイルは、本ツールの設計判断・前提・運用実績・注意点を記録する運用者向けドキュメントです。
一般的な使い方は [README.md](./README.md) を参照。

- 作成日: 2026-07-22
- 検証環境: Windows 11 Home / Windows PowerShell 5.1 / Claude Code CLI（`claude`）
- 設置場所: 任意（スクリプトは自身の位置を `$PSScriptRoot` から解決するため、置き場所に依存しない）

---

## 1. 目的

Claude Code の 5 時間セッション制限（レートリミット）のウィンドウ開始時刻を、
規則的なタイミングで意図的に「最初の1発」を打つことで固定し、**リセット時刻を予測可能にする**。

上限そのものを増やす仕組みではない。あくまでリセットタイミングの可視化・安定化が目的。

---

## 2. 構成ファイル

| ファイル | 役割 |
|---|---|
| `claude-window-ping.ps1` | 本体。前回送信時刻と経過を判定し、必要なら `claude -p` を1発送信して時刻を記録 |
| `register-task.ps1` | タスクスケジューラへの登録／解除（非管理者時はUACで自己昇格） |
| `README.md` | 一般向け説明 |
| `OPERATIONS.md` | 本ドキュメント |
| `LICENSE` | MIT License |

配布時はこの4＋1ファイルをフォルダごと渡す。`.ps1` 2つが必須で、同一フォルダに置く必要がある
（`register-task.ps1` は `$PSScriptRoot` から ping スクリプトを探す）。それ以外の依存はない。

### 状態・ログの保存先

`%USERPROFILE%\.claude\window-keeper\`

| ファイル | 内容 |
|---|---|
| `state-<account>.json` | `{ "lastPing": "<ISO8601>" }` 前回送信時刻のみ。枠はアカウントごとに独立しているため、ログイン中のアカウント（`subscriptionType`）別にファイルを分ける。アカウント分離導入前の旧 `state.json`（無印）は読まない・引き継がない。新パスが無ければ「前回 ping なし」として素直に送信する |
| `ping.log` | 実行ログ（PING / STATE / WARN / ERROR / DRYRUN の追記）。毎時発生しうる `SKIP` は画面表示のみでファイルには残さない。アカウント判別不能の `WARN` は状態が変わったとき（＝初回）だけファイルに残し、以降は `state-unknown.notified` があるあいだ画面表示のみにする |
| `state-unknown.notified` | アカウント判別不能の `WARN` を初回通知済みかどうかの目印（中身は使わない）。判別できた回に削除され、次に判別不能へ戻ったとき改めて1行だけログに残る |
| `ping.log.1` | `ping.log` が 1 MB を超えたときの退避先（1世代のみ保持、以前の内容は破棄） |

---

## 3. 動作ロジック（ping 本体）

1. `state-<account>.json` から `lastPing` を読む（無ければ「前回 ping なし」扱い。旧 `state.json`（無印）は読まない）
2. `-Status`: 前回時刻・経過・推定リセット（`lastPing + WindowMinutes`）を表示して終了（送信・更新なし）
3. アカウントが `unknown`（未ログイン、`/login` 中、別ユーザー資格での実行など）→ `WARN` を出して終了。`state-unknown.notified` が無ければファイルにも残して作成し、あれば画面のみに留める。`-Force` でも送らない
4. `-Force` でない かつ 経過 < `WindowMinutes` → `SKIP` を画面表示して終了（ファイルには残さない）
5. `-DryRun`: 送信・状態更新をせずログのみ
6. それ以外: `claude -p "Reply with only the word: ok" --model <Model>` を実行
7. 成功したら `state-<account>.json` を現在時刻で更新し、推定リセット時刻をログ出力

**設計上のポイント**
- 「送るかどうか」の判断はすべて ping 本体が持つ。タスクは単に頻繁に叩くだけ（冪等）。
- そのため 1 時間ごとに起動しても、5 時間未満なら必ず SKIP されコストは発生しない。
- `-DryRun` / `-Status` は状態を汚さないため、検証に安全に使える。
- 旧 `state.json`（無印）は一切読まない。team で運用してきた環境で個人アカウントに
  切り替えた直後など、旧ファイルを読んで別アカウントの `lastPing` を「まだ枠の途中」と
  誤読すると、ping を送らないまま枠が張り直されない。しかもその回は `SKIP` で終わるため
  `ping.log` には何も残らず、気付く手掛かりがない（このツールが最も避けたい事象）。新パスが無いときは素直に「前回 ping なし」として送信する。
  失うのはアップグレード直後の余分な ping 1 回だけ。
- **`unknown` の回はそもそも ping を送らない。** 枠はアカウントごとに独立しているので、
  判別できないまま送ると「どの枠をいつ張り直したか」が追えず、記録も `state-unknown.json`
  へ分かれてしまう。ログインし直せば解消するので見送るほうが安い。
- **`unknown` の WARN は初回だけファイルに残す。** 判別不能は SKIP と同じく毎時発生しうるが、
  SKIP と違って一時的とは限らない（新しいマシン、資格情報を別の場所に置いた、権限エラーなど
  原因が持続しうる）。毎時ファイルに残せば SKIP 同様 PING/STATE の履歴を押し出してしまうが、
  一切残さなければ「タスクが動いていない」のと見分けがつかず無音のまま気付けない。そこで
  `state-unknown.notified` が無いとき（＝状態が変わった直後）だけファイルに残してマーカーを作り、
  以降はマーカーがあるあいだ画面のみにする。アカウントを判別できた回にマーカーを消すため、
  次にまた判別不能になれば改めて1行だけログに残る。
- **判定の順序は 2 → 4 → 5。** SKIP 判定（4）が DryRun 判定（5）より先に来るため、
  記録がある状態で `-DryRun` 単体を実行すると SKIP で終了し DRYRUN 行に到達しない。
  送信処理の流れを検証したいときは `-Force -DryRun`（送信・記録なし）を使う。
- **成否は例外ではなく `$LASTEXITCODE` で判定する。** 理由は下の「9. 配布時の前提・注意」の
  「PowerShell 5.1 の stderr 挙動」を参照。

---

## 4. タスクスケジューラ設定（register-task.ps1）

- タスク名: `ClaudeWindowKeeper`
- 実行ユーザー: 現在のユーザー
- トリガー:
  - **AtLogOn**（ログオン時に再アンカー）
  - **Once + RepetitionInterval = IntervalHours（既定1時間）**、Duration 3650 日
- 設定: `-StartWhenAvailable`（取りこぼし後追い実行）, `-AllowStartIfOnBatteries`, `-DontStopIfGoingOnBatteries`, 実行時間上限 10 分
- 実行コマンド: `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File <ping.ps1> -WindowMinutes <n> -Model <m>`

### 管理者権限（重要）

この環境では `Register-ScheduledTask` が **アクセス拒否（HRESULT 0x80070005）** になった。
対策として register-task.ps1 の冒頭に**自己昇格処理**を追加済み:
非管理者で起動された場合、`Start-Process -Verb RunAs` で UAC を要求し、同じ引数で自分を再実行して return する
（昇格ウィンドウは `-NoExit` で結果確認のため残す）。

登録確認:
```powershell
Get-ScheduledTask -TaskName ClaudeWindowKeeper | Select-Object TaskName,State
# State = Ready で成功
```

---

## 5. トークン消費 実測値（2026-07-22, model=haiku）

`claude -p "Reply with only the word: ok" --model haiku --output-format json` の `usage`:

| 項目 | 値 |
|---|---:|
| input_tokens（新規入力） | 10 |
| cache_creation_input_tokens | 7,445 |
| cache_read_input_tokens | 21,599 |
| output_tokens | 157 |
| 合計処理トークン | 約 29,200 |
| total_cost_usd | 約 $0.0184 |

**結論:** プロンプト本文は 10 トークンだが、Claude Code のシステムプロンプト＋ツール定義が毎回乗るため、
実処理は約 3 万トークン規模。プロンプトを短くしてもこの固定分は削れない。
実送信は 5 時間に 1 回のため、1 日あたり最大 4〜5 回 ≒ 約 $0.09 相当。

### cache_read について（よくある誤解）

- `cache_read_input_tokens`（約 21,600）は「無駄に読んでいる」ものではなく、**Claude Code 自身のシステムプロンプト＋ツール定義**。これが無いと Claude は動作できない固定の土台であり、`-p "ok"` のような最小プロンプトでも省略不可。
- キャッシュは**コストを増やす仕組みではなく、割引で読むための仕組み**。cache_read は通常入力の約 1/10 の単価。キャッシュを無効化すると同じ量が**フル課金**になり逆に高くなる。つまり cache_read 比率が高い＝安く済んでいる状態。
- **この ping はこの対話（設定作業中の会話）とは完全に無関係。** `claude -p` は独立した新規セッションとして起動するため、会話ログは一切乗らない。上記の実測値がそのまま「素の 1 回分」であり、会話が長い/短いで変動しない。
- コストを下げたい場合、単価ではなく**送信回数**（`-WindowMinutes` を延ばす）で調整するのが唯一有効。

---

## 5-1. プラン別のレート上限の目安（2026-07 時点）

**重要:** Anthropic は**どのプランも「合計トークン数」での上限を公表していない**。公式は相対倍率（Pro=1x、Premium=Standard の 5x 等）と「Web/デスクトップ/Claude Code が同一枠を共有」という説明のみ。消費速度が会話長・複雑さ・モデル・機能で変動するため、固定トークン数では表現されない。

| 項目 | 内容 |
|---|---|
| Standard seat の Claude Code | **利用可**（公式 pricing: "Includes Claude Code and Claude Cowork"）。※以前は Premium 限定という記事が多かったが現在は Standard でも可 |
| Standard の使用量 | Pro より多い枠。Premium seat はその 5 倍 |
| 5 時間枠 | 2026-05-06 に恒久 2 倍化 |
| 週次枠 | 5 時間枠とは**別建て**。**アカウントごとに固定の曜日・時刻**にリセット（ユーザーは選べない）。2026-05-13〜07-13 は +50% の期間限定増量あり |

### 目安（すべて非公式・独立検証レンジ、公式値ではない）

| 枠 | Pro(1x) | Team Standard | Team Premium(5x) |
|---|---|---|---|
| 5 時間・プロンプト数 | 約 10〜45 | Pro よりやや多い | 約 225 |
| 週次 | 約 40〜80 Sonnet 時間 | 中間 | 大幅増 |

- Team Premium ≒「5 時間で約 225 メッセージ」との情報。Standard はその約 1/5 ＝ **5 時間で 40〜45 プロンプト規模**が現実的な目安。
- **正確なトークン総数はユーザー側から取得不可**。本ツールの「時刻記録＝逆算方式」を採るのもこのため。

出典（いずれも 2026-07 参照、非公式ページ含む）:
- claude.com/pricing（Standard seat が Claude Code を含む旨）
- truefoundry.com/blog/claude-code-limits-explained（プロンプト数レンジ、非公式実測）
- ccforeveryone.com/guides/claude-code-limits-and-pricing（「Anthropic は正確なトークン数を非公表」）

---

## 6. 前提と不確実性

- **前提:** レートリミットは「最初の1発から5時間の固定ウィンドウ」として振る舞う（実運用報告の主流）。
  → **2026-08-11 に実測で裏付けた**（下記 6-1）。完全ローリングではない。
- **未確定:** 週次制限の正確な仕様、`--max-budget-usd` 等オプションの確実性（未使用）。
- 機械可読なレート制限残量の取得手段は確実なものが無く、こちら側での時刻記録＝逆算方式を採用。
  → **これは本ツール単体での話。** 別ツール usage-tracker が `~/.claude/usage-tracker/usage.jsonl` に
  サーバー由来のリセット時刻を記録しており、そちらは逆算ではなく実測値である（下記 6-1）。

### 6-1. リセット時刻は10分グリッドに丸められる（2026-08-11 実測）

`usage.jsonl` の `five_reset`（epoch 秒）を全期間ぶん集計したところ、**分は例外なく
00/10/20/30/40/50、秒は必ず 00** だった（team / pro / max の3アカウントで共通）。
つまりサーバー側がリセット時刻を10分単位に丸めている。

**端数は連続使用中そのまま引き継がれる。** 枠が切れた直後に作業を続けると、新しい枠のリセットが
「前の枠のリセット + 5時間ちょうど」になる（実測: `01:20` → `06:20`、`00:00` → `05:00`）。
間を空けて再開すると、その再開時刻の10分グリッドに乗り直す（実測: `19:50` → `01:20` は 5h30m 差）。
リセット時刻が5時間ちょうどの間隔で並ぶこと自体が、固定ウィンドウ説の裏付けになっている。

**この丸めの存在は、`-Status` の推定がズレる二次的な要因にすぎない。主因は下記 6-2 の設計上の限界。**

### 6-2. `-Status` はユーザー自身が始めた枠を検出できない（既知の限界）

ping スクリプトは `lastPing + WindowMinutes` でしか推定しない。**ユーザーが手動で Claude Code を
使い始めて枠が開始した場合、その時刻を知る手段が無い**ため、推定リセット時刻が実際と大きくずれる。

2026-08-11 の実測例:

| ソース | 次のリセット |
|---|---|
| `usage.jsonl` の `five_reset`（サーバー由来） | **06:20** |
| `-Status` の推定（last ping 03:01 + 5h） | 08:01 |

**1時間41分のズレ。** 経緯は、ユーザーが 01:2x に作業を再開して枠が始まり（→ 06:20 リセット）、
その途中の 03:01 に ping が飛んだため。ping 側は「自分が枠を開始した」と解釈して 08:01 を推定した。

この状態では 06:20 に枠が切れても次の ping は 08:01 まで飛ばず、**約1時間40分ぶん枠が張られない
空白**が生まれる。ツールの目的（リセット時刻を予測可能にする）に対する正面からの弱点である。

**改善案（未着手）:** `usage.jsonl` の `five_reset` が存在すればそれを優先して読み、
無いときだけ従来の逆算にフォールバックする。推定が実測に置き換わり、6-1 の丸めも自動的に吸収される。
ただし usage-tracker への依存が増えるため、任意依存（あれば使う）として実装すること。

---

## 7. 検証済み事項（2026-07-22）

- 両スクリプトの構文パス（PowerShell Parser）: OK
- `-DryRun` / `-Status`: 期待通り（状態を更新しない）
- `-Force` 実送信: `reply: ok`、state ファイル（当時は無印 `state.json`。現在はアカウント別の `state-<account>.json`）更新、推定リセット表示を確認
- `--output-format json` でトークン実測を取得
- タスク登録: UAC 昇格経由で成功、`State = Ready` を確認

### 配布前レビューで追加検証した事項（2026-07-27）

- 両スクリプトの構文（PS 5.1 パーサ）: OK
- `Get-Help` でコメントベースヘルプが認識され、パラメータ 5 件ずつ取得できることを確認
- `.ps1` は working tree・git index の blob ともに UTF-8 BOM（`EF BB BF`）付きであることを確認
- `New-ScheduledTaskSettingsSet` の `MultipleInstances` 既定は `IgnoreNew`
  → AtLogOn と定期トリガーが同時に発火しても二重送信にはならない
- 登録済みタスクの実体: `State=Ready` / `LastTaskResult=0` / Repetition `PT1H/P3650D` /
  S4U・Limited / `NumberOfMissedRuns=0`
- SKIP をファイルに残さない変更が有効であることをログで確認（変更後に SKIP 行の増加なし）
- `$ErrorActionPreference` と stderr / 終了コードの挙動 → 下記「9. 配布時の前提・注意」に記録し対処済み

### つまずきポイントの記録

- `!` 実行（Git Bash 経由）では Windows パスの `\` が消え、`C:claude...` になり `-File` が失敗した。
  → パスは **フォワードスラッシュ `/`** で渡すこと。
- タスク登録は管理者必須 → 自己昇格処理で対応済み。
- `-DryRun` 単体では、記録がある間は SKIP 判定が先に走って DRYRUN 行に到達しない。
  → 検証には `-Force -DryRun` を使う。

---

## 8. 変更・運用手順

```powershell
# 送信間隔を変える（例: 6時間ごと）
powershell -File ".\register-task.ps1" -Unregister
powershell -File ".\register-task.ps1" -WindowMinutes 360

# チェック頻度を変える（例: 2時間ごとにチェック）
powershell -File ".\register-task.ps1" -Unregister
powershell -File ".\register-task.ps1" -IntervalHours 2

# 停止
powershell -File ".\register-task.ps1" -Unregister
```

挙動に違和感が出たら `ping.log` のタイムスタンプと Claude Code 内 `/usage` を突き合わせ、
`-WindowMinutes` を調整する。

---

## 9. 配布時の前提・注意

他人の環境へ渡す前提で洗い出した、環境依存になりうる箇所と結論。

| 箇所 | 環境依存性 | 結論 |
|---|---|---|
| スクリプトの設置場所 | `$PSScriptRoot` / `$env:USERPROFILE` のみ使用。絶対パスの埋め込みなし | 依存しない |
| 状態・ログ | 常に `%USERPROFILE%\.claude\window-keeper\` | ユーザー単位で分離。PC間で共有されない |
| `claude` の解決 | PATH → `%USERPROFILE%\.local\bin\claude.exe` → `%APPDATA%\npm\claude.cmd` の順 | 他の場所に入れている人は PATH 設定が必要（README 9章のFAQに記載） |
| 登録タスクの実行コマンド | `Register-ScheduledTask` に**絶対パスが焼き込まれる** | フォルダ移動・リネーム後は `register-task.ps1` の再実行が必要（README 5章 STEP 3 の注記） |
| 実行ユーザー | `"{USERDOMAIN}\{USERNAME}"` + LogonType S4U | ローカル/Microsoft アカウントで動作確認済み。ドメイン参加環境では未検証 |
| ファイルのブロック印 | ZIP 配布時に Zone.Identifier が付く | `-ExecutionPolicy Bypass` で回避されるが、README に `Unblock-File` の案内を記載 |
| 文字エンコーディング | `.ps1` は **UTF-8 with BOM**（日本語コメントを含むため） | BOM なしにすると Windows PowerShell 5.1 が ANSI と誤認しコメントが化ける。編集時は BOM を保持すること |

配布物に含めないもの: `.claude/settings.local.json`（この作業環境専用の権限許可リスト。リポジトリルートの `.gitignore` で除外済み）。

### PowerShell 5.1 の stderr 挙動（対処済み・再発させないための記録）

Windows PowerShell 5.1 は `$ErrorActionPreference = "Stop"` と `2>&1` を併用すると、
**外部コマンドが stderr に1行出力した時点で、終了コードが 0 でも `NativeCommandError` を投げる。**

```powershell
$ErrorActionPreference = "Stop"
& cmd.exe /c "echo warning-to-stderr 1>&2 & exit /b 0" 2>&1 | Out-String
# → THROWN: RemoteException: warning-to-stderr   （exit 0 なのに例外）
```

当初の実装は `claude` の呼び出しを `2>&1 | Out-String` で受けて try/catch で囲んでいたため、
この挙動を踏むと **ping は実際に送信されて枠を消費したのに catch に落ちて state ファイル（`state-<account>.json`）を更新しない**
状態になっていた。すると次の毎時実行でも「経過 ≧ WindowMinutes」のままなので real ping を毎時送り続け、
**1 日 4〜5 回のはずが最大 24 回（枠とコストが約 5 倍）** になる。ログには ERROR しか残らず原因も追いにくい。

あわせて、**非 0 終了は例外にならない**ことも確認した。

```powershell
& cmd.exe /c "echo failed-output & exit /b 1" 2>&1 | Out-String
# → 例外にならず $LASTEXITCODE = 1
```

そのため終了コードを見ないと、認証切れ・ネットワーク断・レート超過で失敗しても
`PING sent; reply: <エラー文>` とログに残り state が更新され、
**ウィンドウを固定できていないのに固定できたと誤認する**。

**対処:** `claude` 呼び出しの間だけ `$ErrorActionPreference` を `Continue` に落とし（`finally` で復帰）、
成否は `$LASTEXITCODE` で判定する形に変更した。stderr は `2>&1` で受けたうえで
`ForEach-Object { "$_" }` で文字列化してからログに載せる（ErrorRecord をそのまま `Out-String` に渡すと
「At line:...」を含む複数行に展開され、ログ 1 行に収まらないため）。

なお検証時点の `claude` 2.1.220 は `--version` の stderr が空であり、この不具合は顕在化していなかった。
つまり **`claude` 側の出力仕様が変わった瞬間に初めて壊れる潜在バグ**だった。MCP サーバの接続警告や
アップデート通知が stderr に出れば即発生するため、`claude` を外部コマンドとして呼ぶ箇所では
この形（EAP を退避して終了コードで判定）を維持すること。
