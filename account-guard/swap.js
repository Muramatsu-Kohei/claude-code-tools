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
// == アカウントの同一性を推測しない ==
// credentials には uuid やメールアドレスのような identity フィールドが無い
// (credentials.js のコメント参照)。以前は subscriptionType を代用の識別子にして
// 「同じアカウントを指すスロット」を割り出していたが、それでは同一プランの別アカウントを
// 同じものと誤認し、相手の唯一のバックアップを黙って上書きして消す経路があった。
// 推測はやめ、「現在のログインはどのスロットから来たか」を .current に記録する。
// 書き込むのは常にそのスロット 1 つだけで、他のスロットには決して触れない。
//
// このツールで最も高い代償を払う失敗は、退避されていない資格情報を失うこと(ブラウザ
// OAuth のやり直しになる)。判断に迷う場面では、切り替えを諦めて現状を保つ方に倒す。
// ただし「止まるだけで抜け出せない」状態も作らない。中止するときは必ず、実際に効く
// 次の一手(多くは --force)を添える。

const fs = require('fs');
const path = require('path');
// credentials の場所と読み方は account-guard.js と共有する(credentials.js のコメント参照)。
const { HOME, CREDENTIALS, readCredentials, subscriptionTypeOf } = require('./credentials');

// 退避先を ~/.claude 配下に置くのは、元の credentials と同じ ACL を継承させるため。
// 平文トークンの本数は増えるが、保護レベルは変わらない(§6.1 の「残るリスク」)。
const ACCOUNTS_DIR = path.join(HOME, '.claude', 'accounts');
// 現在のログインの来歴。スロットではないので、一覧が拾う `*.json` に当たらない名前にする。
const CURRENT_FILE = path.join(ACCOUNTS_DIR, '.current');

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

// 来歴が無いときに同一性を確かめる最後の手掛かり。値そのものは比較にしか使わず、
// 出力にもログにも出さない。ローテートで変わるので「一致すれば同じ」しか言えない
// (不一致は「別アカウント」と「ローテート済みの同一アカウント」の区別が付かない)。
function refreshTokenOf(json) {
  const t = json?.claudeAiOauth?.refreshToken;
  return typeof t === 'string' && t ? t : null;
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

// 退避の実体。読み込み済みの creds をそのまま書くのは、CREDENTIALS を二度読むと
// 「比較したバイト列」と「退避するバイト列」がずれるため(その隙に Claude Code が
// トークンを更新すると、退避したつもりの中身が別物になる)。
function writeSlot(cur, name) {
  writeAtomic(accountFile(name), cur.raw);
  writeCurrentSlot(name);
}

// 現在のログインがどのスロットに対応するか。来歴を第一の根拠にし、まだ記録が無いときだけ
// subscriptionType 由来の名前で代用する。代用には同一プランの別アカウントを区別できない
// 弱点があるので、上書きの直前に guardOverwrite で改めて裏を取る。
function currentSlotOf(cur) {
  return readCurrentSlot() || (cur && cur.json ? accountNameOf(cur.json) : null);
}

// 別アカウントのバックアップを潰さないための門番。退避スロットは唯一のコピーなので、
// 消えたらブラウザ OAuth のやり直ししかない。来歴で自分のスロットだと確認できるか、
// 中身が現在と一致する場合だけ黙って上書きし、それ以外は止めて判断を人に返す。
function guardOverwrite(name, cur, force) {
  if (force || !fs.existsSync(accountFile(name))) return;
  if (readCurrentSlot() === name) return; // 来歴が一致 = このスロットから復元したもの

  const c = readCredsOrNull(accountFile(name));
  const mine = cur && cur.json ? refreshTokenOf(cur.json) : null;
  const theirs = c ? refreshTokenOf(c.json) : null;
  if (mine && mine === theirs) return; // 同じ資格情報がすでに入っている

  const type = c ? subscriptionTypeOf(c.json) : null;
  fail('退避先 ' + name + ' には別の認証情報が入っている可能性があります'
    + (type ? '(' + type + ')' : '')
    + '。上書きすると、そこに入っているアカウントの唯一のバックアップが失われます'
    + '\n  現在のログインはそのままです。同じアカウントだと分かっているなら:'
    + '\n    swap save ' + name + ' --force');
}

// 現在ログイン中の認証情報を accounts/ に退避する。書き込むのは 1 スロットだけで、
// 他のスロットには触れない。戻り値は { name, degraded } か、未ログインなら null。
function saveCurrent(explicitName, force) {
  const cur = readCredsOrNull(CREDENTIALS);

  if (!cur) {
    if (!fs.existsSync(CREDENTIALS)) return null; // 単に未ログイン
    // 「読めない」で止めるだけだと、この状態から抜け出す手段が無くなる(swap も save も
    // 同じ判定で止まるため)。中身を確認した人が先へ進めるよう、raw のまま退避させる。
    if (!force) {
      fail('現在の credentials を読めません(破損しているか、他のプロセスが書き込み中)'
        + '\n  時間をおいて再実行してください。中身を確認したうえで、そのまま退避するなら:'
        + '\n    swap save ' + (explicitName || '<name>') + ' --force');
    }
    const name = explicitName || readCurrentSlot();
    if (!name) fail('退避名を決められません。`swap save <name> --force` で名前を明示してください');
    writeSlot({ raw: fs.readFileSync(CREDENTIALS, 'utf8') }, name);
    return { name, degraded: true };
  }

  const name = explicitName || currentSlotOf(cur);
  if (!name) {
    fail('退避名を決められません(subscriptionType が読めず、来歴も記録されていません)'
      + '\n  `swap save <name>` で名前を明示してください。以後その名前が来歴として記録され、'
      + '名前を省略しても退避できるようになります');
  }
  guardOverwrite(name, cur, force);
  writeSlot(cur, name);
  return { name, degraded: false };
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
  else if (exists) label = '読めません(破損しているか、他のプロセスが書き込み中)';
  else label = '未ログイン';

  console.log('現在のアカウント: ' + label + (curSlot ? '  [' + curSlot + ' から復元]' : ''));
  if (exists) console.log('  ' + CREDENTIALS + (cur ? expiryNote(cur.json) : ''));

  const saved = savedAccounts();
  console.log('\n退避済み (' + ACCOUNTS_DIR + '):');
  if (saved.length === 0) {
    console.log('  なし。`swap save` で現在のアカウントを退避してください');
    return;
  }
  for (const name of saved) {
    const c = readCredsOrNull(accountFile(name));
    // 印は来歴が指すスロットにだけ付ける。プラン種別で合わせると、同一プランの別アカウントに
    // まで印が付き、「これが現在のバックアップだ」と誤解したまま上書きさせてしまう。
    console.log((name === curSlot ? '* ' : '  ') + name.padEnd(8)
      + (c ? expiryNote(c.json) : '  [読めません]'));
  }
  if (!curSlot && cur) {
    console.log('\n来歴が未記録です。`swap save <name>` で退避すると、以後どのスロット由来かを記録します');
  }
}

function cmdSave(name, force) {
  if (name && !NAME_RE.test(name)) fail('アカウント名に使えない文字が含まれています: ' + name);
  const saved = saveCurrent(name, force);
  if (!saved) fail('現在 credentials がありません(未ログイン)');
  console.log('退避しました: ' + saved.name + ' -> ' + accountFile(saved.name));
  if (saved.degraded) {
    console.log('注意: 中身は復元に使える形ではありません(accessToken が読めませんでした)。'
      + '記録として残しただけです');
  }
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

  // subscriptionType が無い中身を復元すると、account-guard は現在のアカウントを判別できず
  // (currentAccount が unknown を返す)、保護ツリーへの操作をすべて拒否し続ける。
  // 切り替えてから気づくと、元に戻す操作まで巻き添えで拒否されるので手前で止める。
  if (!subscriptionTypeOf(next.json) && !force) {
    fail(target + ' には subscriptionType がありません。復元すると account-guard がアカウントを'
      + '判別できなくなり、保護ツリーへの操作がすべて拒否されます'
      + '\n  現在のログインはそのままです。承知のうえで復元するなら: swap ' + target + ' --force');
  }

  const cur = readCredsOrNull(CREDENTIALS);
  const curSlot = currentSlotOf(cur);

  // 同一かどうかは来歴で見る。名前だけで比べると、`swap save personal` のような別名スロットは
  // 現在のアカウント名と一致しないので「切り替え」として処理が進み、退避で最新化したスロットを
  // その前に読み込んだ古い内容で上書きし直してしまう(現在のログインが古い状態に退化する)。
  if (curSlot === target) {
    console.log('すでに ' + target + ' でログインしています。何もしません');
    return;
  }

  // 来歴がまだ無いときは、復元先が「同じアカウントの古い退避」なのか「別アカウント」なのかを
  // 見分けられない。前者だと切り替えたつもりで古い認証情報へ退化し、トークンがローテート済みなら
  // 認証が通らなくなる。同じプランなら黙って進まず、判断を人に返す。中身が現在と一致していれば
  // 復元しても何も変わらないので、その場合は素通しでよい。
  if (!readCurrentSlot() && cur && !force) {
    const type = subscriptionTypeOf(cur.json);
    const mine = refreshTokenOf(cur.json);
    const identical = mine && mine === refreshTokenOf(next.json);
    if (type && type === subscriptionTypeOf(next.json) && !identical) {
      fail(target + ' は現在と同じプラン(' + type + ')ですが、来歴が記録されていないため'
        + '同一アカウントか判別できません'
        + '\n  同じアカウントだった場合、復元すると古い認証情報に戻り、認証が通らなくなることがあります'
        + '\n  現在のログインはそのままです。別のアカウントだと分かっているなら:'
        + '\n    swap ' + target + ' --force');
    }
  }

  // 現在を退避してから差し替える。この退避が唯一のバックアップなので、失敗したら進まない
  if (cur) {
    if (!curSlot) {
      fail('現在のアカウントの退避名を決められません(subscriptionType が読めず、来歴も記録されていません)'
        + '\n  `swap save <name>` で名前を明示して退避してください。以後その名前が来歴として'
        + '記録され、この切り替えは通るようになります');
    }
    guardOverwrite(curSlot, cur, force);
    writeSlot(cur, curSlot);
    console.log('退避: ' + curSlot);
  } else if (fs.existsSync(CREDENTIALS)) {
    // 「未ログイン(ファイルが無い)」と「読めない(破損・権限・書き込み中)」を区別する。
    // 後者で進むと、退避できていない生きた credentials を上書きして復旧不能にする。
    // Claude Code がトークンを更新している最中にも起こりうるので、黙って進んではいけない。
    if (!force) {
      fail('現在の credentials を読めません(破損しているか、他のプロセスが書き込み中)。'
        + '退避できないため中止しました'
        + '\n  時間をおいて再実行してください。中身を確認したうえで、そのまま退避して切り替えるなら:'
        + '\n    swap ' + target + ' --force');
    }
    // --force: 読めない中身でも raw のまま残してから進む。捨てるより手掛かりを残す
    const name = readCurrentSlot() || 'broken';
    writeSlot({ raw: fs.readFileSync(CREDENTIALS, 'utf8') }, name);
    console.log('退避(復元に使える形ではありません): ' + name);
  } else {
    console.log('現在ログインしていないため、退避はしません');
  }

  writeAtomic(CREDENTIALS, next.raw);
  writeCurrentSlot(target);
  console.log('切り替え: ' + (curSlot || 'なし') + ' -> ' + target + expiryNote(next.json));
  console.log('注意: この変更はマシン全体に即座に効きます。稼働中の別セッションも切り替わります');
}

function usage() {
  console.log(`Claude のログインアカウントを切り替える

  swap                 現在のアカウントと退避済み一覧を表示
  swap <name>          現在を退避してから <name> を復元
  swap <name> --force  復元先が失効済み・判別不能でも中止せずに切り替える
                       現在の credentials が読めない場合も、そのまま退避して進む
  swap save [<name>]   現在のアカウントを退避するだけ(切り替えない)
                       名前を省略すると来歴(前回のスロット名)か subscriptionType を使う
  swap save <name> --force
                       別の認証情報が入っているスロットでも上書きする

退避先: ${ACCOUNTS_DIR}
現在のログインがどのスロット由来かは ${CURRENT_FILE} に記録します。
この記録があるので、同一プランのアカウントを 2 つ持っていても取り違えません。

タイマーやフックから自動実行しないこと。認証の入れ替えはマシン全体に即座に効き、
稼働中の別セッションを巻き込みます(docs/account-separation.md §1.3 / §6.1)。`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) return cmdStatus();
  const [cmd, ...rest] = args;
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') return usage();
  const force = rest.includes('--force');
  const extra = rest.filter(a => a !== '--force');
  // 余分な引数は typo の兆候なので黙って捨てない(save は名前を 1 つだけ取る)
  if (cmd === 'save') {
    if (extra.length > 1) fail('引数が多すぎます: ' + args.join(' '));
    return cmdSave(extra[0], force);
  }
  if (extra.length > 0) fail('引数が多すぎます: ' + args.join(' '));
  return cmdSwap(cmd, force);
}

try {
  main();
} catch (e) {
  fail(e.message);
}
