// 姉妹ツール account-guard との食い違い照合の回帰テスト。
//
// 同じツリーを account-guard は「操作の遮断」で、worklog は「記録の読み出し制限」で守る。
// 設定は別ファイルなので、片方だけ書き換えて「解除したつもり」になる事故が起きる
// (実際に起きた)。worklog が記録を伏せたとき、そのツリーが account-guard 側では
// 素通しになっているなら、どちらの設定が効いているのかを注記で伝える。
//
// 大事なのは「判定は一切変えない」こと。照合できない・向こうでも守っている、のどちらでも
// 注記は今までどおりの文面に戻り、伏せる/見せるの結果は動かない。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  tmpDir, projectKey, sandboxHome, checks, runner,
} = require('./lib');

const BASE = tmpDir('guard-mismatch');

const TREE = path.join(BASE, 'org-tree');        // worklog が伏せるツリー
const SUB = path.join(TREE, 'inner');            // その配下(前方一致の確認用)
const OTHER = path.join(BASE, 'other-repo');     // 保護と無関係

for (const r of [TREE, SUB, OTHER]) {
  fs.mkdirSync(r, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: r, windowsHide: true, timeout: 30000, killSignal: 'SIGKILL' });
}

const { home, logDir } = sandboxHome(path.join(BASE, 'home'), { restrictedTrees: [{ tree: TREE, allow: ['team'] }] });
const GUARD_DIR = path.join(home, '.claude', 'account-guard');
fs.mkdirSync(GUARD_DIR, { recursive: true });
const GUARD_CONFIG = path.join(GUARD_DIR, 'config.json');

// 偽の .credentials.json でアカウントを差し替える(本物のトークンには触れない)
function setAccount(subscriptionType) {
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), JSON.stringify({
    claudeAiOauth: { subscriptionType, accessToken: 'dummy', refreshToken: 'dummy' },
  }), 'utf8');
}

// account-guard の設定を差し替える。null を渡すと「未導入」(ファイルごと消す)
function setGuard(config) {
  if (config === null) {
    fs.rmSync(GUARD_CONFIG, { force: true });
    return;
  }
  fs.writeFileSync(GUARD_CONFIG, typeof config === 'string' ? config : JSON.stringify(config), 'utf8');
}

function setWorklog(config) {
  fs.writeFileSync(path.join(logDir, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config), 'utf8');
}

const RESTRICTED = { restrictedTrees: [{ tree: TREE, allow: ['team'] }] };

function write(repo, sessions) {
  const lines = [];
  for (const s of sessions) {
    lines.push(JSON.stringify({ k: 'start', sid: s.sid, ts: s.ts, cwd: s.cwd || repo, branch: 'main' }));
    lines.push(JSON.stringify({ k: 'note', sid: s.sid, ts: s.ts, via: 'wrap', summary: s.summary }));
    lines.push(JSON.stringify({ k: 'end', sid: s.sid, ts: s.ts + 1000, reason: 'clear', stats: {} }));
  }
  fs.writeFileSync(path.join(logDir, `${projectKey(repo)}.ndjson`), `${lines.join('\n')}\n`);
}

const T = Date.now() - 3600 * 1000;
write(TREE, [{ sid: 'r1', ts: T, summary: '保護ツリーの作業' }]);
write(OTHER, [{ sid: 'o1', ts: T, summary: '無関係ツリーの作業' }]);

const run = runner(home, OTHER);
const { check, finish } = checks();

// 食い違いの説明が出ているか。文面全体ではなく「どちらの設定が効いているか」を
// 伝える核だけを見る(言い回しの調整でテストが落ちないように)
const MISMATCH = /account-guard 側では保護されていない/;
const WHICH_CONFIG = /この制限は worklog 側の設定によるもの/;

setAccount('pro'); // allow=[team] に外れるので、以下すべて「伏せる」側

console.log('\n食い違いがあるとき(片方だけ解除した状態)');

setGuard({ rules: [] }); // まさに今回の事故: account-guard だけ空にした
const cwdBlocked = run(['list', '--cwd', TREE]).out;
check('cwd 基準の案内に、どちらの設定が効いているかが出る', WHICH_CONFIG.test(cwdBlocked), cwdBlocked);
check('cwd 基準の案内に、account-guard 側との食い違いが出る', MISMATCH.test(cwdBlocked), cwdBlocked);
check('元の文面(アカウント切り替えの案内)は残っている',
  /別アカウント専用のツリーのため表示していない/.test(cwdBlocked), cwdBlocked);

const projectBlocked = run(['list', '--project', projectKey(TREE)]).out;
check('--project 指定の案内にも食い違いが出る', MISMATCH.test(projectBlocked), projectBlocked);

const todayAll = run(['today', '--days', '3650']).out;
check('件数ベースの注記(today)にも食い違いが出る', MISMATCH.test(todayAll), todayAll);

const moveBlocked = run(['move', '--from', projectKey(TREE), '--to', projectKey(OTHER), '--all', '--dry-run']);
check('move の拒否理由にも食い違いが出る', MISMATCH.test(moveBlocked.err), moveBlocked.err || moveBlocked.out);

// 判定そのものは動かない。注記が増えても、伏せる対象は今までどおり
check('食い違いがあっても保護ツリーの記録は伏せたまま',
  !/保護ツリーの作業/.test(todayAll), todayAll);
check('食い違いがあっても無関係ツリーの記録は見える',
  /無関係ツリーの作業/.test(todayAll), todayAll);

console.log('\n食い違いが無いとき(注記は今までどおりの文面に戻る)');

setGuard({ rules: [{ tree: TREE, allow: ['team'] }] });
const bothSet = run(['list', '--cwd', TREE]).out;
check('両方に同じツリーが書いてあれば何も足さない', !MISMATCH.test(bothSet) && !WHICH_CONFIG.test(bothSet), bothSet);

// account-guard の判定は前方一致なので、親を守っていれば配下も守られている。
// ここを取り違えると、正しく設定してある構成に毎回「食い違っている」と出し続ける
setGuard({ rules: [{ tree: BASE, allow: ['team'] }] });
check('account-guard 側が親ツリーを守っていれば食い違いではない',
  !MISMATCH.test(run(['list', '--cwd', TREE]).out), run(['list', '--cwd', TREE]).out);

// 逆向き(向こうが配下だけを守っている)は、worklog が伏せる範囲の方が広いので食い違い。
// cwdUnderTree の向きを間違えるとここが落ちる
setGuard({ rules: [{ tree: SUB, allow: ['team'] }] });
check('account-guard 側が配下しか守っていなければ食い違いとして出す',
  MISMATCH.test(run(['list', '--cwd', TREE]).out), run(['list', '--cwd', TREE]).out);

setGuard(null);
const noGuard = run(['list', '--cwd', TREE]).out;
check('account-guard 未導入なら何も言わない(使っていないツールの名前を出さない)',
  !MISMATCH.test(noGuard), noGuard);

// 壊れた設定を account-guard は「全拒否」として扱う(fail-closed)。つまり保護は
// 最も強く効いている状態なので、「保護されていない」と案内すると正反対になる
setGuard('{ "rules": [');
check('account-guard の設定が壊れているときは何も言わない(向こうは全拒否なので逆の案内になる)',
  !MISMATCH.test(run(['list', '--cwd', TREE]).out), run(['list', '--cwd', TREE]).out);

setGuard({ rules: 'まちがい' });
check('account-guard の rules が配列でないときも何も言わない',
  !MISMATCH.test(run(['list', '--cwd', TREE]).out), run(['list', '--cwd', TREE]).out);

console.log('\n照合の前提が崩れているとき');

// worklog 側の設定が壊れていると全伏せになるが、理由は「別アカウント専用のツリー」では
// ないので、ツリー単位の食い違いを持ち出しても噛み合わない
setGuard({ rules: [] });
setWorklog('{ "restrictedTrees": [');
const brokenWorklog = run(['list', '--all']).out;
check('worklog の設定が壊れているときは食い違いを言わない(理由が別)',
  !MISMATCH.test(brokenWorklog), brokenWorklog);
check('壊れているときの本来の理由は残っている',
  /読めない/.test(brokenWorklog), brokenWorklog);

setWorklog(RESTRICTED);

// 許可されたアカウントなら、そもそも伏せないので注記自体が出ない
setAccount('team');
const allowed = run(['list', '--cwd', TREE]).out;
check('許可されたアカウントでは記録が見える', /保護ツリーの作業/.test(allowed), allowed);
check('許可されたアカウントでは食い違いも言わない', !MISMATCH.test(allowed), allowed);

// account-guard 側が現在のアカウントを allow していても worklog 側が拒否していれば食い違い。
// 「ルールが書いてあるか」ではなく「今のアカウントに効いているか」で見ていることの確認
setAccount('pro');
setGuard({ rules: [{ tree: TREE, allow: ['pro'] }] });
const guardAllows = run(['list', '--cwd', TREE]).out;
check('account-guard 側が今のアカウントを許可していれば食い違いとして出す',
  MISMATCH.test(guardAllows), guardAllows);

finish();
