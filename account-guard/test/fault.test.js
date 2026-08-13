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

// SWAP_FAULT を親プロセス(このファイル自身)の環境に残したまま require すると、
// fault-fs.js の分岐がここで発火して自分の fs まで壊しかねない。WRAPPED_CALLS を
// 読みたいだけなので、require の間だけ確実に外す(通常は元から設定されていない)。
const savedFault = process.env.SWAP_FAULT;
delete process.env.SWAP_FAULT;
const { WRAPPED_CALLS } = require('./fault-fs');
if (savedFault !== undefined) process.env.SWAP_FAULT = savedFault;

const BASE = path.join(__dirname, '.tmp', 'fault');
const SWAP = path.join(__dirname, '..', 'swap.js');
const FAULT_FS = path.join(__dirname, 'fault-fs.js');
fs.rmSync(BASE, { recursive: true, force: true });

const DAY = 86400000;
const { check, report } = makeHarness();

// シードは固定(コマンドラインから上書きできるようにはするが、既定値は常に同じ数)。
// 同じシードなら必ず同じ操作列になることが再現性の前提なので、Math.random() は使わない。
const SEED = Number(process.env.FAULT_SEED) || 424242;
// ケース数は約 200 が目安。子プロセスを 1 ケースあたり 1〜4 回起動する重さがあるので、
// 実測して 60 秒を大きく超えるようなら FAULT_CASES で減らせるようにしておく。
const CASES = Number(process.env.FAULT_CASES) || 200;

// --- 擬似乱数(xorshift32)。Math.random() は使わない(シード固定・再現性のため) ---
function makeRng(seed) {
  let s = (seed >>> 0) || 1; // 0 は xorshift の不動点なので避ける
  return function rng() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

// ケースごとに独立したシードを作る。全ケースで 1 本の乱数列を使い回すと、あるケースの
// 操作数が変わるだけで後続の全ケースの乱数列がずれ、「ケース i だけ再現する」ができなくなる。
// seed と i だけから決まるようにしておけば、失敗したケース単体を後から再現できる。
function mixSeed(seed, i) {
  let x = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function shuffle(rng, arr) {
  for (let k = arr.length - 1; k > 0; k--) {
    const j = Math.floor(rng() * (k + 1));
    [arr[k], arr[j]] = [arr[j], arr[k]];
  }
  return arr;
}

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

const credPath = (home) => path.join(home, '.claude', '.credentials.json');
const acctPath = (home, name) => path.join(home, '.claude', 'accounts', name + '.json');
const slotPath = (home) => path.join(home, '.claude', 'accounts', '.current');
const replacedDir = (home) => path.join(home, '.claude', 'accounts', '.replaced');

function writeSandbox(home, { current, accounts, slot }) {
  fs.mkdirSync(path.join(home, '.claude', 'accounts'), { recursive: true });
  if (current !== undefined) fs.writeFileSync(credPath(home), JSON.stringify(current), 'utf8');
  for (const [n, v] of Object.entries(accounts)) fs.writeFileSync(acctPath(home, n), JSON.stringify(v), 'utf8');
  if (slot !== undefined) fs.writeFileSync(slotPath(home), slot + '\n', 'utf8');
}

// --- 実行前後のスナップショット ---
// 「実行前に存在した refreshToken が実行後もどこかに残っているか」だけを見る。JSON.parse は
// 使わない: 切り詰められたファイルでも、切れた位置より手前にあるトークンは拾えるべきという
// 前提(credentials.js の rawHasRecoverableToken と同じ思想)なので、正規表現で生バイト列から
// 直接拾う。読む対象は仕様どおり .credentials.json / accounts/*.json / accounts/.replaced/** の
// 3 箇所に限る(accounts/*.json.tmp のような書きかけの一時ファイルは対象外。writeAtomic は
// 上書きされる側の内容を必ず先にどこか安全な場所へ複製してから書き換える設計なので、
// 一時ファイルにしか残っていない状態を不変条件の対象にすると、この設計そのものではなく
// 「rename の直前で止まった」という無関係な事情で偽陽性になる)。
const TOKEN_RE = /"refreshToken"\s*:\s*"([^"]+)"/g;
function tokensInFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return [];
  }
  // latin1 で文字列化するのは 1 バイト = 1 文字で復元するため。truncate 注入で UTF-8 の
  // マルチバイト列が途中で切れても、utf8 デコードのように置換文字(U+FFFD)へ化けて
  // トークンの一部を読み違えることがない(トークンそのものは ASCII なので情報は落ちない)。
  const text = raw.toString('latin1');
  const out = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text))) out.push(m[1]);
  return out;
}

function collectTokens(home) {
  const tokens = new Set();
  tokensInFile(credPath(home)).forEach((t) => tokens.add(t));
  const accountsDir = path.join(home, '.claude', 'accounts');
  let entries = [];
  try {
    entries = fs.readdirSync(accountsDir);
  } catch { /* まだ 1 度も退避していない */ }
  for (const f of entries) {
    if (!f.endsWith('.json')) continue; // .current や .replaced/ 自体はここでは拾わない
    tokensInFile(path.join(accountsDir, f)).forEach((t) => tokens.add(t));
  }
  (function walk(dir) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else tokensInFile(full).forEach((t) => tokens.add(t));
    }
  })(replacedDir(home));
  return tokens;
}

// FAIL したときの手掛かり用。中身までは出さない(トークン文字列はダミーだが、実物の
// swap.js の出力と同じ形式に慣れさせないため、あえてパスと種別だけに留める)。
function listFiles(home) {
  const root = path.join(home, '.claude');
  const out = [];
  (function walk(dir, rel) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of [...ents].sort((a, b) => a.name.localeCompare(b.name))) {
      const relPath = rel ? rel + '/' + ent.name : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { out.push('D ' + relPath); walk(full, relPath); }
      else out.push('F ' + relPath);
    }
  })(root, '');
  return out;
}

// --- 操作列 ---
function pickOperation(rng) {
  const name = NAME_POOL[Math.floor(rng() * NAME_POOL.length)];
  switch (Math.floor(rng() * 6)) {
    case 0: return { label: 'swap', argv: [] };
    case 1: return { label: 'swap save', argv: ['save'] };
    case 2: return { label: `swap save ${name}`, argv: ['save', name] };
    case 3: return { label: `swap save ${name} --force`, argv: ['save', name, '--force'] };
    case 4: return { label: `swap ${name}`, argv: [name] };
    default: return { label: `swap ${name} --force`, argv: [name, '--force'] };
  }
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
  const env = { ...process.env, USERPROFILE: home, HOME: home, NO_COLOR: '1', NODE_OPTIONS: '--require ' + FAULT_FS };
  if (fault) env.SWAP_FAULT = JSON.stringify(fault);
  else delete env.SWAP_FAULT;
  try {
    const out = execFileSync(process.execPath, [SWAP, ...argv], { encoding: 'utf8', env });
    return { code: 0, out, err: '' };
  } catch (e) {
    return { code: e.status ?? 1, out: e.stdout || '', err: e.stderr || '' };
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
report();
