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
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CREDENTIALS = path.join(HOME, '.claude', '.credentials.json');
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

// credentials を読む。raw を保持するのは、退避時に JSON を再生成せず元のバイト列を
// そのまま書き戻すため(フィールド順や表記の揺れを持ち込まない)。
function readCreds(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const json = JSON.parse(raw);
  if (!json || !json.claudeAiOauth || !json.claudeAiOauth.accessToken) {
    throw new Error('claudeAiOauth.accessToken が無い');
  }
  return { raw, json };
}

function readCredsOrNull(file) {
  try {
    return readCreds(file);
  } catch {
    // 未ログイン・破損・将来の構造変更。呼び出し側で「現在なし」として扱う
    return null;
  }
}

// credentials には uuid やメールアドレスのような identity フィールドが無いため、
// プラン種別を代用の識別子にする(account-guard.js / claude-window-ping.ps1 と同じ判断)。
// 同一プランを 2 つ持つ構成では衝突するが、想定は 組織 Team + 個人 Pro の 1 組。
function accountNameOf(json) {
  const t = json.claudeAiOauth.subscriptionType;
  if (typeof t === 'string' && NAME_RE.test(t)) return t;
  return null;
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
  fs.renameSync(tmp, file);
}

// refreshToken には有効期限があり、切れていると復元しても /login のやり直しになる。
// 期間は公表されていないので日数を決め打ちせず、常にトークン自身の値から残りを出す
// (2026-08-09 の実測では残り 26 日だった)。
function expiryNote(json) {
  const at = json.claudeAiOauth.refreshTokenExpiresAt;
  if (typeof at !== 'number') return '';
  const left = at - Date.now();
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

// 現在ログイン中の認証情報を accounts/<name>.json に退避する。戻り値は退避した名前。
function saveCurrent(explicitName) {
  const cur = readCredsOrNull(CREDENTIALS);
  if (!cur) return null;
  const name = explicitName || accountNameOf(cur.json);
  if (!name) {
    throw new Error('subscriptionType が読めないため退避名を決められない。名前を明示して save してください');
  }
  writeAtomic(accountFile(name), cur.raw);
  return name;
}

function cmdStatus() {
  const cur = readCredsOrNull(CREDENTIALS);
  const curName = cur ? accountNameOf(cur.json) : null;
  console.log('現在のアカウント: ' + (curName || (cur ? '不明(subscriptionType が読めない)' : '未ログイン')));
  if (cur) console.log('  ' + CREDENTIALS + expiryNote(cur.json));

  const saved = savedAccounts();
  console.log('\n退避済み (' + ACCOUNTS_DIR + '):');
  if (saved.length === 0) {
    console.log('  なし。`swap save` で現在のアカウントを退避してください');
    return;
  }
  for (const name of saved) {
    const c = readCredsOrNull(accountFile(name));
    const mark = name === curName ? '* ' : '  ';
    console.log(mark + name.padEnd(8) + (c ? expiryNote(c.json) : '  [読めません]'));
  }
}

function cmdSave(name) {
  if (name && !NAME_RE.test(name)) fail('アカウント名に使えない文字が含まれています: ' + name);
  const saved = saveCurrent(name);
  if (!saved) fail('現在の credentials を読めません(未ログインか破損)');
  console.log('退避しました: ' + saved + ' -> ' + accountFile(saved));
}

function cmdSwap(target) {
  if (!NAME_RE.test(target)) fail('アカウント名に使えない文字が含まれています: ' + target);

  const file = accountFile(target);
  if (!fs.existsSync(file)) {
    fail('退避されていません: ' + target + '\n  利用可能: ' + (savedAccounts().join(', ') || 'なし'));
  }

  // 復元先を先に検証する。壊れたファイルで現在のログインを潰さないため
  let next;
  try {
    next = readCreds(file);
  } catch (e) {
    fail(target + ' の内容が不正です (' + e.message + ')。上書きを中止しました');
  }

  const cur = readCredsOrNull(CREDENTIALS);
  const curName = cur ? accountNameOf(cur.json) : null;

  if (curName === target) {
    console.log('すでに ' + target + ' でログインしています。何もしません');
    return;
  }

  // 現在を退避してから差し替える。この退避が唯一のバックアップなので、失敗したら進まない
  if (cur) {
    if (!curName) {
      fail('現在のアカウント名を判定できないため退避できません。`swap save <name>` で名前を明示してください');
    }
    writeAtomic(accountFile(curName), cur.raw);
    console.log('退避: ' + curName);
  } else {
    console.log('警告: 現在の credentials を読めないため退避をスキップします');
  }

  writeAtomic(CREDENTIALS, next.raw);
  console.log('切り替え: ' + (curName || '不明') + ' -> ' + target + expiryNote(next.json));
  console.log('注意: この変更はマシン全体に即座に効きます。稼働中の別セッションも切り替わります');
}

function usage() {
  console.log(`Claude のログインアカウントを切り替える

  swap                現在のアカウントと退避済み一覧を表示
  swap <name>         現在を退避してから <name> を復元
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
  if (rest.length > 0) fail('引数が多すぎます: ' + args.join(' '));
  return cmdSwap(cmd);
}

try {
  main();
} catch (e) {
  fail(e.message);
}
