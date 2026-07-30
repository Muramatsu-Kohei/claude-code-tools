// worklog add の引数解釈のテスト。
// 記録の値は人が書いた文章なので、オプション名(-- で始まる語)から始まることがある。
// それをフラグと誤認して黙って捨てると、記録がひとつ静かに欠ける。実際に起きた。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpDir, projectKey, sandboxHome, checks, runner } = require('./lib');

const BASE = tmpDir('add');
const { home, logDir } = sandboxHome(BASE);
// test/.tmp はこのリポジトリの中にあるため、git init しないとキーが親リポジトリの
// ものになってしまう(プロジェクト = git ルート)
const REPO = path.join(BASE, 'repo');
fs.mkdirSync(REPO, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: REPO, windowsHide: true });

const { check, finish } = checks();
const run = runner(home, REPO);

const SID = 'ffff-9999';
// start が無いと add はセッションを特定できないので、最小の記録を先に置く
fs.writeFileSync(path.join(logDir, `${projectKey(REPO)}.ndjson`),
  `${JSON.stringify({ k: 'start', sid: SID, ts: Date.now(), cwd: REPO })}\n`, 'utf8');

const PROSE = '--to がディスク上に無いときは警告する';
const r = run(['add', '--session', SID, '--via', 'finish', '--summary', '引数解釈の確認',
  '--done', PROSE, '--done', '普通の値',
  '--handoff', '--force で押し切れる', '--handoff', '2行目']);
check('exit 0', r.code === 0, r.err);

const note = fs.readFileSync(path.join(logDir, `${projectKey(REPO)}.ndjson`), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.k === 'note');

check('-- で始まる値も done に入る', note.done.includes(PROSE), JSON.stringify(note.done));
check('done は 2 件そろう', note.done.length === 2, JSON.stringify(note.done));
check('-- で始まる引き継ぎ文も残る', note.handoff === '--force で押し切れる\n2行目', JSON.stringify(note.handoff));
check('後続の本物のフラグはフラグとして読む', note.via === 'finish', JSON.stringify(note.via));
check('要約が入る', note.summary === '引数解釈の確認', JSON.stringify(note.summary));

// 値なしフラグの直後に別のフラグが来ても、そちらを値として飲み込んではいけない。
// --all が --verbose を飲むと verbose が効かず done 行が出なくなる
const verbose = run(['list', '--all', '--verbose', '-n', '1']).out;
check('値なしフラグは次のフラグを飲み込まない', verbose.includes('done:'), verbose);

finish();
