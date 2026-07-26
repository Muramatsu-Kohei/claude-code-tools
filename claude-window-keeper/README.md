# Claude Window Keeper

**Claude Code の「5時間ごとの利用上限（レートリミット）」がいつリセットされるかを、自分で予測できるようにするツールです。**

決まったタイミングで自動的にごく短いメッセージを1回送ることで、5時間ウィンドウの「開始時刻」を規則正しく固定し、「あと何時間でリセットされるか」を常に把握できるようにします。

---

## 1. 背景：なぜこれが必要なのか

Claude Code には「5時間ごとの利用上限」があります。この上限には、あまり知られていない重要な性質があります。

> **5時間のカウントは、そのセッションで最初のメッセージを送った瞬間から始まります。**

つまり、

- 朝10時に最初のメッセージを送れば → その日のウィンドウは **10:00〜15:00**
- たまたま昼13時に始めれば → ウィンドウは **13:00〜18:00**

というように、**リセット時刻は「あなたがいつ最初に触ったか」で毎回バラバラに決まります**。これだと「あと何時間使えるか」「いつ回復するか」が読めず、上限に達したときに困ります。

**このツールは、毎日決まったタイミング（PC起動時など）で自動的に最初の1発を打っておくことで、ウィンドウの開始・リセット時刻を予測可能にします。**

---

## 2. 何をするツールなのか（動作の要約）

1. 「前回メッセージを打った時刻」を記録しておく
2. **前回から5時間以上たっていたら**、`ok` と返すだけの最小メッセージを1回だけ自動送信する
3. まだ5時間たっていなければ、**何もしない**（枠を無駄づかいしない）
4. これを Windows の「タスクスケジューラ」で **PCログオン時＋1時間ごと**に自動チェックする

PCが消えていた・スリープしていた時間帯にタイミングが来ても、起動後に取りこぼしを拾って実行します。

---

## 3. 必要なもの

- Windows 10 / 11
- Windows PowerShell（標準搭載）
- **Claude Code の CLI（`claude` コマンド）がインストール済みで、PATH が通っていること**
  - 確認：PowerShell で `claude --version` が表示されればOK

---

## 4. インストールと初回セットアップ

このフォルダ（`claude-window-keeper`）を任意の場所に置きます。以下の例では `C:\claude\claude-window-keeper` にある前提です。

> **メモ：** PowerShell では Windows のパス区切り `\` が場面によって消えることがあります。
> コマンドプロンプトや Git Bash 経由で叩くときは、パスを **フォワードスラッシュ `/`** で書くと確実です。

### STEP 1 — まず「送らずに」動作確認する（トークンを消費しません）

```powershell
# ロジックだけ確認（実際には送信しない）
powershell -ExecutionPolicy Bypass -File "C:/claude/claude-window-keeper/claude-window-ping.ps1" -DryRun

# 現在の状態を表示
powershell -ExecutionPolicy Bypass -File "C:/claude/claude-window-keeper/claude-window-ping.ps1" -Status
```

### STEP 2 — 手動で1回だけ打ってみる（ここで初めてトークンを消費）

```powershell
powershell -ExecutionPolicy Bypass -File "C:/claude/claude-window-keeper/claude-window-ping.ps1" -Force
```

`PING sent (model=haiku); reply: ok` と表示され、推定リセット時刻が出れば成功です。

### STEP 3 — 自動実行を登録する

```powershell
powershell -ExecutionPolicy Bypass -File "C:/claude/claude-window-keeper/register-task.ps1"
```

- **UAC（管理者確認）のダイアログが出たら「はい」を選んでください。** タスク登録には管理者権限が必要です。
- 管理者ウィンドウが別途開き、そこに登録結果が表示されます。

登録できたか確認：

```powershell
powershell -Command "Get-ScheduledTask -TaskName ClaudeWindowKeeper | Select-Object TaskName,State"
```

`State` が `Ready` なら完了です。以降は自動で動きます。

---

## 5. 日常的に使うコマンド

```powershell
# いまの状態・推定リセット時刻を見る
powershell -ExecutionPolicy Bypass -File "C:/claude/claude-window-keeper/claude-window-ping.ps1" -Status

# 実行ログを見る
powershell -Command "Get-Content $env:USERPROFILE\.claude\window-keeper\ping.log -Tail 20"
```

`-Status` の表示例：

```
Last ping      : 2026-07-22 02:16:58
Elapsed        : 45 min
Window length  : 300 min
Est. reset at  : 2026-07-22 07:16:58
State          : 255 min until next ping is due
```

---

## 6. 設定オプション

### `claude-window-ping.ps1`

| オプション | 既定 | 説明 |
|---|---|---|
| `-WindowMinutes` | `300` | ウィンドウの長さ（分）。5時間＝300。長くすると送信回数が減る |
| `-Model` | `haiku` | 送信に使うモデル。最安の `haiku` 推奨 |
| `-Force` | off | 経過時間を無視して今すぐ送信 |
| `-Status` | off | 状態表示のみ（送信・記録なし） |
| `-DryRun` | off | ロジック確認のみ（送信・記録なし。トークン消費ゼロ） |

### `register-task.ps1`

| オプション | 既定 | 説明 |
|---|---|---|
| `-TaskName` | `ClaudeWindowKeeper` | タスク名 |
| `-IntervalHours` | `1` | 何時間ごとにチェックするか |
| `-WindowMinutes` | `300` | ↑と同じ（タスクに引き継がれる） |
| `-Model` | `haiku` | ↑と同じ |
| `-Unregister` | off | タスクを削除する |

**例：6時間ごと運用にして送信回数をさらに減らす**

```powershell
powershell -ExecutionPolicy Bypass -File "C:/claude/claude-window-keeper/register-task.ps1" -Unregister
powershell -ExecutionPolicy Bypass -File "C:/claude/claude-window-keeper/register-task.ps1" -WindowMinutes 360
```

---

## 7. トークンとコストの目安

`-p "ok"` という最小メッセージでも、Claude Code は毎回システムプロンプトとツール定義を一緒に送るため、見た目より多くのトークンを処理します（実測値）。

| 項目 | 1回あたり |
|---|---:|
| 新規入力（プロンプト本文） | 約 10 トークン |
| システム側（キャッシュ書き込み＋読み込み） | 約 29,000 トークン |
| 応答 | 約 150 トークン |
| **コスト** | **約 $0.018／回**（Haiku・キャッシュ込み） |

実際の送信は5時間に1回なので、**1日あたり最大4〜5回＝約 $0.09 相当**が目安です。サブスクリプション利用の場合は金銭ではなく利用枠を微量消費します。気になる場合は `-WindowMinutes` を延ばして回数を減らしてください。

> **「約29,000トークンは減らせない？」について**
> この約29,000トークン（`cache_read`）はプロンプトや過去の会話ではなく、**Claude Code自身のシステムプロンプト＋ツール定義**です。Claudeが動くために毎回必要な固定の土台で、省略できません。しかも `cache_read` は通常入力の**約1/10の単価**で処理される「割引読み込み」であり、キャッシュを止めるとむしろ高くなります。またこの送信は独立した新規セッションなので、**あなたの他の会話ログは一切含まれません**。コストは送信回数（`-WindowMinutes`）でしか下げられません。

### 参考：レートリミットの上限について

Anthropic は**どのプランも「合計トークン数」での上限を公表していません**（公式は相対倍率のみ）。Team の Standard seat は Claude Code を利用可能で、使用量は Pro より多く、Premium seat はその5倍です。5時間枠・週次枠は別建てで、週次はアカウントごとに固定の時刻にリセットされます。非公式な実測目安では **Standard は5時間あたり40〜45プロンプト規模**とされますが、正確なトークン総数はユーザー側からは取得できません（詳細は [OPERATIONS.md](./OPERATIONS.md) の 5-1 節）。

---

## 7-1. このツールの負荷は無視できるレベルか？（結論：はい）

「毎回3万トークンも使うなら、リミットをかなり圧迫するのでは？」と不安に思うかもしれません。実際にリミットと比べると、負荷はごくわずかです。

### 5時間の枠に対して

| | 値 |
|---|---|
| 5時間枠の容量（目安） | 約 40〜45 プロンプト |
| このツールの消費 | **枠あたり最大 1 プロンプト** |
| 占有率 | **約 2〜2.5%** |

しかも、あなたが普通に Claude Code を使えば、その最初のメッセージが枠を開始するので **ping は自動的にスキップ**されます。ping が実際に送信するのは「その5時間、あなたが一度も使わなかったとき」だけ。実質、**枠の先頭の1発を少しだけ先取りしているにすぎません。**

### 週次の枠に対して（本当の制約はこちら）

ping は最も安い haiku モデルの極小メッセージなので、週次枠に対してもほとんど計上されません。

| ケース | 週あたりの送信回数 | 目安 |
|---|---|---|
| 最悪（PCを24時間つけっぱなし＆Claudeを一切使わない） | 約 33 回 | それでも週上限の **1% 未満** |
| 現実的（普段から自分でも使う → 大半がスキップ） | 5〜15 回 | さらに小さい |

### 結論

- **5時間枠**：1枠につき最大1発（約2%）。自分で使えばスキップされる → **無視できる**
- **週次枠**：最悪でも1%未満、通常はさらに小さい → **無視できる**
- haiku かつ大半が割引読み込みのため、重い枠（Opus/Sonnet の利用枠）をほとんど消費しない

**このツールの負荷は「リセット時刻が予測できる」という利点に対して十分に軽く、コストを理由に外す必要はありません。** それでも気になる場合は `-WindowMinutes 360`（6時間ごと）などにすれば、送信回数が減り負荷は完全に無視できる領域になります。

> **唯一の例外：** 週次上限にギリギリまで張り付く超ヘビーユーザーで、かつPCを常時起動しつつClaudeを使わない日が多い、という組み合わせのときだけは一考の余地があります。ただしその場合でも haiku の ping は誤差の範囲です。

---

## 8. よくある質問（FAQ）

**Q. これで利用上限そのものが増えるの？**
いいえ。上限は変わりません。**リセットの「タイミングを予測可能にする」**だけのツールです。

**Q. 使わない日も勝手にトークンを消費する？**
はい、規則的に少量消費します。それが「ウィンドウを既知の状態に保つ」というこのツールの目的です。不要な期間は STEP の `-Unregister` で自動実行を止められます。

**Q. `-Status` のリセット時刻はどこまで正確？**
「前回送信時刻＋5時間」の計算値です。Claude 側の実際の挙動が固定5時間ウィンドウであればほぼ一致します（下の「制限事項」参照）。

**Q. 送信メッセージの中身は？**
「`ok` とだけ返して」という1行だけです。

---

## 9. 制限事項・注意

- **前提としている挙動：** 「最初の1発から5時間の固定ウィンドウ」。もし Claude 側が完全な**ローリングウィンドウ**（各リクエストが個別に5時間で失効）だった場合、リセット時刻の完全固定は原理的にできません。ただしその場合でもツール自体は無害です（微量トークンを規則的に消費するだけ）。
- `claude` コマンドが PATH にない環境では動きません。
- タスクの登録・削除には管理者権限（UAC承認）が必要です。
- 実際の挙動に違和感があれば、`ping.log` のタイムスタンプと Claude Code 内 `/usage` の表示を突き合わせ、`-WindowMinutes` を調整してください。

---

## 10. アンインストール

```powershell
# 自動実行を解除
powershell -ExecutionPolicy Bypass -File "C:/claude/claude-window-keeper/register-task.ps1" -Unregister

# 状態・ログの削除（任意）
powershell -Command "Remove-Item $env:USERPROFILE\.claude\window-keeper -Recurse -Force"
```

あとはフォルダごと削除すれば完全に元通りです。
