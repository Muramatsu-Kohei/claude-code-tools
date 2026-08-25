'use strict';
// status が姉妹ツール claude-worklog の読み出し制限も並べることの回帰テスト。
//
// 同じツリーを、account-guard は「操作の遮断」で、worklog は「記録の読み出し制限」で守る。
// 設定は別ファイルなので、片方だけ書き換えて「解除したつもり」になる事故が起きる
// (実際に起きた: こちらの rules を空にしたあとも worklog 側が残っていた)。status は
// 「なぜ拒否される/されない」を調べに来る入り口なので、こちらの rules だけを見て
// 「保護なし」で打ち切ると、その事故の原因にたどり着けないまま帰すことになる。
//
// 読むのは表示のためだけで、ガードの判定には一切影響しない。ここでもそれを確かめる。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeHarness } = require('./harness');

const { check, report } = makeHarness();

const GUARD = path.join(__dirname, '..', 'account-guard.js');
const TMP = path.join(__dirname, '.tmp', 'worklog-link');
fs.rmSync(TMP, { recursive: true, force: true });

const HOME = path.join(TMP, 'home');
const GUARD_DIR = path.join(HOME, '.claude', 'account-guard');
const WORKLOG_DIR = path.join(HOME, '.claude', 'worklog');
fs.mkdirSync(GUARD_DIR, { recursive: true });
fs.mkdirSync(WORKLOG_DIR, { recursive: true });

const TREE = 'C:/org-tree';
const SUB = 'C:/org-tree/inner';

// 偽の .credentials.json でアカウントを差し替える(本物のトークンには触れない)
function setAccount(subscriptionType) {
  fs.writeFileSync(path.join(HOME, '.claude', '.credentials.json'), JSON.stringify({
    claudeAiOauth: { subscriptionType, accessToken: 'dummy', refreshToken: 'dummy' },
  }), 'utf8');
}

function setGuard(config) {
  fs.writeFileSync(path.join(GUARD_DIR, 'config.json'),
    typeof config === 'string' ? config : JSON.stringify(config), 'utf8');
}

// null を渡すと「worklog 未導入」(設定ファイルごと消す)
function setWorklog(config) {
  const p = path.join(WORKLOG_DIR, 'config.json');
  if (config === null) {
    fs.rmSync(p, { force: true });
    return;
  }
  fs.writeFileSync(p, typeof config === 'string' ? config : JSON.stringify(config), 'utf8');
}

function status(argv = []) {
  return execFileSync(process.execPath, [GUARD, 'status', ...argv], {
    encoding: 'utf8',
    env: { ...process.env, USERPROFILE: HOME, HOME, NO_COLOR: '1' },
    timeout: 30000,
    killSignal: 'SIGKILL',
  });
}

// 「もう片方の設定を外し忘れている」ことを伝える核。言い回しの調整で落ちないよう、
// 判定に関わる部分だけを見る
const WARN = /account-guard 側には今のアカウントに効く保護ルールがありません/;
const LISTED = /作業ログの読み出し制限 \(claude-worklog\)/;

setAccount('pro');

console.log('status に worklog の制限を並べる');

// 今回の事故そのもの: account-guard だけ空にして worklog を残した状態。
// 「保護ルール: なし」で早期 return する経路なので、ここを通ることが要点
setGuard({ rules: [] });
setWorklog({ restrictedTrees: [{ tree: TREE, allow: ['team'] }] });
const emptyRules = status();
check('保護ルールが無くても worklog の制限を出す(ここで打ち切らない)', LISTED.test(emptyRules), emptyRules);
check('保護ルールが無いことの表示は残っている', /保護ルール: なし/.test(emptyRules), emptyRules);
check('片方だけ外している状態を警告する', WARN.test(emptyRules), emptyRules);
check('どのツリーがどう扱われているかを出す',
  new RegExp(`${TREE}\\s+allow=\\[team\\].*非表示`).test(emptyRules), emptyRules);

// こちらにもルールがある通常の経路
setGuard({ rules: [{ tree: TREE, allow: ['team'] }] });
const both = status();
check('こちらにルールがあるときも worklog の制限を並べる', LISTED.test(both), both);
check('両方に書いてあれば警告しない', !WARN.test(both), both);

// 判定は前方一致なので、親を守っていれば配下も守られている
setGuard({ rules: [{ tree: 'C:/', allow: ['team'] }] });
check('こちらが親ツリーを守っていれば警告しない', !WARN.test(status()), status());

// 逆向き(こちらが配下だけを守っている)は worklog の伏せる範囲の方が広いので警告する
setGuard({ rules: [{ tree: SUB, allow: ['team'] }] });
check('こちらが配下しか守っていなければ警告する', WARN.test(status()), status());

// 「ルールが書いてあるか」ではなく「今のアカウントに効いているか」で見る
setGuard({ rules: [{ tree: TREE, allow: ['pro'] }] });
check('こちらが今のアカウントを許可しているなら警告する', WARN.test(status()), status());

console.log('\n両者で解釈が食い違う tree は突き合わせない');

// こちらの normalize はドライブ文字を落とした `/org-tree` を「どのドライブでも、パスの
// 途中でも一致する広いルール」として扱い、Git Bash 表記の `/c/org-tree` は `c:/org-tree` に
// 寄せる。一方 worklog の normPath(path.resolve)はどちらも実行時ドライブ基準の別の場所へ
// 解決する。この差のまま突き合わせると、両方向に誤る
const UNCOMPARABLE = /突き合わせられません/;

// ケースA(誤警告): 保護は生きているのに「保護ルールがありません」と出し、
// 効いている制限を外させる向きの誤り。プライバシー機能としては最悪の向き
setGuard({ rules: [{ tree: TREE, allow: ['team'] }] });
setWorklog({ restrictedTrees: [{ tree: '/org-tree', allow: ['team'] }] });
const worklogNoDrive = status();
check('worklog の tree にドライブ文字が無ければ突き合わせない', UNCOMPARABLE.test(worklogNoDrive), worklogNoDrive);
check('その状態で誤って「保護ルールがありません」と出さない', !WARN.test(worklogNoDrive), worklogNoDrive);

// ケースB(誤って一致扱い): worklog 自身は `<実行時ドライブ>:\c\org-tree` を伏せているのに、
// こちらの normalize が `c:/org-tree` に寄せるせいで一致と見なし、食い違いを黙って見逃す
setWorklog({ restrictedTrees: [{ tree: '/c/org-tree', allow: ['team'] }] });
const worklogGitBash = status();
check('Git Bash 表記の tree も突き合わせない(黙って一致扱いしない)',
  UNCOMPARABLE.test(worklogGitBash), worklogGitBash);

// こちら側の tree に解釈の差があるときも同じ。worklog の tree だけ検めても差は消えない
setGuard({ rules: [{ tree: '/org-tree', allow: ['team'] }] });
setWorklog({ restrictedTrees: [{ tree: TREE, allow: ['team'] }] });
const guardNoDrive = status();
check('こちらの tree にドライブ文字が無ければ突き合わせない', UNCOMPARABLE.test(guardNoDrive), guardNoDrive);
check('その状態でも誤って「保護ルールがありません」と出さない', !WARN.test(guardNoDrive), guardNoDrive);

// 検めるのは「今このアカウントを拒否しているルール」だけ。allow に今のアカウントが
// 入っているルールは何も遮っていないので、tree の書き方が食い違っていても結論は動かない。
// worklog 側の guardActiveRules も同じ範囲で絞っており(両 README の「逆方向は同じ食い違いを
// 報告する」)、ここを全ルールに広げると同じ設定で報告する側としない側が生まれる
setGuard({ rules: [{ tree: '/org-tree', allow: ['pro'] }] });
const allowedNoDrive = status();
check('今のアカウントを許可しているだけのルールは、tree が解釈できなくても照合を止めない',
  WARN.test(allowedNoDrive) && !UNCOMPARABLE.test(allowedNoDrive), allowedNoDrive);

// 制限の一覧そのものは出す。突き合わせられないのは食い違いの判定だけで、
// 「worklog がどのツリーを伏せているか」は status の主題として残す
check('突き合わせられなくても制限の一覧は出す', LISTED.test(guardNoDrive), guardNoDrive);

console.log('\n黙るべきとき');

setGuard({ rules: [] });
setWorklog(null);
check('worklog 未導入なら何も出さない', !LISTED.test(status()), status());

setWorklog({ restrictedTrees: [] });
check('worklog に制限が無ければ何も出さない', !LISTED.test(status()), status());

setWorklog({ autoSummary: true });
check('worklog に restrictedTrees が無ければ何も出さない', !LISTED.test(status()), status());

console.log('\n読めない設定は「無い」に倒さない');

// worklog は読めない設定を「全ての記録を伏せる」と扱う(fail-closed)。黙ると、
// 記録が消えたように見える原因を status から追えなくなる
setWorklog('{ "restrictedTrees": [');
const brokenWorklog = status();
check('worklog の設定が壊れていることを伝える', /読めません/.test(brokenWorklog), brokenWorklog);
check('壊れているときは全て伏せる扱いだと伝える', /全ての記録を伏せる/.test(brokenWorklog), brokenWorklog);

// JSON として読めることは「正常」を意味しない。worklog の loadConfig は書式の書き損じも
// 全伏せ(fail-closed)として扱うので、同じ基準で見ないと「制限なし」や「表示」と出しながら
// 向こうは全部伏せている、という診断の行き止まりを作る
const SHAPE_BROKEN = /書式が壊れています/;

setWorklog({ restrictedTrees: { tree: 'C:/org-tree' } }); // 配列にし忘れ
check('restrictedTrees が配列でなければ壊れていると伝える', SHAPE_BROKEN.test(status()), status());

setWorklog({ restrictedTrees: [{ tree: 'org-tree', allow: ['team'] }] }); // 相対パス
check('tree が相対パスなら壊れていると伝える', SHAPE_BROKEN.test(status()), status());

setWorklog({ restrictedTrees: [{ path: 'C:/org-tree', allow: ['team'] }] }); // キーの書き損じ
check('tree キーの書き損じも壊れていると伝える', SHAPE_BROKEN.test(status()), status());

setWorklog([{ tree: 'C:/org-tree' }]); // 最上位が配列
check('最上位が配列なら壊れていると伝える', SHAPE_BROKEN.test(status()), status());

setWorklog({ restrictedTrees: [{ tree: 'C:/org-tree', allow: ['team'] }, { tree: '', allow: [] }] });
check('1 件でも壊れていれば全体を壊れているとして扱う(部分的に表示しない)',
  SHAPE_BROKEN.test(status()) && !/現在は/.test(status()), status());

console.log('\n表示するだけで判定は変えない');

setGuard({ rules: [{ tree: TREE, allow: ['team'] }] });
setWorklog({ restrictedTrees: [] });
const probeBlocked = status([TREE]);
check('worklog に制限が無くても保護ツリーの判定は拒否のまま',
  /判定\(cwd=.*\): 拒否/.test(probeBlocked), probeBlocked);

setWorklog({ restrictedTrees: [{ tree: 'C:/other', allow: ['team'] }] });
const probeAllowed = status(['C:/elsewhere']);
check('worklog 側の制限は account-guard の判定に影響しない',
  /判定\(cwd=.*\): 通過/.test(probeAllowed), probeAllowed);

// worklog 側が今のアカウントを許可しているなら、伏せていないので警告の対象外
setGuard({ rules: [] });
setWorklog({ restrictedTrees: [{ tree: TREE, allow: ['pro'] }] });
const visible = status();
check('worklog 側が許可しているツリーは「表示」と出す',
  new RegExp(`${TREE}\\s+allow=\\[pro\\].*表示`).test(visible), visible);
check('伏せていないツリーには警告を出さない', !WARN.test(visible), visible);

report();
