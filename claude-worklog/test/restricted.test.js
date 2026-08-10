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

// F2: cwd を持たないセッション(SessionStart が発火しなかった。端末の強制終了で起きる)。
// write() は cwd が偽値だと repo で埋めてしまうため、ここだけ生の NDJSON を直接追記して
// cwd フィールド自体を欠落させる。キーは無関係ツリー(OTHER)なので、キー単位の網が
// 可視と判定する = 制限対象とみなさない側の代表例(下の F2 の check を参照)
const noCwdLines = [
  JSON.stringify({ k: 'start', sid: 'nc1', ts: T, branch: 'main' }), // cwd フィールドが無い
  JSON.stringify({ k: 'note', sid: 'nc1', ts: T, via: 'wrap', summary: 'cwd不明セッションの作業' }),
  JSON.stringify({ k: 'end', sid: 'nc1', ts: T + 1000, reason: 'clear', stats: {} }),
];
fs.appendFileSync(path.join(logDir, `${projectKey(OTHER)}.ndjson`), `${noCwdLines.join('\n')}\n`);

// F1: cwd フィールドの大小がツリー設定と違っても保護ツリー配下と判定できる(第二の網)。
// Windows はファイルシステムが case-insensitive なので、大小の違いだけで制限が無言で
// すり抜けると危ない。キーは無関係ツリー(OTHER)のまま、cwd だけを大文字化した記録を
// 直接追記する(F2 と同じ「孤児」想定で、キー単位の網には引っかからない形にする)
const caseMismatchLines = [
  JSON.stringify({ k: 'start', sid: 'cm1', ts: T, cwd: TREE.toUpperCase(), branch: 'main' }),
  JSON.stringify({ k: 'note', sid: 'cm1', ts: T, via: 'wrap', summary: '大小違いcwdセッションの作業' }),
  JSON.stringify({ k: 'end', sid: 'cm1', ts: T + 1000, reason: 'clear', stats: {} }),
];
fs.appendFileSync(path.join(logDir, `${projectKey(OTHER)}.ndjson`), `${caseMismatchLines.join('\n')}\n`);

const { check, finish } = checks();
const worklog = runner(home, OTHER);

// --- 許可されていないアカウント(pro) ---
setAccount(home, 'pro');

const todayBlocked = worklog(['today', '--days', '3650']).out;
check('許可されていないアカウントでは today に保護ツリーが出ない', !todayBlocked.includes('保護ツリーの作業'), todayBlocked);
check('無関係ツリーは today にそのまま出る', todayBlocked.includes('無関係ツリーの作業'), todayBlocked);
// 件数はキー単位(プロジェクト)と cwd 単位(セッション)の両方を数える。後者を
// 数えないと、第二の網が拾った取りこぼしだけが注記に現れず黙って消える
check('除外を黙って隠さない注記が出る',
  /別アカウント専用のツリーのため 1 件のプロジェクトと 1 件のセッションを表示していません/.test(todayBlocked),
  todayBlocked);
// F2: cwd の無いセッションは、そのレコードが入っているキー自体が可視なら制限対象に
// しない。キー単位の網は既にツリー情報を反映しているので二重に伏せる理由がなく、
// 一律 fail-closed にすると restrictedTrees を1件足しただけで無関係な cwd 欠落レコードが
// 全経路から消えて move でも動かせなくなる。保護ツリーから move された記録は cwd を
// 持ったまま追記されるので、この緩和では漏れない(下の「大小違いcwd」がその代表例)
check('cwd の無いセッションは、キー自体が可視なら出る',
  todayBlocked.includes('cwd不明セッションの作業'), todayBlocked);
check('F1: cwd の大小がツリー設定と違っても保護ツリー配下と判定される',
  !todayBlocked.includes('大小違いcwdセッションの作業'), todayBlocked);

const listAllBlocked = worklog(['list', '--all', '-n', '20']).out;
check('list --all でも保護ツリーが出ない', !listAllBlocked.includes('保護ツリーの作業'), listAllBlocked);
check('list --all にも注記が出る', /別アカウント専用のツリーのため.*表示していません/.test(listAllBlocked), listAllBlocked);
check('似た名前の別ツリー(org-treeo)は誤って除外されない', listAllBlocked.includes('似た名前ツリーの作業'), listAllBlocked);

const listCwdBlocked = worklog(['list', '-n', '20'], { cwd: TREE }).out;
check('保護ツリーの中で cd して list しても出ない(単独キー解決も塞ぐ)',
  !listCwdBlocked.includes('保護ツリーの作業'), listCwdBlocked);
// F3: --project も --all も付けない既定呼び出しで cwd 由来のキーが制限に当たった場合、
// 「記録がまだない」という誤解を招く文言ではなく、制限が理由だと分かる注記を出す
check('保護ツリーの中で cd して list すると制限の案内が出る(「記録がまだない」ではない)',
  /別アカウント専用のツリーのため.*表示していない/.test(listCwdBlocked)
    && !listCwdBlocked.includes('記録がまだない'),
  listCwdBlocked);

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

// 個別の案内(explicitProjectRestrictionNote)を出したときは、件数ベースの注記
// (restrictionNote)を重ねない。同じ除外を二重に言うと読みにくいだけでなく、
// 「対象が全部制限されているときは個別の案内を優先し、件数の注記は出さない」という
// 出し分けの前提が崩れていないかを確かめられる
check('--project で保護ツリーを名指しした個別の案内には、件数の注記を重ねない(list)',
  !listProjectBlocked.out.includes('件のプロジェクトを表示していません'), listProjectBlocked.out);
check('--project で保護ツリーを名指しした個別の案内には、件数の注記を重ねない(export)',
  !exportProjectBlocked.out.includes('件のプロジェクトを表示していません'), exportProjectBlocked.out);

// --project にツリー名の一部だけを渡すと、前方一致で複数のキーに部分一致することがある
// (保護ツリー org-tree と、無関係な別ツリー org-treeo)。この場合セッションは可視キー
// (org-treeo)からしか読まれないため hiddenSessions は 0 のままで、一覧も空にならない
// ので個別の案内も出ない。キー単位で伏せた数(hiddenKeys)を見ないと、保護ツリーが
// 何の注記もなく黙って消える — 「除外を黙って隠さない」という不変条件そのものの確認
const listPartialMatch = worklog(['list', '--project', 'org-tree', '-n', '20']).out;
check('--project の部分一致では似た名前ツリーの記録は出る',
  listPartialMatch.includes('似た名前ツリーの作業'), listPartialMatch);
check('--project の部分一致でも保護ツリーの記録は出ない',
  !listPartialMatch.includes('保護ツリーの作業'), listPartialMatch);
check('--project の部分一致が保護ツリーにも当たったことを件数の注記で伝える(list)',
  /別アカウント専用のツリーのため 1 件のプロジェクトを表示していません/.test(listPartialMatch), listPartialMatch);

const exportPartialMatch = worklog(['export', '--project', 'org-tree']).out;
check('export --project の部分一致でも同様に件数の注記が出力に残る(保存されるファイルの中身)',
  /別アカウント専用のツリーのため 1 件のプロジェクトを表示していません/.test(exportPartialMatch), exportPartialMatch);

const exportBlocked = worklog(['export', '--all']).out;
check('export --all でも保護ツリーが出ない', !exportBlocked.includes('保護ツリーの作業'), exportBlocked);
check('export --all にも注記が残る(保存されるファイルなので黙って消さない)',
  /別アカウント専用のツリーのため.*表示していません/.test(exportBlocked), exportBlocked);

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
// F2: 制限そのものが無効(この account では blocked が空)なら、cwd の無いセッションも
// fail-closed の対象外になり、通常どおり出る
check('許可されたアカウントでは cwd の無いセッションも出る(制限自体が無効なため)',
  todayAllowed.includes('cwd不明セッションの作業'), todayAllowed);
check('許可されたアカウントでは大小違いcwdセッションも出る(制限自体が無効なため)',
  todayAllowed.includes('大小違いcwdセッションの作業'), todayAllowed);

// F1: config の restrictedTrees.tree 側の大小が実際のキーと違っていても塞ぐ(第一の網、
// キー単位の前方一致)。projectKey() はパス比較で git を使わないので、実在しないパスの
// 大文字化でも安全に検証できる
const { home: home3, logDir: logDir3 } = sandboxHome(
  path.join(BASE, 'home-case'),
  { restrictedTrees: [{ tree: TREE.toUpperCase(), allow: ['team'] }] },
);
setAccount(home3, 'pro');
fs.writeFileSync(
  path.join(logDir3, `${projectKey(TREE)}.ndjson`),
  fs.readFileSync(path.join(logDir, `${projectKey(TREE)}.ndjson`), 'utf8'),
);
const worklog3 = runner(home3, OTHER);
const todayKeyCaseBlocked = worklog3(['today', '--days', '3650']).out;
check('F1: config の tree の大小が実際のキーと違っても保護ツリーは隠れる(第一の網)',
  !todayKeyCaseBlocked.includes('保護ツリーの作業'), todayKeyCaseBlocked);

// F4: move --to が制限キーにしか一致しないとき、resolveMoveKey は listProjectKeys()
// (制限フィルタ済み)しか見ないと「マッチなし」になり、allowNew のフォールバックで
// spec を cwd 相対パスとして解釈した「存在しないキー」を捏造してそこへ move してしまう。
// TREE を使うと「似た名前の別ツリー」SIMILAR が部分一致で先に拾われてしまい再現できないため、
// 専用のサンドボックスに紛れない名前の保護ツリーを別途用意する
const MOVE_TREE = path.join(BASE, 'org-tree'); // 課題文中の例と同じ名前にする(保護ツリー、move 専用)
fs.mkdirSync(MOVE_TREE, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: MOVE_TREE, windowsHide: true });
const { home: home4, logDir: logDir4 } = sandboxHome(
  path.join(BASE, 'home-move'),
  { restrictedTrees: [{ tree: MOVE_TREE, allow: ['team'] }] },
);
const rec4 = (sid, ts, cwd, summary) => [
  JSON.stringify({ k: 'start', sid, ts, cwd, branch: 'main' }),
  JSON.stringify({ k: 'note', sid, ts, via: 'wrap', summary }),
  JSON.stringify({ k: 'end', sid, ts: ts + 1000, reason: 'clear', stats: {} }),
].join('\n');
fs.writeFileSync(path.join(logDir4, `${projectKey(MOVE_TREE)}.ndjson`),
  `${rec4('bt1', T, MOVE_TREE, '保護ツリー(move用)の作業')}\n`);
fs.writeFileSync(path.join(logDir4, `${projectKey(OTHER)}.ndjson`),
  `${rec4('mo1', T, OTHER, '無関係ツリーの作業(move用)')}\n`);
setAccount(home4, 'pro');
const worklog4 = runner(home4, OTHER);
// エラーは worklog.js 側の共通 catch が errors.log にも残すので、比較対象は
// .ndjson(プロジェクトのログファイル)だけに絞る
const ndjsonBeforeMove = fs.readdirSync(logDir4).filter((f) => f.endsWith('.ndjson'));
const moveToBlocked = worklog4(['move', '--from', 'other-repo', '--to', 'org-tree', '--all']);
check('F4: 制限キーにしか一致しない --to は move を拒否する(exit 1)',
  moveToBlocked.code === 1, `code=${moveToBlocked.code} ${moveToBlocked.out}${moveToBlocked.err}`);
check('F4: 拒否の理由が制限だと分かる', /別アカウント専用のツリーのため/.test(moveToBlocked.err), moveToBlocked.err);
check('F4: 捏造キーの新規ファイルを作らない',
  fs.readdirSync(logDir4).filter((f) => f.endsWith('.ndjson')).join(',') === ndjsonBeforeMove.join(','),
  fs.readdirSync(logDir4).join(', '));
check('F4: 移動元(OTHER)のログも書き換えない',
  fs.readFileSync(path.join(logDir4, `${projectKey(OTHER)}.ndjson`), 'utf8').includes('無関係ツリーの作業(move用)'),
  fs.readFileSync(path.join(logDir4, `${projectKey(OTHER)}.ndjson`), 'utf8'));

// F5: F4 は spec が既存キー(org-tree)に部分一致する場合の拒否だったが、resolveMoveKey の
// rawHit チェックは「ディスク上に実在するキーに一致した」場合しか働かない。保護ツリー配下の
// 未使用パス(既存のどのキー名にも部分一致しない)を --to に渡すと rawHit が空のまま
// allowNew のフォールバックに進み、repoKey(spec) で保護ツリー配下の新規キーを捏造して
// しまう。捏造したキーにもツリー判定を掛けているか(resolveMoveKey 末尾の isKeyBlocked)を
// 確かめる。ディスク上に存在しないパスなので repoRoot() の git rev-parse は失敗して
// spec 自身にフォールバックするが、そのパス自体が保護ツリー配下にあれば前方一致で捕まる
const ghostSpec = path.join(MOVE_TREE, 'ghost-sub'); // どのキー名にも部分一致しない、保護ツリー配下の未使用パス
const ndjsonBeforeGhostMove = fs.readdirSync(logDir4).filter((f) => f.endsWith('.ndjson'));
const moveToGhostBlocked = worklog4(['move', '--from', 'other-repo', '--to', ghostSpec, '--all']);
check('F5: 既存キーに一致しない保護ツリー配下のパスへの move も拒否される(exit 1)',
  moveToGhostBlocked.code === 1, `code=${moveToGhostBlocked.code} ${moveToGhostBlocked.out}${moveToGhostBlocked.err}`);
check('F5: 拒否の理由が制限だと分かる',
  /別アカウント専用のツリーのため/.test(moveToGhostBlocked.err), moveToGhostBlocked.err);
check('F5: 捏造キーの新規ファイルを作らない',
  fs.readdirSync(logDir4).filter((f) => f.endsWith('.ndjson')).join(',') === ndjsonBeforeGhostMove.join(','),
  fs.readdirSync(logDir4).join(', '));
check('F5: 移動元(OTHER)のログも書き換えない',
  fs.readFileSync(path.join(logDir4, `${projectKey(OTHER)}.ndjson`), 'utf8').includes('無関係ツリーの作業(move用)'),
  fs.readFileSync(path.join(logDir4, `${projectKey(OTHER)}.ndjson`), 'utf8'));

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

// --- today の注記の出し分け(list / export と揃える) ---
// today は既定で全プロジェクト横断なので件数の注記を出すが、--project で対象を絞ったら
// 横断していない以上その件数は意味を持たない。代わりに、制限で空になったことを伝える
setAccount(home, 'pro');
const todayProjectBlocked = worklog(['today', '--days', '3650', '--project', TREE]).out;
check('today --project で保護ツリーを名指しすると制限の案内が出る(「記録はまだない」ではない)',
  /別アカウント専用のツリーのため.*表示していない/.test(todayProjectBlocked)
    && !todayProjectBlocked.includes('記録はまだない'), todayProjectBlocked);
check('today --project で保護ツリーを名指しした個別の案内には、件数の注記を重ねない',
  !todayProjectBlocked.includes('件のプロジェクトを表示していません'), todayProjectBlocked);

// list/export と同じく、today --project でも部分一致が保護ツリーと可視のプロジェクトの
// 両方に当たったケースを確かめる。today は既定こそ全プロジェクト横断で件数の注記を出すが、
// --project を明示した今回はその横断をしていないため、hiddenKeys を見ないと保護ツリー分
// だけが黙って消える(list/export と同じ不変条件)
const todayPartialMatch = worklog(['today', '--days', '3650', '--project', 'org-tree']).out;
check('today --project の部分一致では似た名前ツリーの記録は出る',
  todayPartialMatch.includes('似た名前ツリーの作業'), todayPartialMatch);
check('today --project の部分一致でも保護ツリーの記録は出ない',
  !todayPartialMatch.includes('保護ツリーの作業'), todayPartialMatch);
check('today --project の部分一致が保護ツリーにも当たったことを件数の注記で伝える',
  /別アカウント専用のツリーのため 1 件のプロジェクトを表示していません/.test(todayPartialMatch), todayPartialMatch);

const todayProjectOther = worklog(['today', '--days', '3650', '--project', OTHER]).out;
check('today --project で無関係なツリーを指定したら件数の注記は出ない',
  !todayProjectOther.includes('件のプロジェクトを表示していません'), todayProjectOther);

// restrictionNote は以前、問い合わせた範囲に関係なくディスク上の全キーから隠した
// プロジェクト数を数えていた。そのため list --project <無関係なプロジェクト> のように
// 単一プロジェクトしか見ていないときでも、一度も見ていない保護ツリー(TREE)の件数を
// 「ここから伏せた」と伝えてしまっていた。OTHER の中には cwd 側の網(大小違いcwd)で
// 隠れるセッションが 1 件あるので、注記自体は出るが、そこにプロジェクト件数は
// 混ざらず(scopeKeys = 問い合わせた OTHER のキーだけ。TREE は含まれない)セッション件数
// だけが出ることを確かめる
const listProjectOther = worklog(['list', '--project', OTHER, '-n', '20']).out;
check('list --project で無関係なプロジェクトを指定すると、注記の件数は問い合わせた範囲だけを数える(他プロジェクトの件数を混ぜない)',
  !listProjectOther.includes('件のプロジェクト') && /1 件のセッションを表示していません/.test(listProjectOther),
  listProjectOther);

// --- move も cwd 単位の網をかける ---
// resolveMoveKey はキー単位でしか止められないので、非制限キーの下にある「cwd が制限ツリー」の
// セッション(過去の move で移された孤児など)が move の一覧に summary ごと出てしまっていた
const moveDry = worklog(['move', '--from', 'other-repo', '--to', 'org-treeo', '--all', '--dry-run']);
check('move の一覧に制限セッションの要約が出ない',
  !moveDry.out.includes('大小違いcwdセッションの作業'), moveDry.out);
check('move では制限セッションを対象外として示す', /対象外.*別アカウント専用/.test(moveDry.out), moveDry.out);
check('制限に当たらないセッションは move の対象に残る', moveDry.out.includes('無関係ツリーの作業'), moveDry.out);
// F2: cwd の無いセッションを「別アカウント専用のツリーの記録」として弾くのは誤った理由の
// 提示になる(そのキーは可視で、保護ツリーとは何の関係もない)。自分のログを整理できる
check('cwd の無いセッションは move の対象に残る', moveDry.out.includes('cwd不明セッションの作業'), moveDry.out);

// --- config.json が壊れているとき(fail-closed) ---
// 「未作成」は既定設定で動く意図した状態だが、「あるが壊れている」は事故。以前は
// どちらも既定に落ちて restrictedTrees が空に戻り、保護ツリーの記録が無警告で出ていた。
// どのツリーを伏せるべきか判断できない以上、全部伏せる側に倒す
const { home: home5, logDir: logDir5 } = sandboxHome(path.join(BASE, 'home-broken'), CONFIG);
setAccount(home5, 'pro');
for (const repo of [TREE, OTHER]) {
  fs.writeFileSync(
    path.join(logDir5, `${projectKey(repo)}.ndjson`),
    fs.readFileSync(path.join(logDir, `${projectKey(repo)}.ndjson`), 'utf8'),
  );
}
fs.writeFileSync(path.join(logDir5, 'config.json'), '{ "restrictedTrees": [ , ] }', 'utf8');
const worklog5 = runner(home5, OTHER);
const todayBroken = worklog5(['today', '--days', '3650']).out;
check('設定が壊れていたら保護ツリーの記録は出ない', !todayBroken.includes('保護ツリーの作業'), todayBroken);
check('設定が壊れていたら無関係な記録も伏せる(どれを伏せるべきか判断できないため)',
  !todayBroken.includes('無関係ツリーの作業'), todayBroken);
check('設定を読めていないことを注記で伝える', /config\.json.*を読めない/.test(todayBroken), todayBroken);
const listBroken = worklog5(['list', '-n', '20']).out;
check('list でも設定を読めていないことを伝える(--all でなくても)',
  /config\.json.*を読めない/.test(listBroken), listBroken);

// restrictedTrees が配列でない書き損じ。そのまま filter に渡すと例外になり、
// フック経路では上位の catch に吸われて文脈注入が黙って止まる
// 相対パスの tree も同じ扱い。normPath(path.resolve)が実行時の cwd を基準に解決するため、
// 呼び出す場所によって守る対象が変わってしまう(別の場所からは何も守らない)
const badConfigCases = [
  ['配列にし忘れたオブジェクト', '{ "restrictedTrees": { "tree": "C:/org-tree", "allow": ["team"] } }'],
  ['null', '{ "restrictedTrees": null }'],
  ['相対パスの tree', '{ "restrictedTrees": [ { "tree": "org-tree", "allow": ["team"] } ] }'],
  // tree を path と書き損じた設定。以前は blockedTrees 側の filter (r.tree が無ければ
  // 無条件で捨てる)が黙ってこのエントリを外すだけだったため、1文字のキー名の書き損じで
  // 読み出し制限が丸ごと無効になるのに、設定ファイル自体は正常(configBroken=false)と
  // 報告されていた。loadConfig 側で fail-closed にすることを確かめる
  ['tree キーを書き損じた(path と誤記)', JSON.stringify({ restrictedTrees: [{ path: TREE, allow: ['team'] }] })],
];
badConfigCases.forEach(([label, rawCfg], i) => {
  const dir = path.join(BASE, `home-badcfg-${i}`);
  const { home: h, logDir: d } = sandboxHome(dir, CONFIG);
  setAccount(h, 'pro');
  fs.writeFileSync(
    path.join(d, `${projectKey(TREE)}.ndjson`),
    fs.readFileSync(path.join(logDir, `${projectKey(TREE)}.ndjson`), 'utf8'),
  );
  fs.writeFileSync(path.join(d, 'config.json'), rawCfg, 'utf8');
  const res = runner(h, OTHER)(['today', '--days', '3650']);
  check(`restrictedTrees が${label}でも異常終了しない`, res.code === 0, `code=${res.code} ${res.err}`);
  check(`restrictedTrees が${label}なら壊れた設定として伏せる`,
    !res.out.includes('保護ツリーの作業') && /config\.json.*を読めない/.test(res.out), res.out);
});

// 設定ファイルが無いのは意図した状態(既定設定で動く)。壊れているときと同じ扱いにしない
const { home: home6, logDir: logDir6 } = sandboxHome(path.join(BASE, 'home-noconfig'));
setAccount(home6, 'pro');
fs.writeFileSync(
  path.join(logDir6, `${projectKey(TREE)}.ndjson`),
  fs.readFileSync(path.join(logDir, `${projectKey(TREE)}.ndjson`), 'utf8'),
);
const todayNoConfig = runner(home6, OTHER)(['today', '--days', '3650']).out;
check('設定ファイルが無いときは制限なしで動く(壊れているときと区別する)',
  todayNoConfig.includes('保護ツリーの作業') && !/を読めない/.test(todayNoConfig), todayNoConfig);

finish();
