'use strict';
// account-guard の判定の回帰テスト。
//
// このガードで最も危険な壊れ方は「拒否しそこねて、しかも気づかない」こと。したがって
// 拒否できることだけでなく、判別不能なとき・設定が壊れているときに拒否側へ倒れることも
// 確かめる。逆に誤検知(似た名前のツリーや無関係な呼び出しを止める)は日常の邪魔に
// 直結するので、通過することも同じ重さで検証する。
//
// 偽 HOME を作って USERPROFILE を差し替えるので、実際の ~/.claude は読まない。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// .tmp 直下ではなく自分専用のサブディレクトリを使う。以前は .tmp 全体を消していたため、
// swap.test.js のサンドボックス(.tmp/swap)まで巻き添えで消えた。2 つのスイートを同時に
// 走らせると、片方が他方の HOME を実行中に削除して ENOENT の偽陽性が出る。
const BASE = path.join(__dirname, '.tmp', 'guard');
const GUARD = path.join(__dirname, '..', 'account-guard.js');
fs.rmSync(BASE, { recursive: true, force: true });

const state = { pass: 0, fail: 0 };
// extra は失敗時の手掛かり。落ちた行だけでは原因が分からないことが多いので実出力を添える
function check(label, cond, extra) {
  if (cond) state.pass++; else state.fail++;
  const tail = extra && !cond ? `\n      ${String(extra).replace(/\n/g, '\n      ')}` : '';
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}${tail}`);
}

// subscriptionType だけを持つ最小の credentials を置く。raw / rawRules に文字列を渡すと
// 壊れたファイルを再現でき、「読めないときに拒否側へ倒れるか」を試せる。
function sandbox(name, { subscriptionType, rules, raw, rawRules } = {}) {
  const home = path.join(BASE, name);
  fs.mkdirSync(path.join(home, '.claude', 'account-guard'), { recursive: true });
  const cred = path.join(home, '.claude', '.credentials.json');
  if (raw !== undefined) fs.writeFileSync(cred, raw, 'utf8');
  else if (subscriptionType) fs.writeFileSync(cred, JSON.stringify({ claudeAiOauth: { subscriptionType } }), 'utf8');
  if (rawRules !== undefined) fs.writeFileSync(configPath(home), rawRules, 'utf8');
  else if (rules) fs.writeFileSync(configPath(home), JSON.stringify({ rules }), 'utf8');
  return home;
}

const configPath = (home) => path.join(home, '.claude', 'account-guard', 'config.json');

// フックとして呼び出し、stdout の JSON を返す。出力なし(= 通常フローに委ねる)は null。
function run(home, input, argv = []) {
  const env = { ...process.env, USERPROFILE: home, HOME: home, NO_COLOR: '1' };
  const out = execFileSync(process.execPath, [GUARD, ...argv], {
    env, input: JSON.stringify(input), encoding: 'utf8',
  });
  if (!out.trim()) return null;
  return JSON.parse(out);
}

const decision = (res) => res?.hookSpecificOutput?.permissionDecision ?? null;
const ORG = [{ tree: 'C:/org-tree', allow: ['team'] }];

console.log('account-guard');

// --- 拒否されるべきケース ---
{
  const home = sandbox('deny-cwd', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, { hook_event_name: 'PreToolUse', cwd: 'C:\\org-tree\\proj', tool_name: 'Read', tool_input: { file_path: 'src/main.py' } });
  check('保護ツリー内の cwd は拒否する', decision(res) === 'deny', JSON.stringify(res));
  check('拒否理由にツリー名が入る', /org-tree/.test(res?.hookSpecificOutput?.permissionDecisionReason || ''), JSON.stringify(res));
  // 拒否の文面は実際に安全な手順を出すこと。先に `/login` させると、まだ swap で退避して
  // いないアカウントの認証情報はその場で消え、復旧はブラウザ OAuth のやり直しになる
  // (README の「拒否されたときの挙動」と同じ順序を、利用者が実際に読むこの文面でも守る)。
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('切り替えは退避してからだと案内する',
    /swap save/.test(reason) && /先に `\/login` すると/.test(reason), reason);
  check('/login を最初の一手として案内しない',
    !/^`?\/login`? で正しいアカウントに切り替えて/m.test(reason), reason);
}
{
  const home = sandbox('deny-arg', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, { hook_event_name: 'PreToolUse', cwd: 'C:\\claude\\ClaudeCode', tool_name: 'Read', tool_input: { file_path: 'C:/org-tree/proj/secret.py' } });
  check('ツリー外からでも引数の絶対パスで拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  // JSON.stringify を通るとバックスラッシュは \\ になる。正規化がこれを吸収できないと素通りする。
  const home = sandbox('deny-backslash', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, { hook_event_name: 'PreToolUse', cwd: 'C:\\claude', tool_name: 'Bash', tool_input: { command: 'type C:\\org-tree\\proj\\secret.py' } });
  check('バックスラッシュ表記でも拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  const home = sandbox('deny-unknown', { raw: '{ broken', rules: ORG });
  const res = run(home, { hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read', tool_input: {} });
  check('アカウントを判別できないときは拒否側に倒す', decision(res) === 'deny', JSON.stringify(res));
}
{
  // credentials ファイルそのものが無い(未ログイン)。JSON が壊れている deny-unknown とは
  // 別経路だが、どちらもアカウントは判別不能(unknown)になる。denyMessage() はこの経路
  // でだけ /login を案内してよい: `swap save <name>` は credentials が無ければ必ず失敗し、
  // 退避が1つも無ければ `swap <name>` も必ず失敗するため、/login を抑止すると打つ手が
  // 1つも残らない行き止まりになっていた(失って困る認証情報が無いので /login は安全)。
  const home = sandbox('deny-loggedout', { rules: ORG });
  const res = run(home, { hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read', tool_input: {} });
  check('未ログインでも保護ツリーは拒否する', decision(res) === 'deny', JSON.stringify(res));
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  // 他の deny 経路にも「先に `/login` すると…消えます」という抑止の一文があるため、
  // それと区別できる形(バッククォート無しで箇条書きの案内として出ている行)を見る。
  check('未ログインなら /login を案内する(swap はどちらも失敗するため)',
    /^\s*\/login\s+…/m.test(reason), reason);
  check('/login で失うものが無いことも伝える', /消える退避はありません/.test(reason), reason);
}
{
  // credentials ファイルはある(existsSync は true)が、0バイト・破損で読めない。
  // 以前は existsSync だけで「未ログイン」を判定していたため、この状態は判別できず、
  // 現在ログインが生きている前提の「切り替え手順」に落ちていた。しかし swap save は
  // 「現在の credentials を読めません」で必ず失敗し、退避が1つも無ければ swap <name> も
  // 必ず失敗するため、/login を抑止したまま行き止まりになる(失って困る認証情報は
  // ファイルが既に壊れている時点で存在しないので、/login は安全)。
  const home = sandbox('deny-corrupted', { rules: ORG });
  // sandbox() は subscriptionType / raw のどちらも指定しないと credentials ファイル自体を
  // 作らない(= 未ログイン扱いになる)ので、ここで直接、壊れた(空の)ファイルを置く。
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '', 'utf8');

  const res = run(home, { hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read', tool_input: {} });
  check('credentials が壊れていても保護ツリーは拒否する', decision(res) === 'deny', JSON.stringify(res));
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('拒否理由が復元に使えない状態であることを言う(無言で終わっていない)',
    /復元に使える中身ではありません/.test(reason), reason);
  check('実際に打てる次の一手(swap / /login)を案内する',
    /swap\s+<name>/.test(reason) && /^\s*\/login\s+…/m.test(reason), reason);
  // swap 側は「読めない現在」を上書きする前に --force を要求する。付けずに案内すると
  // 案内どおり打っても必ず中止され、行き止まりになる(ツール間の受け渡しで切れていた)。
  check('復元の案内に --force が付いている(swap 側の要求と噛み合う)',
    /swap\s+<name>\s+--force/.test(reason), reason);
  check('現在のログインが生きている前提の警告(先に /login すると…消えます)は出さない',
    !/先に `\/login` すると/.test(reason), reason);
}
{
  // deny メッセージは次の一手として `swap save <name>` / `swap <name>` を案内するが、
  // これは Bash ツール呼び出しになる。cwd が保護ツリー内なら violation() の cwd 判定が
  // 先に当たるため、案内どおりに打つと同じコマンドがまた同じ理由で deny され、
  // 同じ案内を繰り返す堂々巡りになっていた(コマンド文字列をパースして swap を特別扱いする
  // 例外は作らず、案内文で「ツリーの外で実行すること」を明示する方針で直す)。
  const home = sandbox('deny-cwd-loop', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read', tool_input: { file_path: 'src/main.py' },
  });
  check('cwd が保護ツリー内なら拒否する(堂々巡りテストの前提)', decision(res) === 'deny', JSON.stringify(res));
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('swap はツリーの外で実行するよう案内する(堂々巡りにしない)',
    /ツリーの外に cd してから実行/.test(reason), reason);
}
{
  // 対照: cwd がツリーの外で、引数のパスだけがツリー内を指す場合は、案内した swap は
  // 同じ cwd からそのまま実行できる。誤って毎回この注意書きを出すと、本当に効く手順が
  // 埋もれるので、この場合は出ないことも確かめる。
  const home = sandbox('deny-arg-noloop', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Read',
    tool_input: { file_path: 'C:/org-tree/proj/secret.py' },
  });
  check('cwd がツリー外なら拒否する(対照テストの前提)', decision(res) === 'deny', JSON.stringify(res));
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('cwd がツリー外なら swap の cd 注意書きは出さない',
    !/ツリーの外に cd してから実行/.test(reason), reason);
  // swap は同梱の別ツールで、PATH に置く手動セットアップが要る。ガードだけを入れた構成では
  // 案内どおり打っても「'swap' は認識されていません」で終わり、文面は /login を抑止して
  // いるので実行できる手が 1 つも残らない。逃げ道まで書いてあることを確かめる。
  check('swap が未設置の場合の逃げ道まで案内する', /`swap` が見つからない場合/.test(reason), reason);
}
{
  // cwd が「当たったルールとは別の」保護ツリーの内側にいる場合。ヒットしたルールだけを見て
  // cd 注記の要否を決めていたため、保護ツリーが 2 つ以上ある構成では注記が出ず、案内どおり
  // 打った swap が今度は cwd 側のルールに当たって同じ deny に戻る堂々巡りになっていた。
  const TWO = [{ tree: 'C:/org-tree', allow: ['team'] }, { tree: 'D:/org-tree', allow: ['team'] }];
  const home = sandbox('deny-cross-tree', { subscriptionType: 'pro', rules: TWO });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'D:/org-tree/work', tool_name: 'Read',
    tool_input: { file_path: 'C:/org-tree/proj/secret.py' },
  });
  check('別ツリーの対象を触っても拒否する(前提)', decision(res) === 'deny', JSON.stringify(res));
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('cwd が別の保護ツリー内なら cd 注記を出す', /ツリーの外に cd してから実行/.test(reason), reason);
  // 注記が指すのは「今いるツリー」であって、当たったルールのツリーではない。取り違えると
  // 案内どおり cd しても同じ場所に留まることになる。
  check('cd 注記は cwd 側のツリーを指す', /D:[\\/]org-tree 配下のままだと/.test(reason), reason);
}
{
  // JSON としては妥当だが accessToken を欠く credentials。ガードが JSON.parse の成否だけを
  // 見ていたときは「正常」に分類され、現在のログインが生きている前提の切り替え手順に落ちて
  // いた。しかし swap 側は accessToken を必須にするので、案内した swap save は必ず失敗し、
  // 退避が無ければ行き止まりになる。判定は credentials.js の hasUsableCredentials に一本化した。
  const home = sandbox('deny-no-accesstoken', { rules: ORG });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{}}', 'utf8');
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read', tool_input: {},
  });
  check('accessToken を欠く credentials でも拒否する', decision(res) === 'deny', JSON.stringify(res));
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('accessToken 欠落は「復元に使えない」側に分類する',
    /復元に使える中身ではありません/.test(reason), reason);
  check('accessToken 欠落でも /login を案内する(行き止まりにしない)',
    /^\s*\/login\s+…/m.test(reason), reason);
  check('accessToken 欠落では現在が生きている前提の警告を出さない',
    !/先に `\/login` すると/.test(reason), reason);
}
{
  // allow を書き損じたルールで保護が外れないこと。
  const home = sandbox('deny-malformed-allow', { subscriptionType: 'pro', rules: [{ tree: 'C:/org-tree', allow: 'team' }] });
  const res = run(home, { hook_event_name: 'PreToolUse', cwd: 'C:/org-tree', tool_name: 'Read', tool_input: {} });
  check('allow が配列でないルールは許可なしとして拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  // tree キーを書き損じた(例: path と誤記)ルールは黙って捨てられ、以前は rules が空になって
  // 保護が丸ごと消えていた(警告なし)。allow の書き損じと違って「守るべきツリー」自体が
  // 分からないので、config ごと壊れた扱いにして拒否側に倒すことを確かめる。
  const home = sandbox('deny-malformed-tree', {
    subscriptionType: 'pro',
    rawRules: JSON.stringify({ rules: [{ path: 'C:/org-tree', allow: ['team'] }] }),
  });
  const res = run(home, { hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Read', tool_input: {} });
  check('tree を書き損じたルールは config ごと壊れた扱いにする', decision(res) === 'deny', JSON.stringify(res));
  check('拒否理由に設定ファイルのパスが入る',
    /config\.json/.test(res?.hookSpecificOutput?.permissionDecisionReason || ''), JSON.stringify(res));
}
{
  // tree に相対パスを書いた設定。resolveFrom / normalize は cwd 基準で解決するため、相対の
  // tree だと同じ設定でも作業場所によって守る対象が変わってしまう(修正2)。tree キーの
  // 書き損じと同じく「守るべきツリー」を確定できないので、config ごと壊れた扱いにし、
  // 保護ツリーと無関係な操作まで拒否側に倒すことを確かめる。
  const home = sandbox('deny-relative-tree', {
    subscriptionType: 'pro',
    rawRules: JSON.stringify({ rules: [{ tree: 'org-tree', allow: ['team'] }] }),
  });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
    tool_input: { command: 'echo hello' },
  });
  check('tree が相対パスのルールは config ごと壊れた扱いにする', decision(res) === 'deny', JSON.stringify(res));
  check('拒否理由に設定ファイルのパスが入る',
    /config\.json/.test(res?.hookSpecificOutput?.permissionDecisionReason || ''), JSON.stringify(res));
}

// --- 通過すべきケース ---
{
  const home = sandbox('allow-team', { subscriptionType: 'team', rules: ORG });
  const res = run(home, { hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read', tool_input: { file_path: 'C:/org-tree/proj/x.py' } });
  check('許可アカウントなら保護ツリーでも通す', res === null, JSON.stringify(res));
}
{
  // 前方一致だけで判定すると org-treeo が org-tree に当たってしまう。
  const home = sandbox('allow-similar', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, { hook_event_name: 'PreToolUse', cwd: 'C:/org-treeo', tool_name: 'Read', tool_input: { file_path: 'C:/org-treeo/x.py' } });
  check('似た名前の別ツリーは誤検知しない', res === null, JSON.stringify(res));
}
{
  const home = sandbox('allow-unrelated', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, { hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Read', tool_input: { file_path: 'C:/claude/ClaudeCode/README.md' } });
  check('無関係な呼び出しは通す', res === null, JSON.stringify(res));
}
{
  const home = sandbox('allow-noconfig', { subscriptionType: 'pro' });
  const res = run(home, { hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read', tool_input: {} });
  check('保護ルール未設定なら何も拒否しない', res === null, JSON.stringify(res));
}
{
  // 実際に踏んだ誤検知。保護ツリーについて書いたドキュメントを、保護ツリー外で
  // 編集しようとして拒否された。操作対象は別ファイルなので通さなければならない。
  const home = sandbox('allow-doc-edit', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Edit',
    tool_input: { file_path: 'C:/claude/ClaudeCode/docs/account-separation.md', old_string: 'x', new_string: '`Read(C:/org-tree/**)` のような記法' },
  });
  check('編集内容に出てくるだけのパスでは拒否しない', res === null, JSON.stringify(res));
}
{
  const home = sandbox('allow-doc-write', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Write',
    tool_input: { file_path: 'C:/claude/ClaudeCode/README.md', content: '保護ツリーは C:/org-tree です' },
  });
  check('書き込む内容に出てくるだけのパスでは拒否しない', res === null, JSON.stringify(res));
}
{
  // 逆に、サブエージェントへの指示は「読ませる」ことそのものなので止める。
  const home = sandbox('deny-agent-prompt', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Agent',
    tool_input: { prompt: 'C:/org-tree/proj のコードを調べて要約して', description: '調査' },
  });
  check('サブエージェントへの指示に含まれる保護ツリーは拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  const home = sandbox('deny-write-target', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude', tool_name: 'Write',
    tool_input: { file_path: 'C:/org-tree/proj/new.py', content: 'print(1)' },
  });
  check('保護ツリーへの書き込みは拒否する', decision(res) === 'deny', JSON.stringify(res));
}

// --- ブロックできないイベントは警告に留める ---
{
  const home = sandbox('warn-sessionstart', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, { hook_event_name: 'SessionStart', cwd: 'C:/org-tree/proj' });
  check('SessionStart は permissionDecision を出さない', decision(res) === null, JSON.stringify(res));
  check('SessionStart は警告を additionalContext で渡す', /org-tree/.test(res?.hookSpecificOutput?.additionalContext || ''), JSON.stringify(res));
}
{
  const home = sandbox('warn-cwdchanged', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, { hook_event_name: 'CwdChanged', cwd: 'C:/org-tree/proj' });
  check('CwdChanged も警告のみ', decision(res) === null && /org-tree/.test(res?.hookSpecificOutput?.additionalContext || ''), JSON.stringify(res));
}

// --- Glob / Grep は path 以外にもパスが入る ---
{
  const home = sandbox('deny-glob-pattern', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Glob',
    tool_input: { pattern: 'C:/org-tree/**/*.py' },
  });
  check('Glob の pattern による列挙を拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  const home = sandbox('deny-grep-glob', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Grep',
    tool_input: { pattern: 'secret', glob: 'C:/org-tree/**' },
  });
  check('Grep の glob による検索を拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  // 検索語は正規表現であってパスではない。ここを見ると grep しただけで止まる。
  const home = sandbox('allow-grep-pattern', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Grep',
    tool_input: { pattern: 'org-tree', path: 'C:/claude/ClaudeCode' },
  });
  check('Grep の検索語がツリー名でも拒否しない', res === null, JSON.stringify(res));
}

// --- 未知のツール(MCP など)は引数からパス形式だけを拾う ---
{
  const home = sandbox('deny-mcp-path', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode',
    tool_name: 'mcp__filesystem__read_file', tool_input: { path: 'C:/org-tree/secret.py' },
  });
  check('未知ツールの絶対パス引数は拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  const home = sandbox('allow-mcp-prose', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode',
    tool_name: 'mcp__memory__write', tool_input: { text: 'org-tree の運用についてのメモ' },
  });
  check('未知ツールでも散文中のツリー名では拒否しない', res === null, JSON.stringify(res));
}

// --- 相対パスは cwd 基準で解決してから判定する ---
// 絶対パスしか見ていなかった頃は、保護ツリー外の cwd から `../../` で上に登る指定が
// 素通りしていた。テストも絶対パスしか書いておらず、そのことに気づけなかった。
{
  const home = sandbox('deny-relative-read', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Read',
    tool_input: { file_path: '../../org-tree/proj/secret.py' },
  });
  check('相対パスで上に登る読み取りを拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  const home = sandbox('deny-relative-bash', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
    tool_input: { command: 'cat ../../org-tree/proj/secret.py' },
  });
  check('コマンド文字列中の相対パスも拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  const home = sandbox('deny-relative-glob', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Glob',
    tool_input: { pattern: '../../org-tree/**/*.py' },
  });
  check('相対パスの Glob による列挙を拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  // 解決先が保護ツリーでなければ通す。相対パスというだけで止めてはいけない。
  const home = sandbox('allow-relative-sibling', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode/account-guard', tool_name: 'Read',
    tool_input: { file_path: '../README.md' },
  });
  check('保護ツリーに届かない相対パスは通す', res === null, JSON.stringify(res));
}

// --- cwd が保護ツリーの「親」にいるときの、降りていく相対パス ---
// `../` を含む形だけを拾っていた頃の穴。降りる指定は cwd の配下にしか届かないので
// cwd が内側なら別の判定で止まる、という理屈だったが、cwd が親にいる場合が抜けていた。
// フィールドの値として解決される Read は同じ指定で拒否されるため、ツールによって
// 結果が食い違い、拒否されない側から保護ツリーを読めてしまう。
{
  const home = sandbox('deny-descend-bash', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/', tool_name: 'Bash',
    tool_input: { command: 'cat org-tree/proj/secret.py' },
  });
  check('親から降りる相対パスをコマンド中でも拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  const home = sandbox('deny-descend-agent', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/', tool_name: 'Agent',
    tool_input: { prompt: 'org-tree/proj のコードを読んで要約して', description: '要約' },
  });
  check('親から降りる相対パスを委譲でも拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  const home = sandbox('deny-descend-mcp', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/',
    tool_name: 'mcp__fs__read', tool_input: { p: 'org-tree/secret.txt' },
  });
  check('未知ツールの降りる相対パスを拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  // 区切りを伴わない言及は、cwd 基準で解決してもツリーの中に落ちない限り通す。
  // ツリー名を口に出しただけで止まると、誤検知の実害のほうが大きくなり、ガードを
  // 外したくなる圧力になる。
  const home = sandbox('allow-mention-descend', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
    tool_input: { command: 'echo org-tree の運用方針をまとめる' },
  });
  check('ツリーの外から見た区切りなしのツリー名の言及は通す', res === null, JSON.stringify(res));
}
{
  // cwd がツリーの親でも、Agent の prompt は自然文であって cd のような「配下を操作する」
  // 指定ではない。シェル限定にした修正1により、区切りなしのツリー名の言及だけでは
  // 拒否しないことを確かめる(以前はここまで拒否され、自然文の委譲まで巻き添えにしていた)。
  const home = sandbox('allow-bare-name-agent-prompt', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/', tool_name: 'Agent',
    tool_input: { prompt: 'org-tree の方針をまとめて', description: '調査' },
  });
  check('Agent の prompt に区切りなしのツリー名が出るだけなら通す', res === null, JSON.stringify(res));
}
{
  // cwd がツリーの「親」にいるときだけは、裸のツリー名も cwd 配下の実在パスを指す。
  // `cd <ツリー名>/` と末尾に区切りを付ければ拒否されるのに、付けないと通るという
  // 食い違いがあり、実際に保護ツリーの中身を読めてしまっていた。
  const home = sandbox('deny-bare-name-from-parent', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/', tool_name: 'Bash',
    tool_input: { command: 'cd org-tree && type secret.txt' },
  });
  check('ツリーの親から裸のツリー名で降りる指定は拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  // 名前の一部が一致するだけの別ディレクトリまで巻き込まない(前方一致では見ない)。
  const home = sandbox('allow-sibling-bare-name', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/', tool_name: 'Bash',
    tool_input: { command: 'cd org-tree-backup && type notes.md' },
  });
  check('似た名前の兄弟ディレクトリは裸の名前でも通す', res === null, JSON.stringify(res));
}
{
  // 別ドライブの同名パスまで cwd 基準で解決すると、無関係な場所の操作が止まる。
  const home = sandbox('allow-other-drive', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/', tool_name: 'Bash',
    tool_input: { command: 'cat D:/org-tree/notes.md' },
  });
  check('別ドライブの同名パスは通す', res === null, JSON.stringify(res));
}

// --- 途中で上に登る絶対パス ---
// 文字列を突き合わせるだけでは `..` が畳まれないため、絶対パスの体裁のまま
// 保護ツリーへ潜り込める。切り出して解決するまで拒否できなかった経路。
{
  const home = sandbox('deny-dotdot-bash', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
    tool_input: { command: 'cat C:/x/../org-tree/secret.txt' },
  });
  check('コマンド中の `..` を含む絶対パスを拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  const home = sandbox('deny-dotdot-mcp', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode',
    tool_name: 'mcp__fs__read', tool_input: { p: 'C:/claude/../org-tree/secret.txt' },
  });
  check('未知ツールの `..` を含む絶対パスを拒否する', decision(res) === 'deny', JSON.stringify(res));
}

// --- Git Bash / MSYS のドライブ表記 ---
// このマシンの Bash ツールは Git Bash なので `/c/...` で同じ場所に届く。
// 表記を替えるだけで保護をすり抜けられてはいけない。
{
  const home = sandbox('deny-msys-bash', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
    tool_input: { command: 'cat /c/org-tree/secret.txt' },
  });
  check('Git Bash 形式(/c/...)の読み取りを拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  const home = sandbox('deny-msys-cygdrive', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'PowerShell',
    tool_input: { command: 'Get-Content /cygdrive/c/org-tree/secret.txt' },
  });
  check('cygdrive 形式の読み取りを拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  const home = sandbox('deny-msys-grep', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Grep',
    tool_input: { pattern: 'secret', glob: '/c/org-tree/**' },
  });
  check('Git Bash 形式の glob 検索を拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  const home = sandbox('deny-msys-mcp', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode',
    tool_name: 'mcp__fs__read', tool_input: { p: '/c/org-tree/secret.txt' },
  });
  check('未知ツールの Git Bash 形式パスを拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  // 区切り記号を列挙して前置文字を見ていた頃、リダイレクトやブレース展開の直後が
  // 変換されず素通りしていた。特に `>` は保護ツリーへの書き込みが通ってしまう。
  const home = sandbox('deny-msys-redirect', { subscriptionType: 'pro', rules: ORG });
  const cases = [
    ['入力リダイレクトの直後', 'cat </c/org-tree/secret.txt'],
    ['出力リダイレクトの直後(書き込み)', 'echo x >/c/org-tree/f.txt'],
    ['区切りを重ねた表記', 'cat /c//org-tree/secret.txt'],
    ['ブレース展開の中', 'cat {/c/org-tree/secret.txt,x}'],
  ];
  for (const [label, command] of cases) {
    const res = run(home, {
      hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
      tool_input: { command },
    });
    check(`Git Bash 形式を拒否する — ${label}`, decision(res) === 'deny', JSON.stringify(res));
  }
}
{
  // Git Bash 形式に `.` / `..` が混ざる形。文字列の書き換えだけでは畳めないので、
  // Windows 形式に直してから解決する必要がある
  const home = sandbox('deny-msys-dots', { subscriptionType: 'pro', rules: ORG });
  for (const [label, command] of [
    ['カレント参照を挟む', 'ls /c/./org-tree'],
    ['上に登る', 'cat /c/x/../org-tree/secret.txt'],
  ]) {
    const res = run(home, {
      hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
      tool_input: { command },
    });
    check(`Git Bash 形式を拒否する — ${label}`, decision(res) === 'deny', JSON.stringify(res));
  }
}
{
  // ドライブのコロン直後の `/c/` は Windows パスの一部。ここを MSYS と誤認すると
  // `d:c:/org-tree` という壊れた文字列になり、無関係なパスを拒否してしまう
  const home = sandbox('allow-drive-then-c', { subscriptionType: 'pro', rules: ORG });
  for (const [label, file] of [
    ['ドライブ直下の c/', 'D:/c/org-tree/notes.md'],
    ['対照(2文字)', 'D:/cc/org-tree/notes.md'],
  ]) {
    const res = run(home, {
      hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Read',
      tool_input: { file_path: file },
    });
    check(`別ドライブの同名パスを誤検知しない — ${label}`, res === null, JSON.stringify(res));
  }
}
{
  // 拒否できないイベントに登録された場合、deny 形式を返しても破棄される。
  // 三種類目以降のイベントでも警告に落ちること
  const home = sandbox('warn-other-event', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, { hook_event_name: 'UserPromptSubmit', cwd: 'C:/org-tree/proj' });
  check('未知のイベントでは deny でなく警告を返す',
    decision(res) === null && res?.hookSpecificOutput?.hookEventName === 'UserPromptSubmit',
    JSON.stringify(res));
}
{
  const home = sandbox('deny-double-slash-win', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
    tool_input: { command: 'cat C://org-tree/secret.txt' },
  });
  check('Windows 形式でも区切りを重ねた表記を拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  // 変換が効きすぎないこと。パスの途中の `/c/` は別物なので巻き込まない
  const home = sandbox('allow-midpath-c', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
    tool_input: { command: 'cat C:/proj/c/org-tree/x.md' },
  });
  check('パス途中の /c/ をドライブ表記と誤認しない', res === null, JSON.stringify(res));
}
{
  // 表記の変換が過剰に効いて無関係なパスを巻き込まないこと。
  const home = sandbox('allow-msys-unrelated', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
    tool_input: { command: 'cat /c/claude/ClaudeCode/README.md' },
  });
  check('Git Bash 形式でも無関係なパスは通す', res === null, JSON.stringify(res));
}

// --- 設定が壊れているとき ---
// 「未作成 = 保護なし」は意図した状態だが、「あるが壊れている」は事故。以前はどちらも
// 保護なしにしていたため、末尾カンマ1つで全ての保護が無言で消えていた。
{
  const home = sandbox('broken-config', { subscriptionType: 'pro', rawRules: '{ "rules": [ , ] }' });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read',
    tool_input: { file_path: 'secret.py' },
  });
  check('設定が壊れていたら拒否側に倒す', decision(res) === 'deny', JSON.stringify(res));
  check('拒否理由に設定ファイルのパスが入る',
    /config\.json/.test(res?.hookSpecificOutput?.permissionDecisionReason || ''), JSON.stringify(res));
}
{
  const home = sandbox('broken-config-outside', { subscriptionType: 'pro', rawRules: '{ "rules": [ , ] }' });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
    tool_input: { command: 'echo hello' },
  });
  check('設定が壊れていればツリー外の操作も拒否する', decision(res) === 'deny', JSON.stringify(res));
}
{
  // 拒否一色にすると Claude Code の中から直せなくなる。修復の口だけは開けておく。
  const home = sandbox('broken-config-repair', { subscriptionType: 'pro', rawRules: '{ "rules": [ , ] }' });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Edit',
    tool_input: { file_path: configPath(home) },
  });
  check('壊れた設定ファイル自身の編集は通す', res === null, JSON.stringify(res));
}
{
  const home = sandbox('broken-config-rules-type', { subscriptionType: 'pro', rawRules: '{ "rules": "C:/org-tree" }' });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Read',
    tool_input: { file_path: 'README.md' },
  });
  check('rules が配列でない設定も壊れた扱いにする', decision(res) === 'deny', JSON.stringify(res));
}
{
  // 空配列を明示したときだけは「保護なし」を意図した設定として通す。
  const home = sandbox('empty-rules', { subscriptionType: 'pro', rawRules: '{ "rules": [] }' });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read', tool_input: {},
  });
  check('rules を空配列にした設定は保護なしとして通す', res === null, JSON.stringify(res));
}

// --- ガード自身が異常終了したとき ---
// 以前は無条件に deny していたため、ガードが壊れた瞬間に全ツールが止まり、ガード自身を
// 直す Edit も通らなくなった。判定できる範囲 = cwd だけを見て、保護ツリー外は通す。
{
  fs.mkdirSync(BASE, { recursive: true });
  const CRASH = path.join(BASE, 'ag-crash.js');
  // ガード本体は同じディレクトリの credentials.js を require する。コピー先は .tmp なので
  // 相対参照のままでは解決できない。実体を指す絶対パスへ書き換えてから落とす
  const credModule = JSON.stringify(path.join(__dirname, '..', 'credentials.js'));
  fs.writeFileSync(
    CRASH,
    fs.readFileSync(GUARD, 'utf8')
      .replace("require('./credentials')", `require(${credModule})`)
      .replace('function main() {', "function main() {\n  throw new Error('boom');"),
    'utf8'
  );
  const runCrash = (home, input) => {
    const env = { ...process.env, USERPROFILE: home, HOME: home, NO_COLOR: '1' };
    const out = execFileSync(process.execPath, [CRASH], {
      env, input: JSON.stringify(input), encoding: 'utf8',
    });
    return out.trim() ? JSON.parse(out) : null;
  };

  const home = sandbox('crash', { subscriptionType: 'pro', rules: ORG });
  let res = runCrash(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
    tool_input: { command: 'echo hello' },
  });
  check('異常終了しても保護ツリー外の操作は通す', res === null, JSON.stringify(res));

  res = runCrash(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read',
    tool_input: { file_path: 'a.py' },
  });
  check('異常終了かつ cwd が保護ツリー内なら拒否する', decision(res) === 'deny', JSON.stringify(res));
  check('異常終了の拒否理由に復旧手順が入る',
    /git checkout/.test(res?.hookSpecificOutput?.permissionDecisionReason || ''), JSON.stringify(res));

  res = runCrash(home, { hook_event_name: 'SessionStart', cwd: 'C:/org-tree/proj' });
  check('異常終了が SessionStart なら deny でなく警告を返す',
    res?.hookSpecificOutput?.hookEventName === 'SessionStart' && decision(res) === null, JSON.stringify(res));

  const noRules = sandbox('crash-norules', { subscriptionType: 'pro' });
  res = runCrash(noRules, {
    hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read', tool_input: {},
  });
  check('保護ルール未設定なら異常終了でも何も拒否しない', res === null, JSON.stringify(res));
}

// --- credentials.js を隣に置き忘れた構成 ---
// インストール手順は account-guard.js の置き場所しか案内していないので、1 ファイルだけ
// コピーする使い方が実際に起こりうる。require をトップレベルで素通しにすると、そこで
// MODULE_NOT_FOUND が投げられて末尾の catch(異常終了を受け止める仕組み)より先に
// プロセスが死ぬ。標準出力に何も出ないまま exit 1 で終わるため、Claude Code はブロックせず
// 処理を続け、保護が丸ごと外れたことに誰も気づけない。判別不能として拒否側に倒すこと。
{
  const ALONE = path.join(BASE, 'alone-guard', 'account-guard.js');
  fs.mkdirSync(path.dirname(ALONE), { recursive: true });
  fs.copyFileSync(GUARD, ALONE); // credentials.js は意図的に置かない

  const runAlone = (home, input) => {
    const env = { ...process.env, USERPROFILE: home, HOME: home, NO_COLOR: '1' };
    const out = execFileSync(process.execPath, [ALONE], {
      env, input: JSON.stringify(input), encoding: 'utf8',
    });
    return out.trim() ? JSON.parse(out) : null;
  };

  // 許可されたアカウント(team)で入っている。credentials.js があれば通る操作なので、
  // ここで deny が出れば「読めないから拒否側に倒した」ことがはっきりする。
  const home = sandbox('alone-home', { subscriptionType: 'team', rules: ORG });
  let res = runAlone(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read',
    tool_input: { file_path: 'a.py' },
  });
  check('credentials.js が無くても保護ツリーは拒否する', decision(res) === 'deny', JSON.stringify(res));
  // 真因は隣のファイルなのに /login を促すと、正しいアカウントで入っている人が
  // 何度ログインし直しても直らない袋小路に入る。拒否の文面が真因を指すこと。
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('拒否理由が真因(credentials.js が読めない)を指す',
    /credentials\.js/.test(reason), reason);
  check('効かない対処(/login)を唯一の次の一手として案内しない',
    /`\/login` では直りません/.test(reason), reason);
  // 他の deny 経路にはある一文。設置ミスだと読んだ Claude が「ガードの都合だから」と
  // 別経路(ツリー名を書かない Bash など)で読み直すと、保護の目的そのものが崩れる。
  check('この経路でも迂回禁止とユーザーへの報告を指示する',
    /回避しようとせず/.test(reason) && /ユーザー/.test(reason), reason);

  // 確認用の入り口(status)でも真因を出す。'アカウント: unknown' だけでは未ログインと
  // 区別が付かず、deny 側でわざわざ塞いだ袋小路(/login の繰り返し)をここで踏む。
  const statusOut = execFileSync(process.execPath, [ALONE, 'status'], {
    env: { ...process.env, USERPROFILE: home, HOME: home, NO_COLOR: '1' }, encoding: 'utf8',
  });
  check('status も credentials.js が読めないことを言う',
    /credentials\.js/.test(statusOut) && /`\/login` では直りません/.test(statusOut), statusOut);

  res = runAlone(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
    tool_input: { command: 'echo hello' },
  });
  check('credentials.js が無くても保護ツリー外は巻き込まない', res === null, JSON.stringify(res));
}

// --- credentials.js は同名で存在するが、必要なエクスポートが欠けている構成 ---
// require 自体は成功するが、無関係な・古い credentials.js が同名で置かれていると
// HOME 等が undefined になり得る。以前はこれを検証せずに使っていたため、この先の
// path.join(HOME, ...) がトップレベルで例外を投げてプロセスごと落ちていた
// (標準出力なし・exit 1 = 無言 fail-open。require が成功したかどうかしか見ていなかった
// ことが原因)。require が成功しても中身の形を検証し、欠けていれば「読み込めない」場合と
// 同じ扱いに合流することを確かめる。
{
  const BADSHAPE_DIR = path.join(BASE, 'badshape-guard');
  fs.mkdirSync(BADSHAPE_DIR, { recursive: true });
  const BADSHAPE_GUARD = path.join(BADSHAPE_DIR, 'account-guard.js');
  fs.copyFileSync(GUARD, BADSHAPE_GUARD);
  // HOME を欠いた、無関係な credentials.js。require 自体は成功するが中身は使えない形。
  fs.writeFileSync(
    path.join(BADSHAPE_DIR, 'credentials.js'),
    "module.exports = { ACCOUNT_UNKNOWN: 'unknown' };",
    'utf8'
  );

  const runBadShape = (home, input) => {
    const env = { ...process.env, USERPROFILE: home, HOME: home, NO_COLOR: '1' };
    const out = execFileSync(process.execPath, [BADSHAPE_GUARD], {
      env, input: JSON.stringify(input), encoding: 'utf8',
    });
    return out.trim() ? JSON.parse(out) : null;
  };

  const home = sandbox('badshape-home', { subscriptionType: 'team', rules: ORG });
  const res = runBadShape(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read',
    tool_input: { file_path: 'a.py' },
  });
  // 無言で終わっていない(= プロセスが落ちて exit 1 で fail-open していない)ことがまず要点。
  check('形式が不正な credentials.js でも無言で終わらず出力を返す', res !== null, JSON.stringify(res));
  check('形式が不正な credentials.js でも保護ツリーは拒否する', decision(res) === 'deny', JSON.stringify(res));
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('拒否理由が credentials.js の問題を指す', /credentials\.js/.test(reason), reason);
  check('効かない対処(/login)を唯一の次の一手として案内しない',
    /`\/login` では直りません/.test(reason), reason);

  // readCredentials だけを欠く形。他のエクスポートが揃っているため見逃されやすいが、
  // 検証を素通りすると readableCredentials() の catch が拾って「credentials が壊れている」
  // という別の案内に落ち、真因(隣の credentials.js)がどこにも出なくなる。
  const NOREAD_DIR = path.join(BASE, 'noread-guard');
  fs.mkdirSync(NOREAD_DIR, { recursive: true });
  const NOREAD_GUARD = path.join(NOREAD_DIR, 'account-guard.js');
  fs.copyFileSync(GUARD, NOREAD_GUARD);
  fs.writeFileSync(
    path.join(NOREAD_DIR, 'credentials.js'),
    "module.exports = { HOME: 'C:/nowhere', CREDENTIALS: 'C:/nowhere/.credentials.json',"
      + " ACCOUNT_UNKNOWN: 'unknown', currentAccount: () => 'unknown' };",
    'utf8'
  );
  const noreadHome = sandbox('noread-home', { subscriptionType: 'team', rules: ORG });
  const noreadRes = (() => {
    const env = { ...process.env, USERPROFILE: noreadHome, HOME: noreadHome, NO_COLOR: '1' };
    const out = execFileSync(process.execPath, [NOREAD_GUARD], {
      env,
      input: JSON.stringify({
        hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read',
        tool_input: { file_path: 'a.py' },
      }),
      encoding: 'utf8',
    });
    return out.trim() ? JSON.parse(out) : null;
  })();
  check('readCredentials を欠く credentials.js でも保護ツリーは拒否する',
    decision(noreadRes) === 'deny', JSON.stringify(noreadRes));
  const noreadReason = noreadRes?.hookSpecificOutput?.permissionDecisionReason || '';
  check('拒否理由が credentials.js の形式を真因として指す',
    /credentials\.js/.test(noreadReason) && /`\/login` では直りません/.test(noreadReason),
    noreadReason);
}

// --- HOME を導出できない環境 ---
// credentials.js が読めず、かつ USERPROFILE も HOME も未設定の環境では、フォールバックの
// 最後の砦を '.' にすると CONFIG が cwd 配下(./.claude/account-guard/config.json)として
// 解決されてしまう。cwd から読めてしまうと、たまたま設定の無い場所では保護が丸ごと外れる
// (exit 0・標準出力なし = fail-open)。os.homedir() を最後の砦にすることで、cwd に本物の
// ルールを置いても、それが設定として読まれないことを確かめる。
//
// 環境変数の delete / 空文字では再現できない(このマシンで実測して確認した Windows 特有の癖):
//   - delete すると、Windows では子プロセス生成時に libuv が USERPROFILE / HOMEDRIVE などを
//     実在する値で勝手に補ってしまう(キーが丸ごと無いときだけ発動する)。すると
//     `process.env.USERPROFILE || ...` の最初の項で真になり、直したい3項目め
//     (`|| os.homedir()`)自体を通らない。バグを戻しても再現できず、テストとして無意味になる。
//   - 空文字にすると、Windows の os.homedir() は USERPROFILE が「空文字として存在する」だけで
//     その空文字をそのまま返す(実プロファイルへはフォールバックしない)。つまり
//     `|| os.homedir()` に辿り着いても壊れた値(空文字)になり、修正前の `'.'` と
//     見分けが付かない(どちらも cwd 相対に解決されて同じ結果になる)。
// そこで os.homedir() 自体をテスト用の値に差し替え、cwd とは無関係な既知の場所を返すようにする。
// これで「3項目めまで来たら cwd ではなくその値が使われる」ことを確定的に検証できる。
{
  const ALONE_DIR = path.join(BASE, 'homefallback-alone');
  fs.mkdirSync(ALONE_DIR, { recursive: true });
  fs.copyFileSync(GUARD, path.join(ALONE_DIR, 'account-guard.js')); // credentials.js は意図的に置かない

  // os.homedir() の差し替え先。cwd(後述の home)とは別物で、かつ設定ファイルを一切
  // 置かない実在しないディレクトリにする。ここが CONFIG の基準になれば「ルール未設定」
  // として何も拒否されないはずで、cwd 側のルールが読まれていないことの裏付けになる。
  const FAKE_HOME = path.join(BASE, 'homefallback-real-home');
  const RUNNER = path.join(ALONE_DIR, 'run-with-fake-home.js');
  fs.writeFileSync(RUNNER, [
    "'use strict';",
    `require('os').homedir = () => ${JSON.stringify(FAKE_HOME)};`,
    "require('./account-guard.js');", // 差し替え後に本体を読み込む。os は Node 内でキャッシュ共有される
  ].join('\n'), 'utf8');

  // cwd には「本物の」保護ルールを置く。HOME='.' のバグが残っていれば、これが読まれて拒否される。
  const TARGET = path.join(BASE, 'nohome-target');
  const home = sandbox('nohome-cwd', { rules: [{ tree: TARGET, allow: [] }] });

  const env = { ...process.env, NO_COLOR: '1', USERPROFILE: '', HOME: '' };

  const out = execFileSync(process.execPath, [RUNNER], {
    cwd: home, // プロセスの実際の cwd。HOME='.' のバグがあればここが CONFIG の基準になる
    env,
    input: JSON.stringify({
      hook_event_name: 'PreToolUse', cwd: TARGET, tool_name: 'Read', tool_input: { file_path: 'x' },
    }),
    encoding: 'utf8',
  });
  const res = out.trim() ? JSON.parse(out) : null;
  check('HOME が無い環境でも設定をカレントディレクトリから読まない', res === null, JSON.stringify(res));
}

// --- HOME 導出の入力が全て空文字を返す環境(credentials.js を正しく置いた通常構成) ---
// 上のテストは credentials.js を意図的に置かない構成でしか「HOME を導出できない」ケースを
// 検証していない。credentials.js 自身にも同じ穴(os.homedir() が空文字を返す環境では
// HOME='' になり、CREDENTIALS / CONFIG が cwd 相対に解決される)があったため、
// credentials.js が存在する通常構成でも同じことが成り立つことを確かめる。
// 環境変数の delete / 空文字だけでは再現できない事情は上のテストのコメントと同じ
// (Windows の libuv 補完・os.homedir() の空文字そのまま返し)なので、
// os.homedir() 自体を差し替える方式に倣う。
{
  const NORMAL_DIR = path.join(BASE, 'homefallback-normal');
  fs.mkdirSync(NORMAL_DIR, { recursive: true });
  fs.copyFileSync(GUARD, path.join(NORMAL_DIR, 'account-guard.js'));
  fs.copyFileSync(path.join(__dirname, '..', 'credentials.js'), path.join(NORMAL_DIR, 'credentials.js'));

  const RUNNER2 = path.join(NORMAL_DIR, 'run-with-empty-home.js');
  fs.writeFileSync(RUNNER2, [
    "'use strict';",
    "require('os').homedir = () => '';", // os.homedir() 自体が空文字を返す壊れた環境を再現
    "require('./account-guard.js');", // os は Node 内でキャッシュ共有されるので credentials.js 側にも効く
  ].join('\n'), 'utf8');

  // cwd には「本物の」保護ルールを置く。HOME='' のバグが残っていれば cwd 相対に解決され、
  // それが読まれて偶然 deny されただけ、という誤検証になる。ツール呼び出し自体は
  // この保護ルールと無関係にして、「HOME を特定できない」という理由で拒否されることを見る。
  const TARGET2 = path.join(BASE, 'emptyhome-target');
  const home2 = sandbox('emptyhome-cwd', { rules: [{ tree: TARGET2, allow: [] }] });

  const env2 = { ...process.env, NO_COLOR: '1', USERPROFILE: '', HOME: '' };
  const out2 = execFileSync(process.execPath, [RUNNER2], {
    cwd: home2,
    env: env2,
    input: JSON.stringify({
      hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
    }),
    encoding: 'utf8',
  });
  const res2 = out2.trim() ? JSON.parse(out2) : null;
  // 無言で fail-open していない(素通し = res===null)ことが要点。保護対象と無関係な
  // Bash 呼び出しでも、HOME を特定できない間は安全側に倒して拒否する。
  check('credentials.js が正しく揃っていても HOME が全滅なら無言で通さない', res2 !== null, JSON.stringify(res2));
  check('credentials.js が正しく揃っていても HOME が全滅なら拒否する', decision(res2) === 'deny', JSON.stringify(res2));
  const reason2 = res2?.hookSpecificOutput?.permissionDecisionReason || '';
  check('拒否理由が HOME を特定できないことを言う(無言で終わっていない)',
    /HOME|ホームディレクトリ/.test(reason2), reason2);

  // 空白のみの HOME。空文字は falsy なので素朴な `||` チェーンでも先へ進むが、空白のみは
  // truthy なため usableHome の trim() が無いとそのまま採用され、path.join(' ', ...) が
  // cwd 配下の実在しない場所を指して「設定が無い」= ルール 0 件の素通しに戻る。
  // trim() を消すリグレッションを捉えられるのはこの経路だけなので、空文字とは別に見る。
  const RUNNER3 = path.join(NORMAL_DIR, 'run-with-blank-home.js');
  fs.writeFileSync(RUNNER3, [
    "'use strict';",
    "require('os').homedir = () => '   ';",
    "require('./account-guard.js');",
  ].join('\n'), 'utf8');

  const out3 = execFileSync(process.execPath, [RUNNER3], {
    cwd: home2,
    env: { ...process.env, NO_COLOR: '1', USERPROFILE: '   ', HOME: '   ' },
    input: JSON.stringify({
      hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
    }),
    encoding: 'utf8',
  });
  const res3 = out3.trim() ? JSON.parse(out3) : null;
  check('空白のみの HOME でも無言で通さない', res3 !== null, JSON.stringify(res3));
  check('空白のみの HOME でも拒否する', decision(res3) === 'deny', JSON.stringify(res3));
  check('空白のみの HOME でも理由が HOME を特定できないことを言う',
    /HOME|ホームディレクトリ/.test(res3?.hookSpecificOutput?.permissionDecisionReason || ''),
    JSON.stringify(res3));

  // HOME 未解決のときは CONFIG がダミーの相対パスになるため、通常の修復経路
  // (isConfigRepair = CONFIG 自身の編集を通す)は絶対パスと決して一致せず成立しない。
  // 逃げ道が 1 つも無いと、フック登録を外すことも環境変数を直すこともできず、Claude Code の
  // 中から復旧不能になる(外部エディタや git で戻すしかなくなる)。settings.json の
  // 読み書きだけは通ることを確かめる。ここで保護の穴は増えない: HOME が不明な時点で
  // 保護ツリーも特定できておらず、そもそも何も保護できていない。
  const settingsTarget = path.join(home2, '.claude', 'settings.json');
  for (const tool of ['Read', 'Edit', 'Write']) {
    const out4 = execFileSync(process.execPath, [RUNNER2], {
      cwd: home2,
      env: env2,
      input: JSON.stringify({
        hook_event_name: 'PreToolUse', cwd: home2, tool_name: tool,
        tool_input: { file_path: settingsTarget },
      }),
      encoding: 'utf8',
    });
    check(`HOME 未解決でも settings.json の ${tool} は通す(復旧経路を残す)`,
      out4.trim() === '', out4);
  }
  // 逃げ道は settings.json だけ。無関係なファイルまで通すと、HOME 未解決を騙る形で
  // 保護が外れる余地が広がる。
  const out5 = execFileSync(process.execPath, [RUNNER2], {
    cwd: home2,
    env: env2,
    input: JSON.stringify({
      hook_event_name: 'PreToolUse', cwd: home2, tool_name: 'Edit',
      tool_input: { file_path: path.join(home2, 'notes.txt') },
    }),
    encoding: 'utf8',
  });
  check('HOME 未解決でも settings.json 以外は通さない', out5.trim() !== '', out5);
  check('逃げ道は拒否メッセージにも書いてある(書かないと気づけない)',
    /settings\.json/.test(res2?.hookSpecificOutput?.permissionDecisionReason || ''),
    JSON.stringify(res2));
}

console.log(`\n  ${state.pass} passed, ${state.fail} failed`);
process.exit(state.fail ? 1 : 0);
