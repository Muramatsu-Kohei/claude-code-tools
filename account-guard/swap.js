#!/usr/bin/env node
// Claude Code のログインアカウントを credentials ファイルの入れ替えで切り替える(方式A)。
//
// なぜファイルの入れ替えなのか: `/login` はブラウザ OAuth を毎回踏む必要があるうえ、
// 切り替えで変わるのは ~/.claude/.credentials.json の 1 本だけで、CLAUDE.md・memory・
// skills・履歴・worklog・usage-tracker はすべて共有されたままだから。
// 詳細と方式Bとの比較は docs/account-separation.md の §6.1 を参照。
//
// 重要: 認証の入れ替えはマシン全体に即座に効き、並行して動いている別セッションも巻き込む
// (§1.3)。したがってタイマーやフックから自動実行してはならない。人が意図して叩くこと。
//
// == アカウントの同一性は「証明できたこと」だけで判断する ==
// credentials には uuid やメールアドレスのような identity フィールドが無い
// (credentials.js のコメント参照)。使える材料は 3 つあり、証明できる範囲が違う。
//   1. refreshToken の一致 … 「同じ資格情報」の証明(強い)。ローテートすると使えなくなる
//   2. subscriptionType の不一致 … 「同じアカウントの同じ世代ではない」まで(中くらい)。
//      別アカウントの証明ではない: 同じアカウントがプランを変えると(Pro → Max)、変更前に
//      退避したスロットとは種別が食い違う。一致のほうは何も証明しない。一致を
//      「同じアカウント」と読んだのが以前の誤りで、同一プランの別アカウントを取り違えて
//      相手の唯一のバックアップを消していた
//   3. .current(来歴) … 「前回このツールが書いた先」の記録(弱い)。外から /login されたり、
//      書き込みが途中で落ちたりすると古くなるので、単独では上書きの根拠にしない
// どれでも決着しない組み合わせ(同一プランの別アカウント同士)は原理的に残る。そこは
// 判断で守らず構造で守る: 既存の退避を上書きするときは、1 の証明が無い限り旧内容を
// accounts/.replaced/ へ退けてから書く。スロットへの書き込みを writeSlot 1 箇所に集約して
// あるので、--force も、壊れた credentials の経路も例外なくこの順を通る。控えの本数制限も
// 同じ理由で、「他にも複製が残っている」と言えるものしか落とさない(言えなければ上限を
// 超えたまま残す)。したがって「唯一のバックアップが消える」は起こらない
// (復旧はファイルの改名で済む)。
// そのうえで、1 回の退避で書き換えるスロットは名前で指定された 1 つだけに限る。以前は
// 「同じ内容だった別名スロット」も揃えて更新していたが、旧内容と現在のログインが同じ
// アカウントかは 1 の証明が無ければ言えず、来歴(3)を根拠にすると同一プランの別アカウントを
// 取り違えて、ユーザーが名前を挙げてもいないスロットまで巻き添えで潰す。古くなりうる
// スロットは書き換えずに名前を挙げて知らせる(staleSlots)。
//
// --force は 1 つの旗だが、意味する判断は 2 つある(混ぜると片方の都合でもう片方が外れる)。
//   swap <name> --force      … 復元側。失効済み・判別不能・同一プランでも復元へ進む。
//                              退避先に別のアカウントが入っていれば、それでも中止する
//   swap save <name> --force … 退避側。そのスロットを上書きしてよいという明示
//
// このツールで最も高い代償を払う失敗は、退避されていない資格情報を失うこと(ブラウザ
// OAuth のやり直しになる)。判断に迷う場面では、切り替えを諦めて現状を保つ方に倒す。
// ただし「止まるだけで抜け出せない」状態も作らない。中止するときは必ず、実際に効く
// 次の一手を添える(できるだけ、何も壊さずに済む手を先に示す)。

const fs = require('fs');
const path = require('path');
// credentials の場所と読み方は account-guard.js と共有する(credentials.js のコメント参照)。
// require を素通しにすると、隣に置き忘れた構成で生の MODULE_NOT_FOUND だけが出て真因に
// たどり着けない(swap.cmd のパスを書き換えて swap.js だけ移すのは README が案内する配置)。
// ガード側と違って swap は credentials の読み方を知らないまま動けないので、ここで止める。
let credentials;
try {
  credentials = require('./credentials');
} catch (e) {
  // HOME_UNRESOLVED は credentials.js を読み込めた(=置き場所は合っている)うえで、
  // USERPROFILE / HOME / os.homedir() のどれも使える値を返さない環境そのものが原因。
  // 下の「隣に置き忘れた」診断のまま案内すると、既に隣にある正しいファイルをコピーし直せと
  // 効かない指示を繰り返させる(account-guard.js の homeUnresolvedMessage() と同じ原因なので、
  // 案内する対処もそちらに合わせる)。
  if (e.code === 'HOME_UNRESOLVED') {
    fail('ホームディレクトリを特定できないため、退避先の場所を決められません'
      + '\n  USERPROFILE / HOME のいずれも使える値を持たず、os.homedir() も空を返しています'
      + '\n  ここで相対パスに逃げると、本物の退避は別の場所にあるのに「退避なし」に見えてしまうため中止しました'
      + '\n  USERPROFILE または HOME に実在するホームディレクトリを設定してから、もう一度実行してください');
  }
  fail('swap.js の隣にある credentials.js を読み込めません'
    + '\n  (' + path.join(__dirname, 'credentials.js') + ': ' + (e.code || e.message) + ')'
    + '\n  swap.js を別の場所へ移した場合は、credentials.js も同じディレクトリへ置いてください');
}
// require が成功しても中身までは保証されない。無関係な・古い credentials.js が隣にあると
// require 自体は成功するが HOME 等が期待する形でないことがあり、素通しで分割代入すると
// この先の path.join(HOME, ...) がここより下の try/catch より前で TypeError を投げ、
// 上のような案内が出ないまま生のスタックトレースだけで終わる(account-guard.js の
// 同種チェックと同じ理由)。必要なエクスポートの形を検証し、欠けていれば「読み込めなかった」
// 場合と同じ fail() 経路に合流させる。
if (
  !credentials
  || typeof credentials.HOME !== 'string' || !credentials.HOME.trim()
  || typeof credentials.CREDENTIALS !== 'string' || !credentials.CREDENTIALS
  || typeof credentials.readCredentials !== 'function'
  || typeof credentials.subscriptionTypeOf !== 'function'
  || typeof credentials.hasUsableCredentials !== 'function'
) {
  fail('swap.js の隣にある credentials.js の形式が想定と違います'
    + '\n  (' + path.join(__dirname, 'credentials.js') + ')'
    + '\n  HOME / CREDENTIALS / readCredentials / subscriptionTypeOf / hasUsableCredentials のいずれかが'
    + '欠けているか、期待する型ではありません'
    + '\n  swap.js と対応する版の credentials.js を同じディレクトリへ置き直してください');
}
const { HOME, CREDENTIALS, readCredentials, subscriptionTypeOf, hasUsableCredentials } = credentials;

// 退避先を ~/.claude 配下に置くのは、元の credentials と同じ ACL を継承させるため。
// 平文トークンの本数は増えるが、保護レベルは変わらない(§6.1 の「残るリスク」)。
const ACCOUNTS_DIR = path.join(HOME, '.claude', 'accounts');
// 現在のログインの来歴。スロットではないので、一覧が拾う `*.json` に当たらない名前にする。
const CURRENT_FILE = path.join(ACCOUNTS_DIR, '.current');
// 上書きで失われるはずだった旧内容の置き場。ここに控えがあるので、取り違えて上書きしても
// 復旧はファイルを戻すだけで済む。同じ理由で、スロット一覧には出さない(復元先ではない)。
const REPLACED_DIR = path.join(ACCOUNTS_DIR, '.replaced');
// 控えは平文トークンなので無制限には残さない。1 本だと「間違えた上書きを 2 回続けた」ときに
// 元が消えるので 2 本。ただしこれは上限であって保証ではない: 落とせるのは失効済み(復旧しても
// /login のやり直しになる)か、同じ資格情報が他にも残っていると言えるものだけで、どちらでもない
// 控えは上限を超えても残す(pruneReplaced)。読み取りに失敗したものも「復旧に使えない」とは
// 言えない(一過性の要因もありうる)ので、証明できるものが尽きたら上限を超えても残す側に倒す。
// 本数を守るために唯一の 1 本を消しては本末転倒。
const REPLACED_KEEP = 2;
// 読めない credentials の控えに使う名前。スロット名と同じ空間に置くと、退避として
// 復元候補に見えてしまう(中身は復元に使えない)。先頭の `.` は NAME_RE が通さない文字
// なので、`swap save unreadable-current` のようなスロット名とは決して衝突しない
// (衝突すると、有効な退避の控えが「復元に使えないので消して構いません」と案内され、
//  さらに控えの本数制限を読めない控えと共有して先に消される)。
const UNREADABLE_BASE = '.unreadable-current';

// アカウント名はそのままファイル名になるので、パス区切りや相対参照を弾く
const NAME_RE = /^[a-zA-Z0-9_-]+$/;
// サブコマンドと同じ名前のスロットは作らせない。main() は第一引数を必ずサブコマンドとして
// 読むので、`accounts/save.json` を作れてしまうと `swap save` は復元ではなく退避に走り、
// そのスロットを復元する引数の形が存在しなくなる(手でファイルを動かすしかない行き止まり)。
// main() が実際にサブコマンドとして横取りする名前。この名前のスロットは既に復元できない。
const DISPATCHED_NAMES = new Set(['save', 'help', '-h', '--help']);
// warmup はまだ実装していないが、docs/account-separation.md §6.3 で仕様確定済みの
// サブコマンド(両アカウントの窓を開ける)。実装前にスロット名として取られると、実装した
// 瞬間に `swap warmup` がそのスロットの復元ではなくサブコマンドとして解釈され、復元する
// 引数の形が失われる(save で実際に起きたのと同じ袋小路)。予約は 1 語ぶんの自由と引き換えに
// それを塞ぐので、実装を待たずにここへ入れておく。
// ただし「新しく作らせない」ことと「既にあるスロットを復元できない」ことは別。予約しただけの
// 名前は main() が横取りしないので、今は `swap warmup` で普通に復元できる。両者を同じ集合で
// 判定していたため、status が復元できるスロットを「復元できません」と警告し、不要な改名や、
// より危険な /login のやり直しへ誘導していた。実装するときはこの名前を上へ移すだけでよい。
const RESERVED_ONLY_NAMES = new Set(['warmup']);
const RESERVED_NAMES = new Set([...DISPATCHED_NAMES, ...RESERVED_ONLY_NAMES]);
const DAY_MS = 86400000;

// fail は「戻らない」前提で各所から呼ばれているので、exitCode を立てて return する形には
// できない(呼び出し元がそのまま先へ進んでしまう)。そのぶん出力側で取りこぼしを防ぐ:
// Windows では出力先がパイプ(`swap team 2>&1 | tee log` など)だと書き込みが非同期になり、
// console.error の直後に process.exit すると理由の文面が途中で切れて届かない。fs.writeSync は
// 書き終わってから戻るので、直後に exit しても最後まで残る。
function fail(msg) {
  const line = 'エラー: ' + msg + '\n';
  try {
    fs.writeSync(2, line);
  } catch {
    // fd が非ブロッキングで EAGAIN になる等、writeSync が使えない環境では従来どおりに出す
    // (切れる可能性は残るが、何も出ないよりはよい)
    process.stderr.write(line);
  }
  process.exit(1);
}

// スロット名の検証は 1 箇所に集める。cmdSave と cmdSwap で条件がずれると、片方では作れるのに
// もう片方では扱えない名前ができる(実際、予約語の判定が save 側に無かったため
// `accounts/save.json` を作れてしまい、復元できないスロットが残せた)。
function validateName(name) {
  if (!NAME_RE.test(name)) {
    fail('アカウント名に使えない文字が含まれています: ' + name
      + '\n  使えるのは英数字とハイフン(-)、アンダースコア(_)だけです'
      + '\n  別の名前で `swap save <名前>` を実行し直してください');
  }
  if (RESERVED_NAMES.has(name)) {
    fail('その名前は swap のサブコマンドと同じなので使えません: ' + name
      + '\n  作れたとしても `swap ' + name + '` はサブコマンドとして解釈されるため、'
      + 'そのスロットを復元する手段がなくなります'
      + '\n  別の名前を指定してください');
  }
}

// credentials を読む。復元に使える中身であることまで確かめる(accessToken が無いものを
// 復元しても意味がない)。raw を保持するのは、退避時に JSON を再生成せず元のバイト列を
// そのまま書き戻すため(フィールド順や表記の揺れを持ち込まない)。
function readCreds(file) {
  const c = readCredentials(file);
  // 判定は credentials.js の hasUsableCredentials に通す。同じ条件をここに書き写していた頃は、
  // 起動時の形式検証が hasUsableCredentials を必須にしているのに一度も呼ばない状態で、
  // 「基準を 1 箇所に置く」という credentials.js の目的が達せられていなかった
  // (定義を変えた瞬間にガードと swap の判定がずれ、過去にはそれが「ガードは正常と判定して
  //  swap を案内するのに swap は必ず失敗する」袋小路を生んだ)。
  if (!hasUsableCredentials(c.json)) {
    throw new Error('claudeAiOauth.accessToken が無い');
  }
  return c;
}

function readCredsOrNull(file) {
  try {
    return readCreds(file);
  } catch {
    // 未ログイン・破損・権限・将来の構造変更。呼び出し側で「現在なし」として扱う
    return null;
  }
}

// 読めない理由を案内に反映するために、もう一度だけ読んで原因を切り分ける。ここを
// 「破損しているか書き込み中」と決め打ちすると、権限で読めない環境の人に
// 「時間をおいて再実行」という永久に効かない対処を繰り返させることになる。
// 返り値の retryable は「待てば直りうるか」で、案内の文面を分ける。retryable false は
// 「中身を見たうえで、待っても直らないと言い切れる」ときだけに限る。呼び出し元はこれを根拠に
// /login を勧めるので、判断がつかないものまで false に倒すと、まだ退避していないアカウントの
// refreshToken を捨てさせることになる。false にしてよいのは、ファイルが無い場合と、JSON として
// 読めたのに形が違う場合(手で編集した、別バージョンが書いた、将来の構造変更)の 2 つだけ。
function unreadableReason(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { label: 'ファイルがありません', retryable: false };
    // ENOENT 以外の読み取り失敗(EBUSY・EPERM・EACCES など)は、中身が健全なままファイルに
    // 手が届いていないだけのことがある。ウイルス対策やバックアップツールが一時的に掴んでいる、
    // ACL が一時的に変わっている、といった一過性の要因が典型で、account-guard.js の
    // credentialsState() は同じ状況を 'unreadable'(中身の価値は判断できない)に分類し、
    // 掴んでいるプロセスを終えてから再実行するよう案内している。ここだけ retryable false に
    // していたため、同じ状況に対して 2 ツールの案内が食い違い、swap 側は /login を勧めていた。
    // 恒久的な権限問題なら待つだけでは直らないので、待つ以外の対処も文面に添える。
    return {
      label: '読み取りに失敗しました(' + e.code + ')。掴んでいるプロセスを終えるか、権限を確認してください',
      retryable: true,
    };
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    // 途中まで書かれたファイルは JSON として壊れて見える。書き込み中なら待てば直る
    return { label: '壊れているか、他のプロセスが書き込み中', retryable: true };
  }
  if (!hasUsableCredentials(json)) {
    return { label: 'claudeAiOauth.accessToken がありません(形式が想定と違います)', retryable: false };
  }
  // ここへ来る = 読み直した時点では健全に読める。cmdSave は --force を挟んでから改めて
  // この関数を呼ぶ設計なので、その間にロック(や書き込み)が解けていれば必ずここに落ちる。
  // つまり「原因不明」ではなく「もう読める」ことのほうが多い。retryable false にしていた
  // 頃は、健全な credentials を前に /login を案内していた(未退避アカウントの refreshToken を
  // 失う経路)。理由を特定できない以上、待てば直りうる側に倒す。
  return { label: '読めない理由を特定できません(今は読める状態かもしれません)', retryable: true };
}

// 同一性の判断材料 1。値そのものは比較にしか使わず、出力にもログにも出さない。
function refreshTokenOf(json) {
  const t = json?.claudeAiOauth?.refreshToken;
  return typeof t === 'string' && t ? t : null;
}

// 「同じ資格情報」の証明。一致すれば同じアカウントの同じ世代だと言い切れる。
function sameCreds(a, b) {
  const x = refreshTokenOf(a);
  return !!x && x === refreshTokenOf(b);
}

// プラン種別が両方読めて食い違うか。証明できるのは「同じアカウントの同じ世代ではない」まで。
// 「別アカウント」の証明ではない: 同じアカウントが Pro → Max と変わると、変更前に退避した
// スロットとは種別が食い違うので、ここは真になる。名前を provablyDifferent にしていた頃は
// これを「別アカウントだから復元してよい」と読んでいて、昇格前のローテート済みトークンを
// --force なしでマシン全体へ書き戻していた。真になったからといって復元が安全とは言えない。
// 逆に一致は何も証明しないので、同一判定には決して使わない。
function planDiffers(a, b) {
  const x = subscriptionTypeOf(a);
  const y = subscriptionTypeOf(b);
  return !!x && !!y && x !== y;
}

// プラン種別をそのままファイル名にすると、空白などファイル名に使えない文字が混ざりうる
// (将来 subscriptionType が "max 20x" のような値になった場合)。弾いて止めてしまうと
// swap 経由の切り替えが恒久的に不能になるため、名前として使える形に潰して先に進める。
// 潰すのは退避ファイルの名前だけで、account-guard 側の判定は生の値を使う。
function accountNameOf(json) {
  const t = subscriptionTypeOf(json);
  if (!t) return null;
  const safe = t.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || null;
}

// 書き込み途中で電源が落ちても credentials を壊さないよう、一時ファイル経由で差し替える。
// 中身は平文トークンなので tmp の時点から 0600 にする。前回の残骸が居ると writeFileSync の
// mode は効かない(mode は作成時のみ)ため、書き込み後に明示的に落とす。
// Windows では ACL 継承が支配的で chmod はほぼ no-op だが、WSL や他環境でも同じ強度を保つ。
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  let renamed = false;
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    // Windows では移動先を他プロセスが開いていると rename が EPERM で落ちる
    // (稼働中の Claude Code が credentials を掴んでいる場合)。
    fs.renameSync(tmp, file);
    renamed = true;
  } finally {
    // 書き込み・chmod・rename のどこで落ちても、平文トークン入りの .tmp を残さない。
    // 一覧は `.json` しか拾わないので、残しても誰も気づけないまま溜まっていく。
    if (!renamed) { try { fs.unlinkSync(tmp); } catch {} }
  }
}

// refreshToken には有効期限があり、切れていると復元しても /login のやり直しになる。
// 期間は公表されていないので日数を決め打ちせず、常にトークン自身の値から残りを出す
// (2026-08-09 の実測では残り 26 日だった)。
function msLeft(json) {
  const at = json.claudeAiOauth.refreshTokenExpiresAt;
  return typeof at === 'number' ? at - Date.now() : null;
}

function isExpired(json) {
  const left = msLeft(json);
  return left !== null && left <= 0;
}

function expiryNote(json) {
  // refreshToken が無い中身は、期限を見るまでもなく更新できない。accessToken だけで
  // 数時間動いたあと、マシン全体が /login のやり直しになる。無言で通さない。
  if (!refreshTokenOf(json)) return '  [refreshToken がありません: 更新できず数時間で切れます]';
  const left = msLeft(json);
  if (left === null) return '  [失効期限が不明]';
  if (left <= 0) return '  [失効済み: /login のやり直しが必要]';
  const days = Math.floor(left / DAY_MS);
  return days <= 1 ? '  [まもなく失効]' : `  [残り ${days} 日]`;
}

function savedAccounts() {
  if (!fs.existsSync(ACCOUNTS_DIR)) return [];
  return fs.readdirSync(ACCOUNTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -5))
    .filter(n => NAME_RE.test(n))
    .sort();
}

function accountFile(name) {
  return path.join(ACCOUNTS_DIR, name + '.json');
}

// --- 退けた旧内容(.replaced) ---

// .replaced の一覧。読めなかったときに取るべき態度は呼び出し元ごとに違う(控えを作る側は
// 進めない、消す側は消さない、数える側は「数えられない」と伝える)ので、判断はここではせず
// error を添えて返す。生の readdirSync を各所で呼んでいた頃は、.replaced が手違いでファイルと
// して置かれている環境で status が出力の途中から `ENOTDIR` の生の例外に落ち、その直前に
// 自分で案内した対処コマンドも同じ形で死ぬ、という行き止まりになっていた。
function listReplaced() {
  if (!fs.existsSync(REPLACED_DIR)) return { files: [], error: null };
  try {
    return { files: fs.readdirSync(REPLACED_DIR), error: null };
  } catch (e) {
    return { files: [], error: e.code || e.message };
  }
}

function replacedEntries(base) {
  const { files, error } = listReplaced();
  // base はスロット名(NAME_RE 済み)か UNREADABLE_BASE。後者は先頭に `.` を持つので、
  // 素通しにすると正規表現の任意 1 文字として効いて別のベースの控えまで拾う。
  const re = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d+)\\.json$');
  const list = files
    .map(f => ({ f, m: re.exec(f) }))
    .filter(x => x.m)
    .map(x => ({ file: path.join(REPLACED_DIR, x.f), n: Number(x.m[1]) }))
    .sort((a, b) => a.n - b.n);
  return { list, error };
}

// その資格情報が他にも残っているか。スロット・他の控え・現在のログインをすべて見る。
// refreshToken の一致は「同じ資格情報」の証明なので、ここで真を返せた控えは、消しても
// 復旧の手立てが減らないと言い切れる。
function hasCopyElsewhere(token, selfFile) {
  if (slotsHolding(token).length > 0) return true;
  const cur = readCredsOrNull(CREDENTIALS);
  if (cur && refreshTokenOf(cur.json) === token) return true;
  // .replaced を読めなければ「他にもある」と証明できないので、複製は無い側に倒す
  // (偽を返すぶんには控えが 1 本残るだけで、消してよいものを消さない安全側に外れる)。
  return listReplaced().files
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(REPLACED_DIR, f))
    .some(f => {
      if (f === selfFile) return false;
      const c = readCredsOrNull(f);
      return c && refreshTokenOf(c.json) === token;
    });
}

// 控えを減らすのは上限を超えたときだけにする。「失効済みだから」で無条件に消すと、
// 退けたばかりの控えがその場で消える(上書きされる旧内容が失効していた場合)。案内が約束する
// 「旧内容は .replaced に控えを残します」が破れ、マシンの時計が進んでいる環境では
// 失効していない控えまで巻き添えになる。
//
// そのうえで、上限は「消してよいと言えるものが足りている範囲」でしか守らない。以前は
// 超過分を古い順で機械的に落としていたため、同じスロットへ 3 回続けて退避すると、最初に
// 押し出されたアカウントの唯一の生存コピーが消えていた(復旧はブラウザ OAuth のやり直し)。
// 冒頭で構造の保証だと書いた以上、本数のために唯一の 1 本を落とすことはしない。
// 落としてよいのは次の 2 つだけで、この順に選ぶ。
//   0. 失効済み       … 復元しても /login のやり直しになる
//   1. 複製が他にある … refreshToken の一致で証明できる
// 読めない控え(readCredsOrNull が null)は落とさない。ウイルス対策やバックアップツールの
// ロック、ACL の一時変更、EBUSY のような一過性の要因でも読めなくなるため、読めないことは
// 「復旧に使えない」の証明にならない。証明できない以上、上限を超えても残す側に倒す。
// どれでもない控えも、そのアカウントの最後の 1 本かもしれないので上限を超えても残す。
// protect は今まさに退けたばかりの控え。上限判定の対象には数えるが、削除の候補からは外す。
//
// 「複製が他にある」は 1 件消すたびに評価し直す。同じ refreshToken を持つ控え同士は
// 互いの証人になれてしまうため、まとめて判定すると両方とも「複製あり」と出て両方消え、
// 唯一の生存コピーが消失する(実機で再現: 他のどこにも複製が無い状態で同じ token を持つ
// 控えが 2 本あると、片方がもう片方の証人になって両方 unlink された)。1 件ずつ消せば、
// 先に消した分は次の判定の証人から自然に外れる(hasCopyElsewhere は実ファイルを見るため)。
function pruneReplaced(base, protect) {
  // 中身は最初に 1 度だけ読む。控えの内容はこのループの中では変わらない(変えるのは
  // unlink だけで、消したものは candidates からも外す)ので、反復ごとに読み直すのは
  // 同じ結果を得るためだけのディスク I/O になる。控えが増えるほど二乗で効いてくる。
  const { list, error } = replacedEntries(base);
  // 一覧を読めなければ、何本あるのかも、どれが唯一の 1 本なのかも分からない。数を守るために
  // 消す判断は「消してよいと証明できる」ことが前提なので、証明の材料が無い以上は何もしない。
  if (error) return;
  const candidates = list
    .filter(e => e.file !== protect)
    .map(e => ({ ...e, creds: readCredsOrNull(e.file) }));
  let excess = candidates.length + 1 - REPLACED_KEEP; // +1 は protect の分
  while (excess > 0) {
    // 失効済みを最優先(他の控えの状態に左右されない、最も確実な根拠)
    let victim = candidates.find(e => e.creds && isExpired(e.creds.json));
    if (!victim) {
      // 一方で hasCopyElsewhere は実ファイルを見たままにする。ここをキャッシュすると、
      // 先に消した控えが証人として残り続け、同じ token を持つ 2 本が互いを保証して
      // 両方消える(上のコメントの事故がそのまま戻る)。
      victim = candidates.find(e => {
        if (!e.creds) return false; // 読めないものは複製の有無を証明できない
        const token = refreshTokenOf(e.creds.json);
        return token && hasCopyElsewhere(token, e.file);
      });
    }
    if (!victim) break; // 消してよいと言えるものが尽きた。上限を超えたまま残す
    try { fs.unlinkSync(victim.file); } catch {}
    candidates.splice(candidates.indexOf(victim), 1);
    excess--;
  }
}

// 上書きで失われる内容の控えを取る。移動ではなく複製なのは、控えを作る途中で落ちても
// 元のファイルが手つかずで残るようにするため。控えが取れなければ上書きへは進まない
// (切り替えられないのは後から取り返せるが、消えた資格情報は取り返せない)。
function keepAside(file, base) {
  // 置き場所を作れない・読めないのも「控えを取れなかった」の一種なので、copyFileSync と
  // 同じように理由と対処を添えて止める。素通しにしていた頃は、.replaced が手違いでファイルと
  // して置かれている環境で `EEXIST: file already exists, mkdir ...` という生の Node 例外だけが
  // 出て、上書きが起きたのかどうかも、どう直せばよいのかも伝わらなかった。
  const replacedFail = (what, e) => fail(
    '上書きで失われる内容の控えを' + what + '(' + (e.code || e.message) + ')'
    + '\n  ' + REPLACED_DIR + ' を扱えません。同じ名前のファイルが置かれていないか、'
    + 'ディレクトリの権限を確認してください'
    + '\n  控えを残せない以上、上書きは行っていません(元のファイルは手つかずです)');
  try {
    fs.mkdirSync(REPLACED_DIR, { recursive: true });
  } catch (e) {
    replacedFail('置く場所を作れませんでした', e);
  }
  // 一覧を読めないまま番号を決めると、既にある控えと同じ名前を選んで上書きしかねない
  // (控えを残すための処理そのものが別の控えを消す)。読めなければ進まない。
  const { list, error } = replacedEntries(base);
  if (error) replacedFail('数えられませんでした', { code: error });
  const n = list.length ? list[list.length - 1].n + 1 : 1;
  const dest = path.join(REPLACED_DIR, base + '-' + n + '.json');
  try {
    fs.copyFileSync(file, dest);
  } catch (e) {
    // ここが失敗する原因(EACCES/EPERM/EISDIR 等)は、たいてい file を読めない理由と同じなので、
    // --force で「読めない現在でも進む」と案内した直後にここで同じ理由の生の Node 例外が出て、
    // 案内どおり打った利用者が行き止まりになっていた。控えを残せない以上、上書きには進めない
    // (捕まえずに投げっぱなしにすると main の catch が生のメッセージだけを出して終わる)。
    // copyFileSync が書き込みの途中で失敗すると(ENOSPC/EIO 等)、切り詰められた部分ファイルが
    // dest に残ることがある。消さずに fail() すると、この部分ファイルが replacedCounts() に
    // 「上書きで退けた旧内容」として数えられ、cmdStatus が復元可能なバックアップとして案内して
    // しまう。しかも pruneReplaced は読めない控えを削除対象から意図的に外すので、自動でも
    // 消えない。unlink 自体の失敗は握りつぶす(そこまで失敗する環境では他に打つ手がない)。
    try { fs.unlinkSync(dest); } catch {}
    fail('上書きで失われる内容の控えを取れませんでした(' + (e.code || e.message) + ')'
      + '\n  ' + file + ' を読み取れません。権限を確認するか、ウイルス対策やバックアップツールなど'
      + 'このファイルを掴んでいる別プロセスがあれば終了したうえで、'
      + '先ほどと同じ swap コマンドをもう一度実行してください'
      + '\n  控えを残せない以上、上書きは行っていません(元のファイルは手つかずです)');
  }
  try { fs.chmodSync(dest, 0o600); } catch {}
  pruneReplaced(base, dest);
  return dest;
}

// 「上書きで退けた旧内容」と「読めなかった現在の credentials の控え」は用途が違う。
// 前者はスロットへ戻せば復旧できるが、後者は復元に使えない中身なので、戻す案内に混ぜると
// 壊れたバイト列を有効なスロットへ書かせることになる。数える段階から分ける。
// 分類を名前だけで決めないのは、writeSlot が「読めない旧内容」も退けるため。スロットの中身が
// 壊れていた状態で上書きすると、その壊れたバイト列は UNREADABLE_BASE ではなくスロット名で
// .replaced に入る。名前で数えていた頃はこれが「戻せる旧内容」に計上され、status が案内する
// とおり accounts/<name>.json へ戻した利用者が、直前に取った正しい退避を自分で潰したうえで
// 復元手段を失っていた(pruneReplaced は読めない控えを消さないので、この誤表示は自動でも
// 消えない)。実際に読めるかどうかまで見て分ける。控えは高々数本なので読み直しは軽い。
// 逆向きの取りこぼしのほうが重い。UNREADABLE_BASE は「読めなかった現在の credentials」の
// つもりで付ける名前だが、readCredsOrNull が書き込み途中を掴んで失敗した直後に copyFileSync
// が書き終わったファイルをコピーすると、中身は有効なまま残る。名前で unreadable に数えると、
// 未退避アカウントの唯一の控えを「復元に使えない・消して構わない」と案内することになる。
// 一覧そのものを読めなかった場合は 0 件と区別する。0 件として黙って表示すると、実際には
// 控えが残っているのに「控えは無い」と読めてしまい、上書きの取り違えから戻す手立てを
// 見落とさせる(status は状況確認の唯一の入り口なので、ここでの取り違えは重い)。
function replacedCounts() {
  const { files, error } = listReplaced();
  if (error) return { overwritten: 0, unreadable: 0, error };
  let overwritten = 0;
  let unreadable = 0;
  for (const f of files.filter(f => f.endsWith('.json'))) {
    if (readCredsOrNull(path.join(REPLACED_DIR, f))) overwritten++;
    else unreadable++;
  }
  return { overwritten, unreadable, error: null };
}

// --- 来歴(.current) ---

// 現在のログインがどのスロット由来かの記録。平文 1 行で持つのは、壊れても「分からない」に
// 落ちるだけで復旧を妨げないため。指しているスロットが消えていれば記録も無効とみなす。
function readCurrentSlot() {
  let name;
  try {
    name = fs.readFileSync(CURRENT_FILE, 'utf8').trim();
  } catch {
    return null; // 未記録(このツールを使い始めた直後、または手で消した)
  }
  if (!NAME_RE.test(name) || !fs.existsSync(accountFile(name))) return null;
  return name;
}

function writeCurrentSlot(name) {
  writeAtomic(CURRENT_FILE, name + '\n');
}

// 来歴を書けなかったときの後始末と案内。書き込みは 3 経路(退避・来歴の自己修復・切り替えの
// 仕上げ)にあり、そのどれでも Windows では rename が EPERM で落ちうる。共通なのは
// 「古い来歴を残すほうが危険」という判断で、残すと次の名前を省いた `swap save` が来歴一致と
// みなして別アカウントのスロットを狙う。消せば「未記録」に落ち、currentSlotOf が
// subscriptionType 由来の名前で代用するので、少なくとも他人のスロットは指さない。
// 認証がその時点でどうなっているかは経路ごとに違うので、それは呼び出し側が書く。
function dropCurrentSlot(e) {
  try { fs.unlinkSync(CURRENT_FILE); } catch {}
  return '来歴を記録できませんでした(' + (e.code || e.message) + ': ' + CURRENT_FILE + ')'
    + '\n  このファイルを掴んでいるプロセスを終えるか、読み取り専用属性を外してください'
    + '\n  以後の退避は `swap save <name>` と名前を明示してください'
    + '(省くと別のスロットを上書きすることがあります)';
}

// 現在のログインをどのスロットへ退避するか。来歴を第一の手掛かりにし、まだ記録が無いときだけ
// subscriptionType 由来の名前で代用する。どちらも「そのスロットを上書きしてよい」ことまでは
// 保証しないので、書く直前に saveInto が改めて裏を取る。
function currentSlotOf(cur) {
  return readCurrentSlot() || (cur && cur.json ? accountNameOf(cur.json) : null);
}

// 指定した refreshToken を持つスロットを探す。一致は「同じ資格情報」の証明なので、
// 退避で押し出した旧内容の複製がどこに残っているかを正確に言える。
// 除外する名前を受け取る引数は持たない。唯一の呼び出し元(hasCopyElsewhere)は常に全件を
// 見る必要があり、除外を足すと「複製が他にある」の証人を取りこぼして、pruneReplaced が
// 消してはいけない唯一の控えを落としうる。
function slotsHolding(token) {
  return savedAccounts().filter(n => {
    const c = readCredsOrNull(accountFile(n));
    return c && refreshTokenOf(c.json) === token;
  });
}

// 今回の退避で古くなりうるスロット。`swap save personal` のように 1 つのアカウントを
// 2 つの名前で退避すると、更新されない方が古いまま取り残され、後で復元したときに
// ローテート済みのトークンへ黙って巻き戻る(マシン全体が認証エラーになる)。
// かといって勝手に揃えて書くと、同一プランの別アカウントを取り違えたときに、名前を
// 挙げてもいないスロットまで潰す。書き換えずに名前を挙げるだけにして、判断は人に返す。
// 拾うのは refreshToken の一致で証明できるものだけ、つまり「押し出した旧内容と同じ資格情報を
// 持つスロット」に限る。以前は来歴が指していたスロットも挙げていたが、来歴が語るのは
// 「前回このツールが書いた先」であって、そこに今も同じアカウントが入っている保証はない。
// README が案内する初回手順(swap save → 別アカウントで /login → swap save <別名>)を
// そのまま踏むと、来歴は 1 つ目のスロットを指したままなので、もう一方のアカウントの
// 新鮮なバックアップを「古い」と報告し、それを潰すコマンド(--force)を添えて終わっていた。
// 「外れても案内が 1 行増えるだけ」ではなく、外れると唯一のバックアップを壊す案内になる。
// 現在の内容と一致するスロットは古くないので外す。読めないスロットは古いかどうか
// 判断できないので挙げない(status が [読めません] として別に扱う)。
//
// 以前は slotsHolding で全 accounts/*.json を読んで refreshToken の一致を調べたあと、
// 一致したスロットだけをここでもう一度開き直して sameCreds を見ていた。退避のたびに
// 同じファイルを二重に読むだけで判定自体は 1 回の読み込みで組み立てられるので、
// slotsHolding は経由せずここで直接読む。
function staleSlots(cur, name, oldToken) {
  if (!oldToken) return [];
  // 押し出した旧内容が現在のログインと同じ資格情報なら、それを持つスロットは古くない。
  // この条件はスロット名に依存しないので、ループの外で 1 回だけ見る。中で sameCreds を
  // 呼んでいた頃は、oldToken に一致したスロットごとに同じ比較を繰り返していた
  // (c の refreshToken は既に oldToken だと確定しているので、sameCreds が見ていたのは
  //  実質「現在のログインの refreshToken が oldToken か」だけだった)。
  if (refreshTokenOf(cur.json) === oldToken) return [];
  return savedAccounts().filter(n => n !== name).filter(n => {
    const c = readCredsOrNull(accountFile(n));
    return c && refreshTokenOf(c.json) === oldToken;
  }).sort();
}

// 来歴が指していたスロットのうち、内容が現在のログインと違うもの。上の staleSlots とは
// 根拠の強さが違うので分けて持つ(混ぜると、証明できたことと推測が同じ強さの案内になる)。
// ここで分かるのは「現在のログインが出てきたと記録されている場所の中身が、いまと違う」だけで、
// 理由が「退避のあとトークンが更新された」なのか「ツールを通さずに別アカウントへ /login した」
// なのかは判別できない。前者なら古い退避、後者なら別アカウントの最新の退避で、扱いは正反対。
function driftedProvenance(cur, name, prevSlot) {
  if (!prevSlot || prevSlot === name) return null;
  const c = readCredsOrNull(accountFile(prevSlot));
  return c && !sameCreds(cur.json, c.json) ? prevSlot : null;
}

// 中止の文面は証明できた範囲に合わせる。確かなのは「現在と違う認証情報が入っている」ことだけで、
// プラン種別が食い違っても「別のアカウント」とまでは言えない(同じアカウントのプラン変更前の
// 退避でも食い違う)。断定すると、同じアカウントの古い退避に対して「別のアカウントです(pro)」と
// 現在と同じプラン名を並べた自己矛盾した案内になり、利用者は不要な別名スロットを増やす。
// 退避が上書きガードに当たるか、その判断材料ごと返す。saveInto が上書きの前に読むものと同じ
// なので、案内を組み立てる側(cmdSwap)からも呼べるように切り出す。案内側で条件を書き写すと、
// 片方だけ直したときに「案内どおり打つと止まる」が復活する(このファイルで繰り返し起きた事故)。
// prevSlot は呼び出し元が既に読んだ .current。cmdSwap は読み直しを避けるために渡し、saveInto は
// 省略して自分で読む(saveCurrent の経路では、そこへ来るまでに .current が書き換わりうる)。
function overwriteGate(cur, name, prevSlot) {
  const file = accountFile(name);
  const exists = fs.existsSync(file);
  const old = exists ? readCredsOrNull(file) : null;
  const identical = !!(old && sameCreds(cur.json, old.json));
  // 来歴が一致しても素通しにはしない。/login や書き込みの中断で来歴は古くなりうるので、
  // 「別アカウントだと証明できる」場合は来歴より証明を優先して止める。
  const slot = prevSlot !== undefined ? prevSlot : readCurrentSlot();
  const provenance = slot === name;
  const different = old ? planDiffers(cur.json, old.json) : false;
  return {
    old, prevSlot: slot, provenance, different,
    blocked: exists && !identical && (!provenance || different),
  };
}

// afterCmd は「退避のあとに続けると、当初の要求が完了するコマンド」。切り替えの途中でここに
// 当たった場合(cmdSwap)、退避の手順だけを出しても要求された切り替えは終わらず、続きは人の
// 推測任せになる(プラン種別が食い違う組み合わせでは手前のガードが 1 つも発火しないので、
// この中止が切り替えに対する唯一の案内になる)。退避そのものが目的の cmdSave からは渡らない。
function failOverwrite(name, old, provenance, different, afterCmd) {
  const theirs = old ? subscriptionTypeOf(old.json) : null;
  const after = afterCmd ? '\n    ' + afterCmd : '';
  fail('退避先 ' + name + ' には現在と違う認証情報が入っています'
    + (theirs ? '(プラン: ' + theirs + ')' : '(中身を読めないため確認できません)')
    + (different
      ? '\n  プラン種別が現在のログインと違います。別のアカウントか、同じアカウントの'
        + 'プラン変更前の退避かのどちらかです'
        + (provenance
          ? '\n  来歴は ' + name + ' を指しているので、このツールを通さずに /login したか、'
            + '退避のあとプランが変わったかで食い違っています'
          : '')
      : '\n  同じアカウントの古い退避かもしれませんし、別のアカウントかもしれません'
        + '(credentials に identity が無いため、このツールでは見分けられません)')
    + '\n  上書きすると、そのアカウントのバックアップが最新でなくなります。'
    + '現在のログインはそのままです'
    + '\n  何も壊さずに退避するなら(既存のスロットには触りません):'
    + '\n    swap save <別名>' + after
    + '\n  同じアカウントだと分かっていて上書きするなら(旧内容は .replaced に控えを残します):'
    + '\n    swap save ' + name + ' --force' + after);
}

// スロットへの書き込みは必ずここを通す。「上書きの前に旧内容を退ける」を呼び出し側の
// 記憶に任せると、後から足した経路がすり抜けて(実際、かつての別名スロット同期がそうだった)、
// 控えを 1 本も残さないまま上書きする。冒頭で構造の保証だと書いた以上、経路は 1 つにしておく。
// 控えを省いてよいのは「同じ資格情報」だと証明できるときだけ(読めない旧内容は証明できない
// ので必ず退ける)。
// old は呼び出し元が既に同じファイルを読んでいる場合だけ渡す。ここで読み直すと、上書きの
// 可否を判断した内容と実際に退ける内容が別物になりうる(その隙に別の swap が書き込むと、
// 「同じ資格情報だから控えは要らない」と判断した直後に、別の中身を控えなしで潰す)。
// 省略時は自分で読む。控えを取る条件の判断はこの関数の中だけに残し、呼び出し側の記憶には
// 任せない(任せた結果、かつての別名スロット同期が控えを 1 本も残さず上書きしていた)。
function writeSlot(name, cur, old) {
  const file = accountFile(name);
  if (fs.existsSync(file)) {
    const prev = old !== undefined ? old : readCredsOrNull(file);
    if (!(prev && sameCreds(cur.json, prev.json))) keepAside(file, name);
  }
  // 控えは取れたのにスロットへ書けないことがある(退避先を他プロセスが開いていると
  // rename が EPERM)。keepAside の copyFileSync と CREDENTIALS の書き込みには理由と対処を
  // 添えてあるのに、ここだけ素通しで生の Node 例外になっていた。何が済んで何が済んで
  // いないのかが読めないと、直せる原因に気づかないまま再実行を繰り返し、控えだけが積み上がる。
  try {
    writeAtomic(file, cur.raw);
  } catch (e) {
    fail('退避先へ書き込めませんでした(' + (e.code || e.message) + ')'
      + '\n  ' + file + ' を書き換えられません。このファイルを掴んでいる別プロセス'
      + '(ウイルス対策・バックアップツールなど)を終了するか、読み取り専用属性を外してください'
      + '\n  退避は完了していません。現在のログインはそのままです');
  }
}

// 退避の実体。読み込み済みの cur をそのまま書くのは、CREDENTIALS を二度読むと
// 「比較したバイト列」と「退避するバイト列」がずれるため(その隙に Claude Code が
// トークンを更新すると、退避したつもりの中身が別物になる)。
// 戻り値は、この退避で古くなりうる他スロットの一覧(書き換えはしない)。
function saveInto(cur, name, forceOverwrite, afterCmd) {
  const g = overwriteGate(cur, name);
  const oldToken = g.old ? refreshTokenOf(g.old.json) : null;

  if (g.blocked && !forceOverwrite) {
    failOverwrite(name, g.old, g.provenance, g.different, afterCmd);
  }

  // 他スロットの状態は書き込みの前に見る(書いたあとでは、退けた旧内容がどこに複製として
  // 残っているかも、来歴が元は何を指していたかも分からなくなる)。
  const stale = staleSlots(cur, name, oldToken);
  const drifted = driftedProvenance(cur, name, g.prevSlot);
  // 上で読んだ old をそのまま渡す。writeSlot に読み直させると、同じファイルを 1 回の退避で
  // 二度読むうえ、identical(上書きの可否)と控えの要否が別々の読み込み結果で決まる。
  writeSlot(name, cur, g.old);
  // 退避そのものは済んでいる。来歴だけ書けずに生の例外で終わると、退避できたのかどうかが
  // 読めず、やり直して同じスロットをもう一度上書きさせることになる。中止はするが(来歴の
  // 無い状態で切り替えまで進めない)、何が済んだかは必ず伝える。
  try {
    writeCurrentSlot(name);
  } catch (e) {
    fail('退避は済みましたが、' + dropCurrentSlot(e)
      + '\n  退避先: ' + accountFile(name));
  }
  return { stale, drifted };
}

// 現在ログイン中の認証情報を accounts/ に退避する。
// 戻り値は { name, stale } / 読めない場合は { degraded:true, kept } / 未ログインなら null。
// force は 2 つの別々の判断を分けて渡す。まとめて 1 つの --force にすると、復元側の都合
// (失効済みを承知で復元したい)で付けた --force が、退避側の上書きガードまで黙って外す。
//   unreadable … 現在の credentials が読めなくても、控えだけ残して先へ進む
//   overwrite  … 別の認証情報が入っているスロットを上書きしてよい
// forceCmd は「読めないまま先へ進む」ための実際に効くコマンド(呼び出し元で文面が変わる)。
// pre は呼び出し元が既に読んだ credentials。渡すのは CREDENTIALS を二度読まないため
// (二度読むと、判定に使ったバイト列と実際に退避するバイト列がずれる。稼働中の別セッションが
//  その隙にトークンを更新すると、ガードを通した内容とは別物がスロットに入る)。
// afterCmd は上書きガードで止まったときに案内へ添える「続きの一手」(failOverwrite 参照)。
function saveCurrent(explicitName, force, forceCmd, pre, afterCmd) {
  const cur = pre || readCredsOrNull(CREDENTIALS);

  if (!cur) {
    if (!fs.existsSync(CREDENTIALS)) return null; // 単に未ログイン
    // 「読めない」で止めるだけだと、この状態から抜け出す手段が無くなる(swap も save も
    // 同じ判定で止まるため)。中身を確認した人が先へ進めるよう --force を用意する。
    const why = unreadableReason(CREDENTIALS);
    if (!force.unreadable) {
      fail('現在の credentials を読めません(' + why.label + ')'
        + (why.retryable ? '\n  時間をおいて再実行してください。' : '\n  ')
        + '中身を確認したうえで、そのまま先へ進めるなら:'
        + '\n    ' + forceCmd);
    }
    // 読めない中身はスロットに入れない。復元に使えないうえ、そこに入っている有効な退避を
    // 潰してしまう(--force の意図は「読めない現在を諦めて進む」であって「有効な退避を
    // 捨てる」ことではない)。手掛かりとしての価値はあるので控えだけ残す。
    const kept = keepAside(CREDENTIALS, UNREADABLE_BASE);
    return { degraded: true, kept };
  }

  const name = explicitName || currentSlotOf(cur);
  if (!name) {
    fail('退避名を決められません(subscriptionType が読めず、来歴も記録されていません)'
      + '\n  `swap save <name>` で名前を明示してください。以後その名前が来歴として記録され、'
      + '名前を省略しても退避できるようになります');
  }
  // 明示された名前は呼び出し元(cmdSave)が既に検証しているが、省略されたときの名前は
  // 来歴か subscriptionType から決まるので、そこを通っていない。検証を 1 箇所に集める以上、
  // 名前が確定したここでも通す(subscriptionType が将来 `save` や `warmup` になれば、
  // 復元する手段の無いスロットがこの経路から静かに作られる)。二重に呼んでも副作用はない。
  validateName(name);
  const { stale, drifted } = saveInto(cur, name, force.overwrite, afterCmd);
  return { name, stale, drifted };
}

// 今回の退避で取り残されうる他スロットの案内。勝手に揃えないと決めた以上、黙って放置もしない
// (放置すると、後でそちらを復元したときにローテート前のトークンへ戻る)。
//
// ただし「古い」と断定はしない。現在のログインが同じアカウントの新しい世代なのか、別アカウントへ
// /login した結果なのかは、このツールには見分けられない。断定して --force を勧めていた頃は、
// README の初回手順(1 つ目を退避 → 2 つ目のアカウントで /login → 2 つ目を退避)をそのまま
// 踏んだ人に、「もう一方の唯一のバックアップを潰すコマンド」を提示して終わっていた。
// 両方の可能性を並べて、判断は人に返す。
//
// returnCmd は「先に戻すためのコマンド」。切り替えを伴う場合に渡す。切り替えのあとで
// `swap save <name> --force` を打つと、更新されるのは復元したばかりのアカウントの内容なので、
// 名前を挙げたスロットのバックアップがそこで失われる(以前は切り替え前に案内していたため、
// 出力どおりに打つと意味が反対になっていた)。
// スロット名ではなくコマンドを丸ごと受け取るのは、--force の要否が呼び出し側にしか分からず、
// ここで名前から組み立て直すと判定が二重になるため(それが実際にずれて、案内どおり打つと
// 中止される事故になっていた。cmdSwap の restoreCmd 参照)。
// インデントは呼び出し元 2 箇所とも '  ' 固定なので引数にはせず定数にする。
const REPORT_INDENT = '  ';
function reportOtherSlots(saved, returnCmd) {
  const indent = REPORT_INDENT;
  const stale = saved.stale || [];
  const drifted = saved.drifted || null;
  const names = [...new Set([...stale, ...(drifted ? [drifted] : [])])];
  if (!names.length) return;
  console.log(indent + '今回の退避と内容が違うスロットがあります: ' + names.join(', '));
  if (stale.length) {
    console.log(indent + '  ' + stale.join(', ')
      + ' は、いま押し出した旧内容と同じものを持っています(refreshToken の一致)');
  }
  if (drifted) {
    console.log(indent + '  ' + drifted + ' は来歴が指していたスロットです'
      + '(現在のログインが出てきたと記録されている場所)');
  }
  console.log(indent + '  退避のあとトークンが更新されたのなら、これらは古くなっています。'
    + 'このツールを通さずに /login したのなら、別アカウントの最新の退避です'
    + '(このツールでは見分けられません)');
  console.log(indent + '  前者だと分かっているときだけ更新してください'
    + '(後者なら、そのアカウントの退避を潰します):');
  if (returnCmd) {
    console.log(indent + '    ' + returnCmd
      + '   (先に戻さないと、いま復元したアカウントの内容で上書きされます)');
  }
  // 名前は挙がっている全部に出す。先頭 1 つだけを出していた頃は、同じアカウントを複数の名前で
  // 退避している人(この関数がまさに想定している状況)が案内どおり打っても残りが取り残され、
  // 後でそちらを復元した時点でローテート前のトークンに戻っていた。防ごうとしている事象を
  // 案内の側で作っていたことになる。
  for (const n of names) {
    console.log(indent + '    swap save ' + n + ' --force');
  }
}

// 退避したあとトークンが更新されると、そのスロットは復元してもローテート前に戻るだけになるが、
// 失効期限は元のままなので expiryNote は「残り N 日」と健全に見える。一過性の警告
// (reportOtherSlots)だけだと、そのとき端末を見ていなければ二度と気づけない。status にも印を残す。
//
// 根拠にできるのは「来歴が指すスロットの内容が現在のログインと違う」という事実だけ
// (現在のログインはそこから出てきたので、少なくとも同じ世代ではない)。同じ refreshToken を
// 持つ別名スロットは同じ世代なので、同じだけ古いと言える(一致は証明)。
// なお、この食い違いは「トークンが更新された」だけでなく「ツールを通さずに /login した」
// でも起きる。後者ならそのスロットは別アカウントの新鮮な退避なので、印の意味は
// 「現在と内容が違う」までにとどめ、更新を促す言い方はしない。
// savedCreds は呼び出し元(cmdStatus)が全スロットを 1 回読んで作った name -> creds の
// キャッシュ。以前はここで accountFile(curSlot) を読み直し、さらに slotsHolding が
// 全 accounts/*.json をもう一度読んでいた。cmdStatus 側の表示ループも同じファイル群を
// 読むため、1 回の `swap`(status)実行で各スロットを複数回読むことになっていた。
function outdatedSlots(cur, curSlot, savedCreds) {
  if (!cur || !curSlot) return new Set();
  const c = savedCreds.get(curSlot);
  if (!c || sameCreds(cur.json, c.json)) return new Set();
  const token = refreshTokenOf(c.json);
  if (!token) return new Set([curSlot]);
  const holding = [...savedCreds.entries()]
    .filter(([n, cc]) => n !== curSlot && cc && refreshTokenOf(cc.json) === token)
    .map(([n]) => n);
  return new Set([curSlot, ...holding]);
}

function cmdStatus() {
  const cur = readCredsOrNull(CREDENTIALS);
  const exists = fs.existsSync(CREDENTIALS);
  const curSlot = readCurrentSlot();

  // 「未ログイン(ファイルが無い)」と「読めない(破損・権限・書き込み中)」を混ぜない。
  // 後者を未ログインと読んだ人が /login をやり直すと、退避していない生きたトークンが
  // 上書きされて消える。status は状況確認の唯一の入り口なので、ここでの誤誘導は重い。
  let label;
  if (cur) label = subscriptionTypeOf(cur.json) || '不明(subscriptionType が読めない)';
  else if (exists) label = '読めません(' + unreadableReason(CREDENTIALS).label + ')';
  else label = '未ログイン';

  // 来歴を併記するのは現在の credentials が読めるときだけ。未ログイン・読み取り不能なのに
  // 「[pro から復元]」と出すと、pro に入っていると読めてしまい、/login を省いたまま
  // 別の中止に当たる。読めないときは来歴を「最後に書いた先」として別の行で言う。
  console.log('現在のアカウント: ' + label + (cur && curSlot ? '  [' + curSlot + ' から復元]' : ''));
  if (exists) console.log('  ' + CREDENTIALS + (cur ? expiryNote(cur.json) : ''));
  if (!cur && curSlot) {
    console.log('  (このツールが最後に書いたのは ' + curSlot
      + ' ですが、現在の内容を読めないため一致は確認できません)');
  }

  const saved = savedAccounts();
  // 各スロットの中身はここで 1 回だけ読み、outdatedSlots の判定と下の表示ループの両方で
  // 使い回す(前は判定と表示で別々に全スロットを読んでいた)。
  const savedCreds = new Map(saved.map(n => [n, readCredsOrNull(accountFile(n))]));
  const outdated = outdatedSlots(cur, curSlot, savedCreds);
  const unreachable = saved.filter(n => DISPATCHED_NAMES.has(n));
  const reservedOnly = saved.filter(n => RESERVED_ONLY_NAMES.has(n));
  console.log('\n退避済み (' + ACCOUNTS_DIR + '):');
  if (saved.length === 0) {
    console.log('  なし。`swap save` で現在のアカウントを退避してください');
  } else {
    for (const name of saved) {
      const c = savedCreds.get(name);
      // 印は来歴が指すスロットにだけ付ける。プラン種別で合わせると、同一プランの別アカウントに
      // まで印が付き、「これが現在のバックアップだ」と誤解したまま上書きさせてしまう。
      console.log((name === curSlot ? '* ' : '  ') + name.padEnd(8)
        + (c ? expiryNote(c.json) : '  [読めません]')
        + (outdated.has(name) ? '  [現在のログインと内容が違います]' : ''));
    }
  }
  if (outdated.size > 0) {
    console.log('\n[現在のログインと内容が違います] の退避は、復元しても現在と同じ状態には'
      + 'なりません。理由は 2 つあり、このツールでは見分けられません:');
    console.log('  a) 退避したあとトークンが更新された … 復元するとローテート前に戻り、'
      + '認証が通らなくなることがあります');
    console.log('  b) このツールを通さずに /login した … その退避は別アカウントの'
      + 'バックアップとして最新のままです');
    console.log('  a だと分かっているときだけ更新してください: swap save <name> --force'
      + '(b なら、そのアカウントの退避を潰します)');
  }
  if (unreachable.length > 0) {
    // 予約語チェックより前に作られたスロット。放置すると復元できないまま一覧に居座り、
    // 「退避してあるから大丈夫」と誤解させる。改名すればそのまま使える。
    console.log('\n復元できない名前の退避があります: ' + unreachable.join(', '));
    console.log('  swap のサブコマンドと同じ名前なので `swap <name>` で復元できません。'
      + 'accounts/<name>.json を別の名前へ改名してください');
  }
  if (reservedOnly.length > 0) {
    // まだ横取りされていないので復元はできる。「できない」と書くと嘘になるが、黙っていると
    // 実装した日に突然復元できなくなるので、猶予があるうちに改名を勧める。
    console.log('\nいずれ復元できなくなる名前の退避があります: ' + reservedOnly.join(', '));
    console.log('  今は `swap <name>` で復元できますが、将来のサブコマンド用に予約済みの'
      + '名前です。実装された時点で復元できなくなるので、いまのうちに改名してください');
  }
  const replaced = replacedCounts();
  if (replaced.error) {
    // 数えられないことを黙って 0 件として出すと、控えが残っているのに「無い」と読める。
    // status を最後まで出しきったうえで、直し方まで添える(ここで例外にすると、この下の
    // 表示だけでなく、直前に出した対処コマンドの根拠まで画面から消える)。
    console.log('\n退けた旧内容の控えを数えられません(' + replaced.error + ': ' + REPLACED_DIR + ')');
    console.log('  同じ名前のファイルが置かれていないか、ディレクトリの権限を確認してください。'
      + 'この状態では、上書きが起きる操作(退避・切り替え)は控えを残せないため中止されます');
  }
  if (replaced.overwritten > 0) {
    console.log('\n上書きで退けた旧内容: ' + replaced.overwritten + ' 件 (' + REPLACED_DIR + ')');
    console.log('  取り違えて上書きしたときは、ここから accounts/<name>.json へ戻せます');
  }
  if (replaced.unreadable > 0) {
    // 復元先には使えない中身なので、上と同じ「戻せます」の案内に混ぜない。
    // 読めなかった現在の credentials だけでなく、退けた時点で既に壊れていた旧内容も
    // ここに入るので、置き場所は UNREADABLE_BASE 固定ではなくディレクトリで示す。
    console.log('\n復元に使えない控え: ' + replaced.unreadable + ' 件 (' + REPLACED_DIR + ')');
    console.log('  読めなかった現在の credentials か、退けた時点で既に壊れていた旧内容です。'
      + 'accounts/<name>.json へ戻しても復元できません(accessToken を取り出せない中身です)。'
      + '原因を調べ終えたら消して構いません');
  }
  if (!curSlot && cur && saved.length > 0) {
    console.log('\n来歴が未記録です。`swap save <name>` で退避すると、以後どのスロット由来かを記録します');
  }
}

function cmdSave(name, force) {
  if (name) validateName(name);
  // save の --force は「このスロットを上書きしてよい」という明示なので、両方に効かせる。
  // 名前が無いときに `<name>` を埋めた文字列を案内していた頃は、表示どおり打つと
  // validateName が `<name>` を弾いて別のエラーで止まり、控えを残して先へ進む経路に
  // 到達できなかった。名前を省いたまま打てる形をそのまま出す。
  const saved = saveCurrent(name, { unreadable: force, overwrite: force },
    'swap save' + (name ? ' ' + name : '') + ' --force');
  if (!saved) {
    fail('現在 credentials がありません(未ログイン)'
      + '\n  Claude Code で `/login` してから、もう一度 `swap save` を実行してください');
  }
  if (saved.degraded) {
    // README は「切り替え(退避)が起きなかったときは終了コードを成功にしない」と明記している。
    // ここを exit 0 で抜けると、`swap save --force && ...` のようなラッパーが「退避できた」
    // ものとして次へ進み、続く /login が書き込み途中だった正規の credentials を上書きして消す。
    // 理由は unreadableReason で改めて確認する(--force を挟む間にファイルの状態が変わって
    // いることもあるため、saveCurrent の中で見た理由を使い回さない)。
    const why = unreadableReason(CREDENTIALS);
    // /login を勧めてよいのは「待っても直らない」と分かっているときだけ。書き込み途中を
    // 読んだだけなら中身は健全で、数百ミリ秒後には読める。そこで /login をやり直させると、
    // まだスロットへ退避していないアカウントの refreshToken をその時点で捨てさせることに
    // なる(ガード側の案内も同じ理由で /login を最後に置いている)。
    fail('現在の credentials を読めないため、退避しませんでした(' + why.label + ')'
      + '\n  中身の控えは残しました: ' + saved.kept
      + (why.retryable
        ? '\n  時間をおいて `swap save` をやり直してください'
          + '\n  /login はまだ試さないでください(中身が健全なまま読めないだけのことが多く、'
          + 'やり直すと未退避のアカウントには戻れなくなります)'
        : '\n  控えの中身を確認したうえで、`/login` してから `swap save` をやり直してください'));
  }
  console.log('退避しました: ' + saved.name + ' -> ' + accountFile(saved.name));
  reportOtherSlots(saved, null);
}

function cmdSwap(target, force) {
  if (!NAME_RE.test(target)) {
    fail('アカウント名に使えない文字が含まれています: ' + target
      + '\n  使えるのは英数字とハイフン(-)、アンダースコア(_)だけです'
      + '\n  退避済みの名前は、引数なしで swap を実行すると一覧できます');
  }

  const file = accountFile(target);
  if (!fs.existsSync(file)) {
    const saved = savedAccounts();
    if (saved.length > 0) {
      fail('退避されていません: ' + target
        + '\n  利用可能: ' + saved.join(', ')
        + '\n  この中の名前で `swap <名前>` を実行してください');
    } else {
      fail('退避されていません: ' + target
        + '\n  まだ何も退避されていません。先に `swap save` で現在のアカウントを退避してください');
    }
  }

  // 復元先を先に検証する。壊れたファイルで現在のログインを潰さないため
  let next;
  try {
    next = readCreds(file);
  } catch {
    // 例外メッセージは出さない。JSON.parse の失敗文はファイル先頭を引用するため、
    // credentials が相手だとトークンの断片が端末やログに残る
    fail(target + ' の内容が壊れているか、想定した形式ではありません。上書きを中止しました'
      + '\n  ファイル: ' + file
      + '\n  そのアカウントで `/login` し直してから `swap save ' + target + ' --force` で入れ直してください'
      + '\n  上書きで失われた旧内容の控えが残っていれば ' + REPLACED_DIR + ' から戻せることがあります');
  }

  const cur = readCredsOrNull(CREDENTIALS);

  // .current は cmdSwap の中で読み直すたびにディスク I/O が増えるだけでなく、同じ実行の中で
  // 何度も同じ値を評価する取り違え事故(下の forceHint と復元ガードが完全に同一の式
  // `cur && currentSlotOf(cur) === target` を別々に評価していて、片方だけ直す事故につながった)
  // の元にもなる。ここで 1 回だけ読み、以降はこの定数を使い回す。
  // 書き換わる経路(この関数の下にある短絡の writeCurrentSlot、末尾の切り替え仕上げの
  // writeCurrentSlot、および saveCurrent 内部の writeCurrentSlot)はすべてこのキャッシュより
  // 後にあるので、キャッシュした値を使ってよいのはそれより前の評価に限る
  // (curSlot 自身も readCurrentSlot、curSlotOf も currentSlotOf と同じ計算式)。
  const curSlot = readCurrentSlot();
  const curSlotOf = curSlot || (cur && cur.json ? accountNameOf(cur.json) : null);

  // 中身が同じなら復元しても認証は何も変わらないので、credentials には触らず来歴だけ合わせる。
  // 「credentials は書けたが .current の書き込みで落ちた」中断状態も、再実行がここに来て
  // 自動的に直る(来歴が古いまま退避へ進むと、別アカウントのスロットを上書きしかねない)。
  //
  // この短絡は復元先の健全性チェック(失効済み・refreshToken 欠け・subscriptionType 欠け)より
  // 前に置く。それらは「これから上書きする内容が使えるか」を見る門であって、上書きが起きない
  // この経路には関係がない。順番が逆だと、既にそのスロットと同じ内容でログインしているのに
  // 「失効しています」で中止し、来歴の自己修復まで飛ばしてしまう。来歴が古いまま残ると、
  // 次の `swap save` が別のスロットを狙って、そこにある唯一の退避を上書きしかねない。
  if (cur && sameCreds(cur.json, next.json)) {
    // ここでの来歴書き込みは自己修復なので、失敗しても中止しない。認証は既に target と
    // 同じで、何も壊れていない。中止すると「同じ内容でログイン済み」という結論のほうが
    // 伝わらなくなる。
    let noteError = null;
    if (curSlot !== target) {
      try {
        writeCurrentSlot(target);
      } catch (e) {
        noteError = dropCurrentSlot(e);
      }
    }
    console.log('すでに ' + target + ' と同じ内容でログインしています。認証は変更しませんでした');
    if (noteError) console.log('  ' + noteError);
    return;
  }

  // 案内に出すコマンドが、その先のガードでそのまま通るかどうか。効くのは 2 種類あり、
  // 向きが逆なので、案内する場所ごとに書いていると片方だけ直して他が古いままになる。実際
  // この取り違えで「案内どおり打つと必ず中止される」事故が、復元の案内・退避の案内・
  // 切り替え後の戻し方でそれぞれ再現した。値も文字列の組み立ても、ここ 1 箇所に集める。
  //   復元側 … 同一プラン・失効済み・refreshToken 欠け・subscriptionType 欠けのどれかで止まる
  //   退避側 … 来歴が一致していてもプラン種別が食い違えば止まる
  const planned = cur ? planDiffers(cur.json, next.json) : false;

  // そのスロットを `swap <name>` で復元するとき --force が要るか。復元の手前にあるガードは
  // 4 つあり、どれか 1 つでも当たれば --force なしでは中止される。以前は同一プランだけを
  // 見ていたため、失効した退避に対して `swap <name>` とだけ案内し、そのとおり打った人が
  // 「失効しています」で二度目の中止に当たっていた。判定はこの関数だけが持つ。
  const needsForceToRestore = (fromJson, slotJson) => {
    if (!slotJson) return true;
    if (isExpired(slotJson) || !refreshTokenOf(slotJson) || !subscriptionTypeOf(slotJson)) return true;
    return fromJson ? !planDiffers(fromJson, slotJson) : false;
  };
  // 向きで判定が変わるので 2 つ持つ。読み込み済みの中身をそのまま渡すのは、target は next として
  // 既に読んであり、戻す先は今の cur そのものだから(同じファイルを読み直しても結果は変わらない)。
  //   restoreCmd     … いま target を復元する向き(現在は cur)
  //   restoreBackCmd … 切り替えたあと元へ戻す向き(そのときの現在は next で、復元先は cur の内容)
  const restoreCmd = 'swap ' + target
    + (needsForceToRestore(cur ? cur.json : null, next.json) ? ' --force' : '');
  const restoreBackCmd = (name) => 'swap ' + name
    + (needsForceToRestore(next.json, cur ? cur.json : null) ? ' --force' : '');
  // 唯一の呼び出し元(下の「すでに復元済み」案内)は常に名前を省いて呼ぶ(退避名は
  // saveCurrent が来歴/subscriptionType から決めるので、ここでは決め打ちできない)。
  const saveCmd = 'swap save' + (planned ? ' --force' : '');

  // 案内する --force が、そのあとの退避まで通るかどうか。素の `swap <target> --force` が
  // 途中で止まる理由は 3 つあり、どれも --force では解けず、先に名前を決めて退避すれば抜ける。
  //   needsName    … 退避名を決められない(来歴も subscriptionType も無い)
  //   sameAsTarget … 退避先が復元元と同じ名前になる(--force でも復元元を上書きするだけ)
  //   saveBlocked  … 退避先に別の認証情報が入っている(ここでの --force は復元側の判断で、
  //                  saveCurrent へは overwrite: false で渡すため、saveInto の上書きガードに当たる)
  // 3 つとも「案内どおり打つと退避の段で二度目の中止に当たる」同じ事故になるので、判定も
  // 文面も 1 箇所で組み立てる(needsName だけ下の !planned 分岐が持っていた頃は、失効・
  // refreshToken 欠け・subscriptionType 欠けの 3 経路が素の --force を案内して行き止まりだった)。
  // 退避名は saveCurrent が来歴/subscriptionType から決めるので curSlotOf と同じ。判定は
  // saveInto と同じ overwriteGate に通し、条件を書き写さない。
  const needsName = !!cur && !curSlotOf;
  const sameAsTarget = !!cur && curSlotOf === target;
  const saveBlocked = !!(cur && curSlotOf && overwriteGate(cur, curSlotOf, curSlot).blocked);
  const saveFirst = needsName || sameAsTarget || saveBlocked;
  // 名前を明示するのは needsName のときだけ(そこは「決められない」ので人に決めてもらう)。
  // 残る 2 つは既存のスロットに触らせないことが目的なので <別名> と書く。
  const saveFirstCmd = 'swap save ' + (needsName ? '<name>' : '<別名>');
  const saveFirstWhy = needsName
    ? '\n  (現在のログインは退避名を決められない状態です'
      + '(subscriptionType が読めず、来歴も記録されていません)。'
      + '先に名前を明示して退避しないと、--force を付けても退避の段で止まります)'
    : saveBlocked && !sameAsTarget
      ? '\n  (退避先 ' + curSlotOf + ' には現在と違う認証情報が入っているため、'
        + '名前を分けないと --force を付けても退避の段で止まります)'
      // sameAsTarget の理由は、この案内を出す側の文面が既に説明している
      : '';
  const forceHint = saveFirst
    ? '\n  現在のログインはそのままです。先に退避してから、承知のうえで復元してください:'
      + '\n    ' + saveFirstCmd
      + '\n    swap ' + target + ' --force'
      + saveFirstWhy
    : '\n  現在のログインはそのままです。承知のうえで復元するなら: swap ' + target + ' --force';

  // 失効済みの復元先は切り替える前に止める。上書きしてから気づいてもマシン全体が
  // 未ログインになっており、稼働中の別セッションも次のリクエストで認証エラーになる。
  if (isExpired(next.json) && !force) {
    fail(target + ' の refreshToken は失効しています。復元しても /login のやり直しになるため中止しました'
      + forceHint);
  }

  // refreshToken が無い中身は復元しても認証を更新できない。readCreds は accessToken しか
  // 見ないので黙って通り、数時間後に accessToken が切れた時点でマシン全体が認証エラーになる
  // (そこから戻す手段は /login しかない)。失効済みと同じ重さなので手前で止める。
  if (!refreshTokenOf(next.json) && !force) {
    fail(target + ' には refreshToken がありません。復元しても認証を更新できず、accessToken が'
      + '切れた時点で /login のやり直しになります'
      + forceHint);
  }

  // subscriptionType が無い中身を復元すると、account-guard は現在のアカウントを判別できず
  // (currentAccount が unknown を返す)、保護ツリーへの操作をすべて拒否し続ける。
  // 切り替えてから気づくと、元に戻す操作まで巻き添えで拒否されるので手前で止める。
  if (!subscriptionTypeOf(next.json) && !force) {
    fail(target + ' には subscriptionType がありません。復元すると account-guard がアカウントを'
      + '判別できなくなり、保護ツリーへの操作がすべて拒否されます'
      + forceHint);
  }

  const provenance = curSlot;
  // cur が無い(未ログイン・読めない)ときは「すでに復元済み」とは言えない。来歴だけを見て
  // ここで止めると、credentials を失った人が退避を復元できない行き止まりになる。
  if (cur && provenance === target && !force) {
    // 来歴が一致していて中身が違う理由は 2 つあり、どちらかは判別できない。
    //   a) 退避したあとトークンがローテートした … 現在のほうが新しく、復元は退化にしかならない
    //   b) このツールを通さずに /login した … 現在は別アカウントで、退避を復元したい
    // 既定は何もしない側(a を壊さない)に倒すが、「何もしません」で終えると b の人が
    // 抜け出せなくなる(--force も同じ文言で止まっていた)。両方の次の一手を必ず出す。
    //
    // 案内は標準出力に出すが、終了コードは失敗にする。要求された切り替えは起きていないので、
    // 成功で返すと `swap team && claude -p ...` のようなラッパーや、結果を一覧にする道具が
    // 別のアカウントのまま次の処理へ進む(枠を消費する ping まで巻き添えになる)。
    console.log('すでに ' + target + ' から復元した状態です。認証は変更しませんでした');
    console.log('  ただし現在の内容は ' + target + ' の退避と一致しません。退避のあとトークンが'
      + '更新されたか、このツールを通さずに /login した可能性があります');
    console.log('  現在のログインのほうが新しいなら、退避を最新にします:');
    console.log('    ' + saveCmd);
    console.log('  ' + target + ' の退避に戻したいなら、先に現在を別名へ退避してから復元します:');
    console.log('    swap save <別名>');
    console.log('    ' + restoreCmd);
    if (!planned) {
      console.log('  (同じプランなので別アカウントだと確認できません。--force はそれを承知で'
        + '復元するという意味です)');
    }
    // process.exit だと、Windows でパイプへ流している場合に直前の console.log がまだ書き終わって
    // おらず、肝心の次の一手が切れて届かないことがある。exitCode を立てて自然に抜ければ、
    // 出力を出し切ってから同じ終了コードで終わる。
    process.exitCode = 1;
    return;
  }

  // 退避先が復元元と同じファイルになる場合は、名前を分けてもらう。--force で押し切っても
  // 「復元元を上書きしてから、その上書きした内容を復元する」か「来歴が実体と食い違う」かの
  // どちらかにしかならない。別名で退避すれば何も壊さずに切り替えられるので、その手順を出す。
  // 次の同一性の判定より先に置くのは、そちらの案内(--force)がこの状況では効かないため。
  if (cur && curSlotOf === target) {
    fail('現在のログインの退避先が復元元(' + target + ')と同じ名前になります'
      // 「別のアカウント」とまでは証明できない(同じアカウントの古い退避かもしれない)。
      // 確かなのは現在と違う認証情報が入っていることなので、そこまでしか言わない。
      + '\n  ' + target + ' には現在と違う認証情報が入っているため、このままでは復元元を上書きします'
      + '\n  先に別名で退避してください(既存のスロットには触りません):'
      + '\n    swap save <別名>'
      + '\n  そのあと切り替えられます:'
      + '\n    ' + restoreCmd
      + (planned
        ? ''
        : '\n  (プラン種別が同じか読めないため別アカウントだと確認できません。'
          + '--force はそれを承知で復元するという意味です)'));
  }

  // 復元先が「別アカウント」だと証明できないときは黙って進まない。同一プランの別アカウントと
  // 「同じアカウントの古い退避」は原理的に見分けられず(冒頭の 2)、後者だと切り替えたつもりで
  // ローテート前のトークンに退化し、稼働中のセッションが次のリクエストで認証エラーになる。
  // 来歴の有無で判断を変えないのは、来歴が語るのは現在のログインの出どころだけで、復元先が
  // 何者かについては何も証明しないため(来歴が第三のスロットを指していても不確かさは同じ)。
  //
  // 逆に、プラン種別が食い違えば安全というわけでもない。planDiffers が証明するのは
  // 「同じ世代ではない」までで、同じアカウントの昇格前(Pro → Max)の退避でも真になる。
  // そこでも復元は退化になる。ただしここで止めると日常の切り替えが常に --force を要求し、
  // 旗の意味が摩耗して本当に危ない場面でも素通りするので、進む代わりに戻し方を必ず添える
  // (この時点で現在のログインは退避済みなので、元に戻す手は必ず残っている)。
  if (cur && !force && !planned) {
    const type = subscriptionTypeOf(cur.json);
    // 案内する --force が退避の段で止まらないかは、上の forceHint と同じ判定
    // (saveFirst / saveFirstCmd / saveFirstWhy)をそのまま使う。ここだけ別に組み立てていた
    // 頃は、needsName をこちらしか見ておらず forceHint 側が行き止まりの案内を出していた。
    fail(target + ' が現在のログインとは別のアカウントだと確認できません'
      + (type ? '(どちらも ' + type + ')' : '(プラン種別を読めないため比較できません)')
      + '\n  同じアカウントの古い退避だった場合、復元するとローテート前のトークンに戻り、'
      + '認証が通らなくなることがあります'
      + '\n  現在のログインはそのままです'
      + '\n  別のアカウントだと分かっているなら(現在のログインは退避してから切り替えます):'
      + (saveFirst
        ? '\n    ' + saveFirstCmd + '\n    swap ' + target + ' --force' + saveFirstWhy
        : '\n    swap ' + target + ' --force')
      + '\n  同じアカウントなら、復元ではなく退避を最新にするだけで済みます:'
      // saveBlocked のときは素の `swap save` も同じ上書きガードで止まる。ここは「同じ
      // アカウントなら」という前提の下の案内なので、上書きを承知する --force を添えてよい。
      + '\n    swap save' + (needsName ? ' <name>' : '') + (saveBlocked ? ' --force' : ''));
  }

  // 現在を退避してから差し替える。この退避が唯一のバックアップなので、失敗したら進まない。
  // 上書きは許可しない: ここでの --force は「復元先が失効済みでも進む」「読めない現在を
  // 諦めて進む」という復元側の判断であって、退避先に入っている別アカウントを潰してよいとは
  // 言っていない(退避名はプラン種別から決まることがあるので、無関係なスロットに当たりうる)。
  // restoreCmd を afterCmd として渡す。プラン種別が食い違う組み合わせでは手前のガードが
  // 1 つも発火しないまま(planned が真なので !planned の分岐にも入らない)ここへ来るので、
  // 上書きガードに当たったときの案内が、その切り替えに対する唯一の案内になる。退避の手順だけ
  // では要求された切り替えが終わらないため、続けて打つコマンドまで出す。
  const saved = saveCurrent(null, { unreadable: force, overwrite: false },
    'swap ' + target + ' --force', cur, restoreCmd);
  if (!saved) {
    console.log('現在ログインしていないため、退避はしません');
  } else if (saved.degraded) {
    // degraded は「読めなかった」であって「中身が無価値」ではない。権限・他プロセスのロック・
    // 書き込み途中でも degraded になるのに「復元に使える形ではない」と断定していた頃は、
    // 未退避のアカウントの唯一のコピーが .replaced に控えとして残っているのに、それを
    // 無価値だと言い切っていた(unreadableReason も credentialsState も、まさにその断定を
    // 避けるために作ってある)。cmdSave と同じく理由を読み直して添える。
    const why = unreadableReason(CREDENTIALS);
    console.log('現在の credentials を読めなかったため、退避しませんでした(' + why.label + ')');
    console.log('  中身の控え: ' + saved.kept);
    console.log(why.retryable
      ? '  中身は健全なまま読めなかっただけのことがあります。この控えは消さないでください'
      : '  この控えは復元には使えません(accessToken を取り出せない中身です)');
  } else {
    console.log('退避: ' + saved.name);
  }

  // ここで落ちる原因は、たいてい Windows で移動先を他プロセスが掴んでいること
  // (writeAtomic の rename が EPERM で落ちる。稼働中の Claude Code が典型)。捕まえないと、
  // 直前に「退避: <name>」とだけ出したあと生の Node 例外で終わり、切り替わったのか退避だけ
  // 済んだのかが文面から読み取れない。keepAside の copyFileSync には理由と対処を添えているのに、
  // 最も EPERM を踏みやすいこの呼び出しだけが素通しになっていた。
  try {
    writeAtomic(CREDENTIALS, next.raw);
  } catch (e) {
    fail('認証情報の差し替えに失敗しました(' + (e.code || e.message) + ')'
      + '\n  ' + CREDENTIALS + ' を書き換えられません。稼働中の Claude Code など、このファイルを'
      + '掴んでいるプロセスを終了するか、読み取り専用属性を外してください'
      + '\n  認証は切り替わっていません'
      + (saved && saved.name
        ? '(現在のログインは ' + saved.name + ' へ退避済みで、失われたものはありません)'
        : '')
      + '\n  原因を取り除いてから、もう一度 `swap ' + target + (force ? ' --force' : '') + '` を実行してください');
  }
  // ここから先は差し替えが済んでいる = 認証はもう切り替わっている。来歴を書けなかった
  // からといって中止すると、生の例外だけを見た利用者が「切り替わらなかった」と読んで
  // やり直し、今度は新しいアカウントを旧スロットへ退避してしまう。切り替えの事実は必ず出す。
  let currentNote = null;
  try {
    writeCurrentSlot(target);
  } catch (e) {
    currentNote = dropCurrentSlot(e);
  }
  console.log('切り替え: ' + ((saved && saved.name) || 'なし') + ' -> ' + target + expiryNote(next.json));
  console.log('注意: この変更はマシン全体に即座に効きます。稼働中の別セッションも切り替わります');
  if (currentNote) {
    console.log('  切り替え自体は済んでいます。ただし' + currentNote);
  }

  // 戻し方は毎回出す。復元先が「同じアカウントのプラン変更前の退避」だった場合(planDiffers は
  // それを別アカウントと区別できない)、切り替えた瞬間に全セッションが認証エラーになるが、
  // 直前の退避があるので戻すだけで復旧できる。知らなければ /login をやり直すことになる。
  // --force の要否は切り替え前と同じ(planDiffers は向きを問わない)。素の名前だけを出して
  // いたため、同一プラン同士の切り替え(--force でしか通れない)のあとに案内どおり打つと
  // 「別のアカウントだと確認できません」で必ず中止されていた。
  // saved.name が同じである限り restoreBackCmd(saved.name) は同じ文字列を返すので、
  // 案内 2 箇所(直後の「元に戻すには」と reportOtherSlots への引き渡し)で 1 回だけ評価する。
  const backCmd = saved && saved.name ? restoreBackCmd(saved.name) : null;
  if (backCmd) {
    console.log('  元に戻すには: ' + backCmd);
  }

  // 取り残された他スロットの案内は切り替えの「あと」に出す。切り替え前に出していた頃は
  // 案内の意味が反対になっていた(reportOtherSlots のコメント参照)。戻る手順を添えて渡す。
  if (saved && saved.name) reportOtherSlots(saved, backCmd);
}

function usage() {
  console.log(`Claude のログインアカウントを切り替える

  swap                 現在のアカウントと退避済み一覧を表示
  swap <name>          現在を退避してから <name> を復元
  swap <name> --force  復元先が失効済み・判別不能・同一プランでも中止せずに切り替える
                       現在の credentials が読めない場合も、控えを残して進む
                       (退避先に別のアカウントが入っている場合は上書きせずに中止する。
                        それを許すのは swap save <name> --force だけ)
  swap save [<name>]   現在のアカウントを退避するだけ(切り替えない)
                       名前を省略すると来歴(前回のスロット名)か subscriptionType を使う
  swap save <name> --force
                       別の認証情報が入っているスロットでも上書きする

退避先: ${ACCOUNTS_DIR}
現在のログインがどのスロット由来かは ${CURRENT_FILE} に記録します。
上書きで失われる旧内容は ${REPLACED_DIR} に控えを残すので、
取り違えて上書きしても accounts/<name>.json へ戻せば復旧できます。

タイマーやフックから自動実行しないこと。認証の入れ替えはマシン全体に即座に効き、
稼働中の別セッションを巻き込みます(docs/account-separation.md §1.3 / §6.1)。`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) return cmdStatus();
  // --force はサブコマンド判定より前に、置かれた位置に関わらず取り除く。以前は rest
  // (第一引数の後ろ)からしか探していなかったため、`swap --force team` のように第一引数の
  // 位置に置くと --force がサブコマンド名として解釈され、`swap save --force team` と
  // 同じ意図で打っても「引数が多すぎます」で止まっていた。
  // スロット名として文字どおり "--force" を使いたい場合との衝突は起きない: ここで無条件に
  // 取り除く以上、"--force" という文字列が cmd や extra に残ることは無く、validateName まで
  // 届かない(NAME_RE 単体は "--force" を弾かないが、CLI の入り口で先に消費される)。
  const force = args.includes('--force');
  const rest0 = args.filter(a => a !== '--force');
  if (rest0.length === 0) {
    // --force だけを渡された(適用対象が無い)。cmdStatus に横流しすると
    // 「引数が無いので状態表示」と「--force だけ渡した」が区別できず、typo に気づけない。
    fail('--force を付けるコマンドがありません'
      + '\n  `swap <name> --force` または `swap save --force` の形で指定してください');
  }
  const [cmd, ...rest] = rest0;
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') return usage();
  const extra = rest;
  // 余分な引数は typo の兆候なので黙って捨てない(save は名前を 1 つだけ取る)
  if (cmd === 'save') {
    if (extra.length > 1) {
      fail('引数が多すぎます: ' + args.join(' ')
        + '\n  `swap save` が取る名前は 1 つだけです。`swap save <名前>` の形で指定し直してください');
    }
    return cmdSave(extra[0], force);
  }
  if (extra.length > 0) {
    fail('引数が多すぎます: ' + args.join(' ')
      + '\n  `swap <名前>` の形で名前を 1 つだけ指定してください。使い方は `swap help` で確認できます');
  }
  return cmdSwap(cmd, force);
}

try {
  main();
} catch (e) {
  fail(e.message);
}
