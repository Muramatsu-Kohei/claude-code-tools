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

const BASE = path.join(__dirname, '.tmp');
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
  fs.writeFileSync(
    CRASH,
    fs.readFileSync(GUARD, 'utf8').replace('function main() {', "function main() {\n  throw new Error('boom');"),
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

console.log(`\n  ${state.pass} passed, ${state.fail} failed`);
process.exit(state.fail ? 1 : 0);
