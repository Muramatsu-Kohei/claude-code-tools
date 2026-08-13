'use strict';
// swap.js の「案内の到達可能性」property test。
//
// swap.js は危険な操作を中止するとき、必ず「次に打つべきコマンド」を画面に案内する設計に
// なっている。このツールで繰り返し起きてきた事故は、その案内どおりに打つと、また別の
// ガードで止まる(行き止まり)というもの。案内の文面を変えるたびに人手で経路を追い直すのは
// 限界なので、機械で検査する:
//   1. 中止に当たりやすい初期状態をシード固定の乱数で大量に作る
//   2. 当初の要求(`swap <name>` か `swap save [<name>]`)を 1 回実行する
//   3. その出力を「選択肢」の集合として読む(下記)。各選択肢を、当初の要求の直後の状態を
//      複製した独立のサンドボックスの上で実行する(深さ2まで)
//   4. 抽出したすべての選択肢が、それぞれ最後まで exit 0 で通ることを確かめる(1つでも
//      その手順の途中で止まれば FAIL)。通った選択肢については、状態が実際に前進したことも確かめる
//   5. あわせて fault.test.js と同じ資格情報保全の不変条件(実行前の refreshToken は
//      実行後もどこかに残っている)も見る
//
// 「選択肢」という単位にしているのは、swap.js の案内の多くが「順に打つ手順」ではなく
// 「択一の選択肢」として書かれているため(例: 「何も壊さずに退避するなら: swap save <別名>」と
// 「上書きするなら: swap save X --force」は同じ状況に対する2つの選べる対処であって、両方を
// 順に打つ手順ではない)。かつてはこれを区別せず「`swap ` で始まる行を上から全部順に実行する」
// 設計にしていたが、それだと前の選択肢の副作用(たとえば自動で選ばれた退避先が、たまたま
// あとの選択肢が対象にしているスロットそのものだった)が、あとの選択肢の前提を壊してしまい、
// 「案内が正しいのに、テストの実行順序のせいで壊れて見える」偽陽性を生んでいた
// (2026-08-13 の検証で判明。過去の版で drift 分岐がまさにこれで壊れていた)。選択肢どうしを
// 独立したサンドボックスの複製の上で試すことで、この偽陽性を除く。
//
// サンドボックスの作り方・子プロセス起動・シード固定 PRNG・harness.js の使い方は
// test/fault.test.js をそのまま踏襲する(このファイル固有のやり方は発明しない)。
// RNG・パス規約・トークン不変条件チェックは test/sandbox.js に共通化してあるものを使う。
//
// FAIL が見つかっても、このテストは本番コードを直さない。再現に要る情報(シード・初期状態・
// 当初の操作・選択肢・止まったコマンド)を添えて報告するところまでが役目で、直すかどうかの
// 判断は人に返す(fault.test.js と同じ方針)。
//
// --- 検査1の基準を「少なくとも1つ」ではなく「すべて」にしている理由(2026-08-13) ---
// 一時期「選択肢のうち少なくとも1つが通ればPASS」という基準を試したことがある。独立サンドボックス化
// (上記)で選択肢どうしの副作用の干渉は解消できたが、それでも変異検証(restoreCmd から --force を
// 落とす/saveFirstText の <name> を落とす)で2つとも検出できなかった: swap.js は同じ状況に対して
// 常に複数の代替経路を用意しており、「1つでも通ればよい」だと、変異で壊れていない側の冗長な代替
// 経路が常に検査を素通りさせてしまい、個別の選択肢が壊れていても何も検出できなかった
// (実測: 260ケースで両方とも FAIL 0 件)。
//
// 案内された選択肢は、独立サンドボックス化で副作用の干渉が無くなった以上、1つ残らずその主張どおりに
// 機能すべきで、効かない選択肢が混じっていること自体が「案内どおり打つと止まる」= このツールで
// 繰り返し起きた事故そのもの、という判断で「すべて通ること」に変更した。この基準に変えたところ、
// 2つの変異はどちらも検出できるようになった(実測: 変異A で 9 件、変異B で 1 件、無改変からの
// 新規 FAIL が増えた)。無改変でも 11 件の FAIL が残った: いずれも cmdSwap の「退避されていません」
// 案内(`swap <名前>` / `swap save` とだけ言い切る経路)が、提示した名前の状態(失効・
// subscriptionType 欠け・同一プラン・来歴とのずれ)や現在のログインの状態(名前未決定・
// credentials 破損)を考慮していないために起きる、同じ型の指摘。本番コードは直していない
// (判断は人に委ねる)。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeHarness } = require('./harness');
const {
  DAY, makeRng, mixSeed, shuffle,
  credPath, acctPath, slotPath, replacedDir,
  collectTokens, listFiles,
} = require('./sandbox');

const BASE = path.join(__dirname, '.tmp', 'reachable');
// SWAP_SCRIPT でテスト対象の swap.js を差し替えられるようにしておく。目的はこのテスト自身の
// 感度検証: swap.js を 1 箇所だけ壊した変異版を test/.tmp/ 配下(git 管理外)に作り、それを
// 指して実行すれば FAIL が出るはずで、出なければ抽出ルールや初期状態の偏りが甘く、このテストが
// 空回りしている証拠になる。既定値は本物の swap.js なので、この口があっても通常の実行は変わらない。
const SWAP = process.env.SWAP_SCRIPT ? path.resolve(process.env.SWAP_SCRIPT) : path.join(__dirname, '..', 'swap.js');
fs.rmSync(BASE, { recursive: true, force: true });

const { check, report } = makeHarness();

// シードは固定(fault.test.js と同じ考え方: 環境変数で上書きできるが既定値は常に同じ数)。
const SEED = Number(process.env.REACHABLE_SEED) || 271828;
// 感度検証(変異版 swap.js で FAIL が出るか)の結果、130 ケースでは的が絞られた分岐
// (同一プランで別アカウント未確認・来歴どおりだが中身がずれている drift 分岐)を
// 一度も踏めないことがあった。初期状態の偏りを強めた(pickSlotDefect・buildInitialState・
// pickInitialOp 参照)うえでケース数も増やし、60 秒程度まで許容して的中率を上げる。
// 60 秒を大きく超えるようなら REACHABLE_CASES で減らせる。
const CASES = Number(process.env.REACHABLE_CASES) || 260;

const NAME_POOL = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
const PLANS = ['pro', 'max', 'team'];

// --- credentials の組み立て ---
// fault.test.js の creds() は「失効させると pruneReplaced に消される」ため常に未失効・
// フル装備にしていたが、このテストは逆に「中止経路に当たりやすい状態」を意図的に混ぜたいので、
// 失効・refreshToken 欠け・subscriptionType 欠けを個別に選べるようにしてある。
function creds(subscriptionType, refreshToken, opts = {}) {
  const oauth = {};
  if (!opts.noAccessToken) oauth.accessToken = 'a-' + refreshToken;
  if (!opts.noRefreshToken) oauth.refreshToken = refreshToken;
  oauth.refreshTokenExpiresAt = Date.now() + (opts.expired ? -1 : 30) * DAY;
  if (subscriptionType) oauth.subscriptionType = subscriptionType;
  return { claudeAiOauth: oauth };
}

function pickPlan(rng) {
  if (rng() < 0.1) return null; // subscriptionType が読めない中身も薄く混ぜる
  return PLANS[Math.floor(rng() * PLANS.length)];
}

// スロットに混ぜる「壊し方」。ok 以外はどれも cmdSwap の復元前ガード(失効・refreshToken 欠け・
// subscriptionType 欠け・同一プランで別アカウントと確認できない)のどれかに直撃させるための
// 意図的な偏り(仕様が名指ししている 4 種類)。感度検証(変異版で FAIL が出るか)で分かったとおり、
// 「別のアカウントだと確認できません」の経路(同一プラン)は的が絞られている実際の分岐なので、
// samePlan の比率を他より高くしてある(cmdSwap の !planned 分岐・saveFirstText の needsName 分岐
// のどちらも、この経路を通らないと踏みにくい)。
function pickSlotDefect(rng) {
  const r = rng();
  if (r < 0.35) return 'ok';
  if (r < 0.47) return 'expired';
  if (r < 0.59) return 'noRefreshToken';
  if (r < 0.71) return 'noSubscriptionType';
  return 'samePlan';
}

function buildSlotCreds(rng, i, name, currentPlan) {
  const token = `t${i}-slot-${name}`;
  switch (pickSlotDefect(rng)) {
    case 'expired': return creds(pickPlan(rng) || 'pro', token, { expired: true });
    case 'noRefreshToken': return creds(pickPlan(rng) || 'pro', token, { noRefreshToken: true });
    case 'noSubscriptionType': return creds(null, token);
    // 「現在のログインと同じプラン種別」= planDiffers が偽になり、別アカウントだと
    // 証明できない経路(cmdSwap の !planned 分岐)を狙って踏む。
    case 'samePlan': return creds(currentPlan || pickPlan(rng) || 'pro', token);
    default: return creds(pickPlan(rng), token);
  }
}

// 現在ログイン中の credentials は「無い / JSON として壊れている / 普通に読める」の3通りを混ぜる。
// 壊れている場合は writeSandbox がここで作った文字列をそのまま書く(JSON.stringify しない)。
function buildCurrent(rng, i) {
  const r = rng();
  if (r < 0.12) return { kind: 'absent' };
  if (r < 0.22) return { kind: 'corrupt', raw: '{"claudeAiOauth":{"accessTok' + i };
  const plan = pickPlan(rng);
  return { kind: 'ok', plan, creds: creds(plan, `t${i}-current`) };
}

// スロット 0〜3 個・現在の credentials・来歴(.current)をランダムに選ぶ。トークンはケース番号 i
// を埋め込んで、他のケースと衝突しない一意な文字列にする(fault.test.js と同じ考え方)。
function buildInitialState(rng, i) {
  const pool = shuffle(rng, NAME_POOL.slice());
  const nSlots = Math.floor(rng() * 4); // 0..3
  const slotNames = pool.slice(0, nSlots);
  const current = buildCurrent(rng, i);
  const currentPlan = current.kind === 'ok' ? current.plan : null;
  const accounts = {};
  for (const name of slotNames) accounts[name] = buildSlotCreds(rng, i, name, currentPlan);

  // .current(来歴)。実体とずれている(存在しないスロットを指す、または現在の中身と食い違う)
  // ことも、記録が無いこともある。感度検証で分かったとおり、来歴が実在するスロットを指す比率を
  // 上げておかないと、cmdSwap の「来歴どおりだが中身がずれている」分岐(drift・同名分岐。
  // restoreCmd の --force 有無がここでしか露出しない)がほとんど踏まれない。
  let slot;
  if (rng() < 0.8) {
    slot = (slotNames.length && rng() < 0.75)
      ? slotNames[Math.floor(rng() * slotNames.length)]
      : 'ghost';
  }
  return { current, accounts, slotNames, slot };
}

function writeSandbox(home, state) {
  fs.mkdirSync(path.join(home, '.claude', 'accounts'), { recursive: true });
  if (state.current.kind === 'ok') {
    fs.writeFileSync(credPath(home), JSON.stringify(state.current.creds), 'utf8');
  } else if (state.current.kind === 'corrupt') {
    fs.writeFileSync(credPath(home), state.current.raw, 'utf8');
  } // 'absent' なら何も書かない(=未ログイン)
  for (const [n, v] of Object.entries(state.accounts)) {
    fs.writeFileSync(acctPath(home, n), JSON.stringify(v), 'utf8');
  }
  if (state.slot !== undefined) fs.writeFileSync(slotPath(home), state.slot + '\n', 'utf8');
}

// --- 当初の要求 ---
// 仕様どおり `swap <name>` か `swap save [<name>]` の 1 つだけ(bare の status 表示や --force は
// 当初の要求には含めない)。target/name は既存スロットを選ぶ比率を高くしておく。存在しない
// スロットを指すだけの「退避されていません」系の中止は案内が薄く(バッククォート付きの
// 言及しか出ない)、このテストが焦点を当てたい「案内どおり打つとまた止まる」の対象に
// なりにくいため。
// 復元側(`swap <name>`)では、来歴(.current)が指す名前をときどき狙って選ぶ。cmdSwap の
// 「来歴どおりだが中身がずれている」分岐(drift・同名分岐)は、CLI に渡す target が実際に
// 来歴と一致しないと踏めない(感度検証で判明。restoreCmd の --force 有無はここでしか露出しない)。
function pickInitialOp(rng, state, i) {
  const slotNames = state.slotNames;
  if (rng() < 0.5) {
    if (rng() < 0.4) return { label: 'swap save', argv: ['save'] };
    const name = (slotNames.length && rng() < 0.6)
      ? slotNames[Math.floor(rng() * slotNames.length)]
      : `init${i}`;
    return { label: `swap save ${name}`, argv: ['save', name] };
  }
  let name;
  if (slotNames.length && state.slot && slotNames.includes(state.slot) && rng() < 0.5) {
    name = state.slot;
  } else if (slotNames.length && rng() < 0.9) {
    name = slotNames[Math.floor(rng() * slotNames.length)];
  } else {
    name = `nosuch${i}`;
  }
  return { label: `swap ${name}`, argv: [name] };
}

// --- 子プロセスの起動(fault.test.js と同じ形。故障注入はしない) ---
function runSwap(home, argv) {
  const env = { ...process.env, USERPROFILE: home, HOME: home, NO_COLOR: '1' };
  try {
    const out = execFileSync(process.execPath, [SWAP, ...argv], { encoding: 'utf8', env });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: e.stdout || '', err: e.stderr || '' };
  }
}

// --- 案内コマンドの抽出(1行の中から) ---
// 3つの形を拾う。
//   1. 行頭形     … "    swap save NAME --force"(行そのものが案内)
//   2. バッククォート埋め込み形 … "もう一度 `swap save` を実行してください"
//   3. コロン埋め込み形 … "承知のうえで復元するなら: swap alpha --force"(コロンのあと
//      行末までをコマンドとみなし、末尾の句読点・閉じ括弧は落とす)
// 感度検証で、1だけでは大半(46箇所)のバッククォート埋め込み形を、1+2だけでも一部の
// コロン埋め込み形(「〜なら: swap X --force」)を取りこぼすことが分かったため3つとも拾う。
// `/login` の除外は行単位で維持する(文中の別の言及だけを見て判定すると、「そのアカウントで
// /login し直してから `swap save target --force` で入れ直してください」のような、/login を
// 済ませて初めて意味を持つ案内まで拾ってしまう)。
const BACKTICK_RE = /`([^`]+)`/g;
const COLON_TAIL_RE = /[:：]\s*(swap\b.*)$/;
const TRAILING_PUNCT_RE = /[。、,.;:)）」』!?!?]+$/u;
function candidatesInLine(raw) {
  if (raw.includes('/login')) return []; // ブラウザでの再ログインが前提の行は丸ごと除外
  const line = raw.trim();
  const cmds = new Set();
  if (line.startsWith('swap ')) cmds.add(line); // ルール1
  BACKTICK_RE.lastIndex = 0;
  let m;
  while ((m = BACKTICK_RE.exec(raw))) {
    const c = m[1].trim();
    if (c.startsWith('swap ')) cmds.add(c); // ルール2
  }
  const cm = COLON_TAIL_RE.exec(line);
  if (cm) {
    const tail = cm[1].trim().replace(TRAILING_PUNCT_RE, '').trim();
    if (tail.startsWith('swap ')) cmds.add(tail); // ルール3
  }
  return [...cmds];
}

// --- 出力を「選択肢」の塊に分ける ---
// コマンドを含む行が連続する塊を1つの選択肢とする。塊の中に複数のコマンドがあれば、それは
// 「順に打つ手順」(例: 先に別名へ退避してから復元する2手セット)なので順に実行する。塊と塊の
// 間に説明文(コマンドを含まない行)が挟まれていれば、別々の選択肢として扱う(例: 「何も壊さず
// 退避するなら」と「上書きするなら」は同じ状況への2つの選べる対処であって、手順ではない)。
function extractChoiceBlocks(output) {
  const blocks = [];
  let current = null;
  for (const raw of output.split('\n')) {
    const cmds = candidatesInLine(raw);
    if (cmds.length) {
      if (!current) { current = []; blocks.push(current); }
      current.push(...cmds);
    } else {
      current = null; // 空行・説明文で区切る
    }
  }
  return blocks;
}

// cmdSwap の「退避されていません」案内(target が無いとき)は、savedAccounts() が非空なら
// 「利用可能: a, b, c」を添えたうえで `swap <名前>` を勧める(swap.js:1373〜1376)。この
// `<名前>` は <name>/<別名> と違って「新しい名前」ではなく「一覧の中の名前」を指す
// (「この中の名前で」という文言どおり)。ほかの2つと同じ規則で機械的に空きスロット名へ
// 置き換えると、案内の意図と違う(実在しない)名前を作ってしまい、案内自体は成立するのに
// 偽陽性の FAIL を生む(バッククォート抽出を足したことで実際にこの誤検出が出た)。出力中に
// 「利用可能: ...」があれば、そこから実在する名前を拾って使う。
function availableNamesFrom(output) {
  const m = /利用可能: ([^\n]+)/.exec(output);
  if (!m) return null;
  const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  return names.length ? names : null;
}

// <name> / <別名> / <名前> を置き換える。<名前> が「一覧の中の名前」を指す文脈(上記)では
// そちらを優先し、それ以外(<name> / <別名>、および一覧が見つからない <名前>)は、その時点で
// 存在しない一意なスロット名に置き換える。呼び出しごとに前進するカウンタを使うので、同じ
// ケース内で何度置換しても衝突しない(NAME_POOL の alpha〜zeta とも書式が違うので、
// そちらとも衝突しない)。
function substitutePlaceholders(line, counter, sourceOutput) {
  const available = availableNamesFrom(sourceOutput || '');
  return line.replace(/<name>|<別名>|<名前>/g, (token) => {
    if (token === '<名前>' && available) return available[0];
    return `fresh${counter.next++}`;
  });
}

// node swap.js への引数として渡すだけなのでシェルの引用規則は関係ない。案内文の引数に空白を
// 含むものは無いので、空白区切りで十分。
function toArgv(command) {
  return command.split(/\s+/).filter(Boolean).slice(1); // 先頭の "swap" を落とす
}

// --- 状態が前進したかの判定 ---
// 対象は仕様どおり credentials 本体と accounts/ のスロット・.replaced の中身に限る。.current は
// 来歴のメタ情報でしかなく、これだけが変わっても退避や切り替えが起きたとは言えない
// (cmdSwap の来歴だけの自己修復がまさにこれで、実際には何も切り替わっていない)。
function readRawOrNull(file) {
  try { return fs.readFileSync(file); } catch { return null; }
}
function bufEqual(a, b) {
  if (a === null || b === null) return a === b;
  return Buffer.compare(a, b) === 0;
}
function snapshotProgress(home) {
  const tree = new Map();
  const accountsDir = path.join(home, '.claude', 'accounts');
  let entries = [];
  try { entries = fs.readdirSync(accountsDir, { withFileTypes: true }); } catch { /* まだ何もない */ }
  for (const ent of entries) {
    if (ent.isFile() && ent.name.endsWith('.json')) {
      tree.set(ent.name, readRawOrNull(path.join(accountsDir, ent.name)));
    }
  }
  (function walk(dir, rel) {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      const relPath = rel + '/' + ent.name;
      if (ent.isDirectory()) walk(full, relPath);
      else tree.set('.replaced' + relPath, readRawOrNull(full));
    }
  })(replacedDir(home), '');
  return { credentials: readRawOrNull(credPath(home)), tree };
}
function progressed(before, after) {
  if (!bufEqual(before.credentials, after.credentials)) return true;
  for (const [k, v] of after.tree) {
    if (!bufEqual(before.tree.get(k) ?? null, v)) return true;
  }
  for (const k of before.tree.keys()) {
    if (!after.tree.has(k)) return true; // 消えたのも「変わった」に含める
  }
  return false;
}

// --- /login 終端の許容(2026-08-13 の方針転換) ---
// このツール群はもともと「/login させたら負け」という前提で作られており、それが異常系の分岐を
// 増やしてきた。しかし失われるのはトークンであってアカウントそのものではなく、実害は
// 「ブラウザで再ログインする手間」でしかない。方針転換後は、控えを残したうえで /login を案内する
// 終端は正常な設計であって「行き止まり」ではない。どの選択肢のどの手であっても、実行した
// コマンドが非 0 で終わったとき、
// (1) 実行直後の現在の credentials が読めない(JSON として parse できないか accessToken を
//     取り出せない)= swap のどのコマンドでも前進できない状態になっていて、
// (2) その実行の出力が /login に言及している
// の両方を満たすなら、この非 0 終了を「許容される終端」として FAIL にしない。
//
// 判定を (1) の状態ベースを主にし、(2) の文面ベースを補助にとどめるのは、文面だけで判定すると
// 誤判定するため。中止メッセージには「/login はまだ試さないでください」という逆向きの言及が
// 多数あり(健全な、または refreshToken が残っている credentials を /login で失わせないための
// 案内)、「/login を含む」だけを条件にすると、こうした「まだ試すな」の警告まで許容側に
// 倒れてしまい、テストがほぼ何も検査しなくなる。実際に現在の credentials が読めない状態に
// なっていることを主たる根拠にすることで、その落とし穴を避ける。
//
// 「読めない」の判定は credentials.js の hasUsableCredentials と同じ考え方(accessToken の有無)
// をこのテストが自前で読み直したもの。本番コードの関数は呼ばない(この判定はテストの厳しさを
// 決める要なので、本番側の定義が変わってもテストの意図が静かにずれないよう独立させてある)。
function currentCredsUnreadable(home) {
  let raw;
  try {
    raw = fs.readFileSync(credPath(home), 'utf8');
  } catch {
    return true; // 無い/読めないも「accessToken を取り出せない」に変わりはない
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return true;
  }
  return !(json && json.claudeAiOauth && json.claudeAiOauth.accessToken);
}

// --- 選択肢の実行エンジン ---
// 1つの選択肢(1つ以上のコマンドから成る手順)を、渡されたサンドボックス(呼び出し元が
// 既にこの選択肢専用に複製済み)の上で順に実行する。途中の1手が非 0 で終わり、かつ /login
// 終端としても許容できないなら、そこで手順を止める(この選択肢は「止まった」)。depthRemaining
// が残っていれば、止まった手の出力からさらに1段だけ選択肢を辿る(exploreBranches)。
// exempt(/login 終端の許容)は手順の途中でも判定する: 「どの選択肢のどの手でも同じ条件を
// 満たせば終端として許容する」という指示どおり、当初の一手目だけを特別扱いしない。
function runChoiceSteps(branchHome, rawLines, sourceOutput, depthRemaining, ctx) {
  const steps = [];
  let hardFail = false;
  for (const rawLine of rawLines) {
    const substituted = substitutePlaceholders(rawLine, ctx.counter, sourceOutput);
    const argv = toArgv(substituted);
    const r = runSwap(branchHome, argv);
    const exempt = r.code !== 0 && currentCredsUnreadable(branchHome) && (r.out + r.err).includes('/login');
    const step = { cmd: substituted, argv, code: r.code, out: r.out, err: r.err, exempt };
    steps.push(step);
    ctx.allSteps.push(step);
    if (r.code !== 0) {
      if (!exempt) hardFail = true;
      break; // 非0で終わった時点でこの選択肢の手順としては打ち切る(許容終端でも同じ)
    }
  }
  const branch = { rawLines, steps, home: branchHome, succeeded: !hardFail, extended: null };
  if (hardFail && depthRemaining > 0) {
    const last = steps[steps.length - 1];
    branch.extended = exploreBranches(branchHome, last.out + '\n' + last.err, depthRemaining - 1, ctx);
  }
  return branch;
}

// 出力から選択肢を抽出し、既出(ctx.seen)を除いて、それぞれ独立した複製の上で試す。
// 複製元(srcHome)はここまでにこのブランチが辿ってきた状態そのもの(そのコピーの中で
// 深さ2を閉じる、という指示どおり、深さ1の複製をさらに複製する)。
function exploreBranches(srcHome, output, depthRemaining, ctx) {
  const branches = [];
  for (const block of extractChoiceBlocks(output)) {
    const key = JSON.stringify(block);
    if (ctx.seen.has(key)) continue; // 同じ選択肢を2回試さない
    ctx.seen.add(key);
    // 複製先は case-i の「兄弟」ディレクトリにする(case-i 自身の下に作ると、Windows の
    // cpSync が「自分自身のサブディレクトリへはコピーできない」で落ちる)。
    const branchHome = ctx.branchBase + (ctx.branchSeq++);
    fs.cpSync(srcHome, branchHome, { recursive: true });
    branches.push(runChoiceSteps(branchHome, block, output, depthRemaining, ctx));
  }
  return branches;
}

// 選択肢(とその先に辿った選択肢)のどこかが最後まで通ったか。
function branchPasses(branch) {
  if (branch.succeeded) return true;
  return !!(branch.extended && branch.extended.some(branchPasses));
}

// 通った選択肢がたどり着いた最終状態のサンドボックス(検査2で使う)。
function successfulHome(branch) {
  if (branch.succeeded) return branch.home;
  if (!branch.extended) return null;
  for (const sub of branch.extended) {
    const h = successfulHome(sub);
    if (h) return h;
  }
  return null;
}

// すべてのブランチ(通った/止まった両方、深さ2まで)のサンドボックスを列挙する。検査3
// (資格情報を失っていないか)は「どの経路を選んでも」成り立つべきなので、1本のホームだけを
// 見るのではなく試したブランチ全部を横断して見る。
function collectBranchHomes(branches, acc) {
  for (const b of branches) {
    acc.push(b.home);
    if (b.extended) collectBranchHomes(b.extended, acc);
  }
  return acc;
}

// FAIL したときに全選択肢のコマンドと出力を出す(検査1の失敗時に指示されている)。
function dumpBranch(branch, indent) {
  const lines = [];
  const stepsDesc = branch.steps
    .map((s) => s.cmd + ' -> exit ' + s.code + (s.exempt ? ' [/login 終端として許容]' : ''))
    .join('  ->  ');
  lines.push(indent + '選択肢: ' + (stepsDesc || '(手順が空)'));
  if (branch.succeeded) {
    lines.push(indent + '  → 通った');
    return lines;
  }
  const last = branch.steps[branch.steps.length - 1];
  lines.push(indent + '  → 止まった。最後の出力:');
  if (last) lines.push(...(last.out + last.err).split('\n').map((l) => indent + '    ' + l));
  if (branch.extended && branch.extended.length) {
    lines.push(indent + '  この出力からさらに辿った選択肢:');
    for (const sub of branch.extended) lines.push(...dumpBranch(sub, indent + '    '));
  } else {
    lines.push(indent + '  (これ以上辿れる選択肢は無い。深さ2の上限、または /login を含む行の除外)');
  }
  return lines;
}

console.log(`reachable.test.js: seed=${SEED} cases=${CASES}`);
const startedAt = Date.now();
// 「終端の許容」が期待を緩めすぎて検査が空回りしていないかを後から確認できるよう、
// 許容が発動したケース数を別途数えて最後に報告する。
let exemptedCases = 0;
// 抽出ルールの感度を実測で追えるように、選択肢が1件以上抽出できたケース数と、実行した
// (試した)選択肢の総数も数える。
let casesWithGuidance = 0;
let totalChoicesExecuted = 0;

for (let i = 0; i < CASES; i++) {
  const caseSeed = mixSeed(SEED, i);
  const rng = makeRng(caseSeed);
  const home = path.join(BASE, 'case-' + i);
  fs.rmSync(home, { recursive: true, force: true });

  const state = buildInitialState(rng, i);
  writeSandbox(home, state);

  const beforeTokens = collectTokens(home);
  const beforeFiles = listFiles(home);
  const beforeProgress = snapshotProgress(home);

  const op = pickInitialOp(rng, state, i);
  const initial = runSwap(home, op.argv);
  const initialCombined = initial.out + '\n' + initial.err;

  // ctx は 1 ケースを通して共有する状態(重複除去・置換カウンタ・複製先の採番・全ステップの記録)。
  const ctx = {
    seen: new Set(), counter: { next: 1 }, allSteps: [],
    branchBase: path.join(BASE, 'case-' + i + '__b'), branchSeq: 0,
  };
  // 選択肢ごとに、当初の要求の直後の状態(home)を複製した独立のサンドボックスの上で試す
  // (「選択肢は独立した状態から試す」という指示どおり。ここが以前の flat な深さ2追跡との
  // 最大の違いで、前の選択肢の副作用が後の選択肢の前提を壊す偽陽性を防ぐ)。
  const topBranches = exploreBranches(home, initialCombined, 1, ctx);

  if (topBranches.length > 0) casesWithGuidance++;
  totalChoicesExecuted += ctx.branchSeq;
  if (ctx.allSteps.some((s) => s.code !== 0 && s.exempt)) exemptedCases++;

  // --- 検査1: 抽出したすべての選択肢が、それぞれ最後まで exit 0 で通ること ---
  // 「少なくとも1つ通ればよい」ではない(以前の版で採用していたが、選択肢どうしの副作用の
  // 干渉を独立サンドボックス化で解消した以上、冗長な代替経路が常に検査を素通りさせてしまい
  // 何も検査できていなかった。詳しい経緯は冒頭コメント参照)。ここでの「選択肢」は当初の要求の
  // 出力から直接抽出したもの(topBranches)に限る。1つでも自分の手順の途中で非0終了(かつ
  // /login 終端としても許容できない)なら、その選択肢は「主張どおりに機能しなかった」ので、
  // ケース全体を FAIL にする。深さ2で見つかる続きの選択肢(branch.extended)は、この判定には
  // 使わない(それは「else こうすれば復旧できる」という別の情報であって、当初案内された
  // 選択肢そのものが機能したことにはならない)。ただし FAIL の手掛かりとして出力には含める。
  const allPass = topBranches.length === 0 || topBranches.every((b) => b.succeeded);
  check(`case ${i} (seed=${caseSeed}): 抽出したすべての選択肢がそれぞれ止まらずに通る`, allPass,
    allPass ? '' : [
      'seed=' + SEED + ' case=' + i + ' caseSeed=' + caseSeed,
      '初期状態: ' + JSON.stringify(state),
      '当初の操作: ' + op.label + ' -> exit ' + initial.code,
      '当初の出力:',
      ...initialCombined.split('\n').map((l) => '  ' + l),
      '試した選択肢(通った/止まったの内訳):',
      ...topBranches.flatMap((b) => dumpBranch(b, '  ')),
    ].join('\n      '));

  // --- 検査2: 通った選択肢について、状態が前進すること ---
  // 当初操作の時点で credentials も accounts のスロットも1つも無ければ、そもそも swap の
  // どのコマンドにも進めようがない(前進しようがない)ので対象外にする(今回の除外規定)。
  const nothingToProgress = state.current.kind === 'absent' && Object.keys(state.accounts).length === 0;
  if (!nothingToProgress && topBranches.some(branchPasses)) {
    const passing = topBranches.filter(branchPasses);
    const ok = passing.some((b) => {
      const h = successfulHome(b);
      return h && progressed(beforeProgress, snapshotProgress(h));
    });
    check(`case ${i} (seed=${caseSeed}): 通った選択肢で状態が前進する`, ok,
      ok ? '' : [
        'seed=' + SEED + ' case=' + i + ' caseSeed=' + caseSeed,
        '初期状態: ' + JSON.stringify(state),
        '当初の操作: ' + op.label + ' -> exit ' + initial.code,
        '当初の出力:',
        ...initialCombined.split('\n').map((l) => '  ' + l),
        '通った選択肢(いずれも状態を変えなかった):',
        ...passing.flatMap((b) => dumpBranch(b, '  ')),
      ].join('\n      '));
  }

  // --- 検査3: 資格情報が失われていないこと(fault.test.js と同じ不変条件をそのまま流用) ---
  // 選択肢ごとに独立したサンドボックスがあるので、当初操作後の home に加え、試した全ブランチ
  // (止まったものも含む。深さ2まで)を横断して見る。どの経路を選んでも資格情報を失わないことが
  // 不変条件であって、たまたま試した1本だけを見ても足りない。
  const allHomes = [home, ...collectBranchHomes(topBranches, [])];
  let missing = [];
  let missingHome = null;
  for (const h of allHomes) {
    const afterTokens = collectTokens(h);
    const m = [...beforeTokens].filter((t) => !afterTokens.has(t));
    if (m.length) { missing = m; missingHome = h; break; }
  }
  check(`case ${i} (seed=${caseSeed}): 実行前の refreshToken がすべて残っている`, missing.length === 0,
    missing.length ? [
      '失われたトークン: ' + missing.join(', ') + '(' + missingHome + ')',
      'seed=' + SEED + ' case=' + i + ' caseSeed=' + caseSeed,
      '初期状態: ' + JSON.stringify(state),
      '当初の操作: ' + op.label,
      '実行前のファイル一覧:',
      ...beforeFiles.map((l) => '  ' + l),
      '実行後のファイル一覧(' + missingHome + '):',
      ...listFiles(missingHome).map((l) => '  ' + l),
    ].join('\n      ') : '');
}

console.log(`  (${CASES} ケース, ${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
console.log(`  選択肢が1件以上抽出できたケース: ${casesWithGuidance} / ${CASES}、実行した選択肢の総数: ${totalChoicesExecuted}`);
console.log(`  /login 終端として許容したケース: ${exemptedCases} / ${CASES}(残り ${CASES - exemptedCases} 件は許容なしで通常どおり)`);
report();
