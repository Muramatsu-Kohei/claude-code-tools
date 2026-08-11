// account-guard.js(ガード)と swap.js(切り替え)が共有する、credentials の置き場所と読み方。
//
// 分けてある理由: 両方とも「~/.claude/.credentials.json を読んでプラン種別を取り出す」
// という同じ前提の上に立っている。片方だけ直すと、ガードは deny するのに swap は
// 「切り替え成功」と言う、といった食い違いが起きて原因の特定に時間がかかる。
// 前提は 1 箇所に置き、両方が同じものを見るようにする。

const fs = require('fs');
const os = require('os');
const path = require('path');

// HOME として使える値か。空文字・空白のみは「無い」のと同じに扱う。Windows では
// USERPROFILE が「空文字として存在する」だけのことがあり(実測)、素通しにすると
// `||` チェーンがそこで確定してしまい、後段の os.homedir() まで辿り着けない。
function usableHome(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

// 環境変数を先に見るのは、テストが USERPROFILE / HOME を差し替えて隔離した HOME で
// フックを動かすため(os.homedir() は差し替えを反映しないことがある)。
// 最後の砦を '.' にしないのは、両方とも持たない環境(サービスアカウント、絞ったシェル、
// 一部の CI)で credentials とスロットがカレントディレクトリ配下として解決され、
// 「未ログイン・退避なし」に見えてしまうため。退避が消えたと誤解させる表示になるうえ、
// 原因(HOME の誤解決)はどこにも出ない。os.homedir() なら誤解決にはならない。
const HOME = usableHome(process.env.USERPROFILE) || usableHome(process.env.HOME) || usableHome(os.homedir());
if (!HOME) {
  // 環境変数も os.homedir() も使える値を返さない、極端に壊れた環境。ここで '.' 等の
  // 相対パスへ逃げると、上のコメントで避けたはずの「カレントディレクトリ配下として解決され、
  // 保護や退避が消えたように見える」事故を空文字経由で再現してしまう。呼び出し側
  // (account-guard.js / swap.js)は require の失敗として拾い、既存の「読めない」経路
  // (拒否側に倒す・真因を案内する)にそのまま合流する。
  // 呼び出し側が「ファイルが無い・置き場所が違う」と取り違えないよう、原因を code で示す。
  // 文面での判別に頼ると、メッセージを直した瞬間に静かに誤診断へ戻る。
  const e = new Error('HOME を解決できません(USERPROFILE / HOME / os.homedir() のいずれも使える値を返しませんでした)');
  e.code = 'HOME_UNRESOLVED';
  throw e;
}
const CREDENTIALS = path.join(HOME, '.claude', '.credentials.json');

// アカウントを判別できなかったときの値。collect.js と同じ規約。
const ACCOUNT_UNKNOWN = 'unknown';

// 生のバイト列も返すのは、swap が退避するときに JSON を再生成せず元のバイト列を
// そのまま書き戻すため(フィールド順や表記の揺れを持ち込まない)。
function readCredentials(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return { raw, json: JSON.parse(raw) };
}

// 「復元に使える中身か」の判定。JSON として読めることと、認証に使えることは別で、
// `{}` や `{"claudeAiOauth":{}}` は JSON.parse を通るが復元しても意味がない。
// ここを 1 箇所に置くのは、ガードと swap で基準がずれると「ガードは正常と判定して
// swap を案内するのに、swap は読めないと言って必ず失敗する」袋小路が生まれるため
// (実際にそうなっていた: ガードは JSON.parse の成否だけを見ていた)。
function hasUsableCredentials(json) {
  return Boolean(json && json.claudeAiOauth && json.claudeAiOauth.accessToken);
}

// credentials に uuid やメールアドレスのような identity フィールドは存在しないため、
// プラン種別を代用の識別子にする(2026-08 時点で実測済み)。
function subscriptionTypeOf(json) {
  const t = json?.claudeAiOauth?.subscriptionType;
  return typeof t === 'string' && t ? t : null;
}

// ガードの判定用。読めなければ判別不能として扱い、拒否側に倒すのは呼び出し側の責任。
function currentAccount() {
  try {
    return subscriptionTypeOf(readCredentials(CREDENTIALS).json) || ACCOUNT_UNKNOWN;
  } catch {
    // 未ログイン・権限不足・将来の構造変更のいずれか。
    return ACCOUNT_UNKNOWN;
  }
}

module.exports = {
  HOME,
  CREDENTIALS,
  ACCOUNT_UNKNOWN,
  readCredentials,
  hasUsableCredentials,
  subscriptionTypeOf,
  currentAccount,
};
