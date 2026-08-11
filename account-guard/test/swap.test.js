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

const BASE = path.join(__dirname, '.tmp', 'swap');
const SWAP = path.join(__dirname, '..', 'swap.js');
fs.rmSync(BASE, { recursive: true, force: true });

const DAY = 86400000;
const state = { pass: 0, fail: 0 };

// extra は失敗時の手掛かり。落ちた行だけでは原因が分からないことが多いので実出力を添える
function check(label, cond, extra) {
  if (cond) state.pass++; else state.fail++;
  const tail = extra && !cond ? `\n      ${String(extra).replace(/\n/g, '\n      ')}` : '';
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}${tail}`);
}

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

// 非ゼロ終了でも中止の理由を確かめたいので、例外から stdout / stderr を拾って返す
function runSwap(home, argv = []) {
  const env = { ...process.env, USERPROFILE: home, HOME: home, NO_COLOR: '1' };
  try {
    const out = execFileSync(process.execPath, [SWAP, ...argv], { env, encoding: 'utf8' });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: e.stdout || '', err: e.stderr || '' };
  }
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
  check('来歴が指すスロットへの切り替えは認証を変えない',
    r.code === 0 && /認証は変更しませんでした/.test(r.out), r.out + r.err);
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
  check('古いまま残るスロットは名前を挙げて知らせる',
    /古いままの退避があります: personal/.test(r.out), r.out);
  check('更新する手順と、触ってはいけない場合の両方を出す',
    /swap save personal --force/.test(r.out) && /別のアカウントなら触らないで/.test(r.out), r.out);
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
  check('巻き添えを避けたぶん、古いまま残ることは知らせる',
    /古いままの退避があります: work/.test(r.out), r.out);
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
  check('切り替え時も古いまま残るスロットを知らせる',
    /古いままの退避があります: personal/.test(r.out), r.out);
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
  check('新しい名前への退避でも、古くなる来歴スロットを知らせる',
    r.code === 0 && /古いままの退避があります: personal/.test(r.out), r.out + r.err);
  check('知らせるだけで、書き換えはしない', tokenOf(acctPath(home, 'personal')) === 'tok-old');
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
  // 控えを無制限には残さない(平文トークンなので)。上限を超えた分だけ落ちること、
  // 落ちるのが古い方で、最後に退けた控えは必ず残ることを見る。
  const home = sandbox('keepaside-limit', {
    current: creds('pro', { token: 'gen1' }),
    accounts: { personal: creds('pro', { token: 'old1' }) },
  });
  for (const t of ['gen2', 'gen3', 'gen4']) {
    fs.writeFileSync(credPath(home), JSON.stringify(creds('pro', { token: t })), 'utf8');
    runSwap(home, ['save', 'personal', '--force']);
  }
  check('控えは上限(2 本)までに保つ', replacedFiles(home, 'personal').length === 2,
    replacedFiles(home, 'personal').join(','));
  check('直前に退けた控えは残っている',
    fs.existsSync(path.join(replacedDir(home), 'personal-3.json'))
    && tokenOf(path.join(replacedDir(home), 'personal-3.json')) === 'gen3',
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
  check('読めない控えは別項目で出す', /読めなかった credentials の控え: 1 件/.test(r.out), r.out);
  check('復元に使えないことを伝える', /復元には使えません/.test(r.out), r.out);
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
  let r;
  try {
    r = { code: 0, out: execFileSync(process.execPath, [path.join(dir, 'swap.js')], {
      env: { ...process.env, USERPROFILE: dir, HOME: dir, NO_COLOR: '1' }, encoding: 'utf8' }), err: '' };
  } catch (e) {
    r = { code: e.status ?? 1, out: e.stdout || '', err: e.stderr || '' };
  }
  check('credentials.js が無いときは真因と置き場所を示して止まる',
    r.code === 1 && /credentials\.js/.test(r.err) && /同じディレクトリ/.test(r.err), r.out + r.err);
  check('スタックトレースを投げっぱなしにしない', !/ {4}at /.test(r.err), r.err);
}

console.log(`\n  ${state.pass} PASS / ${state.fail} FAIL`);
process.exit(state.fail ? 1 : 0);
