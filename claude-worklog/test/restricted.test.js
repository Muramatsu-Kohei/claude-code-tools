// restrictedTrees(読み出し制限)の回帰テスト。
// 組織のツリー(例: C:\org-tree)の作業ログを、許可されていないアカウントの読み出し経路
// (today/list --all/export --all/cd しての list など)から見えなくする一方、記録
// (session-start/add)はアカウントに関係なく成功することを確認する。
// アカウントは ~/.claude/.credentials.json の claudeAiOauth.subscriptionType で
// 差し替える(本物のトークンは使わずダミー値を書く)。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  tmpDir, projectKey, sandboxHome, checks, runner,
} = require('./lib');

const BASE = tmpDir('restricted');

const TREE = path.join(BASE, 'org-tree');     // 保護ツリー
const SIMILAR = path.join(BASE, 'org-treeo'); // 似た名前の別ツリー(誤って巻き込まないことの確認用)
const OTHER = path.join(BASE, 'other-repo'); // 保護と無関係なツリー(常に見えるべき)

for (const r of [TREE, SIMILAR, OTHER]) {
  fs.mkdirSync(r, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: r, windowsHide: true });
}

const CONFIG = { restrictedTrees: [{ tree: TREE, allow: ['team'] }] };
const { home, logDir } = sandboxHome(path.join(BASE, 'home'), CONFIG);

// 偽の .credentials.json でアカウントを差し替える。identity フィールドは無いので
// subscriptionType(team/pro)で代用する。トークン本体はダミー値で、本物には触れない
function setAccount(homeDir, subscriptionType) {
  const p = path.join(homeDir, '.claude', '.credentials.json');
  fs.writeFileSync(p, JSON.stringify({
    claudeAiOauth: { subscriptionType, accessToken: 'dummy', refreshToken: 'dummy' },
  }), 'utf8');
}

function write(repo, sessions) {
  const lines = [];
  for (const s of sessions) {
    lines.push(JSON.stringify({ k: 'start', sid: s.sid, ts: s.ts, cwd: s.cwd || repo, branch: 'main' }));
    lines.push(JSON.stringify({ k: 'note', sid: s.sid, ts: s.ts, via: 'wrap', summary: s.summary }));
    lines.push(JSON.stringify({ k: 'end', sid: s.sid, ts: s.ts + 1000, reason: 'clear', stats: {} }));
  }
  fs.writeFileSync(path.join(logDir, `${projectKey(repo)}.ndjson`), `${lines.join('\n')}\n`);
}

const T = Date.now() - 3600 * 1000; // today --days 1 だと日付境界で落ちうるので --days 3650 で見る
write(TREE, [{ sid: 'r1', ts: T, summary: '保護ツリーの作業' }]);
write(SIMILAR, [{ sid: 's1', ts: T, summary: '似た名前ツリーの作業' }]);
write(OTHER, [{ sid: 'o1', ts: T, summary: '無関係ツリーの作業' }]);

const { check, finish } = checks();
const worklog = runner(home, OTHER);

// --- 許可されていないアカウント(pro) ---
setAccount(home, 'pro');

const todayBlocked = worklog(['today', '--days', '3650']).out;
check('許可されていないアカウントでは today に保護ツリーが出ない', !todayBlocked.includes('保護ツリーの作業'), todayBlocked);
check('無関係ツリーは today にそのまま出る', todayBlocked.includes('無関係ツリーの作業'), todayBlocked);
check('除外を黙って隠さない注記が出る', /別アカウント専用のツリーのため 1 件のプロジェクトを表示していません/.test(todayBlocked), todayBlocked);

const listAllBlocked = worklog(['list', '--all', '-n', '20']).out;
check('list --all でも保護ツリーが出ない', !listAllBlocked.includes('保護ツリーの作業'), listAllBlocked);
check('list --all にも注記が出る', listAllBlocked.includes('件のプロジェクトを表示していません'), listAllBlocked);
check('似た名前の別ツリー(org-treeo)は誤って除外されない', listAllBlocked.includes('似た名前ツリーの作業'), listAllBlocked);

const listCwdBlocked = worklog(['list', '-n', '20'], { cwd: TREE }).out;
check('保護ツリーの中で cd して list しても出ない(単独キー解決も塞ぐ)',
  !listCwdBlocked.includes('保護ツリーの作業'), listCwdBlocked);

// --project でツリーを名指しした場合。「記録がまだない」だと消えたと誤解して調べ回ることに
// なるため、制限による除外だと分かる文言(かつ「記録がまだない」は出ない)ことを見る
const listProjectBlocked = worklog(['list', '--project', TREE, '-n', '20']);
check('--project で保護ツリーを名指しすると「記録がまだない」ではなく制限の案内が出る',
  /別アカウント専用のツリーのため.*表示していない/.test(listProjectBlocked.out)
    && !listProjectBlocked.out.includes('記録がまだない'),
  listProjectBlocked.out);
const exportProjectBlocked = worklog(['export', '--project', TREE]);
check('export --project でも同様に制限の案内が出る(保存されるファイルに残る形)',
  /別アカウント専用のツリーのため.*表示していない/.test(exportProjectBlocked.out), exportProjectBlocked.out);

const exportBlocked = worklog(['export', '--all']).out;
check('export --all でも保護ツリーが出ない', !exportBlocked.includes('保護ツリーの作業'), exportBlocked);
check('export --all にも注記が残る(保存されるファイルなので黙って消さない)',
  exportBlocked.includes('件のプロジェクトを表示していません'), exportBlocked);

// --- 記録(書き込み)経路はアカウントに関係なく制限しない ---
const hookInput = JSON.stringify({ cwd: TREE, session_id: 'blocked-write-1', source: 'startup' });
const startRes = worklog(['session-start'], { input: hookInput });
check('許可されていないアカウントでも session-start は exit 0', startRes.code === 0, startRes.err);
const addRes = worklog(['add', '--cwd', TREE, '--session', 'blocked-write-1', '--summary', '制限中でも記録できる']);
check('許可されていないアカウントでも add は成功する', addRes.code === 0, addRes.err);
const treeLog = fs.readFileSync(path.join(logDir, `${projectKey(TREE)}.ndjson`), 'utf8');
check('add の内容が保護ツリーのログに実際に書き込まれている', treeLog.includes('制限中でも記録できる'), treeLog);

// --- 許可されているアカウント(team) ---
setAccount(home, 'team');
const todayAllowed = worklog(['today', '--days', '3650']).out;
check('許可されたアカウントでは today に保護ツリーが出る', todayAllowed.includes('保護ツリーの作業'), todayAllowed);
check('許可されたアカウントでは注記が出ない', !todayAllowed.includes('件のプロジェクトを表示していません'), todayAllowed);

// --- restrictedTrees が空(既定)なら誰にでも全部出る ---
const { home: home2, logDir: logDir2 } = sandboxHome(path.join(BASE, 'home-empty'), { restrictedTrees: [] });
setAccount(home2, 'pro');
fs.writeFileSync(
  path.join(logDir2, `${projectKey(TREE)}.ndjson`),
  fs.readFileSync(path.join(logDir, `${projectKey(TREE)}.ndjson`), 'utf8'),
);
const worklog2 = runner(home2, OTHER);
const todayEmptyConfig = worklog2(['today', '--days', '3650']).out;
check('restrictedTrees が空なら制限なしで全部出る', todayEmptyConfig.includes('保護ツリーの作業'), todayEmptyConfig);

finish();
