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

// 非対話実行(claude -p / SDK 経由)のレコードか。ここに集約しているのは、同じ判定を
// 各スクリプトで新設すると片方だけ直る形になるため(claude-window-keeper の ping は
// 実データ 90 日で「送信」の 6.2% を占め、cwd が system32 なので架空のプロジェクトも作る)。
// entrypoint は user と assistant の両方に付く。ただし queue-operation のように印を
// 持たない型が同じセッションに混ざるので、これ単体では取りこぼす(実測 18 件が残り、
// 時間軸と架空プロジェクトに現れた)。下の isNonInteractiveSession() と併せて使う。
// 現時点で使っているのは habits.js のみ。sessions.js / turncost.js / breakdown.js は
// まだ ping を含んだまま数えている(sessions.js のセッション数はそのぶん多い)。
const isNonInteractive = o => !!o && o.entrypoint === 'sdk-cli';

// ファイルごと非対話実行のセッションか。レコード単位の判定だけでは足りない:
// ping の transcript には entrypoint を持たない型(queue-operation など)が混ざり、
// それらは timestamp を持つので時間軸と架空プロジェクトに残ってしまう(実測 18 件)。
// 非対話セッションは短く印は先頭に出るので、頭だけ読んで判定する(全読みは数百 MB になる)。
// 読んだ範囲を正規表現で見るのではなく行ごとに JSON として解し、判定は isNonInteractive() に
// 合流させる: 生文字列を検査すると、会話の本文に "entrypoint": "sdk-cli" という文字列が
// 出ただけでセッションが丸ごと全統計から消える(このリポジトリでは transcript のレコードを
// そのまま貼って調べることがあり、実際に起こりうる)。消えた合図は「非対話実行 N 本」の
// 数字だけで気づけない。実データの sdk-cli 103 本はすべてフィールドとして印を持つので、
// 厳密化しても取りこぼしはない。
function isNonInteractiveSession(file, bytes = 65536) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    const head = buf.toString('utf8', 0, n);
    const lines = head.split('\n');
    // 末尾は次の読み出し位置で切れている可能性があるので捨てる(ファイル全体を読み切った
    // ときは最終行が空になるだけなので、同じ扱いでよい)。
    lines.pop();
    let parsed = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      parsed++;
      if (isNonInteractive(o)) return true;
    }
    // 1 行も解せなかった場合(1 レコードが 64KB を超える、壊れたファイル)は判定材料が
    // 無いので、従来どおり文字列一致に落とす。取りこぼすより誤検知する側に倒す。
    return parsed === 0 && /"entrypoint"\s*:\s*"sdk-cli"/.test(head);
  } catch {
    return false;   // 読めないファイルはここで判定せず、本処理側の例外処理に任せる
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* 既に閉じている */ }
  }
}

function warnUnknownModels() {
  if (!unknownModels.size) return;
  const list = [...unknownModels.entries()].map(([m, n]) => `${m}(${n}件)`).join(', ');
  console.error(`\n警告: pricing.js に単価が無いモデルを $0 として集計した: ${list}`);
}

module.exports = { PRICE, ROOT, modelKey, cost, ctxLen, walk, transcriptFiles, records, isNonInteractive, isNonInteractiveSession, warnUnknownModels };
