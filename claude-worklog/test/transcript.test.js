// 変更1(会話ログのパスをフック入力の transcript_path から受け取る)と
// 変更2(プロジェクト = git リポジトリ)の回帰テスト。
// F1: 会話ログの置き場所は cwd から決まるため、git ルート由来のキーで組み立てると
// 子ディレクトリで開いたセッションの turns / edits が 0 になる。それを防げているか見る。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { WORKLOG, TOOL_DIR, tmpDir, projectKey, repoRoot, sandboxHome, checks, runner } = require('./lib');

const BASE = tmpDir('transcript');
const { home, logDir } = sandboxHome(BASE, { autoSummary: false });
const CWD = TOOL_DIR;          // 子ディレクトリで開いたセッションを模す
const REPO_KEY = projectKey(repoRoot()); // 記録はリポジトリのキーに入るはず

const { check, finish } = checks();
const run = runner(home, CWD);
const hook = (args, input) => run([args], { input });

function transcript(sid) {
  const t = (o) => JSON.stringify(o);
  return [
    t({ type: 'user', message: { content: 'これを直して' }, timestamp: '2026-07-31T01:00:00.000Z' }),
    t({ type: 'assistant', timestamp: '2026-07-31T01:00:10.000Z', message: { content: [
      { type: 'text', text: 'やります' },
      { type: 'tool_use', name: 'Edit', input: { file_path: path.join(TOOL_DIR, 'worklog.js') } },
    ] } }),
    t({ type: 'user', message: { content: 'ありがとう' }, timestamp: '2026-07-31T01:05:00.000Z' }),
    t({ type: 'ai-title', aiTitle: `テスト ${sid}` }),
  ].join('\n');
}

function readLog() {
  return fs.readFileSync(path.join(logDir, `${REPO_KEY}.ndjson`), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
}

// --- ケースA: フック入力に transcript_path がある(実際のフックの挙動) ---
const sidA = 'aaaa-1111';
const tpA = path.join(BASE, 'elsewhere', `${sidA}.jsonl`); // projects/ 配下ではない場所
fs.mkdirSync(path.dirname(tpA), { recursive: true });
fs.writeFileSync(tpA, transcript(sidA));

const hookA = { cwd: CWD, session_id: sidA, transcript_path: tpA, source: 'startup' };
hook('session-start', JSON.stringify(hookA));
hook('session-end', JSON.stringify({ ...hookA, reason: 'clear' }));

// --- ケースB: transcript_path が無い(古い記録 / 手動実行のフォールバック) ---
const sidB = 'bbbb-2222';
const dirB = path.join(home, '.claude', 'projects', projectKey(CWD)); // cwd 由来のキーで探す
fs.mkdirSync(dirB, { recursive: true });
fs.writeFileSync(path.join(dirB, `${sidB}.jsonl`), transcript(sidB));

const hookB = { cwd: CWD, session_id: sidB, source: 'startup' };
hook('session-start', JSON.stringify(hookB));
hook('session-end', JSON.stringify({ ...hookB, reason: 'clear' }));

// --- ケースD: SessionEnd が飛ばなかったセッションを後追い確定(start の tp を使う) ---
const sidD = 'dddd-4444';
const tpD = path.join(BASE, 'elsewhere', `${sidD}.jsonl`);
fs.writeFileSync(tpD, transcript(sidD));
hook('session-start', JSON.stringify({ cwd: CWD, session_id: sidD, transcript_path: tpD, source: 'startup' }));
// end を書かずに次のセッションを開始 → finalizeDangling が走る
hook('session-start', JSON.stringify({ cwd: CWD, session_id: 'eeee-5555', source: 'startup' }));

const recs = readLog();
const startA = recs.find((r) => r.k === 'start' && r.sid === sidA);
const endA = recs.find((r) => r.k === 'end' && r.sid === sidA);
const endB = recs.find((r) => r.k === 'end' && r.sid === sidB);
const endD = recs.find((r) => r.k === 'end' && r.sid === sidD);

check('A: start に tp が保存される', startA && startA.tp === tpA, startA && String(startA.tp));
check('A: turns=2', endA && endA.stats.turns === 2, endA && `turns=${endA.stats.turns}`);
check('A: edits=1', endA && endA.stats.edits === 1, endA && `edits=${endA.stats.edits}`);
check('A: aiTitle が取れる', endA && endA.aiTitle === `テスト ${sidA}`, endA && String(endA.aiTitle));
check('B: フォールバックで turns=2', endB && endB.stats.turns === 2, endB && `turns=${endB.stats.turns}`);
check('B: start.tp は null', recs.find((r) => r.k === 'start' && r.sid === sidB).tp === null);
check('D: 後追い確定でも turns=2', endD && endD.stats.turns === 2, endD && `reason=${endD.reason} turns=${endD.stats.turns}`);

// --- ケースC: summarize --transcript が会話ログを引けるか(--dry-run で送信内容を見る) ---
// summarize は stdin を読まないコマンドだが、worklog.js は session-start/session-end で
// 同期的に stdin を読む設計(worklog.js:504)なので下地を揃えて input: '' で明示的に閉じる。
// timeout は孤児プロセスが残る事故(issue #8)の検出網。
const digest = execFileSync(process.execPath, [
  WORKLOG, 'summarize', '--project', REPO_KEY, '--session', sidA,
  '--cwd', CWD, '--transcript', tpA, '--dry-run',
], {
  encoding: 'utf8', cwd: CWD, env: { ...process.env, USERPROFILE: home, HOME: home }, windowsHide: true,
  input: '', timeout: 30000, killSignal: 'SIGKILL',
});
check('C: digest にユーザーの指示が含まれる', digest.includes('これを直して'));

// --- 変更2: リポジトリ単位のキー(T2 / F5) ---
const logs = fs.readdirSync(logDir).filter((f) => f.endsWith('.ndjson'));
check('T2: 子ディレクトリで開いても記録は git ルートのキー1本',
  logs.length === 1 && logs[0] === `${REPO_KEY}.ndjson`, logs.join(', '));
check('T2: 子ディレクトリからの list が記録を引ける', /直近の作業ログ/.test(run(['list', '-n', '5']).out));
// F5: ドライブ文字の大小・末尾スラッシュ・スラッシュ表記が同じキーに落ちる
const wobbly = `${repoRoot().replace(/^([A-Z]):/, (m, d) => `${d.toLowerCase()}:`).replace(/\\/g, '/')}/`;
check('F5: 表記が揺れた --project でも同じプロジェクトを引ける',
  /直近の作業ログ/.test(run(['list', '--project', wobbly, '-n', '5']).out), wobbly);

finish();
