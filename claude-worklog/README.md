# claude-worklog

Claude Code のセッション単位の作業記録を自動で溜め、**次のセッションに引き継ぐ**ツール。

複数のセッションを並列で動かしたり、日をまたいで別の作業に移ると、「どのセッションが何をどこまで
やったのか」が追えなくなる。このツールはセッションごとの要約・変更内容・次回の始め方を追記専用の
ログに残し、同じプロジェクトで次にセッションを開いたときに **SessionStart フックでその内容を
Claude のコンテキストへ自動で戻す**。人間が覚えておく必要をなくすのが目的で、閲覧用の CLI は
その副産物。

Node.js 標準機能のみで動作し、外部依存はない。

## 何が起きるようになるか

```
$ claude                     # 同じディレクトリで新しいセッションを開く
                             # → 前回の「次回の始め方」と直近3件の作業ログが Claude に渡っている

> 前回の続きから進めて        # 何を説明しなくても続きから動ける

...作業...

> /finish                    # ドキュメント反映・検証・コミット・記録・引き継ぎまで一括
```

セッション終了時に `/finish` を叩き忘れても、SessionEnd フックが git 差分から機械的な記録を残し、
さらに haiku が 1 行要約を生成するので記録に穴が空かない。

## 記録の3層構造

上の層があれば下の層は使わない。要約の出どころは一覧表示で見分けられる(無印 = 手書き、
`~` = 自動要約、`?` = Claude Code の自動タイトル)。

| 層 | 出どころ | 正確さ | コスト |
| --- | --- | --- | --- |
| 1 | `/wrap` `/finish` で Claude 自身が書く要約 | 最も高い。意図・未完了・次の一手まで残る | 追加なし(セッション内の会話) |
| 2 | SessionEnd 後に haiku が生成する 1 行要約 | 中。会話ログを外から読むので意図は推測 | 1 セッション 0.1〜0.3 円程度 |
| 3 | Claude Code の `ai-title` と git 差分 | 低いが必ず残る | なし |

3 は常に記録されるため、要約が無い日でも「いつ・どのプロジェクトで・何を変更したか」は失われない。

## 引き継ぎ(次回の始め方)

`/finish` は「次回の始め方」を **handoff** として記録する。渡し方は 3 経路ある。

1. **自動(既定)** — 次のセッションの SessionStart で、注入テキストの先頭に置かれる。
   Claude は最初から状況を把握しているが、勝手には動き出さない。
2. **自動＋自走(任意)** — `config.json` の `autoStartFromHandoff` を `true` にすると、
   引き継ぎが最初のユーザー発言として投入され、セッションを開いた瞬間に続きを実行し始める。
   意図しない自走は事故になり得るので既定は無効。72 時間より古い引き継ぎは自走の対象にしない。
3. **手動** — `worklog handoff` で表示する。`worklog handoff --raw | clip` で貼り付け用に
   クリップボードへ入るので、別マシンや別ツールへ渡せる。

## セットアップ

### 前提

- Node.js (v18 以上を想定。`node --version` で確認)
- Claude Code v2.1.220 以降で確認。フックの `SessionStart` / `SessionEnd` と
  `hookSpecificOutput.additionalContext` に対応したバージョンが必要
- 自動要約を使う場合は `claude` コマンドが PATH から見えること
  (見つからない場合は環境変数 `WORKLOG_CLAUDE_BIN` で実行ファイルを指定する)

### 1. フックを登録する

`~/.claude/settings.json`(全プロジェクト共通)に `hooks-snippet.json` の内容を追記する。
既に `hooks` がある場合は配列に足す。**`command` のパスは絶対パスで書く**
(`~` の展開はフックでは保証されない)。

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node C:/絶対パス/claude-worklog/worklog.js session-start", "timeout": 15 } ] }
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "command", "command": "node C:/絶対パス/claude-worklog/worklog.js session-end", "timeout": 20 } ] }
    ]
  }
}
```

同じ `settings.json` の `permissions.allow` に以下を足しておくと、`/wrap` `/finish` が記録する
たびに許可を求められなくなる。

```json
"Bash(node C:/絶対パス/claude-worklog/worklog.js *)",
"PowerShell(node C:/絶対パス/claude-worklog/worklog.js *)"
```

### 2. スキル(`/wrap` `/finish`)を配置する

`skills/` の 2 つのフォルダを `~/.claude/skills/` にコピーする。

```powershell
Copy-Item .\skills\wrap   "$env:USERPROFILE\.claude\skills\" -Recurse -Force
Copy-Item .\skills\finish "$env:USERPROFILE\.claude\skills\" -Recurse -Force
```

```bash
cp -r ./skills/wrap ./skills/finish ~/.claude/skills/
```

**両ファイル内の `node C:/claude/ClaudeCode/claude-worklog/worklog.js` を自分の絶対パスに
書き換える。**書き換えを忘れると記録コマンドが失敗する。

### 3. 確認

新しいセッションを開き、以下が動けば設定できている。

```
worklog live      # 起動中のセッションが並ぶ
worklog list      # セッションが記録されている(初回は現在のセッションのみ)
worklog context   # 次セッションに注入されるテキスト
```

うまくいかないときは `~/.claude/worklog/errors.log` を見る。フックは失敗してもセッションを
止めないので、エラーはすべてここにだけ出る。

## コマンド

`node <path>/worklog.js <サブコマンド>` で実行する。以下は `worklog` に短縮して記載。

### 閲覧

| コマンド | 内容 |
| --- | --- |
| `worklog list [-n 10] [--verbose]` | 現在のディレクトリのプロジェクトの直近セッション |
| `worklog list --project repo-F` | プロジェクト名の部分一致で絞る |
| `worklog list --all -n 20` | 全プロジェクト横断 |
| `worklog today [--days 7]` | 今日(または直近 N 日)の作業を全プロジェクト横断で |
| `worklog live` | 起動中のセッションと並列状況。同一ディレクトリの並列は警告する |
| `worklog handoff [--raw]` | 前セッションが残した「次回の始め方」 |
| `worklog context` | 次セッションに注入されるテキストの確認 |
| `worklog export [--all] [--since 2026-07-01]` | Markdown に書き出す |

`--verbose` を付けると、やったこと・次にやること・引き継ぎ文・コミット・変更ファイルまで展開する。

### 記録

通常は `/wrap` `/finish` が呼ぶので手で叩く必要はない。

```
worklog add --summary "一行要約"
            [--done "やったこと"]      # 繰り返し可
            [--next "次にやること"]    # 繰り返し可
            [--doc "更新した文書"]     # 繰り返し可
            [--handoff "次回の始め方"] # 繰り返し可。指定順に改行で連結
            [--handoff-stdin]          # 引き継ぎ文を標準入力から読む
            [--via wrap|finish]
```

セッション ID は環境変数 `CLAUDE_CODE_SESSION_ID` から自動で解決する。取れない場合は
そのディレクトリで終了していない最新セッションに紐づける。`--session <id>` で明示もできる。

### フック用(手で叩かない)

| コマンド | 内容 |
| --- | --- |
| `worklog session-start` | stdin にフック JSON。開始を記録し、過去ログを注入する |
| `worklog session-end` | stdin にフック JSON。統計を確定し、必要なら自動要約を起動する |
| `worklog summarize --project <key> --session <id>` | 自動要約の本体。session-end が切り離して起動する |

## 設定

`~/.claude/worklog/config.json`。ファイルが無ければ既定値で動く。

| キー | 既定 | 内容 |
| --- | --- | --- |
| `autoSummary` | `true` | SessionEnd 後の haiku 自動要約を使うか。`false` で LLM を一切使わなくなる |
| `summaryModel` | `"haiku"` | 自動要約のモデル。精度が要るなら `"sonnet"` |
| `contextSessions` | `3` | SessionStart で注入する過去セッション数 |
| `contextMaxChars` | `1600` | 注入テキストの上限。毎セッションのコンテキストを消費するため絞ってある |
| `digestMaxChars` | `6000` | 自動要約へ渡す入力の上限。課金額を読めるようにするため |
| `autoStartFromHandoff` | `false` | `true` で引き継ぎを最初の発言として自動投入し、開いた瞬間に続きを走らせる |
| `handoffMaxAgeHours` | `72` | これより古い引き継ぎは自走の対象にしない |

## 保存されるもの

`~/.claude/worklog/<プロジェクトキー>.ndjson`。プロジェクトキーは作業ディレクトリの英数字以外を
`-` に置き換えたもの(`C:\claude\ClaudeCode` → `C--claude-ClaudeCode`)で、Claude Code が
`~/.claude/projects/` で使う規則と同じ。

1 行 1 レコードの追記専用形式で、`start` / `note` / `auto` / `end` の 4 種類を読み出し時に
セッション単位へ畳み込む。**既存行を書き換えないのは、同一プロジェクトで複数セッションが
並列に走ることが前提だから。** JSON 配列や Markdown 表のように書き換えが必要な形式は同時
書き込みで壊れる。

記録されるのは、セッション ID・時刻・作業ディレクトリ・ブランチ・開始時の HEAD・要約・
やったこと・次にやること・更新した文書・引き継ぎ文・コミット一覧・変更ファイル一覧・
ターン数・ツール呼び出し数。**会話の本文は保存しない**(元の会話ログは Claude Code 側に残る)。

## 設計上の判断

### なぜ「記録」と「終了手続き」を 2 つのコマンドに分けたか

`/finish` は git を触るので打つ場所を選ぶ。1 つにまとめると「まだコミットしたくないから叩かない」
が起きて記録が抜ける。`/wrap` は記録だけなので作業の途中でも何度でも叩ける。

### SessionEnd が発火しない場合

ターミナルを強制終了した場合など、SessionEnd は発火しないことがある。そのため次回の
SessionStart で「`start` はあるが `end` が無い」かつ「そのセッションのプロセスが生きていない」
セッションを検出し、後追いで確定させる(会話ログはディスクに残っているので後からでも統計は取れる)。
この経路で確定したセッションは一覧に `終了不明` と出る。

判定に経過時間ではなくプロセスの生死を使うのは、長時間放置しただけの現役セッションを誤って
閉じないため。

### headless 実行(`claude -p`)を記録しない理由

`claude -p` でもフックは発火する(実測)。スクリプトから claude を呼ぶたびに中身のない
セッション記録が増えると一覧が使い物にならないため、環境変数 `CLAUDE_CODE_ENTRYPOINT` が
`sdk` / `print` 系のときは記録しない(対話起動は `cli`)。

### 自動要約の無限再帰を止める仕組み

自動要約は headless の claude を呼ぶが、その claude 自身もフックを発火させるため、放置すると
要約が要約を呼ぶ再帰になる。子プロセスに `WORKLOG_DISABLE=1` を渡し、フック側はこれを見たら
何もせずに終わる。

`--bare` でも自動読み込みを止められるが、認証情報の読み込みまで止まって `Not logged in` で
失敗するため使っていない(実測で確認)。

### コンテキスト注入を絞っている理由

注入は毎セッション必ずコンテキストを消費する。そのため「次回の始め方」「直近 N 件の要約」
「持ち越しの未完タスク」「同一ディレクトリで並列稼働中のセッション」だけに限り、
既定で 1600 文字を上限にしている。別プロジェクトで動いているセッションは対処のしようがないので
あえて出さない。

`resume` / `compact` で始まったセッションには注入しない。同じ会話の続きで、過去ログは既に
コンテキストに入っているため。

## 制約・注意

- **Windows で開発・検証している。**macOS / Linux でも標準 API しか使っていないので動く想定だが
  未検証。パス区切りとプロジェクトキーの生成規則は OS に依存しない。
- コンソールのコードページが cp932 のままだと、日本語の要約が化けることがある。
  `chcp 65001` で UTF-8 にする。
- 自動要約は会話ログを外から読んで生成するため、意図や未完了の把握は `/wrap` `/finish` に劣る。
  重要なセッションでは `/finish` を叩くのが望ましい。
- 自動要約は haiku へ最大 `digestMaxChars` 文字を送る。従量課金の場合はごく小額だが費用が発生する。
  `autoSummary: false` で完全に止められる。
- 未完タスクの追跡は「直近セッションの `next` にあって、その後 `done` に入っていないもの」という
  文字列一致の目安。厳密な追跡はしない。
- git リポジトリでないディレクトリでも動く(git 由来の情報が空になるだけ)。

## アンインストール

1. `~/.claude/settings.json` の `hooks` から `SessionStart` / `SessionEnd` の該当エントリを消す
2. `~/.claude/skills/wrap` と `~/.claude/skills/finish` を消す
3. 記録を破棄する場合は `~/.claude/worklog/` を消す(残しておいても他に影響はない)

## ライセンス

MIT License. 詳細は [LICENSE](LICENSE) を参照。

**無保証**。Claude Code のフック仕様・入力 JSON・CLI フラグは Anthropic 側の変更で変わる
可能性がある。
