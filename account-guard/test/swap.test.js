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
  // 読めない理由が権限やシステムエラーなら「時間をおいて再実行」は永久に効かない。
  // 待てば直る話だと言い切ると、原因が権限だと気づけないまま繰り返させることになる。
  // ディレクトリを置いて EISDIR を作り、err.code が案内に出ることを見る。
  const home = sandbox('status-unreadable', {});
  fs.mkdirSync(credPath(home), { recursive: true });
  const r = runSwap(home, []);
  check('status は読めない理由に err.code を添える', /EISDIR/.test(r.out), r.out + r.err);
  check('権限で読めない場合は権限の確認を案内する', /権限/.test(r.out), r.out);
}
{
  const home = sandbox('status-empty', {});
  const r = runSwap(home, []);
  check('status はファイルが無いときだけ未ログインと言う', /未ログイン/.test(r.out), r.out + r.err);
}
{
  // JSON としては読めるのに accessToken が無い(手で編集した、別バージョンが書いた、
  // 将来の構造変更)。待っても直らないので「時間をおいて再実行」は永久に効かない案内になる。
  const home = sandbox('status-no-token', {
    current: { claudeAiOauth: { subscriptionType: 'pro' } },
    accounts: { team: creds('team') },
  });
  const s = runSwap(home, []);
  check('status は形式の問題を「書き込み中」と言わない',
    /accessToken/.test(s.out) && !/書き込み中/.test(s.out), s.out + s.err);
  const r = runSwap(home, ['team']);
  check('待っても直らない理由では再実行を案内しない', !/時間をおいて/.test(r.err), r.out + r.err);
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
  // cmdSave(degraded 案内、swap.js:790 付近): 「待てば直る」壊れ方(JSON として壊れている
  // = 書き込み途中を読んだ状態。unreadableReason が retryable: true を返す)では、中身は
  // 健全なまま数百ミリ秒後には読めることが多い。そこで /login を勧めると、まだ退避していない
  // アカウントの refreshToken をその場で消してしまうため、/login には触れず「時間をおいて」
  // やり直す案内だけを出す。
  const home = sandbox('save-degraded-retryable', { current: '{ broken' });
  const r = runSwap(home, ['save', '--force']);
  check('待てば直る壊れ方では成功終了しない', r.code !== 0, r.out + r.err);
  // 「/login はまだ試さないでください」という抑止の一文自体には /login が出るので、
  // 見るのは「/login してから」という勧める言い回しが無いことに絞る
  check('待てば直る壊れ方では /login を勧めない', !/`\/login` してから/.test(r.out + r.err), r.out + r.err);
  check('待てば直る壊れ方では /login をまだ試すなと明示する',
    /\/login はまだ試さないでください/.test(r.out + r.err), r.out + r.err);
  check('待てば直る壊れ方では時間をおいてやり直す案内を出す',
    /時間をおいて `swap save` をやり直してください/.test(r.out + r.err), r.out + r.err);
}
{
  // 対照: 待っても直らない壊れ方(JSON としては妥当だが accessToken が無い。手で編集した・
  // 将来の構造変更を想定)では retryable: false になり、従来どおり控えの中身を確認したうえで
  // /login する案内を出す。
  const home = sandbox('save-degraded-not-retryable', {
    current: { claudeAiOauth: { subscriptionType: 'pro' } },
  });
  const r = runSwap(home, ['save', '--force']);
  check('待っても直らない壊れ方では成功終了しない', r.code !== 0, r.out + r.err);
  check('待っても直らない壊れ方では /login を勧める',
    /`\/login` してから/.test(r.out + r.err), r.out + r.err);
  check('待っても直らない壊れ方では時間をおいての案内は出さない',
    !/時間をおいて/.test(r.out + r.err), r.out + r.err);
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

report();
