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
//   2. subscriptionType の不一致 … 「別アカウント」の証明(強い)。
//      一致は何も証明しない。ここを「同じアカウント」と読んだのが以前の誤りで、
//      同一プランの別アカウントを取り違えて相手の唯一のバックアップを消していた
//   3. .current(来歴) … 「前回このツールが書いた先」の記録(弱い)。外から /login されたり、
//      書き込みが途中で落ちたりすると古くなるので、単独では上書きの根拠にしない
// どれでも決着しない組み合わせ(同一プランの別アカウント同士)は原理的に残る。そこは
// 判断で守らず構造で守る: 既存の退避を上書きするときは、1 の証明が無い限り旧内容を
// accounts/.replaced/ へ退けてから書く。--force も、壊れた credentials の経路も例外なく
// この順を通るので、「唯一のバックアップが消える」は起こらない(復旧はファイルの改名で済む)。
//
// このツールで最も高い代償を払う失敗は、退避されていない資格情報を失うこと(ブラウザ
// OAuth のやり直しになる)。判断に迷う場面では、切り替えを諦めて現状を保つ方に倒す。
// ただし「止まるだけで抜け出せない」状態も作らない。中止するときは必ず、実際に効く
// 次の一手を添える(できるだけ、何も壊さずに済む手を先に示す)。

const fs = require('fs');
const path = require('path');
// credentials の場所と読み方は account-guard.js と共有する(credentials.js のコメント参照)。
const { HOME, CREDENTIALS, readCredentials, subscriptionTypeOf } = require('./credentials');

// 退避先を ~/.claude 配下に置くのは、元の credentials と同じ ACL を継承させるため。
// 平文トークンの本数は増えるが、保護レベルは変わらない(§6.1 の「残るリスク」)。
const ACCOUNTS_DIR = path.join(HOME, '.claude', 'accounts');
// 現在のログインの来歴。スロットではないので、一覧が拾う `*.json` に当たらない名前にする。
const CURRENT_FILE = path.join(ACCOUNTS_DIR, '.current');
// 上書きで失われるはずだった旧内容の置き場。ここに控えがあるので、取り違えて上書きしても
// 復旧はファイルを戻すだけで済む。同じ理由で、スロット一覧には出さない(復元先ではない)。
const REPLACED_DIR = path.join(ACCOUNTS_DIR, '.replaced');
// 控えは平文トークンなので無制限には残さない。失効した分は自動で消し、残りは新しい方から
// この本数だけ保つ。1 本だと「間違えた上書きを 2 回続けた」ときに元が消えるので 2 本。
const REPLACED_KEEP = 2;
// 読めない credentials の控えに使う名前。スロット名と同じ空間に置くと、退避として
// 復元候補に見えてしまう(中身は復元に使えない)。
const UNREADABLE_BASE = 'unreadable-current';

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
    // 未ログイン・破損・権限・将来の構造変更。呼び出し側で「現在なし」として扱う
    return null;
  }
}

// 読めない理由を案内に反映するために、もう一度だけ読んで err.code を見る。ここを
// 「破損しているか書き込み中」と決め打ちすると、権限で読めない環境の人に
// 「時間をおいて再実行」という永久に効かない対処を繰り返させることになる。
// 返り値の retryable は「待てば直りうるか」で、案内の文面を分ける。
function unreadableReason(file) {
  try {
    fs.readFileSync(file, 'utf8');
    return { label: '破損しているか、他のプロセスが書き込み中', retryable: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { label: 'ファイルがありません', retryable: false };
    return { label: '読み取りに失敗しました(' + e.code + ')。権限を確認してください', retryable: false };
  }
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

// 「別アカウント」の証明。プラン種別が両方読めて食い違うなら、同じアカウントではありえない
// (プランは変更できるが、変更後の credentials は改めて退避されるので取り違えは起きない)。
// 逆に一致は何も証明しないので、同一判定には決して使わない。
function provablyDifferent(a, b) {
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

// --- 退けた旧内容(.replaced) ---

function replacedEntries(base) {
  if (!fs.existsSync(REPLACED_DIR)) return [];
  const re = new RegExp('^' + base + '-(\\d+)\\.json$'); // base は NAME_RE 済みなので正規表現として安全
  return fs.readdirSync(REPLACED_DIR)
    .map(f => ({ f, m: re.exec(f) }))
    .filter(x => x.m)
    .map(x => ({ file: path.join(REPLACED_DIR, x.f), n: Number(x.m[1]) }))
    .sort((a, b) => a.n - b.n);
}

// 消すのは「もう復旧に使えない」と分かるものから。失効済みを先に落とし、それでも
// 上限を超える分だけ古い順に落とす。読めない控えは中身を判断できないので本数でのみ扱う。
function pruneReplaced(base) {
  let list = replacedEntries(base);
  for (const e of list) {
    const c = readCredsOrNull(e.file);
    if (c && isExpired(c.json)) {
      try { fs.unlinkSync(e.file); e.gone = true; } catch {}
    }
  }
  list = list.filter(e => !e.gone);
  for (const e of list.slice(0, Math.max(0, list.length - REPLACED_KEEP))) {
    try { fs.unlinkSync(e.file); } catch {}
  }
}

// 上書きで失われる内容の控えを取る。移動ではなく複製なのは、控えを作る途中で落ちても
// 元のファイルが手つかずで残るようにするため。控えが取れなければ上書きへは進まない
// (切り替えられないのは後から取り返せるが、消えた資格情報は取り返せない)。
function keepAside(file, base) {
  fs.mkdirSync(REPLACED_DIR, { recursive: true });
  const list = replacedEntries(base);
  const n = list.length ? list[list.length - 1].n + 1 : 1;
  const dest = path.join(REPLACED_DIR, base + '-' + n + '.json');
  fs.copyFileSync(file, dest);
  try { fs.chmodSync(dest, 0o600); } catch {}
  pruneReplaced(base);
  return dest;
}

function replacedCount() {
  if (!fs.existsSync(REPLACED_DIR)) return 0;
  return fs.readdirSync(REPLACED_DIR).filter(f => f.endsWith('.json')).length;
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

// 現在のログインをどのスロットへ退避するか。来歴を第一の手掛かりにし、まだ記録が無いときだけ
// subscriptionType 由来の名前で代用する。どちらも「そのスロットを上書きしてよい」ことまでは
// 保証しないので、書く直前に saveInto が改めて裏を取る。
function currentSlotOf(cur) {
  return readCurrentSlot() || (cur && cur.json ? accountNameOf(cur.json) : null);
}

// 同じ内容だと証明できた他スロットを探す。`swap save personal` のように 1 つのアカウントを
// 2 つの名前で退避すると、更新されない方が古いまま取り残され、後で復元したときに
// ローテート済みのトークンへ黙って巻き戻る。証明は refreshToken の一致に限る。
function slotsHolding(token, exclude) {
  return savedAccounts().filter(n => n !== exclude).filter(n => {
    const c = readCredsOrNull(accountFile(n));
    return c && refreshTokenOf(c.json) === token;
  });
}

function failOverwrite(name, old, provenance, different) {
  const theirs = old ? subscriptionTypeOf(old.json) : null;
  fail('退避先 ' + name + ' には別のアカウントが入っています'
    + (theirs ? '(' + theirs + ')' : '(中身を読めないため確認できません)')
    + (different && provenance
      ? '\n  来歴は ' + name + ' を指していますが、プラン種別が現在のログインと違うので'
        + '別のアカウントです(このツールを通さずに /login しましたか?)'
      : '')
    + '\n  上書きすると、そのアカウントのバックアップが最新でなくなります。'
    + '現在のログインはそのままです'
    + '\n  何も壊さずに退避するなら(既存のスロットには触りません):'
    + '\n    swap save <別名>'
    + '\n  同じアカウントだと分かっていて上書きするなら(旧内容は .replaced に控えを残します):'
    + '\n    swap save ' + name + ' --force');
}

// 退避の実体。読み込み済みの cur をそのまま書くのは、CREDENTIALS を二度読むと
// 「比較したバイト列」と「退避するバイト列」がずれるため(その隙に Claude Code が
// トークンを更新すると、退避したつもりの中身が別物になる)。
// 戻り値は、ついでに更新した別名スロットの一覧。
function saveInto(cur, name, force) {
  const file = accountFile(name);
  const exists = fs.existsSync(file);
  const old = exists ? readCredsOrNull(file) : null;
  const oldToken = old ? refreshTokenOf(old.json) : null;
  const identical = !!(old && sameCreds(cur.json, old.json));
  // 来歴が一致しても素通しにはしない。/login や書き込みの中断で来歴は古くなりうるので、
  // 「別アカウントだと証明できる」場合は来歴より証明を優先して止める。
  const provenance = readCurrentSlot() === name;
  const different = old ? provablyDifferent(cur.json, old.json) : false;

  if (exists && !identical) {
    if (!force && (!provenance || different)) failOverwrite(name, old, provenance, different);
    keepAside(file, name);
  }

  // 別名スロットを揃えるのは「同じアカウントの新しい世代で置き換える」と言えるときだけ。
  // --force で別アカウントを押し込んだ場合まで揃えると、押し出された側の他の退避まで
  // 巻き添えで書き換えてしまう(そちらのバックアップを増やすどころか全部消すことになる)。
  const sameAccount = exists && !identical && !different && provenance;
  const aliases = sameAccount && oldToken ? slotsHolding(oldToken, name) : [];
  writeAtomic(file, cur.raw);
  for (const a of aliases) writeAtomic(accountFile(a), cur.raw);
  writeCurrentSlot(name);
  return aliases;
}

// 現在ログイン中の認証情報を accounts/ に退避する。
// 戻り値は { name, aliases } / 読めない場合は { degraded:true, kept } / 未ログインなら null。
// forceCmd は「読めないまま先へ進む」ための実際に効くコマンド(呼び出し元で文面が変わる)。
function saveCurrent(explicitName, force, forceCmd) {
  const cur = readCredsOrNull(CREDENTIALS);

  if (!cur) {
    if (!fs.existsSync(CREDENTIALS)) return null; // 単に未ログイン
    // 「読めない」で止めるだけだと、この状態から抜け出す手段が無くなる(swap も save も
    // 同じ判定で止まるため)。中身を確認した人が先へ進めるよう --force を用意する。
    const why = unreadableReason(CREDENTIALS);
    if (!force) {
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
  const aliases = saveInto(cur, name, force);
  return { name, aliases };
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

  console.log('現在のアカウント: ' + label + (curSlot ? '  [' + curSlot + ' から復元]' : ''));
  if (exists) console.log('  ' + CREDENTIALS + (cur ? expiryNote(cur.json) : ''));

  const saved = savedAccounts();
  console.log('\n退避済み (' + ACCOUNTS_DIR + '):');
  if (saved.length === 0) {
    console.log('  なし。`swap save` で現在のアカウントを退避してください');
  } else {
    for (const name of saved) {
      const c = readCredsOrNull(accountFile(name));
      // 印は来歴が指すスロットにだけ付ける。プラン種別で合わせると、同一プランの別アカウントに
      // まで印が付き、「これが現在のバックアップだ」と誤解したまま上書きさせてしまう。
      console.log((name === curSlot ? '* ' : '  ') + name.padEnd(8)
        + (c ? expiryNote(c.json) : '  [読めません]'));
    }
  }
  const replaced = replacedCount();
  if (replaced > 0) {
    console.log('\n上書きで退けた旧内容: ' + replaced + ' 件 (' + REPLACED_DIR + ')');
    console.log('  取り違えて上書きしたときは、ここから accounts/<name>.json へ戻せます');
  }
  if (!curSlot && cur && saved.length > 0) {
    console.log('\n来歴が未記録です。`swap save <name>` で退避すると、以後どのスロット由来かを記録します');
  }
}

function cmdSave(name, force) {
  if (name && !NAME_RE.test(name)) fail('アカウント名に使えない文字が含まれています: ' + name);
  const saved = saveCurrent(name, force, 'swap save ' + (name || '<name>') + ' --force');
  if (!saved) fail('現在 credentials がありません(未ログイン)');
  if (saved.degraded) {
    console.log('現在の credentials は復元に使える形ではないため、退避しませんでした');
    console.log('  中身の控え: ' + saved.kept);
    return;
  }
  console.log('退避しました: ' + saved.name + ' -> ' + accountFile(saved.name));
  if (saved.aliases.length) {
    console.log('  同じ内容だった ' + saved.aliases.join(', ') + ' も更新しました(古いまま残さないため)');
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

  // 中身が同じなら復元しても認証は何も変わらないので、credentials には触らず来歴だけ合わせる。
  // 「credentials は書けたが .current の書き込みで落ちた」中断状態も、再実行がここに来て
  // 自動的に直る(来歴が古いまま退避へ進むと、別アカウントのスロットを上書きしかねない)。
  if (cur && sameCreds(cur.json, next.json)) {
    if (readCurrentSlot() !== target) writeCurrentSlot(target);
    console.log('すでに ' + target + ' と同じ内容でログインしています。認証は変更しませんでした');
    return;
  }

  const provenance = readCurrentSlot();
  if (provenance === target) {
    // 来歴が一致していて中身が違う = 退避したあとにトークンがローテートした状態。
    // 復元すると現在のログインが古い世代に退化するだけなので、切り替えない。
    console.log('すでに ' + target + ' でログインしています。何もしません');
    console.log('  現在のログインは ' + target + ' の退避より新しい可能性があります。'
      + '退避を最新にするなら: swap save');
    return;
  }

  // 退避先が復元元と同じファイルになる場合は、名前を分けてもらう。--force で押し切っても
  // 「復元元を上書きしてから、その上書きした内容を復元する」か「来歴が実体と食い違う」かの
  // どちらかにしかならない。別名で退避すれば何も壊さずに切り替えられるので、その手順を出す。
  // 次のプラン一致の判定より先に置くのは、そちらの案内(--force)がこの状況では効かないため。
  if (cur && currentSlotOf(cur) === target) {
    fail('現在のログインの退避先が復元元(' + target + ')と同じ名前になります'
      + '\n  ' + target + ' には別のアカウントが入っているため、このままでは復元元を上書きします'
      + '\n  先に別名で退避してください(既存のスロットには触りません):'
      + '\n    swap save <別名>'
      + '\n  そのあと `swap ' + target + '` で切り替えられます');
  }

  // 来歴がまだ無いときは、復元先が「同じアカウントの古い退避」なのか「別アカウント」なのかを
  // 見分けられない。前者だと切り替えたつもりで古い認証情報へ退化し、トークンがローテート済みなら
  // 認証が通らなくなる。同じプランなら黙って進まず、判断を人に返す。
  if (!provenance && cur && !force) {
    const type = subscriptionTypeOf(cur.json);
    if (type && type === subscriptionTypeOf(next.json)) {
      fail(target + ' は現在と同じプラン(' + type + ')ですが、来歴が記録されていないため'
        + '同一アカウントか判別できません'
        + '\n  同じアカウントだった場合、復元すると古い認証情報に戻り、認証が通らなくなることがあります'
        + '\n  現在のログインはそのままです。別のアカウントだと分かっているなら:'
        + '\n    swap ' + target + ' --force');
    }
  }

  // 現在を退避してから差し替える。この退避が唯一のバックアップなので、失敗したら進まない
  const saved = saveCurrent(null, force, 'swap ' + target + ' --force');
  if (!saved) {
    console.log('現在ログインしていないため、退避はしません');
  } else if (saved.degraded) {
    console.log('現在の credentials は復元に使える形ではないため、退避しませんでした');
    console.log('  中身の控え: ' + saved.kept);
  } else {
    console.log('退避: ' + saved.name
      + (saved.aliases.length ? '(同じ内容だった ' + saved.aliases.join(', ') + ' も更新)' : ''));
  }

  writeAtomic(CREDENTIALS, next.raw);
  writeCurrentSlot(target);
  console.log('切り替え: ' + ((saved && saved.name) || 'なし') + ' -> ' + target + expiryNote(next.json));
  console.log('注意: この変更はマシン全体に即座に効きます。稼働中の別セッションも切り替わります');
}

function usage() {
  console.log(`Claude のログインアカウントを切り替える

  swap                 現在のアカウントと退避済み一覧を表示
  swap <name>          現在を退避してから <name> を復元
  swap <name> --force  復元先が失効済み・判別不能でも中止せずに切り替える
                       現在の credentials が読めない場合も、控えを残して進む
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
