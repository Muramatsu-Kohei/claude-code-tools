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
const TREE2 = path.join(BASE, 'second-tree');    // 2 本目。注記の対象を取り違えないことの確認用。
// TREE と部分一致しない名前にするのは、--project や move の部分一致検索で巻き込まないため
const OTHER = path.join(BASE, 'other-repo');     // 保護と無関係

for (const r of [TREE, SUB, TREE2, OTHER]) {
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
write(TREE2, [{ sid: 'r2', ts: T, summary: '2本目のツリーの作業' }]);
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

console.log('\naccount-guard 側が壊れている・解釈できない書き方をしているとき');

// account-guard は「1 つでも書き損じたルールがあれば設定全体を壊れているとみなし、
// すべての操作を拒否する」。こちらが壊れたルールだけ捨てて残りで判定すると、
// 向こうが全拒否している最中に「保護されていない」と正反対の案内を出す
// 同居させる有効なルールは、TREE を覆わないもの(OTHER)にする。TREE を覆うルールを
// 混ぜると、壊れたルールを無視しても「両方に書いてある」と判定されてしまい、
// このチェックを外しても検査が通ってしまう(= 退行を検出できないテストになる)
setGuard({ rules: [{ tree: OTHER, allow: ['team'] }, { tree: 'relative-path', allow: ['team'] }] });
check('相対パスのルールが混じっていたら黙る(向こうは設定全体を壊れているとみなし全拒否)',
  !MISMATCH.test(run(['list', '--cwd', TREE]).out), run(['list', '--cwd', TREE]).out);

setGuard({ rules: [{ tree: 42, allow: ['team'] }] });
check('tree が文字列でないルールがあっても黙る',
  !MISMATCH.test(run(['list', '--cwd', TREE]).out), run(['list', '--cwd', TREE]).out);

// ドライブ文字を落とした tree は向こうでは有効なルールとして働くが、こちらの normPath
// (path.resolve)は実行時のドライブを基準に別の場所として解決する。解釈が食い違う以上、
// 「保護されていない」と言い切れない
setGuard({ rules: [{ tree: '/org-tree', allow: ['team'] }] });
check('ドライブ文字の無い tree があれば黙る(解釈が両者で食い違う)',
  !MISMATCH.test(run(['list', '--cwd', TREE]).out), run(['list', '--cwd', TREE]).out);

// Git Bash 表記。向こうの normalize は `/c/org-tree` を `c:/org-tree` に寄せるが、
// こちらの path.resolve は `<実行時のドライブ>:\c\org-tree` にしてしまう
setGuard({ rules: [{ tree: '/c/org-tree', allow: ['team'] }] });
check('Git Bash 表記の tree があれば黙る(保護が効いているのに外せと案内しない)',
  !MISMATCH.test(run(['list', '--cwd', TREE]).out), run(['list', '--cwd', TREE]).out);

console.log('\n名指しの注記は、その対象に効いている制限だけを説明する');

// 制限ツリーが 2 本あり、TREE2 だけ account-guard 側にもある状態。
// 「この制限は worklog 側の設定によるもの」が別のツリーの食い違いを指してはいけない
setWorklog({ restrictedTrees: [{ tree: TREE, allow: ['team'] }, { tree: TREE2, allow: ['team'] }] });
setGuard({ rules: [{ tree: TREE2, allow: ['team'] }] });

const aboutTree2 = run(['list', '--project', projectKey(TREE2)]).out;
check('両方に書いてあるツリーの注記に、別ツリーの食い違いを混ぜない',
  !MISMATCH.test(aboutTree2), aboutTree2);
check('その注記自体は今までどおり出ている',
  /別アカウント専用のツリーのため表示していない/.test(aboutTree2), aboutTree2);

const aboutTree1 = run(['list', '--project', projectKey(TREE)]).out;
check('worklog 側だけのツリーの注記には食い違いを出す', MISMATCH.test(aboutTree1), aboutTree1);
check('その説明に挙がるのは当該ツリーだけ',
  aboutTree1.includes(TREE) && !aboutTree1.includes(TREE2), aboutTree1);

// cwd 基準の案内も同じ。TREE2 に cd している体で叩く
const cwdTree2 = run(['list', '--cwd', TREE2]).out;
check('cwd 基準の案内でも対象を取り違えない', !MISMATCH.test(cwdTree2), cwdTree2);

// 件数ベースの注記は横断的な話なので、絞らずに全ての食い違いを挙げてよい
const acrossAll = run(['today', '--days', '3650']).out;
check('件数ベースの注記は横断的なので食い違いを挙げる', MISMATCH.test(acrossAll), acrossAll);

console.log('\nexport の Markdown では継続行にも引用記号を付ける');

// `> ` の引用は 2 行目に `>` が無いと lazy continuation で前の行に繋がり、
// 改行が消えて 1 行に潰れる
setWorklog(RESTRICTED);
setGuard({ rules: [] });
const exported = run(['export', '--project', projectKey(TREE)]).out;
check('export の注記が引用として出る', /^> .*別アカウント専用/m.test(exported), exported);
check('食い違いの説明の継続行にも > が付く',
  /^> この制限は worklog 側の設定によるもの/m.test(exported)
  && /^> \(.*account-guard 側では保護されていない/m.test(exported), exported);
check('引用記号の無い裸の継続行が残っていない',
  !/^この制限は worklog 側の設定によるもの/m.test(exported), exported);

finish();
