// move サブコマンド(変更10 / F10 の修復手段)の回帰テスト。
// 偽 HOME に 2 つのプロジェクトのログを置き、引っ越しの結果をファイルの中身で確かめる。
const fs = require('fs');
const path = require('path');
const { tmpDir, sandboxHome, checks, runner } = require('./lib');

const BASE = tmpDir('move');
const { home, logDir } = sandboxHome(BASE);
const SESSIONS_DIR = path.join(home, '.claude', 'sessions');

const { check, finish } = checks();
const run = runner(home, BASE);

const SID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const SID_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const SID_C = 'cccccccc-1111-2222-3333-444444444444';

const rec = (k, sid, ts, extra) => JSON.stringify({ k, sid, ts, cwd: 'C:\\claude\\utility', ...extra });

// 移動元には「壊れた行」と「sid の無い行」も混ぜる。書き戻しで静かに消えないことの確認用
function reset() {
  fs.rmSync(logDir, { recursive: true, force: true });
  fs.rmSync(SESSIONS_DIR, { recursive: true, force: true });
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const old = [
    rec('start', SID_A, 1000, { head: 'h1', branch: 'main' }),
    rec('note', SID_A, 1100, { summary: 'A の作業', done: ['x'] }),
    rec('end', SID_A, 1200, { stats: { commits: [], files: ['a.js'] } }),
    rec('start', SID_B, 2000, { head: 'h2' }),
    rec('note', SID_B, 2100, { summary: 'B の作業' }),
    rec('end', SID_B, 2200, {}),
    '{ broken json',
    JSON.stringify({ k: 'note', ts: 3000, summary: 'sid なし' }),
  ].join('\n');
  fs.writeFileSync(path.join(logDir, 'C--claude-utility.ndjson'), `${old}\n`, 'utf8');
  fs.writeFileSync(path.join(logDir, 'C--claude-ClaudeCode.ndjson'),
    `${rec('start', SID_C, 5000, {})}\n${rec('note', SID_C, 5100, { summary: 'C の作業' })}\n`, 'utf8');
}

function lines(key) {
  const p = path.join(logDir, `${key}.ndjson`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
}

function sidsIn(key) {
  return (lines(key) || []).map((l) => { try { return JSON.parse(l).sid; } catch { return '?'; } });
}

// 起動中セッションの一覧に偽の 1 件を置く。pid の生存確認が走るので自分の pid を使う
function fakeLive(sid, pid) {
  fs.writeFileSync(path.join(SESSIONS_DIR, '1.json'),
    JSON.stringify({ pid: pid == null ? process.pid : pid, sessionId: sid, kind: 'interactive', status: 'idle' }), 'utf8');
}

// --- 1. dry-run は何も書かない -------------------------------------------------
reset();
console.log('1. --dry-run');
let r = run(['move', '--from', 'utility', '--to', 'ClaudeCode', '--all', '--dry-run']);
check('exit 0', r.code === 0, r.err);
check('[dry-run] と表示', r.out.includes('[dry-run]'), r.out);
check('2 セッションを列挙', (r.out.match(/移動 /g) || []).length === 2, r.out);
check('元ファイルは無変更', (lines('C--claude-utility') || []).length === 8);
check('移動先は無変更', (lines('C--claude-ClaudeCode') || []).length === 2);

// --- 2. --session で 1 セッションだけ移す --------------------------------------
reset();
console.log('2. --session(先頭一致)');
r = run(['move', '--from', 'utility', '--to', 'ClaudeCode', '--session', 'aaaaaaaa']);
check('exit 0', r.code === 0, r.err);
check('A の 3 レコードが移動先に付いた', (lines('C--claude-ClaudeCode') || []).length === 5, String((lines('C--claude-ClaudeCode') || []).length));
check('移動先に A が入った', sidsIn('C--claude-ClaudeCode').filter((s) => s === SID_A).length === 3);
check('元に A は残っていない', !sidsIn('C--claude-utility').includes(SID_A));
check('元に B は残る', sidsIn('C--claude-utility').filter((s) => s === SID_B).length === 3);
check('壊れた行と sid なし行は元に残る', (lines('C--claude-utility') || []).length === 5, JSON.stringify(lines('C--claude-utility')));
check('元ファイルは残る', lines('C--claude-utility') !== null);
check('移動先の一覧に A が出る', run(['list', '--project', 'C--claude-ClaudeCode', '-n', '10']).out.includes('A の作業'));
check('cwd は書き換えない', fs.readFileSync(path.join(logDir, 'C--claude-ClaudeCode.ndjson'), 'utf8').includes('C:\\\\claude\\\\utility'));

// --- 3. --all で全部移すと元ファイルが消える -----------------------------------
reset();
console.log('3. --all で残りが無くなる場合');
fs.writeFileSync(path.join(logDir, 'C--claude-utility.ndjson'),
  `${rec('start', SID_A, 1000, {})}\n${rec('note', SID_A, 1100, { summary: 'A の作業' })}\n`, 'utf8');
r = run(['move', '--from', 'utility', '--to', 'ClaudeCode', '--all']);
check('exit 0', r.code === 0, r.err);
check('元ファイルが削除された', lines('C--claude-utility') === null);
check('削除を報告', r.out.includes('削除した'), r.out);
check('移動先に 4 レコード', (lines('C--claude-ClaudeCode') || []).length === 4);

// --- 4. 生存セッションは既定で外す、--force で押し切る -------------------------
reset();
console.log('4. 生存セッション');
fakeLive(SID_B);
r = run(['move', '--from', 'utility', '--to', 'ClaudeCode', '--all']);
check('exit 0(A は移せる)', r.code === 0, r.err);
check('B をスキップと表示', r.out.includes('スキップ(起動中)') && r.out.includes(SID_B.slice(0, 8)), r.out);
check('--force の案内', r.out.includes('--force'), r.out);
check('B は元に残る', sidsIn('C--claude-utility').filter((s) => s === SID_B).length === 3);
check('A は移動した', sidsIn('C--claude-ClaudeCode').filter((s) => s === SID_A).length === 3);
r = run(['move', '--from', 'utility', '--to', 'ClaudeCode', '--session', SID_B, '--force']);
check('--force で B も移る', r.code === 0 && sidsIn('C--claude-ClaudeCode').filter((s) => s === SID_B).length === 3, r.err + r.out);

reset();
fakeLive(SID_B);
r = run(['move', '--from', 'utility', '--to', 'ClaudeCode', '--session', 'bbbbbbbb']);
check('選択が全部生存中なら exit 1', r.code === 1, `code=${r.code} ${r.out}`);
check('移動先は無変更', (lines('C--claude-ClaudeCode') || []).length === 2);

reset();
fakeLive(SID_B, 999999); // 落ちたプロセスの残骸
r = run(['move', '--from', 'utility', '--to', 'ClaudeCode', '--session', 'bbbbbbbb']);
check('死んだ pid は無視して移動', r.code === 0 && sidsIn('C--claude-ClaudeCode').includes(SID_B), r.err + r.out);

// --- 5. 引数のエラー ----------------------------------------------------------
reset();
console.log('5. 引数のエラー');
r = run(['move', '--from', 'utility']);
check('--to 無しで exit 1', r.code === 1 && r.err.includes('使い方'), r.err);
r = run(['move', '--from', 'utility', '--to', 'ClaudeCode']);
check('--all / --session 無しで exit 1', r.code === 1 && r.err.includes('--all'), r.err);
r = run(['move', '--from', 'nowhere', '--to', 'ClaudeCode', '--all']);
check('移動元が無いと exit 1', r.code === 1 && r.err.includes('一致するプロジェクトがない'), r.err);
r = run(['move', '--from', 'C--claude', '--to', 'ClaudeCode', '--all']);
check('移動元があいまいなら exit 1', r.code === 1 && r.err.includes('件のプロジェクトに一致'), r.err);
r = run(['move', '--from', 'utility', '--to', 'utility', '--all']);
check('同じキーなら exit 1', r.code === 1 && r.err.includes('同じキー'), r.err);
r = run(['move', '--from', 'utility', '--to', 'ClaudeCode', '--session', 'zzzz']);
check('無いセッションなら exit 1', r.code === 1 && r.err.includes('無いセッション'), r.err);
check('エラー時は何も書き換えない', (lines('C--claude-utility') || []).length === 8 && (lines('C--claude-ClaudeCode') || []).length === 2);

// --- 6. 新しいキー(パス指定)への移動 ----------------------------------------
reset();
console.log('6. --to にパスを指定(記録がまだ無い移動先)');
r = run(['move', '--from', 'utility', '--to', 'C:\\claude\\NewPlace', '--all']);
check('exit 0', r.code === 0, r.err);
check('ディスク上に無い移動先は警告する', r.out.includes('ディスク上に無い'), r.out);
check('新しいファイルができた', lines('C--claude-NewPlace') !== null, fs.readdirSync(logDir).join(','));
check('6 レコード入った', (lines('C--claude-NewPlace') || []).length === 6);

// --- 7. help に move が出る --------------------------------------------------
check('help に move', run(['help']).out.includes('worklog move --from'));

finish();
