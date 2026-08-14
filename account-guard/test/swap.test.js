'use strict';
// swap の回帰テスト。
//
// このツールで最も危険な壊れ方は「切り替えたつもりが、どのアカウントにもログインできない」
// 状態を作ることで、しかも credentials は 1 本しか無いので取り返しがつかない。したがって
// 「切り替えられること」よりも「危ないときに現在のログインを温存して中止すること」を重く見る。
// 退避を伴わない上書き・失効済みの復元・壊れたファイルでの上書き・他アカウントのバックアップの
// 上書きが、その代表例。
//
// もう一つの軸は「止まったまま抜け出せない状態を作らないこと」。安全側に倒した結果、
// 案内どおりに操作しても永久に切り替えられなくなるなら、それは安全ではなく行き止まりなので、
// 中止のたびに「次の一手が実際に効くか」まで確かめる。
//
// 偽 HOME を作って USERPROFILE を差し替えるので、実際の ~/.claude は読み書きしない。
// トークンもすべてダミー値で、本物には一切触れない。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeHarness } = require('./harness');

const BASE = path.join(__dirname, '.tmp', 'swap');
const SWAP = path.join(__dirname, '..', 'swap.js');
fs.rmSync(BASE, { recursive: true, force: true });

const DAY = 86400000;
// state カウンタと check()・最後の集計は account-guard.test.js と共通なので harness.js に
// 切り出してある(詳しい経緯はそちらのコメント参照)。
const { check, report } = makeHarness();

// accessToken を退避スロットごとに変えられるようにしてあるのは、「更新されたか」「古いままか」を
// 中身で見分けるため。名前だけを見ていると、指摘のあった「別名スロットが取り残される」種類の
// 壊れ方が検出できない。subscriptionType に null を渡すと「プラン種別が読めない credentials」を
// 再現できる(将来の構造変更や、手で編集された退避ファイルを想定した経路の検証に使う)。
// noRefresh は refreshToken を持たない中身(手で編集された退避、将来の構造変更)。readCreds は
// accessToken しか見ないので、この形でも「読める」ものとして通ってしまう経路の検証に使う。
function creds(subscriptionType, { token, expiresInDays = 30, noRefresh = false } = {}) {
  const t = token || 'tok-' + (subscriptionType || 'none');
  const oauth = {
    accessToken: t,
    refreshTokenExpiresAt: Date.now() + expiresInDays * DAY,
  };
  if (!noRefresh) oauth.refreshToken = 'refresh-' + t;
  if (subscriptionType) oauth.subscriptionType = subscriptionType;
  return { claudeAiOauth: oauth };
}

const credPath = (home) => path.join(home, '.claude', '.credentials.json');
const acctPath = (home, name) => path.join(home, '.claude', 'accounts', name + '.json');
const slotPath = (home) => path.join(home, '.claude', 'accounts', '.current');
// 上書きで退けた旧内容の控え。ここに残っている限り、取り違えた上書きは改名で復旧できる
const replacedDir = (home) => path.join(home, '.claude', 'accounts', '.replaced');
const replacedFiles = (home, base) => (fs.existsSync(replacedDir(home))
  ? fs.readdirSync(replacedDir(home)).filter((f) => !base || f.startsWith(base + '-')) : []);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const typeOf = (p) => readJson(p).claudeAiOauth.subscriptionType;
// 無い場合に例外で落とさないのは、控えが消えている系の失敗で残りのテストまで止めないため
// (この種の壊れ方は「1 件だけ落ちる」よりも「どこまで壊れているか」を知りたい)
const tokenOf = (p) => (fs.existsSync(p) ? readJson(p).claudeAiOauth.accessToken : null);
const slotOf = (home) => (fs.existsSync(slotPath(home))
  ? fs.readFileSync(slotPath(home), 'utf8').trim() : null);
// 本数制限の刈り込み(pruneReplaced)が控え(.replaced 配下)以外に手を出していないかを見るため、
// accounts/ 直下のスロット本体(*.json)だけを数える(.replaced はサブディレクトリなので
// endsWith('.json') のフィルタに引っかからず、自然に除外される)。
const slotCount = (home) => fs.readdirSync(path.join(home, '.claude', 'accounts'))
  .filter((f) => f.endsWith('.json')).length;

// current / accounts に文字列を渡すと壊れたファイルを再現できる(JSON にならない中身を置く)。
// slot は来歴(.current)。省略すると「まだ記録が無い」= 使い始めた直後の状態になる。
function sandbox(name, { current, accounts = {}, slot } = {}) {
  const home = path.join(BASE, name);
  fs.mkdirSync(path.join(home, '.claude', 'accounts'), { recursive: true });
  if (current !== undefined) {
    fs.writeFileSync(credPath(home), typeof current === 'string' ? current : JSON.stringify(current), 'utf8');
  }
  for (const [n, v] of Object.entries(accounts)) {
    fs.writeFileSync(acctPath(home, n), typeof v === 'string' ? v : JSON.stringify(v), 'utf8');
  }
  if (slot !== undefined) fs.writeFileSync(slotPath(home), slot + '\n', 'utf8');
  return home;
}

// 子プロセスの起動を 1 箇所に集約する。以前は runSwap のほかに、credentials.js を
// 意図的に置かない配置や os.homedir() まで壊れた環境を再現する箇所ごとに同じ組み立てが
// 複写されていた(account-guard.test.js は execGuardScript() / homeEnv() に一本化済みなので
// 同じ形に揃える)。swap は非ゼロ終了でも中止の理由を確かめたいので、例外から
// stdout / stderr を拾って返す(hook である account-guard 側とはここが異なる)。
function execSwapScript(script, argv = [], { cwd, env } = {}) {
  const opts = { encoding: 'utf8' };
  if (cwd !== undefined) opts.cwd = cwd;
  opts.env = env || { ...process.env, NO_COLOR: '1' };
  try {
    const out = execFileSync(process.execPath, [script, ...argv], opts);
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: e.stdout || '', err: e.stderr || '' };
  }
}

// USERPROFILE/HOME を home に差し替えた環境変数の組み立て。ほとんどの呼び出しがこの形を
// 必要とするのでここに寄せる(account-guard.test.js の homeEnv() と同じ形)。
function homeEnv(home) {
  return { ...process.env, USERPROFILE: home, HOME: home, NO_COLOR: '1' };
}

function runSwap(home, argv = []) {
  return execSwapScript(SWAP, argv, { env: homeEnv(home) });
}

// 中止の不変条件を確かめるため、home 配下の .claude ツリーを丸ごと比較できる形にする。
// D/F の接頭辞でディレクトリの有無も分かるようにし、内容込みで 1 本の文字列にする
// (中止したなら丸ごと一致するはずなので、前後の突き合わせで足りる)。
function snapshotTree(home) {
  const root = path.join(home, '.claude');
  const out = [];
  (function walk(dir, rel) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const relPath = rel ? rel + '/' + ent.name : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { out.push('D ' + relPath); walk(full, relPath); }
      else out.push('F ' + relPath + ': ' + fs.readFileSync(full, 'utf8'));
    }
  })(root, '');
  return out.join('\n');
}

// 中止したときに必ず成り立つべき 3 つ(非ゼロ終了・何も書き換えない・次の一手がある)を
// まとめて確かめる。個別の check() に分けるのは、どれが破れたかを label だけで判別できるように
// するため。「次の一手」の判定は「`swap ` を含む行が 1 行以上ある、または `/login` を含む」で
// 足りるとする(行き止まりにしないことが目的で、案内の文面そのものを厳密に問わない)。
// 空白付きの `swap ` で見るのは、コマンドではない単なる言及(「swap のサブコマンドと同じ」等)を
// 次の一手と数えないため。引数なしの swap を案内するときだけは後ろに引数が来ないので、
// 「swap を実行すると」のように空白を挟んだ地の文で書くこと(バッククォートで囲んだだけでは弾かれる)。
function checkAbort(label, home, before, r) {
  check(label + ': 中止しても成功終了しない', r.code !== 0, `code=${r.code}\n` + r.out + r.err);
  const after = snapshotTree(home);
  check(label + ': 中止しても何も書き換えない', after === before,
    `-- before --\n${before}\n-- after --\n${after}`);
  const hasNextStep = (r.out + r.err).split('\n').some((l) => l.includes('swap '))
    || (r.out + r.err).includes('/login');
  check(label + ': 中止しても次の一手を示す', hasNextStep, r.out + r.err);
}

console.log('swap');

// --- 現在のログインを失わないこと(最優先) ---
{
  // 現在の credentials が読めないのに上書きすると、退避されていない生きたトークンが消える。
  // Claude Code がトークン更新でファイルを書いている最中にも起こりうる状況。
  const home = sandbox('broken-current', {
    current: '{ broken',
    accounts: { team: creds('team') },
  });
  const r = runSwap(home, ['team']);
  check('現在の credentials が読めないときは切り替えを中止する', r.code === 1, r.out + r.err);
  check('中止したとき現在の credentials は書き換えない',
    fs.readFileSync(credPath(home), 'utf8') === '{ broken', fs.readFileSync(credPath(home), 'utf8'));
}
{
  // 「読めない」で中止するだけでは行き止まりになる(save も同じ判定で止まるため)。
  // 中身を確認した人が --force で先へ進めること、そのとき生の中身が捨てられないことを見る。
  // 読めない中身をスロットに入れてはいけない。復元に使えないうえ、そこに有効な退避が
  // 入っていれば唯一のバックアップを壊れたバイト列で潰すことになる(控えとしてだけ残す)。
  const home = sandbox('broken-current-force', {
    current: '{ broken',
    accounts: { team: creds('team'), pro: creds('pro', { token: 'pro-live' }) },
    slot: 'pro',
  });
  const r = runSwap(home, ['team', '--force']);
  check('--force なら読めない credentials でも切り替えられる', r.code === 0, r.out + r.err);
  check('読めない中身は捨てずに控えを残す',
    replacedFiles(home, '.unreadable-current').length === 1
    && fs.readFileSync(path.join(replacedDir(home), '.unreadable-current-1.json'), 'utf8') === '{ broken',
    replacedFiles(home).join(','));
  // --force の意図は「読めない現在を諦めて進む」であって「有効な退避を捨てる」ことではない
  check('--force でも来歴が指す有効な退避を壊れた中身で潰さない',
    tokenOf(acctPath(home, 'pro')) === 'pro-live', fs.readFileSync(acctPath(home, 'pro'), 'utf8'));
  check('--force の切り替え後は team になる', typeOf(credPath(home)) === 'team');
}
{
  // 「読めない」と違い、ファイルが無いのは単に未ログイン。退避するものが無いだけなので進めてよい
  const home = sandbox('no-current', { accounts: { team: creds('team') } });
  const r = runSwap(home, ['team']);
  check('未ログイン(ファイルが無い)なら退避せず切り替える', r.code === 0, r.out + r.err);
  check('未ログインからの切り替え後は team になる', typeOf(credPath(home)) === 'team');
}
{
  // 来歴が復元先を指したまま credentials を失った状態。比較する現在が無いので「すでに復元済み」
  // とは言えない。来歴だけを見て止めると、退避を持っているのに復元できない行き止まりになる。
  const home = sandbox('no-current-same-slot', {
    accounts: { team: creds('team') },
    slot: 'team',
  });
  const r = runSwap(home, ['team']);
  check('来歴が指す先でも、未ログインなら復元する', r.code === 0, r.out + r.err);
  check('未ログインからの復元で credentials が戻る', typeOf(credPath(home)) === 'team');
}
{
  const SECRET = 'sk-ant-oat01-DUMMYSECRET';
  const home = sandbox('broken-target', {
    current: creds('pro'),
    accounts: { team: SECRET + ' is not json' },
  });
  const r = runSwap(home, ['team']);
  check('復元先が壊れていたら切り替えを中止する', r.code === 1, r.out + r.err);
  check('壊れた復元先で現在のログインを潰さない', typeOf(credPath(home)) === 'pro');
  // JSON.parse の例外文はファイル先頭を引用するため、そのまま出すとトークンが端末やログに残る
  check('中止の理由にトークンの断片を含めない', !(r.out + r.err).includes('sk-ant'), r.out + r.err);
}

// --- 失効済みの復元先 ---
{
  const home = sandbox('expired-target', {
    current: creds('pro'),
    accounts: { team: creds('team', { expiresInDays: -1 }) },
  });
  const r = runSwap(home, ['team']);
  check('失効済みの復元先には切り替えない(切り替えてから気づいても遅い)', r.code === 1, r.out + r.err);
  check('失効で中止したとき現在のログインはそのまま', typeOf(credPath(home)) === 'pro');
}
{
  const home = sandbox('expired-force', {
    current: creds('pro'),
    accounts: { team: creds('team', { expiresInDays: -1 }) },
  });
  const r = runSwap(home, ['team', '--force']);
  check('--force なら失効済みでも切り替える', r.code === 0, r.out + r.err);
  check('--force の切り替え後は team になる', typeOf(credPath(home)) === 'team');
}

// --- 来歴(.current)に沿って 1 スロットだけ更新すること ---
{
  // `swap save personal` のような別名スロットは、名前が subscriptionType と一致しない。
  // 名前だけで退避先を決めると personal が古いまま残り、後で復元して認証が通らなくなる。
  // 来歴があれば、そのスロットが更新対象だと確実に分かる。
  const home = sandbox('slot-swap', {
    current: creds('pro', { token: 'pro-new' }),
    accounts: { personal: creds('pro', { token: 'pro-old' }), team: creds('team') },
    slot: 'personal',
  });
  const r = runSwap(home, ['team']);
  check('切り替えは成功する', r.code === 0, r.out + r.err);
  check('切り替え時、来歴が指すスロットが更新される',
    tokenOf(acctPath(home, 'personal')) === 'pro-new', r.out + r.err);
  check('来歴と関係ないスロットは作らない', !fs.existsSync(acctPath(home, 'pro')),
    fs.readdirSync(path.join(home, '.claude', 'accounts')).join(','));
  check('切り替え後の来歴は復元先を指す', slotOf(home) === 'team', slotOf(home));
}
{
  const home = sandbox('slot-save', {
    current: creds('pro', { token: 'pro-new' }),
    accounts: { personal: creds('pro', { token: 'pro-old' }) },
    slot: 'personal',
  });
  const r = runSwap(home, ['save']);
  check('save は成功する', r.code === 0, r.out + r.err);
  check('save でも来歴が指すスロットを更新する',
    tokenOf(acctPath(home, 'personal')) === 'pro-new', r.out + r.err);
}
{
  const home = sandbox('slot-same', {
    current: creds('pro', { token: 'pro-new' }),
    accounts: { personal: creds('pro', { token: 'pro-old' }) },
    slot: 'personal',
  });
  const r = runSwap(home, ['personal']);
  // 終了コードは失敗にする。要求された切り替えは起きていないので、成功で返すと
  // `swap team && claude -p ...` のようなラッパーが別アカウントのまま次へ進む。
  check('来歴が指すスロットへの切り替えは認証を変えず、成功として返さない',
    r.code !== 0 && /認証は変更しませんでした/.test(r.out), `code=${r.code}\n` + r.out + r.err);
  check('現在のログインを古いスナップショットに戻さない',
    tokenOf(credPath(home)) === 'pro-new');
  // 中身が違う理由は「ローテートした」だけでなく「外から /login した」もありうる。
  // 前者しか想定せずに終えると、後者の人は退避に戻す手段が無いまま行き止まりになる
  // (以前は --force を付けても同じ文言で止まっていた)。両方の次の一手を出すこと。
  check('退避を最新にする手順を出す', /swap save\n/.test(r.out), r.out);
  check('退避に戻したい人向けの手順も出す',
    /別名/.test(r.out) && /swap personal --force/.test(r.out), r.out);
}

{
  // 1 つのアカウントを 2 つの名前で退避すると(README が `swap save personal` を案内している)、
  // 更新されない方が古いまま取り残される。後でそちらを復元すると、ローテート済みの
  // トークンに黙って巻き戻り、マシン全体が認証エラーになる。かといって揃えて書き換えると、
  // 「旧内容と現在のログインが同じアカウントか」を証明できないまま他人の退避を潰す。
  // 書き換えずに名前を挙げて知らせ、判断は人に返す。
  const home = sandbox('stale-slots', {
    current: creds('pro', { token: 'pro-new' }),
    accounts: {
      pro: creds('pro', { token: 'pro-old' }),
      personal: creds('pro', { token: 'pro-old' }),
      team: creds('team'),
    },
    slot: 'pro',
  });
  const r = runSwap(home, ['save']);
  check('書き換えるのは名前で指定されたスロットだけ',
    tokenOf(acctPath(home, 'pro')) === 'pro-new'
    && tokenOf(acctPath(home, 'personal')) === 'pro-old', r.out + r.err);
  check('取り残されるスロットは名前を挙げて知らせる',
    /内容が違うスロットがあります: personal/.test(r.out), r.out);
  // 「古い」と断定しないこと。現在のログインが同じアカウントの新しい世代なのか、別アカウントへ
  // /login した結果なのかは見分けられず、後者に --force を勧めると唯一の退避を潰す。
  check('更新する手順と、触ってはいけない場合の両方を出す',
    /swap save personal --force/.test(r.out) && /見分けられません/.test(r.out), r.out);
  check('内容が違う無関係のスロットは案内にも出さない', !/team/.test(r.out), r.out);
}
{
  // 指摘の本体。同一プランの別アカウントへ /login してから退避すると、来歴の一致だけで
  // 「同じアカウントの世代交代」と読み、名前を挙げてもいない別名スロットまで上書きしていた。
  // 相手の有効な退避が accounts/ から 1 本残らず消え、復旧は .replaced からの改名が要る
  // (その控えもベースごとに 2 本しか残らない)。巻き添えにしないことを見る。
  const home = sandbox('other-account-not-collateral', {
    current: creds('pro', { token: 'acct-B' }),
    accounts: {
      personal: creds('pro', { token: 'acct-A' }),
      work: creds('pro', { token: 'acct-A' }),
    },
    slot: 'personal',
  });
  const r = runSwap(home, ['save']);
  check('来歴が指すスロット以外は巻き添えにしない',
    r.code === 0 && tokenOf(acctPath(home, 'work')) === 'acct-A', r.out + r.err);
  check('来歴が指すスロットの控えは残る(そちらは改名で戻せる)',
    tokenOf(path.join(replacedDir(home), 'personal-1.json')) === 'acct-A',
    replacedFiles(home).join(','));
  check('巻き添えを避けたぶん、取り残されることは知らせる',
    /内容が違うスロットがあります: work/.test(r.out), r.out);
  // ここは実際に「別アカウントを上書きした」側の経路。案内が work の更新を断定的に勧めると、
  // acct-A の accounts/ 上の最後の 1 本が消える(復旧は .replaced からの改名になる)。
  check('別アカウントの退避かもしれないことを同じ強さで書く',
    /別アカウントの最新の退避/.test(r.out), r.out);
}
{
  // 押し出した旧内容が現在のログインと同じ資格情報なら、それを持つ他スロットは古くない。
  // staleSlots はこの条件がスロット名に依存しないことを使って、ループの外で 1 回だけ見る。
  // 誤って落とすと、同じ内容の別名スロットに「内容が違う」と印を付け、--force での
  // 上書きを勧めることになる(勧めた先で潰れるのは、現に有効なバックアップ)。
  const home = sandbox('stale-slots-same-creds', {
    current: creds('pro', { token: 'A' }),
    accounts: { pro: creds('pro', { token: 'A' }), spare: creds('pro', { token: 'A' }) },
    slot: 'pro',
  });
  const r = runSwap(home, ['save', 'pro']);
  check('同じ内容での退避は成功する', r.code === 0, r.out + r.err);
  check('現在と同じ資格情報を持つスロットは古い扱いにしない',
    !/内容が違うスロットがあります/.test(r.out), r.out + r.err);
}
{
  // 切り替えに伴う退避でも同じ。ここでも揃えて書いていたので、swap 経由でも巻き添えが起きた。
  const home = sandbox('stale-slots-swap', {
    current: creds('pro', { token: 'pro-new' }),
    accounts: {
      pro: creds('pro', { token: 'pro-old' }),
      personal: creds('pro', { token: 'pro-old' }),
      team: creds('team'),
    },
    slot: 'pro',
  });
  const r = runSwap(home, ['team']);
  check('切り替え時の退避でも他スロットは書き換えない',
    r.code === 0 && tokenOf(acctPath(home, 'personal')) === 'pro-old', r.out + r.err);
  check('切り替え時も来歴が指すスロットは更新される', tokenOf(acctPath(home, 'pro')) === 'pro-new');
  check('切り替え時も取り残されるスロットを知らせる',
    /内容が違うスロットがあります: personal/.test(r.out), r.out);
  // 案内は切り替えの「あと」に出す。切り替え前に出していた頃は、そのまま
  // `swap save personal --force` を打つと personal が team の内容で上書きされていた。
  check('更新の前に元のスロットへ戻す手順を出す',
    r.out.indexOf('swap pro\n') > r.out.indexOf('切り替え: ')
    && /先に戻さないと/.test(r.out), r.out);
  check('案内は切り替えの報告より後に出る',
    r.out.indexOf('内容が違うスロットがあります') > r.out.indexOf('切り替え: '), r.out);
}
{
  // 新しい名前へ退避すると、来歴が指していたスロットが古いまま残る。旧実装は「既存スロットを
  // 上書きするとき」しか他スロットを見ておらず(exists=false では同期が走らない)、この場合を
  // 黙って取り残していた。後日そちらを --force で復元すると、ローテート済みの無効なトークンが
  // マシン全体に書き戻り、失効チェックにも掛からないまま認証エラーになる。
  const home = sandbox('stale-provenance-newslot', {
    current: creds('pro', { token: 'tok-new' }),
    accounts: { personal: creds('pro', { token: 'tok-old' }) },
    slot: 'personal',
  });
  const r = runSwap(home, ['save', 'pro']);
  check('新しい名前への退避でも、取り残される来歴スロットを知らせる',
    r.code === 0 && /内容が違うスロットがあります: personal/.test(r.out), r.out + r.err);
  check('知らせるだけで、書き換えはしない', tokenOf(acctPath(home, 'personal')) === 'tok-old');
}
{
  // 同じ形の操作でも、来歴スロットが「別アカウントの新鮮な退避」であることがある。
  // README が案内する初回手順(1 つ目を退避 → 2 つ目のアカウントで /login → 2 つ目を退避)が
  // まさにこれで、以前はその出力が「古いままの退避があります: pro / swap save pro --force で
  // 更新できます」となり、案内どおり打つとアカウント A の唯一のバックアップが消えていた。
  // 2 つの可能性は区別できないので、断定せず両方を出す。
  const home = sandbox('onboarding-second-account', {
    current: creds('pro', { token: 'acct-B' }),
    accounts: { pro: creds('pro', { token: 'acct-A' }) },
    slot: 'pro',
  });
  const r = runSwap(home, ['save', 'personal']);
  check('初回手順の 2 つ目の退避は成功する', r.code === 0, r.out + r.err);
  check('もう一方のアカウントの退避は書き換えない', tokenOf(acctPath(home, 'pro')) === 'acct-A');
  check('「古い」と断定しない', !/古いままの退避/.test(r.out), r.out);
  check('別アカウントの最新の退避かもしれないと書く',
    /別アカウントの最新の退避/.test(r.out) && /見分けられません/.test(r.out), r.out);
}
{
  // 別名スロットが最新なら、そこへの切り替えは認証を何も変えない。復元して書き直すと
  // 「読んだあとにローテートした」場合に古い内容へ退化しうるので、来歴だけ合わせる。
  const home = sandbox('alias-switch', {
    current: creds('pro', { token: 'pro-new' }),
    accounts: { pro: creds('pro', { token: 'pro-new' }), personal: creds('pro', { token: 'pro-new' }) },
    slot: 'pro',
  });
  const r = runSwap(home, ['personal']);
  check('同じ内容のスロットへの切り替えは認証を変えない', r.code === 0 && tokenOf(credPath(home)) === 'pro-new',
    r.out + r.err);
  check('同じ内容でも来歴は復元先に合わせる', slotOf(home) === 'personal', slotOf(home));
}
{
  // credentials を書いたあと .current の書き込みで落ちると(Windows の rename EPERM など)、
  // 来歴だけが前のアカウントを指したまま残る。ユーザーはエラーを見て「切り替わっていない」と
  // 思って再実行するので、そこで来歴を信じて退避すると別アカウントのスロットを上書きする。
  // 中身の一致で中断を検出し、来歴を直すだけで済ませる。
  const home = sandbox('interrupted-swap', {
    current: creds('pro', { token: 'personal-tok' }),
    accounts: { personal: creds('pro', { token: 'personal-tok' }), team: creds('team', { token: 'team-tok' }) },
    slot: 'team',
  });
  const r = runSwap(home, ['personal']);
  check('中断後の再実行は成功する', r.code === 0, r.out + r.err);
  check('中断で来歴が古いまま再実行しても、他アカウントのスロットを上書きしない',
    tokenOf(acctPath(home, 'team')) === 'team-tok', r.out + r.err);
  check('中断後の再実行で来歴が実体に合う', slotOf(home) === 'personal', slotOf(home));
}
{
  // 来歴があっても、プラン種別が食い違えば別アカウントだと証明できる。ここを来歴優先で
  // 素通しすると、README の手順(`/login` で切り替えてから `swap save`)で前のアカウントの
  // 唯一のバックアップが別アカウントの認証情報に置き換わる。
  const home = sandbox('stale-provenance-save', {
    current: creds('team', { token: 'team-after-login' }),
    accounts: { pro: creds('pro', { token: 'pro-backup' }) },
    slot: 'pro',
  });
  const r = runSwap(home, ['save']);
  check('来歴が古くても、別アカウントだと証明できる上書きは中止する', r.code === 1, r.out + r.err);
  check('中止したとき前のアカウントの退避は元のまま',
    tokenOf(acctPath(home, 'pro')) === 'pro-backup');
  check('中止のときは何も壊さない手順を先に案内する', /swap save <別名>/.test(r.err), r.err);
  const saved = runSwap(home, ['save', 'team']);
  check('案内どおり別名で退避すれば通る(行き止まりにしない)', saved.code === 0, saved.out + saved.err);
  check('別名退避のあとも pro の退避は無傷', tokenOf(acctPath(home, 'pro')) === 'pro-backup');
}

// --- 他アカウントのバックアップを上書きしないこと ---
{
  // 同じプランのアカウントを 2 つ持っていると、プラン種別では区別できない。以前は
  // 「同一 subscriptionType = 同一アカウント」と決め打ちして、相手の唯一のバックアップを
  // 黙って上書きしていた。消えると復旧はブラウザ OAuth のやり直ししかない。
  const home = sandbox('overwrite-other', {
    current: creds('pro', { token: 'acct-B' }),
    accounts: { personal: creds('pro', { token: 'acct-A' }) },
  });
  const r = runSwap(home, ['save', 'personal']);
  check('別の認証情報が入ったスロットへの save は中止する', r.code === 1, r.out + r.err);
  check('中止したときスロットの中身は元のまま',
    tokenOf(acctPath(home, 'personal')) === 'acct-A');
}
{
  const home = sandbox('overwrite-force', {
    current: creds('pro', { token: 'acct-B' }),
    accounts: { personal: creds('pro', { token: 'acct-A' }) },
  });
  const r = runSwap(home, ['save', 'personal', '--force']);
  check('--force なら承知のうえで上書きできる', r.code === 0, r.out + r.err);
  check('--force の上書き後は現在の内容になる',
    tokenOf(acctPath(home, 'personal')) === 'acct-B');
  // 取り違えた --force から復旧できるように、上書きされた側の内容を控えとして残す
  check('--force で上書きした旧内容は控えが残る',
    replacedFiles(home, 'personal').length === 1
    && tokenOf(path.join(replacedDir(home), 'personal-1.json')) === 'acct-A',
    replacedFiles(home).join(','));
}
{
  // --force で「別アカウントを押し込む」場合も、押し出された側の他の退避は無傷であること。
  // 書き換えるのは名前で指定されたスロットだけなので、--force でも巻き添えは起きない。
  const home = sandbox('force-no-collateral', {
    current: creds('pro', { token: 'acct-B' }),
    accounts: { personal: creds('pro', { token: 'acct-A' }), work: creds('pro', { token: 'acct-A' }) },
  });
  const r = runSwap(home, ['save', 'personal', '--force']);
  check('--force の上書きは同じ内容の別スロットを巻き添えにしない',
    r.code === 0 && tokenOf(acctPath(home, 'work')) === 'acct-A', r.out + r.err);
}
{
  // 控えを取った直後に刈り込みを走らせていたため、上書きされる旧内容が失効していると
  // その控えが同じ呼び出しの中で消えていた。案内が約束する「旧内容は .replaced に控えを
  // 残します」が破れ、スロット名を打ち間違えただけで復旧手段が無くなる。
  const home = sandbox('keepaside-expired', {
    current: creds('pro', { token: 'live' }),
    accounts: { personal: creds('pro', { token: 'dead', expiresInDays: -1 }) },
  });
  const r = runSwap(home, ['save', 'personal', '--force']);
  check('失効した旧内容でも控えを残す(その場で消さない)',
    replacedFiles(home, 'personal').length === 1, r.out + r.err + replacedFiles(home).join(','));
  check('控えの中身は上書きされた旧内容',
    tokenOf(path.join(replacedDir(home), 'personal-1.json')) === 'dead');
}
{
  // 控えの上限は「消してよいと言えるものが足りている範囲」でしか守らない。以前は超過分を
  // 古い順で機械的に落としていたため、同じスロットへ 3 回続けて退避すると、最初に押し出した
  // アカウントの唯一の生存コピーが消えていた(復旧はブラウザ OAuth のやり直し)。
  // ここでは 3 世代とも他のどこにも残っていないので、上限を超えても 1 本も落とさないこと。
  const home = sandbox('keepaside-limit', {
    current: creds('pro', { token: 'gen1' }),
    accounts: { personal: creds('pro', { token: 'old1' }) },
  });
  // ループ内で毎回 check を出すと件数が膨らむので、全反復の結果を旗に集約して 1 件にまとめる。
  let allOk = true;
  let neverShrank = true; // 本数制限の刈り込みはスロット本体(*.json)を減らしてはいけない
  let count = slotCount(home);
  for (const t of ['gen2', 'gen3', 'gen4']) {
    fs.writeFileSync(credPath(home), JSON.stringify(creds('pro', { token: t })), 'utf8');
    const r = runSwap(home, ['save', 'personal', '--force']);
    if (r.code !== 0) allOk = false;
    const next = slotCount(home);
    if (next < count) neverShrank = false;
    count = next;
  }
  check('反復はすべて成功する(exit code 0)', allOk);
  check('本数制限の刈り込みでスロット本体(*.json)は減らない', neverShrank);
  check('唯一のコピーは上限を超えても落とさない', replacedFiles(home, 'personal').length === 3,
    replacedFiles(home, 'personal').join(','));
  check('最初に押し出した内容が残っている(唯一のコピーだった)',
    tokenOf(path.join(replacedDir(home), 'personal-1.json')) === 'old1',
    replacedFiles(home, 'personal').join(','));
  check('直前に退けた控えも残っている',
    tokenOf(path.join(replacedDir(home), 'personal-3.json')) === 'gen3',
    replacedFiles(home, 'personal').join(','));
}
{
  // 落としてよいと言えるものがあるときは、上限どおりに減らす。失効済み(復元しても /login の
  // やり直しになる)から順に落ち、最後に退けた控えは必ず残る。
  const home = sandbox('keepaside-limit-expired', {
    current: creds('pro', { token: 'gen1' }),
    accounts: { personal: creds('pro', { token: 'dead1', expiresInDays: -1 }) },
  });
  let allOk = true;
  let neverShrank = true;
  let count = slotCount(home);
  for (const t of ['gen2', 'gen3', 'gen4']) {
    fs.writeFileSync(credPath(home), JSON.stringify(creds('pro', { token: t })), 'utf8');
    const r = runSwap(home, ['save', 'personal', '--force']);
    if (r.code !== 0) allOk = false;
    const next = slotCount(home);
    if (next < count) neverShrank = false;
    count = next;
  }
  check('反復はすべて成功する(exit code 0)', allOk);
  check('本数制限の刈り込みでスロット本体(*.json)は減らない', neverShrank);
  check('失効済みの控えは落として上限に戻す', replacedFiles(home, 'personal').length === 2,
    replacedFiles(home, 'personal').join(','));
  check('落ちたのは失効済みの方',
    !fs.existsSync(path.join(replacedDir(home), 'personal-1.json')),
    replacedFiles(home, 'personal').join(','));
  check('直前に退けた控えは残っている',
    tokenOf(path.join(replacedDir(home), 'personal-3.json')) === 'gen3',
    replacedFiles(home, 'personal').join(','));
}
{
  // 同じ資格情報が他のスロットに残っているなら、控えを落としても復旧の手立ては減らない。
  // 「唯一のコピーは残す」を口実に無制限へ倒さないこと(平文トークンの本数は増やしたくない)。
  const home = sandbox('keepaside-limit-duplicate', {
    current: creds('pro', { token: 'gen1' }),
    accounts: { personal: creds('pro', { token: 'dup' }), mirror: creds('pro', { token: 'dup' }) },
  });
  let allOk = true;
  let neverShrank = true;
  let count = slotCount(home);
  for (const t of ['gen2', 'gen3', 'gen4']) {
    fs.writeFileSync(credPath(home), JSON.stringify(creds('pro', { token: t })), 'utf8');
    const r = runSwap(home, ['save', 'personal', '--force']);
    if (r.code !== 0) allOk = false;
    const next = slotCount(home);
    if (next < count) neverShrank = false;
    count = next;
  }
  check('反復はすべて成功する(exit code 0)', allOk);
  check('本数制限の刈り込みでスロット本体(*.json)は減らない', neverShrank);
  check('複製が他にある控えは落としてよい', replacedFiles(home, 'personal').length === 2,
    replacedFiles(home, 'personal').join(','));
  check('落ちたのは mirror に同じものが残っている控え',
    !fs.existsSync(path.join(replacedDir(home), 'personal-1.json'))
    && tokenOf(acctPath(home, 'mirror')) === 'dup',
    replacedFiles(home, 'personal').join(','));
}
{
  // pruneReplaced(データ消失、実機で再現): 同じ refreshToken を持つ控え同士は、他のどこにも
  // 複製が無くても「複製が他にある」の証人になり合える。まとめて判定すると両方とも
  // droppable と出て、同じ回の刈り込みで両方消えてしまう(ツリー上のどこにも残らない)。
  // 1 件消すたびに残りの控えで判定を取り直せば、片方を消した時点でもう片方は証人を失って
  // 残る側に回るはず。
  const home = sandbox('prune-mutual-witness', {
    current: creds('pro', { token: 'incoming' }),
    accounts: { personal: creds('pro', { token: 'old-in-slot' }) },
  });
  fs.mkdirSync(replacedDir(home), { recursive: true });
  fs.writeFileSync(path.join(replacedDir(home), 'personal-1.json'),
    JSON.stringify(creds('pro', { token: 'dup-X' })), 'utf8');
  fs.writeFileSync(path.join(replacedDir(home), 'personal-2.json'),
    JSON.stringify(creds('pro', { token: 'dup-X' })), 'utf8');
  fs.writeFileSync(path.join(replacedDir(home), 'personal-3.json'),
    JSON.stringify(creds('pro', { token: 'unique-Z' })), 'utf8');
  const r = runSwap(home, ['save', 'personal', '--force']);
  check('相互に証人になる控えがあっても実行は成功する', r.code === 0, r.out + r.err);
  const survivorTokens = replacedFiles(home, 'personal')
    .map(f => tokenOf(path.join(replacedDir(home), f)));
  check('複製元(dup-X)がツリー上のどこかに必ず残っている(データ消失なし)',
    survivorTokens.includes('dup-X'), survivorTokens.join(','));
  check('他に複製の無い控え(unique-Z)は落とさない', survivorTokens.includes('unique-Z'),
    survivorTokens.join(','));
}
{
  // pruneReplaced(読み取り失敗の誤同一視): 読み取りに失敗した控えは「復元に使えない中身」だと
  // 決め打ちできない(ウイルス対策やバックアップツールのロック、ACL の一時変更、EBUSY のような
  // 一過性の事象でも同じ null が返る)。唯一のコピーが一過性の読み取り失敗で消えないよう、
  // 「複製があると証明できない」側として上限を超えても残すこと。
  const home = sandbox('prune-unreadable-not-provable', {
    current: creds('pro', { token: 'gen1' }),
    accounts: { personal: creds('pro', { token: 'old1' }) },
  });
  fs.mkdirSync(replacedDir(home), { recursive: true });
  fs.writeFileSync(path.join(replacedDir(home), 'personal-1.json'), 'not valid json', 'utf8');
  let allOk = true;
  for (const t of ['gen2', 'gen3']) {
    fs.writeFileSync(credPath(home), JSON.stringify(creds('pro', { token: t })), 'utf8');
    const r = runSwap(home, ['save', 'personal', '--force']);
    if (r.code !== 0) allOk = false;
  }
  check('読めない控えがあっても反復はすべて成功する', allOk);
  check('読めない控えは複製の有無を証明できないので上限を超えても残す',
    fs.existsSync(path.join(replacedDir(home), 'personal-1.json')),
    replacedFiles(home, 'personal').join(','));
}
{
  // 来歴が一致するスロットは自分のバックアップなので、確認を挟まず更新できないと
  // 通常の `swap save` が毎回 --force を要求することになって使い物にならない。
  const home = sandbox('overwrite-own', {
    current: creds('pro', { token: 'pro-new' }),
    accounts: { personal: creds('pro', { token: 'pro-old' }) },
    slot: 'personal',
  });
  const r = runSwap(home, ['save']);
  check('来歴が一致するスロットは確認なしで更新する', r.code === 0, r.out + r.err);
  check('更新後は現在の内容になる', tokenOf(acctPath(home, 'personal')) === 'pro-new');
}

// --- 来歴がまだ無いとき ---
{
  // 使い始めた直後は来歴が無く、別名スロットが「同じアカウントの古い退避」なのか
  // 「別アカウント」なのか判別できない。前者を復元すると古い認証情報へ退化する。
  const home = sandbox('noslot-same-plan', {
    current: creds('pro', { token: 'pro-new' }),
    accounts: { personal: creds('pro', { token: 'pro-old' }) },
  });
  const r = runSwap(home, ['personal']);
  check('来歴が無く同じプランの復元先には、黙って切り替えない', r.code === 1, r.out + r.err);
  check('中止したとき現在のログインはそのまま', tokenOf(credPath(home)) === 'pro-new');
}
{
  const home = sandbox('noslot-same-plan-force', {
    current: creds('pro', { token: 'pro-new' }),
    accounts: { personal: creds('pro', { token: 'pro-old' }) },
  });
  const r = runSwap(home, ['personal', '--force']);
  check('別アカウントだと分かっていれば --force で切り替えられる', r.code === 0, r.out + r.err);
  check('--force の切り替え後は復元先の内容になる', tokenOf(credPath(home)) === 'pro-old');
}

{
  // 来歴が無く、退避先の名前(プラン種別由来)が復元元と同じになる状況。ここを
  // 「すでに pro でログインしています」で早期に返すと、--force でも切り替えられず、
  // 案内された `swap save pro --force` は復元元(アカウントA)を消してしまう。
  // 何も壊さずに抜けられる手順(別名で退避 → 切り替え)が実際に効くことまで見る。
  const home = sandbox('noslot-name-collision', {
    current: creds('pro', { token: 'acct-B' }),
    accounts: { pro: creds('pro', { token: 'acct-A' }) },
  });
  const first = runSwap(home, ['pro']);
  check('退避先と復元元の名前が衝突するときは中止する', first.code === 1, first.out + first.err);
  const forced = runSwap(home, ['pro', '--force']);
  check('--force でも復元元を上書きして進んだりしない',
    forced.code === 1 && tokenOf(acctPath(home, 'pro')) === 'acct-A', forced.out + forced.err);
  // 中止するときは、案内どおり打てば実際に通る手順を出すこと。同一プランでは復元側の
  // 同一性ガードに当たるので、案内にも --force が含まれていなければ「案内どおり打って
  // また止まる」になる(それは行き止まりを一段先送りしただけ)。
  check('案内に、そのあと実際に効くコマンドが載っている',
    /swap save <別名>/.test(first.err) && /swap pro --force/.test(first.err), first.err);
  const saved = runSwap(home, ['save', 'mine']);
  check('別名での退避は通る', saved.code === 0, saved.out + saved.err);
  const second = runSwap(home, ['pro', '--force']);
  check('別名で退避すれば切り替えられる(行き止まりにしない)', second.code === 0, second.out + second.err);
  check('切り替え後もアカウントA の退避は無傷', tokenOf(acctPath(home, 'pro')) === 'acct-A');
  check('アカウントB は別名スロットに残る', tokenOf(acctPath(home, 'mine')) === 'acct-B');
}

// --- 復元側の --force と退避側の上書きは別の判断 ---
{
  // 復元側の --force(失効済み・判別不能でも進む)で退避側の上書きガードまで外すと、
  // 退避名がプラン種別から決まったときに、無関係のスロットを確認も警告もなく潰す。
  const home = sandbox('force-scope', {
    current: creds('pro', { token: 'acct-B' }),
    accounts: { pro: creds('pro', { token: 'acct-A' }), personal: creds('pro', { token: 'acct-C' }) },
  });
  const r = runSwap(home, ['personal', '--force']);
  check('復元側の --force は他アカウントの退避を上書きしない',
    tokenOf(acctPath(home, 'pro')) === 'acct-A', r.out + r.err);
  // 同一プランなので「別のアカウント」とまでは証明できない。断定せず、確かなこと
  // (現在と違う認証情報が入っている)までにとどめて中止する
  check('上書きが必要になるなら中止して知らせる',
    r.code === 1 && /現在と違う認証情報が入っています/.test(r.err), r.out + r.err);
  check('証明できていないことを断定しない',
    !/別のアカウントが入っています/.test(r.err)
    && /見分けられません/.test(r.err), r.err);
  check('中止したので現在のログインもそのまま', tokenOf(credPath(home)) === 'acct-B');
}

// --- 復元先が「別アカウント」だと証明できないとき ---
{
  // 来歴は現在のログインの出どころしか語らないので、それが第三のスロットを指していても
  // 復元先が何者かは分からない。ここを素通しにすると、同じアカウントの古い退避へ黙って
  // 巻き戻り、ローテート済みのトークンで稼働中の全セッションが認証エラーになる。
  const home = sandbox('rollback-other-slot', {
    current: creds('pro', { token: 'acctA-new' }),
    accounts: {
      team: creds('pro', { token: 'acctA-new' }),
      personal: creds('pro', { token: 'acctA-veryold' }),
    },
    slot: 'team',
  });
  const r = runSwap(home, ['personal']);
  check('来歴が別スロットを指していても、同一性を確認できなければ中止する',
    r.code === 1 && /確認できません/.test(r.err), r.out + r.err);
  check('古い世代へ黙って巻き戻さない', tokenOf(credPath(home)) === 'acctA-new');
  check('中止のときは両方の次の一手を出す',
    /swap personal --force/.test(r.err) && /swap save/.test(r.err), r.err);
  const forced = runSwap(home, ['personal', '--force']);
  check('別アカウントだと分かっていれば --force で通る(行き止まりにしない)',
    forced.code === 0 && tokenOf(credPath(home)) === 'acctA-veryold', forced.out + forced.err);
}

// --- subscriptionType が読めない場合 ---
{
  // 現在の credentials から名前を導けないとき、中止するだけでは行き止まりになる。
  // 案内どおり `swap save <name>` すれば来歴が記録され、以後の切り替えが通ること。
  const home = sandbox('no-type-current', {
    current: creds(null, { token: 'no-type' }),
    accounts: { team: creds('team') },
  });
  const first = runSwap(home, ['team']);
  check('退避名を決められないときは切り替えを中止する', first.code === 1, first.out + first.err);
  const saved = runSwap(home, ['save', 'mine']);
  check('名前を明示すれば退避できる', saved.code === 0, saved.out + saved.err);
  // 現在のプラン種別が読めない以上、復元先が別アカウントである証明も立たない。中止するが、
  // 案内した --force で必ず抜けられること(止まったまま出られないのは安全ではない)。
  const blocked = runSwap(home, ['team']);
  check('プラン種別を比較できないときは復元を中止する',
    blocked.code === 1 && /確認できません/.test(blocked.err), blocked.out + blocked.err);
  const second = runSwap(home, ['team', '--force']);
  check('一度退避すれば --force で切り替えが通る(行き止まりにしない)',
    second.code === 0, second.out + second.err);
  check('退避した中身は元の credentials', tokenOf(acctPath(home, 'mine')) === 'no-type');
  check('切り替え後は team', typeOf(credPath(home)) === 'team');
}
{
  // subscriptionType の無い中身を復元すると、account-guard は誰のログインか判別できず
  // (currentAccount が unknown を返す)、保護ツリーへの操作をすべて拒否し続ける。
  // 切り替えたあとで気づくと、戻す操作まで巻き添えで拒否される。
  const home = sandbox('no-type-target', {
    current: creds('pro'),
    accounts: { odd: creds(null, { token: 'odd' }) },
  });
  const r = runSwap(home, ['odd']);
  check('subscriptionType が無い復元先には切り替えない', r.code === 1, r.out + r.err);
  check('中止したとき現在のログインはそのまま', typeOf(credPath(home)) === 'pro');
}
{
  const home = sandbox('no-type-target-force', {
    current: creds('pro'),
    accounts: { odd: creds(null, { token: 'odd' }) },
  });
  const r = runSwap(home, ['odd', '--force']);
  check('--force なら承知のうえで復元できる', r.code === 0, r.out + r.err);
  check('--force の復元後は odd の内容になる', tokenOf(credPath(home)) === 'odd');
}

// --- プラン種別がそのままでは名前にできない場合 ---
{
  // 将来 subscriptionType が空白を含む値になっても、swap 経由の切り替えが恒久的に
  // 不能になってはいけない(そうなると /login に戻るしかなくなる)
  const home = sandbox('odd-type', {
    current: creds('max 20x'),
    accounts: { team: creds('team') },
  });
  const r = runSwap(home, ['team']);
  check('subscriptionType に空白が混じっても切り替えは止まらない', r.code === 0, r.out + r.err);
  check('ファイル名に使える形へ潰して退避する', fs.existsSync(acctPath(home, 'max-20x')),
    fs.readdirSync(path.join(home, '.claude', 'accounts')).join(','));
}

// --- 通常の経路 ---
{
  const home = sandbox('basic', {
    current: creds('pro'),
    accounts: { team: creds('team') },
  });
  const r = runSwap(home, ['team']);
  check('退避してから切り替える', r.code === 0, r.out + r.err);
  check('切り替え後は team', typeOf(credPath(home)) === 'team');
  check('切り替え前の pro が退避されている', typeOf(acctPath(home, 'pro')) === 'pro');
  // 平文トークン入りの .tmp が残ると、一覧(.json のみ)に出ないまま気づかれずに増える
  check('一時ファイルを残さない',
    !fs.readdirSync(path.join(home, '.claude')).some((f) => f.endsWith('.tmp'))
    && !fs.readdirSync(path.join(home, '.claude', 'accounts')).some((f) => f.endsWith('.tmp')),
    fs.readdirSync(path.join(home, '.claude')).join(','));
}
{
  const home = sandbox('missing-target', { current: creds('pro') });
  const r = runSwap(home, ['team']);
  check('退避されていない名前への切り替えは拒否する', r.code === 1, r.out + r.err);
  check('拒否しても現在のログインはそのまま', typeOf(credPath(home)) === 'pro');
}
{
  const home = sandbox('status', {
    current: creds('pro'),
    accounts: { pro: creds('pro'), personal: creds('pro'), team: creds('team') },
    slot: 'personal',
  });
  const r = runSwap(home, []);
  check('status は現在のアカウントを表示する', /現在のアカウント: pro/.test(r.out), r.out + r.err);
  check('status は来歴が指すスロットに印を付ける', /\* personal/.test(r.out), r.out);
  // プラン種別で印を付けると、同一プランの別アカウントにまで印が付き、
  // 「これが現在のバックアップだ」と誤解したまま上書きさせてしまう
  check('status は同じプランでも来歴以外には印を付けない',
    /\n {2}pro/.test(r.out) && /\n {2}team/.test(r.out), r.out);
}
{
  // 「読めない」を「未ログイン」と読んだ人が /login をやり直すと、退避していない
  // 生きたトークンが上書きされて消える。status は状況確認の唯一の入り口なので重い。
  const home = sandbox('status-broken', { current: '{ broken' });
  const r = runSwap(home, []);
  check('status は読めない credentials を未ログインと言わない',
    /読めません/.test(r.out) && !/未ログイン/.test(r.out), r.out + r.err);
}
{
  // 読めない理由が権限やシステムエラーのとき、原因を伏せて「やり直してください」だけを
  // 出すと、原因に気づけないまま繰り返させることになる。理由は必ず添える。
  // ディレクトリを置いて EISDIR を作り、err.code と原因に応じた対処が案内に出ることを見る。
  const home = sandbox('status-unreadable', {});
  fs.mkdirSync(credPath(home), { recursive: true });
  const r = runSwap(home, []);
  check('status は読めない理由に err.code を添える', /EISDIR/.test(r.out), r.out + r.err);
  check('読めない理由に応じた対処を案内する', /ディレクトリ/.test(r.out), r.out);
}
{
  // 読み取り自体に失敗したとき、待てば直るかどうかはこのツールには分からない。EISDIR
  // (同じ名前のディレクトリが置かれている)を「一過性のロック」と同じに扱って
  // 「時間をおいてやり直してください」だけを出していた頃は、案内どおり打ち続けても
  // 一歩も進まなかった。時間についての推測はやめ、原因に応じた対処と、先へ進む手段が
  // 常に出ることを見る。
  const home = sandbox('swap-unreadable-dir', { accounts: { team: creds('team') } });
  fs.mkdirSync(credPath(home), { recursive: true });
  const r = runSwap(home, ['team']);
  check('読み取り失敗に時間をおいての案内は出さない',
    !/時間をおいて/.test(r.err), r.out + r.err);
  check('読み取りに失敗した理由に応じた対処を添える', /ディレクトリ/.test(r.err), r.out + r.err);
  // レビュー指摘: この check はもともと「--force という文字列が出ること」だけを見ていたが、
  // 開けない現在(copyable:false)では --force は脱出路にならない。keepAside の copyFileSync が
  // 同じ理由で落ち、その失敗が「もう一度実行してください」と案内するため、--force を勧めると
  // 2 コマンドを往復し続ける行き止まりになる(saveCurrent の degraded 分岐参照)。新しい文面にも
  // 「--force」という語自体は残るので、旧 check は意図と正反対の内容のまま緑で通っていた。
  check('開けない現在に --force を脱出路として勧めない',
    !/そのまま先へ進めます/.test(r.err), r.err);
  check('代わりに、開ける状態に戻すべきパスを示す',
    r.err.includes(credPath(home)) && /開ける状態に戻して/.test(r.err), r.err);
}
{
  // 対照: 控えを取れる壊れ方(JSON として壊れているだけ。バイト列は読める = copyable:true)
  // では、これまでどおり --force が「そのまま先へ進めます」の形で脱出路として案内される。
  // これが無いと、「copyable にかかわらず常に --force を出さない」実装でも上のテストは
  // 緑になってしまう。
  const home = sandbox('swap-unreadable-json-copyable', {
    current: '{ broken',
    accounts: { team: creds('team') },
  });
  const r = runSwap(home, ['team']);
  check('控えを取れる壊れ方では --force を脱出路として案内する',
    /そのまま先へ進めます/.test(r.err) && /swap team --force/.test(r.err), r.err);
}
{
  // レビュー指摘1: 開けない現在(EISDIR)では、--force を付けても keepAside の copyFileSync が
  // 同じ理由で落ちるため、「--force を付けてもう一度実行してください」と「もう一度実行しても
  // 同じなら…」を行き来するだけで、どちらのコマンドを打っても先に進めない状態になっていた。
  // 両方を実際に打って、往復が成立しないことを確かめる。打ち直しの案内が出るかを見るのは
  // --force 付きの側だけでよい。その文言は keepAside の失敗にしか無く、--force 無しは
  // saveCurrent の入口で止まってそこへ到達しないため、どんな実装でも出ない(検査を置いても
  // 変異で落ちない = 何も検査していないチェックが増えるだけになる)。往復は片側を止めれば
  // 成立しないので、--force 無しの側は終了コードと副作用だけを見る。
  const home = sandbox('unreadable-dir-no-retry-loop', { accounts: { team: creds('team') } });
  fs.mkdirSync(credPath(home), { recursive: true });
  // --force 側は keepAside が控えの置き場所(accounts/.replaced)を作ってからコピーに失敗する。
  // 空ディレクトリの作成自体は「書き換え」に数えない(keepaside-copy-fails と同じ理由で、
  // ここを差分に含めると mkdirSync 自体が snapshotTree の比較に引っかかってしまう)。
  fs.mkdirSync(replacedDir(home), { recursive: true });
  const before = snapshotTree(home);
  const plain = runSwap(home, ['team']);
  const forced = runSwap(home, ['team', '--force']);
  check('--force 付きは同じコマンドの打ち直しを勧めない',
    !/先ほどと同じ swap コマンドをもう一度実行してください/.test(forced.out + forced.err),
    forced.out + forced.err);
  check('どちらも非ゼロ終了する', plain.code !== 0 && forced.code !== 0,
    `plain=${plain.code} forced=${forced.code}`);
  check('どちらも何も書き換えない', snapshotTree(home) === before,
    `-- before --\n${before}\n-- after --\n${snapshotTree(home)}`);
}
{
  const home = sandbox('status-empty', {});
  const r = runSwap(home, []);
  check('status はファイルが無いときだけ未ログインと言う', /未ログイン/.test(r.out), r.out + r.err);
}
{
  // JSON としては読めるのに accessToken が無い(手で編集した、別バージョンが書いた、
  // 将来の構造変更)。中身は最後まで確認できているので、「書き込み中かもしれない」と
  // 曖昧に濁さず、形式の問題だと言い切る。
  const home = sandbox('status-no-token', {
    current: { claudeAiOauth: { subscriptionType: 'pro' } },
    accounts: { team: creds('team') },
  });
  const s = runSwap(home, []);
  check('status は形式の問題を「書き込み中」と言わない',
    /accessToken/.test(s.out) && !/書き込み中/.test(s.out), s.out + s.err);
  const r = runSwap(home, ['team']);
  check('形式の問題に時間をおいての案内は出さない', !/時間をおいて/.test(r.err), r.out + r.err);
  check('先へ進む手段は案内する', /--force/.test(r.err), r.err);
}
{
  // 「上書きで退けた旧内容」と「読めなかった credentials の控え」を同じ件数に混ぜると、
  // 案内どおり accounts/<name>.json へ戻した人が、復元に使えない中身を有効なスロットに書く。
  const home = sandbox('status-replaced-kinds', {
    current: '{ broken',
    accounts: { team: creds('team') },
  });
  runSwap(home, ['team', '--force']); // 読めない現在の控えだけができる
  const r = runSwap(home, []);
  check('読めない控えを「上書きで退けた旧内容」に数えない',
    !/上書きで退けた旧内容/.test(r.out), r.out + r.err);
  check('読めない控えは別項目で出す', /復元に使えない控え: 1 件/.test(r.out), r.out);
  check('復元に使えないことを伝える', /復元できません/.test(r.out), r.out);
}
{
  // 壊れたスロットを上書きすると、その旧内容は UNREADABLE_BASE ではなくスロット名で
  // .replaced に入る。名前だけで分類していた頃は「戻せる旧内容」に数えられ、案内どおり
  // accounts/<name>.json へ戻した人が、直前に取った正しい退避を自分で潰していた。
  const home = sandbox('status-replaced-broken-slot', {
    current: creds('pro'),
    accounts: { team: '{ broken' },
  });
  runSwap(home, ['save', 'team', '--force']); // 壊れた旧内容が team-1.json として退けられる
  const r = runSwap(home, []);
  check('壊れていた旧内容を「戻せる旧内容」に数えない',
    !/上書きで退けた旧内容/.test(r.out), r.out + r.err);
  check('壊れていた旧内容は復元に使えない側で数える',
    /復元に使えない控え: 1 件/.test(r.out), r.out + r.err);
}
{
  // replacedCounts(swap.js:421 付近)の分類はファイル名ではなく中身が読めるかどうかで決まる。
  // UNREADABLE_BASE の名前を持つファイルでも、中身が有効な credentials なら「復元に使えない」
  // には数えない。この控えが未退避アカウントの唯一のバックアップであることがあり、
  // 「復元に使えません、消して構いません」と案内すると refreshToken を失わせる。
  const home = sandbox('replaced-counts-by-content', { current: creds('pro') });
  fs.mkdirSync(replacedDir(home), { recursive: true });
  fs.writeFileSync(path.join(replacedDir(home), '.unreadable-current-1.json'),
    JSON.stringify(creds('pro', { token: 'still-live' })), 'utf8');
  const r = runSwap(home, []);
  check('中身が読める控えは UNREADABLE_BASE の名前でも「復元に使えない」に数えない',
    !/復元に使えない控え/.test(r.out), r.out + r.err);
  check('中身が読める控えは「上書きで退けた旧内容」に数える',
    /上書きで退けた旧内容: 1 件/.test(r.out), r.out + r.err);
}
{
  // 修正2: accessToken が無くても refreshToken が残っている控え(hasRecoverableToken)は、
  // 「復元に使えない・消して構いません」の unusable 側に混ぜてはいけない。refreshToken は
  // 交換すればまた使えるので、そう案内すると救えたはずの資格情報を消させることになる。
  const home = sandbox('replaced-counts-stale-token', { current: creds('pro') });
  fs.mkdirSync(replacedDir(home), { recursive: true });
  fs.writeFileSync(path.join(replacedDir(home), '.unreadable-current-1.json'), JSON.stringify({
    claudeAiOauth: {
      subscriptionType: 'pro',
      refreshToken: 'refresh-still-good',
      refreshTokenExpiresAt: Date.now() + 30 * DAY,
    },
  }), 'utf8');
  const r = runSwap(home, []);
  check('refreshToken だけの控えは「復元に使えない控え」に数えない',
    !/^復元に使えない控え/m.test(r.out), r.out + r.err);
  check('refreshToken だけの控えは別項目で件数を出す',
    /トークンが残っている控え: 1 件/.test(r.out), r.out + r.err);
  check('消さないでほしいことを明示する', /消さないでください/.test(r.out), r.out + r.err);
}
{
  // 上のテストは JSON として読める(accessToken だけ欠ける)場合の hasRecoverableToken 経路を
  // 見ている。replacedCounts() には JSON.parse そのものが失敗する別経路(swap.js:682-693)があり、
  // 書き込みの途中で切り詰められた控えはこちらを通る。JSON としては壊れているが、切れた位置
  // より手前に refreshToken の文字列は残っている。ここを一律 unreadable に数えていた頃は、
  // cmdStatus が「原因を調べ終えたら消して構いません」と案内し、案内どおり消すと未退避
  // アカウントの唯一のコピーを失っていた。
  const home = sandbox('replaced-counts-truncated-token', { current: creds('pro') });
  fs.mkdirSync(replacedDir(home), { recursive: true });
  fs.writeFileSync(path.join(replacedDir(home), '.unreadable-current-1.json'),
    '{"claudeAiOauth":{"accessToken":"AT-A","refreshToken":"RT-ONLY-COPY"', 'utf8');
  const r = runSwap(home, []);
  check('JSON 構文エラーで読めなくても refreshToken が残る控えは「復元に使えない控え」に数えない',
    !/^復元に使えない控え/m.test(r.out), r.out + r.err);
  check('「上書きで退けた旧内容」にも数えない(JSON としては読めていない)',
    !/上書きで退けた旧内容/.test(r.out), r.out + r.err);
  check('トークンが残っている控えとして別項目で件数を出す',
    /トークンが残っている控え: 1 件/.test(r.out), r.out + r.err);
  check('消さないでほしいことを明示する', /消さないでください/.test(r.out), r.out + r.err);
  // この件数には accessToken だけが残った控えも入る(すぐ下のテストが確かめている形)ので、
  // 集計の文面では refreshToken と名指ししない。ここで残っているのが実際に refreshToken でも、
  // 件数表示は両方を束ねたものである以上、名指しは他方について嘘になる。
  check('集計の文面では refreshToken と名指ししない',
    !/refreshToken が残っている控え/.test(r.out), r.out + r.err);
}
{
  const home = sandbox('bad-name', { current: creds('pro') });
  const r = runSwap(home, ['../evil']);
  check('パス区切りを含む名前は拒否する(ファイル名になるため)', r.code === 1, r.out + r.err);
}
{
  // 読めない credentials の控えの名前がスロット名と同じ空間にあると、`swap save
  // unreadable-current` で作った有効な退避の控えが「復元には使えません、消して構いません」と
  // 案内される。さらに控えの本数制限を共有するので、有効な控えの方が先に消される。
  const home = sandbox('unreadable-name-collision', {
    current: creds('pro', { token: 'live-2' }),
    accounts: { 'unreadable-current': creds('pro', { token: 'live-1' }) },
  });
  const r = runSwap(home, ['save', 'unreadable-current', '--force']);
  check('スロット名と同じ名前でも退避の控えは作れる',
    r.code === 0 && tokenOf(path.join(replacedDir(home), 'unreadable-current-1.json')) === 'live-1',
    r.out + r.err + replacedFiles(home).join(','));
  const s = runSwap(home, []);
  check('有効な退避の控えを「読めなかった credentials の控え」に数えない',
    /上書きで退けた旧内容: 1 件/.test(s.out) && !/読めなかった credentials の控え/.test(s.out), s.out);
}
{
  // 「別アカウントだと確認できません」で中止したとき、案内した --force が退避の段で
  // もう一度止まってはいけない(案内どおり打って止まるのは、案内していないのと同じ)。
  // subscriptionType が読めず来歴も無いと退避名を決められないので、名前を明示する手順を出す。
  const home = sandbox('unproven-needs-name', {
    current: creds(null, { token: 'cur-tok' }),
    accounts: { team: creds('team', { token: 'team-tok' }) },
  });
  const r = runSwap(home, ['team']);
  check('退避名を決められないときは名前を明示する手順を出す',
    r.code === 1 && /swap save <name>/.test(r.err), r.out + r.err);
  const saved = runSwap(home, ['save', 'mine']);
  check('案内どおり名前を付ければ退避できる', saved.code === 0, saved.out + saved.err);
  const forced = runSwap(home, ['team', '--force']);
  check('そのあとの --force が実際に通る(行き止まりにしない)',
    forced.code === 0 && tokenOf(credPath(home)) === 'team-tok', forced.out + forced.err);
}
{
  // refreshToken が無い中身は readCreds を通ってしまう(accessToken しか見ない)。復元すると
  // 認証を更新できず、数時間後にマシン全体が認証エラーになる。失効済みと同じ重さで止める。
  const home = sandbox('no-refresh-token', {
    current: creds('pro', { token: 'live' }),
    accounts: { team: creds('team', { token: 'no-refresh', noRefresh: true }) },
    slot: 'pro',
  });
  const r = runSwap(home, ['team']);
  check('refreshToken が無い退避先への切り替えは中止する',
    r.code === 1 && /refreshToken/.test(r.err), r.out + r.err);
  check('中止したので現在のログインはそのまま', tokenOf(credPath(home)) === 'live');
  const s = runSwap(home, []);
  check('status も一覧で警告する', /refreshToken がありません/.test(s.out), s.out);
  const forced = runSwap(home, ['team', '--force']);
  check('承知のうえなら --force で復元できる(行き止まりにしない)',
    forced.code === 0 && tokenOf(credPath(home)) === 'no-refresh', forced.out + forced.err);
}
{
  // 未ログインなのに「[pro から復元]」と併記すると、pro に入っていると読めてしまい、
  // /login を省いたまま別の中止に当たる。来歴は別の行で「最後に書いた先」として出す。
  const home = sandbox('status-provenance-no-current', {
    accounts: { pro: creds('pro') },
    slot: 'pro',
  });
  const r = runSwap(home, []);
  check('未ログインのときは来歴を「復元済み」として併記しない',
    /未ログイン/.test(r.out) && !/\[pro から復元\]/.test(r.out), r.out + r.err);
  check('来歴そのものは別の行で伝える',
    /最後に書いたのは pro/.test(r.out) && /一致は確認できません/.test(r.out), r.out);
}
{
  // README は swap.cmd のパスを書き換えて別の場所へ置く手順を案内しており、swap.js だけを
  // 移す配置は現実に起きる。require を素通しにすると main() の try/catch より前に落ちて
  // 生のスタックトレースだけが出る(account-guard.js 側は同じ状況で真因を示す)。
  const dir = path.join(BASE, 'lone-swap');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(SWAP, path.join(dir, 'swap.js')); // credentials.js は意図的に置かない
  const r = execSwapScript(path.join(dir, 'swap.js'), [], { env: homeEnv(dir) });
  check('credentials.js が無いときは真因と置き場所を示して止まる',
    r.code === 1 && /credentials\.js/.test(r.err) && /同じディレクトリ/.test(r.err), r.out + r.err);
  check('スタックトレースを投げっぱなしにしない', !/ {4}at /.test(r.err), r.err);
}
{
  // 隣に credentials.js は「ある」が、無関係・古いファイルで HOME 等を export していない
  // (`{}` を export する等)。require 自体は成功するので、素通しで分割代入すると
  // path.join(HOME, ...) がトップレベルで TypeError を投げ、案内より前に生のスタックトレースだけが
  // 出ていた(account-guard.js 側は同種の検証を既に持つ)。
  const dir = path.join(BASE, 'malformed-credentials-swap');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(SWAP, path.join(dir, 'swap.js'));
  fs.writeFileSync(path.join(dir, 'credentials.js'), 'module.exports = {};', 'utf8');
  const r = execSwapScript(path.join(dir, 'swap.js'), [], { env: homeEnv(dir) });
  check('credentials.js の形式が不正なときは真因を示して止まる',
    r.code === 1 && /形式が想定と違います/.test(r.err), r.out + r.err);
  check('スタックトレースを投げっぱなしにしない', !/ {4}at /.test(r.err), r.err);
}
{
  // 同一プラン同士の切り替え(max ⇄ max)。この向きは planDiffers が「別アカウントだ」と
  // 証明できないので --force でしか通れない。にもかかわらず切り替え成功時の「元に戻すには」は
  // 素の名前だけを出していたため、案内どおり打つと必ず「別のアカウントだと確認できません」で
  // 中止していた。案内するコマンドは、その先のガードをそのまま通れなければ意味がない。
  const home = sandbox('return-cmd-force', {
    current: creds('max', { token: 'personal-live' }),
    accounts: { personal: creds('max', { token: 'personal-live' }), work: creds('max', { token: 'work-live' }) },
    slot: 'personal',
  });
  const r = runSwap(home, ['work', '--force']);
  check('同一プランでも --force なら切り替わる(前提)', r.code === 0, r.out + r.err);
  check('「元に戻すには」に --force が付く', /元に戻すには: swap personal --force/.test(r.out), r.out);

  // 案内どおりに打って実際に戻れることまで見る。文字列だけ合わせても、その先で別の理由に
  // 当たれば行き止まりは残る。
  const back = runSwap(home, ['personal', '--force']);
  check('案内どおり打つと実際に元へ戻れる', back.code === 0, back.out + back.err);
  check('戻った内容は元のアカウントのもの', tokenOf(credPath(home)) === 'personal-live', tokenOf(credPath(home)));

  // 対照: プラン種別が食い違う向き(pro → team)では復元側のガードに当たらないので --force を
  // 足さない。要らない --force を常に添えると旗の意味が摩耗し、本当に危ない場面でも素通りする。
  const home2 = sandbox('return-cmd-plain', {
    current: creds('pro', { token: 'pro-live' }),
    accounts: { pro: creds('pro', { token: 'pro-live' }), team: creds('team', { token: 'team-live' }) },
    slot: 'pro',
  });
  const r2 = runSwap(home2, ['team']);
  check('プランが違えば --force なしで切り替わる(対照の前提)', r2.code === 0, r2.out + r2.err);
  check('プランが違うときは「元に戻すには」に --force を足さない',
    /元に戻すには: swap pro$/m.test(r2.out), r2.out);
}
{
  // HOME をどこからも導出できない環境。credentials.js が '.' 等へ逃げると、退避先が cwd 配下に
  // 解決されて「退避が 1 つも無い」ように見える(実際の退避は本物の HOME に残っているのに、
  // 消えたと誤解して /login し直すと現在のアカウントまで失う)。空文字だけでなく空白のみも
  // 見るのは、後者が truthy で usableHome の trim() が無いと素通りするため。
  const dir = path.join(BASE, 'nohome-swap');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(SWAP, path.join(dir, 'swap.js'));
  fs.copyFileSync(path.join(__dirname, '..', 'credentials.js'), path.join(dir, 'credentials.js'));
  // os.homedir() まで壊れた環境は環境変数だけでは作れないので、ラッパー経由で差し替える
  // (account-guard.test.js の同種テストと同じ手口。理由はそちらのコメントに書いた)。
  for (const [label, value] of [['空文字', ''], ['空白のみ', '   ']]) {
    const runner = path.join(dir, 'run-' + (value === '' ? 'empty' : 'blank') + '.js');
    fs.writeFileSync(runner, [
      "'use strict';",
      `require('os').homedir = () => ${JSON.stringify(value)};`,
      "require('./swap.js');",
    ].join('\n'), 'utf8');
    const r = execSwapScript(runner, [], {
      cwd: dir,
      env: { ...process.env, USERPROFILE: value, HOME: value, NO_COLOR: '1' },
    });
    // 要点は「退避なし」と表示して成功終了しないこと。cwd 配下へ逃げた状態と見分けるため、
    // 終了コードと真因(HOME)の両方を見る。
    check(`HOME が全滅(${label})なら成功終了しない`, r.code !== 0, `code=${r.code} ` + r.out + r.err);
    check(`HOME が全滅(${label})なら退避を空と偽らず真因を出す`,
      /HOME/.test(r.out + r.err) && !/退避されていません/.test(r.out), r.out + r.err);
    check(`HOME が全滅(${label})でもスタックトレースを投げっぱなしにしない`,
      !/ {4}at /.test(r.err), r.err);
    // credentials.js は隣にある(require 自体は成功する)ので、「隣に置き忘れた」診断に
    // 落ちてはいけない。落ちると、既に隣にある正しいファイルをコピーし直せという効かない
    // 案内を繰り返させてしまう(account-guard.js の homeUnresolvedMessage() と同じ理由)。
    check(`HOME が全滅(${label})でも置き場所の誤診断をしない`,
      !/credentials\.js を読み込めません/.test(r.err), r.err);
    check(`HOME が全滅(${label})なら環境変数を直すよう案内する`,
      /USERPROFILE または HOME に実在するホームディレクトリを設定/.test(r.out + r.err), r.out + r.err);
  }
}

// --- プラン種別は「別アカウント」を証明しない ---
{
  // プランを上げると(Pro → Max)、昇格前に退避したスロットとは subscriptionType が食い違う。
  // 以前はこれを「別アカウントだから復元してよい」と読んでいたので、同じアカウントの
  // ローテート済みの古いトークンが --force なしでマシン全体に書き戻り、稼働中の全セッションが
  // 認証エラーになっていた(account-guard も昇格前のプランと誤認識して拒否を始める)。
  // ここで止めると日常の切り替えが常に --force を要求して旗の意味が摩耗するので、進む代わりに
  // 戻し方を必ず出す。直前に退避しているので、戻す手は必ず残っている。
  // 昇格後に `swap save max` と名前を明示して退避した状態(来歴は max を指す)。ここから
  // 昇格前の退避 pro を復元しようとすると、来歴の一致でも退避先の同名でもないので、
  // 最後に残るのはプラン種別の比較だけになる。
  const home = sandbox('plan-change-not-proof', {
    current: creds('max', { token: 'acct-A-new' }),
    accounts: {
      pro: creds('pro', { token: 'acct-A-old' }),
      max: creds('max', { token: 'acct-A-new' }),
    },
    slot: 'max',
  });
  const r = runSwap(home, ['pro']);
  check('プラン種別が違えば切り替えは進む', r.code === 0 && tokenOf(credPath(home)) === 'acct-A-old',
    r.out + r.err);
  check('切り替え前の内容は退避されている', tokenOf(acctPath(home, 'max')) === 'acct-A-new',
    r.out + r.err);
  check('プラン変更前の退避だった場合に備えて戻し方を出す',
    /元に戻すには: swap max/.test(r.out), r.out);
}

// --- 復元先の健全性チェックより、同一内容の短絡を先に見る ---
{
  // 現在のログインが b と同じ内容なのに来歴が a を指している(中断か手作業)。この状態で
  // `swap b` は認証を何も変えないので、b が失効していようと関係がない。以前は失効チェックが
  // 先に走って中止し、来歴の自己修復まで飛ばしていた。来歴が a のまま残ると、次の
  // `swap save` が a を狙い、そこにあるアカウントの退避を上書きしてしまう。
  const home = sandbox('selfheal-before-expiry', {
    current: creds('pro', { token: 'b-tok', expiresInDays: -1 }),
    accounts: {
      a: creds('pro', { token: 'a-tok' }),
      b: creds('pro', { token: 'b-tok', expiresInDays: -1 }),
    },
    slot: 'a',
  });
  const r = runSwap(home, ['b']);
  check('同じ内容なら復元先が失効していても中止しない',
    r.code === 0 && /認証は変更しませんでした/.test(r.out), r.out + r.err);
  check('来歴が直る(次の save が別スロットを狙わない)', slotOf(home) === 'b', slotOf(home));
  check('認証には触らない', tokenOf(credPath(home)) === 'b-tok');
}

// --- 陳腐化の信号を一過性の警告だけにしない ---
{
  // 退避のあとトークンが更新されても、失効期限は元のままなので一覧は「残り N 日」と健全に見える。
  // 退避したときの警告を見逃すと二度と気づけないので、status にも印を残す。ただし理由は
  // 「更新された」と「ツールを通さずに /login した」の 2 つあり、扱いは正反対なので断定しない。
  const home = sandbox('status-outdated-mark', {
    current: creds('pro', { token: 'new' }),
    accounts: {
      pro: creds('pro', { token: 'old' }),
      mirror: creds('pro', { token: 'old' }),
      team: creds('team'),
    },
    slot: 'pro',
  });
  const r = runSwap(home, []);
  check('来歴が指すスロットの内容が現在と違えば印を付ける',
    /pro\s+\[残り \d+ 日\]\s+\[現在のログインと内容が違います\]/.test(r.out), r.out + r.err);
  check('同じ資格情報を持つ別名スロットにも印を付ける(一致は証明)',
    /mirror\s+\[残り \d+ 日\]\s+\[現在のログインと内容が違います\]/.test(r.out), r.out);
  check('無関係のスロットには付けない',
    r.out.split('\n').some(l => /^\s+team\s+\[残り \d+ 日\]$/.test(l)), r.out);
  check('2 つの可能性を並べて、断定はしない',
    /トークンが更新された/.test(r.out) && /\/login した/.test(r.out), r.out);
}
{
  // 修正A(撤回): 一時期「.replaced の控えの refreshToken と一致するスロットも stale とみなす」
  // 照合を足したことがあるが、誤検知を生むため撤回した。.replaced が語れるのは「かつて押し出された
  // 内容がこれだ」という履歴だけで、「いまそのスロットが古いか」ではない。取り違えて上書きした
  // ときの復旧手順(.replaced から accounts/<name>.json へ戻す)を実行した直後のスロットは、
  // 中身が控えと完全に一致する。つまり「押し出された古いもの」と「復旧されたばかりの正しいもの」
  // が区別できず、後者にまで「swap save <name> --force」を添えた更新案内を出すと、
  // 復旧したばかりの唯一の正しい退避を現在のログインで上書きして失いうる。
  const home = sandbox('outdated-replaced-no-false-positive', {
    current: creds('pro', { token: 'old' }),
    accounts: {
      pro: creds('pro', { token: 'old' }),
      mirror: creds('pro', { token: 'old' }),
    },
    slot: 'pro',
  });
  // pro を新しいトークンへ更新する。押し出された old は .replaced/pro-*.json へ控えられるが、
  // mirror はそれと同じ旧トークンを持ったままでも stale 扱いにはしない(来歴は pro しか
  // 指しておらず、mirror が古いのか別アカウントの新鮮な退避なのかはこのツールには分からない)。
  fs.writeFileSync(credPath(home), JSON.stringify(creds('pro', { token: 'new' })), 'utf8');
  const s = runSwap(home, ['save', 'pro', '--force']);
  check('退避が成功する(前提条件)', s.code === 0, s.out + s.err);
  const r = runSwap(home, []);
  check('来歴のスロットは現在と一致するので印が付かない',
    r.out.split('\n').some(l => /^\*\s*pro\s+\[残り \d+ 日\]$/.test(l)), r.out);
  check('.replaced の控えと一致するだけの別名スロットには印を付けない(誤検知の回帰防止)',
    r.out.split('\n').some(l => /^\s+mirror\s+\[残り \d+ 日\]$/.test(l))
    && !/mirror\s+\[残り \d+ 日\]\s+\[現在のログインと内容が違います\]/.test(r.out), r.out + r.err);
}

// --- サブコマンドと同じ名前のスロットは作らせない ---
{
  // `accounts/save.json` を作れてしまうと、main() は第一引数を必ずサブコマンドとして読むので
  // `swap save` は復元ではなく退避に走り、そのスロットを復元する引数の形が存在しなくなる。
  // 一覧には出るのに戻せない(手でファイルを動かすしかない)行き止まりだった。
  const home = sandbox('reserved-name', {
    current: creds('pro', { token: 'tok' }),
  });
  const r = runSwap(home, ['save', 'save']);
  check('サブコマンドと同じ名前では退避できない',
    r.code === 1 && /サブコマンドと同じ/.test(r.err), r.out + r.err);
  check('中止したのでファイルも作らない', !fs.existsSync(acctPath(home, 'save')), r.err);
  check('復元できなくなることを理由として書く', /復元する手段がなくなります/.test(r.err), r.err);
}
{
  // warmup はまだ実装していないが docs/account-separation.md §6.3 で仕様確定済み。
  // 実装を待ってから予約すると、それまでに作られたスロットが実装した瞬間に復元不能になる
  // (`swap warmup` がサブコマンドとして解釈され、復元する引数の形が消える)。
  const home = sandbox('reserved-name-warmup', {
    current: creds('pro', { token: 'tok' }),
  });
  const r = runSwap(home, ['save', 'warmup']);
  check('未実装でも仕様確定済みのサブコマンド名は退避に使わせない',
    r.code === 1 && /サブコマンドと同じ/.test(r.err), r.out + r.err);
  check('warmup で中止したのでファイルも作らない', !fs.existsSync(acctPath(home, 'warmup')), r.err);
}
{
  // 予約語チェックより前に作られたスロットは、放置すると復元できないまま一覧に居座り、
  // 「退避してあるから大丈夫」と誤解させる。改名すれば使えるので、status で名指しする。
  const home = sandbox('reserved-name-existing', {
    current: creds('pro', { token: 'tok' }),
    accounts: { save: creds('pro', { token: 'stuck' }), pro: creds('pro', { token: 'tok' }) },
  });
  const r = runSwap(home, []);
  check('復元できない名前の退避は status が名指しする',
    /復元できない名前の退避があります: save/.test(r.out), r.out + r.err);
  check('改名という実際に効く対処を出す', /改名してください/.test(r.out), r.out);
}
{
  // RESERVED_ONLY_NAMES(warmup)は DISPATCHED_NAMES と違い main() がまだ横取りしていないので、
  // 今のところ `swap warmup` で普通に復元できる。この違いを同じ「復元できません」で扱うと、
  // 復元できるバックアップに対して不要な改名や、より危険な /login のやり直しへ誘導する
  // (swap.js の RESERVED_ONLY_NAMES 周辺コメント参照)。validateName は warmup を新規スロット名
  // として弾くので、accounts/warmup.json は sandbox() で直接ファイルとして置く(save 経由では作れない)。
  const home = sandbox('reserved-only-name-warmup', {
    current: creds('pro', { token: 'pro-tok' }),
    accounts: { warmup: creds('team', { token: 'warmup-tok' }) },
  });
  const r = runSwap(home, []);
  check('まだ復元できる warmup を「復元できない名前」とは言わない(事実と違う)',
    !/復元できない名前の退避があります/.test(r.out), r.out + r.err);
  check('代わりに「いずれ復元できなくなる」と案内する',
    /いずれ復元できなくなる名前の退避があります: warmup/.test(r.out), r.out);
  check('実装された時点で復元できなくなるといういまのうちの改名を促す',
    /実装された時点で復元できなくなる/.test(r.out) && /いまのうちに改名してください/.test(r.out), r.out);

  // 警告が事実と食い違わないことの裏取り。実際に `swap warmup` を実行すると復元できることを見る
  // (別プランなので --force なしで通る。他のテストの basic 経路と同じ組み合わせ)。
  const restored = runSwap(home, ['warmup']);
  check('実際に `swap warmup` を実行すると復元できる',
    restored.code === 0 && tokenOf(credPath(home)) === 'warmup-tok', restored.out + restored.err);
}
{
  // 予約名スロットの来歴があると、以後どのアカウントへも切り替えられなくなっていたバグの回帰。
  // `swap warmup` で復元すると .current が warmup を指す。その後の `swap <他のスロット>` は
  // 切り替えの前に必ず現在のログインを来歴の名前(= warmup)へ退避するが、validateName が
  // 予約語を実在確認なしで一律に弾いていた頃は、ここで「サブコマンドと同じなので使えません」
  // に当たり中断していた(退避なしでは切り替えも起きない)。既に実在するスロットには予約語
  // チェックを効かせないことで、この行き止まりを塞いだ(validateName 参照)。
  const home = sandbox('reserved-name-warmup-provenance-swap', {
    current: creds('team', { token: 'warmup-cur-tok' }),
    accounts: {
      warmup: creds('team', { token: 'warmup-old-tok' }),
      other: creds('max', { token: 'other-tok' }),
    },
    slot: 'warmup',
  });
  const r = runSwap(home, ['other']);
  check('予約名スロットの来歴があっても他スロットへ切り替えられる(行き止まりの回帰)',
    r.code === 0, r.out + r.err);
  check('credentials は切り替え先の中身になる',
    tokenOf(credPath(home)) === 'other-tok', r.out + r.err);
  check('切り替え前の現在のログインは warmup へ退避される',
    tokenOf(acctPath(home, 'warmup')) === 'warmup-cur-tok', r.out + r.err);
  check('来歴も切り替え先へ進む', slotOf(home) === 'other', r.out + r.err);
}
{
  // 同じ来歴の状態でも `swap save warmup`(既存スロットの明示的な更新)は通ることの確認。
  // 予約語チェックは「新しく作らせない」ためのものなので、既に実在するスロットの更新までは
  // 止めない(上のテストと対になる。予約語が無条件でまだ実在しないときに弾かれることは
  // 「サブコマンドと同じ名前のスロットは作らせない」のテストで確認済み)。
  const home = sandbox('reserved-name-warmup-provenance-save', {
    current: creds('team', { token: 'warmup-new-tok' }),
    accounts: { warmup: creds('team', { token: 'warmup-old-tok' }) },
    slot: 'warmup',
  });
  const r = runSwap(home, ['save', 'warmup']);
  check('予約名でも既存スロットの明示的な更新は通る', r.code === 0, r.out + r.err);
  check('warmup の中身が現在のログインで更新される',
    tokenOf(acctPath(home, 'warmup')) === 'warmup-new-tok', r.out + r.err);
}

// --- レビュー指摘: 復元できない名前を「打てるコマンド」として案内しない ---
{
  // 「退避されていません」の一覧(cmdSwap 冒頭)。accounts/save.json は予約語と衝突していて
  // `swap save` は復元ではなく save サブコマンドとして解釈されるため、案内どおり打つと
  // 切り替わらないまま exit 0 で終わる(restorableByName / renameToRestoreText 参照)。
  // alpha は従来どおり `swap alpha` を案内してよい対照として一緒に置く。
  const home = sandbox('missing-target-reserved-name', {
    accounts: { alpha: creds('pro'), save: creds('pro') },
  });
  const r = runSwap(home, ['nosuchslot']);
  check('復元できない名前は「打てるコマンド」として案内しない',
    r.code === 1 && !/^\s*swap save\s*$/m.test(r.err), r.out + r.err);
  check('代わりに改名を促す案内を出す',
    /swap のサブコマンドと同じ名前なので/.test(r.err) && /別の名前へ改名してください/.test(r.err),
    r.err);
  check('復元できる名前はこれまでどおり案内する',
    /^\s*swap alpha\s*$/m.test(r.err), r.err);
  // 対照: 復元できるスロット(alpha)が 1 つでもあれば、これまでどおり択一を促す見出しのまま
  check('復元できるスロットが 1 つでもあれば択一を促す',
    /いずれか1つを選んでください/.test(r.err), r.err);
}
{
  // 追加修正(1): 復元できるスロットが 1 つも無い(save は予約語衝突、help も同様)ときに、
  // 「いずれか1つを選んでください」と択一を促すと、無い選択肢を探させることになる。
  // 各行には改名や読み取り失敗への対処が書いてあるので、見出しはそちらへ読ませる文面に切り替わる。
  const home = sandbox('missing-target-all-unrestorable', {
    accounts: { save: creds('pro'), help: creds('pro') },
  });
  const r = runSwap(home, ['nosuchslot']);
  check('選べる行が無いときは択一を促さない', !/いずれか1つを選んでください/.test(r.err), r.err);
  check('代わりに「いま復元できるものはありません」と言う',
    /退避はありますが、いま復元できるものはありません/.test(r.err), r.err);
  check('各スロットの改名案内はこれまでどおり出る',
    /^\s*save:/m.test(r.err) && /^\s*help:/m.test(r.err)
    && /swap のサブコマンドと同じ名前なので/.test(r.err) && /別の名前へ改名してください/.test(r.err),
    r.err);
}
{
  // 切り替え後の「元に戻すには」も同じ判定を通す。来歴が save を指したまま切り替えると、
  // saveCurrent は save の中身を(必要なら)更新して saved.name = 'save' を返すが、
  // それをそのまま restoreBackCmd に渡すと「元に戻すには: swap save」になり、
  // 案内どおり打った人は save サブコマンドが走って戻れないまま誤解する。
  const home = sandbox('return-cmd-reserved-name', {
    current: creds('pro', { token: 'live' }),
    accounts: { save: creds('pro', { token: 'live' }), team: creds('team', { token: 'team-tok' }) },
    slot: 'save',
  });
  const r = runSwap(home, ['team']);
  check('切り替えは成功する(前提)', r.code === 0, r.out + r.err);
  check('「元に戻すには」に save サブコマンドを案内しない',
    !r.out.includes('元に戻すには: swap save'), r.out);
  check('代わりに改名を促す案内を出す',
    /元に戻すには: swap のサブコマンドと同じ名前なので/.test(r.out) && /別の名前へ改名してください/.test(r.out),
    r.out);
}
{
  // 追加修正(2): reportOtherSlots(取り残されるスロットの案内)は returnCmd が null
  // (退避名がサブコマンドと衝突していて、戻すコマンドが打てる形で存在しない)のとき、以前は
  // 警告ごと行が消えていた。その下に並ぶ `swap save <n> --force` が書き込むのは現在のログイン
  // = いま復元したアカウントなので、警告が無いとそのまま打ってよく見える(戻さずに打つと
  // mirror の唯一の控えが復元後の内容で潰れる)。来歴が save を指したまま切り替え、かつ
  // 同じ内容を持つ別名スロット(mirror)を用意して reportOtherSlots を発火させる
  // (組み立ては「切り替え時の退避でも他スロットは書き換えない」の stale-slots-swap と同じで、
  // スロット名を save/mirror に差し替えただけ)。
  const home = sandbox('report-other-slots-reserved-name', {
    current: creds('pro', { token: 'pro-new' }),
    accounts: {
      save: creds('pro', { token: 'pro-old' }),
      mirror: creds('pro', { token: 'pro-old' }),
      team: creds('team'),
    },
    slot: 'save',
  });
  const r = runSwap(home, ['team']);
  check('切り替えは成功する(前提)', r.code === 0, r.out + r.err);
  check('取り残されるスロットを知らせる(前提)', /内容が違うスロットがあります: mirror/.test(r.out),
    r.out + r.err);
  check('戻すコマンドが無くても上書きの警告は消さない',
    /先に元へ戻さないと/.test(r.out), r.out);
  // 「復元コマンドとしての swap save」(単独行)と「更新コマンドとしての swap save mirror --force」
  // (末尾に別名と --force が付く)を取り違えないよう、行単位で判定する。
  check('swap save を復元コマンドとしては案内しない',
    !r.out.split('\n').some((l) => /^\s*swap save\s*$/.test(l)), r.out);
  check('swap save <別名> --force という更新コマンドはこれまでどおり出る',
    /^\s*swap save mirror --force\s*$/m.test(r.out), r.out);
}

// --- 中止の不変条件 ---
// swap.js の中止経路それぞれについて、「実行前スナップショットを取る → 中止させる →
// checkAbort」を繰り返す。個々の中止理由の妥当性は上のテストで確認済みなので、ここでは
// 「中止したなら 3 つとも必ず成り立つ」ことだけを機械的に確かめる。
{
  // validateName(99行目): アカウント名に使えない文字は save 経由でも弾く
  const home = sandbox('abort-bad-name-save', { current: creds('pro') });
  const before = snapshotTree(home);
  const r = runSwap(home, ['save', '../evil']);
  checkAbort('不正な文字を含む名前での save', home, before, r);
}
{
  // validateName(101行目): サブコマンドと同じ名前のスロットは作れない
  const home = sandbox('abort-reserved-name', { current: creds('pro') });
  const before = snapshotTree(home);
  const r = runSwap(home, ['save', 'save']);
  checkAbort('予約語をスロット名に使う save', home, before, r);
}
{
  // saveCurrent(500行目): save 経路で現在の credentials が読めないときは --force なしで中止する
  const home = sandbox('abort-unreadable-save', {
    current: '{ broken',
    accounts: { team: creds('team') },
  });
  const before = snapshotTree(home);
  const r = runSwap(home, ['save']);
  checkAbort('現在の credentials が読めない save', home, before, r);
}
{
  // saveCurrent(514行目): subscriptionType も来歴も無いと退避名を決められない
  const home = sandbox('abort-no-name', { current: creds(null, { token: 'no-type' }) });
  const before = snapshotTree(home);
  const r = runSwap(home, ['save']);
  checkAbort('退避名を決められない save', home, before, r);
}
{
  // cmdSave(657行目): 未ログインでの save はエラーで中止する(swap 側は中止しない点と違う)
  const home = sandbox('abort-no-current-save', {});
  const before = snapshotTree(home);
  const r = runSwap(home, ['save']);
  checkAbort('未ログインでの save', home, before, r);
}
{
  // cmdSwap(668行目): 復元先の名前も不正な文字を弾く
  const home = sandbox('abort-bad-name-swap', { current: creds('pro') });
  const before = snapshotTree(home);
  const r = runSwap(home, ['../evil']);
  checkAbort('不正な文字を含む復元先への切り替え', home, before, r);
}
{
  // cmdSwap(672行目): 退避されていない名前への切り替えは拒否する
  const home = sandbox('abort-missing-target', { current: creds('pro') });
  const before = snapshotTree(home);
  const r = runSwap(home, ['team']);
  checkAbort('退避されていない名前への切り替え', home, before, r);
}
{
  // cmdSwap(682行目): 復元先が JSON として読めなければ中止する
  const home = sandbox('abort-broken-target', {
    current: creds('pro'),
    accounts: { team: 'not json' },
  });
  const before = snapshotTree(home);
  const r = runSwap(home, ['team']);
  checkAbort('壊れた復元先への切り替え', home, before, r);
}
{
  // cmdSwap(706行目): 失効済みの復元先には --force なしで切り替えない
  const home = sandbox('abort-expired-target', {
    current: creds('pro'),
    accounts: { team: creds('team', { expiresInDays: -1 }) },
  });
  const before = snapshotTree(home);
  const r = runSwap(home, ['team']);
  checkAbort('失効済みの復元先への切り替え', home, before, r);
}
{
  // cmdSwap(714行目): refreshToken が無い復元先には --force なしで切り替えない
  const home = sandbox('abort-no-refresh', {
    current: creds('pro', { token: 'live' }),
    accounts: { team: creds('team', { token: 'no-refresh', noRefresh: true }) },
    slot: 'pro',
  });
  const before = snapshotTree(home);
  const r = runSwap(home, ['team']);
  checkAbort('refreshToken が無い復元先への切り替え', home, before, r);
}
{
  // cmdSwap(723行目): subscriptionType が無い復元先には --force なしで切り替えない
  const home = sandbox('abort-no-type-target', {
    current: creds('pro'),
    accounts: { odd: creds(null, { token: 'odd' }) },
  });
  const before = snapshotTree(home);
  const r = runSwap(home, ['odd']);
  checkAbort('subscriptionType が無い復元先への切り替え', home, before, r);
}
{
  // cmdSwap(767行目): 退避先が復元元と同じ名前になる場合は中止する
  const home = sandbox('abort-name-collision', {
    current: creds('pro', { token: 'acct-B' }),
    accounts: { pro: creds('pro', { token: 'acct-A' }) },
  });
  const before = snapshotTree(home);
  const r = runSwap(home, ['pro']);
  checkAbort('退避先と復元元の名前が衝突する切り替え', home, before, r);
}
{
  // cmdSwap(799行目): 復元先が別アカウントだと証明できないときは --force なしで中止する
  const home = sandbox('abort-unproven', {
    current: creds('pro', { token: 'pro-new' }),
    accounts: { personal: creds('pro', { token: 'pro-old' }) },
  });
  const before = snapshotTree(home);
  const r = runSwap(home, ['personal']);
  checkAbort('別アカウントだと証明できない切り替え', home, before, r);
}
{
  // failOverwrite(417/419行目): 退避先に別の認証情報が入っているときは save を中止する
  const home = sandbox('abort-overwrite-other', {
    current: creds('pro', { token: 'acct-B' }),
    accounts: { personal: creds('pro', { token: 'acct-A' }) },
  });
  const before = snapshotTree(home);
  const r = runSwap(home, ['save', 'personal']);
  checkAbort('別の認証情報が入ったスロットへの save', home, before, r);
}
{
  // main(880行目): save に名前を 2 つ以上渡すと typo とみなして中止する
  const home = sandbox('abort-too-many-args-save', { current: creds('pro') });
  const before = snapshotTree(home);
  const r = runSwap(home, ['save', 'a', 'b']);
  checkAbort('save への引数過多', home, before, r);
}
{
  // main(883行目): swap <name> に余分な引数が付くと typo とみなして中止する
  const home = sandbox('abort-too-many-args-swap', {
    current: creds('pro'),
    accounts: { team: creds('team') },
  });
  const before = snapshotTree(home);
  const r = runSwap(home, ['team', 'extra']);
  checkAbort('swap への引数過多', home, before, r);
}

// --- レビュー指摘: 行き止まりと誤った成功終了の回帰 ---
{
  // cmdSave(degraded 経路): 退避が起きなかった以上、成功終了で返さない(README:
  // 「切り替え(退避)が起きなかったときは終了コードを成功にしない」)。ここが exit 0 のままだと、
  // `swap save --force && ...` のようなラッパーが「退避できた」ものとして次へ進み、続く /login が
  // 書き込み途中だった正規の credentials を上書きして消す(実測済み)。
  // 控え(手掛かり)は作るのでツリーは変わる。checkAbort の「何も書き換えない」は使えないため
  // 個別に確認する。
  const home = sandbox('save-degraded-nonzero', { current: '{ broken' });
  const r = runSwap(home, ['save', '--force']);
  check('読めない現在を --force で退避しても成功終了しない', r.code !== 0, r.out + r.err);
  check('中身の控えは残す(手掛かりとしての価値)', replacedFiles(home).length === 1,
    r.out + r.err + replacedFiles(home).join(','));
  check('中止しても次の一手を示す(行き止まりにしない)',
    /\/login/.test(r.out + r.err) || /swap /.test(r.out + r.err), r.out + r.err);
}
{
  // cmdSave(degraded 案内): JSON として壊れている(書き込み途中を読んだ状態)は、中身を
  // 最後まで確認できていないので verdict は 'unreadable'。ここを「待てば直る/直らない」で
  // 出し分けていた頃は、直るかどうかの推測に案内を賭けており、永久に直らない状態へ
  // 「時間をおいてやり直してください」を出し続ける無限ループを作っていた。いまは控えを
  // 残したうえで「もう一度実行しても同じなら /login」の一本に寄せる。書き込み途中なら
  // 次の実行で読めて別の案内(いまは読めています)に落ちるので、待てば直るケースは
  // 分岐を増やさずに吸収される。控えが残っている以上、案内どおり /login しても失われない。
  const home = sandbox('save-degraded-unreadable', { current: '{ broken' });
  const r = runSwap(home, ['save', '--force']);
  check('読めない壊れ方では成功終了しない', r.code !== 0, r.out + r.err);
  check('読めない壊れ方でも控えは残す', replacedFiles(home).length === 1,
    r.out + r.err + replacedFiles(home).join(','));
  check('読めない壊れ方では時間をおいての案内は出さない',
    !/時間をおいて/.test(r.out + r.err), r.out + r.err);
  check('読めない壊れ方ではやり直しを先に、その後に /login を案内する',
    /もう一度実行しても同じなら/.test(r.out + r.err) && /`\/login` してから/.test(r.out + r.err),
    r.out + r.err);
}
{
  // 対照: JSON としては妥当だが accessToken も refreshToken も無い(手で編集した・将来の
  // 構造変更を想定)。中身を最後まで確認できたので verdict は 'unusable' になり、
  // 「もう一度実行しても」を挟まずに済む……のではなく、文面は共通のまま /login を案内する。
  // 案内を verdict ごとに書き分けないことが、行き止まりを作らないための肝。
  const home = sandbox('save-degraded-unusable', {
    current: { claudeAiOauth: { subscriptionType: 'pro' } },
  });
  const r = runSwap(home, ['save', '--force']);
  check('使えないと確認できた壊れ方では成功終了しない', r.code !== 0, r.out + r.err);
  check('使えないと確認できた壊れ方では /login を勧める',
    /`\/login` してから/.test(r.out + r.err), r.out + r.err);
  check('使えないと確認できた壊れ方でも時間をおいての案内は出さない',
    !/時間をおいて/.test(r.out + r.err), r.out + r.err);
}
{
  // 修正3: accessToken が無くても refreshToken が残っている(stale)場合は、unusable と
  // 同じ「/login してから」を案内してはいけない。refreshToken は交換すればまた使えるので、
  // /login で上書きさせると救えたはずの資格情報を失わせる(account-guard.js の 'stale' 分岐と
  // 同じ判断)。
  const home = sandbox('save-degraded-stale-refresh-token', {
    current: {
      claudeAiOauth: {
        subscriptionType: 'pro',
        refreshToken: 'refresh-stale',
        refreshTokenExpiresAt: Date.now() + 30 * DAY,
      },
    },
  });
  const r = runSwap(home, ['save', '--force']);
  check('refreshToken が残る壊れ方では成功終了しない', r.code !== 0, r.out + r.err);
  check('refreshToken が残る壊れ方では /login を勧めない',
    !/`\/login` してから/.test(r.out + r.err), r.out + r.err);
  check('refreshToken が残っていることを理由として示す',
    /refreshToken は残っています/.test(r.out + r.err), r.out + r.err);
  check('/login すると失われることを伝える', /失われる/.test(r.out + r.err), r.out + r.err);
  check('中身の控えは残す(手掛かりとしての価値)', replacedFiles(home).length === 1,
    r.out + r.err + replacedFiles(home).join(','));
}
{
  // keepAside(控えのコピー失敗): fs.copyFileSync 自体が失敗すると、以前は生の Node 例外
  // (EPERM 等)がそのまま main の catch を通って出て、案内された --force が行き止まりになって
  // いた。ディレクトリを退避先に置いて確実に EPERM を再現する(実機では権限や別プロセスの
  // ロックで同じことが起きる)。
  const home = sandbox('keepaside-copy-fails', { current: creds('pro', { token: 'incoming' }) });
  fs.mkdirSync(acctPath(home, 'personal'), { recursive: true }); // ファイルの代わりにディレクトリ
  fs.mkdirSync(replacedDir(home), { recursive: true }); // 事前に作り、mkdirSync 自体を差分にしない
  const before = snapshotTree(home);
  const r = runSwap(home, ['save', 'personal', '--force']);
  checkAbort('控えのコピーが失敗する上書き', home, before, r);
  check('生の Node 例外ではなく理由と対処を案内する',
    /控えを取れませんでした/.test(r.err) && !/ {4}at /.test(r.err), r.err);
  // copyFileSync が ENOSPC/EIO 等で書き込み途中に失敗すると、切り詰められた部分ファイルが
  // dest に残ることがある。消さずに残すと replacedCounts() が「上書きで退けた旧内容」として
  // 数え、cmdStatus が復元可能なバックアップとして誤って案内する(しかも pruneReplaced は
  // 読めない控えを削除対象から外すので自動でも消えない)。personal 用の控えが 1 つも
  // 残っていないことを確認する。
  check('控えのコピー失敗で部分ファイルの残骸を残さない',
    replacedFiles(home, 'personal').length === 0, replacedFiles(home, 'personal').join(','));
}
{
  // レビュー指摘: 控えを取れない理由を「権限とロック」に決め打ちしていた頃は、probe が
  // EISDIR(同名のディレクトリが置かれている)と言っている直後に「別プロセスを終了したうえで
  // もう一度実行してください」を出しており、そのとおり動いても直らなかった(存在しないプロセス
  // 探しから始めさせることになる)。判定を unreadableReason に合流させ、原因に応じた対処
  // (このケースなら「先に原因を解いてください」)と、控えを取れない状態でも進める次の一手
  // (別の名前での退避)を出す。keepaside-copy-fails と同じサンドボックスを使う。
  const home = sandbox('keepaside-copy-fails-reason', { current: creds('pro', { token: 'incoming' }) });
  fs.mkdirSync(acctPath(home, 'personal'), { recursive: true }); // ファイルの代わりにディレクトリ
  fs.mkdirSync(replacedDir(home), { recursive: true });
  const r = runSwap(home, ['save', 'personal', '--force']);
  check('控えを取れない理由に、EISDIR に応じた原因(同じ名前のディレクトリ)を出す',
    /同じ名前のディレクトリ/.test(r.err), r.err);
  check('別の名前で退避すれば触れずに済むという次の一手を出す',
    /別の名前で退避すれば personal には触れずに済みます: swap save <別名>/.test(r.err), r.err);
}
{
  // cmdSwap 末尾(writeCurrentSlot(target) を包む try/catch): credentials の差し替えは成功した
  // あと、来歴(.current)の書き込みだけが失敗する状況。CURRENT_FILE をディレクトリにしておくと
  // writeAtomic の rename が失敗する。以前は生の Node 例外だけを出して exit 1 だったため、
  // 実際には切り替わっているのに「切り替わっていない」と読め、やり直すと新しいアカウントを
  // 旧スロットへ退避してしまっていた。
  // current を指定しない(未ログイン)のは、ログイン中だと saveCurrent が現在のアカウントを
  // 退避する過程でも writeCurrentSlot を呼ぶため、cmdSwap 末尾のガードより前の、保護されて
  // いない呼び出しで同じ EPERM に当たってしまい、確かめたい経路(末尾のガード)に届かないため。
  const home = sandbox('current-write-fails', {
    accounts: { team: creds('team', { token: 'team-tok' }) },
  });
  fs.mkdirSync(slotPath(home), { recursive: true }); // .current をディレクトリにして rename を失敗させる
  const r = runSwap(home, ['team']);
  check('来歴の書き込みが失敗しても切り替え自体は成功終了する', r.code === 0, r.out + r.err);
  check('切り替えたことを伝える(実際には切り替わっているので失敗したとは読ませない)',
    /切り替え:/.test(r.out), r.out + r.err);
  check('来歴を記録できなかった旨と、次は名前を明示する案内を出す',
    /来歴を記録できませんでした/.test(r.out) && /swap save <name>/.test(r.out), r.out + r.err);
  check('credentials の差し替え自体は実際に成功している',
    tokenOf(credPath(home)) === 'team-tok', r.out + r.err);
}
{
  // saveInto の上書きガード(cmdSwap の「来歴は一致するが中身が違う」経路): 来歴が一致していても
  // プラン種別が食い違えば、案内した `swap save` は上書きガードに当たって必ず失敗していた
  // (実機で再現)。他の中止経路と同じく、当たるなら --force を添えて案内すること。
  const home = sandbox('provenance-save-needs-force', {
    current: creds('pro', { token: 'pro-live' }),
    accounts: { team: creds('team', { token: 'team-old' }) },
    slot: 'team',
  });
  const r = runSwap(home, ['team']);
  check('来歴一致でもプラン種別が食い違えば中止する', r.code === 1, r.out + r.err);
  check('案内する swap save に --force が付いている(行き止まりにしない)',
    /swap save --force/.test(r.out + r.err), r.out + r.err);
  const follow = runSwap(home, ['save', '--force']);
  check('案内どおり実行すると実際に通る', follow.code === 0, follow.out + follow.err);
  check('退避先が現在の内容で更新される', tokenOf(acctPath(home, 'team')) === 'pro-live',
    follow.out + follow.err);
}
{
  // main(--force の位置): 一般的なフラグ位置で打っても、サブコマンド判定より前に --force を
  // 認識すること。`swap save --force team` は通るのに `swap --force team` は
  // 「引数が多すぎます」で止まっていた(実機で再現)。
  const home = sandbox('force-flag-position', {
    current: creds('pro', { token: 'live' }),
    accounts: { team: creds('team', { token: 'team-tok' }) },
  });
  const r = runSwap(home, ['--force', 'team']);
  check('--force を先頭に置いても通常の位置と同じ意味になる(行き止まりにしない)',
    r.code === 0 && tokenOf(credPath(home)) === 'team-tok', r.out + r.err);
}
{
  // main(--force の位置): --force だけを渡す(適用対象が無い)。cmdStatus に紛れ込ませると
  // 「引数無しなので状態表示」なのか「--force だけ渡された」なのか typo に気づけない。
  const home = sandbox('force-flag-alone', { current: creds('pro') });
  const before = snapshotTree(home);
  const r = runSwap(home, ['--force']);
  checkAbort('--force だけを渡した', home, before, r);
}

// --- README の初回手順をそのままなぞる ---
{
  // README 200-209行目付近: 「swap save」→「/login」→「swap save <名前>」の順で初回に通す手順。
  // /login は実行できないので、Claude Code が .credentials.json を置き換える動きを直接ファイルの
  // 上書きで再現する。2 つのアカウントは README の注記(同一プランだと判別できない)を踏まえて
  // プラン種別を変えておく。最後に最初のアカウント名で戻れることまで確認する。
  const home = sandbox('readme-first-run', { current: creds('pro', { token: 'acct-A' }) });
  const first = runSwap(home, ['save']);
  check('README手順: 1 回目の save は成功する', first.code === 0, first.out + first.err);
  fs.writeFileSync(credPath(home), JSON.stringify(creds('team', { token: 'acct-B' })), 'utf8');
  const second = runSwap(home, ['save', 'second']);
  check('README手順: 2 回目は名前を明示すれば save できる', second.code === 0, second.out + second.err);
  const back = runSwap(home, ['pro']);
  check('README手順: 最初のアカウントへ戻れる(exit 0)', back.code === 0, back.out + back.err);
  check('README手順: 戻った内容は最初のアカウントのもの',
    tokenOf(credPath(home)) === 'acct-A', back.out + back.err);
}

// 失効した退避への案内は、そのまま打てば通ること。--force を要求するガードは 4 つあるのに
// 判定が planDiffers しか見ておらず、しかも「退避先が復元元と同じ名前」の判定がそれらより
// 後ろにあったため、案内どおり打つと別の理由で二度目の中止に当たっていた。
{
  const home = sandbox('expired-guidance', {
    current: creds('pro'),
    accounts: { team: creds('team', { expiresInDays: -1 }) },
    slot: 'team',
  });
  const r1 = runSwap(home, ['team']);
  check('失効した退避への切り替えは中止する', r1.code === 1, r1.out + r1.err);
  // 来歴が target を指している状態では、素の `--force` はこの後の「退避先が復元元と同じ
  // 名前になります」で必ず中止される。別名での退避から案内しないと抜け出せない。
  check('失効の案内は別名での退避から示す', /swap save <別名>/.test(r1.err), r1.out + r1.err);
  const r2 = runSwap(home, ['save', 'other']);
  check('案内どおり別名で退避できる', r2.code === 0, r2.out + r2.err);
  const r3 = runSwap(home, ['team', '--force']);
  check('案内どおり打てば切り替えられる(二度目の中止に当たらない)', r3.code === 0, r3.out + r3.err);
}

// 切り替えたあとの「元に戻すには」も同じ判定を通すこと。戻す先(直前に退避した現在の
// ログイン)が失効している場合、planDiffers だけを見ていると --force が落ちて、案内どおり
// 打つと「失効しています」で中止される。復元先の状態はプラン種別とは独立に効く。
{
  const home = sandbox('restore-back-expired', {
    current: creds('pro', { expiresInDays: -1 }),
    accounts: { pro: creds('pro', { expiresInDays: -1 }), team: creds('team') },
    slot: 'pro',
  });
  const r = runSwap(home, ['team']);
  check('プランが違えば --force なしで切り替えられる', r.code === 0, r.out + r.err);
  check('戻し方の案内は失効を見て --force を付ける',
    /元に戻すには: swap pro --force/.test(r.out), r.out + r.err);
  const back = runSwap(home, ['pro', '--force']);
  check('案内どおり打てば元に戻せる', back.code === 0, back.out + back.err);
  check('戻った内容は元のアカウントのもの', typeOf(credPath(home)) === 'pro', back.out + back.err);
}

// 名前を省いた save が案内する --force コマンドに、そのまま打てない文字列を混ぜないこと。
// `swap save <name> --force` を印字していた頃は、表示どおり打つと validateName が `<name>` を
// 弾いて別のエラーで止まり、控えを残して先へ進む経路に到達できなかった。
{
  const home = sandbox('save-forcecmd-placeholder', { current: '{ broken' });
  const r1 = runSwap(home, ['save']);
  check('読めない現在の save は中止する', r1.code === 1, r1.out + r1.err);
  check('案内する --force にプレースホルダを混ぜない', !/<name>/.test(r1.err), r1.err);
  const r2 = runSwap(home, ['save', '--force']);
  check('案内どおり打てば名前の検証で弾かれない',
    !/使えない文字/.test(r2.err), r2.out + r2.err);
  check('案内どおり打てば控えが残る', replacedFiles(home, '.unreadable-current').length === 1,
    r2.out + r2.err);
}

{
  // cmdSwap の degraded 案内: 「読めなかった」は「中身が無価値」ではない。権限・ロック・
  // 書き込み途中でも degraded になるので、そこで「復元に使える形ではない」と断定すると、
  // 未退避アカウントの唯一のコピーになっている控えを、無価値だと言い切って捨てさせる。
  const home = sandbox('swap-degraded-reason', {
    current: '{ broken',
    accounts: { team: creds('team') },
  });
  const r = runSwap(home, ['team', '--force']);
  check('読めない現在でも --force なら切り替わる', r.code === 0, r.out + r.err);
  check('読めなかっただけの中身を「使えない」と断定しない',
    !/復元に使える形ではない/.test(r.out), r.out + r.err);
  check('退避しなかった理由を添える', /読めなかったため/.test(r.out), r.out + r.err);
  check('読めなかっただけの控えは消さないよう伝える',
    /消さないでください/.test(r.out), r.out + r.err);
}

{
  // 対照: JSON としては読めるが accessToken も refreshToken も無い場合は、中身を最後まで
  // 確認できているので、控えが復元に使えないことまで言い切ってよい。上の断定を避けるのは
  // 中身を確認できていないときだけ。
  const home = sandbox('swap-degraded-unusable', {
    current: { claudeAiOauth: { subscriptionType: 'pro' } },
    accounts: { team: creds('team') },
  });
  const r = runSwap(home, ['team', '--force']);
  check('待っても直らない壊れ方では控えが使えないと明示する',
    /復元には使えません/.test(r.out), r.out + r.err);
}

{
  // forceHint(saveBlocked): --force は復元側の判断でしかなく、退避先の上書きまでは許さない。
  // 来歴の指すスロットがプラン変更前の内容だと(driftedProvenance として明示的に扱う状態)、
  // 素の `swap <target> --force` は退避の段で上書きガードに当たって二度目の中止になる。
  // 案内には別名での退避を先に置き、そのとおり打てば切り替えられることまで見る。
  const home = sandbox('swap-force-blocked-by-save', {
    current: creds('max', { token: 'now' }),
    slot: 'personal',
    accounts: {
      personal: creds('pro', { token: 'older' }),
      team: creds('team', { token: 'gone', expiresInDays: -1 }),
    },
  });
  const r = runSwap(home, ['team']);
  check('失効した復元先は --force なしで中止する', r.code !== 0, r.out + r.err);
  check('案内は別名での退避を先に置く', /swap save <別名>/.test(r.err), r.out + r.err);
  check('退避の段で止まる理由も添える', /退避先 personal/.test(r.err), r.out + r.err);
  const s = runSwap(home, ['save', 'alias']);
  check('案内どおり別名で退避できる', s.code === 0, s.out + s.err);
  const f = runSwap(home, ['team', '--force']);
  check('案内どおり打てば切り替えられる(退避の段で止まらない)', f.code === 0, f.out + f.err);
  check('切り替え後の内容は復元先のもの', typeOf(credPath(home)) === 'team', f.out + f.err);
}

{
  // reportOtherSlots: 同じ内容を複数の名前で退避している場合、取り残されるスロットは複数ある。
  // 先頭 1 つにしかコマンドを出していなかった頃は、案内どおり打っても残りがローテート前の
  // トークンを持ったままになり、後でそちらを復元した時点でこの関数が防ぐはずの退化が起きた。
  const home = sandbox('report-other-slots-all', {
    current: creds('pro', { token: 'fresh' }),
    slot: 'pro',
    accounts: {
      pro: creds('pro', { token: 'stale' }),
      alias1: creds('pro', { token: 'stale' }),
      alias2: creds('pro', { token: 'stale' }),
    },
  });
  const r = runSwap(home, ['save']);
  check('取り残されるスロットを挙げる', /alias1/.test(r.out) && /alias2/.test(r.out), r.out + r.err);
  check('取り残される全スロットに更新コマンドを出す',
    /swap save alias1 --force/.test(r.out) && /swap save alias2 --force/.test(r.out),
    r.out + r.err);
}

{
  // レビュー指摘(前回の退行): reportOtherSlots は cmdSwap(切り替え直後)と cmdSave(退避しか
  // していない)の両方から呼ばれる。returnCmd が null であることだけを根拠に「いま復元した
  // アカウントの内容で上書きされます」「元に戻すには」を出すと、何も復元していない cmdSave の
  // 呼び出しにまで、復元した前提の案内が出てしまう(実際には切り替えていないので「元に戻す」
  // 相手が無く、上の「元に戻すには」の行自体も存在しない)。drifted(来歴が指していたスロットが
  // 取り残される)は cmdSave の `swap save <新しい名前>` 経由でしか作れない(cmdSwap は必ず
  // 来歴のスロットへ書き戻すため drifted にならない)ので、この経路が唯一の再現手段。
  const home = sandbox('save-drifted-no-restored-premise', {
    current: creds('pro', { token: 'acct-B' }),
    accounts: { old: creds('pro', { token: 'acct-A' }) },
    slot: 'old',
  });
  const r = runSwap(home, ['save', 'team']);
  check('退避は成功する(前提)', r.code === 0, r.out + r.err);
  check('取り残されたスロット(old)の警告は従来どおり出る',
    /今回の退避と内容が違うスロットがあります: old/.test(r.out), r.out + r.err);
  check('復元した前提の文言(いま復元したアカウント)は出さない',
    !r.out.includes('いま復元したアカウント'), r.out);
  check('「元に戻すには」も出さない(切り替えていないので戻す相手が無い)',
    !r.out.includes('元に戻すには'), r.out);
}

{
  // forceHint(needsName): 退避名を決められない状態(subscriptionType が読めず、来歴も無い)
  // では、素の `swap <target> --force` は退避の段で「退避名を決められません」に当たる。
  // この判定は !planned の分岐だけが持っていたため、復元前の 3 つのガード(失効・refreshToken
  // 欠け・subscriptionType 欠け)は行き止まりの案内を出していた。ここでは失効で再現する。
  const home = sandbox('force-hint-needs-name', {
    current: creds(null, { token: 'now' }),
    accounts: { team: creds('team', { token: 'gone', expiresInDays: -1 }) },
  });
  const r = runSwap(home, ['team']);
  check('失効した復元先は --force なしで中止する', r.code !== 0, r.out + r.err);
  check('退避名を決められないなら名前を明示する save を先に案内する',
    /swap save <name>/.test(r.err), r.out + r.err);
  check('名前が要る理由も添える', /退避名を決められない状態/.test(r.err), r.out + r.err);
  const s = runSwap(home, ['save', 'mine']);
  check('案内どおり名前を明示すれば退避できる', s.code === 0, s.out + s.err);
  const f = runSwap(home, ['team', '--force']);
  check('案内どおり打てば切り替えられる(退避名の段で止まらない)', f.code === 0, f.out + f.err);
}

{
  // failOverwrite(afterCmd): プラン種別が食い違う組み合わせでは復元前のガードが 1 つも
  // 発火しない(planned が真なので !planned の分岐にも入らない)ため、上書きガードでの中止が
  // その切り替えに対する唯一の案内になる。退避の手順だけを出すと、要求した切り替えを終える
  // 最後の一手を人に推測させることになるので、続けて打つコマンドまで出す。
  const home = sandbox('save-blocked-shows-next-step', {
    current: creds('pro', { token: 'cur' }),
    accounts: { pro: creds('pro', { token: 'other' }), team: creds('team') },
  });
  const r = runSwap(home, ['team']);
  check('退避先に別の内容があれば切り替えを中止する', r.code !== 0, r.out + r.err);
  check('退避の案内には続きの一手を添える',
    /swap save <別名>\n\s+swap team/.test(r.err), r.out + r.err);
  check('上書きを選ぶ場合にも続きの一手を添える',
    /swap save pro --force\n\s+swap team/.test(r.err), r.out + r.err);
  const s = runSwap(home, ['save', 'alias']);
  check('案内どおり別名で退避できる', s.code === 0, s.out + s.err);
  const f = runSwap(home, ['team']);
  check('案内どおり続けて打てば切り替えられる', f.code === 0, f.out + f.err);
  check('切り替え後の内容は復元先のもの', typeOf(credPath(home)) === 'team', f.out + f.err);
}

{
  // .replaced を扱えない環境(手違いで同名のファイルが置かれている、権限が無い)。控えの
  // 置き場所を作る mkdirSync と一覧の readdirSync は keepAside の try の外にあったため、
  // 生の `EEXIST: file already exists, mkdir ...` / `ENOTDIR: not a directory, scandir ...`
  // だけが出て、何が中止されたのかも直し方も伝わらない行き止まりになっていた。
  // ファイルを置いて再現する(実機では権限や ACL でも同じことが起きる)。
  const home = sandbox('replaced-dir-unusable', {
    current: creds('pro', { token: 'now' }),
    accounts: { pro: creds('pro', { token: 'older' }) },
  });
  fs.writeFileSync(replacedDir(home), 'not a directory', 'utf8');
  const r = runSwap(home, ['save', 'pro', '--force']);
  check('控えを置けない環境では上書きへ進まない', r.code !== 0, r.out + r.err);
  check('控えを置けない理由を添える', /控えを/.test(r.err) && /EEXIST|ENOTDIR|EACCES|EPERM/.test(r.err),
    r.out + r.err);
  check('元のファイルが手つかずだと伝える', /元のファイルは手つかずです/.test(r.err), r.out + r.err);
  check('スロットは実際に上書きされていない', tokenOf(acctPath(home, 'pro')) === 'older',
    r.out + r.err);
  const s = runSwap(home, []);
  check('status は途中で死なずに最後まで出す', /退避済み|accounts/.test(s.out) && s.code === 0,
    s.out + s.err);
  check('status は控えを数えられないことを伝える',
    /控えを数えられません/.test(s.out), s.out + s.err);
}

{
  // 修正4: ACCOUNTS_DIR が手違いでファイルとして存在すると、savedAccounts() の生の readdirSync が
  // ENOTDIR で落ち、原因も対処も示されないまま全サブコマンドが死んでいた。listReplaced()
  // (340-345 付近)は既にこのパターンへ対策済みなので、そこに揃える。
  const home = sandbox('accounts-dir-unusable', { current: creds('pro', { token: 'now' }) });
  const accountsDir = path.join(home, '.claude', 'accounts');
  fs.rmSync(accountsDir, { recursive: true, force: true });
  fs.writeFileSync(accountsDir, 'not a directory', 'utf8');
  //
  // 第9ラウンドの監査で savedAccountsOrFail(一覧が読めなければ process.exit)は削除した。
  // status は「いま何が残っているか」を確かめる唯一の入り口なので、一覧が読めなくても
  // 最後まで出しきる。ここで止めると下の .replaced の復旧・保全の案内に到達せず、控えが
  // 残っていること自体に気づけない。したがって期待は exit 0 で、原因と対処は stdout に出る。
  const r = runSwap(home, []);
  check('スロット一覧を読めない環境でも status は最後まで出す', r.code === 0, r.out + r.err);
  check('原因(e.code)を添える', /ENOTDIR|EEXIST|EACCES|EPERM/.test(r.out), r.out + r.err);
  check('対処を添える', /権限を確認/.test(r.out), r.out + r.err);
  // 「読めない」を「0 件」に倒すと、控えがあるのに無いと誤認させる(規則1と同じ型)。
  check('読めないことを 0 件と言い換えない', !/なし。`swap save`/.test(r.out), r.out + r.err);
  check('生の Node スタックトレースを出さない',
    !/at Object\.|at Module\.|node:internal/.test(r.out + r.err), r.out + r.err);
}

{
  // 修正6: writeAtomic の mkdirSync が ENOTDIR / EEXIST(置き場所が同名のファイルになっている)で
  // 落ちた場合、以前は EPERM/EBUSY 向けの「ファイルを掴んでいる別プロセスを終了…」しか出さず、
  // 的外れだった。初回の `swap save` はまだ何も退避していない(oldToken が無い)ので staleSlots が
  // savedAccounts を呼ばずに素通しし、savedAccountsOrFail(修正4)より先に writeAtomic へ到達する
  // (実機で確認済み)。ACCOUNTS_DIR をファイルとして置いて再現する。
  const home = sandbox('accounts-dir-is-file-on-save', { current: creds('pro', { token: 'now' }) });
  const accountsDir = path.join(home, '.claude', 'accounts');
  fs.rmSync(accountsDir, { recursive: true, force: true });
  fs.writeFileSync(accountsDir, 'not a directory', 'utf8');
  const r = runSwap(home, ['save', '--force']);
  check('置き場所がファイルの環境では書き込みへ進まない', r.code !== 0, r.out + r.err);
  check('原因(e.code)を添える', /EEXIST|ENOTDIR/.test(r.err), r.err);
  check('ENOTDIR/EEXIST 向けの「同名のファイル」の案内を添える',
    /同名のファイルになっていないか確認してください/.test(r.err), r.err);
  // 修正F: dirIsFileHint は差し替えであって追記ではない。的外れな EPERM 向け文言(該当プロセスが
  // 無いのに終了を促す)が先頭に残ったまま「同名のファイル」の案内が追記されるだけだと、
  // 利用者はまず存在しないプロセス探しから始めることになる。
  check('的外れな EPERM 向け「別プロセスを終了」の文言は残らない(追記ではなく差し替え)',
    !/掴んでいる別プロセス/.test(r.err), r.err);
}

{
  // 名前を省いた退避は、来歴か subscriptionType から名前が決まる。この経路は validateName を
  // 通っていなかったため、subscriptionType が予約語(サブコマンドと同じ名前)になると、
  // `swap <name>` では復元できないスロットが静かに作られる。名前が確定したところで検証する。
  const home = sandbox('implicit-name-reserved', { current: creds('save', { token: 'now' }) });
  const r = runSwap(home, ['save']);
  check('暗黙の退避名でも予約語なら中止する', r.code !== 0, r.out + r.err);
  check('予約語だと分かる理由を出す', /サブコマンドと同じ/.test(r.err), r.out + r.err);
  check('復元できないスロットを作らない', !fs.existsSync(acctPath(home, 'save')), r.out + r.err);
}

{
  // 復元先スロットの読み取り失敗を「壊れている」と決め打ちしていた頃は、ウイルス対策や
  // バックアップツールが一時的に掴んでいるだけのときにも `/login` し直す案内を出していた。
  // そのとおり打つと、まだ退避していない現在のアカウントの refreshToken がそこで消える
  // (現在の credentials 側では既に避けている経路)。ディレクトリを置いて EISDIR で再現する。
  const home = sandbox('restore-target-unreadable', { current: creds('pro', { token: 'now' }) });
  fs.mkdirSync(acctPath(home, 'team'), { recursive: true });
  const r = runSwap(home, ['team']);
  check('読めない復元先では上書きしない', r.code !== 0, r.out + r.err);
  check('読み取り失敗を「壊れている」と断定しない', !/壊れているか/.test(r.err), r.out + r.err);
  check('読めない理由を添える', /EISDIR/.test(r.err), r.out + r.err);
  // 抜ける手順(/login し直して入れ直す)は、読めない理由によらず必ず案内する。ただし
  // 現在の pro/now はまだどこにも退避されていないため、/login より先に必ず退避を案内する。
  // 順序が逆になると、案内どおり打った時点で現在のアカウントが永久に失われる。
  check('/login より先に現在のログインの退避を案内する',
    r.err.indexOf('swap save pro') >= 0
    && r.err.indexOf('swap save pro') < r.err.indexOf('`/login` し直して'), r.out + r.err);
  check('現在のログインはそのまま', tokenOf(credPath(home)) === 'now', r.out + r.err);
}

{
  // 対照: JSON としては読めるのに accessToken が無い復元先は、待っても直らない(手で編集した・
  // 別バージョンが書いた・将来の構造変更)。従来どおり入れ直しを案内してよいが、いまログイン中の
  // pro/now はまだどこにも退避されていない(accounts にあるのは team だけ)ので、修正1により
  // /login より先に `swap save` を案内しないと、案内どおり打った時点で pro/now が永久に失われる。
  const home = sandbox('restore-target-no-token', {
    current: creds('pro', { token: 'now' }),
    accounts: { team: { claudeAiOauth: { subscriptionType: 'team' } } },
  });
  const r = runSwap(home, ['team']);
  check('待っても直らない復元先では入れ直しを案内する',
    /`\/login` し直して/.test(r.err), r.out + r.err);
  check('現在のアカウントが未退避なら /login より先に swap save を案内する',
    /swap save[^\n]*\n[\s\S]*`\/login` し直して/.test(r.err), r.err);
}
{
  // 修正1の核心: 現在ログイン中のアカウントがまだどのスロットにも退避されていない状態で、
  // 復元先が壊れている(accessToken が無い)swap を打つと、以前は現在の状態を一度も確認せずに
  // いきなり「そのアカウントで /login し直してください」と案内していた。案内どおり打つと、
  // 一度も swap save していない現在の credentials が /login の時点で永久に失われる
  // (このツールで最も高い代償を払う失敗、swap.js 冒頭コメント参照)。
  const home = sandbox('swap-save-first-when-current-unsaved', {
    current: creds('pro', { token: 'unsaved-now' }),
    accounts: { team: { claudeAiOauth: { subscriptionType: 'team' } } },
  });
  const r = runSwap(home, ['team']);
  check('復元先が壊れていて上書きを中止する', r.code !== 0, r.out + r.err);
  check('/login より先に swap save <name> を案内する',
    /swap save pro/.test(r.err), r.err);
  check('swap save の案内が /login より前に出る',
    r.err.indexOf('swap save pro') < r.err.indexOf('`/login` し直して'), r.err);
  check('現在のログインには何も触れていない', tokenOf(credPath(home)) === 'unsaved-now', r.out + r.err);
}
{
  // 対照: 現在ログイン中のアカウントが既に別のスロットへ退避済み(refreshToken の一致で証明できる)
  // なら、/login しても失うものが無いので、従来どおりの案内のままでよい(swap save の一手を
  // 余分に挟ませない)。
  const home = sandbox('no-swap-save-first-when-already-saved', {
    current: creds('pro', { token: 'already-saved' }),
    accounts: {
      pro: creds('pro', { token: 'already-saved' }),
      team: { claudeAiOauth: { subscriptionType: 'team' } },
    },
    slot: 'pro',
  });
  const r = runSwap(home, ['team']);
  check('復元先が壊れていて上書きを中止する', r.code !== 0, r.out + r.err);
  check('既に退避済みなら swap save <name> の追加案内は出さない',
    !/先に `swap save/.test(r.err), r.err);
  check('従来どおり入れ直しを案内する', /`\/login` し直して/.test(r.err), r.err);
}

// --- 修正B: 復元先を読めないときの「先に swap save」案内が、既存の上書きガードを迂回していた ---
{
  // B-1: 案内する退避先(curSlotOf)が既存のスロットと違う内容で埋まっている(overwriteGate が
  // blocked)なら、素の名前ではなく <別名> を案内する。これを通さずに「swap save pro」と
  // 決め打ちしていた頃は、案内どおり打つと「退避先 pro には現在と違う認証情報が入っています」で
  // exit 1 になり、指示された一手が実行できなかった。
  const home = sandbox('swap-save-first-routes-through-overwrite-gate', {
    current: creds('pro', { token: 'now' }),
    accounts: {
      pro: creds('pro', { token: 'someone-elses-pro' }), // 同じプランの別アカウント(来歴は未記録)
      team: { claudeAiOauth: { subscriptionType: 'team' } }, // 復元先: 壊れている(accessToken 無し)
    },
  });
  const r = runSwap(home, ['team']);
  check('復元先が壊れていて上書きを中止する', r.code !== 0, r.out + r.err);
  check('ブロックされる退避先をそのまま案内しない(素の swap save pro を出さない)',
    !/先に `swap save pro`/.test(r.err), r.err);
  check('<別名> を案内し、上書きガードに当たる理由を添える',
    /先に `swap save <別名>`/.test(r.err) && /退避先 pro には現在と違う認証情報が入っている/.test(r.err),
    r.err);
  // 案内どおり別名で退避すると実際に成功する(止まらない)ことまで確かめる
  const s = runSwap(home, ['save', 'alias']);
  check('案内どおり別名で退避すると実際に成功する', s.code === 0, s.out + s.err);
  check('退避先 pro には触れていない(別アカウントの唯一のバックアップを守る)',
    tokenOf(acctPath(home, 'pro')) === 'someone-elses-pro', s.out + s.err);
}
{
  // B-2: 案内する退避先が、いま復元しようとしている target 自身になることがある(来歴が target を
  // 指しているが target のファイル自体は壊れている)。これを通さずに案内していた頃は、
  // 「swap save max」→(手で /login)→「swap save max --force」の 3 行目が、1 行目で
  // 退避したばかりのアカウントを自分自身で潰していた。
  const home = sandbox('swap-save-first-avoids-same-as-target', {
    current: creds('team', { token: 'now' }),
    accounts: { team: { claudeAiOauth: { subscriptionType: 'team' } } }, // 壊れている(target 自身)
    slot: 'team', // 来歴が target(team) を指している
  });
  const r = runSwap(home, ['team']);
  check('復元先が壊れていて上書きを中止する', r.code !== 0, r.out + r.err);
  check('target 自身を退避先として案内しない',
    !/先に `swap save team`/.test(r.err), r.err);
  check('<別名> を案内する', /先に `swap save <別名>`/.test(r.err), r.err);
}
{
  // B-3: 現在の credentials が accessToken 欠け・refreshToken だけ残る(staleRefreshToken)状態だと、
  // 従来は readCredsOrNull(accessToken 必須)で null になり、「先に swap save」の案内が一切出ないまま
  // 「/login し直してください」だけが出ていた。案内どおり /login すると、まだ退避していない
  // refreshToken がその時点で失われる。
  const home = sandbox('swap-save-first-detects-stale-refresh-token', {
    current: {
      claudeAiOauth: {
        refreshToken: 'refresh-stale-now',
        refreshTokenExpiresAt: Date.now() + 30 * DAY,
        subscriptionType: 'pro',
      },
    }, // accessToken が無い(staleRefreshToken)
    accounts: { team: { claudeAiOauth: { subscriptionType: 'team' } } }, // 壊れている(target)
  });
  const r = runSwap(home, ['team']);
  check('復元先が壊れていて上書きを中止する', r.code !== 0, r.out + r.err);
  // accessToken を欠く現在の credentials はスロットへは退避できない(読めない中身を入れると
  // そこにある有効な退避を潰す)。案内できるのは「控えだけ残す」ところまでなので、素の
  // `swap save pro` ではなく、名前を伴わない `swap save --force` を出す。ここで名前入りの
  // コマンドや `<name>` を案内していた頃は、そのとおり打っても退避できず行き止まりになった。
  check('stale な現在の credentials でも先に控えを残す手を案内する',
    /先に `swap save --force`/.test(r.err), r.err);
  check('控えを残す案内が /login より前に出る',
    r.err.indexOf('swap save --force') < r.err.indexOf('`/login` し直して'), r.err);
}

// --- 修正C: cmdSwap の degraded 表示が staleRefreshToken を見ていなかった ---
{
  // cmdStatus / cmdSave は staleRefreshToken(accessToken 欠けだが refreshToken は残る)の控えを
  // 「消さないでください」と案内するのに、実際に控えを作る cmdSwap の degraded 表示だけが
  // 「この控えは復元には使えません」と断定していた。唯一の refreshToken の控えをその場で
  // 消させかねないので、cmdStatus と同じ文面に揃える。
  const home = sandbox('swap-degraded-display-stale-refresh-token', {
    current: {
      claudeAiOauth: {
        refreshToken: 'refresh-stale',
        refreshTokenExpiresAt: Date.now() + 30 * DAY,
        subscriptionType: 'pro',
      },
    }, // accessToken が無い(staleRefreshToken)
    accounts: { team: creds('team', { token: 'team-tok' }) }, // 健全な復元先
  });
  const r = runSwap(home, ['team', '--force']);
  check('stale な現在の credentials の控えは消さないでくださいと案内する',
    /消さないでください/.test(r.out) && /refreshToken/.test(r.out), r.out + r.err);
  check('復元には使えないと断定しない(cmdStatus の staleToken 案内と食い違わない)',
    !/この控えは復元には使えません/.test(r.out), r.out + r.err);
}

// --- 修正D: replacedCounts が読み取れないだけの控えを「消して構いません」側に分類していた ---
{
  // ウイルス対策やバックアップツールがファイルを掴んでいる(EBUSY/EACCES/EPERM)だけの控えが
  // 「復元に使えない」側に落ち、cmdStatus が「原因を調べ終えたら消して構いません」と案内して
  // いた。pruneReplaced は同じ控えを「読めないことは復旧に使えないことの証明にならない」として
  // 決して消さないので、自動削除の方針と表示の方針が逆を向いていた。件数を分ける軸は
  // 「待てば直るか」ではなく「中身を確認できたか」で、ここは読み取り自体に失敗した側。
  // 読み取り失敗はディレクトリで代用して EISDIR で再現する(既存の
  // 「復元先スロットの読み取り失敗」テストと同じ技法)。
  const home = sandbox('replaced-status-unreadable', {
    current: creds('pro', { token: 'now' }),
    accounts: { pro: creds('pro', { token: 'older' }) },
  });
  const save1 = runSwap(home, ['save', 'pro', '--force']);
  check('前提: 退避が成功する', save1.code === 0, save1.out + save1.err);
  const files = replacedFiles(home, 'pro');
  check('前提: 押し出された旧内容の控えができている', files.length === 1, files.join(', '));
  const victim = path.join(replacedDir(home), files[0]);
  fs.rmSync(victim);
  fs.mkdirSync(victim); // ファイルをディレクトリに差し替えて EISDIR を起こす
  const r = runSwap(home, []);
  check('読み取れない控えを別項目で出す',
    /読み取れない控え: 1 件/.test(r.out), r.out + r.err);
  check('「消して構いません」には混ぜない',
    !/読み取れない控え[\s\S]{0,300}消して構いません/.test(r.out), r.out);
  check('消さないでくださいと案内する',
    /読み取れない控え[\s\S]{0,300}消さないでください/.test(r.out), r.out);
}

// --- 修正E: 中止メッセージ組み立て中の slotsHolding が accounts 一覧を読めないと process を落とす ---
{
  // 修正Bの saveFirst 案内(先に swap save)は accounts の一覧を読んで「既に退避済みか」を
  // 確かめる。この一覧読み取りに savedAccountsOrFail(= 読めなければ process.exit)を使うと、
  // 「target を復元できません」という本来出るはずの中止メッセージが、組み立ての途中で
  // 「一覧を読めません」という別の中止に差し替わって消える。accounts ディレクトリの
  // 読み取り権限だけが落ちている環境(WSL など)で起きる。POSIX の権限ビット(読み取り不可・
  // 実行可)で再現するので、chmod が効かない環境(Windows など)では自己診断でスキップする。
  const home = sandbox('swap-abort-message-survives-unreadable-accounts-dir', {
    current: creds('pro', { token: 'now' }),
    accounts: { team: { claudeAiOauth: { subscriptionType: 'team' } } }, // 壊れている(target)
  });
  const accountsDir = path.join(home, '.claude', 'accounts');
  fs.chmodSync(accountsDir, 0o311); // r-x を落とし --x だけにする(一覧はできないが個別の到達は可)
  let reproduces = true;
  try { fs.readdirSync(accountsDir); reproduces = false; } catch { /* この環境では期待どおり読めない */ }
  if (reproduces) {
    const r = runSwap(home, ['team']);
    check('accounts 一覧を読めなくても target 読み込み失敗の中止メッセージを保つ',
      /team を復元できません/.test(r.err), r.out + r.err);
    check('無関係な「一覧を読めません」には差し替わらない',
      !/退避済みアカウントの一覧を読めません/.test(r.err), r.out + r.err);
  }
  fs.chmodSync(accountsDir, 0o755); // 後始末(後続のクリーンアップが失敗しないように戻す)
}

{
  // 読めない現在の控えは pruneReplaced の対象外(復旧に使えないことを証明できないので消さない)
  // なので、壊れた credentials を抱えたまま --force を繰り返すと上限の効かないまま増え続けて
  // いた。同じバイト列なら同じ中身の控えなので、新しい番号を作らない。
  const home = sandbox('unreadable-keepaside-dedup', { current: '{ broken' });
  runSwap(home, ['save', '--force']);
  runSwap(home, ['save', '--force']);
  runSwap(home, ['save', '--force']);
  check('同じ中身の控えは増やさない',
    replacedFiles(home, '.unreadable-current').length === 1,
    replacedFiles(home, '.unreadable-current').join(', '));
  // 中身が変われば別の控えとして残す(取りこぼしを作らない)
  fs.writeFileSync(credPath(home), '{ broken differently', 'utf8');
  runSwap(home, ['save', '--force']);
  check('中身が変われば控えを増やす',
    replacedFiles(home, '.unreadable-current').length === 2,
    replacedFiles(home, '.unreadable-current').join(', '));
}

// --- スロット名の大小を無視するファイルシステムでの同一視 ---
// canonicalSlotName(swap.js:719)の回帰。大小を無視するファイルシステム(Windows/macOS の
// 既定)では accounts/pro.json と accounts/Pro.json が同じファイルを指すが、target の比較は
// 文字列そのもので行われる。cmdSwap が canonicalSlotName を通さずに target を使っていた頃は、
// `swap pro --force` は「退避先が復元元と同じ」ガード(swap.js:1540)で正しく中止されるのに、
// `swap Pro --force` だとファイルは同じものが開かれるのに文字列だけが食い違ってガードが
// 1 つも発火せず、退避で新しい内容を書いた直後、読み込み済みの古い内容を credentials へ
// 書き戻していた(マシン全体の認証がローテート前に巻き戻る。実機で再現済み)。
// 区別する FS ではこの食い違いがそもそも起きない(`swap Pro --force` は accounts/Pro.json が
// 無いので「退避されていません」で止まるだけ)ので、まず実測して分岐する。
{
  const probeDir = path.join(BASE, '.case-probe');
  fs.mkdirSync(probeDir, { recursive: true });
  fs.writeFileSync(path.join(probeDir, 'probe.tmp'), 'x', 'utf8');
  const isCaseInsensitiveFs = fs.existsSync(path.join(probeDir, 'PROBE.tmp'));
  if (isCaseInsensitiveFs) {
    const home = sandbox('canonical-slot-name-case', {
      current: creds('pro', { token: 'pro-new' }),
      accounts: { pro: creds('pro', { token: 'pro-old' }) },
      slot: 'pro',
    });
    const r = runSwap(home, ['Pro', '--force']);
    check('大文字始まりでも同一視ガードで中止する(大小無視 FS)', r.code !== 0, r.out + r.err);
    check('中止したので credentials は古いトークンへ巻き戻らない',
      tokenOf(credPath(home)) === 'pro-new', tokenOf(credPath(home)));
  }
  // else: このマシンのファイルシステムが大小を区別する場合、上のガードはそもそも試せない
  // (target='Pro' は accounts/pro.json に一致しないため)。check() を出さずに抜ける。
}

// --- 読めない現在の credentials に対する案内 ---
// 3 つとも根は同じ: コードが現在の credentials を「読める / 無い」の 2 値でしか持たず、
// 「読めない」を扱う唯一の箇所が accessToken 欠け(stale)決め打ちだったこと。判定は
// unreadableReason の copyable / hasToken に合流させてある(swap.js の同名コメント参照)。
// 書き込みが途中で切れた形。JSON としては壊れているが、生バイト列に refreshToken が残る。
const TRUNCATED_CURRENT =
  '{"claudeAiOauth":{"accessToken":"at-x","refreshToken":"rt-only-copy","expiresAt":1';

{
  // 復元先も壊れていて中止するとき、現在の唯一の refreshToken を控えに残す手順を先に案内する。
  // 案内せず `/login` し直すことだけを勧めていた頃は、.replaced に控えが 1 つも無い状態で
  // 上書きを促しており、そのとおり打つと未退避の refreshToken が完全に失われた。
  const home = sandbox('unreadable-current-restore-guidance', {
    current: TRUNCATED_CURRENT,
    accounts: { alpha: '{ broken slot' },
  });
  const out = (({ out: o, err }) => o + err)(runSwap(home, ['alpha']));
  check('壊れた現在では控えを残す手順を先に案内する',
    out.includes('swap save --force') && out.includes('控え'), out);
  // 元は out.includes('refreshToken') だったが、出力のどこかにその語があれば通る形なので
  // 案内の文面が退化しても気づけない。約束している当の一文を名指しで見る。
  check('控えにトークンが残ることまで伝える', out.includes('控えにトークンが残る'), out);
}

{
  // 退避済みスロットがあるときの一覧。現在が読めないと saveFirstText が「不要」を返し、
  // 素の `swap <名前>` だけを並べていた。打つと「現在の credentials を読めません」で
  // 即座に止まる(このファイルで繰り返し起きた「案内どおり打つと止まる」)。
  const home = sandbox('unreadable-current-slot-list', {
    current: TRUNCATED_CURRENT,
    accounts: { alpha: creds('pro', { token: 'alpha-token' }) },
  });
  const out = (({ out: o, err }) => o + err)(runSwap(home, ['nosuch']));
  check('読めない現在では控えを取る手順も案内する', out.includes('swap save --force'), out);
  check('復元コマンドに --force が付く(付けないと退避の段で止まる)',
    out.includes('swap alpha --force'), out);
  // 案内どおり打つと本当に通ることまで確かめる(reachable.test.js と同じ基準)。
  runSwap(home, ['save', '--force']);
  const r2 = runSwap(home, ['alpha', '--force']);
  check('案内どおり打つと切り替えまで到達する', r2.code === 0, r2.out + r2.err);
  check('現在の中身は控えとして残っている',
    replacedFiles(home, '.unreadable-current').length === 1,
    replacedFiles(home, '.unreadable-current').join(', '));
}

{
  // 開くことすらできない現在(ここでは同名ディレクトリを置いて EISDIR にする)。控えは
  // copyFileSync が同じ理由で落ちるので取れないのに、「--force を付ければ控えが残ります
  // (refreshToken を取り出せます)」と約束していた。約束してよいのはバイト列を読めたときだけ。
  const home = sandbox('unopenable-current-no-copy-promise');
  fs.mkdirSync(credPath(home), { recursive: true });
  const out = (({ out: o, err }) => o + err)(runSwap(home, ['nosuch']));
  check('開けない現在では控えを約束しない', !out.includes('控えだけが残ります'), out);
  check('開けないことと、控えも取れないことを伝える', out.includes('控えも取れない'), out);
}

{
  // 開くことすらできない現在(EISDIR)から、失効済みの復元先へ切り替えようとした場合。
  // curUnsavable(現在を退避できない理由)を forceHint が見ていなかった頃は、needsName /
  // sameAsTarget / saveBlocked の 3 つがすべて false(cur が null で判定材料が無い)になり、
  // 案内が「現在のログインはそのままです。承知のうえで復元するなら: swap alpha --force」の
  // 1 行だけに退化していた。案内どおり打つと、開けない現在は copyFileSync も同じ理由で
  // 失敗するため keepAside が控えを取れずに中止し、「もう一度実行してください」を繰り返す
  // 無限リトライになる(上の「開けない現在では控えを約束しない」と根は同じ)。
  const home = sandbox('unopenable-current-expired-target', {
    accounts: { alpha: creds('pro', { expiresInDays: -1 }) },
  });
  fs.mkdirSync(credPath(home), { recursive: true });
  const r = runSwap(home, ['alpha']);
  const out = r.out + r.err;
  check('開けない現在からの復元は中止する', r.code !== 0, out);
  check('裸の --force 案内だけにしない',
    !out.includes('現在のログインはそのままです。承知のうえで復元するなら: swap alpha --force'), out);
  check('先に控えを残す手順を案内する',
    out.includes('先に退避してから、承知のうえで復元してください') && out.includes('swap save --force'),
    out);
}

// --- 大小を区別するファイルシステムでは読み替えない ---
// canonicalSlotName の、上の「大小無視 FS」ブロックとは逆側。Windows/macOS の既定では実測分岐で
// スキップされてしまい、Linux でしか検査できていなかった。区別する FS の本質は「打った名前の
// ファイルが実在しない(ENOENT)」ことなので、accounts/Pro.json の読み取りにだけ ENOENT を
// 注入して同じ状況を作る(readdir には pro.json しか現れない、という条件はそのまま成立する)。
// 名前だけで読み替えていた頃は、`swap save Pro` が既存の pro スロットへ読み替わり、別アカウントの
// 唯一の退避を狙って上書きガードも来歴判定もすり抜けていた。
{
  const home = sandbox('canonical-slot-name-case-sensitive', {
    current: creds('pro', { token: 'cur-account' }),
    accounts: { pro: creds('pro', { token: 'other-account' }) },
  });
  const r = execSwapScript(SWAP, ['save', 'Pro'], {
    env: {
      ...homeEnv(home),
      NODE_OPTIONS: '--require ' + path.join(__dirname, 'fault-fs.js'),
      SWAP_FAULT: JSON.stringify({
        call: 'readFileSync', match: 'Pro.json', kind: 'throw', code: 'ENOENT',
      }),
    },
  });
  const out = r.out + r.err;
  // 実ファイルの中身では判定できない(このマシンの FS は大小を無視するので、Pro.json への
  // 書き込みは pro.json に当たる)。読み替えたかどうかは、選ばれたスロット名に現れる。
  check('区別する FS では既存の pro スロットへ読み替えない',
    out.includes('Pro') && !/退避しました: pro\b/.test(out), out);
  check('別アカウントの退避を上書きするガードに当たらない(そもそも別スロット)',
    !out.includes('上書きを中止'), out);
}

// --- 1 回目の読み取りだけ失敗する現在の credentials ---
// cmdSwap は cur が null のときだけ復元ガードを素通しする設計なので、たまたま 1 回目の read が
// 失敗しただけの状態を null のまま進めると、来歴一致・退避先が復元元と同じ・同一プランで
// 別アカウント未確認の 3 つが同時に外れる。実機相当の再現(credentials の 1 回目の read にだけ
// EBUSY を注入)では「切り替え: mypro -> mypro」と表示して読み込み済みの旧内容を書き戻し、
// exit 0 で終わっていた(ローテート前のトークンへ退化する)。
{
  const home = sandbox('current-unreadable-once-guard', {
    current: creds('pro', { token: 'CUR-NEW' }),
    accounts: { mypro: creds('pro', { token: 'SLOT-OLD' }) },
    slot: 'mypro',
  });
  const r = execSwapScript(SWAP, ['mypro'], {
    env: {
      ...homeEnv(home),
      NODE_OPTIONS: '--require ' + path.join(__dirname, 'fault-fs.js'),
      SWAP_FAULT: JSON.stringify({
        call: 'readFileSync', match: '.credentials.json', kind: 'throw', code: 'EBUSY', nth: 1,
      }),
    },
  });
  check('1 回目だけ読めなくても復元ガードは素通りしない', r.code !== 0, r.out + r.err);
  check('現在のログインはローテート前へ巻き戻らない',
    tokenOf(credPath(home)) === 'CUR-NEW', tokenOf(credPath(home)));

  // status も同じ読み方に揃っていること。揃っていないと「読めません(いまは健全に読めて
  // います)」という、それ自体で矛盾した行が出る(原因の切り分けができなくなる)。
  const s = execSwapScript(SWAP, [], {
    env: {
      ...homeEnv(home),
      NODE_OPTIONS: '--require ' + path.join(__dirname, 'fault-fs.js'),
      SWAP_FAULT: JSON.stringify({
        call: 'readFileSync', match: '.credentials.json', kind: 'throw', code: 'EBUSY', nth: 1,
      }),
    },
  });
  check('status は自己矛盾した行を出さない',
    !(s.out + s.err).includes('読めません(いまは健全に読めています'), s.out + s.err);
}

// --- 読み取りが 2 回続けて失敗する現在の credentials(1 回だけでは再現できない自己矛盾) ---
// readCurrentForGuard() の最終分岐(「読めたり読めなかったりします」verdict='unreadable')は、
// 同じ実行内で .credentials.json への readFileSync が 1→(readCredsOrNull) 2→(probeFile,
// exists 確認) 3→(probeFile, 1 回目の unreadableReason) 4→(readCredsOrNull, 再読み込み)
// 5→(probeFile, 2 回目の unreadableReason) の順に最大 5 回呼ばれる設計になっている(実装
// コメント参照)。この分岐に届くには 1 回目と 4 回目(readCredsOrNull 経由)だけを失敗させ、
// 2・3・5 回目(probeFile 経由)は成功させる必要がある。readCredsOrNull も probeFile も内部で
// `fs.readFileSync(file, 'utf8')` を同じ引数で呼んでいて、SWAP_FAULT は呼び出し元を区別
// できないため、離れた 2 回(1 と 4)だけを狙い撃つには nth が単一の回数では表現できない
// (fault-fs.js を単一値のままにして「1 回目だけ」を注入すると、4 回目の再読み込みは
// 素通りして健全に読めてしまい、この分岐には届かない。実測で裏を取ってある: 下記コメント
// 「実測」参照)。fault-fs.js の nth を配列/カンマ区切りで複数指定できるよう拡張し
// (単一の数値もこれまでどおり動く後方互換)、1 と 4 だけを注入できるようにした。
//
// 実測: nth の値を変えながら実際に注入して出力を確認し、上の対応(1,4 → 目的の分岐/
// 2,3,5 → probeFile 経由)が推測ではなく事実であることを確かめてある。
//   nth:[1]   … 4 回目の再読み込みが素通りして回復する(「1 回目だけ読めなくても」と同じ)
//   nth:[1,2] … 2 回目(exists 確認)は失敗しても probeFile が code から exists=true を
//               返すため、nth:[1] と同じ結果になる(2 回目を失敗させても効かない)
//   nth:[1,3] … 3 回目(1 回目の unreadableReason)が失敗し、verdict が 'usable' に届かない
//               ので、4 回目へ進まずに「読み取りに失敗しました(EBUSY)」で確定して終わる
//   nth:[1,5] … 5 回目は 4 回目が成功すれば呼ばれないので、nth:[1] と同じ結果になる
//   nth:[1,4] … 目的の「読めたり読めなかったりします」に到達する(下のテスト)
{
  const home = sandbox('current-unreadable-twice-guard', {
    current: creds('pro', { token: 'CUR-NEW' }),
    accounts: { mypro: creds('pro', { token: 'SLOT-OLD' }) },
    slot: 'mypro',
  });
  const s = execSwapScript(SWAP, [], {
    env: {
      ...homeEnv(home),
      NODE_OPTIONS: '--require ' + path.join(__dirname, 'fault-fs.js'),
      SWAP_FAULT: JSON.stringify({
        call: 'readFileSync', match: '.credentials.json', kind: 'throw', code: 'EBUSY', nth: [1, 4],
      }),
    },
  });
  const out = s.out + s.err;
  check('2 回続けて読めないときは「いまは健全に読めています」と言わない',
    !out.includes('いまは健全に読めています'), out);
  check('代わりに「読めたり読めなかったりします」と言う',
    /読めたり読めなかったりします/.test(out), out);
}

{
  // レビュー指摘: 現在の credentials が読めない(--force で控えだけ取って先へ進む degraded
  // 経路)状態から、差し替え本体の writeAtomic(CREDENTIALS) が失敗すると、以前は控えの
  // パス(「中身の控え: <path>」)を stdout の console.log でしか出しておらず、直後の
  // process.exit がパイプ越しにそれを切ることがあった(fail が守るのは stderr だけ)。控えの
  // 場所を見失うと、読めなかった現在のログインを取り戻す手掛かりが消える。fail を
  // failText + process.exitCode + return に分け、控えのパスを stderr 側にも載せるようにした。
  // writeAtomic の rename(tmp -> CREDENTIALS)だけを狙って EPERM を注入する(tmp のパスにしか
  // 現れない `.credentials.json.tmp` で絞り込むので、keepAside の copyFileSync 等は巻き込まない)。
  const home = sandbox('writeatomic-fail-after-degraded-save', {
    current: '{ broken', // copyable(JSON としては壊れているだけ)なので --force で控えを取れる
    accounts: { team: creds('team') },
  });
  const r = execSwapScript(SWAP, ['team', '--force'], {
    env: {
      ...homeEnv(home),
      NODE_OPTIONS: '--require ' + path.join(__dirname, 'fault-fs.js'),
      SWAP_FAULT: JSON.stringify({
        call: 'renameSync', match: '.credentials.json.tmp', kind: 'throw', code: 'EPERM',
      }),
    },
  });
  check('差し替え自体は失敗する(前提)', r.code !== 0, r.out + r.err);
  check('控えの場所を stderr 側にも載せる(パイプに切られても残る)',
    /読めなかった現在の内容の控え: /.test(r.err)
    && r.err.includes(replacedDir(home)), r.err);
}

// --- 来歴(.current)が読めないときに黙って別名を作らない ---
// 生の readFileSync + catch で「無い」に倒していた頃は、権限やロックで読めないだけでも
// 「未記録」になり、subscriptionType 由来の名前へ黙って乗り換えて、同じアカウントを 2 つの
// 名前で退避した状態(README が危険だと書いている状態)を無警告で作っていた。
{
  const home = sandbox('current-slot-unreadable-warns', {
    current: creds('pro', { token: 'cur' }),
    accounts: { mypro: creds('pro', { token: 'mypro' }) },
  });
  fs.mkdirSync(slotPath(home), { recursive: true }); // .current をディレクトリにして読めなくする
  const r = runSwap(home, ['save']);
  // 「来歴」を含むかだけを見ると、書き込み側の失敗(来歴を記録できませんでした)が同じ語を
  // 含むため、読み取り側の通知を消しても緑のままになる。読み取り側の文面を名指しで見る。
  check('来歴を読めないことを黙って握り潰さない',
    (r.out + r.err).includes('来歴(.current)を読めません'), r.out + r.err);
}

// --- 書きかけのまま残ったファイルを status が知らせる ---
// writeAtomic の後始末は例外経路にしか効かないので、書き込み中にプロセスごと落ちると平文の
// トークンを含む <名前>.json.tmp が残る。一覧も控えの集計も `.json` しか見ないため、
// 知らせる場所が 1 つも無かった。
{
  const home = sandbox('partial-write-visible-in-status', {
    current: creds('pro', { token: 'cur' }),
    accounts: { mypro: creds('pro', { token: 'mypro' }) },
  });
  fs.writeFileSync(acctPath(home, 'mypro') + '.tmp', '{"claudeAiOauth":{"refreshToken":"rt', 'utf8');
  const out = (({ out: o, err }) => o + err)(runSwap(home, []));
  check('書きかけのファイルを status が知らせる', out.includes('mypro.json.tmp'), out);
  check('退避済みの一覧には混ぜない(.json ではないので)',
    !out.includes('* mypro.json.tmp'), out);
}
{
  // 上のテストは accounts/ 配下の書きかけ(savedPartial)を見ている。書きかけは現在の
  // credentials 側(切り替えの最終段である writeAtomic(CREDENTIALS))にも同じ理由で残りうるが、
  // savedPartial は accounts/ の readdir なので構造上 ~/.claude/.credentials.json.tmp を
  // 拾えない。ここを見ていないと、平文トークンを含む .tmp が accounts/ の外に残り続けても
  // status がずっと気づかない。
  const home = sandbox('current-partial-write-visible-in-status', { current: creds('pro') });
  fs.writeFileSync(credPath(home) + '.tmp', '{"claudeAiOauth":{"accessToken":"AT-LIVE","refreshTo', 'utf8');
  const out = (({ out: o, err }) => o + err)(runSwap(home, []));
  check('現在の credentials 側の書きかけファイルも status が知らせる',
    out.includes(credPath(home) + '.tmp'), out);
  check('書きかけの枠に入れて知らせる',
    out.includes('書きかけのまま残っているファイルがあります'), out);
}

// --- 現在の credentials が 2 回続けて読めないとき、復元ガードを素通りさせない ---
// cmdSwap は readCurrentForGuard() の結果 cur を 1 度だけ取り、4 つの復元ガード(同一性・
// 来歴・退避先が復元元と同じ・別アカウントだと確認できない)はすべて `cur && …` で書かれて
// いる。cur が null になると 4 つが同時に外れる。そのあと saveCurrent が
// `pre || readCredsOrNull(CREDENTIALS)` で自前に読み直しており、その 3 度目が成功すると、
// ガードを 1 つも通っていない切り替えが、退避だけ済ませて先へ進んでいた。来歴が復元元を
// 指していれば、退避はそのスロット(= 復元元)を現在のログインで上書きし、続く writeAtomic が
// 読み込み済みの旧内容をマシン全体へ書き戻す。--force は要らず、exit 0 で終わるので
// `swap team && claude -p …` のようなラッパーは成功として扱う。
// nth:[1,4] は上の status のテストと同じ「readCredsOrNull 経由の 2 回だけを落とす」指定
// (2・3・5 回目の probeFile / unreadableReason 経由は通す)。
{
  const home = sandbox('current-unreadable-twice-swap', {
    current: creds('team', { token: 'CUR-NEW' }),
    accounts: { team: creds('team', { token: 'SLOT-OLD' }) },
    slot: 'team',
  });
  const r = execSwapScript(SWAP, ['team'], {
    env: {
      ...homeEnv(home),
      NODE_OPTIONS: '--require ' + path.join(__dirname, 'fault-fs.js'),
      SWAP_FAULT: JSON.stringify({
        call: 'readFileSync', match: '.credentials.json', kind: 'throw', code: 'EBUSY', nth: [1, 4],
      }),
    },
  });
  const live = fs.readFileSync(credPath(home), 'utf8');
  const slot = fs.readFileSync(acctPath(home, 'team'), 'utf8');
  check('ガードが素通りしたまま切り替えを完了しない', r.code !== 0, r.out + r.err);
  // 巻き戻りの検査は「新しいトークンが残っている」と「古いトークンが入っていない」の両方を
  // 見る。前者だけだと、両方を書いてしまう実装(退避と差し替えの順序が入れ替わった場合)を
  // 見逃す。
  check('マシン全体の credentials を旧トークンへ巻き戻さない',
    live.includes('CUR-NEW') && !live.includes('SLOT-OLD'), live);
  check('復元元のスロットを現在のログインで上書きしない',
    slot.includes('SLOT-OLD') && !slot.includes('CUR-NEW'), slot);
}

// --- 生バイト列から拾えたトークンを refreshToken と名指ししない ---
// rawHasRecoverableToken は refreshToken と accessToken のどちらでも真になるのに、これを
// 使う 3 箇所(status の控えの集計・saveFirstText・account-guard の拒否文)はいずれも
// 「refreshToken が残っています」と断定していた。書き込みの途中で accessToken の直後に
// 切れた控えは実際にこの形になるので、そこに「交換すればまた使えます」と案内すると、
// 存在しない復旧手段を探させることになる。判定そのものは変えない(accessToken だけでも
// 失って困る中身なので、控えを消させない側に倒したまま)。
{
  const home = sandbox('raw-token-not-named-refresh', { current: creds('pro') });
  fs.mkdirSync(replacedDir(home), { recursive: true });
  fs.writeFileSync(path.join(replacedDir(home), '.unreadable-current-1.json'),
    '{"claudeAiOauth":{"accessToken":"AT-PARTIAL', 'utf8');
  const out = (({ out: o, err }) => o + err)(runSwap(home, []));
  check('控えは「消さないでください」の側に残したまま(判定は変えない)',
    out.includes('消さないでください'), out);
  check('残っていたトークンを refreshToken と名指ししない',
    !out.includes('refreshToken が残っている控え')
    && !out.includes('refreshToken は交換すれば'), out);
}

// --- 退避先に入っていた旧内容を退けたことを、その場の出力に出す ---
// writeSlot が控えを取った事実(reportReplaced)を呼び出し側が出し忘れると、上書きが
// 起きたことに気づくのは後日そのスロットを復元して別アカウントに戻ったときになる。
// cmdSave 経路。
{
  const home = sandbox('report-replaced-save', {
    current: creds('pro', { token: 'acct-B' }),
    accounts: { personal: creds('pro', { token: 'acct-A' }) },
    slot: 'personal',
  });
  const r = runSwap(home, ['save']);
  check('退避は成功する', r.code === 0, r.out + r.err);
  check('退けた旧内容をその場の出力に出す',
    r.out.includes('入っていた旧内容は控えに退けました:'), r.out);
  check('控えのパス(.replaced 配下)を出力に含める',
    r.out.includes(replacedDir(home)), r.out);
}
{
  // 同じ報告が cmdSwap の自動退避(切り替えの前に必ず通る)からも出ること。片方だけ直して
  // 食い違う事故がこのファイルで繰り返し起きているので、経路ごとに別々に確かめる。
  const home = sandbox('report-replaced-swap', {
    current: creds('pro', { token: 'acct-B' }),
    accounts: { personal: creds('pro', { token: 'acct-A' }), team: creds('team') },
    slot: 'personal',
  });
  const r = runSwap(home, ['team']);
  check('切り替えは成功する', r.code === 0, r.out + r.err);
  check('自動退避で退けた旧内容もその場の出力に出す',
    r.out.includes('入っていた旧内容は控えに退けました:'), r.out);
  check('控えのパス(.replaced 配下)を出力に含める',
    r.out.includes(replacedDir(home)), r.out);
}

// --- 未ログインの status は /login を案内する ---
// 退避が 0 件でも、理由が「未ログイン」なのか「credentials を読めない」なのかで次の一手は
// 別物になる。`swap save` だけを勧めると、案内どおり打っても「未ログイン」で止まる。
{
  const home = sandbox('status-true-first-run', {}); // credentials も退避も無い、真の初回状態
  const r = runSwap(home, []);
  check('status は成功する', r.code === 0, r.out + r.err);
  check('現在のアカウントは未ログインと表示する', /現在のアカウント: 未ログイン/.test(r.out), r.out);
  check('退避済み 0 件の案内は /login を含む', /なし。Claude Code で `\/login`/.test(r.out), r.out);
}
{
  // 未ログインのまま存在しない名前を指定した場合も同じ理由で /login を案内すること
  // (cmdSwap 側の既定文が別に持っているので、status と食い違いうる)。
  const home = sandbox('swap-nope-true-first-run', {});
  const r = runSwap(home, ['nope']);
  check('未ログインで存在しない名前を指定すると中止する', r.code === 1, r.out + r.err);
  check('エラー出力に /login を含む', r.err.includes('/login'), r.err);
}

// --- 現在ログイン中のスロットを、択一の選択肢として出さない ---
// 「退避されていません」案内は利用可能なスロットごとに実際に打てるコマンドを列挙するが、
// 現在ログイン中と同じ中身のスロットへ切り替えても no-op にしかならない。択一の選択肢として
// 出す以上、選んで前進しないものは実行コマンドから外し、/login による別アカウント追加を促す。
{
  const home = sandbox('same-slot-not-a-choice', {
    current: creds('pro', { token: 'same-tok' }),
    accounts: { pro: creds('pro', { token: 'same-tok' }) },
  });
  const r = runSwap(home, ['nope']);
  check('存在しない名前を指定すると中止する', r.code === 1, r.out + r.err);
  check('現在ログイン中の文言を出す', /現在このスロットでログイン中です/.test(r.err), r.err);
  check('pro を実際に打てるコマンドとして出さない(swap pro --force が出ない)',
    !/swap pro --force/.test(r.err), r.err);
}

// --- 来歴が読めないときの status は「未記録」と正反対の案内を出す ---
// 「未記録」(このツールをまだ使っていない)と「読めない」(ファイルはあるが開けない)は
// readCurrentSlot がどちらも null を返すので、curSlot だけを見て文面を選ぶと区別できない。
// currentSlotIsUnreadable() を見ずに書いていた頃は、読めないだけの状態で「来歴が未記録です。
// `swap save <name>` で退避すると記録されます」という、打っても直らない案内を出し、
// 一覧の `*` 印と「現在のログインと内容が違います」の判定が理由も告げずに消えていた
// (stderr には「来歴(.current)を読めません」と出ているのに、両方出すと矛盾する)。
{
  const home = sandbox('status-current-unreadable', {
    current: creds('pro', { token: 'cur' }),
    accounts: { mypro: creds('pro', { token: 'mypro' }) },
  });
  fs.mkdirSync(slotPath(home), { recursive: true }); // .current をディレクトリにして読めなくする
  const r = runSwap(home, []);
  check('status は成功する', r.code === 0, r.out + r.err);
  check('打っても直らない「来歴が未記録です」は出さない',
    !r.out.includes('来歴が未記録です'), r.out);
  check('読めないことを理由として明示する',
    r.out.includes('来歴(.current)を読めないため'), r.out);
  check('`*` 印と食い違い判定を出せていない旨の注記を、退避一覧の直後に出す',
    r.out.includes('判定は出せていません'), r.out);
}

// --- 消せなかった来歴が読めないなら「残っている」と警告しない ---
// dropCurrentSlot は unlinkSync が ENOENT 以外で失敗すると「古い来歴が残った」と扱っていたが、
// 残った実体を readCurrentSlot が読めるかどうかまでは見ていなかった。.current がまるごと
// ディレクトリだと read も unlink も EISDIR で落ちるが、残った実体は readCurrentSlot からは
// 読めない(= 来歴としては効かず、次に名前を省いた退避が誤って別アカウントのスロットを
// 上書きすることもない)。それでも「名前を省いた退避は別のアカウントのスロットを上書きします」
// と警告するのは事実に反する。来歴を記録できなかったこと自体は伝える。
{
  const home = sandbox('save-dropcurrentslot-still-unreadable', {
    current: creds('pro', { token: 'cur' }),
  });
  fs.mkdirSync(slotPath(home), { recursive: true }); // .current をディレクトリにして read も unlink も失敗させる
  const r = runSwap(home, ['save', 'mypro']);
  check('退避先への書き込み自体は済んでいる(来歴だけが書けない)',
    tokenOf(acctPath(home, 'mypro')) === 'cur', r.out + r.err);
  check('来歴を記録できなかったこと自体は伝える',
    (r.out + r.err).includes('来歴を記録できませんでした'), r.out + r.err);
  check('読めない残骸を実害があるかのように警告しない',
    !(r.out + r.err).includes('古い来歴が残ったままです'), r.out + r.err);
}

// --- 来歴だけが根拠のスロットを、証明済みのものと同じ更新一覧に混ぜない ---
// README の初回手順(swap save → 別アカウントで /login → swap save <別名>)をそのまま踏むと、
// staleSlots(refreshToken の一致で裏を取れる)は 0 件のまま、driftedProvenance(来歴だけが
// 根拠)だけが発火する。この 2 つは根拠の強さが違うので、stale 向けの見出し
// 「前者だと分かっているときだけ更新してください」は stale が 1 件も無いときに出してはならない
// (drifted しか無いのにこの見出しを出すと、来歴だけの推測を refreshToken 一致と同じ強さで
// 語ることになる)。一方で drifted 向けの更新コマンド自体は行き止まりにせず出す。
{
  const home = sandbox('driftedprovenance-only', {
    current: creds('pro', { token: 'acct-B' }),
    accounts: { pro: creds('pro', { token: 'acct-A' }) },
    slot: 'pro',
  });
  const r = runSwap(home, ['save', 'team']);
  check('退避は成功する', r.code === 0, r.out + r.err);
  check('今回の退避と内容が違うスロットとして pro を挙げる',
    r.out.includes('今回の退避と内容が違うスロットがあります: pro'), r.out);
  check('stale (refreshToken 一致) は 0 件なので、その見出しは出さない',
    !r.out.includes('前者だと分かっているときだけ更新してください'), r.out);
  check('根拠は来歴だけで、内容が古いという証明はないと明示する',
    r.out.includes('pro の根拠は来歴だけで、内容が古いという証明はありません'), r.out);
  check('中身を確かめたうえでの更新コマンド自体は出す(行き止まりにしない)',
    r.out.includes('swap save pro --force'), r.out);
}

// --- usage は名前を省いた --force の意味も説明する ---
// `swap save <name> --force` のままだと、名前を省いた場合の挙動(退避先が来歴か
// subscriptionType から自動で決まる)が一切説明されず、案内どおり名前を省いて --force を
// 付けた人が、意図しないスロットを上書きした理由を usage から読み取れなかった。
{
  const home = sandbox('usage-save-force-name-optional', {});
  const r = runSwap(home, ['help']);
  check('usage は成功する', r.code === 0, r.out + r.err);
  // 行頭からの箇条書き行だけを見る。素の includes だと、`swap <name> --force` の説明中に
  // 出てくる「それを許すのは swap save [<name>] --force だけ)」という言及にも当たってしまい、
  // 箇条書き自体を元の `swap save <name> --force` へ戻した変異を検知できない。
  check('swap save [<name>] --force の形(名前は省略可)を箇条書きとして案内する',
    /^ {2}swap save \[<name>\] --force$/m.test(r.out), r.out);
  check('名前を省いた場合に退避先が自動で決まる旨まで説明する',
    r.out.includes('名前を省くと退避先は上の規則で決まるため'), r.out);
}

// --- 予約名の照合は大小を無視する ---
// Windows と macOS のファイルシステムは大小を区別しないので、`swap save Warmup` が作るのは
// このガードが作らせまいとしている accounts/warmup.json そのもの(canonicalSlotName が大小を
// 畳む以上、以後 `swap warmup` もそれを指す)。ディスク上の綴りで照合していた頃は、予約の
// 意味がひと文字の大小で消えていた。
{
  const home = sandbox('reserved-name-warmup-mixed-case', {
    current: creds('pro', { token: 'tok' }),
  });
  const r = runSwap(home, ['save', 'Warmup']);
  check('大小違いでも予約名は新しい退避先に使わせない',
    r.code === 1 && /サブコマンドと同じ/.test(r.err), r.out + r.err);
  check('中止したのでファイルも作らない', !fs.existsSync(acctPath(home, 'Warmup')), r.err);
}
{
  // status の予告も同じ照合で見ている。ここが大小を区別していたため、大小違いで作られた
  // スロットにだけ「いずれ復元できなくなる」が出ず、予約が守ろうとしていた当のスロットが
  // 無警告のまま実装日を迎えることになっていた(そのときには復元の引数の形が消えている)。
  const home = sandbox('reserved-only-name-mixed-case', {
    current: creds('pro', { token: 'pro-tok' }),
    accounts: { Warmup: creds('team', { token: 'warmup-tok' }) },
  });
  const r = runSwap(home, []);
  check('大小違いの予約名スロットにも「いずれ復元できなくなる」を出す',
    /いずれ復元できなくなる名前の退避があります: Warmup/.test(r.out), r.out + r.err);
}

report();
