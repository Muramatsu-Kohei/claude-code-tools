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

// subscriptionType だけを持つ最小の credentials を置く。raw に文字列を渡すと
// 壊れたファイルを再現でき、「読めないときに拒否側へ倒れるか」を試せる。
function sandbox(name, { subscriptionType, rules, raw } = {}) {
  const home = path.join(BASE, name);
  fs.mkdirSync(path.join(home, '.claude', 'account-guard'), { recursive: true });
  const cred = path.join(home, '.claude', '.credentials.json');
  if (raw !== undefined) fs.writeFileSync(cred, raw, 'utf8');
  else if (subscriptionType) fs.writeFileSync(cred, JSON.stringify({ claudeAiOauth: { subscriptionType } }), 'utf8');
  if (rules) {
    fs.writeFileSync(path.join(home, '.claude', 'account-guard', 'config.json'), JSON.stringify({ rules }), 'utf8');
  }
  return home;
}

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

console.log(`\n  ${state.pass} passed, ${state.fail} failed`);
process.exit(state.fail ? 1 : 0);
