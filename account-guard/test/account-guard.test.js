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
const { makeHarness } = require('./harness');

// .tmp 直下ではなく自分専用のサブディレクトリを使う。以前は .tmp 全体を消していたため、
// swap.test.js のサンドボックス(.tmp/swap)まで巻き添えで消えた。2 つのスイートを同時に
// 走らせると、片方が他方の HOME を実行中に削除して ENOENT の偽陽性が出る。
const BASE = path.join(__dirname, '.tmp', 'guard');
const GUARD = path.join(__dirname, '..', 'account-guard.js');
fs.rmSync(BASE, { recursive: true, force: true });

// state カウンタと check()・最後の集計は swap.test.js と共通なので harness.js に
// 切り出してある(詳しい経緯はそちらのコメント参照)。
const { check, report } = makeHarness();

// 正常にログインしている状態の credentials を置く。raw / rawRules に文字列を渡すと
// 壊れたファイルを再現でき、「読めないときに拒否側へ倒れるか」を試せる。
//
// accessToken まで入れるのは、これが「正常なログイン」を代表するサンドボックスだから。
// subscriptionType だけを書いていた頃は、判別はできるのに復元には使えない中身という
// 実運用では起きにくい状態を全テストの既定にしていた。ガードが健全性を見るようになると
// この既定が「失うものは無い」側の分岐へ落ち、通常の切り替え案内を検証しているつもりの
// テストが別の文面を見ることになる。accessToken を欠く状態は raw で明示的に作る。
function sandbox(name, { subscriptionType, rules, raw, rawRules } = {}) {
  const home = path.join(BASE, name);
  fs.mkdirSync(path.join(home, '.claude', 'account-guard'), { recursive: true });
  const cred = path.join(home, '.claude', '.credentials.json');
  if (raw !== undefined) fs.writeFileSync(cred, raw, 'utf8');
  else if (subscriptionType) {
    fs.writeFileSync(cred, JSON.stringify({
      claudeAiOauth: { subscriptionType, accessToken: 'test-access-token' },
    }), 'utf8');
  }
  if (rawRules !== undefined) fs.writeFileSync(configPath(home), rawRules, 'utf8');
  else if (rules) fs.writeFileSync(configPath(home), JSON.stringify({ rules }), 'utf8');
  return home;
}

const configPath = (home) => path.join(home, '.claude', 'account-guard', 'config.json');

// child_process 起動の共通下地。account-guard.js 本体を叩く経路(run())だけでなく、
// 異常系を再現するための別スクリプト(CRASH / ALONE / BADSHAPE_GUARD / NOREAD_GUARD /
// HOME 導出を壊す RUNNER 系)を起動するテストが多数あり、以前はそれぞれが execFileSync の
// 呼び出しをコピーしていた。cwd の有無・env の作り方・追加の argv・stdin の有無だけが
// 違う同じ形なので起動処理はここに一本化する。timeout を足す・空出力の扱いを変える、
// といった変更を全経路に効かせたいときはここ 1 箇所を直せばよい。
function execGuardScript(scriptPath, { argv = [], env, cwd, input } = {}) {
  const opts = { env, encoding: 'utf8' };
  if (cwd !== undefined) opts.cwd = cwd;
  // account-guard.js は hook として stdin から JSON を読む設計。execFileSync は stdio を
  // 3 つとも pipe で開くので、input を渡さない呼び出しでも子は親の TTY を継承せず、
  // 何も書かれないまま即座に EOF を受け取る(空文字を渡しても spawnSync は truthy 判定で
  // 無視するので同じ)。
  if (input !== undefined) opts.input = JSON.stringify(input);
  // issue #8(test/.tmp の孤児プロセス)の原因は上記の EOF 挙動ではなく未解明のまま。
  // timeout はその原因不明のハングを検出するための網であり、CI で検出できず放置される
  // 事態を避けるための保険。
  opts.timeout = 30000;
  opts.killSignal = 'SIGKILL';
  try {
    return execFileSync(process.execPath, [scriptPath, ...argv], opts);
  } catch (e) {
    // 終了ステータスが無いまま死んだ場合(e.status が null / undefined)は timeout
    // (ETIMEDOUT)以外に maxBuffer 超過(ENOBUFS)・外部や OOM による kill も同じ形で来る。
    // 呼び出し元(run() / runCrash() など)は try/catch を持たず「非ゼロ終了なら例外が
    // そのまま飛んでテストが落ちる」ことに依存しているので、status がある異常終了は
    // そのまま投げ直す。status が無いときだけ、起動していた対象を添えて包む(潰すと
    // どのスクリプトが固まったか分からなくなる)。
    if (e.status == null) {
      const why = e.code === 'ETIMEDOUT'
        ? `timeout(${opts.timeout}ms)で強制終了された`
        : `終了コードを残さずに落ちた(code=${e.code || '不明'} signal=${e.signal || 'なし'})`;
      // stderr は末尾 3 行だけ添える(全部出すと ENOBUFS で ~1MB がログに流れる)。
      // cause で stdout を含む元の例外を残す(issue #8 の原因究明の材料にするため)。
      const tail = (e.stderr || '').trim().split('\n').slice(-3).join('\n');
      const msg = `子プロセスが${why}: ${scriptPath} ${argv.join(' ')}`;
      throw new Error(tail ? `${msg}\n  stderr(末尾): ${tail}` : msg, { cause: e });
    }
    throw e;
  }
}

// execGuardScript の生の stdout を、フックの JSON 出力として解釈する。空出力は
// 「通常フローに委ねる(何も拒否しない)」を表す null として扱う。
function toResult(out) {
  return out.trim() ? JSON.parse(out) : null;
}

// USERPROFILE/HOME を home に差し替えた環境変数の組み立て。ほとんどの呼び出しがこの形を
// 必要とするのでここに寄せる(NO_COLOR は ANSI エスケープが reason の正規表現照合を
// 壊すのを防ぐため)。HOME 導出そのものを壊すテストは homeEnv を使わず env を個別に組む。
function homeEnv(home) {
  return { ...process.env, USERPROFILE: home, HOME: home, NO_COLOR: '1' };
}

// フックとして呼び出し、stdout の JSON を返す。出力なし(= 通常フローに委ねる)は null。
function run(home, input, argv = []) {
  return toResult(execGuardScript(GUARD, { argv, env: homeEnv(home), input }));
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
  // 拒否の文面は実際に安全な手順を出すこと。先に `/login` させると、まだ swap で退避して
  // いないアカウントの認証情報はその場で消え、復旧はブラウザ OAuth のやり直しになる
  // (README の「拒否されたときの挙動」と同じ順序を、利用者が実際に読むこの文面でも守る)。
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('切り替えは退避してからだと案内する',
    /swap save/.test(reason) && /先に `\/login` すると/.test(reason), reason);
  check('/login を最初の一手として案内しない',
    !/^`?\/login`? で正しいアカウントに切り替えて/m.test(reason), reason);
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
  // credentials ファイルそのものが無い(未ログイン)。JSON が壊れている deny-unknown とは
  // 別経路だが、どちらもアカウントは判別不能(unknown)になる。denyMessage() はこの経路
  // でだけ /login を案内してよい: `swap save <name>` は credentials が無ければ必ず失敗し、
  // 退避が1つも無ければ `swap <name>` も必ず失敗するため、/login を抑止すると打つ手が
  // 1つも残らない行き止まりになっていた(失って困る認証情報が無いので /login は安全)。
  const home = sandbox('deny-loggedout', { rules: ORG });
  const res = run(home, { hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read', tool_input: {} });
  check('未ログインでも保護ツリーは拒否する', decision(res) === 'deny', JSON.stringify(res));
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  // 他の deny 経路にも「先に `/login` すると…消えます」という抑止の一文があるため、
  // それと区別できる形(バッククォート無しで箇条書きの案内として出ている行)を見る。
  check('未ログインなら /login を案内する(swap はどちらも失敗するため)',
    /^\s*\/login\s+…/m.test(reason), reason);
  check('/login で失うものが無いことも伝える', /消える退避はありません/.test(reason), reason);
}
{
  // credentials ファイルはある(existsSync は true)が、0バイト・破損で読めない。
  // 以前は existsSync だけで「未ログイン」を判定していたため、この状態は判別できず、
  // 現在ログインが生きている前提の「切り替え手順」に落ちていた。しかし swap save は
  // 「現在の credentials を読めません」で必ず失敗し、退避が1つも無ければ swap <name> も
  // 必ず失敗するため、/login を抑止したまま行き止まりになる(失って困る認証情報は
  // ファイルが既に壊れている時点で存在しないので、/login は安全)。
  const home = sandbox('deny-corrupted', { rules: ORG });
  // sandbox() は subscriptionType / raw のどちらも指定しないと credentials ファイル自体を
  // 作らない(= 未ログイン扱いになる)ので、ここで直接、壊れた(空の)ファイルを置く。
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '', 'utf8');

  const res = run(home, { hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read', tool_input: {} });
  check('credentials が壊れていても保護ツリーは拒否する', decision(res) === 'deny', JSON.stringify(res));
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('拒否理由が復元に使えない状態であることを言う(無言で終わっていない)',
    /復元に使える中身ではありません/.test(reason), reason);
  check('実際に打てる次の一手(swap / /login)を案内する',
    /swap\s+<name>/.test(reason) && /^\s*\/login\s+…/m.test(reason), reason);
  // swap 側は「読めない現在」を上書きする前に --force を要求する。付けずに案内すると
  // 案内どおり打っても必ず中止され、行き止まりになる(ツール間の受け渡しで切れていた)。
  check('復元の案内に --force が付いている(swap 側の要求と噛み合う)',
    /swap\s+<name>\s+--force/.test(reason), reason);
  check('現在のログインが生きている前提の警告(先に /login すると…消えます)は出さない',
    !/先に `\/login` すると/.test(reason), reason);
}
{
  // deny メッセージは次の一手として `swap save <name>` / `swap <name>` を案内するが、
  // これは Bash ツール呼び出しになる。cwd が保護ツリー内なら violation() の cwd 判定が
  // 先に当たるため、案内どおりに打つと同じコマンドがまた同じ理由で deny され、
  // 同じ案内を繰り返す堂々巡りになっていた(コマンド文字列をパースして swap を特別扱いする
  // 例外は作らず、案内文でセッション外から実行することを明示する方針で直す)。
  const home = sandbox('deny-cwd-loop', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read', tool_input: { file_path: 'src/main.py' },
  });
  check('cwd が保護ツリー内なら拒否する(堂々巡りテストの前提)', decision(res) === 'deny', JSON.stringify(res));
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('swap は別のターミナルで実行するよう案内する(堂々巡りにしない)',
    /別のターミナル/.test(reason), reason);
  // 「ツリーの外に cd してから実行」と書いていた頃は、そのとおり打っても堂々巡りが続いた。
  // 判定に使う cwd は PreToolUse 入力(= セッションの作業ディレクトリ)なので、コマンド内の
  // cd は届かない。効かない手を勧めないことまで含めて回帰対象にする。
  check('cd では抜けられないことまで書く', /`cd` しても判定は変わりません/.test(reason), reason);
}
{
  // 対照: cwd がツリーの外で、引数のパスだけがツリー内を指す場合は、案内した swap は
  // 同じ cwd からそのまま実行できる。誤って毎回この注意書きを出すと、本当に効く手順が
  // 埋もれるので、この場合は出ないことも確かめる。
  const home = sandbox('deny-arg-noloop', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Read',
    tool_input: { file_path: 'C:/org-tree/proj/secret.py' },
  });
  check('cwd がツリー外なら拒否する(対照テストの前提)', decision(res) === 'deny', JSON.stringify(res));
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('cwd がツリー外なら swap の cwd 注意書きは出さない',
    !/別のターミナル/.test(reason) && !/配下のままだと/.test(reason), reason);
  // swap は同梱の別ツールで、PATH に置く手動セットアップが要る。ガードだけを入れた構成では
  // 案内どおり打っても「'swap' は認識されていません」で終わり、文面は /login を抑止して
  // いるので実行できる手が 1 つも残らない。逃げ道まで書いてあることを確かめる。
  check('swap が未設置の場合の逃げ道まで案内する', /`swap` が見つからない場合/.test(reason), reason);
}
{
  // cwd が「当たったルールとは別の」保護ツリーの内側にいる場合。ヒットしたルールだけを見て
  // cd 注記の要否を決めていたため、保護ツリーが 2 つ以上ある構成では注記が出ず、案内どおり
  // 打った swap が今度は cwd 側のルールに当たって同じ deny に戻る堂々巡りになっていた。
  const TWO = [{ tree: 'C:/org-tree', allow: ['team'] }, { tree: 'D:/second-tree', allow: ['team'] }];
  const home = sandbox('deny-cross-tree', { subscriptionType: 'pro', rules: TWO });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'D:/second-tree/work', tool_name: 'Read',
    tool_input: { file_path: 'C:/org-tree/proj/secret.py' },
  });
  check('別ツリーの対象を触っても拒否する(前提)', decision(res) === 'deny', JSON.stringify(res));
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('cwd が別の保護ツリー内なら cwd 注記を出す', /別のターミナル/.test(reason), reason);
  // 注記が指すのは「今いるツリー」であって、当たったルールのツリーではない。取り違えると
  // どのツリーから出れば実行できるのかが伝わらない。
  check('cwd 注記は cwd 側のツリーを指す', /D:[\\/]second-tree 配下のままだと/.test(reason), reason);
}
{
  // JSON としては妥当だが accessToken を欠く credentials。ガードが JSON.parse の成否だけを
  // 見ていたときは「正常」に分類され、現在のログインが生きている前提の切り替え手順に落ちて
  // いた。しかし swap 側は accessToken を必須にするので、案内した swap save は必ず失敗し、
  // 退避が無ければ行き止まりになる。判定は credentials.js の hasUsableCredentials に一本化した。
  const home = sandbox('deny-no-accesstoken', { rules: ORG });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{}}', 'utf8');
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read', tool_input: {},
  });
  check('accessToken を欠く credentials でも拒否する', decision(res) === 'deny', JSON.stringify(res));
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('accessToken 欠落は「復元に使えない」側に分類する',
    /復元に使える中身ではありません/.test(reason), reason);
  check('accessToken 欠落でも /login を案内する(行き止まりにしない)',
    /^\s*\/login\s+…/m.test(reason), reason);
  check('accessToken 欠落では現在が生きている前提の警告を出さない',
    !/先に `\/login` すると/.test(reason), reason);
}
{
  // アカウントは判別できる(subscriptionType が読める)が accessToken を欠く credentials。
  // 以前はアカウントを判別できる場合だけ健全性判定を素通りして汎用文に落ちており、案内された
  // swap save / swap は swap 側の accessToken 必須判定に弾かれて必ず失敗していた
  // (denyMessage の state 判定は account では門番しない、というコメントの回帰確認)。
  const home = sandbox('deny-accesstoken-known-account', { rules: ORG });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'),
    '{"claudeAiOauth":{"subscriptionType":"pro"}}', 'utf8');
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read', tool_input: {},
  });
  check('アカウントを判別できても accessToken 欠落は拒否する', decision(res) === 'deny', JSON.stringify(res));
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('アカウントが判別できる場合も健全性判定を素通りしない(汎用文に落ちない)',
    /現在ログイン中のアカウントは "pro"/.test(reason), reason);
  check('この状態で失われる認証情報はないと伝える(通常の切り替え手順ではない)',
    /失われる認証情報はない/.test(reason), reason);
  check('案内する復元コマンドに --force が付いている(swap 側の accessToken 必須判定と噛み合う)',
    /swap <name> --force/.test(reason), reason);
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
{
  // tree に相対パスを書いた設定。resolveFrom / normalize は cwd 基準で解決するため、相対の
  // tree だと同じ設定でも作業場所によって守る対象が変わってしまう(修正2)。tree キーの
  // 書き損じと同じく「守るべきツリー」を確定できないので、config ごと壊れた扱いにし、
  // 保護ツリーと無関係な操作まで拒否側に倒すことを確かめる。
  const home = sandbox('deny-relative-tree', {
    subscriptionType: 'pro',
    rawRules: JSON.stringify({ rules: [{ tree: 'org-tree', allow: ['team'] }] }),
  });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
    tool_input: { command: 'echo hello' },
  });
  check('tree が相対パスのルールは config ごと壊れた扱いにする', decision(res) === 'deny', JSON.stringify(res));
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
{
  // ツリーのパスにシェルのメタ文字が入ると、切り出したトークンが TOKEN_STOP でそこで切れ、
  // ツリー名に届かない。未知ツールは切り出したものしか対象にしていなかったため、Read や Bash
  // からは拒否される同じツリーが、未知ツールからだけ無言で素通りしていた。
  for (const tree of ['C:/a;b/org', 'C:/a&b/org', 'C:/a[1]/org']) {
    const home = sandbox(`deny-mcp-metachar-${tree.replace(/[^a-z0-9]/gi, '')}`,
      { subscriptionType: 'pro', rules: [{ tree, allow: ['team'] }] });
    const res = run(home, {
      hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode',
      tool_name: 'mcp__filesystem__read_file', tool_input: { path: `${tree}/secret.py` },
    });
    check(`メタ文字を含むツリー ${tree} も未知ツールから守る`, decision(res) === 'deny', JSON.stringify(res));
  }
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
  // cwd がツリーの親でも、Agent の prompt は自然文であって cd のような「配下を操作する」
  // 指定ではない。シェル限定にした修正1により、区切りなしのツリー名の言及だけでは
  // 拒否しないことを確かめる(以前はここまで拒否され、自然文の委譲まで巻き添えにしていた)。
  const home = sandbox('allow-bare-name-agent-prompt', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/', tool_name: 'Agent',
    tool_input: { prompt: 'org-tree の方針をまとめて', description: '調査' },
  });
  check('Agent の prompt に区切りなしのツリー名が出るだけなら通す', res === null, JSON.stringify(res));
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
  // ガード本体は同じディレクトリの credentials.js を require する。コピー先は .tmp なので
  // 相対参照のままでは解決できない。実体を指す絶対パスへ書き換えてから落とす
  const credModule = JSON.stringify(path.join(__dirname, '..', 'credentials.js'));
  fs.writeFileSync(
    CRASH,
    fs.readFileSync(GUARD, 'utf8')
      .replace("require('./credentials')", `require(${credModule})`)
      .replace('function main() {', "function main() {\n  throw new Error('boom');"),
    'utf8'
  );
  const runCrash = (home, input) => toResult(execGuardScript(CRASH, { env: homeEnv(home), input }));

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

// --- credentials.js を隣に置き忘れた構成 ---
// インストール手順は account-guard.js の置き場所しか案内していないので、1 ファイルだけ
// コピーする使い方が実際に起こりうる。require をトップレベルで素通しにすると、そこで
// MODULE_NOT_FOUND が投げられて末尾の catch(異常終了を受け止める仕組み)より先に
// プロセスが死ぬ。標準出力に何も出ないまま exit 1 で終わるため、Claude Code はブロックせず
// 処理を続け、保護が丸ごと外れたことに誰も気づけない。判別不能として拒否側に倒すこと。
{
  const ALONE = path.join(BASE, 'alone-guard', 'account-guard.js');
  fs.mkdirSync(path.dirname(ALONE), { recursive: true });
  fs.copyFileSync(GUARD, ALONE); // credentials.js は意図的に置かない

  const runAlone = (home, input) => toResult(execGuardScript(ALONE, { env: homeEnv(home), input }));

  // 許可されたアカウント(team)で入っている。credentials.js があれば通る操作なので、
  // ここで deny が出れば「読めないから拒否側に倒した」ことがはっきりする。
  const home = sandbox('alone-home', { subscriptionType: 'team', rules: ORG });
  let res = runAlone(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read',
    tool_input: { file_path: 'a.py' },
  });
  check('credentials.js が無くても保護ツリーは拒否する', decision(res) === 'deny', JSON.stringify(res));
  // 真因は隣のファイルなのに /login を促すと、正しいアカウントで入っている人が
  // 何度ログインし直しても直らない袋小路に入る。拒否の文面が真因を指すこと。
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('拒否理由が真因(credentials.js が読めない)を指す',
    /credentials\.js/.test(reason), reason);
  check('効かない対処(/login)を唯一の次の一手として案内しない',
    /`\/login` では直りません/.test(reason), reason);
  // 他の deny 経路にはある一文。設置ミスだと読んだ Claude が「ガードの都合だから」と
  // 別経路(ツリー名を書かない Bash など)で読み直すと、保護の目的そのものが崩れる。
  check('この経路でも迂回禁止とユーザーへの報告を指示する',
    /回避しようとせず/.test(reason) && /ユーザー/.test(reason), reason);

  // 確認用の入り口(status)でも真因を出す。'アカウント: unknown' だけでは未ログインと
  // 区別が付かず、deny 側でわざわざ塞いだ袋小路(/login の繰り返し)をここで踏む。
  const statusOut = execGuardScript(ALONE, { argv: ['status'], env: homeEnv(home) });
  check('status も credentials.js が読めないことを言う',
    /credentials\.js/.test(statusOut) && /`\/login` では直りません/.test(statusOut), statusOut);

  res = runAlone(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
    tool_input: { command: 'echo hello' },
  });
  check('credentials.js が無くても保護ツリー外は巻き込まない', res === null, JSON.stringify(res));
}

// --- credentials.js は同名で存在するが、必要なエクスポートが欠けている構成 ---
// require 自体は成功するが、無関係な・古い credentials.js が同名で置かれていると
// HOME 等が undefined になり得る。以前はこれを検証せずに使っていたため、この先の
// path.join(HOME, ...) がトップレベルで例外を投げてプロセスごと落ちていた
// (標準出力なし・exit 1 = 無言 fail-open。require が成功したかどうかしか見ていなかった
// ことが原因)。require が成功しても中身の形を検証し、欠けていれば「読み込めない」場合と
// 同じ扱いに合流することを確かめる。
{
  const BADSHAPE_DIR = path.join(BASE, 'badshape-guard');
  fs.mkdirSync(BADSHAPE_DIR, { recursive: true });
  const BADSHAPE_GUARD = path.join(BADSHAPE_DIR, 'account-guard.js');
  fs.copyFileSync(GUARD, BADSHAPE_GUARD);
  // HOME を欠いた、無関係な credentials.js。require 自体は成功するが中身は使えない形。
  fs.writeFileSync(
    path.join(BADSHAPE_DIR, 'credentials.js'),
    "module.exports = { ACCOUNT_UNKNOWN: 'unknown' };",
    'utf8'
  );

  const runBadShape = (home, input) => toResult(execGuardScript(BADSHAPE_GUARD, { env: homeEnv(home), input }));

  const home = sandbox('badshape-home', { subscriptionType: 'team', rules: ORG });
  const res = runBadShape(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read',
    tool_input: { file_path: 'a.py' },
  });
  // 無言で終わっていない(= プロセスが落ちて exit 1 で fail-open していない)ことがまず要点。
  check('形式が不正な credentials.js でも無言で終わらず出力を返す', res !== null, JSON.stringify(res));
  check('形式が不正な credentials.js でも保護ツリーは拒否する', decision(res) === 'deny', JSON.stringify(res));
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('拒否理由が credentials.js の問題を指す', /credentials\.js/.test(reason), reason);
  check('効かない対処(/login)を唯一の次の一手として案内しない',
    /`\/login` では直りません/.test(reason), reason);

  // 起動時の形式検証と、実際に呼んでいるメンバーがドリフトしないことを機械で見る。
  // rawHasRecoverableToken は credentialsState() が使うのに検証リストから漏れており、
  // 欠ける版が隣にあると deny 経路が TypeError で落ち、reportCrash が無出力・exit 0 で
  // 終わって保護ツリーへのアクセスが素通しになっていた(このブロックが防ぐはずの fail-open)。
  // リストを人が同期させる限り同じ漏れが再発するので、ソースどうしを突き合わせて落とす。
  {
    const src = fs.readFileSync(GUARD, 'utf8');
    const block = src.slice(src.indexOf('const loaded = require'), src.indexOf('credentials = loaded;'));
    const verified = new Set([...block.matchAll(/loaded\.(\w+)/g)].map((m) => m[1]));
    // 直前が . や英数字のものはパスの一部(.credentials.json)なので拾わない。
    // 行頭や空白に続く credentials.js は残るため、その 'js' だけ名前で除く。
    const used = [...new Set([...src.matchAll(/(?<![.\w])credentials\.(\w+)/g)].map((m) => m[1]))]
      .filter((n) => n !== 'js');
    const missing = used.filter((n) => !verified.has(n));
    check('credentials.* の呼び出しがすべて起動時の形式検証に含まれている',
      missing.length === 0, '検証漏れ: ' + missing.join(', '));
  }

  // readCredentials だけを欠く形。他のエクスポートが揃っているため見逃されやすいが、
  // 検証を素通りすると readableCredentials() の catch が拾って「credentials が壊れている」
  // という別の案内に落ち、真因(隣の credentials.js)がどこにも出なくなる。
  const NOREAD_DIR = path.join(BASE, 'noread-guard');
  fs.mkdirSync(NOREAD_DIR, { recursive: true });
  const NOREAD_GUARD = path.join(NOREAD_DIR, 'account-guard.js');
  fs.copyFileSync(GUARD, NOREAD_GUARD);
  fs.writeFileSync(
    path.join(NOREAD_DIR, 'credentials.js'),
    "module.exports = { HOME: 'C:/nowhere', CREDENTIALS: 'C:/nowhere/.credentials.json',"
      + " ACCOUNT_UNKNOWN: 'unknown', currentAccount: () => 'unknown' };",
    'utf8'
  );
  const noreadHome = sandbox('noread-home', { subscriptionType: 'team', rules: ORG });
  const noreadRes = toResult(execGuardScript(NOREAD_GUARD, {
    env: homeEnv(noreadHome),
    input: {
      hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read',
      tool_input: { file_path: 'a.py' },
    },
  }));
  check('readCredentials を欠く credentials.js でも保護ツリーは拒否する',
    decision(noreadRes) === 'deny', JSON.stringify(noreadRes));
  const noreadReason = noreadRes?.hookSpecificOutput?.permissionDecisionReason || '';
  check('拒否理由が credentials.js の形式を真因として指す',
    /credentials\.js/.test(noreadReason) && /`\/login` では直りません/.test(noreadReason),
    noreadReason);
}

// --- HOME を導出できない環境 ---
// credentials.js が読めず、かつ USERPROFILE も HOME も未設定の環境では、フォールバックの
// 最後の砦を '.' にすると CONFIG が cwd 配下(./.claude/account-guard/config.json)として
// 解決されてしまう。cwd から読めてしまうと、たまたま設定の無い場所では保護が丸ごと外れる
// (exit 0・標準出力なし = fail-open)。os.homedir() を最後の砦にすることで、cwd に本物の
// ルールを置いても、それが設定として読まれないことを確かめる。
//
// 環境変数の delete / 空文字では再現できない(このマシンで実測して確認した Windows 特有の癖):
//   - delete すると、Windows では子プロセス生成時に libuv が USERPROFILE / HOMEDRIVE などを
//     実在する値で勝手に補ってしまう(キーが丸ごと無いときだけ発動する)。すると
//     `process.env.USERPROFILE || ...` の最初の項で真になり、直したい3項目め
//     (`|| os.homedir()`)自体を通らない。バグを戻しても再現できず、テストとして無意味になる。
//   - 空文字にすると、Windows の os.homedir() は USERPROFILE が「空文字として存在する」だけで
//     その空文字をそのまま返す(実プロファイルへはフォールバックしない)。つまり
//     `|| os.homedir()` に辿り着いても壊れた値(空文字)になり、修正前の `'.'` と
//     見分けが付かない(どちらも cwd 相対に解決されて同じ結果になる)。
// そこで os.homedir() 自体をテスト用の値に差し替え、cwd とは無関係な既知の場所を返すようにする。
// これで「3項目めまで来たら cwd ではなくその値が使われる」ことを確定的に検証できる。
{
  const ALONE_DIR = path.join(BASE, 'homefallback-alone');
  fs.mkdirSync(ALONE_DIR, { recursive: true });
  fs.copyFileSync(GUARD, path.join(ALONE_DIR, 'account-guard.js')); // credentials.js は意図的に置かない

  // os.homedir() の差し替え先。cwd(後述の home)とは別物で、かつ設定ファイルを一切
  // 置かない実在しないディレクトリにする。ここが CONFIG の基準になれば「ルール未設定」
  // として何も拒否されないはずで、cwd 側のルールが読まれていないことの裏付けになる。
  const FAKE_HOME = path.join(BASE, 'homefallback-real-home');
  const RUNNER = path.join(ALONE_DIR, 'run-with-fake-home.js');
  fs.writeFileSync(RUNNER, [
    "'use strict';",
    `require('os').homedir = () => ${JSON.stringify(FAKE_HOME)};`,
    "require('./account-guard.js');", // 差し替え後に本体を読み込む。os は Node 内でキャッシュ共有される
  ].join('\n'), 'utf8');

  // cwd には「本物の」保護ルールを置く。HOME='.' のバグが残っていれば、これが読まれて拒否される。
  const TARGET = path.join(BASE, 'nohome-target');
  const home = sandbox('nohome-cwd', { rules: [{ tree: TARGET, allow: [] }] });

  const env = { ...process.env, NO_COLOR: '1', USERPROFILE: '', HOME: '' };

  const res = toResult(execGuardScript(RUNNER, {
    cwd: home, // プロセスの実際の cwd。HOME='.' のバグがあればここが CONFIG の基準になる
    env,
    input: { hook_event_name: 'PreToolUse', cwd: TARGET, tool_name: 'Read', tool_input: { file_path: 'x' } },
  }));
  check('HOME が無い環境でも設定をカレントディレクトリから読まない', res === null, JSON.stringify(res));
}

// --- HOME 導出の入力が全て空文字を返す環境(credentials.js を正しく置いた通常構成) ---
// 上のテストは credentials.js を意図的に置かない構成でしか「HOME を導出できない」ケースを
// 検証していない。credentials.js 自身にも同じ穴(os.homedir() が空文字を返す環境では
// HOME='' になり、CREDENTIALS / CONFIG が cwd 相対に解決される)があったため、
// credentials.js が存在する通常構成でも同じことが成り立つことを確かめる。
// 環境変数の delete / 空文字だけでは再現できない事情は上のテストのコメントと同じ
// (Windows の libuv 補完・os.homedir() の空文字そのまま返し)なので、
// os.homedir() 自体を差し替える方式に倣う。
{
  const NORMAL_DIR = path.join(BASE, 'homefallback-normal');
  fs.mkdirSync(NORMAL_DIR, { recursive: true });
  fs.copyFileSync(GUARD, path.join(NORMAL_DIR, 'account-guard.js'));
  fs.copyFileSync(path.join(__dirname, '..', 'credentials.js'), path.join(NORMAL_DIR, 'credentials.js'));

  const RUNNER2 = path.join(NORMAL_DIR, 'run-with-empty-home.js');
  fs.writeFileSync(RUNNER2, [
    "'use strict';",
    "require('os').homedir = () => '';", // os.homedir() 自体が空文字を返す壊れた環境を再現
    "require('./account-guard.js');", // os は Node 内でキャッシュ共有されるので credentials.js 側にも効く
  ].join('\n'), 'utf8');

  // cwd には「本物の」保護ルールを置く。HOME='' のバグが残っていれば cwd 相対に解決され、
  // それが読まれて偶然 deny されただけ、という誤検証になる。ツール呼び出し自体は
  // この保護ルールと無関係にして、「HOME を特定できない」という理由で拒否されることを見る。
  const TARGET2 = path.join(BASE, 'emptyhome-target');
  const home2 = sandbox('emptyhome-cwd', { rules: [{ tree: TARGET2, allow: [] }] });

  const env2 = { ...process.env, NO_COLOR: '1', USERPROFILE: '', HOME: '' };
  const res2 = toResult(execGuardScript(RUNNER2, {
    cwd: home2,
    env: env2,
    input: {
      hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
    },
  }));
  // 無言で fail-open していない(素通し = res===null)ことが要点。保護対象と無関係な
  // Bash 呼び出しでも、HOME を特定できない間は安全側に倒して拒否する。
  check('credentials.js が正しく揃っていても HOME が全滅なら無言で通さない', res2 !== null, JSON.stringify(res2));
  check('credentials.js が正しく揃っていても HOME が全滅なら拒否する', decision(res2) === 'deny', JSON.stringify(res2));
  const reason2 = res2?.hookSpecificOutput?.permissionDecisionReason || '';
  check('拒否理由が HOME を特定できないことを言う(無言で終わっていない)',
    /HOME|ホームディレクトリ/.test(reason2), reason2);

  // 空白のみの HOME。空文字は falsy なので素朴な `||` チェーンでも先へ進むが、空白のみは
  // truthy なため usableHome の trim() が無いとそのまま採用され、path.join(' ', ...) が
  // cwd 配下の実在しない場所を指して「設定が無い」= ルール 0 件の素通しに戻る。
  // trim() を消すリグレッションを捉えられるのはこの経路だけなので、空文字とは別に見る。
  const RUNNER3 = path.join(NORMAL_DIR, 'run-with-blank-home.js');
  fs.writeFileSync(RUNNER3, [
    "'use strict';",
    "require('os').homedir = () => '   ';",
    "require('./account-guard.js');",
  ].join('\n'), 'utf8');

  const res3 = toResult(execGuardScript(RUNNER3, {
    cwd: home2,
    env: { ...process.env, NO_COLOR: '1', USERPROFILE: '   ', HOME: '   ' },
    input: {
      hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
    },
  }));
  check('空白のみの HOME でも無言で通さない', res3 !== null, JSON.stringify(res3));
  check('空白のみの HOME でも拒否する', decision(res3) === 'deny', JSON.stringify(res3));
  check('空白のみの HOME でも理由が HOME を特定できないことを言う',
    /HOME|ホームディレクトリ/.test(res3?.hookSpecificOutput?.permissionDecisionReason || ''),
    JSON.stringify(res3));

  // HOME 未解決のときは CONFIG がダミーの相対パスになるため、通常の修復経路
  // (isConfigRepair = CONFIG 自身の編集を通す)は絶対パスと決して一致せず成立しない。
  // 逃げ道が 1 つも無いと、フック登録を外すことも環境変数を直すこともできず、Claude Code の
  // 中から復旧不能になる(外部エディタや git で戻すしかなくなる)。settings.json の
  // 読み書きだけは通ることを確かめる。ここで保護の穴は増えない: HOME が不明な時点で
  // 保護ツリーも特定できておらず、そもそも何も保護できていない。
  const settingsTarget = path.join(home2, '.claude', 'settings.json');
  for (const tool of ['Read', 'Edit', 'Write']) {
    const out4 = execGuardScript(RUNNER2, {
      cwd: home2,
      env: env2,
      input: { hook_event_name: 'PreToolUse', cwd: home2, tool_name: tool, tool_input: { file_path: settingsTarget } },
    });
    check(`HOME 未解決でも settings.json の ${tool} は通す(復旧経路を残す)`,
      out4.trim() === '', out4);
  }
  // 逃げ道は settings.json だけ。無関係なファイルまで通すと、HOME 未解決を騙る形で
  // 保護が外れる余地が広がる。
  const out5 = execGuardScript(RUNNER2, {
    cwd: home2,
    env: env2,
    input: {
      hook_event_name: 'PreToolUse', cwd: home2, tool_name: 'Edit',
      tool_input: { file_path: path.join(home2, 'notes.txt') },
    },
  });
  check('HOME 未解決でも settings.json 以外は通さない', out5.trim() !== '', out5);
  check('逃げ道は拒否メッセージにも書いてある(書かないと気づけない)',
    /settings\.json/.test(res2?.hookSpecificOutput?.permissionDecisionReason || ''),
    JSON.stringify(res2));

  // status も同じ状態を「保護は無効」と言わない。「全部拒否される」原因を調べに来る唯一の
  // 入り口がここで、実態と逆の情報(保護が効いていない)を出したうえに実在しないダミーパスの
  // config.json を直せと案内すると、行き止まりに入ってガードを外す方向の回避しか残らなくなる
  // (main() の status 分岐は homeUnresolved を通常の「未作成 — 保護は無効」表示とは別扱いに
  // している。ここはその回帰テスト)。
  const statusOut2 = execGuardScript(RUNNER2, { argv: ['status'], cwd: home2, env: env2 });
  check('status は HOME 未解決を通常の「未作成 — 保護は無効」の文言では言わない(事実と逆になる)',
    !/未作成 — 保護は無効/.test(statusOut2), statusOut2);
  check('status はすべての操作を拒否している旨を明言する',
    /保護は無効ではありません/.test(statusOut2) && /すべての操作を拒否しています/.test(statusOut2),
    statusOut2);
  check('status でも settings.json からフック登録を外す逃げ道を案内する',
    /settings\.json/.test(statusOut2) && /フック登録を[\s\S]*外してください/.test(statusOut2),
    statusOut2);
}

// HOME 未解決とガード自身の異常終了が重なった場合。main() 側には settings.json の逃げ道が
// あるのに reportCrash 側だけ isConfigRepair しか見ていなかったため、この組み合わせでだけ
// 「Claude Code の中から復旧する手段が 1 つも無い」状態が残っていた(CONFIG がダミーの
// 相対パスになるので isConfigRepair は決して成立しない)。両方の経路で逃げ道が要る。
{
  const CRASH_DIR = path.join(BASE, 'crash-homeunresolved');
  fs.mkdirSync(CRASH_DIR, { recursive: true });
  // main() だけを確実に落とす。reportCrash の側を見たいので、注入は main の中に限る
  // (トップレベルで投げると catch より先にプロセスが死に、別の経路の検証になってしまう)。
  const original = fs.readFileSync(GUARD, 'utf8');
  const injected = original.replace('function main() {', 'function main() {\n  throw new Error("injected for test");');
  if (injected === original) throw new Error('main() への注入に失敗しました(テストの前提が崩れています)');
  fs.writeFileSync(path.join(CRASH_DIR, 'account-guard.js'), injected, 'utf8');
  fs.copyFileSync(path.join(__dirname, '..', 'credentials.js'), path.join(CRASH_DIR, 'credentials.js'));

  // HOME が全滅した環境の作り方は上のテストと同じ(環境変数の空文字だけでは再現できない)。
  const RUNNER4 = path.join(CRASH_DIR, 'run.js');
  fs.writeFileSync(RUNNER4, [
    "'use strict';",
    "require('os').homedir = () => '';",
    "require('./account-guard.js');",
  ].join('\n'), 'utf8');

  const crashHome = sandbox('crash-cwd', { rules: [{ tree: path.join(BASE, 'crash-target'), allow: [] }] });
  const crashEnv = { ...process.env, NO_COLOR: '1', USERPROFILE: '', HOME: '' };
  const runCrash = (toolName, filePath) => execGuardScript(RUNNER4, {
    cwd: crashHome,
    env: crashEnv,
    input: { hook_event_name: 'PreToolUse', cwd: crashHome, tool_name: toolName, tool_input: { file_path: filePath } },
  });

  const settingsTarget = path.join(crashHome, '.claude', 'settings.json');
  for (const tool of ['Read', 'Edit', 'Write']) {
    const out = runCrash(tool, settingsTarget);
    check(`異常終了 + HOME 未解決でも settings.json の ${tool} は通す(全停止させない)`,
      out.trim() === '', out);
  }
  // 逃げ道は settings.json だけ。ここを広げると、異常終了を装う形で保護が外れる。
  const outOther = runCrash('Edit', path.join(crashHome, 'notes.txt'));
  check('異常終了 + HOME 未解決でも settings.json 以外は通さない', outOther.trim() !== '', outOther);
  const crashReason = (outOther.trim() ? JSON.parse(outOther) : null)
    ?.hookSpecificOutput?.permissionDecisionReason || '';
  // CONFIG はこの状態ではダミー値なので、そのパスを「読めない設定ファイル」として出すと
  // 存在しない場所を直しに行かせることになる。
  check('異常終了の文面がダミーの設定パスを直せと言わない',
    !/home-unresolved/.test(crashReason), crashReason);
  check('異常終了の文面でも逃げ道(settings.json)を案内する',
    /settings\.json/.test(crashReason), crashReason);
}

// --- 異常終了の縮小判定は、切り出しが道連れになっても cwd の拒否を残す ---
//
// reportCrash は解除の遮断(isUnlockAttempt / isUnlockStateWrite)と解除範囲(unlockedPaths)も
// 見るが、これらは targetStrings 系の切り出しを通る。最初の例外がその切り出しから出ていた場合、
// reportCrash 自身が同じ例外で落ち、外側の catch は stderr に書くだけ ―― 拒否が出力されず、
// 呼び出しはそのまま通る。ガードが壊れたときこそ効いてほしい cwd の拒否が、壊れ方によって
// 消えることになる。切り出しごと壊した版で、その拒否が残ることを確かめる。
{
  const DIR = path.join(BASE, 'crash-targets');
  fs.mkdirSync(DIR, { recursive: true });
  const original = fs.readFileSync(GUARD, 'utf8');
  const withMain = original.replace(
    'function main() {',
    'function main() {\n  throw new Error("injected for test");'
  );
  const injected = withMain.replace(
    'function targetStrings(toolName, toolInput, cwd, trees = [], markUndecidable = false) {',
    'function targetStrings(toolName, toolInput, cwd, trees = [], markUndecidable = false) {\n  throw new Error("injected into targetStrings");'
  );
  if (withMain === original || injected === withMain) {
    throw new Error('注入に失敗しました(テストの前提が崩れています)');
  }
  fs.writeFileSync(path.join(DIR, 'account-guard.js'), injected, 'utf8');
  fs.copyFileSync(path.join(__dirname, '..', 'credentials.js'), path.join(DIR, 'credentials.js'));

  const tree = path.join(BASE, 'crash-targets-tree');
  fs.mkdirSync(tree, { recursive: true });
  const home = sandbox('crash-targets-home', {
    subscriptionType: 'pro', rules: [{ tree, allow: [] }],
  });
  // ツールは Edit にする。Read は READ_ONLY_TOOLS として isUnlockStateWrite が早い段階で
  // false を返すため切り出しに届かず、注入した例外が起きないまま通ってしまう(この形で
  // 書いたときは、壊した版でも落ちない ―― 何も確かめていないテストになっていた)。
  const res = toResult(execGuardScript(path.join(DIR, 'account-guard.js'), {
    env: homeEnv(home),
    input: {
      hook_event_name: 'PreToolUse', cwd: tree,
      tool_name: 'Edit', tool_input: { file_path: 'x.py' },
    },
  }));
  check('切り出しごと壊れても cwd が保護ツリー内なら拒否する',
    decision(res) === 'deny', JSON.stringify(res));
}

// credentials を読み取れなかっただけの状態を「壊れている」と同一視しない。中身が健全なまま
// 手が届いていないだけ(ウイルス対策のロック・ACL の一時変更・EBUSY)のことがあり、そこで
// 「失われる認証情報はない」と断言して /login を勧めると、まだ退避していないアカウントの
// refreshToken がその場で消える(復旧はブラウザ OAuth のやり直し)。
// ディレクトリを置いて EISDIR を作るのは、権限操作なしで移植性のある形で読み取り失敗を
// 再現できるため(0 バイト・JSON 破損は「中身を見たうえで使えない」側なので別扱いのまま)。
{
  const home = sandbox('creds-unreadable', { rules: ORG });
  fs.mkdirSync(path.join(home, '.claude', '.credentials.json'), { recursive: true });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:\\org-tree\\proj',
    tool_name: 'Read', tool_input: { file_path: 'src/main.py' },
  });
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('読み取れないだけの場合は拒否する', decision(res) === 'deny', JSON.stringify(res));
  check('読み取れないだけの場合は「失われる認証情報はない」と断言しない',
    !/失われる認証情報はない/.test(reason), reason);
  check('読み取れない場合は控えを残す手を先に案内する',
    /swap save <name> --force/.test(reason), reason);
  check('読み取れない場合も /login で消えることを伝える',
    /`\/login` すると/.test(reason), reason);
  // 2 手目の `swap <name>` にも --force が要る。CREDENTIALS 自体は読めないままなので、
  // 付けずに案内すると swap 側の同じ判定で必ず中止され、案内どおり打つと止まる。
  check('2 手目の swap にも --force が付いている(付いていないと swap 側が必ず中止する)',
    reason.includes('swap <name> --force'), reason);
  // 権限で読めない場合は swap のどの経路も控えを取れずに止まる。手で控えを取る逃げ道を
  // 示さないと、案内どおり打った先が行き止まりになる。
  check('「どちらも控えを取れませんでした」で止まる場合の逃げ道(手で別名コピーして /login)を案内する',
    /どちらも「控えを取れませんでした」で止まるなら/.test(reason) && /手で別名コピーして/.test(reason), reason);
  // 破損(0 バイト)の側は従来どおり「失うものは無い」と言い切ってよい。取り違えると
  // 今度は行き止まり(打つ手が 1 つも無い状態)に戻るので、両方を並べて固定する。
  const broken = sandbox('creds-empty', { rules: ORG, raw: '' });
  const resBroken = run(broken, {
    hook_event_name: 'PreToolUse', cwd: 'C:\\org-tree\\proj',
    tool_name: 'Read', tool_input: { file_path: 'src/main.py' },
  });
  check('0 バイトの credentials は従来どおり「失うものは無い」と案内する',
    /失われる認証情報はない/.test(resBroken?.hookSpecificOutput?.permissionDecisionReason || ''),
    JSON.stringify(resBroken));
}

// accessToken だけが欠けた credentials(書き込みの途中が典型)。復元には使えないので
// hasUsableCredentials は false になるが、refreshToken は交換すればまた使えるため、
// 「失われる認証情報はない」と言って /login を勧めると、まだ退避していないアカウントの
// 認証がそこで消える。破損(0 バイト)と同じ扱いにしていた頃はそうなっていた。
{
  const home = sandbox('creds-refresh-only', {
    rules: ORG,
    raw: JSON.stringify({ claudeAiOauth: { refreshToken: 'r-1', subscriptionType: 'pro' } }),
  });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:\\org-tree\\proj',
    tool_name: 'Read', tool_input: { file_path: 'src/main.py' },
  });
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('refreshToken だけ残る場合も拒否する', decision(res) === 'deny', JSON.stringify(res));
  check('refreshToken だけ残る場合は「失われる認証情報はない」と断言しない',
    !/失われる認証情報はない/.test(reason), reason);
  // 文面はトークンの名前を挙げない。この分岐には JSON として読めた中身(refreshToken が
  // 残っていると確定できる)と、生バイト列から拾っただけの中身(refreshToken か accessToken の
  // どちらかまでしか分からない)の両方が来るため。検査は「何が残っているか」の断定ではなく、
  // 失って困るものが残っていると伝えているかを見る。
  check('失って困るトークンが残っていることを理由として示す',
    /交換すればまた使えるトークンが残っています/.test(reason), reason);
  check('先に /login すると失われることを伝える', /`\/login` すると/.test(reason), reason);
  // swap 側はこの中身も「読めない現在」として扱う(hasUsableCredentials が false)。
  // --force を付けずに案内すると、案内どおり打っても必ず中止される。
  check('案内する swap には --force が付いている',
    /swap save <name> --force/.test(reason) && reason.includes('swap <name> --force'), reason);
}

// credentialsState() の SyntaxError 分岐(account-guard.js:474-482)。上の creds-refresh-only は
// JSON として読める(accessToken だけ欠ける)場合の hasRecoverableToken 経路を、creds-empty は
// raw='' で rawHasRecoverableToken も false になる unusable 側を見ており、どちらも
// 「JSON.parse が例外を投げ、かつ切れた位置より手前に refreshToken の文字列が残っている」
// 組み合わせは通らない。書き込みの途中で切り詰められた credentials がまさにこの形で、
// 以前はここを無条件に unusable(失うものは無い)へ倒し、「失われる認証情報はない」と
// 断言して /login を勧めていた。
{
  const home = sandbox('creds-truncated-syntax-error', {
    rules: ORG,
    raw: '{"claudeAiOauth":{"accessToken":"AT-A","refreshToken":"RT-ONLY-COPY"',
  });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:\\org-tree\\proj',
    tool_name: 'Read', tool_input: { file_path: 'src/main.py' },
  });
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('JSON 構文エラーで読めなくても保護ツリーは拒否する', decision(res) === 'deny', JSON.stringify(res));
  check('JSON 構文エラーを理由に「失われる認証情報はない」と断言しない',
    !/失われる認証情報はない/.test(reason), reason);
  check('未ログイン側の文言(消える退避はありません)も流用しない',
    !/消える退避はありません/.test(reason), reason);
  check('失って困るトークンが残っていることを理由として示す',
    /交換すればまた使えるトークンが残っています/.test(reason), reason);
  // こちらは JSON 構文エラー = rawHasRecoverableToken が生バイト列から拾っただけの経路。
  // 拾えたのが accessToken だけの控え(書き込みの途中で切れた形)もここに来るので、
  // refreshToken と名指しすると、交換という存在しない復旧手段を探させることになる。
  check('生の中身から拾ったトークンを refreshToken と名指ししない',
    !/refreshToken/.test(reason), reason);
  check('先に /login すると失われることを伝える', /`\/login` すると/.test(reason), reason);
}

// denyMessage の通常経路(account-guard.js:663-688、credentials は健全な usable)。まだ一度も
// swap で退避していない切り替え先へ向かう最初の1回。以前はこの経路に /login が一切出ず、
// 「swap save <name> → swap <name>」の2手だけを案内していた。切り替え先を一度も退避して
// いなければ `swap <name>` は「退避されていません」で必ず止まるため、案内どおり打つと
// 堂々巡りになっていた(README の初回手順は「退避 → /login → 退避」の順で /login を挟む)。
{
  const home = sandbox('deny-first-time-no-backups', { subscriptionType: 'pro', rules: ORG });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/org-tree/proj', tool_name: 'Read',
    tool_input: { file_path: 'src/main.py' },
  });
  check('健全な credentials でも保護ツリーは拒否する(前提)', decision(res) === 'deny', JSON.stringify(res));
  const reason = res?.hookSpecificOutput?.permissionDecisionReason || '';
  check('通常の切り替え手順(save→swap)を出す(前提)',
    /swap save <name>/.test(reason) && /swap <name>/.test(reason), reason);
  check('切り替え先を一度も退避していない場合の初回手順を出す',
    /まだ一度も退避していない場合は、この順で進めてください/.test(reason), reason);
  check('初回手順は退避のあとに /login する順序で出ている(先に /login ではない)',
    /1\.\s*swap save <name>[\s\S]*2\.\s*\/login[\s\S]*3\.\s*swap save <別名>/.test(reason), reason);
}

// --- 一時解除(unlock) ---
//
// 解除で確かめたいのは 3 点。(1) 開けた範囲だけが開くこと ―― ツリー単位で開くと、ツリーの下に
// 保護対象と非保護対象が混在している構成で全部が開いてしまう。(2) 解除がセッションに紐づくこと。
// (3) Claude 自身は解除できないこと ―― 歯止めがコマンド遮断と状態ファイル保護の 2 層あるので、
// 両方を別々に確かめる。

// 解除の CLI を叩く。セッション ID は環境変数で渡す(unlock はフック入力を持たない経路)。
// sessionId を省いたときは親の値も落として、「Claude Code の外から実行した」状況を作る。
function guardCli(home, argv, sessionId) {
  const env = homeEnv(home);
  if (sessionId) env.CLAUDE_CODE_SESSION_ID = sessionId;
  else delete env.CLAUDE_CODE_SESSION_ID;
  return execGuardScript(GUARD, { argv, env });
}

// 失敗する CLI 呼び出し。非ゼロ終了は execGuardScript が例外にするので、そこから stderr を取る。
// 成功してしまった場合は null を返す(呼び出し側が「失敗するはず」を検査できるように)。
function guardCliFail(home, argv, sessionId) {
  try {
    guardCli(home, argv, sessionId);
    return null;
  } catch (e) {
    return { status: e.status, stderr: String(e.stderr || '') };
  }
}

// 解除を絡めたフック呼び出し。env のセッション ID は必ず落とす。実行環境(このテストを走らせて
// いる Claude Code 自身)の値が候補に紛れ込むと、「別セッションでは解除が効かない」ことを
// 確かめるテストが実行環境しだいで意味を変える。
function runInSession(home, input) {
  const env = homeEnv(home);
  delete env.CLAUDE_CODE_SESSION_ID;
  return toResult(execGuardScript(GUARD, { env, input }));
}

// 解除済みのサンドボックス。解除は CLI 経由で作る ―― 状態ファイルを直接書くと、実際に
// 書かれる形式との食い違いに気づけないまま「テストだけ通る」ことになる。
function unlockedSandbox(name, dir, sessionId) {
  const home = sandbox(name, { subscriptionType: 'pro', rules: ORG });
  guardCli(home, ['unlock', '--path', dir, 'テスト用の解除'], sessionId);
  return home;
}

const reasonOf = (res) => res?.hookSpecificOutput?.permissionDecisionReason || '';
const contextOf = (res) => res?.hookSpecificOutput?.additionalContext || '';
const unlocksFile = (home) => path.join(home, '.claude', 'account-guard', 'unlocks.json');
const TOOL_A = 'C:/org-tree/tool-a';
const TOOL_B = 'C:/org-tree/tool-b';

// 解除の範囲
{
  const SID = 'session-scope';
  const home = unlockedSandbox('unlock-scope', TOOL_A, SID);
  const read = (session, cwd, file) => runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: session, cwd,
    tool_name: 'Read', tool_input: { file_path: file },
  });
  const shell = (command, cwd = 'C:/claude/ClaudeCode') => runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd,
    tool_name: 'Bash', tool_input: { command },
  });

  let res = read(SID, TOOL_A, 'x.py');
  check('解除した範囲では cwd 判定を通す', decision(res) === null, JSON.stringify(res));
  check('解除が効いた回は解除中であることを文脈に載せる',
    /一時解除/.test(contextOf(res)) && contextOf(res).includes('tool-a'), JSON.stringify(res));

  res = read(SID, TOOL_B, 'x.py');
  check('解除していない兄弟ディレクトリは拒否したまま', decision(res) === 'deny', JSON.stringify(res));

  res = read('session-other', TOOL_A, 'x.py');
  check('別のセッションでは同じ解除が効かない', decision(res) === 'deny', JSON.stringify(res));

  res = read(SID, 'C:/claude/ClaudeCode', TOOL_A + '/x.py');
  check('ツリーの外からでも解除範囲を指す対象は通す', decision(res) === null, JSON.stringify(res));

  res = read(SID, 'C:/claude/ClaudeCode', TOOL_B + '/x.py');
  check('ツリーの外からでも解除範囲外を指す対象は拒否する', decision(res) === 'deny', JSON.stringify(res));

  // 「対象が複数あるなら全部が範囲内であること」。ここが緩いと、一部だけ解除した状態で
  // 範囲外を巻き込むコマンドが通ってしまう。
  res = shell(`cp ${TOOL_A}/x ${TOOL_B}/`);
  check('対象の一部が範囲外なら拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = shell(`cat ${TOOL_A}/x`);
  check('シェルでも対象が全部範囲内なら通す', decision(res) === null, JSON.stringify(res));

  // 表記を変えるだけで範囲判定がずれないこと。拒否側(mentionsTree)と解除側(treeRefsIn)は
  // 同じ正規化を通す約束なので、片方だけが当たる書き方があってはいけない。
  res = shell('cat /c/org-tree/tool-b/x');
  check('MSYS 表記でも範囲外は拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = shell('type C:\\org-tree\\tool-a\\x');
  check('バックスラッシュ表記でも範囲内なら通す', decision(res) === null, JSON.stringify(res));

  res = shell(`cat ${TOOL_A}/../tool-b/x`);
  check('範囲内を経由して範囲外へ登る指定は拒否する', decision(res) === 'deny', JSON.stringify(res));

  // cwd の解除は「そこで作業してよい」であって、同じツリーの範囲外を触ってよいことにはならない。
  res = read(SID, TOOL_A, '../tool-b/x.py');
  check('cwd が解除済みでも、範囲外を指す対象は拒否する', decision(res) === 'deny', JSON.stringify(res));

  // リダイレクトはパスの区切りとして扱う。空白を省いた `x>y` を 1 つのトークンとして
  // 切り出していた頃は、前半が範囲内なら後半(範囲外)ごと範囲内と判定され、上の
  // 「対象の一部が範囲外なら拒否する」が空白ひとつで無効になっていた。
  res = shell(`cat ${TOOL_A}/x>${TOOL_B}/y`);
  check('空白なしのリダイレクトで連結された範囲外は拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = shell(`cat ${TOOL_A}/x>>${TOOL_B}/y`);
  check('追記リダイレクトで連結された範囲外は拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = shell(`diff ${TOOL_A}/x<${TOOL_B}/y`);
  check('入力リダイレクトで連結された範囲外は拒否する', decision(res) === 'deny', JSON.stringify(res));
}

// Claude 自身が解除できないこと(歯止め 1: コマンドの遮断)
{
  const SID = 'session-selfblock';
  const home = unlockedSandbox('unlock-selfblock', TOOL_A, SID);
  const shell = (command, cwd = 'C:/claude/ClaudeCode') => runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd,
    tool_name: 'Bash', tool_input: { command },
  });

  // この home は解除中。それでも解除の実行は拒否する(解除の延長・再発行を防ぐため)。
  let res = runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: TOOL_A,
    tool_name: 'Read', tool_input: { file_path: 'x.py' },
  });
  check('前提: このサンドボックスでは解除が効いている', decision(res) === null, JSON.stringify(res));

  res = shell('guard unlock "理由"');
  check('解除中のセッションでも guard unlock は拒否する', decision(res) === 'deny', JSON.stringify(res));
  check('拒否の文面はユーザーが `!` で打つよう案内する',
    /! guard unlock/.test(reasonOf(res)), reasonOf(res));
  check('Claude から打てる手(lock / status)も併せて示す',
    /guard lock/.test(reasonOf(res)) && /guard status/.test(reasonOf(res)), reasonOf(res));

  res = shell('node C:/claude/ClaudeCode/account-guard/account-guard.js unlock --path C:/x "r"');
  check('ラッパーを介さず本体を直接叩く解除も拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = shell('powershell -c "guard.cmd unlock r"');
  check('別のシェルを噛ませた解除も拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = shell('guard lock');
  check('取り消し(guard lock)は Claude からも通す', decision(res) === null, JSON.stringify(res));

  res = shell('guard status');
  check('状態の確認(guard status)は Claude からも通す', decision(res) === null, JSON.stringify(res));

  // 設定が壊れていても遮断は効く。ここが config の状態に依存すると、「設定を壊せば解除できる」
  // という迂回路ができる。
  const broken = sandbox('unlock-selfblock-broken', { subscriptionType: 'pro', rawRules: '{ broken' });
  res = runInSession(broken, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: 'C:/claude/ClaudeCode',
    tool_name: 'Bash', tool_input: { command: 'guard unlock "理由"' },
  });
  check('設定が壊れていても解除の実行は拒否する', decision(res) === 'deny', JSON.stringify(res));
  check('その拒否は設定破損ではなく解除の遮断として説明する',
    /Claude からの実行を止めています/.test(reasonOf(res)), reasonOf(res));
}

// Claude 自身が解除できないこと(歯止め 2: 状態ファイルの保護)
{
  const SID = 'session-statefile';
  const home = unlockedSandbox('unlock-statefile', TOOL_A, SID);
  const file = unlocksFile(home);
  const call = (tool_name, tool_input, cwd = 'C:/claude/ClaudeCode') => runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd, tool_name, tool_input,
  });

  check('前提: 解除の状態ファイルができている', fs.existsSync(file), file);

  let res = call('Write', { file_path: file, content: '{"unlocks":[]}' });
  check('unlocks.json への Write は拒否する', decision(res) === 'deny', JSON.stringify(res));
  // 何のファイルなのかを文面で説明する。守る範囲がディレクトリ単位になってからは、
  // config.json(保護ルール)まで含むので、そこまで書き分けられていることを見る。
  check('拒否の文面が状態ファイルであることを説明する',
    /状態ファイル/.test(reasonOf(res)) && /config\.json は保護ルール/.test(reasonOf(res)), reasonOf(res));

  res = call('Edit', { file_path: file });
  check('unlocks.json への Edit は拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = call('Bash', { command: 'echo {} > unlocks.json' }, path.dirname(file));
  check('相対パスで unlocks.json を書く経路も拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = call('Bash', { command: `echo {} > ${file.replace(/\\/g, '/')}` });
  check('絶対パスで unlocks.json を書く経路も拒否する', decision(res) === 'deny', JSON.stringify(res));

  // 読み取りまで止める理由はない(status が出すのと同じ内容で、隠しても迂回の動機になるだけ)。
  res = call('Read', { file_path: file });
  check('unlocks.json の読み取りは止めない', decision(res) === null, JSON.stringify(res));

  // リダイレクトを区切りとして扱わないと、`>` の前のパスと連結した 1 トークンになり、
  // 状態ファイルとの一致判定(完全一致)をすり抜ける。
  res = call('Bash', { command: `cat C:/tmp/x>${file.replace(/\\/g, '/')}` });
  check('空白なしのリダイレクトでも状態ファイルへの書き込みは拒否する', decision(res) === 'deny', JSON.stringify(res));

  // `~` や `$HOME` は path.resolve が知らない。展開しないままだと cwd 配下の実在しない
  // パスへ解決され、ホームを指すいちばん普通の書き方だけが素通りしていた。
  res = call('Bash', { command: 'echo {} > ~/.claude/account-guard/unlocks.json' });
  check('~ 表記でも状態ファイルへの書き込みは拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = call('Bash', { command: 'cp /tmp/x "$HOME/.claude/account-guard/unlocks.json"' });
  check('$HOME 表記でも状態ファイルへの書き込みは拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = call('PowerShell', { command: 'Set-Content %USERPROFILE%\\.claude\\account-guard\\unlocks.json "{}"' });
  check('%USERPROFILE% 表記でも状態ファイルへの書き込みは拒否する', decision(res) === 'deny', JSON.stringify(res));

  // 知らないツール(MCP のファイルシステムサーバなど)にも同じ歯止めを効かせる。書き込める
  // ツール名を列挙して塞ぐ形だと、増えるたびに歯止めの外側が広がる。
  res = call('mcp__fs__write_file', { path: file });
  check('知らないツールからの状態ファイル書き込みも拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = call('MultiEdit', { file_path: file, edits: [] });
  check('MultiEdit からの状態ファイル書き込みも拒否する', decision(res) === 'deny', JSON.stringify(res));

  // 宛先がディレクトリの書き込みは、コマンド文字列にファイル名が現れない。完全一致だけを
  // 見ていた頃は `cp <偽の unlocks.json> ~/.claude/account-guard/` がそのまま通り、状態ファイルを
  // 名指ししないまま置き換えられた(同じ操作を cd してファイル名で書けば拒否されていたので、
  // 書き方だけで結論が変わっていた)。
  res = call('Bash', { command: 'cp /tmp/x ~/.claude/account-guard/' });
  check('ディレクトリ宛ての書き込みも拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = call('Bash', { command: 'mv /tmp/x ~/.claude/account-guard' });
  check('末尾に区切りが無いディレクトリ宛ても拒否する', decision(res) === 'deny', JSON.stringify(res));

  // 過剰検出は承知のうえ。書き込みかどうかはコマンドを解釈しないと分からず、解釈を増やすほど
  // 「その解釈から漏れた書き方」が穴になる。言及しただけのコマンドが止まる実害は、そのコマンドを
  // 打てないことだけで、読むだけなら Read / Glob / Grep が通る。
  res = call('Bash', { command: 'ls ~/.claude/account-guard/' });
  check('ディレクトリを言及しただけでも止める(過剰検出は許容)', decision(res) === 'deny', JSON.stringify(res));

  // 履歴は「誰がいつ何のために解除したか」を後から確かめる唯一の手掛かりで、この設計は
  // 「ユーザーが `!` で打った」ことに全体重を預けている。書き換えられるとその確かめようがない。
  const logFile = path.join(path.dirname(file), 'unlock.log');
  res = call('Write', { file_path: logFile, content: '' });
  check('解除の履歴への書き込みも拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = call('Bash', { command: 'echo x >> ~/.claude/account-guard/unlock.log' });
  check('履歴への追記も拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = call('Read', { file_path: logFile });
  check('履歴の読み取りは止めない', decision(res) === null, JSON.stringify(res));

  // Win32 が「同じファイル」として扱う書き方。NTFS の代替データストリーム表記は本体そのものを
  // 指し(`x::$DATA` への書き込みが実際に x を上書きすることを確認済み)、末尾のドットと空白は
  // Win32 が黙って落とす。完全一致で突き合わせていた頃はいずれも別のパスとして素通りしていた。
  for (const [label, suffix] of [
    ['代替データストリーム', '::$DATA'],
    ['末尾のドット', '.'],
    ['末尾の空白', ' '],
  ]) {
    res = call('Write', { file_path: `${file}${suffix}`, content: '{}' });
    check(`${label}を付けた書き込みも拒否する`, decision(res) === 'deny', JSON.stringify(res));
  }

  // 同名でも別の場所のファイルは巻き込まない。
  res = call('Write', { file_path: 'C:/claude/ClaudeCode/unlocks.json', content: '{}' });
  check('別の場所にある同名ファイルは巻き込まない', decision(res) === null, JSON.stringify(res));

  res = call('mcp__fs__write_file', { path: 'C:/claude/ClaudeCode/unlocks.json' });
  check('知らないツールでも別の場所の同名ファイルは巻き込まない', decision(res) === null, JSON.stringify(res));
}

// CLI の異常系と、解除 → 確認 → 取り消しの一巡
{
  const SID = 'session-cli';
  const home = sandbox('unlock-cli', { subscriptionType: 'pro', rules: ORG });
  const file = unlocksFile(home);

  let f = guardCliFail(home, ['unlock', '--path', TOOL_A], SID);
  check('理由のない unlock は失敗する', f !== null && f.status === 1, JSON.stringify(f));
  check('理由が要ることを伝える', /理由が必要/.test(f?.stderr || ''), f?.stderr);
  check('失敗した解除は状態ファイルを作らない', !fs.existsSync(file), file);

  // 知らないオプションを理由へ吸い込むと、`--path` の打ち間違いが「範囲指定のない解除」として
  // 成立し、意図した範囲ではなく cwd(たいていもっと広い)が黙って開く。
  f = guardCliFail(home, ['unlock', '--paht', TOOL_B, '理由'], SID);
  check('知らないオプションは失敗させる', f !== null && f.status === 1, JSON.stringify(f));
  check('打ち間違えたオプションをそのまま示す', /--paht/.test(f?.stderr || ''), f?.stderr);
  check('打ち間違えた解除は状態ファイルを作らない', !fs.existsSync(file), file);

  // 引用符で正しく囲んだ理由がハイフンで始まるだけで、知らないオプション扱いにしない。
  // 要素全体を見ていた頃は「理由は引用符で囲んで渡してください」と、すでに従っている指示を
  // 返していた。オプションらしさに「空白を含まない 1 語」まで求めれば、打ち間違い(--paht)は
  // そのまま捕まえられる。
  // 成功する解除を作るので、この一巡の状態ファイル検査に影響しないよう別のサンドボックスで行う。
  for (const [i, why] of ['-- limit hit', '-1 日だけ'].entries()) {
    const h = sandbox(`unlock-dash-reason-${i}`, { subscriptionType: 'pro', rules: ORG });
    const failed = guardCliFail(h, ['unlock', '--path', TOOL_B, why], SID);
    check(`ハイフンで始まる理由 "${why}" を受け付ける`, failed === null, JSON.stringify(failed));
  }

  f = guardCliFail(home, ['unlock', '--path', 'C:/elsewhere', '理由'], SID);
  check('保護ツリーの外は解除できない', f !== null && f.status === 1, JSON.stringify(f));

  // issue #6(ドライブ文字を落とした指定が広い範囲に一致する)を解除側へ持ち込まない。
  // config の tree 側は過剰に拒否する方向の誤りで済むが、解除側の同じ緩さは保護が外れる向き。
  f = guardCliFail(home, ['unlock', '--path', '/org-tree', '理由'], SID);
  check('ドライブ文字のない --path は受け付けない', f !== null && f.status === 1, JSON.stringify(f));
  f = guardCliFail(home, ['unlock', '--path', 'org-tree', '理由'], SID);
  check('相対パスの --path も受け付けない', f !== null && f.status === 1, JSON.stringify(f));

  f = guardCliFail(home, ['unlock', '--path', TOOL_A, '理由'], null);
  check('セッション ID を取れないなら解除しない', f !== null && f.status === 1, JSON.stringify(f));
  check('セッション ID が理由であることを伝える', /セッション ID/.test(f?.stderr || ''), f?.stderr);

  const out = guardCli(home, ['unlock', '--path', TOOL_A, 'リミット回避のため'], SID);
  check('解除は範囲と取り消し方を出す', /解除しました/.test(out) && /guard lock/.test(out), out);

  const st = guardCli(home, ['status'], SID);
  check('status に解除中の範囲が出る', /org-tree[\\/]tool-a/.test(st), st);
  check('status に解除の理由が出る', /リミット回避のため/.test(st), st);
  const stOther = guardCli(home, ['status'], 'session-someone-else');
  check('status は他セッションの解除を自分のものとして出さない', /解除: なし/.test(stOther), stOther);

  // lock も同じ取り違えを起こす。向きは逆(範囲を指定したつもりで全部消える)だが、原因は
  // 同じ「打ち間違えたオプションが黙って通ること」なので、判定は unlock と合流させてある。
  f = guardCliFail(home, ['lock', '--paht', TOOL_A], SID);
  check('lock でも知らないオプションは失敗させる', f !== null && f.status === 1, JSON.stringify(f));
  check('失敗した lock は解除を消さない', JSON.parse(fs.readFileSync(file, 'utf8')).unlocks.length === 1, file);

  // `--path` を書き忘れた形はオプションの判定に当たらない。裸の引数は lock では意味を持たず、
  // 黙って捨てると範囲を絞ったつもりのまま全部消えて「取り消しました」と返る。
  f = guardCliFail(home, ['lock', TOOL_A], SID);
  check('lock は --path なしの範囲指定を失敗させる', f !== null && f.status === 1, JSON.stringify(f));
  check('--path を欠いた lock は解除を消さない',
    JSON.parse(fs.readFileSync(file, 'utf8')).unlocks.length === 1, file);

  // --path の形も unlock と揃える。ドライブ文字を欠くと cwd 基準で解決され、まだ開いている
  // 範囲に対して「解除はありません」と返っていた(消えないので実害は誤解だけだが、
  // 取り消したつもりで作業を続けることになる)。
  f = guardCliFail(home, ['lock', '--path', '/org-tree/tool-a'], SID);
  check('lock でもドライブ文字のない --path は受け付けない', f !== null && f.status === 1, JSON.stringify(f));

  guardCli(home, ['unlock', '--path', TOOL_A, '二度目の理由'], SID);
  let state = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('同じ範囲を重ねて解除しても件数は増えない', state.unlocks.length === 1, JSON.stringify(state));
  check('重ねた解除は理由を新しいもので置き換える', state.unlocks[0].reason === '二度目の理由', JSON.stringify(state));

  const log = fs.readFileSync(path.join(home, '.claude', 'account-guard', 'unlock.log'), 'utf8');
  check('解除は履歴に残る', /unlock\t/.test(log) && /リミット回避のため/.test(log), log);

  const lockOut = guardCli(home, ['lock'], SID);
  check('lock は取り消した範囲を出す', /取り消しました/.test(lockOut), lockOut);
  state = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('lock で解除が消える', state.unlocks.length === 0, JSON.stringify(state));
  check('取り消しも履歴に残る',
    /\tlock\t/.test(fs.readFileSync(path.join(home, '.claude', 'account-guard', 'unlock.log'), 'utf8')), log);

  // 取り消しは自分のセッションのぶんだけ。他セッションの解除まで消すと、片方の作業が黙って止まる。
  guardCli(home, ['unlock', '--path', TOOL_A, '別セッションの解除'], 'session-elsewhere');
  guardCli(home, ['lock'], SID);
  state = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('lock は他セッションの解除を消さない',
    state.unlocks.length === 1 && state.unlocks[0].sessionId === 'session-elsewhere', JSON.stringify(state));

  // 範囲を指定した取り消しは完全一致。配下を指定して親の解除が消えると、範囲の見立てが狂う。
  guardCli(home, ['unlock', '--path', TOOL_A, 'また解除'], SID);
  guardCli(home, ['lock', '--path', TOOL_A + '/inner'], SID);
  state = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('lock --path は配下の指定では親の解除を消さない',
    state.unlocks.some((u) => u.sessionId === SID), JSON.stringify(state));
  guardCli(home, ['lock', '--path', TOOL_A], SID);
  state = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('lock --path は完全一致なら消す',
    !state.unlocks.some((u) => u.sessionId === SID), JSON.stringify(state));

  // 状態を保存できないときに「解除しました」と出すと、拒否され続ける理由が分からなくなる。
  const blocked = sandbox('unlock-write-blocked', { subscriptionType: 'pro', rules: ORG });
  fs.mkdirSync(unlocksFile(blocked) + '.tmp', { recursive: true });
  const wf = guardCliFail(blocked, ['unlock', '--path', TOOL_A, '理由'], 'session-blocked');
  check('状態ファイルを書けなければ解除は失敗する', wf !== null && wf.status === 1, JSON.stringify(wf));
  check('保存できなかったことを伝える', /解除を保存できません/.test(wf?.stderr || ''), wf?.stderr);

  // 壊れた状態ファイルを黙って書き直すと、他セッションの解除と履歴をまとめて消してしまう。
  const corrupt = sandbox('unlock-corrupt', { subscriptionType: 'pro', rules: ORG });
  fs.writeFileSync(unlocksFile(corrupt), '{ broken', 'utf8');
  const cf = guardCliFail(corrupt, ['unlock', '--path', TOOL_A, '理由'], 'session-corrupt');
  check('壊れた状態ファイルは黙って書き直さない', cf !== null && cf.status === 1, JSON.stringify(cf));
  check('壊れた状態ファイルの中身は残したまま',
    fs.readFileSync(unlocksFile(corrupt), 'utf8') === '{ broken', fs.readFileSync(unlocksFile(corrupt), 'utf8'));
  const cres = runInSession(corrupt, {
    hook_event_name: 'PreToolUse', session_id: 'session-corrupt', cwd: TOOL_A,
    tool_name: 'Read', tool_input: { file_path: 'x.py' },
  });
  check('壊れた状態ファイルでは解除が効かず拒否側に倒れる', decision(cres) === 'deny', JSON.stringify(cres));
}

// ガード自身が異常終了した経路(縮小判定)にも解除を効かせる
{
  fs.mkdirSync(BASE, { recursive: true });
  const CRASH = path.join(BASE, 'ag-crash-unlock.js');
  const credModule = JSON.stringify(path.join(__dirname, '..', 'credentials.js'));
  fs.writeFileSync(
    CRASH,
    fs.readFileSync(GUARD, 'utf8')
      .replace("require('./credentials')", `require(${credModule})`)
      .replace('function main() {', "function main() {\n  throw new Error('boom');"),
    'utf8'
  );
  const runCrash = (home, input) => {
    const env = homeEnv(home);
    delete env.CLAUDE_CODE_SESSION_ID;
    return toResult(execGuardScript(CRASH, { env, input }));
  };

  const SID = 'session-crash';
  const home = unlockedSandbox('unlock-crash', TOOL_A, SID);

  let res = runCrash(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: TOOL_A,
    tool_name: 'Read', tool_input: { file_path: 'x.py' },
  });
  // 反映しないと「ガードが壊れている間だけ解除が無視されて詰む」穴が残る。
  check('異常終了しても解除済みの cwd は通す', res === null, JSON.stringify(res));

  res = runCrash(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: TOOL_B,
    tool_name: 'Read', tool_input: { file_path: 'x.py' },
  });
  check('異常終了時も解除範囲外の cwd は拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = runCrash(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: 'C:/claude/ClaudeCode',
    tool_name: 'Bash', tool_input: { command: 'guard unlock "理由"' },
  });
  check('異常終了時も Claude からの解除は拒否する', decision(res) === 'deny', JSON.stringify(res));
}

// --- 切り詰められた参照は解除の範囲内と見なさない ---
//
// ブレース展開・glob のブラケット・カンマ・引用符は、切り出したトークンの続きを実行時に作る。
// 前方一致の範囲判定は「先頭が範囲内なら全体も範囲内」と答えるので、先頭だけを見て通すと
// 解除していない兄弟ディレクトリに手が届く。同じ切り詰めが解除の状態ファイルの一致判定も
// 外していた(下の「状態ファイルへの書き込み」)ので、両方を並べて確かめる。
{
  const SID = 'session-truncate';
  const home = unlockedSandbox('unlock-truncate', TOOL_A, SID);
  const shell = (command) => runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: 'C:/claude/ClaudeCode',
    tool_name: 'Bash', tool_input: { command },
  });

  let res = shell(`cat ${TOOL_A}/x.py`);
  check('解除範囲だけを触るコマンドは通す', decision(res) === null, JSON.stringify(res));

  res = shell(`cat ${TOOL_A}/x.py && ls`);
  check('シェルの区切りで続くコマンドも通す', decision(res) === null, JSON.stringify(res));

  res = shell(`cat "${TOOL_A}"/x.py`);
  check('引用符で割れたパスは繋げて解除範囲と見る', decision(res) === null, JSON.stringify(res));

  res = shell(`cat ${TOOL_A}{,bc}/secret`);
  check('ブレース展開で兄弟に届く形は拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = shell(`cat ${TOOL_A}[bc]/secret`);
  check('glob のブラケットで兄弟に届く形は拒否する', decision(res) === 'deny', JSON.stringify(res));

  // 切り詰めで拒否したときは見出しも「判定できない」でなければならない。断定形のままだと
  // 「配下だと分かった」と読め、字面を判定できる形に直せば通ることに気づけない。ブレース展開は
  // 別経路(undecidable: 'brace')で既に判定不能にしていたので、こちらだけが断定形に戻っていた。
  const truncatedReason = res?.hookSpecificOutput?.permissionDecisionReason ?? '';
  check('切り詰めの拒否は見出しも判定不能にする',
    /判定できないため拒否/.test(truncatedReason), truncatedReason);

  // どのフィールドが操作対象か分からないツールは入力を JSON にしてから拾うので、トークンは
  // 必ず JSON の `"` で終わり、常に切り詰め扱いになる ―― 解除が効かないのは意図した設計だが、
  // 理由まで「指定がそこで終わっている」と説明すると、書き方を直せば通るように読める。
  // 直しようがないので、この場合だけ別の文面にする。拒否そのものは変わらない。
  const opaque = runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: 'C:/claude/ClaudeCode',
    tool_name: 'mcp__fs__read_file', tool_input: { path: `${TOOL_A}/x.py` },
  });
  check('知らないツールは解除の範囲内でも拒否する', decision(opaque) === 'deny', JSON.stringify(opaque));
  check('知らないツールの理由は書き換えを促さない',
    /入力の形が決まっておらず/.test(reasonOf(opaque)), reasonOf(opaque));

  res = shell(`cat ${TOOL_A},bc/secret`);
  check('カンマで名前が続く形は拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = shell(`cat "${TOOL_A}"bc/secret`);
  check('引用符の外で名前が伸びる形は拒否する', decision(res) === 'deny', JSON.stringify(res));

  // ブレースがツリー名そのものを割る形。切り出せるのは `c:/` までで、コマンド文字列にも
  // 連続した `c:/org-tree` は現れない ―― ツリーへの言及が 1 つも見つからないまま通ると、
  // 解除の範囲どころか拒否そのものが素通りする。
  res = shell('cat C:/{org-tree,other}/secret');
  check('ブレースでツリー名を割る形も拒否する', decision(res) === 'deny', JSON.stringify(res));
}

// --- cd の移動先を基準にした相対パス ---
//
// 移動してから相対で指す形は、フック入力の cwd で解決すると別の場所になる。絶対パスで
// 同じ場所を指せば拒否されるので、書き方だけで結論が変わっていた。
{
  const SID = 'session-cd';
  const home = unlockedSandbox('unlock-cd', TOOL_A, SID);
  const shell = (command) => runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: 'C:/claude/ClaudeCode',
    tool_name: 'Bash', tool_input: { command },
  });

  let res = shell(`cd ${TOOL_A} && cat sub/x.py`);
  check('移動先が解除範囲なら、その配下の相対パスは通す', decision(res) === null, JSON.stringify(res));

  res = shell(`cd ${TOOL_A} && cat ../tool-b/secret`);
  check('移動先から解除範囲の外へ登る相対パスは拒否する', decision(res) === 'deny', JSON.stringify(res));

  // 改行もコマンドの区切り。`&&` 版だけを見ていた頃は、同じ内容を複数行で書くと cd が
  // 拾われず、相対パスがフック入力の cwd で解決されて素通りしていた(書き方だけで結論が
  // 変わる状態)。ヒアドキュメントや複数行のスクリプトは実際にこの形で来る。
  res = shell(`echo hi\ncd ${TOOL_A}\ncat ../tool-b/secret`);
  check('改行区切りでも cd の移動先を基準にする', decision(res) === 'deny', JSON.stringify(res));

  // ラッパーの引数として渡された cd も基準にする。引用符は判定より前に外れるので
  // `bash -c "cd <dir> && …"` は cd の直前が `-c ` になり、行頭にも区切りにも当たらなかった。
  // 移動先が拾われないと基準は cwd だけになり、解除範囲の外を指す相対パスが解除の内側に
  // 解決されて、兄弟ディレクトリが実際に読めていた。
  for (const [label, command] of [
    ['bash -c', `bash -c "cd ${TOOL_A} && cat ../tool-b/secret"`],
    ['sh -c', `sh -c 'cd ${TOOL_A}; cat ../tool-b/secret'`],
    ['eval', `eval "cd ${TOOL_A} && cat ../tool-b/secret"`],
    ['sudo', `sudo cd ${TOOL_A} && cat ../tool-b/secret`],
  ]) {
    res = shell(command);
    check(`${label} 越しの cd も移動先を基準にする`, decision(res) === 'deny', JSON.stringify(res));
  }

  // 解除した場所を cwd にして、ラッパー越しに上へ登る形。上と裏返しの経路で、cwd が解除の
  // 範囲内なのでツリーの内側にいること自体は通り、対象の判定だけが頼りになる。
  const inTree = (command) => runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: TOOL_A,
    tool_name: 'Bash', tool_input: { command },
  });
  res = inTree('bash -c "cd .. && cat tool-b/secret"');
  check('解除した場所からラッパー越しに登る形も拒否する', decision(res) === 'deny', JSON.stringify(res));
  res = inTree('cat sub/x.py');
  check('解除の範囲内なら cwd 基準の相対パスは通す', decision(res) === null, JSON.stringify(res));

  // 連鎖する cd。cd ごとに cwd から解決し直していた頃は候補が cwd・cwd/x・cwd/y の 3 つで、
  // 実際の基準 x/y がどこにも無かった。そこから登る相対パスは別の場所に解決され、解除の
  // 範囲内に見えて通っていた ―― 1 段の `cat ../tool-b/secret` なら拒否されるので、段数を
  // 増やすだけで結論が変わる形だった。
  res = inTree('cd x && cd y && cat ../../../tool-b/secret');
  check('連鎖した cd の基準からツリー外へ登る形も拒否する', decision(res) === 'deny', JSON.stringify(res));
  // 積み上げた基準は cwd 基準の候補に足す形なので、実際には通らない基準も残る。連鎖した cd
  // から見て範囲内を指す相対パスでも、別の候補から解決すると範囲外になり拒否される ――
  // 候補が増えるほど拒否側に倒れる設計どおりで、この修正の前後で変わらない。
  res = inTree('cd x && cd y && cat ../../sub/x.py');
  check('連鎖した cd では範囲内を指していても拒否側に倒れる', decision(res) === 'deny', JSON.stringify(res));

  // Glob の pattern と Grep の glob は、cwd ではなく同じ入力の path フィールドからの相対で
  // 効く。すべて cwd 基準で解決していた頃は、逃げる側の pattern が cwd 基準ではツリーの外に
  // 落ちて対象にならず、残る対象が解除済みの path だけになって素通りしていた。
  for (const [tool, field] of [['Glob', 'pattern'], ['Grep', 'glob']]) {
    res = runInSession(home, {
      hook_event_name: 'PreToolUse', session_id: SID, cwd: 'C:/work',
      tool_name: tool, tool_input: { path: TOOL_A, [field]: '../tool-b/**' },
    });
    check(`${tool} の ${field} は path 基準で解決する`, decision(res) === 'deny', JSON.stringify(res));

    res = runInSession(home, {
      hook_event_name: 'PreToolUse', session_id: SID, cwd: 'C:/work',
      tool_name: tool, tool_input: { path: TOOL_A, [field]: '**/*.py' },
    });
    check(`${tool} の ${field} が範囲内なら通す`, decision(res) === null, JSON.stringify(res));
  }
}

// --- 実行時にしか決まらない要素を含むコマンドでは解除を適用しない ---
//
// resolveFrom は `$PARENT` を字面どおりのディレクトリ名として解決するので、解除したディレクトリ
// の「配下」に実在しない場所ができ、実際には範囲外を指すコマンドが範囲内に見えていた
// (`tool-a` だけを解除した状態で兄弟の `tool-b` が読めた)。触る場所が字面から決まらない
// コマンドでは解除を無かったものとして扱い、解除を入れる前と同じ「保護ツリーの中は無条件に
// 拒否」へ戻す。
//
// 当初は cd の移動先だけを見ていたが、同じ要素が操作対象の側にあっても結果は同じで、そちらは
// 素通りしていた。とくに区切りを含まない `cat $X` はパスのトークンとして切り出されないため
// 対象が 1 つも作られず、実行時の値は cwd 基準で解決される以上、届く先はツリーの中に限らない。
{
  const SID = 'session-runtime-cd';
  const home = unlockedSandbox('unlock-runtime-cd', TOOL_A, SID);
  const shell = (command) => runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: TOOL_A,
    tool_name: 'Bash', tool_input: { command },
  });

  let res = shell('cd .. && cat tool-b/secret');
  check('静的に解決できる cd では従来どおり範囲外を拒否する', decision(res) === 'deny', JSON.stringify(res));

  // バッククォートと `$(` で始まる形は CD_COMMAND のキャプチャに現れない(TOKEN_STOP で
  // 切れる)。移動先の切り出しを分けた理由がこれなので、両方を並べて確かめる。
  for (const [label, dest] of [
    ['$VAR', '$PARENT'],
    ['${VAR}', '${PARENT}'],
    ['%VAR%', '%PARENT%'],
    ['$(...)', '$(dirname $PWD)'],
    ['バッククォート', '`dirname $PWD`'],
  ]) {
    res = shell(`cd ${dest} && cat tool-b/secret`);
    check(`移動先が ${label} の cd では解除を適用しない`, decision(res) === 'deny', JSON.stringify(res));
  }

  // 操作対象の側に入った実行時要素。cd の移動先だけを見ていた頃はここが素通りだった。
  for (const [label, command] of [
    ['$VAR/…', 'cat $SOMEDIR/secret'],
    ['$(...)/…', 'cat $(dirname ..)/tool-b/secret'],
    // バッククォートは判定より前に外れるので、外した残り(`pwd/secret`)が解除の範囲内に
    // 収まる形にする。`` `dirname ..`/tool-b/secret `` だと外した残りの `../tool-b/secret` が
    // それだけで範囲外になり、実行時要素を見ていなくても拒否される(感度の無いテストになる)。
    ['バッククォート', 'cat `pwd`/secret'],
    ['区切りを含まない $VAR', 'cat $X'],
  ]) {
    res = shell(command);
    check(`操作対象が ${label} のコマンドでは解除を適用しない`, decision(res) === 'deny', JSON.stringify(res));
  }

  // 部分式は PowerShell の経路で見る。裸の丸括弧を数えるのは PowerShell だけで、Bash や
  // 委譲の指示文まで数えると `python -c "print(1)"` のような無関係なコマンドで解除が
  // 失われる(Bash では `(` はサブシェルの構文で、そこからパスが生まれるわけではない。
  // 実際に置換するのは `$(...)` で、そちらは上のループが押さえている)。
  res = runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: TOOL_A,
    tool_name: 'PowerShell', tool_input: { command: 'cat (Get-Item ..).FullName/secret' },
  });
  check('操作対象が PowerShell の部分式のコマンドでは解除を適用しない',
    decision(res) === 'deny', JSON.stringify(res));

  // 解除が効く形まで巻き込んでいないことを確かめる。実行時要素を拒否側に倒す判定は、
  // 「何でも拒否」に膨らませると解除そのものが使えなくなる。
  res = shell('cat x.py');
  check('実行時要素を含まないコマンドは解除範囲のまま通す', decision(res) === null, JSON.stringify(res));

  res = shell('cd sub && cat x.py');
  check('移動先が静的な cd は解除範囲のまま通す', decision(res) === null, JSON.stringify(res));

  // パスのフィールドが決まっているツールでは、そのフィールドが操作対象そのもので、実行時要素の
  // 入りようがない(相対パスの基準は cwd だけ)。引数全体を見ると、書き込む「文面」に $VAR が
  // 入っているだけで解除が効かなくなり、解除した範囲のドキュメントにコマンド例を書けなくなる。
  res = runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: TOOL_A,
    tool_name: 'Write',
    tool_input: { file_path: `${TOOL_A}/note.md`, content: 'echo hi; cd $PARENT && ls' },
  });
  check('パスのフィールドを持つツールは文面の実行時要素で解除を失わない', decision(res) === null, JSON.stringify(res));
}

// --- 展開を打ち切ったブレースは判定不能として拒否する ---
//
// ツリー名がブレースで割れていると、判定材料は展開後の variant しかない(元の文字列には
// 連続したツリー名が現れない)。上限を超えて捨てた variant は誰も見ないので、選択肢を並べる
// だけで拒否そのものをすり抜けられていた。上限を上げても同じ手が使えるため、打ち切りは
// 「判定できなかった」として拒否側に倒す。
{
  const SID = 'session-brace-cap';
  const home = unlockedSandbox('unlock-brace-cap', TOOL_A, SID);
  const shell = (command) => runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: 'C:/claude/ClaudeCode',
    tool_name: 'Bash', tool_input: { command },
  });

  // 選択肢の数と入れ子の深さは、上限(BRACE_MAX_VARIANTS / BRACE_MAX_DEPTH)を実際に超える値で
  // 書く。上限を引き上げたときにここが上限の内側に収まると、展開しきった結果ツリー名が見つかって
  // 拒否されるだけになり、「打ち切りを拒否に倒す」ことを検証しないまま緑になる。
  const many = Array.from({ length: 300 }, (_, i) => `d${i}`).join(',');
  let res = shell(`cat C:/{${many},org-tree}/secret`);
  check('本数の上限を超えるブレースは拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = shell('cat C:/{a,{b,{c,{d,{e,{f,{g,{h,{i,org-tree}}}}}}}}}/secret');
  check('深さの上限を超えるブレースは拒否する', decision(res) === 'deny', JSON.stringify(res));

  // 打ち切りの印をツール名で絞ると、そこから漏れたツールがそのまま抜け道になる。コマンド
  // 文字列の中身を実行するのは別のシェルでありうる ―― PowerShell から bash を呼ぶ形も、
  // 知らないツール(MCP のシェル実行系)も同じで、Bash に同じものを渡せば拒否される内容が
  // 素通りしていた。
  const NESTED = 'cat C:/{a,{b,{c,{d,{e,{f,{g,{h,{i,org-tree}}}}}}}}}/secret';
  const asTool = (tool_name, tool_input) => runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: 'C:/claude/ClaudeCode',
    tool_name, tool_input,
  });
  res = asTool('PowerShell', { command: `bash -c "${NESTED}"` });
  check('PowerShell 越しの入れ子ブレースも拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = asTool('PowerShell', { command: `cat C:/{${many},org-tree}/secret` });
  check('PowerShell の本数超過も拒否する', decision(res) === 'deny', JSON.stringify(res));

  // 知らないツールは展開そのものをしていなかったので、2 択で割るだけで足りていた。
  res = asTool('mcp__shell__exec', { cmd: 'cat C:/{a,org-tree}/secret' });
  check('知らないツールのブレースも展開して拒否する', decision(res) === 'deny', JSON.stringify(res));

  // 判定できなかったときは、見出しも「判定できなかった」と言う。断定形のままだと、対象が
  // 本当にツリー配下にあると読めてしまい、書き方を変えれば通ることに気づけない。
  const undecidableReason = res?.hookSpecificOutput?.permissionDecisionReason ?? '';
  check('判定不能の拒否は見出しでも断定しない',
    /判定できないため拒否/.test(undecidableReason) && !/^\[account-guard\] C:\/org-tree は別アカウント専用/.test(undecidableReason),
    undecidableReason);

  // 逆に、配下だと確定した対象が 1 つでもあるなら判定不能とは言わない。判定不能の見出しは
  // 「書き方を直せば結論が変わりうる」と伝えるためのもので、直しても拒否が動かない場合に
  // 出すと通らない書き直しへ誘導する。`cp <tree>/a.txt{,.bak}` は展開後の両方が明確に配下
  // なのに、展開前のトークンが `{` で切り詰められているというだけで判定不能になっていた。
  res = shell('cp C:/org-tree/a.txt{,.bak}');
  const certainReason = res?.hookSpecificOutput?.permissionDecisionReason ?? '';
  check('配下と確定した対象があるなら判定不能とは言わない',
    decision(res) === 'deny' && !/判定できない/.test(certainReason), certainReason);

  // 上限の内側は従来どおり展開して判定する。打ち切りを拒否に倒したことで、ブレースを含む
  // 無関係なコマンドまで一律に拒否していないことを確かめる。
  res = shell('cat C:/{a,b}/x');
  check('上限の内側で無関係なブレースは通す', decision(res) === null, JSON.stringify(res));

  // 判定不能の印は保護ツリーの判定にだけ効かせる。印は trees の各要素を操作対象として偽造する
  // ので、解除の状態ファイル自身を trees に渡す判定(isUnlockStateWrite)にも流れると、それが
  // そのまま状態ファイルへの一致になり、保護ツリーと無関係なコマンドが「状態ファイルへの
  // 書き込み」として拒否される。保護ルールが空でも起きる誤拒否だった。
  // このサンドボックスは C:/org-tree を保護しているので、判定不能によるツリー側の拒否は正しい
  // 挙動。ここで確かめたいのは理由の取り違えで、「状態ファイルへの書き込み」として拒否されて
  // いないこと ―― そちらは保護ルールが空でも発火するので、誤拒否の影響範囲が桁違いに広い。
  res = shell('mkdir -p a/{x,y}/{1,2}/{p,q}/{r,s}/{t,u}/{v,w}/{2,3}/{4,5}');
  const braceReason = res?.hookSpecificOutput?.permissionDecisionReason ?? '';
  check('打ち切りを状態ファイルへの書き込みと取り違えない', !braceReason.includes('状態ファイル'), braceReason);

  // 上限は「ふつうに書く Bash が打ち切りに当たらない」ところまで上げてある。累積で数えるため
  // 2 択のグループ 4 個で頭打ちだった頃は、保護ツリーに一切触れないこの形が拒否されていた。
  res = shell('mkdir -p a/{x,y} b/{x,y} c/{x,y} d/{x,y} e/{x,y}');
  check('保護ツリーに触れない 5 グループのブレースは通す', decision(res) === null, JSON.stringify(res));

  // 上限が測っているのは「捨てた variant があるか」で、本数そのものではない。段の累積で数えて
  // 即座に打ち切っていた頃は、展開しきっていて捨てたものが無いのに拒否されていた ―― 3 択 5
  // グループ(累積 363)と 2 択 8 グループ(累積 510)がどちらも「判定できません」になり、
  // 2 択 7 グループ(累積 254)だけが通るという、上限をまたぐかどうかだけの差になっていた。
  res = shell('mkdir -p a/{x,y,z} b/{x,y,z} c/{x,y,z} d/{x,y,z} e/{x,y,z}');
  check('展開しきれる 3 択 5 グループは通す', decision(res) === null, JSON.stringify(res));

  res = shell('mkdir -p a/{x,y} b/{x,y} c/{x,y} d/{x,y} e/{x,y} f/{x,y} g/{x,y} h/{x,y}');
  check('展開しきれる 2 択 8 グループは通す', decision(res) === null, JSON.stringify(res));

  // ブレース展開をするのは Bash であって PowerShell ではない。PowerShell のハッシュテーブルや
  // パイプのスクリプトブロックは中身の形が展開されるブレースと見分けられない(どの選択肢にも
  // 引用符も空白も無い)ので、シェルの種類で落とさないと、保護ツリーと無関係なふつうの
  // コマンドが判定不能で拒否される。
  const ps = (command) => runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: 'C:/claude/ClaudeCode',
    tool_name: 'PowerShell', tool_input: { command },
  });
  res = ps('$a=@{x=1;y=2}; $b=@{p=1,2}; $c=@{q=3,4}; $d=@{r=5,6}; $e=@{s=7,8}; $f=@{t=9,10}');
  check('PowerShell のハッシュテーブルは打ち切りに数えない', decision(res) === null, JSON.stringify(res));
  res = ps('Get-Process | ? { $_.Id -gt 1, 2 } | % { $_.Name, $_.Id } | % { $_, 1 } | % { $_, 2 } | % { $_, 3 }');
  check('PowerShell のスクリプトブロックは打ち切りに数えない', decision(res) === null, JSON.stringify(res));

  // 引用符の中にもブレースを書くコマンドはふつうにある。数える対象から落とすのではなく、
  // 上限の内側で展開しきれる限りは通す(落とすと下のラッパーの穴が開く)。
  res = shell('node -e "const a={x:1,y:2}; const b={p:3,q:4}; const c={r:5,s:6}; const d={t:7,u:8}; const e={v:9,w:0};"');
  check('引用符の中のブレースも上限の内側なら通す', decision(res) === null, JSON.stringify(res));

  // 引用符の中でも、ラッパーに渡した文字列は内側のシェルが展開する。数える側から引用符の中を
  // 丸ごと落としていた頃は、展開する側(引用符を外してから展開する)との差がそのまま抜け道に
  // なっていた ―― `bash -c` の中で選択肢を並べて上限を超えさせると、打ち切りが無印のまま
  // 捨てられ、ツリー名を割ったまま拒否をすり抜けられた。引用符の外に同じものを書けば拒否
  // されるので、これも書き方だけで結論が変わる形だった。
  res = shell('bash -c "echo x{1,2}{1,2}{1,2}{1,2}{1,2}{1,2}{1,2}{1,2}{1,2} ; cat C:/{org-tre,other}e/secret"');
  // 拒否だけでは足りない。数え方を旧実装(引用符の外だけ)に戻しても、展開しきれた別の変種が
  // ツリーに当たって拒否されることがあり、それだと穴が開いたまま緑になる。「判定できなかった
  // から拒否した」という理由まで見て、打ち切りが印として残ったことを確かめる。
  check('ラッパーに渡した引用符の中の打ち切りも判定不能にする',
    decision(res) === 'deny' && /判定できないため拒否/.test(reasonOf(res)), JSON.stringify(res));

  // 引用符の中を数えるようにした代わりに、シェルが展開しない形を中身で見分ける
  // (DATA_ALTERNATIVE)。どちらのケースも上限を実際に超える深さで書く ―― 見分けを外すと
  // 打ち切りに達して拒否されることを確認済みで、上限の内側に収まる浅さだと、見分けが
  // 壊れても緑のままになる。
  res = shell(`curl -d '{"a": {"b": {"c": {"d": {"e": {"f": {"g": {"h": 1,"i": 2},"j": 3},"k": 4},"l": 5},"m": 6},"n": 7},"o": 8},"p": 9}' http://x`);
  check('引用符の中の JSON は打ち切りに数えない', decision(res) === null, JSON.stringify(res));

  res = shell(`jq '{z: {a: {b: {c: {d: {e: {f: {g: {h: .x, i: .y}, j: 1}, k: 2}, l: 3}, m: 4}, n: 5}, o: 6}, p: 7}' x.json`);
  check('引用符の中の jq フィルタは打ち切りに数えない', decision(res) === null, JSON.stringify(res));

  // 空白を詰めた JSON。見分けの条件は引用符と空白の 2 つだが、展開を引用符除去のあとに
  // 行っていた頃は引用符が先に消えており、空白しか効いていなかった ―― 上の JSON から
  // 空白を抜いただけで判定不能の拒否に変わり、書き方だけで結論が変わっていた。
  res = shell(`curl -d '{"a":{"b":{"c":{"d":{"e":{"f":{"g":{"h":1,"i":2},"j":3},"k":4},"l":5},"m":6},"n":7},"o":8},"p":9}' http://x`);
  check('空白を詰めた JSON も打ち切りに数えない', decision(res) === null, JSON.stringify(res));
}

// --- 裸のツリー名は区切りを伴わない形だけを拾う ---
//
// 区切り付きの形は相対パスとして正しい深さで拾われている。そこへ重ねてツリールートまで
// 積むと、配下を解除していても相対形だけが拒否される(絶対パスなら通るのに、という食い違い)。
{
  const SID = 'session-bare';
  const home = unlockedSandbox('unlock-bare', TOOL_A, SID);
  const shell = (command) => runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: 'C:/',
    tool_name: 'Bash', tool_input: { command },
  });

  let res = shell('cd org-tree/tool-a && ls');
  check('親から解除範囲へ相対で降りる形は通す', decision(res) === null, JSON.stringify(res));

  res = shell('cd org-tree && ls');
  check('親からツリールートへ降りる裸の名前は拒否する', decision(res) === 'deny', JSON.stringify(res));
}

// --- 解除の状態ファイルへの書き込み ---
{
  const SID = 'session-state-write';
  const home = unlockedSandbox('unlock-state-write', TOOL_A, SID);
  const dir = path.join(home, '.claude', 'account-guard').replace(/\\/g, '/');
  const shell = (command) => runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: 'C:/claude/ClaudeCode',
    tool_name: 'Bash', tool_input: { command },
  });

  let res = shell(`echo {} > ${dir}/unlocks.json`);
  check('状態ファイルへの書き込みは拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = shell(`echo {} > ${dir}/"unlocks.json"`);
  check('引用符で割った状態ファイルへの書き込みも拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = shell(`echo {} > ${dir}/unlocks{.json,}`);
  check('ブレース展開で作る状態ファイル名も拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = shell('ls C:/{a,b}');
  check('無関係なブレース展開まで状態ファイル扱いしない', decision(res) === null, JSON.stringify(res));

  // 裸名での書き込みは cd の移動先で解決して初めて状態ファイルに届く。区切りが `&&` か
  // 改行かで結論が変わってはいけない(cd の基準積みと同じ穴)。
  res = shell(`cd ${dir} && echo {} > unlocks.json`);
  check('移動してからの裸名の書き込みも拒否する', decision(res) === 'deny', JSON.stringify(res));

  res = shell(`cd ${dir}\necho {} > unlocks.json`);
  check('改行で移動してからの裸名の書き込みも拒否する', decision(res) === 'deny', JSON.stringify(res));
}

// --- 解除コマンドの遮断は Bash / PowerShell 以外にも効く ---
{
  const SID = 'session-unknown-tool';
  const home = unlockedSandbox('unlock-unknown-tool', TOOL_A, SID);

  let res = runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: 'C:/claude/ClaudeCode',
    tool_name: 'mcp__shell__exec', tool_input: { cmd: 'guard unlock "理由"' },
  });
  check('知らないツール経由の解除も拒否する', decision(res) === 'deny', JSON.stringify(res));
  check('拒否の理由が解除の遮断であること', /解除/.test(reasonOf(res)), reasonOf(res));

  res = runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: 'C:/claude/ClaudeCode',
    tool_name: 'Read', tool_input: { file_path: 'C:/notes/guard unlock.md' },
  });
  check('パスのフィールドしか持たないツールは解除試行と見なさない',
    decision(res) === null, JSON.stringify(res));
}

// --- セッション ID はフック入力を優先する ---
//
// 環境変数に別セッションの値が残っている環境で、両方を候補にすると解除が漏れる。
{
  const SID = 'session-hook-priority';
  const home = unlockedSandbox('unlock-session-priority', TOOL_A, SID);
  const env = homeEnv(home);
  env.CLAUDE_CODE_SESSION_ID = SID;
  const res = toResult(execGuardScript(GUARD, {
    env,
    input: {
      hook_event_name: 'PreToolUse', session_id: 'another-session', cwd: TOOL_A,
      tool_name: 'Read', tool_input: { file_path: 'x.py' },
    },
  }));
  check('フック入力のセッションが違えば、環境変数が一致していても解除は効かない',
    decision(res) === 'deny', JSON.stringify(res));
}

// --- 状態ファイルの読み書きは直列化する ---
{
  const SID = 'session-lock';
  const home = sandbox('unlock-lock', { subscriptionType: 'pro', rules: ORG });
  const lock = path.join(home, '.claude', 'account-guard', 'unlocks.lock');
  fs.writeFileSync(lock, '', 'utf8');

  const failed = guardCliFail(home, ['unlock', '--path', TOOL_A, 'テスト用の解除'], SID);
  check('ロックが生きている間は解除を失敗させる',
    failed !== null && /進行中/.test(failed.stderr), JSON.stringify(failed));
  check('失敗した解除は状態ファイルを作らない', !fs.existsSync(unlocksFile(home)), '');

  // 取り残されたロックは奪う。奪えないと、強制終了のたびに以後ずっと解除できなくなる。
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lock, old, old);
  const out = String(guardCli(home, ['unlock', '--path', TOOL_A, 'テスト用の解除'], SID) || '');
  check('古いロックは奪って解除できる', /解除しました/.test(out), out);
  check('奪ったロックは処理の後に消える', !fs.existsSync(lock), '');
}

// --- ロックを取得できないときの案内 ---
//
// ロックの取得はまだ状態ファイルに触れる前の段階。ここで「状態ファイルを直すか削除して
// ください」と案内すると、従った人は他セッションの解除まで消すことになる(この設計が
// 避けたかった結末そのもの)。ロックの場所をディレクトリで塞いで再現する ―― 奪おうとしても
// 消せず、取り直しも失敗する。
{
  const SID = 'session-lock-fail';
  const home = sandbox('unlock-lock-fail', { subscriptionType: 'pro', rules: ORG });
  const lock = path.join(home, '.claude', 'account-guard', 'unlocks.lock');
  fs.mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lock, old, old);

  const failed = guardCliFail(home, ['unlock', '--path', TOOL_A, 'テスト用の解除'], SID);
  check('ロックを取得できなければ解除を失敗させる',
    failed !== null && /ロックを取得できません/.test(failed.stderr), JSON.stringify(failed));
  check('ロックの失敗で状態ファイルの修復や削除を勧めない',
    failed !== null && !/直すか削除/.test(failed.stderr), JSON.stringify(failed));
}

// --- 基準の打ち切り(MAX_BASES)---
// 判定が遅くなりすぎると、フックの timeout(hooks-snippet.json は 5 秒)でプロセスが kill され、
// 返すはずだった deny が届かない。「重ねるほど遅くなる」はそのまま「重ねれば保護を外せる」を
// 意味する。上限を外すと実測 20 秒に戻り、ここで落ちる。
{
  const home = sandbox('bases-limit', { subscriptionType: 'pro', rules: ORG });
  const cds = Array.from({ length: 8 }, (_, i) => `cd d${i}/{a,b}`).join(' && ');
  const tail = Array.from({ length: 20 }, (_, i) => `f${i}/g${i}/h${i}`).join(' ');
  const shell = (command) => run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
    tool_input: { command },
  });

  const t0 = Date.now();
  const res = shell(`${cds} && cat ${TOOL_B}/secret ${tail}`);
  const ms = Date.now() - t0;
  check('基準が指数的に増える形でも拒否する', decision(res) === 'deny', JSON.stringify(res));
  // 実測 0.9 秒。フックの timeout 自体が 5 秒なので、そこを閾値にする(5 倍の余裕がある)。
  check(`基準が指数的に増える形でも 5 秒以内に判定する(実測 ${ms}ms)`, ms < 5000, `${ms}ms`);

  // 上限は 1 つの因子(基準の数・展開版の本数)しか抑えないので、掛け合わせは上限の中でも
  // 伸びる。トークンを 20 個しか並べない上の形では気づけず、実測で「cd 31 段 + ブレース 8 組
  // + トークン 200 個」が 5.9 秒かかって timeout で kill されていた ―― 拒否が届かないので
  // 保護が外れるのと同じ。展開版をまたいでトークンを一意にしてから基準を掛ける形に直すと
  // 0.5 秒になる。掛け算のまま上限だけ足す直し方に戻すと、ここで落ちる。
  const manyCds = Array.from({ length: 31 }, (_, i) => `cd d${i}`).join(' && ');
  const manyBraces = Array.from({ length: 8 }, (_, i) => `g${i}/{aa,bb}`).join(' ');
  const manyTokens = Array.from({ length: 200 }, (_, i) => `s${i}/f${i}.js`).join(' ');
  const t1 = Date.now();
  shell(`${manyCds} && ls ${manyBraces} ${manyTokens}`);
  const ms1 = Date.now() - t1;
  check(`基準・展開版・トークンが同時に多くても 5 秒以内に判定する(実測 ${ms1}ms)`, ms1 < 5000, `${ms1}ms`);

  // 打ち切ったときは「判定できなかった」として拒否する。ツリーに一度も触れないコマンドまで
  // 拒否側に落ちるのは承知のうえ ―― 見ていない基準で解決すれば配下を指しうる。
  const res2 = shell(`${cds} && cat x`);
  check('基準を打ち切ったら判定不能として拒否する', decision(res2) === 'deny', JSON.stringify(res2));
  // ブレースを含まない形で打ち切ったときに「ブレース展開が…」と出すと、直す先を探して
  // 見つからない。打ち切りの種別ごとに文面を分けてあることを固定する。
  check('打ち切りの理由をブレース展開と混同しない',
    /基準を数え切れない/.test(reasonOf(res2)) && !/ブレース/.test(reasonOf(res2)), reasonOf(res2));
}

// --- ガードディレクトリ配下への書き込み ---
// 守る対象をファイル名で列挙していた頃は、列挙に無いファイルがそのまま穴だった。とくに
// config.json は保護ルールそのもので、消せば解除するまでもなく保護が丸ごと消える。
{
  const home = sandbox('guard-dir-write', { subscriptionType: 'pro', rules: ORG });
  const guardFile = (f) => path.join(home, '.claude', 'account-guard', f);
  const write = (file) => run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Write',
    tool_input: { file_path: file, content: 'x' },
  });

  for (const f of ['config.json', 'unlocks.json', 'unlock.log', 'unlocks.lock', 'unlocks.json.tmp']) {
    check(`ガードディレクトリ配下の ${f} への書き込みを拒否する`,
      decision(write(guardFile(f))) === 'deny', f);
  }
  check('保護ルールを書き換えようとしたと分かる文面を出す',
    /config\.json は保護ルール/.test(reasonOf(write(guardFile('config.json')))),
    reasonOf(write(guardFile('config.json'))));

  // 前方一致だけで見ると、名前が接頭辞になっている別ディレクトリまで巻き込む。
  const sibling = write(path.join(home, '.claude', 'account-guard-old', 'x.json'));
  check('名前が前方一致する別ディレクトリは巻き込まない', sibling === null, JSON.stringify(sibling));

  // 中身を確かめる道は残す(読み取り専用と分かっているツールは素通し)。
  const read = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Read',
    tool_input: { file_path: guardFile('config.json') },
  });
  check('ガードディレクトリ配下の読み取りは通す', read === null, JSON.stringify(read));
}

// --- 保護ルールが無いインストール ---
// README は「設定していない状態では何も拒否しない」と約束している。解除に関わる操作の遮断を
// 無条件にしていた頃は、ルール未設定の環境でもこのリポジトリ自身への操作が拒否されていた。
{
  const home = sandbox('no-rules-unlock-block', { subscriptionType: 'pro', rawRules: '{ "rules": [] }' });
  const res = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Bash',
    tool_input: { command: 'git commit -m "fix: guard unlock の判定"' },
  });
  check('保護ルールが無ければ解除コマンドに見える文字列も拒否しない', res === null, JSON.stringify(res));

  const write = run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/claude/ClaudeCode', tool_name: 'Write',
    tool_input: { file_path: path.join(home, '.claude', 'account-guard', 'config.json'), content: '{}' },
  });
  check('保護ルールが無ければガードディレクトリへの書き込みも拒否しない', write === null, JSON.stringify(write));
}

// --- 解除中に拒否するときの見出し ---
// 範囲内しか触らないのに切り詰めで拒否するとき、断定形の見出しを出すと「書き方を直せば通る」に
// 気づけない(`mkdir -p a/x a/y` と書けば通る)。
{
  const SID = 'session-certain-hit';
  const home = unlockedSandbox('unlock-certain-hit', TOOL_A, SID);
  const res = runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: TOOL_A,
    tool_name: 'Bash', tool_input: { command: 'mkdir -p a/{x,y}' },
  });
  check('解除範囲内しか触らないなら判定不能として拒否する',
    decision(res) === 'deny' && /判定できません/.test(reasonOf(res)), reasonOf(res));
  check('解除でカバー済みの対象を配下だと断定しない', !/配下です/.test(reasonOf(res)), reasonOf(res));
}

// --- 実行時要素の数え方 ---
// 裸の丸括弧を数えるのは PowerShell だけ。全ツールで数えていた頃は、解除中に
// `python -c "print(1)"` や丸括弧を含む委譲の指示文まで拒否され、一時解除の用途そのものが
// 成立しなかった。
{
  const SID = 'session-runtime-paren';
  const home = unlockedSandbox('unlock-runtime-paren', TOOL_A, SID);
  const call = (tool, toolInput) => runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: TOOL_A,
    tool_name: tool, tool_input: toolInput,
  });

  // 解除が効いた回は additionalContext が返るので、レスポンス自体は null にならない。
  // 見るのは permissionDecision。
  const paren = call('Bash', { command: 'python -c "print(1)"' });
  check('Bash の丸括弧は実行時要素として数えない', decision(paren) === null, JSON.stringify(paren));
  const taskParen = call('Task', { prompt: 'このディレクトリの内容をまとめて(簡潔に)', description: 'まとめ' });
  check('委譲の指示文の丸括弧も数えない', decision(taskParen) === null, JSON.stringify(taskParen));
  check('PowerShell の丸括弧は実行時要素として数える',
    decision(call('PowerShell', { command: 'Get-Content (Get-Item .).FullName' })) === 'deny', 'pwsh paren');

  const varRes = call('Bash', { command: 'echo $PATH' });
  check('変数参照は実行時要素として数える', decision(varRes) === 'deny', reasonOf(varRes));
  // 「パスを字面で書き直すと通ります」だけでは、書き直す対象が無いコマンドで行き止まりになる。
  check('パスを含まないコマンドには ! で打つ道を案内する',
    /`!` を付けて自分で実行/.test(reasonOf(varRes)), reasonOf(varRes));
}

// --- Glob / Grep のパターン ---
// パターンはツール自身が展開してから探すので、字面のパスとして突き合わせるだけでは足りない。
// 展開を見ていなかった頃は、ツリー名をブレースで割る形とワイルドカードで伏せる形が素通りし、
// 保護ツリーの列挙(Glob)と中身の読み出し(Grep)ができていた ―― 同じ場所をリテラルで
// 書けば拒否されるので、書き方だけで結論が変わっていた。
{
  const home = sandbox('glob-pattern', { subscriptionType: 'pro', rules: ORG });
  const call = (tool, toolInput) => run(home, {
    hook_event_name: 'PreToolUse', cwd: 'C:/work/proj', tool_name: tool, tool_input: toolInput,
  });

  check('Glob のパターンでツリー名を割った形を拒否する',
    decision(call('Glob', { pattern: 'C:/{org-tree,other}/**' })) === 'deny', 'glob brace');
  check('Grep のパターンでツリー名を割った形を拒否する',
    decision(call('Grep', { glob: 'C:/{org-tree,other}/**' })) === 'deny', 'grep brace');
  check('ワイルドカードでツリー名を伏せた形を拒否する',
    decision(call('Glob', { pattern: 'C:/org*/**' })) === 'deny', 'glob star');
  check('1 文字ワイルドカードでも拒否する',
    decision(call('Glob', { pattern: 'C:/org-tre?/**' })) === 'deny', 'glob question');
  // メタ文字を含むパターンだけを見る実装にすると、ブレースもワイルドカードも無いリテラルの
  // パターンが対象を 1 つも作らずに素通りする(実装中に一度これを踏んだ)。
  check('リテラルのパターンは従来どおり拒否する',
    decision(call('Glob', { pattern: 'C:/org-tree/**' })) === 'deny', 'glob literal');
  // 届きようのないパターンまで拒否すると日常の邪魔になる。
  check('保護ツリーに届かないパターンは通す',
    call('Glob', { pattern: 'C:/claude/**' }) === null, 'glob unrelated');
  check('保護ツリーに届かない再帰パターンも通す',
    call('Glob', { pattern: '**/*.js' }) === null, 'glob recursive');

  // file_path 系は展開しない(その名前のファイルを直接開く)。届きようのない書き方なので、
  // ここまで拒否側に倒すと誤拒否が増えるだけ。
  check('展開しないフィールドのブレースは対象にしない',
    call('Read', { file_path: 'C:/{org-tree,other}/secret' }) === null, 'read brace');
}

// --- コマンド文字列のグロブ ---
// 上の到達判定を Glob / Grep のフィールドにしか持っていなかった頃、同じ形をコマンド文字列に
// 書くと素通りしていた ―― `Glob{pattern:"C:/org*/**"}` は拒否されるのに `Bash{ls C:/org*/}` は
// 通る、という経路だけで結論が変わる状態で、シェルは展開後に列挙も読み出しもできた。
// 塞ぐ側を経路(PATH_FIELDS の枝)で絞る形は、このファイルが繰り返し避けてきた失敗。
{
  const home = sandbox('command-glob', { subscriptionType: 'pro', rules: ORG });
  const call = (tool, toolInput, cwd = 'C:/work/proj') => run(home, {
    hook_event_name: 'PreToolUse', cwd, tool_name: tool, tool_input: toolInput,
  });

  check('Bash のワイルドカードでツリーを列挙する形を拒否する',
    decision(call('Bash', { command: 'ls C:/org*/' })) === 'deny', 'bash star');
  check('Bash のワイルドカードで中身を読む形を拒否する',
    decision(call('Bash', { command: 'cat C:/org*/secret.txt' })) === 'deny', 'bash star read');
  check('Bash の ? で伏せる形を拒否する',
    decision(call('Bash', { command: 'cat C:/org-tre?/secret.txt' })) === 'deny', 'bash question');
  // `[` はトークンの終わりなので、切り出した時点ではメタ文字がトークンに残らない。
  // 切れた文字を戻してから届き先を見ないと、ブラケットで伏せた形だけがすり抜ける。
  check('Bash のブラケットで伏せる形を拒否する',
    decision(call('Bash', { command: 'cat C:/org[-]tree/secret.txt' })) === 'deny', 'bash bracket');
  check('Git Bash 形式のワイルドカードも拒否する',
    decision(call('Bash', { command: 'cat /c/org*/secret.txt' })) === 'deny', 'msys star');
  check('PowerShell のワイルドカードを拒否する',
    decision(call('PowerShell', { command: 'Get-ChildItem C:/org*/' })) === 'deny', 'pwsh star');
  check('知らないツールのワイルドカードを拒否する',
    decision(call('mcp__fs__list', { path: 'C:/org*/' })) === 'deny', 'mcp star');
  check('委譲の指示文のワイルドカードを拒否する',
    decision(call('Agent', { prompt: 'C:/org*/ の中身を要約して', description: 'x' })) === 'deny', 'agent star');

  // 起点がツリーの祖先というだけで積むと、ドライブ直下のツリーの祖先は `C:/` なので、
  // 無関係なワイルドカードが軒並み拒否される。メタ文字より前の字面がツリー名の先頭に
  // なっていない形は「届きようがない」と言い切れるので通す。
  check('先頭が一致しないワイルドカードは通す',
    call('Bash', { command: 'ls C:/claude*/' }) === null, 'unrelated star');
  check('cwd 配下のワイルドカードは通す',
    call('Bash', { command: 'ls src/*.js' }) === null, 'relative star');
  check('区切りを含まないワイルドカードは通す',
    call('Bash', { command: 'grep -rn foo *.js' }) === null, 'bare star');
  // 同じ絞り込みが Glob 側にも効く(判定は 1 か所なので、片方だけ緩むことがない)。
  check('Glob でも先頭が一致しないワイルドカードは通す',
    call('Glob', { pattern: 'C:/claude*/**' }) === null, 'glob unrelated star');
  // cwd がツリーの親なら、1 つ目の成分を伏せた相対形でもツリーに届く。絶対形で書けば
  // 拒否されるので、ここを拾えないと書き方だけで結論が変わる。
  check('cwd がツリーの親なら相対のワイルドカードを拒否する',
    decision(call('Bash', { command: 'ls org*/' }, 'C:/')) === 'deny', 'parent cwd star');
  check('先頭が一致しない相対のワイルドカードは通す',
    call('Bash', { command: 'ls other*/' }, 'C:/') === null, 'parent cwd unrelated star');

  // `..` を追えないのはメタ文字を挟んだ側だけ。メタ文字より前の `..` は解決で畳めるので、
  // ここまで拒否側に倒すと、ごく普通の相対指定が軒並み通らなくなる。
  check('メタ文字を挟んで登る形は拒否する',
    decision(call('Bash', { command: 'cat */../org-tree/s' })) === 'deny', 'star parent shell');
  check('メタ文字より前の .. は通す',
    call('Bash', { command: 'cat ../src/*.js' }) === null, 'parent then star');
}

// --- 解除中の Glob / Grep ---
{
  const SID = 'session-glob-escape';
  const home = unlockedSandbox('unlock-glob-escape', TOOL_A, SID);
  const call = (tool, toolInput) => runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: TOOL_A,
    tool_name: tool, tool_input: toolInput,
  });

  check('解除範囲の外を直接指すパターンは拒否する',
    decision(call('Glob', { path: TOOL_A, pattern: '../tool-b/**' })) === 'deny', 'direct');
  check('ブレースで割って解除範囲の外へ出る形を拒否する',
    decision(call('Glob', { path: TOOL_A, pattern: '{../tool-b,x}/**' })) === 'deny', 'brace escape');
  check('Grep でも同じ形を拒否する',
    decision(call('Grep', { path: TOOL_A, glob: '{../tool-b,x}/*' })) === 'deny', 'grep escape');
  // path.resolve は `..` の直前の成分を畳むので、`*` ごと消えて残りが範囲内に解決される。
  // メタ文字と `..` の組み合わせは追えないものとして拒否する。
  check('メタ文字を挟んで登る形を拒否する',
    decision(call('Glob', { path: TOOL_A, pattern: '*/../tool-b/**' })) === 'deny', 'star parent');

  // 解除の正常系を巻き込んでいないこと。ここが拒否になると解除中に Glob が一切使えない。
  check('解除範囲内の再帰パターンは通す',
    decision(call('Glob', { path: TOOL_A, pattern: '**/*.py' })) === null, 'recursive inside');
  check('解除範囲内のリテラルパターンは通す',
    decision(call('Glob', { path: TOOL_A, pattern: 'src/*.py' })) === null, 'literal inside');
}

// --- 委譲の指示文と実行時要素 ---
// 自然文に現れる `$` やバッククォートは実行される置換ではない。全ツールで数えていた頃は、
// マークダウンのコードスパンを 1 つ書いただけで解除が消えていた。委譲先は別セッションなので
// 解除を継承せず、そこで改めて保護が効く。
{
  const SID = 'session-prose-runtime';
  const home = unlockedSandbox('unlock-prose-runtime', TOOL_A, SID);
  const call = (tool, toolInput) => runInSession(home, {
    hook_event_name: 'PreToolUse', session_id: SID, cwd: TOOL_A,
    tool_name: tool, tool_input: toolInput,
  });

  check('委譲の指示文のコードスパンは実行時要素として数えない',
    decision(call('Task', { prompt: `${TOOL_A} の \`foo\` を直して`, description: '修正' })) === null,
    'task backtick');
  check('委譲の指示文の $ も数えない',
    decision(call('Agent', { prompt: '$HOME の話は関係ない。ここの x.py を直して', description: '修正' })) === null,
    'agent dollar');
  // シェルのコマンド文字列では従来どおり数える(ここを緩めると解除の範囲が実行時の値で決まる)。
  check('シェルでは従来どおり数える',
    decision(call('Bash', { command: 'cat `pwd`/secret' })) === 'deny', 'bash backtick');
}

report();
