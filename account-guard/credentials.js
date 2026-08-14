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
  try {
    return { raw, json: JSON.parse(raw) };
  } catch (e) {
    // パースに失敗しても、読めたバイト列そのものは呼び出し側の判断材料になる(切り詰められた
    // credentials には refreshToken が残っていることがある)。ここで捨てると、呼び出し側は
    // 同じファイルを読み直すしかなく、その隙に書き換われば判定と実体がずれる。
    e.raw = raw;
    throw e;
  }
}

// ファイルの素性を 1 回の読み取りで確かめる。「無い」と「読めない」を分ける唯一の場所。
//
// fs.existsSync を使わないのは、Node の仕様上 stat が失敗すれば理由を問わず false を返す
// ためで、権限が足りない・別プロセスが掴んでいる・同名のディレクトリが置かれている、
// といった「あるのに読めない」状態がすべて「無い」と区別できなくなる。このツールで
// 「無い」は「失うものは無いので上書きしてよい」と同義なので、取り違えると生きた資格情報を
// 控えなしで潰す(実際に writeSlot と saveCurrent がその形になっていた)。
//
// したがって exists は「ENOENT だったときだけ false」にする。EACCES/EBUSY/EISDIR/ENOTDIR
// などは「あるかもしれないが確かめられない」として exists を true 側に倒す。安全側とは、
// 常に「まだ失って困るものがあるかもしれない」と考える側のこと。
//
// readable と exists を分けて返すのは、呼び出し側の問いが 2 種類あるため。
//   - 上書き・削除してよいか      → exists を見る(「無い」ときだけ素通し)
//   - 中身を判断材料に使えるか    → readable と json を見る
// raw も返すのは、パースできなくても切り詰められた中に refreshToken が残ることがあり
// (rawHasRecoverableToken)、その判断材料をここで捨てると呼び出し側が読み直すしかなく、
// その隙に書き換わると判定と実体がずれるため。
function probeFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const missing = e.code === 'ENOENT';
    return {
      exists: !missing,
      readable: false,
      raw: null,
      json: null,
      code: e.code || null,
      parseError: false,
    };
  }
  try {
    return { exists: true, readable: true, raw, json: JSON.parse(raw), code: null, parseError: false };
  } catch {
    // 読めたが JSON として壊れている。raw は残すので、呼び出し側は
    // rawHasRecoverableToken でトークンの残骸を確かめられる。
    return { exists: true, readable: true, raw, json: null, code: null, parseError: true };
  }
}

// 「復元に使える中身か」の判定。JSON として読めることと、認証に使えることは別で、
// `{}` や `{"claudeAiOauth":{}}` は JSON.parse を通るが復元しても意味がない。
// ここを 1 箇所に置くのは、ガードと swap で基準がずれると「ガードは正常と判定して
// swap を案内するのに、swap は読めないと言って必ず失敗する」袋小路が生まれるため
// (実際にそうなっていた: ガードは JSON.parse の成否だけを見ていた)。
function hasUsableCredentials(json) {
  return Boolean(json && json.claudeAiOauth && json.claudeAiOauth.accessToken);
}

// 「上書きしたら失って困るものが残っているか」。復元に使えるか(hasUsableCredentials)とは
// 別の問いなので判定も分ける。accessToken が無くても refreshToken が残っていれば、それは
// 交換すればまた使える資格情報で、/login で上書きすれば復旧はブラウザ OAuth のやり直しになる。
// 2 つを同じ判定で済ませていた頃は、ガードが「この状態で失われる認証情報はない」と断言して
// /login を勧めており、書き込み途中の credentials(accessToken だけ欠ける)がその条件に当たった。
function hasRecoverableToken(json) {
  const o = json && json.claudeAiOauth;
  return Boolean(o && (o.accessToken || o.refreshToken));
}

// JSON として読めないバイト列に、失って困る資格情報が残っているか。書き込みの途中で
// 切り詰められた credentials は JSON.parse に失敗するが、切れた位置より手前のバイト列には
// refreshToken がそのまま残っていることがある。パースできないことを根拠に「失って困るものは
// 無い」と断言すると、まだ退避していないアカウントの唯一のコピーを、/login の案内や
// 「この控えは消して構いません」の案内で捨てさせることになる(ガード側・status 側の
// 両方で実際にそうなっていた)。パースを通らない中身について言えるのは「トークンらしき
// 文字列が残っているか」までなので、判定もそこまでにとどめ、残っていれば消させない側に倒す。
// 値の 1 文字目まで見るのは、`"refreshToken":"` で切れた残骸だけを根拠に残さないため。
const RAW_TOKEN_RE = /"(?:refreshToken|accessToken)"\s*:\s*"[^"]/;
function rawHasRecoverableToken(raw) {
  return RAW_TOKEN_RE.test(typeof raw === 'string' ? raw : String(raw));
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
  probeFile,
  hasUsableCredentials,
  hasRecoverableToken,
  rawHasRecoverableToken,
  subscriptionTypeOf,
  currentAccount,
};
