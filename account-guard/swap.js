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
  || typeof credentials.probeFile !== 'function'
  || typeof credentials.subscriptionTypeOf !== 'function'
  || typeof credentials.hasUsableCredentials !== 'function'
  || typeof credentials.hasRecoverableToken !== 'function'
  || typeof credentials.rawHasRecoverableToken !== 'function'
) {
  fail('swap.js の隣にある credentials.js の形式が想定と違います'
    + '\n  (' + path.join(__dirname, 'credentials.js') + ')'
    + '\n  HOME / CREDENTIALS / readCredentials / probeFile / subscriptionTypeOf / '
    + 'hasUsableCredentials / hasRecoverableToken / rawHasRecoverableToken のいずれかが欠けているか、'
    + '期待する型ではありません'
    + '\n  swap.js と対応する版の credentials.js を同じディレクトリへ置き直してください');
}
const {
  HOME, CREDENTIALS, readCredentials, probeFile, subscriptionTypeOf, hasUsableCredentials,
  hasRecoverableToken, rawHasRecoverableToken,
} = credentials;

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

// `swap <name>` を「打てるコマンド」として案内してよいか。validateName は新規作成しか
// 弾かない(既存ファイルがあれば素通しする)ので、予約語チェックより前に作られた
// accounts/save.json のようなスロットは今も一覧に残り、退避先として自動で選ばれもする。
// その名前をそのまま案内すると、打った人には復元ではなく save サブコマンドが走り、
// 切り替わっていないのに exit 0 で終わる(ラッパーは戻したつもりで戻れていない)。
// 案内文へスロット名を埋め込む箇所は必ずここを通す。判定は cmdStatus の「復元できない
// 名前の退避があります」と同じ集合を見る(同じ規則を別の場所へ書き写すと、片方だけ直る)。
function restorableByName(name) {
  return !DISPATCHED_NAMES.has(name);
}

// 復元できない名前のスロットに残された唯一の抜け道。ファイルは無事なので、改名すれば
// そのまま復元できる(/login のやり直しは要らない)。cmdStatus と同じ内容を、案内 1 件ぶんの
// 文面としてここから出す。
function renameToRestoreText(name) {
  return 'swap のサブコマンドと同じ名前なので `swap ' + name + '` では復元できません'
    + '(accounts/' + name + '.json を別の名前へ改名してください)';
}
const DAY_MS = 86400000;

// fail は「戻らない」前提で各所から呼ばれているので、exitCode を立てて return する形には
// できない(呼び出し元がそのまま先へ進んでしまう)。そのぶん出力側で取りこぼしを防ぐ:
// Windows では出力先がパイプ(`swap team 2>&1 | tee log` など)だと書き込みが非同期になり、
// console.error の直後に process.exit すると理由の文面が途中で切れて届かない。fs.writeSync は
// 書き終わってから戻るので、直後に exit しても最後まで残る。
// 文面を出すところまで。stdout に既に何かを出している場所では、process.exit が直前の
// console.log を切ることがあるので、そこではこちらで出して exitCode を立て、自然に抜ける
// (cmdSwap の「別アカウントだと確認できません」案内と同じ扱い)。
function failText(msg) {
  const line = 'エラー: ' + msg + '\n';
  try {
    fs.writeSync(2, line);
  } catch {
    // fd が非ブロッキングで EAGAIN になる等、writeSync が使えない環境では従来どおりに出す
    // (切れる可能性は残るが、何も出ないよりはよい)
    process.stderr.write(line);
  }
}

function fail(msg) {
  failText(msg);
  process.exit(1);
}

// スロット名の検証は 1 箇所に集める。cmdSave と cmdSwap で条件がずれると、片方では作れるのに
// もう片方では扱えない名前ができる(実際、予約語の判定が save 側に無かったため
// `accounts/save.json` を作れてしまい、復元できないスロットが残せた)。
// 予約語の判定は「新しいスロットを作らせない」ためのものなので、既に実在するスロットには
// 効かせない。書き戻しても復元手段の有無は変わらず(復元できない名前なら、退避を止めた
// ところで既にできない)、止めることで失うものだけがある。一律に弾いていた頃は、`swap warmup`
// で復元して来歴が warmup を指したあと、名前を省いた退避 — cmdSwap が切り替えの前に必ず通る
// 退避 — がここで止まり、以後どのアカウントへも切り替えられなくなっていた(抜けるには手で
// .current を消すしかなく、案内は「別の名前を指定してください」としか言わない)。
// 実在確認は probeFile に通す(規則1)。existsSync だと権限やロックで読めないだけのスロットが
// 「無い」に倒れ、実在するのに新規作成として弾かれて同じ行き止まりへ戻る。
function validateName(name) {
  if (!NAME_RE.test(name)) {
    fail('アカウント名に使えない文字が含まれています: ' + name
      + '\n  使えるのは英数字とハイフン(-)、アンダースコア(_)だけです'
      + '\n  別の名前で `swap save <名前>` を実行し直してください');
  }
  if (RESERVED_NAMES.has(name) && !probeFile(accountFile(name)).exists) {
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
// 返り値の verdict は「中身について何を確認できたか」を表し、案内の方向を決める。以前は
// 「待てば直りうるか」(retryable)で分けていたが、待てば直るかはこのツールには分からない。
// 推測で分けた結果、永久に直らない状態へ「時間をおいてやり直してください」を出し続ける
// 無限ループと、そこから抜ける手順が反対側の分岐にしか無い行き止まりを両方作った。
// 時間についての推測をやめ、確認できた事実だけで分ける。待てば直るケースは、案内に共通で
// 添える「もう一度実行しても同じなら」の一文が、分岐を増やさずに吸収する。
// 語彙は account-guard.js の credentialsState() に揃える。同じ状態を 2 つのツールが別の
// 名前で呼び、別の対処を案内していたことが、繰り返した食い違いの元だった。
//   usable     … 読み直したら健全に読めた(推測ではなく事実)。/login を勧めてはいけない
//   stale      … accessToken は無いが refreshToken は残る。交換すればまた使える
//   unusable   … 中身を確認したうえで、復元に使えるものは無いと言い切れる
//   unreadable … 中身を確認できていない。使えるとも使えないとも言えず、控えは消させない
// このファイルを他のプロセスが書き換えうるか。書き換えうるのは Claude Code が更新する
// CREDENTIALS だけで、スロット(accounts/<name>.json)も .replaced の控えも、writeAtomic の
// rename か 1 回きりの copyFileSync でしか書かれない。この違いは verdict を変えない
// (どちらも中身は確認できていない)が、原因の手掛かりとして label の文面だけを分ける。
function isLiveCredentialsFile(file) {
  return file === CREDENTIALS;
}
// verdict のほかに、案内を組み立てる側が必要とする事実を 2 つ添える。verdict だけを見て
// 文面を決めていた頃は、呼び出し側が「読めない = accessToken 欠け」と決め打ちし、開くことすら
// できないファイルにも「--force を付ければ控えが残ります(refreshToken を取り出せます)」と
// 約束していた(実際には copyFileSync が同じ理由で落ち、控えは 1 つも残らない)。
//   copyable … バイト列としては読めた = keepAside で控えを取れる。約束してよいのはこのときだけ
//   hasToken … その中身に refreshToken が残っている = /login で上書きさせてはいけない
// hasToken の判定は credentials.js の rawHasRecoverableToken に合流させる(ここで書き起こすと、
// account-guard.js の credentialsState() と同じ状態を別の基準で分類する食い違いが戻る)。
function unreadableReason(file) {
  const live = isLiveCredentialsFile(file);
  // 読み取りは probeFile に一本化する。ここで readFileSync を書き起こしていた頃は、
  // 「無い」と「読めない」の区別がこの関数にしか無く、existsSync で判断する他の
  // 呼び出し元(writeSlot / saveCurrent など)がその区別を持たないまま素通ししていた。
  const p = probeFile(file);
  if (!p.readable) {
    if (!p.exists) {
      // 呼び出し元は存在を確かめてから呼ぶので、ここへ来るのは直後に消えたとき。中身を
      // 一度も見ていない以上「無価値」とは言い切れない(unusable は控えを消させる)。
      return { label: 'ファイルがありません', verdict: 'unreadable', copyable: false, hasToken: false };
    }
    // EISDIR / ENOTDIR は「そこに読めるファイルが無い」の変種。同じ名前のディレクトリが
    // 置かれている(あるいは途中の要素がファイルになっている)ことが原因で、一過性の
    // ロックとは種類が違うが、中身を確認できていない点では同じ扱いになる。
    if (p.code === 'EISDIR' || p.code === 'ENOTDIR') {
      return {
        label: '読み取りに失敗しました(' + p.code + ')。'
          + '同じ名前のディレクトリが置かれていないか確認してください',
        verdict: 'unreadable',
        copyable: false,
        hasToken: false,
      };
    }
    // ENOENT 以外の読み取り失敗(EBUSY・EPERM・EACCES など)。ウイルス対策やバックアップ
    // ツールが一時的に掴んでいるだけのことも、恒久的な権限問題のこともあり、ここでは
    // 区別できない。account-guard.js の credentialsState() も同じ状況を 'unreadable'
    // (中身の価値は判断できない)に分類する。待つ以外の対処も文面に添える。
    return {
      label: '読み取りに失敗しました(' + p.code + ')。掴んでいるプロセスを終えるか、権限を確認してください',
      verdict: 'unreadable',
      copyable: false,
      hasToken: false,
    };
  }
  if (p.parseError) {
    // 途中まで書かれたファイルは JSON として壊れて見える。切れ目より手前に refreshToken が
    // 残っていることがあるので、パースできなかったことを「中身が無い」の証拠にはしない。
    // live かどうかは原因の心当たりを変えるだけで、確認できていない事実は変わらない。
    return {
      label: live ? '壊れているか、他のプロセスが書き込み中' : '壊れています(JSON として読めません)',
      verdict: 'unreadable',
      copyable: true,
      hasToken: rawHasRecoverableToken(p.raw),
    };
  }
  if (!hasUsableCredentials(p.json)) {
    // accessToken が無くても refreshToken が残っていることがある(書き込み途中が典型)。
    // refreshToken は交換すればまた使える資格情報なので、accessToken だけが欠けた状態を
    // 「失って困るものは無い」側の unusable と同じに扱ってはいけない。account-guard.js の
    // credentialsState() も同じ状況を stale として分けており、swap 側だけが粗いままだと、
    // ガードは /login を勧めないのに swap は勧める、という食い違いが起きて refreshToken を失う。
    if (hasRecoverableToken(p.json)) {
      return {
        label: 'claudeAiOauth.accessToken がありません(形式が想定と違います)。'
          + 'ただし refreshToken は残っています(交換すればまた使えます)',
        verdict: 'stale',
        copyable: true,
        hasToken: true,
      };
    }
    // JSON として読めたうえで、交換できるトークンも無い。「復元に使えない」と言い切れるのは
    // 中身を最後まで確認できたこの経路だけで、控えを消してよいと案内できるのもここに限る。
    return {
      label: 'claudeAiOauth.accessToken がありません(形式が想定と違います)',
      verdict: 'unusable',
      copyable: true,
      hasToken: false,
    };
  }
  // ここへ来る = 読み直した時点では健全に読める。cmdSave は --force を挟んでから改めて
  // この関数を呼ぶ設計なので、その間にロック(や書き込み)が解けていれば必ずここに落ちる。
  // 「待てば直るかもしれない」という推測ではなく「いま読めた」という事実なので、案内も
  // 推測ではなく事実として出す。ここで /login を案内すると、健全な credentials を前に
  // 未退避アカウントの refreshToken を捨てさせることになる。
  return {
    label: 'いまは健全に読めています(先ほど読めなかった理由は特定できません)',
    verdict: 'usable',
    copyable: true,
    // 健全に読めても refreshToken を持たない形はありうる(accessToken だけの構造)。
    // 事実を確かめずに true を返すと、将来この verdict を案内に通したときに
    // 「refreshToken が残っています」と嘘をつく。
    hasToken: !!refreshTokenOf(p.json),
  };
}

// 「現在のログイン」を、復元ガードが門番に使える形で読む。cmdSwap は cur が null のときだけ
// ガードを素通しする設計なので、1 回目の読み取りがたまたま失敗しただけの状態を null のまま
// 進めると、来歴一致・退避先が復元元と同じ・同一プランで別アカウント未確認の 3 つが同時に
// 外れる。実際、credentials の 1 回目の read にだけ EBUSY を注入すると(Windows で稼働中の
// Claude Code やウイルス対策が一瞬掴む状況)、`swap <いま居るスロット>` が「切り替え: X -> X」と
// 表示しながら読み込み済みの旧内容をマシン全体へ書き戻し、exit 0 で終わっていた
// (ローテート前のトークンへ退化する。このツールが防ごうとしている事象そのもので、exit 0 な
// ぶんラッパーも異常に気づけない)。
// unreadableReason が 'usable' を返すのは「いま読み直せば健全に読めた」という事実なので、
// それに従って 1 度だけ読み直す。cmdSave は同じ状況を「いまは読めています。そのまま
// もう一度実行してください」と案内しており、読み直す判断はそこと揃う。
//   cur … 読めた現在のログイン(null なら未ログイン、または読めない)
//   why … cur が null で、かつファイルは在るときの理由(未ログインなら null)
function readCurrentForGuard() {
  const cur = readCredsOrNull(CREDENTIALS);
  if (cur) return { cur, why: null };
  if (!probeFile(CREDENTIALS).exists) return { cur: null, why: null }; // 単に未ログイン
  const why = unreadableReason(CREDENTIALS);
  if (why.verdict !== 'usable') return { cur: null, why };
  // 読み直しても取れなければ、その隙にまた掴まれたということ。理由を取り直して「読めない」
  // として扱う(null のまま進めると、上に書いたガードの素通しが再発する)。
  const again = readCredsOrNull(CREDENTIALS);
  if (again) return { cur: again, why: null };
  // 3 度目の理由をそのまま返すと、その瞬間だけ読めたときに verdict が 'usable' で戻り、
  // 呼び出し側が「読めません(いまは健全に読めています)」という自己矛盾した案内を出す。
  // 4a5e753 が消したのは一過性が 1 度きりの場合で、2 度続くとこの経路から戻ってくる。
  // ここまで来た事実は「読めたり読めなかったりする」なので、そう名乗らせる。中身について
  // 分かったこと(控えを取れる/refreshToken が残っている)は probe で確かめた事実なので保つ。
  const last = unreadableReason(CREDENTIALS);
  if (last.verdict !== 'usable') return { cur: null, why: last };
  return {
    cur: null,
    why: {
      label: '読めたり読めなかったりします(他のプロセスが断続的に掴んでいる可能性があります)',
      // 中身を最後まで確認できていない以上 unusable ではない(控えを消させない側に倒す)。
      verdict: 'unreadable',
      copyable: last.copyable,
      hasToken: last.hasToken,
    },
  };
}

// 残した控えをどう扱えばよいかの案内。verdict から 1 箇所で決める。この判断が cmdSwap と
// cmdStatus に分かれて書かれていた頃は、同じ控えに一方が「消さないでください」、他方が
// 「消して構いません」と案内していた。「消して構いません」と言えるのは、中身を最後まで
// 確認できた unusable だけで、読めなかった控え(unreadable)は未退避アカウントの唯一の
// コピーでありうる以上、消させない。
function keptNote(verdict) {
  if (verdict === 'usable') {
    return 'いまは読めています。中身は健全なので、この控えは消さないでください';
  }
  if (verdict === 'stale') {
    return 'accessToken が無いため、そのままでは accounts/<name>.json へ戻しても復元できませんが、'
      + 'refreshToken は交換すればまた使えます。消さないでください';
  }
  if (verdict === 'unusable') {
    return 'この控えは復元には使えません(accessToken を取り出せない中身です)';
  }
  return '中身を確認できていません。健全なアカウントの唯一のコピーである可能性があるため、'
    + '原因が分かるまで消さないでください';
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
// 実在するスロットに大小違いで当たる場合は、そちらの名前に揃える(canonicalSlotName)。
// ここで揃えないと、大小を無視するファイルシステムで `swap save Pro` と作ったスロットに対して
// この関数が返す小文字の 'pro' が同じファイルを指しながら別名として比較され、退避先が同じ
// なのに sameAsTarget も provenance も成立しない状態が生まれる。
function accountNameOf(json) {
  const t = subscriptionTypeOf(json);
  if (!t) return null;
  const safe = t.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe ? canonicalSlotName(safe) : null;
}

// 書き込み途中で電源が落ちても credentials を壊さないよう、一時ファイル経由で差し替える。
// 中身は平文トークンなので tmp の時点から 0600 にする。前回の残骸が居ると writeFileSync の
// mode は効かない(mode は作成時のみ)ため、書き込み後に明示的に落とす。
// Windows では ACL 継承が支配的で chmod はほぼ no-op だが、WSL や他環境でも同じ強度を保つ。
function writeAtomic(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch (e) {
    // ENOTDIR / EEXIST は「置き場所が同名のファイルになっている」ことが原因で、掴んでいる
    // 別プロセスを終了しても直らない。呼び出し元(退避先・来歴・CREDENTIALS 本体の 3 箇所)は
    // どれも EPERM/EBUSY 向けの「別プロセスを終了…」を案内していたため、この原因だと的外れになる
    // (keepAside の replacedFail が同種の原因を先に切り分けているのと同じ着眼)。ここで印を
    // 付けておき、呼び出し元がメッセージを選び分けられるようにする。
    if (e.code === 'ENOTDIR' || e.code === 'EEXIST') e.dirIsFile = true;
    throw e;
  }
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
    // ただしここで掃除できるのは例外経路だけで、書き込み中にプロセスごと落ちる(電源断・
    // 強制終了)と .tmp は残る。一覧は `.json` しか拾わないため気づけないので、savedAccounts が
    // 同じ readdir で拾い、status が知らせる(そちらのコメント参照)。
    if (!renamed) { try { fs.unlinkSync(tmp); } catch {} }
  }
}

// writeAtomic が付けた e.dirIsFile を見て、対処文を選んで返す(呼び出し元の EPERM/EBUSY 向け
// 文言に「追記」しない。丸ごと差し替える)。ENOTDIR/EEXIST(置き場所が同名ファイルになっている)
// と EPERM/EBUSY(掴んでいる別プロセスがいる)は原因が別なので、両方の文を並べて出すと、
// 該当しない方の指示(存在しない別プロセスを終了する、など)が先頭 2 行として残り、
// 案内どおり動いても直らないまま利用者がまず的外れな対処から始めることになる。
// heldByText は EPERM/EBUSY のときの文言(呼び出し元ごとに主語が違うため引数で受け取る)。
function dirIsFileHint(e, dir, heldByText) {
  return e.dirIsFile
    ? dir + ' が同名のファイルになっていないか確認してください'
    : heldByText;
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

// そのスロットを `swap <name>` で復元するとき --force が要るか。復元の手前にあるガードは
// 4 つあり、どれか 1 つでも当たれば --force なしでは中止される。以前は同一プランだけを
// 見ていたため、失効した退避に対して `swap <name>` とだけ案内し、そのとおり打った人が
// 「失効しています」で二度目の中止に当たっていた。判定はこの関数だけが持つ。
// もとは cmdSwap 専用のローカル関数だったが、「退避されていません」案内(target が
// 存在しないとき、利用可能なスロットごとに実際に打てるコマンドを列挙する)からも同じ判定を
// 使うため、モジュールスコープへ移した(中身は変えていない)。案内する場所ごとにこの判定を
// 書き写すと、片方だけ直して「案内どおり打つと止まる」事故が再発する(このファイルで
// 繰り返し起きてきた)。
// curUnsavable は「現在の credentials をそのまま退避できない」ときの理由(unreadableReason の
// 戻り値)。この状態では復元にも必ず --force が要る(saveCurrent は force.unreadable を見て
// 初めて控えだけ残して先へ進む)。fromJson は未ログインでも読めない場合でも同じく null に
// なるため、fromJson だけでは両者を区別できない。区別せずに案内していた頃は、読めない現在に
// 対して素の `swap <name>` を案内し、案内どおり打つと「現在の credentials を読めません」で
// 必ず止まっていた(このファイルで繰り返し起きた「案内どおり打つと止まる」と同じ形)。
function needsForceToRestore(fromJson, slotJson, curUnsavable) {
  if (curUnsavable) return true;
  if (!slotJson) return true;
  if (isExpired(slotJson) || !refreshTokenOf(slotJson) || !subscriptionTypeOf(slotJson)) return true;
  return fromJson ? !planDiffers(fromJson, slotJson) : false;
}

// existsSync だけを盾に readdirSync していた頃は、ACCOUNTS_DIR が手違いでファイルとして
// 存在すると ENOTDIR の生例外が main() まで抜け、原因も対処も示されないまま全サブコマンドが
// 死んでいた。同じファイルの listReplaced() (340-345 付近)と同じパターンに揃え、
// エラーを戻り値に入れて呼び出し元に判断を返す。
// 書きかけの .tmp も同じ readdir で拾う。writeAtomic の finally は例外経路しか掃除しないので、
// 書き込み中に落ちる(電源断・強制終了)と平文のトークンを含む <名前>.json.tmp が残る。一覧も
// 控えの集計も `.json` しか見ないため、残っても誰も気づけないまま置かれ続けていた。読む側を
// 増やさず、ここで一緒に返して status に知らせさせる。
function savedAccounts() {
  try {
    const entries = fs.readdirSync(ACCOUNTS_DIR);
    return {
      names: entries
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -5))
        .filter(n => NAME_RE.test(n))
        .sort(),
      partial: entries.filter(f => f.endsWith('.json.tmp')).sort(),
      error: null,
    };
  } catch (e) {
    // ENOENT(まだ 1 度も退避していない)だけが「無い」。existsSync を盾にしていた頃は、
    // 権限で stat できない場合も同じ「0 件・error なし」に落ちており、すぐ下のコメントが
    // 禁じている「読めないことを 0 件に倒す」を入口で自分がやっていた。
    if (e.code === 'ENOENT') return { names: [], partial: [], error: null };
    return { names: [], partial: [], error: e.code || e.message };
  }
}

// savedAccountsOrFail(一覧が読めなければ process.exit)は削除した。呼び出し 3 箇所すべてが
// 「一覧は助言・表示のためだけに要る」場所で、止めると要求された操作を行わないまま無関係な
// 理由に差し替わって終わっていた(適合ゼロ)。一覧の可否は呼び出し元が savedAccounts() の
// error を見て決める。読めないことを「0 件」に倒さないこと。
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
  try {
    return { files: fs.readdirSync(REPLACED_DIR), error: null };
  } catch (e) {
    // ENOENT(まだ 1 度も控えを作っていない)だけが「無い」。existsSync では権限で読めない
    // 場合も同じ「空・error なし」に落ち、控えがあるのに 0 件と表示していた。
    if (e.code === 'ENOENT') return { files: [], error: null };
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
// slots は呼び出し元が既に取得したスロット名の一覧。読めなかったときは null を渡す。
// ここで一覧を読み直して(かつ savedAccountsOrFail で)止めてはいけない。この関数は
// keepAside → pruneReplaced から呼ばれ、控えを作った直後・スロットへ書く前に通るので、
// fail() の副作用(process.exit)が働くと退避が未完のまま終わり、利用者には退避が
// 失敗した本当の理由ではなく「一覧を読めません」という無関係な理由だけが出る
// (修正E で cmdSwap の中止メッセージについて直したのと同じ問題が、この経路に残っていた)。
// 一覧が無ければ「他にもある」と証明できないだけなので、複製は無い側に倒す。
function hasCopyElsewhere(token, selfFile, slots) {
  if (slots && slotsHoldingIn(slots, token).length > 0) return true;
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
  // スロットの一覧はこのループの中では変わらない(unlink するのは .replaced だけで、
  // スロットへの書き込みは pruneReplaced を終えた後の writeSlot まで起きない)ので、
  // 1 度だけ読んで hasCopyElsewhere に渡す。反復ごとに読み直すと、控えが増えるほど
  // ディスク I/O が二乗で効くうえ、一過性のロックを踏む機会もそのぶん増える。
  // 読めなければ null を渡し、「複製が他にある」と証明できない側に倒す(消さない)。
  const { names: slotNames, error: slotsError } = savedAccounts();
  const slots = slotsError ? null : slotNames;
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
        return token && hasCopyElsewhere(token, e.file, slots);
      });
    }
    if (!victim) break; // 消してよいと言えるものが尽きた。上限を超えたまま残す
    try { fs.unlinkSync(victim.file); } catch {}
    candidates.splice(candidates.indexOf(victim), 1);
    excess--;
  }
}

// file と同じバイト列を持つ既存の控えを探す。比較を JSON ではなくバイト列で行うのは、
// 読めない中身(まさに控えを取る理由)でも「同じものか」だけは判断できるため。
// 読めない場合は比較を諦めて null を返す(新しい控えを作る側に倒す。控えが 1 本増えるのは、
// 唯一の 1 本を取り違えて消すことに比べれば何でもない)。
function sameContentEntry(file, list) {
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return null;
  }
  for (const e of list) {
    try {
      if (fs.readFileSync(e.file).equals(raw)) return e.file;
    } catch {
      // この控えとは比較できなかっただけ。他の控えの判定は続ける
    }
  }
  return null;
}

// 上書きで失われる内容の控えを取る。移動ではなく複製なのは、控えを作る途中で落ちても
// 元のファイルが手つかずで残るようにするため。控えが取れなければ上書きへは進まない
// (切り替えられないのは後から取り返せるが、消えた資格情報は取り返せない)。
// nextStep は控えを取れずに中止するときへ添える「実際に効く次の一手」(呼び出し元ごとに違う)。
function keepAside(file, base, nextStep) {
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
  // 既に同じバイト列の控えがあるなら、それがこの中身の控えそのものなので新しく作らない。
  // pruneReplaced は読めない控えを消さない(復旧に使えないことを証明できないため)ので、
  // 壊れた credentials を抱えたまま --force を繰り返すと .unreadable-current-N.json が
  // 上限の効かないまま増え続け、status の「復元に使えない控え」も膨らんでいた。同じ中身を
  // 数えないだけなので、残っている情報は 1 本も減らない。
  const twin = sameContentEntry(file, list);
  if (twin) return twin;
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
    // 失敗の理由は unreadableReason に判定させる。ここで文面を書き起こしていた頃は、原因を
    // 権限とロックに決め打ちしていたため、probe が EISDIR(同名のディレクトリ)と言った直後に
    // この行が EPERM を見せて別プロセスを終了させようとし、そのとおり動いても直らなかった。
    // 読めさえすれば控えは取れるので、copyable が false = 打ち直しても同じ結果になる。
    // 「もう一度」を勧めてよいのはその逆のときだけで、常に勧めると --force との間で
    // 2 つのコマンドを往復し続ける案内になる。
    const why = unreadableReason(file);
    fail('上書きで失われる内容の控えを取れませんでした(' + (e.code || e.message) + ')'
      + '\n  ' + file + ': ' + why.label
      + (why.copyable
        ? '\n  権限を確認するか、ウイルス対策やバックアップツールなどこのファイルを掴んでいる'
          + '別プロセスがあれば終了したうえで、先ほどと同じ swap コマンドをもう一度実行してください'
        : '\n  この状態が続くあいだは控えを取れません。先に原因を解いてください')
      // 控えを取れないのが「上書きされる側」の事情なら、別の名前を選べばそこは触らずに済む。
      // 呼び出し元にしか分からないので文面ごと受け取る(ここで組み立てると、控えを取る対象が
      // 現在の credentials の場合にも、効かない別名の案内を出すことになる)。
      + (nextStep ? '\n  ' + nextStep : '')
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
// 「復元に使えない控え」に refreshToken だけの控えを混ぜていた頃は、cmdStatus がそれを
// 「原因を調べ終えたら消して構いません」と案内していた。refreshToken は交換すればまた使える
// ので、accessToken 欠け(hasUsableCredentials 基準で false)と、失って困るものが無い状態
// (hasRecoverableToken 基準でも false)は同じではない。3 分類にして、真ん中(staleToken)は
// 「消してよい」側には決して混ぜない。
// unreadable はさらに 2 つに分かれる。「壊れていると確認できた(JSON として読めない・
// accessToken も refreshToken も無い)」ものは復旧に使えないと言い切れるが、「一時的に
// 読めなかっただけ(EBUSY/EACCES/EPERM でファイルを開けない)」はウイルス対策やバックアップ
// ツールが掴んでいるだけのことがあり、健全な未退避アカウントの唯一のコピーでも同じ表示に
// なりうる。この切り分けは unreadableReason が内部でしている「開けなかった(e.code)」と
// 「開けたが JSON として壊れている」の区別に合流させる(新しい判定を書き起こさない)。
// ただし後者(JSON.parse 失敗)は「読み取れない」には数えない。unreadableReason は生きている
// CREDENTIALS も相手にするので両方を unreadable にまとめるが、.replaced の控えは keepAside が
// 1 回だけ copyFileSync するだけで以後だれも書き換えない(コピー元が壊れていれば、それを
// そのまま複製しただけ)。開けている以上、中身は rawHasRecoverableToken まで確認できる。
// 一方で「読めない」と「消してよい」は別の問いで、ここを混ぜると資格情報を失う。
// コピー元が書き込みの途中だった控えは、JSON としては壊れたまま切れ目より手前に
// refreshToken を残していることがあり、それが未退避アカウントの唯一のコピーでありうる。
// 消してよいと言えるのは、トークンらしき文字列すら残っていないと確認できたときだけなので、
// パースできなかった中身は rawHasRecoverableToken に通してから staleToken と unusable に分ける。
// 数える軸は unreadableReason の verdict と同じ「中身について何を確認できたか」で、
// unreadable(読み取り自体に失敗した。中身は不明)と unusable(最後まで確認して使えない)を
// 分ける。以前の名前(unreadableRetryable)は「待てば直る」という推測を指していたが、
// 実際に数えていたのは読み取りに失敗したかどうかで、名前だけが推測を匂わせていた。
function replacedCounts() {
  const { files, error } = listReplaced();
  if (error) return { overwritten: 0, staleToken: 0, unreadable: 0, unusable: 0, error };
  let overwritten = 0;
  let staleToken = 0;
  let unreadable = 0;
  let unusable = 0;
  for (const f of files.filter(f => f.endsWith('.json'))) {
    const full = path.join(REPLACED_DIR, f);
    if (readCredsOrNull(full)) { overwritten++; continue; }
    let raw;
    try {
      raw = fs.readFileSync(full);
    } catch (e) {
      // ENOENT(一覧を取った直後に消えた)は読み取りの失敗ではあるが、実体がもう無いので
      // 「消さないでください」と案内しても意味がない。どちらに数えても実害はなく、
      // 件数の説明が素直な unusable 側に寄せる。
      if (e.code && e.code !== 'ENOENT') unreadable++;
      else unusable++;
      continue;
    }
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      // JSON として壊れていることは「復元に使えない」の証明にはならない。keepAside は
      // 読めなかった credentials をバイト列のままコピーするので、書き込みの途中を掴んだ控えは
      // JSON としては壊れたまま、切れた位置より手前に refreshToken を残していることがある
      // (未退避アカウントの唯一のコピーがまさにこの形で残る)。ここを一律 unreadable に
      // 数えると、cmdStatus が「原因を調べ終えたら消して構いません」と案内して、その資格情報を
      // 失わせる(swap 本体は同じ控えを「消さないでください」と案内しており、指示も食い違う)。
      // 判定は credentials.js の rawHasRecoverableToken に合流させ、ここでは書き起こさない。
      if (rawHasRecoverableToken(raw)) staleToken++;
      else unusable++;
      continue;
    }
    // readCredsOrNull が null な理由が accessToken 欠けだけなら、refreshToken の有無を見る
    // (readCreds は accessToken 必須なのでここでは使えない)。
    if (hasRecoverableToken(json)) staleToken++;
    else unusable++;
  }
  return { overwritten, staleToken, unreadable, unusable, error: null };
}

// --- 来歴(.current) ---

// 現在のログインがどのスロット由来かの記録。平文 1 行で持つのは、壊れても「分からない」に
// 落ちるだけで復旧を妨げないため。指しているスロットが消えていれば記録も無効とみなす。
// スロット名を、実在するファイルの名前に読み替える。Windows と macOS の既定のように大小を
// 無視するファイルシステムでは accounts/Pro.json と accounts/pro.json が同じファイルを指すが、
// 名前は文字列としてそのまま比較されるため、大小違いで打つだけで「退避先が復元元と同じ」
// (sameAsTarget)も「すでにそのスロットから復元済み」(provenance)もどちらも素通しになる。
// そのとき cmdSwap は退避で新しい内容をそのファイルへ書いた直後、読み込み済みの古い内容を
// credentials へ書き戻すので、マシン全体の認証がローテート前に巻き戻る(実機で再現済み)。
// 名前を実名に揃えてしまえば、以後の比較はすべて実名どうしになり、個々のガードに大小の
// 例外を持ち込まずに済む(判定を増やすと、既存ガードを迂回する経路が新たに生まれる)。
// 読み替えてよいのは「打った名前と実在するスロットが同じファイルを指す」と確かめられたときだけ。
// 名前が一覧に無いのに、その名前のファイルが実在する — これが大小を無視するファイルシステムの
// 証拠になる(readdir には片方の綴りしか現れないが、どちらの綴りで開いても同じ実体に当たる)。
// 逆に大小を区別するファイルシステムでは Pro と pro は別ファイルなので、実在しない側は ENOENT に
// なる。この確認を省いて名前だけで読み替えていた頃は、Linux で `swap save Pro` と打つと(Pro は
// まだ無いのに)既存の pro スロットへ読み替わり、別アカウントの唯一の退避を狙って上書きガードや
// 来歴判定をすり抜けていた。存在確認は probeFile に通す(規則1。existsSync だと権限やロックで
// 読めないだけのスロットも「無い」に倒れ、大小無視 FS でも読み替えが効かなくなる)。
// 一覧を読めないときと、大小無視で複数当たるとき(区別する FS でのみ起きる)は、読み替える
// 根拠が無いのでそのまま返す。
function canonicalSlotName(name) {
  const { names, error } = savedAccounts();
  if (error || names.includes(name)) return name;
  if (!probeFile(accountFile(name)).exists) return name;
  const lower = name.toLowerCase();
  const hits = names.filter(n => n.toLowerCase() === lower);
  return hits.length === 1 ? hits[0] : name;
}

// 来歴が読めないことは 1 回の実行で 6 箇所から検出されうる(readCurrentSlot の呼び出し数)。
// そのたびに出すと本題の案内が埋もれるので、最初の 1 回だけ知らせる。
let currentSlotWarned = false;
function warnCurrentUnreadable(code) {
  if (currentSlotWarned) return;
  currentSlotWarned = true;
  console.error('注意: 来歴(.current)を読めません(' + (code || '理由不明') + ')。'
    + '退避名は subscriptionType から決めます: ' + CURRENT_FILE);
}

function readCurrentSlot() {
  // 読み取りは probeFile に一本化する(規則1)。生の readFileSync + catch で「無い」に倒して
  // いた頃は、.current が権限やロックで読めないだけでも「未記録」になり、来歴を失ったまま
  // subscriptionType 由来の名前へ黙って乗り換えて、同じアカウントを 2 つの名前で退避した
  // 状態(README が危険だと書いている状態)を無警告で作っていた。--force では「退避先が
  // 復元元と同じ名前になります」のガードも同じ経路で外れる。
  const p = probeFile(CURRENT_FILE);
  if (!p.exists) return null; // 未記録(このツールを使い始めた直後、または手で消した)
  if (!p.readable) {
    // 読めない来歴を「無い」と同じに扱わない。名前を決められないことは伝わるべきで、
    // 黙って別名を作らせない(呼び出し元は null を「決められない」として扱う)。
    warnCurrentUnreadable(p.code);
    return null;
  }
  const name = p.raw.trim();
  // 指す先が「無い」ときだけ来歴を無効にする。existsSync は読めないだけのスロットも false に
  // するので、来歴は生きているのに「未記録」へ落ち、overwriteGate の provenance 判定が
  // 効かないまま別アカウントのスロットを上書きする経路になっていた。
  if (!NAME_RE.test(name) || !probeFile(accountFile(name)).exists) return null;
  // 大小違いで書かれた来歴(このツールの旧版が書いた、手で書いた)もここで実名に揃える。
  // 揃えないと、指しているファイルは正しいのに名前の比較だけが食い違い、status の印も
  // 「現在のログインと内容が違います」の警告も出なくなる(退化に気づく手段が消える)。
  return canonicalSlotName(name);
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
  // 消せたかどうかで状況の意味がまるで違う。消せていれば来歴は「未記録」に落ち、
  // currentSlotOf が subscriptionType 由来の名前で代用するので、少なくとも他人のスロットは
  // 指さない。消せなければ古い来歴がそのまま残り、次に名前を省いた `swap save` は
  // overwriteGate の provenance 一致まで通って、別アカウントのスロットを上書きする。
  // 握りつぶしていた頃は、どちらの場合も同じ「記録できませんでした」だけを出していたため、
  // 残っている古い来歴に気づく手段が無かった(この関数を呼ぶ経路は書き込みが EPERM で
  // 落ちた直後なので、同じ理由で unlink も落ちるのがむしろ典型)。
  // ENOENT は「元から無い」= 消えているのと同じなので、残存とは扱わない。
  let stale = false;
  try {
    fs.unlinkSync(CURRENT_FILE);
  } catch (unlinkError) {
    if (unlinkError.code !== 'ENOENT') stale = true;
  }
  return '来歴を記録できませんでした(' + (e.code || e.message) + ': ' + CURRENT_FILE + ')'
    + '\n  ' + dirIsFileHint(e, path.dirname(CURRENT_FILE),
      'このファイルを掴んでいるプロセスを終えるか、読み取り専用属性を外してください')
    + (stale
      ? '\n  古い来歴が残ったままです(消せませんでした)。この記録は現在のログインを指して'
        + 'いないため、名前を省いた退避は別のアカウントのスロットを上書きします'
        + '\n  ' + CURRENT_FILE + ' を手で削除すれば、来歴は未記録に戻ります'
      : '')
    + '\n  以後の退避は `swap save <name>` と名前を明示してください'
    + '(省くと別のスロットを上書きすることがあります)';
}

// 現在のログインをどのスロットへ退避するか。来歴を第一の手掛かりにし、まだ記録が無いときだけ
// subscriptionType 由来の名前で代用する。どちらも「そのスロットを上書きしてよい」ことまでは
// 保証しないので、書く直前に saveInto が改めて裏を取る。
function currentSlotOf(cur) {
  return readCurrentSlot() || (cur && cur.json ? accountNameOf(cur.json) : null);
}

// 指定した refreshToken を持つスロットを探す(name のリストに対して)。除外する名前を
// 受け取る引数は持たない。呼び出し元(hasCopyElsewhere, cmdSwap の中止メッセージ組み立て)は
// どちらも常に全件を見る必要があり、除外を足すと「複製が他にある」の証人を取りこぼして、
// pruneReplaced が消してはいけない唯一の控えを落としうる。
function slotsHoldingIn(names, token) {
  return names.filter(n => {
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
// 以前は共通の refreshToken 一致ヘルパーで全 accounts/*.json を読んで一致を調べたあと、
// 一致したスロットだけをここでもう一度開き直して sameCreds を見ていた。退避のたびに
// 同じファイルを二重に読むだけで判定自体は 1 回の読み込みで組み立てられるので、
// そのヘルパーは経由せずここで直接読む。
function staleSlots(cur, name, oldToken) {
  if (!oldToken) return [];
  // 押し出した旧内容が現在のログインと同じ資格情報なら、それを持つスロットは古くない。
  // この条件はスロット名に依存しないので、ループの外で 1 回だけ見る。中で sameCreds を
  // 呼んでいた頃は、oldToken に一致したスロットごとに同じ比較を繰り返していた
  // (c の refreshToken は既に oldToken だと確定しているので、sameCreds が見ていたのは
  //  実質「現在のログインの refreshToken が oldToken か」だけだった)。
  if (refreshTokenOf(cur.json) === oldToken) return [];
  // 戻り値は reportOtherSlots の助言表示にしか使わない。一覧が読めないだけで止めると、
  // 呼び出し元(saveInto)はスロットへ書く手前なので、要求された退避も切り替えも行われないまま
  // 「一覧を読めません」という無関係な理由に差し替わって終わる。読めなければ助言を省く。
  const { names, error } = savedAccounts();
  if (error) return [];
  return names.filter(n => n !== name).filter(n => {
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
  // 「無い」ときだけ上書きガードを素通しにする。existsSync では読めないだけのスロットも
  // exists=false になり、blocked=false でガード自体が発火しなかった(writeSlot の控え取得も
  // 同じ理由で飛ばされるため、2 つが重なると控えなしで別アカウントを潰す)。
  const exists = probeFile(file).exists;
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
  // existsSync では「権限が足りず stat できない」「別プロセスが掴んでいる」も false になり、
  // そのとき控えを 1 本も取らないまま下の writeAtomic が上書きしていた。probeFile は ENOENT の
  // ときだけ exists を false にするので、読めないスロットは「失って困る中身があるかもしれない」
  // 側として必ず控えを取る。控えが取れなければ keepAside がそこで中止する。
  if (probeFile(file).exists) {
    const prev = old !== undefined ? old : readCredsOrNull(file);
    // 控えを取れないのはこのスロットの側の事情(壊れている・掴まれている)なので、別の名前を
    // 選べばそこには触れずに退避できる。原因の解消を待たなくても進める唯一の手なので添える。
    if (!(prev && sameCreds(cur.json, prev.json))) {
      keepAside(file, name, '別の名前で退避すれば ' + name + ' には触れずに済みます: swap save <別名>');
    }
  }
  // 控えは取れたのにスロットへ書けないことがある(退避先を他プロセスが開いていると
  // rename が EPERM)。keepAside の copyFileSync と CREDENTIALS の書き込みには理由と対処を
  // 添えてあるのに、ここだけ素通しで生の Node 例外になっていた。何が済んで何が済んで
  // いないのかが読めないと、直せる原因に気づかないまま再実行を繰り返し、控えだけが積み上がる。
  try {
    writeAtomic(file, cur.raw);
  } catch (e) {
    fail('退避先へ書き込めませんでした(' + (e.code || e.message) + ')'
      + '\n  ' + file + ' を書き換えられません。'
      + dirIsFileHint(e, path.dirname(file),
        'このファイルを掴んでいる別プロセス(ウイルス対策・バックアップツールなど)を'
        + '終了するか、読み取り専用属性を外してください')
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
    // 「無い」ときだけ未ログインとして退避を省く。existsSync は権限やロックで stat が失敗
    // しても false を返すため、生きた未退避トークンがあるのに「未ログイン」と判断し、
    // 呼び出し元(cmdSwap)が退避せずそのまま CREDENTIALS を上書きする経路になっていた。
    if (!probeFile(CREDENTIALS).exists) return null; // 単に未ログイン
    // 「読めない」で止めるだけだと、この状態から抜け出す手段が無くなる(swap も save も
    // 同じ判定で止まるため)。中身を確認した人が先へ進めるよう --force を用意する。
    const why = unreadableReason(CREDENTIALS);
    if (!force.unreadable) {
      // 「時間をおいて再実行」を verdict で出し分けていた頃の名残を残さない。もう一度打てば
      // 直る種類の失敗はここで吸収され、直らなければ次の行の --force が常に脱出路になる。
      // --force が脱出路になるのは控えを取れるときだけ。開くことすらできないファイル
      // (copyable: false)では、その先の keepAside が copyFileSync を同じ理由で落とし、
      // その失敗が「もう一度実行してください」と案内するため、2 つのコマンドを往復し続ける
      // ことになる。控えを取れない以上「中身を確認したうえで進む」も成り立たないので、
      // 原因の解消を先に促す(saveFirstText が同じ状態に出している文面と揃える)。
      fail('現在の credentials を読めません(' + why.label + ')'
        + (why.copyable
          ? '\n  もう一度実行しても同じなら、中身を確認したうえで、そのまま先へ進めます:'
            + '\n    ' + forceCmd
          : '\n  ' + CREDENTIALS + ' を開けないあいだは控えも取れないため、--force を付けても'
            + '同じところで止まります。先にこのパスを開ける状態に戻してください'
            // ここで `/login` を脱出路として出さない。中身を確認できていない以上、未退避の
            // refreshToken が残っている可能性を否定できず、勧めたとおり打つとそれを捨てさせる
            // (29ef72b で塞いだ経路)。パスさえ開けば控えも切り替えも通る。
        ));
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
// returnNote は「戻すコマンドが存在しない」ときにコマンドの代わりへ出す注記。呼び出し側から
// 渡すのは、この関数が cmdSwap(切り替え直後)と cmdSave(何も復元していない)の両方から
// 呼ばれるため。returnCmd が null であることだけを根拠にここで文面を決めると、退避しかして
// いない cmdSave にも「いま復元したアカウントの内容で上書きされます」を出すことになる。
function reportOtherSlots(saved, returnCmd, returnNote) {
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
  } else if (returnNote) {
    // 戻すコマンドが無い(退避名がサブコマンドと衝突していて、打てる形が存在しない)。手順は
    // 出せないが、警告まで一緒に消すと下の `swap save` をそのまま打ってよいように見える。
    // それが書き込むのは現在のログイン = いま復元したアカウントなので、戻さないまま打つと
    // 元の内容が失われる。
    console.log(indent + '    ' + returnNote);
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
// キャッシュ。以前はここで accountFile(curSlot) を読み直し、さらに refreshToken の一致判定が
// 全 accounts/*.json をもう一度読んでいた。cmdStatus 側の表示ループも同じファイル群を
// 読むため、1 回の `swap`(status)実行で各スロットを複数回読むことになっていた。
//
// 過去に「.replaced にある控えの refreshToken と一致するスロットも stale とみなす」照合を
// 足したことがあるが、撤回した(このコメントは再挑戦を思いとどまらせるために残す)。
// .replaced が語れるのは「かつて上書きで押し出された内容がこれだ」という履歴だけで、
// 「いまそのスロットが古いか」ではない。status 自身が「取り違えて上書きしたときは
// .replaced から accounts/<name>.json へ戻せます」という復旧手順を案内しており、その手順を
// 実行した直後のスロットは中身が控えと完全に一致する。つまり「押し出された古いもの」と
// 「復旧されたばかりの正しいもの」が同じ条件に当てはまり、区別できない。印には
// 「swap save <name> --force」という更新コマンドが併記されるため、復旧した人が案内どおり
// 打つと唯一の正しい退避を現在のログインで上書きして失う。印が付かない不便より、
// 正しい退避を潰すほうが高くつくので、この照合はしない。
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
  // cmdSwap と同じ読み方に揃える。readCredsOrNull だけで判定していた頃は、1 回目の読み取りが
  // たまたま失敗しただけでも「読めません(いまは健全に読めています)」という、それ自体で
  // 矛盾した行を出していた(status は何が起きているかを調べに来る入り口なので、ここが
  // 自己矛盾していると原因の切り分けができない)。
  const { cur, why: curUnsavable } = readCurrentForGuard();
  const exists = probeFile(CREDENTIALS).exists;
  const curSlot = readCurrentSlot();

  // 「未ログイン(ファイルが無い)」と「読めない(破損・権限・書き込み中)」を混ぜない。
  // 後者を未ログインと読んだ人が /login をやり直すと、退避していない生きたトークンが
  // 上書きされて消える。status は状況確認の唯一の入り口なので、ここでの誤誘導は重い。
  let label;
  if (cur) label = subscriptionTypeOf(cur.json) || '不明(subscriptionType が読めない)';
  // 理由は readCurrentForGuard が確定させたものを使う(ここで読み直すと、その間に状態が
  // 変わって cur との食い違いが生まれる)。
  else if (exists) label = '読めません(' + (curUnsavable ? curUnsavable.label : '理由不明') + ')';
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

  // status は「いま何が残っているか」を確かめる唯一の入り口なので、一覧が読めなくても
  // 最後まで出しきる。ここで止めると下の .replaced の復旧・保全の案内に到達せず、
  // 控えが残っていること自体に気づけない(listReplaced が例外を戻り値に変えているのと同じ理由)。
  const { names: saved, partial: savedPartial, error: savedError } = savedAccounts();
  // 各スロットの中身はここで 1 回だけ読み、outdatedSlots の判定と下の表示ループの両方で
  // 使い回す(前は判定と表示で別々に全スロットを読んでいた)。
  const savedCreds = new Map(saved.map(n => [n, readCredsOrNull(accountFile(n))]));
  const outdated = outdatedSlots(cur, curSlot, savedCreds);
  const unreachable = saved.filter(n => !restorableByName(n));
  const reservedOnly = saved.filter(n => RESERVED_ONLY_NAMES.has(n));
  console.log('\n退避済み (' + ACCOUNTS_DIR + '):');
  if (savedError) {
    // 「0 件」と書くと、控えがあるのに無いと誤認させる(読めない ≠ 無い)。
    console.log('  一覧を読めません(' + savedError + ')');
    console.log('  同じ名前のファイルが置かれていないか、ディレクトリの権限を確認してください');
  } else if (saved.length === 0) {
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
  // 書きかけのまま残ったファイル。writeAtomic の後始末は例外経路にしか効かないので、書き込み
  // 中に落ちるとここに残る。中身は平文のトークンで、退避の一覧にも控えの集計にも現れないため、
  // 知らせるのはこの status だけ。消してよいかは中身を見ないと決められない(唯一のコピーで
  // ありうる)ので、判断材料だけ出して削除は促さない(keptNote と同じ扱い)。
  // 同じ後始末漏れは現在の credentials 側にも起きる(切り替えの最終段は writeAtomic(CREDENTIALS))。
  // savedPartial は accounts/ の readdir なので ~/.claude/.credentials.json.tmp を構造上拾えないが、
  // 場所が違うだけで残るものは同じ平文トークンなので同じ枠で知らせる。probeFile を使うのは、
  // 読めないだけのファイルを「無い」に倒して見逃さないため。
  const livePartial = CREDENTIALS + '.tmp';
  const partialPaths = (savedPartial || []).map(f => path.join(ACCOUNTS_DIR, f));
  if (probeFile(livePartial).exists) partialPaths.push(livePartial);
  if (partialPaths.length > 0) {
    console.log('\n書きかけのまま残っているファイルがあります(平文のトークンを含みます):');
    for (const f of partialPaths) console.log('  ' + f);
    console.log('  退避が済んでいるかを確かめたうえで、不要なら削除してください');
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
  if (replaced.staleToken > 0) {
    // accessToken が無いので accounts/<name>.json へ戻してもそのままでは復元できないが、
    // refreshToken は交換すればまた使える。「復元に使えない控え」に混ぜて「消して構いません」
    // と案内すると、救えたはずの資格情報をその案内どおり消させることになる。
    console.log('\n復元には使えないが refreshToken が残っている控え: ' + replaced.staleToken
      + ' 件 (' + REPLACED_DIR + ')');
    console.log('  accessToken が無いため accounts/<name>.json へ戻してもそのままでは復元できませんが、'
      + 'refreshToken は交換すればまた使えます。消さないでください');
  }
  if (replaced.unreadable > 0) {
    // 読み取り自体に失敗した控え。ウイルス対策やバックアップツールが掴んでいる
    // (EBUSY/EACCES/EPERM)だけかもしれず、それは中身が壊れている証拠にはならない。
    // pruneReplaced は同じ理由でこの控えを決して自動削除しないので、案内も「消して
    // 構いません」とは言わない(以前は使えないと確認済みの控えに混ぜていたため、自動削除の
    // 方針と表示の方針が逆を向いていた)。文面は keptNote に合流させる。
    console.log('\n読み取れない控え: ' + replaced.unreadable + ' 件 (' + REPLACED_DIR + ')');
    console.log('  掴んでいる別プロセス(ウイルス対策・バックアップツールなど)がいないか'
      + '確認してください。' + keptNote('unreadable'));
  }
  if (replaced.unusable > 0) {
    // 復元先には使えない中身なので、上と同じ「戻せます」の案内に混ぜない。
    // 読めなかった現在の credentials だけでなく、退けた時点で既に壊れていた旧内容も
    // ここに入るので、置き場所は UNREADABLE_BASE 固定ではなくディレクトリで示す。
    console.log('\n復元に使えない控え: ' + replaced.unusable + ' 件 (' + REPLACED_DIR + ')');
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
  // 大小違いで既存スロットを指している場合は実名に揃える。揃えずに書くと、書き込み先は
  // 同じファイルなのに来歴には打った側の大小で記録され、以後の比較(status の印、
  // sameAsTarget、provenance)がすべて食い違う。
  if (name) name = canonicalSlotName(name);
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
    // /login を勧めてよいのは「中身を確認できていて、失うものが無い」ときだけ。いま読める
    // (usable)なら健全な credentials がそこにあり、refreshToken が残る(stale)なら交換で
    // また使える。どちらでも /login をやり直させると、まだスロットへ退避していないアカウントを
    // その時点で捨てさせることになる(ガード側の案内も同じ理由で /login を最後に置いている)。
    fail('現在の credentials を読めないため、退避しませんでした(' + why.label + ')'
      + '\n  中身の控えは残しました: ' + saved.kept
      + (why.verdict === 'usable'
        ? '\n  いまは読めています。そのまま `swap save` をもう一度実行してください'
          + '\n  /login はまだ試さないでください(中身は健全なので、やり直すと未退避の'
          + 'アカウントには戻れなくなります)'
        : why.verdict === 'stale'
          // refreshToken は交換すればまた使えるので /login では上書きさせない
          // (account-guard.js の 'stale' 案内・credentialsState() と同じ判断)。
          ? '\n  refreshToken は残っています(交換すればまた使えます)。/login すると、まだ'
            + '退避していないアカウントはその時点で失われるため、いま試さないでください'
            + '\n  退避済みの別アカウントへ切り替えるなら: swap <name> --force'
          : '\n  もう一度実行しても同じなら、控えの中身を確認したうえで、`/login` してから'
            + ' `swap save` をやり直してください'));
  }
  console.log('退避しました: ' + saved.name + ' -> ' + accountFile(saved.name));
  reportOtherSlots(saved, null);
}

// 「現在のログインを先に退避してください」と案内するときの、実際に打てるコマンドと理由を
// 組み立てる。cmdSwap には 2 箇所(target を読めずに中止する場合と、target は読めたが他の
// ガードで復元を中止する場合の forceHint)、同じ条件(needsName / sameAsTarget /
// saveBlocked / staleCur)から同じ文面を作る必要がある。判定は呼び出し側が用意する(現在のログインを
// 表す json の由来が 2 箇所で違う。片方は accessToken 必須の readCredsOrNull、もう片方は
// verdict 'stale' も拾う)。文面の組み立てだけをここに集め、片方だけ直して食い違う事故
// (このファイルで繰り返し起きた「案内どおり打つと止まる」)を防ぐ。
// curUnsavable は「現在の credentials をそのままスロットへ退避できない」ときの理由
// (unreadableReason の戻り値。読めない・壊れている・accessToken 欠けのいずれも入る)。
// この状態では素の `swap save <name>` は「現在の credentials を読めません」で必ず止まり、
// --force を付けても読めない中身はスロットに入れない設計なので、退避そのものは達成できない
// (控えだけが .replaced に残る)。ここを普通の退避として案内していた頃は、案内どおり 2 手
// 打っても退避できず、利用者が行き止まりに入っていた。打てば何が起きるかまで書く。
// 理由を boolean の staleCur で受けていた頃は、呼び出し側が「読めない = accessToken 欠け」と
// 決め打ちして true を渡しており、開くことすらできないファイル(EACCES/EBUSY/EISDIR)にも
// 「--force を付ければ控えが残ります」と約束していた。控えを約束してよいのは copyable の
// ときだけで、refreshToken の存在に触れてよいのは hasToken のときだけ。
function saveFirstText(needsName, sameAsTarget, saveBlocked, curSlotOf, curUnsavable) {
  const needed = needsName || sameAsTarget || saveBlocked || !!curUnsavable;
  // curUnsavable では名前を出さない。この経路の --force は「読めない現在を諦めて控えだけ残す」
  // ことにしか効かず、saveCurrent は名前を決める手前で返るので名前は使われない。にもかかわらず
  // `<name>` を埋めて案内すると、表示どおり打った人が validateName に弾かれて別のエラーで
  // 止まり、控えを残す経路に到達できない(cmdSave の forceCmd で同じ事故を既に直している)。
  const name = needsName ? '<name>' : (sameAsTarget || saveBlocked) ? '<別名>' : curSlotOf;
  const cmd = curUnsavable ? 'swap save --force' : 'swap save ' + name;
  const why = curUnsavable
    ? (curUnsavable.copyable
      // 開けてはいる(バイト列は読めた)。スロットへは入らないが控えは確実に取れるので、
      // そこまでを約束する。refreshToken に触れてよいのは、実際に残っていると確かめた
      // ときだけ(rawHasRecoverableToken の判定を hasToken として受け取っている)。
      ? '\n  (現在の credentials はスロットへ退避できません: ' + curUnsavable.label
        + '。--force を付けると ' + REPLACED_DIR + ' に控えだけが残ります'
        + (curUnsavable.hasToken ? '。控えに refreshToken が残るので、あとから取り出せます' : '')
        + ')'
      // 開くことすらできない。控えは copyFileSync が同じ理由で落ちるので取れない。
      // ここで控えを約束すると、案内どおり打った人が「控えを取れませんでした」で行き止まる。
      : '\n  (現在の credentials を開けません: ' + curUnsavable.label
        + '。開けないあいだは控えも取れないので、先に原因を解いてください)')
    : needsName
      ? '\n  (現在のログインは退避名を決められない状態です'
        + '(subscriptionType が読めず、来歴も記録されていません)。'
        + '先に名前を明示して退避しないと、--force を付けても退避の段で止まります)'
      : saveBlocked && !sameAsTarget
        ? '\n  (退避先 ' + curSlotOf + ' には現在と違う認証情報が入っているため、'
          + '名前を分けないと --force を付けても退避の段で止まります)'
        // sameAsTarget の理由は、この案内を出す側の文面が既に説明している
        : '';
  return { needed, cmd, why };
}

function cmdSwap(target, force) {
  if (!NAME_RE.test(target)) {
    fail('アカウント名に使えない文字が含まれています: ' + target
      + '\n  使えるのは英数字とハイフン(-)、アンダースコア(_)だけです'
      + '\n  退避済みの名前は、引数なしで swap を実行すると一覧できます');
  }
  // 大小違いで既存スロットを指しているなら実名に揃えてから進む。この 1 行が無いと、
  // 大小を無視するファイルシステムで `swap Pro` が accounts/pro.json を開きながら
  // 'Pro' として比較され、退避先が復元元と同じことを検出できない(canonicalSlotName 参照)。
  target = canonicalSlotName(target);

  const file = accountFile(target);

  // .current は cmdSwap の中で読み直すたびにディスク I/O が増えるだけでなく、同じ実行の中で
  // 何度も同じ値を評価する取り違え事故(forceHint と復元ガードが完全に同一の式
  // `cur && currentSlotOf(cur) === target` を別々に評価していて、片方だけ直す事故につながった)
  // の元にもなる。ここで 1 回だけ読み、以降はこの定数を使い回す。
  // 書き換わる経路(この関数の下にある短絡の writeCurrentSlot、末尾の切り替え仕上げの
  // writeCurrentSlot、および saveCurrent 内部の writeCurrentSlot)はすべてこのキャッシュより
  // 後にあるので、キャッシュした値を使ってよいのはそれより前の評価に限る
  // (curSlot 自身も readCurrentSlot、curSlotOf も currentSlotOf と同じ計算式)。
  // 以前はこのすぐ下の「退避されていません」案内より後で読んでいたが、その案内でも
  // 同じ cur/curSlotOf が要る(利用可能なスロットごとに、いま打てば通るコマンドを
  // 具体化するため)ようになったので、ここまで読み込み位置を前へ動かした。読み込みは
  // 引き続き 1 回のまま(二度読むと、判定に使ったバイト列と実際に退避するバイト列がずれる)。
  // cur が null でも「未ログイン(ファイルが無い)」と「あるが読めない・壊れている」は別物で、
  // 出すべき案内が正反対になる(前者は退避するものが無い、後者は先に控えを取らないと
  // そのあとの /login で未退避の refreshToken を失う)。cur だけを見て分岐していた頃は
  // 後者が前者に混ざり、「退避されていません」の案内が素の `swap <name>` だけを並べ、
  // 打つと「現在の credentials を読めません」で即座に止まっていた。curUnsavable が
  // その区別(= 読めない理由)で、以降の案内はすべてこの値を通す(判定を各所で書き写さない)。
  const { cur, why: curUnsavable } = readCurrentForGuard();
  const curSlot = readCurrentSlot();
  const curSlotOf = curSlot || (cur && cur.json ? accountNameOf(cur.json) : null);

  // 「無い」ときだけ「退避されていません」と言い切る。existsSync では読めないだけのスロットも
  // ここへ落ち、実際には退避済みなのに「退避されていません」と案内していた(そのまま
  // `swap save <target>` を打つと、読めない中身の上に現在のログインを書いて控えを 1 本失う)。
  // 読めない場合は下の readCreds へ進み、unreadableReason が理由を添えて中止する。
  if (!probeFile(file).exists) {
    // ここは中止メッセージを組み立てている最中なので、一覧の取得で止めない。止めると
    // 「退避されていません: <名前>」という本当の理由が「一覧を読めません」に差し替わる
    // (hasCopyElsewhere のコメントが禁じているのと同じ形)。読めなければ候補だけ省く。
    const { names: saved, error: savedError } = savedAccounts();
    if (savedError) {
      fail('退避されていません: ' + target
        + '\n  退避済みの一覧も読めませんでした(' + savedError + ': ' + ACCOUNTS_DIR + ')'
        + '\n  同じ名前のファイルが置かれていないか、ディレクトリの権限を確認してください'
        + '\n  一覧は `swap` で確認できます');
    } else if (saved.length > 0) {
      // 名前を並べるだけでは、その名前で `swap <名前>` を打っても別のガードで止まりうる
      // (失効・refreshToken 欠け・subscriptionType 欠け・同一プランで別アカウント未確認・
      // 復元先が復元元と同じ名前になる、等)。実際に打てば通る形へ具体化する。判定は
      // cmdSwap 本体の復元ガードと同じ関数に通し、この案内だけの基準を作らない
      // (このファイルで繰り返し起きた「案内する場所で条件を書き写して片方だけ直す」事故を
      // 避けるため)。
      //   needsForceToRestore … 復元先の健全性と同一プランのどれかで --force が要るか
      //   saveFirstText(needsName, sameAsTarget, saveBlocked, curSlotOf) … 単発の復元コマンドでは
      //     通らない状況(名前を決められない/退避先が復元元と同じ名前になる/自動で選ばれる
      //     退避先に既に別の認証情報が入っている)を forceHint と同じ形で先に案内する
      const needsName = !!cur && !curSlotOf;
      const saveBlocked = !!(cur && curSlotOf && overwriteGate(cur, curSlotOf, curSlot).blocked);
      // 各スロットの見出し(`name:`)は必ず付ける。見出しを省いて実行コマンドの行だけを
      // 連ねると、複数スロットぶんの行が隙間なく並び、「どれか1つを選ぶ択一の選択肢」ではなく
      // 「上から順に全部打つ手順」に見えてしまう(この案内どおりに前のスロットへ切り替えてから
      // 次のスロットへ切り替えようとすると、直前の切り替えのせいで判定の前提が変わり、
      // 案内どおり打っているのに止まることがある)。見出し行を挟むことで、スロットごとに
      // 独立した選択肢だと分かる形にする。
      // 打てるコマンドを出せたかを行ごとに持ち回る。見出しは「いずれか1つを選んでください」と
      // 択一を促すので、選べる行が 1 つも無いまま出すと、無い選択肢を探させることになる
      // (全スロットが読めない場合に前からあった穴で、復元できない名前を弾くぶん当たりやすくなる)。
      const entries = saved.map((name) => {
        // 中身より先に名前を見る。読めるかどうかに関わらず、この名前では復元が走らないので、
        // 「打てるコマンド」として出してはいけない(status は同じスロットを「復元できない名前の
        // 退避」と警告しており、ここで swap <name> を勧めると案内どうしが正面から矛盾する)。
        if (!restorableByName(name)) return { runnable: false, body: renameToRestoreText(name) };
        const c = readCredsOrNull(accountFile(name));
        // 読めないスロットは「打てば必ず通る」と請け合えない。列挙から外し、存在だけ伝える。
        if (!c) return { runnable: false, body: '読めないため案内できません' };
        const sameAsTarget = !!cur && curSlotOf === name;
        const restore = 'swap ' + name
          + (needsForceToRestore(cur ? cur.json : null, c.json, curUnsavable) ? ' --force' : '');
        const g = saveFirstText(needsName, sameAsTarget, saveBlocked, curSlotOf, curUnsavable);
        const body = g.needed ? g.cmd + '\n      ' + restore + g.why : restore;
        return { runnable: true, body };
      }).map((e, i) => ({ ...e, line: '    ' + saved[i] + ':\n      ' + e.body }));
      const heading = entries.some(e => e.runnable)
        ? '\n  利用可能なスロットと、実際に打てるコマンド(いずれか1つを選んでください):'
        // 退避はあるのに 1 つも復元できない。行き止まりではなく、各行に抜け道(改名・原因の解消)を
        // 書いてあるので、そちらを読ませる。
        : '\n  退避はありますが、いま復元できるものはありません。理由と対処は各行のとおりです:';
      fail('退避されていません: ' + target
        + heading
        + '\n' + entries.map(e => e.line).join('\n'));
    } else {
      // 素の `swap save` は、現在のログインの状態によっては退避の段で止まりうる(名前を
      // 決められない/credentials が読めない)。forceHint と同じ saveFirstText の判定で
      // 実際に打てる形にする。未ログインなら退避できるものが無く具体化しようがないので、
      // 元の案内のまま(/login を挟む以外に進みようがない)。
      let hint = '\n  まだ何も退避されていません。先に `swap save` で現在のアカウントを退避してください';
      if (cur) {
        // curUnsavable は cur が読めているこの分岐では常に null(readCurrentForGuard が
        // 両立させない)。省いても値は変わらないが、呼び出しごとに引数の数が違うと
        // 「渡し忘れ」と「渡す必要がない」を見分けられなくなるので明示する。
        const g = saveFirstText(!curSlotOf, false, false, curSlotOf, curUnsavable);
        if (g.needed) {
          hint = '\n  まだ何も退避されていません。先に `' + g.cmd
            + '` で現在のアカウントを退避してください' + g.why;
        }
      } else if (curUnsavable) {
        // ファイルはあるが読めない(壊れている/権限が無いなど)。saveCurrent 自身がこの状態を
        // 「控えだけ残して先へ進む」経路(--force)で持っているので、それを案内する。
        // 理由をそのまま渡す(ここで true を決め打ちしていた頃は、開けないファイルにも
        // 「控えが残ります」と約束していた)。
        const g = saveFirstText(false, false, false, curSlotOf, curUnsavable);
        hint = '\n  まだ何も退避されていません。現在の credentials を読めないため、先に `'
          + g.cmd + '` を実行してください' + g.why;
      }
      fail('退避されていません: ' + target + hint);
    }
  }

  // 復元先を先に検証する。壊れたファイルで現在のログインを潰さないため
  let next;
  try {
    next = readCreds(file);
  } catch {
    // 例外メッセージは出さない。JSON.parse の失敗文はファイル先頭を引用するため、
    // credentials が相手だとトークンの断片が端末やログに残る。
    // 理由は unreadableReason で切り分ける。ここを「壊れている」と決め打ちして /login を
    // 案内していた頃は、ウイルス対策やバックアップツールが一時的にスロットを掴んでいるだけの
    // ときにも同じ案内を出しており、そのとおり打つと、まだ退避していない現在のアカウントの
    // refreshToken が /login で消えていた(現在の credentials 側では既に避けている経路)。
    const why = unreadableReason(file);
    // /login を案内する前に、現在のログインが失われないことを確かめる。案内どおり打つと、
    // いまログイン中の credentials は問答無用で上書きされる。それがまだどのスロットにも
    // 退避されていなければ、「このツールで最も高い代償を払う失敗」(冒頭コメント参照)を
    // そのまま踏ませることになる。/login より先に、必ず現在の状態を確認してから案内する
    // (判定は slotsHoldingIn に揃える。同じ判定を書き起こすと基準がずれる)。
    // ここは中止メッセージを組み立てている最中なので、一覧を savedAccountsOrFail 経由で
    // 読まない。読めなければ fail() の副作用(process.exit)がここで働き、
    // いま組み立てている「target を復元できません」のメッセージ自体が、別の中止理由
    // (「一覧を読めません」)に差し替わって消えてしまう(修正E: accounts ディレクトリの
    // 読み取り権限だけが落ちている環境で発生)。読めなければ「退避済みか確認できなかった」と
    // みなし、安全側(=退避を促す側)に倒して案内を続ける。
    // 「先に退避してください」は verdict によらず常に出す。退避は現在のログインを何も壊さない
    // 操作で、先に済ませておけば、そのあと /login や別セッションの更新で現在の資格情報が
    // 入れ替わっても失わずに済む。これを分岐の内側に置いていた頃は、「時間をおいてやり直して
    // ください」以外は何も出ない行き止まりになっていた。
    let saveFirst = '';
    {
      // accessToken が無くても refreshToken だけは残っていることがある(verdict 'stale')。
      // readCredsOrNull(accessToken 必須)だけで判定していた頃は、この状態を拾えずに
      // ここを素通しして下の /login 案内だけが出ていた(cmdSave は同じ状態を見て /login を
      // 止めているのに、ここだけ食い違っていた)。
      // 壊れて JSON として読めない中身からは json を組み立てられない(readCredentials も
      // 同じ SyntaxError で落ちる)ので、verdict を 'stale' に寄せても curJson は null のまま
      // になる。救うべきものがあるかどうかは、json ではなく生バイト列に refreshToken が
      // 残っているか(hasToken)で決める。json の有無で判定していた頃は、書き込み途中で
      // 切れた credentials が唯一の refreshToken を抱えているのに「先に退避してください」が
      // 出ず、下の /login 案内だけが残っていた(そのとおり打つと、その控えごと失われる)。
      let curJson = cur ? cur.json : null;
      if (!curJson && curUnsavable && curUnsavable.verdict === 'stale') {
        try {
          curJson = readCredentials(CREDENTIALS).json;
        } catch { /* 直後に読めなくなった */ }
      }
      // スロットへ入らず控えだけが残る状態か(文面が「退避してから」ではなく
      // 「控えを残してから」に変わる)。理由オブジェクトをそのまま saveFirstText へ渡す。
      const staleCur = curUnsavable;
      const curToken = curJson ? refreshTokenOf(curJson) : null;
      const { names: savedNames, error: savedErr } = savedAccounts();
      const curSaved = !!(curToken && !savedErr && slotsHoldingIn(savedNames, curToken).length > 0);
      // 救うべきものがあるのは、読めた json があってどのスロットにも入っていないとき
      // (curJson && !curSaved)か、json を組み立てられなくても生バイト列に refreshToken が
      // 残っているとき(hasToken)。後者は中身を照合できないので「どのスロットに既に入って
      // いるか」を確かめようがない。確かめられないものを退避済みとみなすと、控えを取らせない
      // まま /login を案内することになるため、安全側(控えを勧める)に倒す。
      const rescuable = (curJson && !curSaved)
        || !!(!curJson && curUnsavable && curUnsavable.hasToken);
      if (rescuable) {
        // 案内するコマンドは saveFirstText(下の forceHint と共通)に通し、既存の overwriteGate と
        // sameAsTarget の判定を経由させる。ここだけ「swap save <curSlotOf>」と決め打ちしていた
        // 頃は、退避先に別の認証情報が入っていても素通しで案内し(--force なしでは退避の段で
        // 止まる)、退避先がたまたま target 自身だと、この fail() のすぐ下にある
        // `swap save <target> --force` が退避したばかりの内容を自分自身で潰していた。
        const curSlot0 = readCurrentSlot();
        // curJson が無い(壊れて読めない)経路では、名前も上書きガードも判定材料が無い。
        // null を overwriteGate へ渡すと別の判定に化けるので、curJson があるときだけ通す。
        const curSlotOf0 = curSlot0 || (curJson ? accountNameOf(curJson) : null);
        const needsName0 = !curSlotOf0;
        const sameAsTarget0 = curSlotOf0 === target;
        const saveBlocked0 = !!(curJson && curSlotOf0
          && overwriteGate({ json: curJson }, curSlotOf0, curSlot0).blocked);
        const g = saveFirstText(needsName0, sameAsTarget0, saveBlocked0, curSlotOf0, staleCur);
        // staleCur では「退避してから」と書けない(スロットへは入らず、控えだけが残る)。
        // 達成できないことを先に約束すると、案内どおり打った人がそこで行き止まりに入る。
        saveFirst = staleCur
          ? '\n  先に `' + g.cmd + '` で現在の中身の控えを残してから、次へ進んでください' + g.why
          : '\n  先に `' + g.cmd + '` でいまログイン中のアカウントを退避してから、'
            + '次へ進んでください' + g.why;
      }
    }
    fail(target + ' を復元できません(' + why.label + ')。上書きを中止しました'
      + '\n  ファイル: ' + file
      + saveFirst
      + (why.verdict === 'usable'
        ? '\n  いまは読めています。同じコマンドをもう一度実行してください'
          + '\n  /login はまだ試さないでください(中身は健全なので、やり直すと未退避の'
          + 'アカウントには戻れなくなります)'
        : '\n  もう一度実行しても同じなら、そのアカウントで `/login` し直してから'
          + ' `swap save ' + target + ' --force` で入れ直してください')
      + '\n  上書きで失われた旧内容の控えが残っていれば ' + REPLACED_DIR + ' から戻せることがあります');
  }

  // cur/curSlot/curSlotOf はこの関数の先頭(「退避されていません」案内より前)で読み込み済み
  // (そちらのコメント参照)。ここで読み直さない。

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

  // needsForceToRestore はモジュールスコープに定義してある(このファイル冒頭寄りの
  // isExpired の近く)。「退避されていません」案内(target が存在しないとき)からも同じ判定を
  // 呼びたいため、cmdSwap 専用のローカル関数のままにしておけなかった。
  // 向きで判定が変わるので 2 つ持つ。読み込み済みの中身をそのまま渡すのは、target は next として
  // 既に読んであり、戻す先は今の cur そのものだから(同じファイルを読み直しても結果は変わらない)。
  //   restoreCmd     … いま target を復元する向き(現在は cur)
  //   restoreBackCmd … 切り替えたあと元へ戻す向き(そのときの現在は next で、復元先は cur の内容)
  const restoreCmd = 'swap ' + target
    + (needsForceToRestore(cur ? cur.json : null, next.json, curUnsavable) ? ' --force' : '');
  // 名前がサブコマンドと衝突しているスロットへは、打って戻れる形が存在しない。ここで文字列を
  // 返すと「元に戻すには: swap save」を案内することになり、そのとおり打った人は退避を走らせて
  // 切り替わったまま exit 0 で終わる(戻したつもりで戻れていない)。打てる形が無いことを
  // null で表し、改名の手順は呼び出し側に出させる(reportOtherSlots は returnCmd 無しの
  // 場合を既に持っている)。curUnsavable は cur が読めているこの経路では常に null だが、
  // 省くと needsForceToRestore の引数の意味が呼び出しごとに変わって見えるので渡しておく。
  const restoreBackCmd = (name) => restorableByName(name)
    ? 'swap ' + name
      + (needsForceToRestore(next.json, cur ? cur.json : null, curUnsavable) ? ' --force' : '')
    : null;
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
  // saveInto と同じ overwriteGate に通し、条件を書き写さない。文面の組み立ては saveFirstText
  // (上の target 読み込み失敗時の中断案内と共通)に揃える。
  const needsName = !!cur && !curSlotOf;
  const sameAsTarget = !!cur && curSlotOf === target;
  const saveBlocked = !!(cur && curSlotOf && overwriteGate(cur, curSlotOf, curSlot).blocked);
  // curUnsavable を省いていた頃は、現在の credentials を開けない状態(cur が null なので
  // needsName / sameAsTarget / saveBlocked が 3 つとも false になる)で saveFirst が立たず、
  // 案内が裸の `swap <target> --force` に退化していた。そのとおり打つと keepAside が控えを
  // 取れずに中止し、「もう一度実行してください」へ落ちる無限リトライになる。すぐ上の
  // needsForceToRestore には同じ curUnsavable を渡して --force を要求しているので、
  // 理由の説明だけが欠ける食い違いでもあった。
  const { needed: saveFirst, cmd: saveFirstCmd, why: saveFirstWhy } =
    saveFirstText(needsName, sameAsTarget, saveBlocked, curSlotOf, curUnsavable);
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
    // 控えの扱いは keptNote に集約する。ここと cmdStatus が別々に判断していた頃は、実際に
    // 控えを作るこの経路だけが「使えない」と断定し、cmdStatus は同じ控えを「消さないで
    // ください」と案内していて、指示が食い違っていた。
    console.log('  ' + keptNote(why.verdict));
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
    // 直前の console.log は stdout に出ている。degraded だった場合そこにしか無い「中身の控え」の
    // パスを、process.exit がパイプ越しに切ってしまうことがある(fail が守るのは stderr だけ)。
    // 控えの場所を見失うと、読めなかった現在のログインを取り戻す手掛かりが消えるので、ここは
    // 文面だけ出して自然に抜ける。
    failText('認証情報の差し替えに失敗しました(' + (e.code || e.message) + ')'
      + '\n  ' + CREDENTIALS + ' を書き換えられません。'
      + dirIsFileHint(e, path.dirname(CREDENTIALS),
        '稼働中の Claude Code など、このファイルを掴んでいるプロセスを終了するか、'
        + '読み取り専用属性を外してください')
      + '\n  認証は切り替わっていません'
      + (saved && saved.name
        ? '(現在のログインは ' + saved.name + ' へ退避済みで、失われたものはありません)'
        : '')
      + (saved && saved.degraded && saved.kept
        ? '\n  読めなかった現在の内容の控え: ' + saved.kept
        : '')
      + '\n  原因を取り除いてから、もう一度 `swap ' + target + (force ? ' --force' : '') + '` を実行してください');
    process.exitCode = 1;
    return;
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
  } else if (saved && saved.name) {
    // 退避そのものは済んでいるので失われた内容は無く、塞がっているのは戻す手順だけ。
    // 黙って行を省くと「戻せる」と誤解したまま切り替えを済ませてしまうので、改名を案内する。
    console.log('  元に戻すには: ' + renameToRestoreText(saved.name));
  }

  // 取り残された他スロットの案内は切り替えの「あと」に出す。切り替え前に出していた頃は
  // 案内の意味が反対になっていた(reportOtherSlots のコメント参照)。戻る手順を添えて渡す。
  // 戻す手順が出せないのはここ(切り替え済み)だけなので、注記もここで組み立てて渡す。
  if (saved && saved.name) {
    reportOtherSlots(saved, backCmd, backCmd ? null
      : '(先に元へ戻さないと、いま復元したアカウントの内容で上書きされます。'
        + '戻し方は上の「元に戻すには」を参照してください)');
  }
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
  // 想定外の例外は、どの出力の途中でも起こりうる唯一の経路(他の fail はすべて、まだ何も
  // stdout へ出していない時点のガードとして使っている)。ここで process.exit すると、
  // そこまでに出した行 ─ 切り替えの結果、退避先、控えの場所 ─ がパイプ越しに切れて、
  // 何がどこまで済んだのかを読み取れなくなる。exitCode を立てて自然に抜ける。
  failText(e.message);
  process.exitCode = 1;
}
