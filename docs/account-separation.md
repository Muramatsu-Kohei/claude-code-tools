# Claude アカウント分離：現状の事実とガード設計

最終更新: 2026-08-09 / 状態: **実装済み（組織 Team + 個人 Pro の 2 アカウント運用）**

組織アカウントとは別に個人アカウントを契約した場合に備えて書いた設計メモ。
2026-08-09 に個人 Pro を契約し、ここに書いた設計を実装した。

**実装時に前提が 1 つ崩れた。** `SessionStart` フックはセッションをブロックできないことが
判明し（§4.2）、ガードの置き場所を `PreToolUse` に移した。設計の骨格（プラン種別で判別する、
読めなければ拒否側に倒す）はそのまま通用したので、経緯を残したうえで実装に合わせて書き直してある。

実装したもの:

| 何 | どこ |
|---|---|
| アカウント別のガード | `account-guard/`（新規） |
| 使用量のアカウント別記録・集計 | `usage-tracker/`（`collect.js` `guard.js` `analyze.js`） |
| 過去ログへの識別子付与 | `usage-tracker/migrate-account.js` |
| 作業ログのツリー隔離 | `claude-worklog/`（`restrictedTrees` 設定） |
| 5時間枠 ping のアカウント別状態 | `claude-window-keeper/` |

---

## 1. 前提となる事実（2026-08-02 に実測）

### 1.1 ほぼ全部ローカルにある

`~/.claude/` を実際に調べた結果:

| もの | 実体 | スコープ |
|---|---|---|
| セッション履歴 | `projects/**/*.jsonl` — **(ファイル数) / (サイズ)** | ローカル |
| 自動メモリ | `projects/<dir>/memory/` | ローカル・ディレクトリ単位 |
| `CLAUDE.md` | `~/.claude/CLAUDE.md` | ローカル・**全セッション共通** |
| skills / agents / plugins / commands | `~/.claude/` 配下 | ローカル・全セッション共通 |
| 設定・フック | `~/.claude/settings.json` | ローカル・全セッション共通 |
| worklog | `~/.claude/worklog/*.ndjson` | ローカル・ツール横断 |
| usage-tracker | `~/.claude/usage-tracker/usage.jsonl` | ローカル |
| **アカウント紐づけ** | `.credentials.json` — **(サイズ)** | これだけ |

**結論: アカウントを失っても消えるのは利用権だけで、ファイルは 1 バイトも消えない。**
別アカウントでログインし直せば履歴もメモリも設定もそのまま読める。

### 1.2 サーバ側にあるもの（＝アカウントに紐づく）

- 契約（利用権）そのもの
- claude.ai の Web 会話、公開した Artifacts、クラウド実行セッション、スケジュール実行エージェント
- **組織管理者からの可視性** — 使用量。プランによっては会話内容のエクスポート

### 1.3 `/login` の挙動

- `.credentials.json` は 1 つだけ。**同時にアクティブなログインは 1 つ**
- `/login` で入れ替わるのはこのファイルだけ。他の設定資産はすべて共有されたまま
- **マシン全体に即座に効く** — 並行して動いている他のセッションにも影響する

---

## 2. 何が危険か（方向によって相手が変わる）

### 組織のコード → 個人アカウント：**NG（絶対）**

相手は「組織」（守秘義務違反）と「Anthropic」（個人プランは学習利用の設定次第）。
自分の一存では正当化できない。

### 個人のコード → 組織アカウント：**推奨されないが、自分でリスクを取れる**

Anthropic との関係ではほぼ問題にならない（組織が払った座席を組織のメンバーが使っているだけ）。
問題になる相手は所属組織で、実害の経路は 3 つ:

1. 管理者から使用量が見える（プランによっては内容も）
2. **成果物の帰属** — OSS 公開したくなったとき、「業務アカウントで全部作った」事実が反証を難しくする
3. （※ 当初 3 番目に「退職で消える」と書いていたが、1.1 のとおり**誤り**。ファイルは残る）

### 強度の差

- 「組織のコードを個人アカウントで触らない」= **絶対**（相手の情報だから）
- 「個人のコードを組織アカウントで触らない」= **推奨**（自分の資産の話だから）

同じ厳しさで運用する必要はない。ただし**公開する気のあるコードだけは分けておく**。

---

## 3. アカウントを分けても自動では分かれないもの

`/login` はトークンだけを入れ替える。以下は**アカウントに関係なく共有される**。

### 3.1 セッション開始時に自動注入されるもの（最重要）

無操作で文脈に載るので、`--resume` を避けるだけでは防げない。

| もの | スコープ | リスク |
|---|---|---|
| `~/.claude/CLAUDE.md` | 全セッション共通 | 組織固有の記述を書くと個人アカウントにも載る |
| `projects/<dir>/memory/MEMORY.md` | ディレクトリ単位 | org ツリーに入れば自動で載る |
| worklog の引き継ぎメモ | **ツール横断** | SessionStart フックが「他に未完の作業があるツール」を列挙する |

**worklog の現状（実測）**: 追跡対象は 6 件（`C--claude-repo-A` / `C--claude-repo-B` / `C--claude-ClaudeCode` /
`C--claude-repo-F` / `C--claude-repo-E` / `C--Users-user`）で **org-tree は 0 件**。
一方 `projects/` には `C--org-tree-*` が 複数存在する（project-a, project-b, project-c,
project-d, project-e, project-f, project-g, project-h, project-i, project-j, および org-tree 直下）。

→ **次に org リポジトリで Claude Code を開いた時点で追跡が始まり、以後は個人アカウントの
セッション開始時にも org の作業内容が提示されうる。** 仮定ではなく、あと 1 回で発生する。

**訂正（2026-08-09、実装時に実際のコードを読んで確認）**: 「ツール横断」は言い過ぎだった。
SessionStart が注入する「他に未完の作業があるツール」は `scopeIndex()` が組み立てており、
**走査範囲は 1 つの ndjson ファイル＝1 つの git リポジトリの中**に閉じている。
`C:\org-tree\<repo>` は別キーになるので、**自動注入で org の内容が載ることはなかった。**

実際に混ざる経路は**手動実行のときだけ**だった——`worklog today`（既定で全キー横断）、
`worklog list --all`、`worklog export --all`。ここは `restrictedTrees` 設定で塞いだ。

書き込みは制限していない。組織ツリーで組織アカウントを使う分には今までどおり記録される。
**制限したのは読み出しだけ**で、これは §2 の「強度の差」——守るのは相手の情報であって
自分の記録ではない——をそのまま反映している。

### 3.2 履歴はディレクトリ単位で、アカウント単位ではない

`projects/` のキーは**作業パス**であってアカウントではない。
個人アカウントで `C:\org-tree\...` に入り過去セッションを `--resume` すると、
**その履歴の中身が個人アカウントのトークンで再送される。**

### 3.3 共有される設定資産

`skills/` `agents/` `commands/` と MCP のトークンキャッシュはグローバル。
組織向けに書いたスキルに内部情報があれば、個人アカウントのセッションでも読み込まれる。

### 3.4 ディレクトリは砂場ではない

`C:\claude` で作業していても Read も Bash も `C:\org-tree\...` に到達できる。
**ディレクトリ固定は規約であって技術的な壁ではない。**

### 3.5 usage-tracker がアカウントを区別しない

`usage-tracker/collect.js` が追記する `row` のキーは
`ts / five_pct / five_reset / seven_pct / seven_reset / model / effort / fast / in_tok / out_tok / cost / sid`。
**アカウント識別子がない。**（行番号ではなく `row` の定義を辿ること。collect.js は今後も触るため）

切り替えると組織の `five_pct: 80` と個人の `five_pct: 5` が 1 本の時系列に混ざり、
`guard.js` の閾値判定も `analyze.js` の推定も壊れる。
→ **アカウントを分けるなら `row` に識別子を足すのが前提作業。**

**対応済み（2026-08-09）。** `row` に `acct` を追加し、差分判定の state を
`collect-state-<アカウント>.json` に分けた。`guard.js` は自分のアカウントの state だけを見る。
`analyze.js` は既定で現在のアカウントに絞って集計し、`--account all` を指定したときだけ
混ぜる（そのときは推定値が意味を持たない旨を警告する）。

実装して分かった壊れ方のうち、事前に見えていなかったもの:

- `analyze.js` の `weekWindowStarts` は「`seven_reset` が変わった＝週次リセット」と解釈するため、
  **アカウントの切り替えを新しい週と数える**。既定のレポートは直近 1 週分なので、
  放置すると「最後に切り替えて以降の数行」しか描かなくなっていた
- `guard.js` の発火済みフラグはセッション単位だが枠のリセット時刻でしか同一性を見ておらず、
  セッション途中で `/login` すると誤って抑止/再通知が起きる。フラグに `acct` を持たせて解決
- `claude-window-keeper` の `state.json` も `lastPing` を 1 本しか持たず、切り替え直後の ping を
  「送信済み」と誤判定していた。5 時間枠の開始時刻を固定するというツールの目的が崩れる

---

## 4. ガードの設計

### 4.1 使える機構（Claude Code のフック仕様より）

| 機構 | 効果 | 確度（2026-08-09 に確認） |
|---|---|---|
| `SessionStart` フックが `{"continue": false, "stopReason": "..."}` を返す | — | **効かない。** 公式ドキュメントで `SessionStart` は "Context only / No blocking or decision control" と明記。exit code 2 も stderr を表示するだけでブロックしない |
| `PreToolUse` フックが `hookSpecificOutput.permissionDecision: "deny"` を返す | ツール単位で拒否 | **確定。実地で動作を確認済み**（設定変更は稼働中のセッションにも即座に効いた） |
| `CwdChanged` フック | セッション途中の `cd` を捕捉 | **実在する。** ドキュメントに記載あり。ただしブロック可否は未確認なので警告用途にとどめた |
| `permissions.deny` に `Read(C:/org-tree/**)` 等 | パス単位の静的拒否 | 記法は確定。ただし静的でアカウント条件を表現できないため不採用（§4.6） |
| `forceLoginOrgUUID`（managed settings 専用） | 認証アカウントの組織を強制 | 確定 |

**この表が設計を決めた。** ブロックできるのは `PreToolUse` だけなので、実際の防御はそこに置き、
`SessionStart` と `CwdChanged` には警告を出す役割だけを持たせた。当初の案（§4.4）は
`SessionStart` で起動ごと止める前提だったので、そこだけ差し替えている。

### 4.2 核心的な制約：identity は取れない（が、プラン種別は取れる）

フックに渡る入力（stdin JSON）に**アカウント情報は含まれない**。
`.credentials.json` にも identity フィールドはない（§4.4 に実測構造）。
したがって「どのアカウントか」を知る方法はない。

`permissions.deny` は静的なので「個人アカウントのときだけ拒否」を表現できない。
`forceLoginOrgUUID` はマシン全体に効くため、ディレクトリ別条件にできない
（設定すると個人アカウントが一切使えなくなる）。

**ただし `subscriptionType`（プラン種別）は取得できる。**
組織 = Team、個人 = Pro / Max なら、identity がなくても判別条件として成立する。
→ これを使うのが **§4.4 の案 A**（採用・実装済み）。

### 4.3 案 B（フォールバック）：宣言と実態の照合

**※ §4.4 の案 A を実装したため、こちらは予備。**
案 A が使えなくなった場合（`subscriptionType` の廃止、個人側も Team 契約にした場合など）に戻る。
そのときも登録先は `PreToolUse`（§4.5）のままで、差し替わるのは判定材料だけ。

**考え方**: 実アカウントを直接読めないなら、**起動方法を宣言させて、それとパスを突き合わせる。**

```
1. ランチャー org-launcher.cmd が CLAUDE_ACCOUNT=org を設定して claude を起動する
2. SessionStart フックが cwd と CLAUDE_ACCOUNT を突き合わせる
3. 不一致、または org-tree 配下で CLAUDE_ACCOUNT 未設定なら continue:false でブロック
```

素の `claude` を org-tree で叩くと `CLAUDE_ACCOUNT` が未設定なので**必ず止まる**。
意図的に `CLAUDE_ACCOUNT=org` を設定すればすり抜けられるが、
相手は自分自身なので**悪意ある回避を防ぐ必要はない。事故防止として十分**。

実装スケッチ（`~/.claude/account-guard.js`、既存の guard.js と同じく node で実行）:

```js
// SessionStart フック。cwd と自己申告アカウントの不一致を検出して起動を止める。
// アカウントの実体はフック入力から取得できないため、ランチャーが宣言した
// CLAUDE_ACCOUNT を真とみなす。意図的な回避は防げないが、素の起動は確実に止まる。
const path = require('path');

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  let cwd = process.cwd();
  try {
    // SessionStart の入力には cwd と session_id が入る(claude-worklog の
    // cmdSessionStart が現に使っている)。process.cwd() は取れなかった場合の保険。
    const d = JSON.parse(input || '{}');
    if (typeof d.cwd === 'string' && d.cwd) cwd = d.cwd;
  } catch {}

  const norm = path.resolve(cwd).toLowerCase().replace(/\\/g, '/');
  const isOrgTree = norm.startsWith('c:/org-tree');
  const declared = process.env.CLAUDE_ACCOUNT || null;

  // 組織ツリーで組織アカウントの宣言がなければ止める。逆方向は警告のみ。
  if (isOrgTree && declared !== 'org') {
    process.stdout.write(JSON.stringify({
      continue: false,
      stopReason:
        'このディレクトリは組織アカウント専用です。org-launcher.cmd から起動してください' +
        `（現在の宣言: ${declared ?? '未設定'}）`,
    }));
    return;
  }
  if (!isOrgTree && declared === 'org') {
    process.stdout.write(JSON.stringify({
      systemMessage: '個人ツリーで組織アカウントを使用中です。',
    }));
  }
});
```

登録方法は案 A と共通（§4.5）。

### 4.4 案 A（採用・実装済み）：subscriptionType でプラン種別を見る

#### `.credentials.json` の実測構造（2026-08-02）

```json
{
  "claudeAiOauth": {
    "accessToken":  "<108 文字>",
    "refreshToken": "<108 文字>",
    "expiresAt": 1785664958179,
    "refreshTokenExpiresAt": 1786278760179,
    "scopes": ["user:file_upload", "user:inference", "user:mcp_servers", "user:profile", "<25 文字>"],
    "subscriptionType": "team",
    "rateLimitTier": "default_raven"
  }
}
```

**`accountUuid` / `organizationUuid` / `emailAddress` のような identity フィールドは存在しない。**
「どのアカウントか」を直接知る手段はない、が確定。

#### 個人 Pro での実測値（2026-08-09）

契約後に確認した。**組織と個人で両方の値が違う**ので、判別条件として問題なく機能する。

| | 組織 | 個人 |
|---|---|---|
| `subscriptionType` | `"team"` | `"pro"` |
| `rateLimitTier` | `"default_raven"` | `"default_claude_ai"` |

判別には `subscriptionType` だけを使う。`rateLimitTier` は値の意味が不透明で、
同じプランでも契約内容で変わりうるため。

#### しかし `subscriptionType` が判別に使える

組織アカウント = `"team"`。個人で契約するなら Pro / Max なので値が変わる。
**「どのアカウントか」は分からなくても「Team かどうか」は分かる**ため、
2 アカウント構成なら判別条件として十分。

利点:
- **アカウント属性なのでトークンのリフレッシュでは変わらない**（ハッシュ方式の不安定さを回避）
- 自己申告に頼らないので、ランチャーを経由せず素の `claude` を叩いても止まる
- 環境変数の設定忘れという事故が原理的に発生しない

制約:
- 文書化されていない内部フィールド。Claude Code の更新で構造が変わりうる → **読めなければ安全側（ブロック）に倒す**
- 判別できるのはプラン種別であって identity ではない。個人側も Team 契約にすると機能しない
- `rateLimitTier`（`"default_raven"`）も候補だが、値の意味が不透明なので使わない

#### 実装スケッチ（当時）

**実物は `account-guard/account-guard.js`。** 以下は契約前に書いたスケッチで、考え方
（プラン種別で判別する・読めなければ拒否側に倒す）はそのまま実装に引き継いだが、
**登録先が `SessionStart` から `PreToolUse` に変わった**（§4.1）。経緯として残す。

```js
// org-tree ツリーでは組織アカウント（subscriptionType === 'team'）以外を弾く。
// credentials には identity フィールドがないため、プラン種別で代用している。
// トークン本体には触れない・記録しない。読めない場合は安全側に倒してブロックする。
const fs = require('fs');
const path = require('path');

function subscriptionType() {
  try {
    const p = path.join(process.env.USERPROFILE || process.env.HOME, '.claude', '.credentials.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'))?.claudeAiOauth?.subscriptionType ?? null;
  } catch {
    // 構造変更・権限・未ログインのいずれか。判別不能として扱う。
    return null;
  }
}

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  let cwd = process.cwd();
  try {
    // SessionStart の入力には cwd と session_id が入る(claude-worklog の
    // cmdSessionStart が現に使っている)。process.cwd() は取れなかった場合の保険。
    const d = JSON.parse(input || '{}');
    if (typeof d.cwd === 'string' && d.cwd) cwd = d.cwd;
  } catch {}

  const isOrgTree = path.resolve(cwd).toLowerCase().replace(/\\/g, '/').startsWith('c:/org-tree');
  if (!isOrgTree) return;

  const sub = subscriptionType();
  if (sub !== 'team') {
    process.stdout.write(JSON.stringify({
      continue: false,
      stopReason:
        'このディレクトリは組織アカウント専用です。/login で組織アカウントに切り替えてください' +
        `（検出したプラン: ${sub ?? '判別不能'}）`,
    }));
  }
});
```

判別不能（`null`）もブロック対象にしている。フィールドが廃止されたときに
**黙って素通しになるより、止まって気づけるほうがよい**ため。

#### 実装で変えたところ

| 論点 | スケッチ | 実装 |
|---|---|---|
| 登録先 | `SessionStart` で起動ごとブロック | `PreToolUse` でツール単位に拒否。`SessionStart` / `CwdChanged` は警告のみ |
| 保護ツリー | コードに `c:/org-tree` を直書き | `~/.claude/account-guard/config.json` に外出し（複数ツリー・複数許可アカウントに対応） |
| 判定対象 | cwd のみ | cwd に加えてツールの**操作対象パス**も見る。ツリー外から絶対パスで触りにいく経路を塞ぐため |

**判定対象では一度誤った。** 当初は `tool_input` を丸ごと文字列化して走査していたところ、
この文書（保護ツリーのパスが本文に出てくる）を編集しようとして拒否された。保護ツリーの
ファイルには触れていないのに止まるのは明確な誤りなので、`Read` / `Edit` / `Write` などは
パス引数だけを見るように直した。`Bash` / `PowerShell` / `Agent` はコマンドや指示文の全体を
見る（パスの位置が決まっておらず、「読め」という指示自体を止めたいため）。

**誤検知はガードの寿命を縮める。** 日常の邪魔になれば外したくなり、外せば守りはゼロになる。
拒否の範囲は「守るものが実際に増える操作」に限る。

### 4.5 登録方法（実装したもの）

`~/.claude/settings.json` に登録した内容。ひな形は `account-guard/hooks-snippet.json`。

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read|Edit|Write|NotebookEdit|Glob|Grep|Bash|PowerShell|Agent|Task",
        "hooks": [{ "type": "command", "command": "node C:/claude/ClaudeCode/account-guard/account-guard.js", "timeout": 5 }]
      }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node C:/claude/ClaudeCode/account-guard/account-guard.js", "timeout": 5 }] }
    ],
    "CwdChanged": [
      { "hooks": [{ "type": "command", "command": "node C:/claude/ClaudeCode/account-guard/account-guard.js", "timeout": 5 }] }
    ]
  }
}
```

**実際に止まるのは `PreToolUse` だけ**で、残り 2 つは気づきを早めるための警告。
`matcher` でツールを絞っているのは、全ツール呼び出しに node の起動を挟まないため。
ここに載っていないツール（`WebFetch` など）から保護ツリーの中身が出ることはない
——出すには先に `Read` か `Bash` が要り、そこで止まる。

**設定変更は稼働中のセッションにも即座に効いた**（登録直後に同じセッションから
保護ツリーを読もうとして拒否された）。再起動は要らない。

**サブエージェント経由でも拒否される**（実測）。サブエージェントのツール呼び出しにも同じ
`PreToolUse` が挟まるため、委譲は抜け穴にならない。ここが素通しなら「サブエージェントに
読ませる」だけでガードを迂回できてしまうので、実際に確かめた
（保護ツリーを `Glob` させたところ `account-guard` の拒否メッセージが返った）。

`CwdChanged` は**実在した**（ドキュメントに記載あり）。ただしブロックできるかは未確認なので
警告用途にとどめた。結果として「`PreToolUse` を毎回通す常用前提の構成」になったが、
これは選択ではなく必然だった——ブロックできる機構が他に無い。

**フックの実在を実行バイナリの文字列検索で確かめようとしたのは誤りだった**（§7 参照）。
文字列が圧縮されていて既知のフック名すら 0 件になるので、この手段では何も判定できない。
公式ドキュメントを読むのが正しい。

§3.4 の「ディレクトリは砂場ではない」に対する答えがこの `PreToolUse` 層そのもので、
cwd だけでなくツールの操作対象パスも見ることで、ツリー外から絶対パスで触りにいく経路も塞いだ。

### 4.6 採用しない案

| 案 | 却下理由 |
|---|---|
| 設定ディレクトリを分ける | CLAUDE.md / skills / agents / hooks まで分かれる。共有したい資産が多すぎる |
| `forceLoginOrgUUID` を managed settings に書く | マシン全体に効き、個人アカウントが使えなくなる |
| `permissions.deny` 単体 | 静的なのでアカウント条件を表現できない |
| statusline に現在のアカウントを表示する | **起動時に Claude Code 自身が出している**（`Opus 5 · Claude Pro · <メールアドレス>`）。`subscriptionType` からプラン種別を推定する自作表示より正確 |

**statusline の件は 2026-08-09 に見送りを決めた。** 検討した理由と却下の判断は以下。

守れるのは「個人ツリーで組織アカウントのまま作業する」方向だけで、これは §2 の弱いほう
（強いほう——保護ツリーへの個人アカウント——は `account-guard` が確実に止める）。
一方でコストは、`statusline.js` が実稼働版とリポジトリ版の 2 つあるため**同じ機能を 2 箇所に
入れ続ける保守**と、現在 stdin だけで完結している表示ロジックに**初のファイル I/O**
（`.credentials.json` の読み取り）が加わること。幅の増加は 4〜6 文字で問題にならなかった。

**起動時表示はスクロールで流れて消える**ので、長いセッションの途中で確かめる手段にはならない。
それでも、セッション中にアカウントが変わるのは `/login` を打ったときだけ（意識的な操作）なので
実害は小さいと判断した。**再検討の条件は「Claude Code の更新で起動時のアカウント表示が消えたとき」。**

---

## 5. 実施結果（2026-08-09）

設計の生死を決める 2 つの検証を先に潰した。**片方が外れた。**
どちらも外れれば案 A が黙って素通しになる（止まらないのに止まっているつもりになるのが
最悪の壊れ方）ため、実装より先に確かめたのは正しかった。

- [x] **`SessionStart` フックの `continue: false` が実際にセッションを止めるか**
      → **止められない。** ドキュメントに "Context only / No blocking or decision control" と明記。
      予告どおりブロック層を `PreToolUse` に移した（§4.1・§4.5）
- [x] **`CwdChanged` フックが実在するか** → **実在した。** ただしブロック可否は不明なので警告用途

その上で:

- [x] 個人アカウントの `subscriptionType` の実際の値を確認する → **`"pro"`**（§4.4）
- [x] `.credentials.json` に安定識別子があるか確認する（§4.4）→ identity なし。`subscriptionType` で代用
- [x] `account-guard` を実装する（`account-guard/`、テスト 17 件）
- [x] `usage-tracker/collect.js` の `row` にアカウント識別子 `acct` を追加する（§3.5）
- [x] `guard.js` / `analyze.js` をアカウント別集計に対応させる
- [x] 過去ログ (行数)に `acct: "team"` を付与する（`migrate-account.js`。全行が Team 期だと実測済み）
- [x] `claude-window-keeper` の ping 状態をアカウント別に分ける（§3.5）
- [x] worklog の提示範囲をツリーで絞る（§3.1、テスト 103 件が通過）

コードでは守れない範囲（Anthropic 側の設定・共有される設定資産）:

- [x] **個人アカウント側のデータ学習利用設定を確認する** → 2026-08-09 に Web の設定画面で
      「AI モデルの改善にご協力ください」を **OFF** にした。ここはフックでもガードでも
      到達できないので、アカウントを増やすたびに手で確認するしかない
- [x] **`~/.claude/CLAUDE.md` に組織固有の記述がないことを確認する** → 2026-08-09 に確認。
      言語方針・モデル運用・Git 運用などの汎用方針のみで、組織名・内部パス・固有名詞はなし。
      **`CLAUDE.md` は全セッション共通なので、ここに組織固有のことを書いた時点で個人アカウントにも載る。**
      組織固有の指示はツリー内のプロジェクト `CLAUDE.md` に書くこと
- [x] **`~/.claude/skills` `agents` に組織固有の内容がないか棚卸しする** → 2026-08-09 に確認。
      組織固有の記述は **0 件**。内訳は `skills/` が 3 件（`finish` `handoff` `wrap`。いずれも
      ディレクトリ自体は通常フォルダで、**各エントリが個別に `claude-worklog/skills/*` を指す
      シンボリックリンク**）、`agents/` が 2 件（`sonnet-explorer` `sonnet-worker`）、
      `commands/` は存在せず、`plugins/` は Anthropic 公式マーケットプレイスのみ。
      唯一出てくる固有情報は `worklog.js` への絶対パスだが、これは個人ツリーのパスで組織情報ではない

**この 3 件は再発する。** どれもコードで守れる場所ではなく、設定資産を足すたびに混入しうる。
skills / agents を新設したときと、アカウントを増やしたときに見直すこと。

---

## 6. 運用ルール（分けた後）

**アカウントはディレクトリツリーに固定する。** git の author をパスで決めているのと同じ発想。

| ツリー | アカウント | git author |
|---|---|---|
| `C:\org-tree\*` | **組織のみ**（`account-guard` が強制する） | 組織メール |
| それ以外 | どちらでもよい | noreply |

**非対称なのは意図的。** 組織のコードを個人アカウントに渡すのは相手の情報を持ち出すことなので
絶対に避ける（§2）。逆向き——個人のコードを組織アカウントで触る——は自分の資産の話で、
リスクを取るかは自分で決められる。同じ厳しさで縛る必要はない。

`C:\org-tree` に入るときだけ `/login` で組織アカウントに切り替える。忘れても
`account-guard` が最初のツール呼び出しで止めるので、気づかずに読み込ませることはない。

**守るべき一線は 1 つ: org ディレクトリに入るときは必ず組織アカウント。**

---

## 7. 未確認事項

- ~~`.credentials.json` の中身~~ → 2026-08-02 に確認済み（§4.4）
- ~~`SessionStart` の stdin JSON に `cwd` が含まれるか~~ → **含まれる**。`claude-worklog` の
  `cmdSessionStart` が `input.cwd` と `input.session_id` を使って現に動作している（2026-08-03 確認）
- ~~個人プラン（Pro / Max）での `subscriptionType` の実際の値~~ → **`"pro"`**（§4.4）
- ~~`SessionStart` フックが `continue: false` を実際に尊重するか~~ → **しない**（§4.1）。
  この 1 点で設計の置き場所が変わった
- ~~`CwdChanged` フックが実在するか~~ → **実在する**（§4.1）

  実行バイナリ（`~/.local/share/claude/versions/*`、約 253 MB）の文字列検索でフックの実在を
  確かめようとしていたが、既知のフック名すべてが 0 件になる（文字列が圧縮されている）。
  **この手段では何も判定できない。公式ドキュメントを見ること。**

まだ残っているもの:

- `CwdChanged` がブロック（`permissionDecision` 相当）を返せるか。返せるならセッション途中の
  ツリー移動をツール実行前に止められる。いまは警告のみ
- `claude --help` の環境変数一覧（実行が権限でブロック）
- Anthropic の利用規約における複数アカウント保持の正確な条項
- 所属組織の知財規程
