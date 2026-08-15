'use strict';
// swap.js の故障注入 property test。
//
// test/swap.test.js は「この経路でこの故障が起きたらこう中止する」を 1 件ずつ確かめる
// example test で、故障の組み合わせは書いた分しか検査できない。このツールで最も高い代償を
// 払う失敗は「操作の途中で失敗して、どのアカウントにもログインできなくなる」ことなので、
// 組み合わせを人手で網羅するのではなく、ランダムな操作列 × 任意の中断点を大量に振って
// 同じ不変条件を機械的に検査する側に倒す。
//
// 不変条件は 1 つだけ: 「実行前に存在した refreshToken は、実行後もどこかに残っている」。
// これが破れなければ、この実行のどこで何が失敗しても最悪でも /login のやり直しにはならない
// (=生きた資格情報を 1 本も失っていない)。破れたら本番コードは直さずそのまま報告する
// (シード・操作列・注入した故障・実行前後のファイル状態を添える。判断は人がする)。
//
// 偽 HOME を作って USERPROFILE/HOME を差し替えるので、実際の ~/.claude は読み書きしない
// (test/swap.test.js と同じやり方)。トークンはすべてダミー値で、本物には一切触れない。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeHarness } = require('./harness');
// RNG・パス規約・トークン不変条件チェックは test/reachable.test.js と共通なので
// test/sandbox.js に切り出してある(由来と設計意図は sandbox.js のコメント参照)。
const {
  DAY, makeRng, mixSeed, shuffle,
  credPath, acctPath, slotPath,
  collectTokens, listFiles,
} = require('./sandbox');
// 操作列の元になるサブコマンドの表。ここから生成する理由は pickOperation のコメント参照。
const { SUBCOMMANDS, BARE_FAULT_ARGVS, NAME_PLACEHOLDER } = require('../subcommands');

// warmup は CLAUDE_WINDOW_PING が指すスクリプトを実際に起動する。ダミーを指し忘れると
// 本物の claude-window-ping.ps1 に落ち、テストが `claude -p` を飛ばして 5 時間枠を本当に
// 消費する(取り返しがつかない)。存在を確かめられないまま子プロセスを起動しない。
const PING_STUB = path.join(__dirname, 'ping-stub.ps1');
if (!fs.existsSync(PING_STUB)) {
  throw new Error('ping スタブが見つかりません: ' + PING_STUB
    + '\n  これが無いと warmup が本物の ping スクリプトを叩く可能性があるため、実行しません');
}

// SWAP_FAULT を親プロセス(このファイル自身)の環境に残したまま require すると、
// fault-fs.js の分岐がここで発火して自分の fs まで壊しかねない。WRAPPED_CALLS を
// 読みたいだけなので、require の間だけ確実に外す(通常は元から設定されていない)。
const savedFault = process.env.SWAP_FAULT;
delete process.env.SWAP_FAULT;
const { WRAPPED_CALLS } = require('./fault-fs');
if (savedFault !== undefined) process.env.SWAP_FAULT = savedFault;

const BASE = path.join(__dirname, '.tmp', 'fault');
// SWAP_SCRIPT でテスト対象の swap.js を差し替えられるようにしておく(test/reachable.test.js と
// 同じ口。感度検証で変異版を指して FAIL が出ることを確かめるためのもので、既定は本物の swap.js)。
const SWAP = process.env.SWAP_SCRIPT ? path.resolve(process.env.SWAP_SCRIPT) : path.join(__dirname, '..', 'swap.js');
const FAULT_FS = path.join(__dirname, 'fault-fs.js');
fs.rmSync(BASE, { recursive: true, force: true });

const { check, report } = makeHarness();

// シードは固定(コマンドラインから上書きできるようにはするが、既定値は常に同じ数)。
// 同じシードなら必ず同じ操作列になることが再現性の前提なので、Math.random() は使わない。
const SEED = Number(process.env.FAULT_SEED) || 424242;
// ケース数は約 200 が目安。子プロセスを 1 ケースあたり 1〜4 回起動する重さがあるので、
// 実測して 60 秒を大きく超えるようなら FAULT_CASES で減らせるようにしておく。
const CASES = Number(process.env.FAULT_CASES) || 200;

// --- credentials の組み立て(test/swap.test.js の creds() と同じ考え方) ---
// refreshToken を呼び出し元から直接受け取る(ケース内で一意な文字列を渡させる)。
// 「失効済みの控えは pruneReplaced が意図的に消す」ため、失効させると不変条件が偽陽性になる
// (仕様の制約どおり、ここでは常に未失効にする)。
function creds(subscriptionType, refreshToken) {
  const oauth = {
    accessToken: 'a-' + refreshToken,
    refreshToken,
    refreshTokenExpiresAt: Date.now() + 30 * DAY,
  };
  if (subscriptionType) oauth.subscriptionType = subscriptionType;
  return { claudeAiOauth: oauth };
}

function pickPlan(rng) {
  if (rng() < 0.1) return null; // subscriptionType が読めない中身も薄く混ぜる
  const plans = ['pro', 'max', 'team'];
  return plans[Math.floor(rng() * plans.length)];
}

const NAME_POOL = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];

// スロット 0〜3 個・現在の credentials 有無・来歴(.current)有無をランダムに選ぶ。
// トークンはケース番号 i を埋め込んで、他のケースと衝突しない一意な文字列にする
// (ケースごとに別の偽 HOME を使うので実害は無いが、FAIL 時に「どのケースのどの中身か」を
// トークン文字列だけで追えるようにするため)。
function buildInitialState(rng, i) {
  const pool = shuffle(rng, NAME_POOL.slice());
  const nSlots = Math.floor(rng() * 4); // 0..3
  const slotNames = pool.slice(0, nSlots);
  const accounts = {};
  for (const name of slotNames) accounts[name] = creds(pickPlan(rng), `t${i}-slot-${name}`);
  const current = rng() < 0.7 ? creds(pickPlan(rng), `t${i}-current`) : undefined;
  let slot;
  if (rng() < 0.6) {
    // 来歴が指す先は、既存スロットのことも、どこも指していない(手違い・旧版の名残)こともある
    slot = (slotNames.length && rng() < 0.7)
      ? slotNames[Math.floor(rng() * slotNames.length)]
      : 'ghost';
  }
  return { accounts, current, slot };
}

function writeSandbox(home, { current, accounts, slot }) {
  fs.mkdirSync(path.join(home, '.claude', 'accounts'), { recursive: true });
  if (current !== undefined) fs.writeFileSync(credPath(home), JSON.stringify(current), 'utf8');
  for (const [n, v] of Object.entries(accounts)) fs.writeFileSync(acctPath(home, n), JSON.stringify(v), 'utf8');
  if (slot !== undefined) fs.writeFileSync(slotPath(home), slot + '\n', 'utf8');
}

// --- 操作列 ---
// 操作列はサブコマンドの表(../subcommands.js)から作る。6 パターンを直書きしていた頃は、
// 新しいサブコマンドを足しても操作列には入らず、故障注入の守備範囲から静かに漏れていた
// (warmup のように keepAside と .current を触るコマンドが漏れると、この property test が
//  守っている不変条件そのものが検査されないまま緑になる)。表から作れば、subcommands.js へ
// 1 行足すだけで自動的にここへ入る。
const OPERATIONS = [
  ...BARE_FAULT_ARGVS,
  ...SUBCOMMANDS.flatMap(s => s.faultArgvs),
];
function pickOperation(rng) {
  const name = NAME_POOL[Math.floor(rng() * NAME_POOL.length)];
  const argv = OPERATIONS[Math.floor(rng() * OPERATIONS.length)]
    .map(a => (a === NAME_PLACEHOLDER ? name : a));
  return { label: ['swap', ...argv].join(' '), argv };
}

// --- 故障注入 ---
const FAULT_CODES = ['EPERM', 'EACCES', 'EBUSY', 'ENOSPC', 'EIO', 'ENOTDIR', 'EEXIST', 'ENOENT'];
function randomFault(rng) {
  if (rng() < 0.5) return null; // 半分程度は故障なしで実行し、正常経路も操作列に混ぜる
  const kind = ['throw', 'kill', 'truncate'][Math.floor(rng() * 3)];
  // truncate が完全に定義されているのは writeFileSync だけ(fault-fs.js 参照)。他の call を
  // 選ぶと truncate の意図(切り詰めて書く)を再現できないので、call ごと固定する。
  const call = kind === 'truncate'
    ? 'writeFileSync'
    : WRAPPED_CALLS[Math.floor(rng() * WRAPPED_CALLS.length)];
  const nth = 1 + Math.floor(rng() * 6);
  const fault = { kind, call, nth };
  if (kind === 'throw') fault.code = FAULT_CODES[Math.floor(rng() * FAULT_CODES.length)];
  return fault;
}

// --- 子プロセスの起動 ---
// NODE_OPTIONS で fault-fs.js を先読みさせる。SWAP_FAULT を設定しない実行では fault-fs.js は
// 何も差し替えない(素通し)ので、この NODE_OPTIONS は「故障なし」のケースでも常に付けてよい
// (毎回付け外しする条件分岐を増やすと、条件を間違えたときに故障が静かに注入されなくなる
// 事故のほうが起きやすい)。
function runSwap(home, argv, fault) {
  const env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    NO_COLOR: '1',
    NODE_OPTIONS: '--require ' + FAULT_FS,
    // warmup の ping を必ずダミーへ向ける(PING_STUB のコメント参照)。子が起動する孫の
    // swap プロセスにもそのまま継承される。
    CLAUDE_WINDOW_PING: PING_STUB,
  };
  // 呼ばれた回数を数える必要はない(この test の不変条件はトークンの残存だけ)ので、
  // PING_LOG は設定しない。スタブは何も書かずに終わる。
  delete env.PING_LOG;
  delete env.PING_EXIT;
  if (fault) env.SWAP_FAULT = JSON.stringify(fault);
  else delete env.SWAP_FAULT;
  // execFileSync は stdio を pipe で開くので、swap.js が stdin を読まなくても子は親の
  // TTY を継承しない。timeout は issue #8(原因未解明のハング)の検出網。
  const opts = { encoding: 'utf8', env, timeout: 30000, killSignal: 'SIGKILL' };
  try {
    const out = execFileSync(process.execPath, [SWAP, ...argv], opts);
    return { code: 0, out, err: '' };
  } catch (e) {
    // 終了ステータスが無いまま死んだ場合(e.status が null / undefined)は、呼び出し側の
    // 「非ゼロ終了 = 想定どおり失敗した」という判定に混ぜてはいけない。timeout(ETIMEDOUT)
    // のほかに maxBuffer 超過(ENOBUFS)・外部や OOM による kill も同じ形で来るので、
    // code ではなく status の有無で判別する。ここで 1 や -1 に潰すと基盤の異常が
    // PASS として集計される。
    if (e.status == null) {
      const why = e.code === 'ETIMEDOUT'
        ? `timeout(${opts.timeout}ms)で強制終了された`
        : `終了コードを残さずに落ちた(code=${e.code || '不明'} signal=${e.signal || 'なし'})`;
      // stderr は末尾 3 行だけ添える(全部出すと ENOBUFS で ~1MB がログに流れる)。
      // cause で stdout を含む元の例外を残す(issue #8 の原因究明の材料にするため)。
      const tail = (e.stderr || '').trim().split('\n').slice(-3).join('\n');
      const msg = `子プロセスが${why}: ${SWAP} ${argv.join(' ')}`;
      throw new Error(tail ? `${msg}\n  stderr(末尾): ${tail}` : msg, { cause: e });
    }
    return { code: e.status, out: e.stdout || '', err: e.stderr || '' };
  }
}

console.log(`fault.test.js: seed=${SEED} cases=${CASES}`);
const startedAt = Date.now();

for (let i = 0; i < CASES; i++) {
  const caseSeed = mixSeed(SEED, i);
  const rng = makeRng(caseSeed);
  const home = path.join(BASE, 'case-' + i);
  fs.rmSync(home, { recursive: true, force: true });

  const init = buildInitialState(rng, i);
  writeSandbox(home, init);

  const before = collectTokens(home);
  const beforeFiles = listFiles(home);

  const nOps = 1 + Math.floor(rng() * 4); // 1..4
  const trace = [];
  for (let k = 0; k < nOps; k++) {
    const op = pickOperation(rng);
    const fault = randomFault(rng);
    const r = runSwap(home, op.argv, fault);
    trace.push({ op: op.label, fault, code: r.code });
  }

  const after = collectTokens(home);
  const missing = [...before].filter((t) => !after.has(t));

  check(`case ${i} (seed=${caseSeed}): 実行前の refreshToken がすべて残っている`, missing.length === 0,
    missing.length ? [
      '失われたトークン: ' + missing.join(', '),
      'seed=' + SEED + ' case=' + i + ' caseSeed=' + caseSeed,
      '初期状態: ' + JSON.stringify(init),
      '操作列: ' + JSON.stringify(trace),
      '実行前のファイル一覧:',
      ...beforeFiles.map((l) => '  ' + l),
      '実行後のファイル一覧:',
      ...listFiles(home).map((l) => '  ' + l),
    ].join('\n      ') : '');
}

console.log(`  (${CASES} ケース, ${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);

// --- WRAPPED_CALLS が実装側の fs 呼び出しからドリフトしていないこと ---
// WRAPPED_CALLS は「実装側が呼ぶ fs の同期 API のうち、故障を注入する意味があるもの」の
// 一覧。ここが実装からずれると、注入したいはずの経路が誰にも気づかれないまま故障注入の
// 対象から抜け落ちる(実際に chmodSync が一覧から抜けていて、しかも「一覧は網羅している」と
// いうコメントが付いていたため、writeAtomic の chmod 失敗経路が長期間検査対象から漏れていた)。
// 実装側 3 ファイルのソースから `fs.<name>Sync(` の呼び出し名をすべて拾い、WRAPPED_CALLS か
// 意図的な除外リスト(fault-fs.js の WRAPPED_CALLS 直上のコメント参照)のどちらかに
// 含まれることを確かめる。どちらにも無ければ、新しく増えた fs 呼び出しの故障注入を
// 検討しないまま見落としている、ということ。
{
  const IMPL_FILES = [
    path.join(__dirname, '..', 'swap.js'),
    path.join(__dirname, '..', 'credentials.js'),
    path.join(__dirname, '..', 'account-guard.js'),
    // fs をまったく呼ばない純データのモジュールだが、一覧から外すと「呼ぶようになった日」に
    // 誰も気づけない。この検査が守っているのは網羅であって、いま何件当たるかではない。
    path.join(__dirname, '..', 'subcommands.js'),
  ];
  // 意図的な除外はファイル単位で持つ。ファイルを問わない 1 つの集合にしていた頃は、ある
  // ファイルのために書いた除外が全ファイルに効いてしまい、たとえば swap.js の書き込み経路に
  // fs.existsSync が入っても検査が素通りした。それは probeFile 規則が防いでいる「読めない
  // だけのファイルを『無い』に倒し、控えを取らないまま上書きする」経路そのもので、
  // chmodSync を見落としたのとまったく同じ形の穴になる。
  const INTENTIONAL_EXCLUSIONS = new Map([
    // writeSync … failText が stderr(fd 2)へ直接書くためだけに使う。ここを失敗させると、
    //              注入した故障そのものの説明が画面から消えて、何を確かめたのか読めなくなる。
    // readSync  … warmup の確認プロンプトが端末(fd 0)から答えを読むためだけに使う。この
    //              test は子プロセスを execFileSync の pipe で起動する = stdin が端末では
    //              ないので、操作列の warmup は必ず --yes 付きで走り、この経路自体を通らない
    //              (通らない呼び出しに故障を注入しても、現実には起きない状態を作るだけ)。
    ['swap.js', new Set(['writeSync', 'readSync'])],
    // status の表示にだけ使うフォールバック。内部で例外を握りつぶす API なので、throw を
    // 注入しても現実には起きない状態を作ることになる。
    ['account-guard.js', new Set(['existsSync'])],
    // credentials.js は existsSync を呼んでいない。probeFile の説明コメントが「fs.existsSync を
    // 使わない」理由を書いており、その文字列を下の正規表現が拾うだけ。コメントを削ってから
    // 拾う手もあるが、削りすぎれば本物の呼び出しを見逃す(危険側に倒れる)ので、拾いすぎた
    // ぶんをこうして名指しで除外する。
    ['credentials.js', new Set(['existsSync'])],
  ]);
  const CALL_RE = /fs\.(\w+Sync)\(/g;
  const wrapped = new Set(WRAPPED_CALLS);
  // どのファイルの何が漏れたかまで出す。名前だけを挙げていた頃は、除外がファイル単位に
  // なっていない以上どのみち区別できなかったが、分けた今は「swap.js の existsSync」と
  // 「account-guard.js の existsSync」が別物として報告されなければ意味がない。
  const drifted = [];
  for (const file of IMPL_FILES) {
    const base = path.basename(file);
    const allowed = INTENTIONAL_EXCLUSIONS.get(base) || new Set();
    const src = fs.readFileSync(file, 'utf8');
    let m;
    CALL_RE.lastIndex = 0;
    while ((m = CALL_RE.exec(src))) {
      if (!wrapped.has(m[1]) && !allowed.has(m[1])) drifted.push(base + ': ' + m[1]);
    }
  }
  check('実装側の fs.*Sync 呼び出しは WRAPPED_CALLS か、そのファイルの除外に含まれる',
    drifted.length === 0,
    'WRAPPED_CALLS に無く、そのファイルの除外にも無い呼び出し: ' + [...new Set(drifted)].join(', '));
}

report();
