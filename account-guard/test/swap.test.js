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
function creds(subscriptionType, { token, expiresInDays = 30 } = {}) {
  const t = token || 'tok-' + (subscriptionType || 'none');
  const oauth = {
    accessToken: t,
    refreshToken: 'refresh-' + t,
    refreshTokenExpiresAt: Date.now() + expiresInDays * DAY,
  };
  if (subscriptionType) oauth.subscriptionType = subscriptionType;
  return { claudeAiOauth: oauth };
}

const credPath = (home) => path.join(home, '.claude', '.credentials.json');
const acctPath = (home, name) => path.join(home, '.claude', 'accounts', name + '.json');
const slotPath = (home) => path.join(home, '.claude', 'accounts', '.current');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const typeOf = (p) => readJson(p).claudeAiOauth.subscriptionType;
const tokenOf = (p) => readJson(p).claudeAiOauth.accessToken;
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
  const home = sandbox('broken-current-force', {
    current: '{ broken',
    accounts: { team: creds('team') },
  });
  const r = runSwap(home, ['team', '--force']);
  check('--force なら読めない credentials でも退避してから切り替えられる', r.code === 0, r.out + r.err);
  check('読めない中身は捨てずに退避する',
    fs.existsSync(acctPath(home, 'broken'))
    && fs.readFileSync(acctPath(home, 'broken'), 'utf8') === '{ broken');
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
  check('来歴が指すスロットへの切り替えは何もしない', /何もしません/.test(r.out), r.out + r.err);
  check('現在のログインを古いスナップショットに戻さない',
    tokenOf(credPath(home)) === 'pro-new');
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
  const second = runSwap(home, ['team']);
  check('一度退避すれば来歴が効いて切り替えが通る(行き止まりにしない)',
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
  const home = sandbox('status-empty', {});
  const r = runSwap(home, []);
  check('status はファイルが無いときだけ未ログインと言う', /未ログイン/.test(r.out), r.out + r.err);
}
{
  const home = sandbox('bad-name', { current: creds('pro') });
  const r = runSwap(home, ['../evil']);
  check('パス区切りを含む名前は拒否する(ファイル名になるため)', r.code === 1, r.out + r.err);
}

console.log(`\n  ${state.pass} PASS / ${state.fail} FAIL`);
process.exit(state.fail ? 1 : 0);
