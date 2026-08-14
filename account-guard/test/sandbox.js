'use strict';
// test/fault.test.js と test/reachable.test.js の両方が使う、偽 HOME サンドボックス関連の
// 共通部品を切り出したもの。もともと fault.test.js に直接書かれていた実装をそのまま移しただけで、
// 挙動は変えていない(コメントも含め、由来を辿れるよう極力そのまま残す)。
//
// 「なぜ切り出すか」: 2 つの property test はどちらも同じ前提を持つ(シード固定の xorshift32、
// accounts/.replaced のパス規約、実行前後の refreshToken を生バイト列から拾う不変条件チェック)。
// 別々に持つと、一方だけ直したときに定義がずれる(このリポジトリで繰り返し起きている「片方だけ
// 直して食い違う」事故の温床になる)。

const fs = require('fs');
const path = require('path');

const DAY = 86400000;

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

const credPath = (home) => path.join(home, '.claude', '.credentials.json');
const acctPath = (home, name) => path.join(home, '.claude', 'accounts', name + '.json');
const slotPath = (home) => path.join(home, '.claude', 'accounts', '.current');
const replacedDir = (home) => path.join(home, '.claude', 'accounts', '.replaced');

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

module.exports = {
  DAY, makeRng, mixSeed, shuffle,
  credPath, acctPath, slotPath, replacedDir,
  TOKEN_RE, tokensInFile, collectTokens, listFiles,
};
