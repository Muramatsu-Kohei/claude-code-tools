// account-guard.js(ガード)と swap.js(切り替え)が共有する、credentials の置き場所と読み方。
//
// 分けてある理由: 両方とも「~/.claude/.credentials.json を読んでプラン種別を取り出す」
// という同じ前提の上に立っている。片方だけ直すと、ガードは deny するのに swap は
// 「切り替え成功」と言う、といった食い違いが起きて原因の特定に時間がかかる。
// 前提は 1 箇所に置き、両方が同じものを見るようにする。

const fs = require('fs');
const os = require('os');
const path = require('path');

// 環境変数を先に見るのは、テストが USERPROFILE / HOME を差し替えて隔離した HOME で
// フックを動かすため(os.homedir() は差し替えを反映しないことがある)。
// 最後の砦を '.' にしないのは、両方とも持たない環境(サービスアカウント、絞ったシェル、
// 一部の CI)で credentials とスロットがカレントディレクトリ配下として解決され、
// 「未ログイン・退避なし」に見えてしまうため。退避が消えたと誤解させる表示になるうえ、
// 原因(HOME の誤解決)はどこにも出ない。os.homedir() なら誤解決にはならない。
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const CREDENTIALS = path.join(HOME, '.claude', '.credentials.json');

// アカウントを判別できなかったときの値。collect.js と同じ規約。
const ACCOUNT_UNKNOWN = 'unknown';

// 生のバイト列も返すのは、swap が退避するときに JSON を再生成せず元のバイト列を
// そのまま書き戻すため(フィールド順や表記の揺れを持ち込まない)。
function readCredentials(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return { raw, json: JSON.parse(raw) };
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
  subscriptionTypeOf,
  currentAccount,
};
