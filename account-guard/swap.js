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

const fs = require('fs');
const path = require('path');
// credentials の場所と読み方は account-guard.js と共有する(credentials.js のコメント参照)。
const { HOME, CREDENTIALS, readCredentials, subscriptionTypeOf } = require('./credentials');

// 退避先を ~/.claude 配下に置くのは、元の credentials と同じ ACL を継承させるため。
// 平文トークンの本数は増えるが、保護レベルは変わらない(§6.1 の「残るリスク」)。
const ACCOUNTS_DIR = path.join(HOME, '.claude', 'accounts');

// アカウント名はそのままファイル名になるので、パス区切りや相対参照を弾く
const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const DAY_MS = 86400000;

function fail(msg) {
  console.error('エラー: ' + msg);
  process.exit(1);
}

// credentials を読む。復元に使える中身であることまで確かめる(accessToken が無いものを
// 復元しても意味がない)。raw を保持するのは、退避時に JSON を再生成せず元のバイト列を
// そのまま書き戻すため(フィールド順や表記の揺れを持ち込まない)。
function readCreds(file) {
  const c = readCredentials(file);
  if (!c.json || !c.json.claudeAiOauth || !c.json.claudeAiOauth.accessToken) {
    throw new Error('claudeAiOauth.accessToken が無い');
  }
  return c;
}

function readCredsOrNull(file) {
  try {
    return readCreds(file);
  } catch {
    // 未ログイン・破損・将来の構造変更。呼び出し側で「現在なし」として扱う
    return null;
  }
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
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // Windows では移動先を他プロセスが開いていると rename が EPERM で落ちる
    // (稼働中の Claude Code が credentials を掴んでいる場合)。放置すると平文トークン入りの
    // .tmp が残るが、一覧は `.json` しか拾わないので誰も気づけない。必ず消してから投げる。
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
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
  const left = msLeft(json);
  if (left === null) return '';
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

// 退避先の名前は subscriptionType から導くが、`swap save <明示名>` で別名を付けたスロットも
// 同じアカウントを指している。名前だけを見て 1 つしか更新しないと、明示名のスロットが
// 古いスナップショットのまま取り残され、`swap <明示名>` でローテート済みのトークンを
// 復元して認証が通らなくなる。同じアカウントを指すスロットは揃って更新する。
// 同一判定に subscriptionType を使うのは identity フィールドが無いため。同一プランを
// 2 つ持つ構成では区別できないが、それは退避名の衝突と同じ既知の前提(§6.1)。
function slotsForSameAccount(json, primary) {
  const names = new Set(primary ? [primary] : []);
  const type = subscriptionTypeOf(json);
  if (type) {
    for (const name of savedAccounts()) {
      const c = readCredsOrNull(accountFile(name));
      if (c && subscriptionTypeOf(c.json) === type) names.add(name);
    }
  }
  return [...names];
}

// 現在ログイン中の認証情報を accounts/ に退避する。戻り値は書き込んだ名前の一覧。
function saveCurrent(explicitName) {
  const cur = readCredsOrNull(CREDENTIALS);
  if (!cur) return null;
  const primary = explicitName || accountNameOf(cur.json);
  if (!primary) {
    throw new Error('subscriptionType が読めないため退避名を決められない。名前を明示して save してください');
  }
  const names = slotsForSameAccount(cur.json, primary);
  for (const name of names) writeAtomic(accountFile(name), cur.raw);
  return names;
}

function cmdStatus() {
  const cur = readCredsOrNull(CREDENTIALS);
  const curType = cur ? subscriptionTypeOf(cur.json) : null;
  console.log('現在のアカウント: ' + (curType || (cur ? '不明(subscriptionType が読めない)' : '未ログイン')));
  if (cur) console.log('  ' + CREDENTIALS + expiryNote(cur.json));

  const saved = savedAccounts();
  console.log('\n退避済み (' + ACCOUNTS_DIR + '):');
  if (saved.length === 0) {
    console.log('  なし。`swap save` で現在のアカウントを退避してください');
    return;
  }
  for (const name of saved) {
    const c = readCredsOrNull(accountFile(name));
    // 印は名前ではなくプラン種別で合わせる。明示名で退避したスロットにも印が付く
    const isCurrent = Boolean(c && curType && subscriptionTypeOf(c.json) === curType);
    console.log((isCurrent ? '* ' : '  ') + name.padEnd(8) + (c ? expiryNote(c.json) : '  [読めません]'));
  }
}

function cmdSave(name) {
  if (name && !NAME_RE.test(name)) fail('アカウント名に使えない文字が含まれています: ' + name);
  const saved = saveCurrent(name);
  if (!saved) fail('現在の credentials を読めません(未ログインか破損)');
  console.log('退避しました: ' + saved.join(', ') + ' -> ' + ACCOUNTS_DIR);
}

function cmdSwap(target, force) {
  if (!NAME_RE.test(target)) fail('アカウント名に使えない文字が含まれています: ' + target);

  const file = accountFile(target);
  if (!fs.existsSync(file)) {
    fail('退避されていません: ' + target + '\n  利用可能: ' + (savedAccounts().join(', ') || 'なし'));
  }

  // 復元先を先に検証する。壊れたファイルで現在のログインを潰さないため
  let next;
  try {
    next = readCreds(file);
  } catch {
    // 例外メッセージは出さない。JSON.parse の失敗文はファイル先頭を引用するため、
    // credentials が相手だとトークンの断片が端末やログに残る
    fail(target + ' の内容が壊れているか、想定した形式ではありません。上書きを中止しました'
      + '\n  ファイル: ' + file);
  }

  // 失効済みの復元先は切り替える前に止める。上書きしてから気づいてもマシン全体が
  // 未ログインになっており、稼働中の別セッションも次のリクエストで認証エラーになる。
  if (isExpired(next.json) && !force) {
    fail(target + ' の refreshToken は失効しています。復元しても /login のやり直しになるため中止しました'
      + '\n  現在のログインはそのままです。承知のうえで上書きするなら: swap ' + target + ' --force');
  }

  const cur = readCredsOrNull(CREDENTIALS);
  const curName = cur ? accountNameOf(cur.json) : null;

  // 同一かどうかは名前ではなくプラン種別で見る。`swap save personal` のような別名スロットは
  // 名前が現在のアカウント名と一致しないので、名前だけで比べると「切り替え」として処理が進み、
  // 退避で最新化したスロットを、その前に読み込んだ古い内容で上書きし直してしまう
  // (現在のログインが古いスナップショットに退化する)。
  const curType = cur ? subscriptionTypeOf(cur.json) : null;
  const nextType = subscriptionTypeOf(next.json);
  const sameAccount = curType && nextType ? curType === nextType : curName === target;
  if (sameAccount) {
    console.log(curName === target
      ? 'すでに ' + target + ' でログインしています。何もしません'
      : 'すでに ' + target + ' と同じアカウント(' + curType + ')でログインしています。何もしません');
    return;
  }

  // 現在を退避してから差し替える。この退避が唯一のバックアップなので、失敗したら進まない
  if (cur) {
    if (!curName) {
      fail('現在のアカウント名を判定できないため退避できません。`swap save <name>` で名前を明示してください');
    }
    const names = slotsForSameAccount(cur.json, curName);
    for (const name of names) writeAtomic(accountFile(name), cur.raw);
    console.log('退避: ' + names.join(', '));
  } else if (fs.existsSync(CREDENTIALS)) {
    // 「未ログイン(ファイルが無い)」と「読めない(破損・権限・書き込み中)」を区別する。
    // 後者で進むと、退避できていない生きた credentials を上書きして復旧不能にする。
    // Claude Code がトークンを更新している最中にも起こりうるので、黙って進んではいけない。
    fail('現在の credentials を読めません(破損しているか、他のプロセスが書き込み中)。'
      + '退避できないため中止しました'
      + '\n  時間をおいて再実行するか、中身を確認してから `swap save <name>` で退避してください');
  } else {
    console.log('現在ログインしていないため、退避はしません');
  }

  writeAtomic(CREDENTIALS, next.raw);
  console.log('切り替え: ' + (curName || 'なし') + ' -> ' + target + expiryNote(next.json));
  console.log('注意: この変更はマシン全体に即座に効きます。稼働中の別セッションも切り替わります');
}

function usage() {
  console.log(`Claude のログインアカウントを切り替える

  swap                現在のアカウントと退避済み一覧を表示
  swap <name>         現在を退避してから <name> を復元
  swap <name> --force 復元先が失効済みでも中止せずに切り替える
  swap save [<name>]  現在のアカウントを退避するだけ(切り替えない)
                      名前を省略すると subscriptionType(team / pro など)を使う

退避先: ${ACCOUNTS_DIR}

タイマーやフックから自動実行しないこと。認証の入れ替えはマシン全体に即座に効き、
稼働中の別セッションを巻き込みます(docs/account-separation.md §1.3 / §6.1)。`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) return cmdStatus();
  const [cmd, ...rest] = args;
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') return usage();
  // 余分な引数は typo の兆候なので黙って捨てない(save は名前を 1 つだけ取る)
  if (cmd === 'save') {
    if (rest.length > 1) fail('引数が多すぎます: ' + args.join(' '));
    return cmdSave(rest[0]);
  }
  const force = rest.includes('--force');
  const extra = rest.filter(a => a !== '--force');
  if (extra.length > 0) fail('引数が多すぎます: ' + args.join(' '));
  return cmdSwap(cmd, force);
}

try {
  main();
} catch (e) {
  fail(e.message);
}
