# スコープ対応 実装仕様書

`claude-worklog` に「1リポジトリ内のツール単位(スコープ)」を導入する。2026-07-30 の設計議論の結論。
**変更1〜10 すべて実装済み**(2026-07-31)。
調査で判明した事実(§2)は、後から挙動を疑うときの根拠として残してある。

対象コード: `claude-worklog/worklog.js`(単一ファイル、依存なし)

---

## 1. 解決したい問題

| # | 問題 | 現状の挙動 |
| --- | --- | --- |
| P1 | 親ディレクトリと子ディレクトリでセッションを開くと、同じリポジトリなのに履歴が別プロジェクトに分裂する | プロジェクトキーが `cwd` から作られるため。子で `worklog list` を叩くと「記録がまだない」 |
| P2 | `claude-statusline` を触りたいのに `claude-worklog` の引き継ぎが注入される | 引き継ぎがプロジェクト単位で1本しかないため |

P1 と P2 は同じ根に繋がっている。「プロジェクト = ディレクトリ」という単位が、
実際の作業単位(リポジトリ / その中のツール)と噛み合っていない。

---

## 2. 調査で判明した事実

実装前に必ず読むこと。**特に F1 は、対策せずに P1 を直すと静かに壊れる。**

### F1 (重大) 会話ログの場所は cwd から決まる。git ルートではない

`transcriptPathFor(key, sid)` は `~/.claude/projects/<key>/<sid>.jsonl` を組み立てている。
しかし **Claude Code 側のディレクトリ名は cwd から作られる**。実際に両方存在する。

```
~/.claude/projects/C--claude-ClaudeCode/
~/.claude/projects/C--claude-ClaudeCode-claude-worklog/        ← 子で開いたセッション
~/.claude/projects/C--claude-ClaudeCode-claude-window-keeper/  ← 同じく
```

プロジェクトキーを git ルート由来に変えると、子で開いたセッションの会話ログが引けなくなる。
結果は `turns=0 / edits=0 / editedFiles=[] / aiTitle=null` で、`worthSummarizing()` が false を
返すため**自動要約も走らない**。例外は出ないので気づけない。

対策: フック入力の `transcript_path` を使う(現在のコードは受け取っていない。`grep` で確認済み)。

### F2 `stats.files` は空になることがある

`gitDelta(cwd, startHead)` は `startHead` が null のとき `git diff` をスキップする。
`start` レコードが無いセッション(フック導入前に開始・SessionStart が発火しなかった等)では
`files: []` になる。実例: `C--claude-repo-A.ndjson` のセッション `1c9576f6` は `edits: 6` だが `files: []`。

→ スコープ判定は `files` だけに頼れない。`editedFiles`(絶対パス)からの補完が必須。

### F3 `editedFiles` にはリポジトリ外のパスが混ざる

スクラッチパッドが入る。判定時に除外すること。

```json
"editedFiles": ["C:\\claude\\repo-A\\tool-c\\lib\\stage-calc.js",
                "C:\\Users\\user\\AppData\\Local\\Temp\\claude\\...\\gen_cases.py"]
```

### F4 git の出力はサブディレクトリからでもルート相対(検証済み)

```
子で git status --porcelain      → claude-worklog/_probe.txt
子で git diff --name-only HEAD~1 → claude-worklog/README.md, claude-worklog/worklog.js
子で git rev-parse --show-toplevel → C:/claude/ClaudeCode
diff.relative → 未設定(false)
```

→ `stats.files` はそのままスコープ判定に使える。`diff.relative=true` の環境では崩れるため、
`git diff` には `--no-relative` を明示する。

### F5 パス表記の揺れはキーを分裂させる

`projectKey()` は非英数字を `-` に潰すだけなので、`c:/...`(ドライブ小文字)や末尾 `/` が
別キーになる。`git rev-parse --show-toplevel` は `C:/claude/ClaudeCode`(スラッシュ)を返す。

```
そのまま:      C:/claude/ClaudeCode → C--claude-ClaudeCode
               c:/claude/ClaudeCode → c--claude-ClaudeCode   ← 分裂
正規化してから: 上記いずれも       → C--claude-ClaudeCode   ← 一致(既存ファイル名と同じ)
```

→ `path.resolve()` + ドライブ文字の大文字化を通してからキーを作る。
**既存の3ファイル(`C--claude-repo-A` `C--claude-ClaudeCode` `C--claude-repo-F`)はすべて
git ルート由来なので、データ移行は不要。**

### F6 注入される引き継ぎに古さの上限がない

`handoffMaxAgeHours: 72` は `autoStartFromHandoff` の判定(worklog.js の 1 箇所)にしか
使われていない。`buildContext()` は何週間前の引き継ぎでも「次回の始め方」として出す。
スコープ索引を足すと放置されたツールが毎回並ぶため、索引側には日数上限を設ける。

### F7 並列セッションの警告が親子をまたげない

`buildContext()` の同一 cwd 判定は `path.resolve(a) === path.resolve(b)`。
プロジェクトを git ルート単位にすると「親で1つ、子で1つ」という最も危険な組み合わせが
警告されなくなる。前方一致で判定すること。

### F8 `shortProject()` はハイフンを含むディレクトリ名で壊れる

キーを `-` で分割して最後の要素を返すため、`C--claude-utility-claude-statusline` → `statusline`、
`C:\claude\my-tool` → `tool` になる。レコードに保存済みの `cwd` の末尾から取ればよい。

### F9 複数ツール判定を実リポジトリ15個で検証した結果

「自分の目印ファイルを持つ最上位ディレクトリが2つ以上」で判定した場合。

```
複数ツール(7) repo-A           tool-a … tool-b
複数ツール(7) repo-B           tool-a … 
複数ツール(3) ClaudeCode   claude-statusline claude-window-keeper claude-worklog
複数ツール(4) project-e  Library_Poco lib-b lib-a dev   ← 外部ライブラリ混在
複数ツール(4) project-g    project-p project-l lib-c project-q ← 同上
単一    (0)  repo-F, legal, project-j, project-n, project-d, project-t,
             project-k, project-r, project-s
単一    (1)  repo-E (fmt-a のみ), project-a
```

1リポジトリ1ツールは正しく「単一」になる(repo-F の `UI` `Widgets` `docs` は
スコープにならない)。`project-e` と `project-g` は同梱の外部ライブラリを
ツールと誤認するが、**誤認しても壊れない設計**にする(§4.4 と §7)。

### F10 ディレクトリ移動による孤児化が既に起きている

`~/.claude/projects/` に `C--claude-utility` `C--claude-utility-claude-statusline`
`C--claude-utility-claude-window-keeper` `C--claude-utility-repo-F` が残っている。
このリポジトリは以前 `C:\claude\utility` にあった。→ `move` サブコマンドの必要性の裏付け(§6)。

---

## 3. 決めごと

### D1 プロジェクト = git リポジトリ

親でも子でも同じプロジェクトになる。git 管理外なら従来どおり `cwd`。

### D2 スコープ = リポジトリ内のツール。有効化はリポジトリ単位で自動判定

- **リポジトリの判定**に目印ファイルを使う(2つ以上で有効)
- **セッションのスコープ判定**には目印を使わない。変更ファイル数で決める

この分離が要点。repo-A の `tool-c` は現在 README を持たないが、いま最も作業している
ツールである。目印でスコープを決めると**今アクティブなツールだけ分類されない**という逆の結果になる。

### D3 スコープは保存せず、読み取り時に導出する

判定の材料(`stats.files` / `stats.editedFiles`)は既に全レコードに保存されている。
書き込み時に固定しないことで:

- リポジトリが後から複数ツールになったとき、**過去のセッションにも遡ってラベルが付く**
  (例: repo-E は現在 `fmt-a` のみが README を持つので無効。2つ目のツールに README ができた時点で
  有効になり、それまでに `fmt-a` を触ったセッションも `[fmt-a]` として表示される)
- 判定式を後で改良したとき、履歴全体の分類がその場で直る。backfill 不要

例外: `--scope` による明示指定はレコードに保存し、常に優先する(人の判断のほうが正しい)。

### D4 注入は「最新1本を全文 + 他は1行の索引」

全ツール分を全文入れると、P2 の「無関係な引き継ぎ」が増えるだけになる。

---

## 4. 実装詳細

### 4.1 定数

```js
const MARKERS = ['README.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'LICENSE'];

// スコープ候補にしない最上位ディレクトリ(F9 の実データに出た名前を全て含む)
const DENY_DIRS = new Set(['docs', 'doc', 'test', 'tests', 'src', 'lib', 'bin', 'scripts',
  'assets', 'images', 'dist', 'build', 'obj', 'out', 'target', 'legal', 'shared', 'common',
  'tmp', 'temp', 'node_modules', '.git', '.github', '.vscode', '.claude']);

// 中身が個々のツールである入れ物。2階層目までをスコープ名にする(例: tools/tool-d)
const CONTAINER_DIRS = new Set(['tools', 'packages', 'apps', 'projects', 'crates', 'services']);

const MULTI_TOOL_MIN = 2;
```

### 4.2 設定に追加するキー

```js
scopeMode: 'auto',          // 'auto' | 'off' | 'on'  自動判定を上書きする逃げ道
scopeIndexMax: 3,           // 索引に出す他スコープの最大件数
scopeIndexMaxAgeDays: 14,   // これより古い未完は索引に出さない(F6)
```

### 4.3 パスとキー

```js
function normPath(p) {
  let r = path.resolve(String(p || ''));
  if (/^[a-z]:/.test(r)) r = r[0].toUpperCase() + r.slice(1);   // F5
  return r;
}

// git ルートを優先。git 管理外なら cwd。結果は normPath 済み
function repoRoot(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  return normPath(top || cwd);
}

function projectKey(cwd) {          // 既存を差し替え
  return normPath(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}
function repoKey(cwd) {
  return projectKey(repoRoot(cwd));
}
```

**`repoKey()` を使う箇所を漏らさないこと。** `cmdSessionStart` / `cmdSessionEnd` /
`cmdAdd` / `cmdSummarize` / `resolveTargetKeys` のすべて。片方だけ残すと分裂する。

### 4.4 複数ツール判定

```js
// 目印ファイルを持つ最上位ディレクトリが MULTI_TOOL_MIN 以上あれば有効。
// CONTAINER_DIRS はその中身を見る。fs 呼び出しはルート直下だけなので安価。
function isMultiTool(root, cfg) {
  if (cfg.scopeMode === 'off') return false;
  if (cfg.scopeMode === 'on') return true;
  let n = 0;
  for (const e of readdirSafe(root)) {              // ディレクトリのみ、DENY_DIRS を除く
    const dirs = CONTAINER_DIRS.has(e) ? readdirSafe(path.join(root, e)).map((x) => `${e}/${x}`) : [e];
    for (const d of dirs) if (MARKERS.some((m) => existsSafe(path.join(root, d, m)))) { n++; break; }
  }
  return n >= MULTI_TOOL_MIN;
}
```

コマンド1回の中では結果をキャッシュする(`Map<root, boolean>`)。

### 4.5 スコープの導出(読み取り時)

```js
// 戻り値: スコープ名 or null(= リポジトリ全体の作業)
function deriveScope(session, root, multiTool) {
  if (session.scope) return session.scope;        // --scope の明示指定が最優先(D3 の例外)
  if (!multiTool) return null;

  const st = session.stats || {};
  let rels = st.files && st.files.length ? st.files.slice() : [];
  if (!rels.length) {                             // F2 のフォールバック
    for (const abs of st.editedFiles || []) {
      const r = path.relative(root, normPath(abs));
      if (r && !r.startsWith('..') && !path.isAbsolute(r)) rels.push(r.split(path.sep).join('/')); // F3
    }
  }

  const count = new Map();                        // スコープ名 -> ファイル数
  for (const rel of rels) {
    const seg = rel.split('/').filter(Boolean);
    if (seg.length < 2) continue;                 // ルート直下のファイル(README.md 等)は候補外
    let name = seg[0];
    if (DENY_DIRS.has(name)) continue;
    if (CONTAINER_DIRS.has(name) && seg.length >= 3) name = `${seg[0]}/${seg[1]}`;
    count.set(name, (count.get(name) || 0) + 1);
  }
  if (!count.size) return null;

  // 最多。同数なら editedFiles の末尾に近い(= 最後に編集した)ほうを採る
  return [...count.entries()].sort((a, b) => b[1] - a[1] || lastIdx(b[0]) - lastIdx(a[0]))[0][0];
}
```

### 4.6 会話ログのパス(F1 の修正。他と独立してコミットできる)

1. `cmdSessionStart`: フック入力の `transcript_path` を `start` レコードに `tp` として保存する
2. `cmdSessionEnd`: フック入力の `transcript_path` を直接使う
3. `spawnSummarizer` → `cmdSummarize`: `--transcript <path>` で引き渡す
4. `finalizeDangling`: `start` レコードの `tp` を使う
5. すべて無い場合のフォールバックは `~/.claude/projects/<projectKey(cwd)>/<sid>.jsonl`。
   **ここは `repoKey` ではなく cwd 由来のキーであること**(Claude Code 側の命名規則に合わせる)

既存レコードには `tp` が無いが、既存セッションはすべてリポジトリルートで開始されているため
フォールバックで正しく引ける。

### 4.7 注入(`buildContext`)

```
前回: claude-worklog に短縮ラッパーを同梱し、README 整備と next 重複の修正
  [claude-worklog / 07-30]
  まず worklog today --days 7 を叩き、~ 印の件数を数える。
  作業ツリーは clean。main から 8 コミット、push なし。

他に未完の作業があるツール:
  claude-statusline (07-28)  WSL 手順の追記が途中
  claude-window-keeper (07-25)  常駐時の CPU 使用率の確認待ち

別のツールを触るなら /handoff <ツール名> で切り替える。
```

規則:

1. **cwd がツールディレクトリ内なら、そのスコープを最優先**(`path.relative(root, cwd)` の
   先頭セグメントから確定する)。子ディレクトリで起動したときは注入が最も正確になる
2. cwd がリポジトリルートなら、最新セッションのスコープを主とする
3. 主スコープの引き継ぎを全文、他スコープは1行(スコープ名 / 日付 / `next` の先頭1件を70字で切る)
4. 索引は `scopeIndexMax` 件まで、`scopeIndexMaxAgeDays` 以内のものだけ
5. 未完のスコープが無ければ索引を出さない → **判定が誤っても実害が出にくい**
6. スコープなし(リポジトリ全体)の引き継ぎは常に候補に含める
7. `contextMaxChars`(1600)による末尾切り捨てが索引を削らないよう、**引き継ぎ → 索引 →
   直近ログ → 並列警告** の順に組む。現状の注入は 913 字、索引3行で +150 字程度の見込み

### 4.8 表示・閲覧

| 変更 | 内容 |
| --- | --- |
| `list --scope <名前>` | 部分一致で絞る。`--project` はプロジェクト用として残す |
| `handoff [<名前>]` | 位置引数でスコープを指定。省略時は §4.7 の規則で選ぶ |
| `today` / `list --all` | プロジェクト名を `ClaudeCode/claude-worklog` の形で出す |
| 表示名 | `shortProject()` を廃し、レコードの `cwd` の末尾セグメントから作る(F8) |
| 並列警告 | 同一 cwd 完全一致から**前方一致**に変更(F7) |

---

## 5. 変更点一覧(実装順)

| # | 変更 | 根拠 | 状態 |
| --- | --- | --- | --- |
| 1 | `transcript_path` をフックから受け取り保存・引き渡し | F1 | 済(単独コミット) |
| 2 | `repoKey()` 導入、`projectKey()` に正規化を追加 | D1 / F5 | 済(単独コミット) |
| 3 | `isMultiTool()` / `deriveScope()` を追加 | D2 / D3 | 済(5 の表示・7・8 と同コミット) |
| 4 | 注入をスコープ対応に | D4 / F6 | 済(5 の handoff・6 と同コミット) |
| 5 | `list --scope` / `handoff <名前>` / `today` の表示 | — | 済 |
| 6 | 並列警告を前方一致に | F7 | 済(`worklog live` も同様に変更) |
| 7 | 表示名を `cwd` 由来に | F8 | 済 |
| 8 | `scopeMode` / `scopeIndexMax` / `scopeIndexMaxAgeDays` を設定に追加 | — | 済 |
| 9 | `/wrap` `/finish` に `--scope`、`/handoff` に位置引数。README 更新 | — | 済 |
| 10 | `move` サブコマンド | F10 | 済(単独コミット) |

実装時に §4 から変えた点:

- 索引(§4.7)は「そのツールの直近の未完」まで遡る。ツールごとの最新セッションだけで
  判断すると、未完を残したまま別の回で軽い修正をしただけでツールが索引から消え、
  `/handoff <ツール名>` が拾う引き継ぎと食い違うため。古いものは日数上限のほうで落とす

---

## 6. `move` サブコマンド

ディレクトリの改名・移動でキーが変わったときに履歴を引っ越す。D1 によって親子分裂は
起きなくなるが、移動による孤児化は D1 では直らない(F10 が実例)。

```
worklog move --from <部分一致> --to <部分一致|キー|パス> (--all | --session <id>) [--dry-run] [--force]
```

- **生存セッションの記録は既定で拒否する。**移した後に `SessionEnd` が古いキー側へ `end` を
  書くため、`start` の無い断片が残り、一覧に開始時刻不明のセッションとして現れる
  (`foldSessions` は種類を問わず sid でエントリを作る)。`--force` で押し切れるようにする
- レコード内の `cwd` は書き換えない(どこで実行されたかは事実として残す)
- 移動後に空になった元ファイルは削除する

実装時に決めた点:

- `--all` か `--session` のどちらかを必須にした。既定で全件移すのは事故が大きすぎる
- 拒否は「選択から外して残りを移す」にした。全体を中止すると、自分自身が起動中である限り
  `--all` が一度も通らない(移す動機のある状況ほど通らなくなる)
- `--session` は先頭一致。一覧の 8 桁表示をそのまま貼れるようにするため
- 書き込みは「移動先へ追記 → 元を書き戻し(空なら削除)」の順。途中で失敗したとき、
  記録が消えるより重複して残るほうが復旧しやすい
- 元の書き戻しは一時ファイル + `rename`。移す側は追記済みで復旧できるが、残す側は
  どこにも複製が無いため、書き込み途中で落ちても原本を壊さないようにする
- **移動元のプロジェクトに生存セッションがあれば実行そのものを止める**(`--force` で解除)。
  このコマンドだけが追記専用の原則を破る read-modify-write なので、読んでから書き戻すまでの
  間に他セッションが追記した行を取りこぼす。追記の原子性では守れない。呼び出し元セッション
  自身はコマンドの実行中に追記しないため除外する(`CLAUDE_CODE_SESSION_ID` で判別)
- ファイルの書き戻しは**行の原文**で行う(`readRawLines()` を追加)。`readRecords()` は
  壊れた行を捨てるので、それを使って書き戻すと破損行が静かに消える
- `--to` が既存キーに当たらないときはパスとして解釈する。打ち間違いがそのまま新キーになるため、
  ディスク上に無い場合は警告を出す(消えたディレクトリの記録を移す用途があるのでエラーにはしない)

---

## 7. テスト計画

| # | 確認 | 期待 |
| --- | --- | --- |
| T1 | `claude-worklog/` で起動 → 数ターン作業 → 終了 → `worklog list --verbose` | `turns` / `edits` が 0 でない(**F1 の回帰テスト。最重要**) |
| T2 | 同じセッションが親のプロジェクトに記録される | `C--claude-ClaudeCode.ndjson` に入る。子のファイルは作られない |
| T3 | repo-F で `worklog list` | スコープ表示が出ない。注入も現状のまま |
| T4 | repo-A の既存レコードでスコープを導出 | セッション `c399a95f` → `tool-c`(`docs` `shared` `tools/tool-d` に負けない) |
| T5 | repo-A の `1c9576f6`(`files: []`) | `editedFiles` から `tool8-...` を導出できる。スクラッチパッドは無視される |
| T6 | repo-E の `sub-a/` に README を仮置き → `worklog list` → 戻す | 一時的にスコープ有効になり、過去セッションにもラベルが付く(D3 の確認) |
| T7 | 親と子で同時に起動 | 並列警告が出る(F7) |
| T8 | `worklog context` の文字数 | 1600 未満。索引が切り捨てられていない |
| T9 | `worklog list --scope claude-worklog` | 該当セッションのみ |

---

## 8. やらないこと

- **`UserPromptSubmit` フックで最初の発言からツールを推測して注入する自動切り替え。**
  精度は上がるが、文字列照合というあいまいな判定と「セッション内で1回だけ」の状態管理が増える。
  §4.7 の「索引 + `/handoff`」で足りるかを実運用で確認してから判断する
- `history.jsonl` からの backfill(D3 により過去分の分類は自動で付くため優先度が下がった)

## 9. 残るリスク

- スコープ判定は「変更ファイルが最多」というヒューリスティック。外部ライブラリを大量に触った回に
  `Library_Poco` のようなラベルが付くことがある(F9)。表示が的外れになるだけで、引き継ぎは消えない
- 目印ファイルを置かない運用のリポジトリではスコープが有効にならない。`scopeMode: 'on'` で対応
- 読み取り時導出は**現在のディスク上の構成**を見る。ツールディレクトリを削除・改名すると、
  過去セッションのラベルが変わる(記録は失われない)
