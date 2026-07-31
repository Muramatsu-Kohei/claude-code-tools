# usage-tracker

Claude Code の **5時間枠と週次枠の使用率を時系列で記録し、「5時間枠を何回使い切ったら週次リミットに当たるか」を実測で推定する**ツール。

Anthropic はプランごとの枠の内訳を公開していないため、自分の使用履歴から比を求める。

## 何を測るのか

statusline に渡される JSON には、そのときの枠の使用率が入っている。

```
5h 54% (resets 20:54)   7d 97% (resets Wed 18:20)
```

この2つを継続的に記録すると、**5時間枠1本を x% 使ったとき週次枠が y% 進む**という対応が取れる。
5時間枠ごとに (x, y) を集め、原点を通る直線を当てれば

```
5h枠を100%使い切ったときの週次枠の消費 = slope × 100  [%]
週次リミットに当たるまでの満タン回数     = 100 ÷ (slope × 100)
```

が出る。これが `analyze.js` の主結論。

## 仕組み

使用率は **statusline の入力 JSON にしか現れない**。transcript(`~/.claude/projects/**/*.jsonl`) にも API レスポンスにも残らないため、後から復元できない。したがって収集は statusline に相乗りする。

```
Claude Code ──(stdin JSON)──> ~/.claude/statusline.js
                                     │ 表示を出したあと
                                     └─> usage-tracker/collect.js
                                              └─> ~/.claude/usage-tracker/usage.jsonl
```

- 追記は**使用率かリセット時刻が動いたとき**か、変化がなくても **10分経過したとき**。statusline は表示更新ごとに何度も呼ばれるため、そのままではログが肥大化する。
- 収集側の失敗は全て飲み込む。statusline が消えると原因の切り分けが不能になるので、取りこぼしよりも表示の安定を優先している。
- 注入は `install.ps1` が**配置済みの** `~/.claude/statusline.js` の末尾に行う。`claude-statusline` 側のソースは変更しない(独立したツールなので依存を焼き込まない)。

## インストール

```powershell
# 収集を開始する
pwsh -File C:\claude\ClaudeCode\usage-tracker\install.ps1

# 入れ直す(statusline.js を再デプロイしたあとなど)
pwsh -File .\install.ps1 -Force

# 外す
pwsh -File .\install.ps1 -Uninstall
```

冪等で、注入後に `node --check` を通す。構文が壊れたらバックアップ(`statusline.js.bak-usage-tracker`)から自動で戻す。

`CLAUDE_STATUSLINE_HOOK` 環境変数を設定すると、そちらのモジュールが優先して読まれる(パスを固定したくない場合用)。

## 分析

```powershell
node analyze.js                      # コンソールサマリ + report.html を生成
node analyze.js --json               # 集計結果を JSON で出す
node analyze.js --log <path> --html <path>
```

HTML レポートには時系列グラフ(5h/7d)、5時間枠ごとの散布図と回帰直線、枠の一覧表が入る。単一ファイルで自己完結している。

## データ形式

`~/.claude/usage-tracker/usage.jsonl` に1行1レコード。

| フィールド | 内容 |
| --- | --- |
| `ts` | 記録時刻 (ISO 8601, UTC) |
| `five_pct` / `seven_pct` | 5時間枠 / 週次枠の使用率 (0-100) |
| `five_reset` / `seven_reset` | リセット時刻。**Unix epoch 秒**で来る(ISO 文字列も許容) |
| `model` / `effort` / `fast` | そのときのモデル・推論強度・fast モード |
| `in_tok` / `out_tok` | コンテキスト窓の累積入出力トークン |
| `cost` | セッションの `total_cost_usd` |
| `sid` | セッション ID |

**同じ `five_reset` を持つ行の集まりが1つの5時間枠**。枠の識別はこの値で行う(使用率の下落ではなく)。

## 限界

読み方を誤らないために、分かっている制約を挙げる。

- **使用率の分解能は1%**。API が整数で返すため、1つの5時間枠での週次枠の増分が数%だと丸め誤差の影響が大きい。複数の枠を回帰にかけて緩和する前提。有効な枠が2本未満なら `analyze.js` は推定を出さない。
- **`claude -p` では statusline が呼ばれない**。`claude-window-keeper` の定期 ping は非対話実行なので点が増えない。使っていない間は枠も進まないので分析上の実害はないが、「枠が切り替わった瞬間」は記録されず、次に対話を開いたときに初めて分かる。
- **週次枠が既に高い週からは何も測れない**。残り3%の状態で観測できるのは3%分の増分だけ。週次リセット後の1週間が本番のデータになる。
- **モデルと推論強度で消費レートが変わる**。Opus と Haiku が混在した枠は傾きが揺れる。枠ごとのモデル内訳を見て、傾向が違う枠は分けて解釈する。
- `in_tok` / `out_tok` は**コンテキスト窓の累積でセッション単位**。プランの枠に計上される総消費量ではないので、「%あたり何トークン」の目安にはなるが絶対値としては使えない。
- **Anthropic 側が枠の定義や重み付けを変えると過去データと比較できない**。時系列を残しているのはそのため(傾きが途中で変わったら定義変更を疑う)。
- 5時間枠と週次枠が**同じ消費を同じ重みで数えている保証はない**。このツールが測るのはあくまで両者の観測上の比。
