'use strict';
// transcript 系スクリプトの共通処理。3本とも「~/.claude/projects を走査して JSONL を
// 1行ずつ読む」「usage をコストに換算する」を同じ形で必要とするため、ここに集約する。
// 単価テーブルだけは変更頻度が違う(モデル追加のたびに触る)ので pricing.js に分けてある。
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PRICE = require('./pricing');

// USERPROFILE は Windows、HOME は WSL/macOS から実行された場合の保険。
// テストは子プロセスの USERPROFILE を偽 HOME に差し替えてここを乗っ取る。
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const ROOT = path.join(HOME, '.claude', 'projects');

// モデル名として現れるが課金対象ではないもの。単価表に無くても警告しない。
// <synthetic> は Claude Code が挿入するシステム生成メッセージ。
const NOT_BILLED = new Set(['<synthetic>', 'unknown', '']);

const unknownModels = new Map();

// 'claude-opus-5' → 'opus-5'。単価表のキーに合わせる
function modelKey(model) {
  return String(model || 'unknown').replace('claude-', '');
}

// 単価表に無いモデルは 0 円として扱うしかないが、黙って落とすと集計漏れに気づけない。
// 見かけた名前を控えておき、呼び出し側が最後に warnUnknownModels() で報告する。
function cost(model, u) {
  const key = modelKey(model);
  const p = PRICE[key];
  if (!p) {
    if (!NOT_BILLED.has(key)) unknownModels.set(key, (unknownModels.get(key) || 0) + 1);
    return 0;
  }
  return ((u.input_tokens || 0) * p.in
    + (u.cache_creation_input_tokens || 0) * p.in * 1.25
    + (u.cache_read_input_tokens || 0) * p.in * 0.1
    + (u.output_tokens || 0) * p.out) / 1e6;
}

// そのターンが実際に読ませたプロンプト長。cache_read だけでは足りない点が重要:
// キャッシュ TTL が切れた直後のターンは同じ量が cache_creation 側に乗るため、
// cache_read だけで見ると 200K のターンが「ほぼ 0」に見えて低い帯に誤分類される。
// input/cache_creation/cache_read は互いに排他な内訳なので、3つの和が総プロンプト長。
function ctxLen(u) {
  if (!u) return 0;
  return (u.cache_read_input_tokens || 0)
    + (u.cache_creation_input_tokens || 0)
    + (u.input_tokens || 0);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// ROOT が無い環境(Claude Code 未使用のマシン、HOME 未設定)では黙って 0 件を返すのではなく
// 何を見に行ったかを示して落とす。空集計を「使っていない」と誤読するのを防ぐため。
function transcriptFiles() {
  if (!fs.existsSync(ROOT)) {
    console.error(`transcript が見つからない: ${ROOT}`);
    process.exit(1);
  }
  return walk(ROOT);
}

// 1ファイル分のレコードを順に返す。壊れた行は飛ばす(書き込み中の末尾行がありうる)。
// ファイル単位にしているのは、呼び出し側が tool_use_id → ツール名の対応表や
// セッション単位の集計といったファイル内に閉じた状態を持てるようにするため。
async function* records(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    yield o;
  }
}

function warnUnknownModels() {
  if (!unknownModels.size) return;
  const list = [...unknownModels.entries()].map(([m, n]) => `${m}(${n}件)`).join(', ');
  console.error(`\n警告: pricing.js に単価が無いモデルを $0 として集計した: ${list}`);
}

module.exports = { PRICE, ROOT, modelKey, cost, ctxLen, walk, transcriptFiles, records, warnUnknownModels };
