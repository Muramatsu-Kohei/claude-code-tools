# claude-statusline

Claude Code 用のステータスライン。コンテキスト使用率・セッションコスト・プラン利用枠などを 1 行に収めて常時表示します。

```
claude | Opus5 hi | ctx 4% 958k | $0.32 +2/-0 | 5h 26% 05:50 | 7d 7% Sat 09:00
```

依存はありません（Node.js 標準機能のみ）。Windows / macOS / Linux で動作します。

## ファイル構成

| ファイル | 内容 |
| --- | --- |
| `statusline.js` | スクリプト本体。これ 1 つで動きます |
| `settings-snippet.json` | `settings.json` に貼る設定ブロック |
| `sample-input.json` | 動作確認用のサンプル入力（匿名化済み） |
| `preview-colors.js` | ANSI 色見本の表示。配色を決めるとき用 |

## 表示の見方

| 表示 | 意味 |
| --- | --- |
| `claude` | カレントディレクトリ名（シアン） |
| `Opus5` | モデル名。空白を詰めて表示 |
| `hi` | 推論エフォート。`lo` / `md` / `hi` / `xhi` / `max` |
| `fast` | Fast モードが有効なときだけ表示（黄） |
| `nothink` | 拡張思考が無効なときだけ表示 |
| `ctx 4% 958k` | コンテキスト使用率と残りトークン数 |
| `$0.32` | セッション累計コスト |
| `+2/-0` | セッション中の増減行数 |
| `5h 26% 05:50` | 5 時間枠の使用率とリセット時刻 |
| `7d 7% Sat 09:00` | 週次枠の使用率とリセット時刻 |

**色**: 使用率は 70% 以上で黄、90% 以上で赤。コストは $5 で黄、$20 で赤。エフォートは `xhi` / `max` のときだけ黄。それ以外は控えめな灰色（dim）です。

**表示されない項目があるのは正常です。** 既定の状態は幅を節約するため出しません（拡張思考が有効・Fast が無効・差分 0 行・コスト 0）。また `rate_limits` は claude.ai のサブスク認証時にしか渡ってこないため、API キー利用では `5h` / `7d` が消えます。コンテキスト情報もセッション開始直後や `/compact` 直後は `null` になり、その項目だけ省かれます。

## インストール

### 方法 1: 個人で使う

1. `statusline.js` を `~/.claude/statusline.js` に置く（Windows では `%USERPROFILE%\.claude\statusline.js`）
2. `~/.claude/settings.json` に `settings-snippet.json` の内容を追記する

```json
{
  "statusLine": {
    "type": "command",
    "command": "node ~/.claude/statusline.js",
    "padding": 0
  }
}
```

Claude Code を再起動すると反映されます。

> **Windows でのパス表記に注意**: `command` のパスには必ずフォワードスラッシュを使ってください。Git Bash がバックスラッシュをエスケープ文字として食べてしまい、エラーも出ないまま失敗します。`~` は Windows のホームディレクトリにも展開されるため、上記の書き方でそのまま動きます。

### 方法 2: チームで共有する

スクリプトをリポジトリに含め、`.claude/settings.json`（git 管理対象）に `statusLine` を書いてコミットすると、クローンした全員に適用されます。

ただしパス解決に注意が必要です。`${CLAUDE_PROJECT_DIR}` が `statusLine` の `command` で展開されるかは公式ドキュメントに記載がありません（hooks とプラグインの monitor では使えると明記あり）。確実に動かすなら方法 1 の `~/.claude/` 方式か、方法 3 のプラグイン方式を選んでください。

### 方法 3: プラグインとして配布する

広く配りたい場合はプラグイン形式にします。`${CLAUDE_PLUGIN_ROOT}` はプラグインのパス置換として正式にサポートされています。

```
my-statusline/
├── .claude-plugin/
│   └── plugin.json
├── settings.json
└── scripts/
    └── statusline.js
```

`settings.json`（プラグインの既定設定）:

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/statusline.js\"",
    "padding": 0
  }
}
```

このディレクトリを git リポジトリやマーケットプレイス経由で配布すると、インストール時に `user` / `project` / `local` のスコープを利用者が選べます。

## 動作確認

設定する前に、サンプル入力を食わせて単体で動くか確認できます。

```bash
node statusline.js < sample-input.json
```

期待される出力（色は端末で付きます）:

```
demo | Opus5 hi | ctx 4% 959k | $0.32 +12/-3 | 5h 26% ... | 7d 7% ...
```

リセット時刻の部分は実行時刻との関係で変わります（当日中なら時刻のみ、翌日以降は曜日付き）。

## カスタマイズ

すべて `statusline.js` の 1 ファイルで完結しています。ファイル冒頭に **ANSI エスケープの早見表**（スタイル・文字色・明るい色・背景色・256 色・24bit）をコメントで載せてあるので、調べずにその場で色を変えられます。

**色見本を端末で確認する** — 同梱の `preview-colors.js` で、スタイル・基本 16 色・背景色・256 色パレット・24bit グラデーションを、コード番号と `c(...)` の書き方つきで一覧表示できます。

```bash
node preview-colors.js                          # 同じフォルダの statusline.js が対象
node preview-colors.js ~/.claude/statusline.js  # 稼働中の設定が対象
```

最後のセクションには対象ファイルを実際に走らせた**現在の配色の実物**が出るので、`THEME` を書き換えて再実行すれば変更結果をその場で確認できます。色は端末のテーマによって見え方が変わるため、コメントの色名だけで決めるよりこちらが確実です。

> インストール先（`~/.claude/statusline.js`）を編集している場合は、上のように引数でそのパスを渡してください。省略するとこのフォルダ内のコピーが対象になり、編集した色が反映されていないように見えます。どのファイルを見ているかは「現在の配色」の見出しに表示されます。

**配色** — `THEME` オブジェクト 1 箇所にまとまっています。早見表から名前を選んで書き換えるだけです。

```js
const THEME = {
  dir: c(FG.cyan),           // → c(ST.bold, FG.brightCyan) で太字の明るいシアン
  costWarn: c(FG.yellow),    // → c(FG.black, BG.yellow) で黄背景に黒文字
  ok: c(FG.green),           // → c(38, 5, 71) で端末テーマに影響されない色
  ...
};
```

`c()` は複数のコードを 1 つのエスケープにまとめるヘルパーで、`c(ST.bold, FG.cyan, BG.blue)` のように何個でも渡せます。`ST` / `FG` / `BG` は早見表の数値に名前を付けた定数です。

**色が変わる閾値** — `PCT_WARN` / `PCT_CRIT`（使用率 70% / 90%）と `COST_WARN` / `COST_HIGH`（$5 / $20）。

**その他**

- **項目の削除** — 不要な項目の `parts.push(...)` ブロックごと消せば消えます。項目間は独立しているので、他の表示は壊れません
- **エフォートの表記** — `EFFORT` オブジェクトの短縮名
- **区切り文字** — 末尾の `parts.join(...)`

> 基本 16 色は端末のカラーテーマ側で色味が差し替えられるため、環境によって見え方が変わります。どの環境でも同じ色にしたい場合は 256 色（`c(38, 5, n)`）か 24bit（`c(38, 2, r, g, b)`）で直接指定してください。

## トラブルシューティング

**ステータスラインが表示されない**

- ワークスペースの信頼ダイアログを承認しましたか。`statusLine` はシェルコマンドを実行するため hooks と同じ信頼ゲートがかかります。未承認だと空白のままで、`claude --debug` に `Status line command skipped: workspace trust not accepted` と出ます
- 設定に `disableAllHooks: true` があるとステータスラインも無効化されます
- `claude --debug` でセッション初回実行時の終了コードと stderr が確認できます

**`(statusline: ...)` と表示される**

異常時も必ず 1 行出す設計です。原因が文字列で出ます。

| 表示 | 原因 |
| --- | --- |
| `no stdin` | パイプが無い / 閉じている |
| `no input` | 入力が空 |
| `bad json` | JSON のパースに失敗 |
| `no fields` | 既知のフィールドが 1 つも無かった |

**文字化けする（Windows）**

出力を ASCII のみに限定しているため通常は起きませんが、ディレクトリ名に非 ASCII 文字が含まれる場合は化ける可能性があります。これは表示側の制約です。

## 設計メモ

**なぜ PowerShell ではなく Node なのか**

Windows PowerShell は `-File` 実行時に stdin を自ら読み切って `$input` に格納し、そのデコードにコンソールのコードページ（日本語環境では cp932）を使います。UTF-8 として読み直す余地がないため、JSON 内の日本語（セッション名など）が壊れて引用符が欠落し、パースに失敗してステータスラインが消えていました。pwsh 7 でも親プロセスのコードページを継承するため同じ結果になります。Node は `fs.readFileSync(0)` で stdin を生バイトから読めるためこの問題が構造的に起きず、起動も高速です（実測 約 55ms 対 PowerShell 約 520ms）。

**なぜ出力を ASCII に限定するのか**

曜日名を `ja-JP` ロケールにすると表示側が cp932 として解釈して化けるため、曜日は英語 3 文字で出しています。同じ理由で絵文字も使っていません。

**幅の設計**

ステータスラインは常時表示で横幅が貴重です。区切り（`" | "` は 3 文字）の数を増やさないよう関連する値をグループにまとめ、`Opus 5` → `Opus5` のように詰め、既定状態の項目は出さない方針を取っています。

**トークンは消費しません**

ステータスラインはローカルで実行され、その出力が API に送られる会話履歴に入ることはありません（公式ドキュメントにも `The status line runs locally and does not consume API tokens.` と明記があります）。実コストは表示更新ごとの Node プロセス起動（約 55ms、CPU のみ）だけです。

## 参考

- [Customize your status line](https://code.claude.com/docs/en/statusline)
- [Settings](https://code.claude.com/docs/en/settings)
- [Plugins reference](https://code.claude.com/docs/en/plugins-reference)
