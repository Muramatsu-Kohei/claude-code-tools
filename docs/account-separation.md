# Claude アカウント分離：現状の事実とガード設計

最終更新: 2026-08-03 / 状態: **未実装（アカウントは組織の 1 つのみ）**

将来、組織アカウントとは別に個人アカウントを契約した場合に備えた設計メモ。
「今すぐ何かする」ためではなく、**契約した時点で読み返す**ためのもの。

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

---

## 4. ガードの設計

### 4.1 使える機構（Claude Code のフック仕様より）

| 機構 | 効果 | 確度 |
|---|---|---|
| `SessionStart` フックが `{"continue": false, "stopReason": "..."}` を返す | セッション開始をブロック | スキーマ上は可・**実効性は未検証**（§5） |
| `PreToolUse` フックが `hookSpecificOutput.permissionDecision: "deny"` を返す | ツール単位で拒否 | 確定 |
| `CwdChanged` フック | セッション途中の `cd` を捕捉 | **存在自体が未確認**（§7） |
| `permissions.deny` に `Read(C:/org-tree/**)` 等 | パス単位の静的拒否 | 確定 |
| `forceLoginOrgUUID`（managed settings 専用） | 認証アカウントの組織を強制 | 確定 |

### 4.2 核心的な制約：identity は取れない（が、プラン種別は取れる）

フックに渡る入力（stdin JSON）に**アカウント情報は含まれない**。
`.credentials.json` にも identity フィールドはない（§4.4 に実測構造）。
したがって「どのアカウントか」を知る方法はない。

`permissions.deny` は静的なので「個人アカウントのときだけ拒否」を表現できない。
`forceLoginOrgUUID` はマシン全体に効くため、ディレクトリ別条件にできない
（設定すると個人アカウントが一切使えなくなる）。

**ただし `subscriptionType`（プラン種別）は取得できる。**
組織 = Team、個人 = Pro / Max なら、identity がなくても判別条件として成立する。
→ これを使うのが **§4.4 の案 A（推奨）**。

### 4.3 案 B（フォールバック）：宣言と実態の照合

**※ §4.4 の案 A が実装可能と判明したため、こちらは予備。**
案 A が使えなくなった場合（`subscriptionType` の廃止、個人側も Team 契約にした場合など）に戻る。

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

### 4.4 案 A（推奨・実装可能）：subscriptionType でプラン種別を見る

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

#### 実装スケッチ

`~/.claude/account-guard.js`（`SessionStart` と `CwdChanged` に登録）:

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

### 4.5 登録方法と補強（案 A / 案 B 共通）

`~/.claude/settings.json` への登録:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "node ~/.claude/account-guard.js" }] }
    ],
    "CwdChanged": [
      { "hooks": [{ "type": "command", "command": "node ~/.claude/account-guard.js" }] }
    ]
  }
}
```

`SessionStart` だけだと起動時しか見ないため、セッション途中の `cd` を捕捉する
`CwdChanged` も併せて登録する。

**ただし `CwdChanged` というフックが実在するかは未確認**（§7）。確認できているフックは
`SessionStart` / `SessionEnd` / `PreToolUse` / `PostToolUse` / `UserPromptSubmit` /
`Notification` / `Stop` / `SubagentStop` / `PreCompact` で、この中には無い。
存在しない場合、セッション途中のツリー移動は下の**補強**（`PreToolUse` で毎回 cwd と
アカウントを突き合わせる）に頼ることになり、常用前提の構成になる。実装前に確認すること。

**補強**: §3.4 の「ディレクトリは砂場ではない」に対しては、
個人アカウントのセッションで `PreToolUse`（`Read|Bash|Grep|Glob`）を見て
`C:/org-tree` へのアクセスを `permissionDecision: "deny"` で止める層を足す。
ただし全ツール呼び出しにフックが挟まるので、常用するかは要検討。

### 4.6 採用しない案

| 案 | 却下理由 |
|---|---|
| 設定ディレクトリを分ける | CLAUDE.md / skills / agents / hooks まで分かれる。共有したい資産が多すぎる |
| `forceLoginOrgUUID` を managed settings に書く | マシン全体に効き、個人アカウントが使えなくなる |
| `permissions.deny` 単体 | 静的なのでアカウント条件を表現できない |

---

## 5. 個人アカウントを契約するときの前提作業チェックリスト

実装に着手する前に、設計の生死を決める 2 つを先に潰す。どちらも外れると案 A が
**黙って素通しになる**（止まらないのに止まっているつもりになるのが最悪の壊れ方）。

- [ ] **`SessionStart` フックの `continue: false` が実際にセッションを止めるか実測する**
      — スキーマ上は可だが未実行検証。効かなければブロック層を `PreToolUse` に移すしかなく、
      §4.4 の「読めなければ安全側に倒す」設計自体が無効化される
- [ ] **`CwdChanged` フックが実在するか確認する**（§4.5・§7）

その上で:

- [ ] `~/.claude/CLAUDE.md` に組織固有の記述がないことを確認する（現状は汎用方針のみで OK）
- [ ] `usage-tracker/collect.js` の `row` にアカウント識別子を追加する（§3.5）
- [ ] `guard.js` / `analyze.js` をアカウント別集計に対応させる
- [ ] worklog の引き継ぎ提示範囲をツリーで絞る（§3.1）
- [ ] `~/.claude/skills` `agents` に組織固有の内容がないか棚卸しする
- [x] `.credentials.json` に安定識別子があるか確認する（§4.4）→ identity なし。`subscriptionType` で代用
- [ ] 個人アカウント契約後、`subscriptionType` の実際の値を確認する（`"pro"` / `"max"` 等）
- [ ] account-guard.js を実装する（§4.4 案 A）
- [ ] 個人アカウント側のデータ学習利用設定を確認する

---

## 6. 運用ルール（分けた後）

**アカウントはディレクトリツリーに固定する。** git の author をパスで決めているのと同じ発想。

| ツリー | アカウント | git author |
|---|---|---|
| `C:\claude\*` | 個人 | noreply |
| `C:\org-tree\*` | 組織 | 組織メール |

ツリーを移るときは `/login` が必要（固定化しても切り替え自体は消えない）。
固定化が消すのは「今どっちで入るべきか」という判断の迷いだけ。

**守るべき一線は 1 つ: org ディレクトリに入るときは必ず組織アカウント。**

---

## 7. 未確認事項

- ~~`.credentials.json` の中身~~ → 2026-08-02 に確認済み（§4.4）
- ~~`SessionStart` の stdin JSON に `cwd` が含まれるか~~ → **含まれる**。`claude-worklog` の
  `cmdSessionStart` が `input.cwd` と `input.session_id` を使って現に動作している（2026-08-03 確認）
- 個人プラン（Pro / Max）での `subscriptionType` の実際の値
- `SessionStart` フックが `continue: false` を実際に尊重するか（スキーマ上は可、未実行検証）
  → 実装前の必須検証として §5 に移した
- **`CwdChanged` フックが実在するか**（§4.1・§4.5 がこれに依存している）。確認できている
  フックは `SessionStart` / `SessionEnd` / `PreToolUse` / `PostToolUse` / `UserPromptSubmit` /
  `Notification` / `Stop` / `SubagentStop` / `PreCompact` の 9 種で、この中には無い。
  なお実行バイナリ（`~/.local/share/claude/versions/*`、約 253 MB）の文字列検索では
  既知のフック名すべてが 0 件になる（文字列が圧縮されているため）。**この手段では確認できない**
- `claude --help` の環境変数一覧（実行が権限でブロック）
- Anthropic の利用規約における複数アカウント保持の正確な条項
- 所属組織の知財規程
