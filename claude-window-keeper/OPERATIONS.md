# 運用ドキュメント（Claude Window Keeper）

このファイルは、本ツールの設計判断・前提・運用実績・注意点を記録する運用者向けドキュメントです。
一般的な使い方は [README.md](./README.md) を参照。

- 作成日: 2026-07-22
- 対象環境: Windows 11 Home / PowerShell / Claude Code CLI（`claude`）
- 設置場所: `C:\claude\claude-window-keeper\`

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

### 状態・ログの保存先

`%USERPROFILE%\.claude\window-keeper\`

| ファイル | 内容 |
|---|---|
| `state.json` | `{ "lastPing": "<ISO8601>" }` 前回送信時刻のみ |
| `ping.log` | 実行ログ（SKIP / PING / STATE / ERROR / DRYRUN の追記） |

---

## 3. 動作ロジック（ping 本体）

1. `state.json` から `lastPing` を読む
2. `-Status`: 前回時刻・経過・推定リセット（`lastPing + WindowMinutes`）を表示して終了（送信・更新なし）
3. `-Force` でない かつ 経過 < `WindowMinutes` → `SKIP` ログを残して終了
4. `-DryRun`: 送信・状態更新をせずログのみ
5. それ以外: `claude -p "Reply with only the word: ok" --model <Model>` を実行
6. 成功したら `state.json` を現在時刻で更新し、推定リセット時刻をログ出力

**設計上のポイント**
- 「送るかどうか」の判断はすべて ping 本体が持つ。タスクは単に頻繁に叩くだけ（冪等）。
- そのため 1 時間ごとに起動しても、5 時間未満なら必ず SKIP されコストは発生しない。
- `-DryRun` / `-Status` は状態を汚さないため、検証に安全に使える。

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

## 5-1. 契約プランのレート上限（Team / Standard seat, 2026-07 時点）

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
- **不確実性:** 一部情報では「完全なローリングウィンドウ（各リクエストが個別に5時間で失効）」との記述もある。
  完全ローリングなら「リセット時刻の完全固定」は原理的に不可。ただしツール自体は無害。
- **未確定:** 週次制限の正確な仕様、`--max-budget-usd` 等オプションの確実性（未使用）。
- 機械可読なレート制限残量の取得手段は確実なものが無く、こちら側での時刻記録＝逆算方式を採用。

---

## 7. 検証済み事項（2026-07-22）

- 両スクリプトの構文パス（PowerShell Parser）: OK
- `-DryRun` / `-Status`: 期待通り（状態を更新しない）
- `-Force` 実送信: `reply: ok`、`state.json` 更新、推定リセット表示を確認
- `--output-format json` でトークン実測を取得
- タスク登録: UAC 昇格経由で成功、`State = Ready` を確認

### つまずきポイントの記録

- `!` 実行（Git Bash 経由）では Windows パスの `\` が消え、`C:claude...` になり `-File` が失敗した。
  → パスは **フォワードスラッシュ `/`** で渡すこと。
- タスク登録は管理者必須 → 自己昇格処理で対応済み。

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
