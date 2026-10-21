'use strict';
// 単価表(pricing.js)に無いモデルが transcript に現れたら、セッション開始時に知らせる SessionStart フック。
// 5.5 世代の追加漏れで集計が数週間 $0 になっていた実例がある。sessions.js / turncost.js も実行の
// 最後に警告するが、集計を回さない限り気づけないので、毎セッションの入口で見る。
//
// transcript は数百 MB ある(30 日分で約 380MB、全量を読むと約 1.2 秒)。毎セッションの入口で
// 払うには重いので、ファイルごとに前回読み終えたバイト位置を状態ファイルに持ち、そこから先だけを
// 読む(普段は 0.2 秒以内)。初回と状態ファイルが壊れたときだけ全量を読む。
// 見つけたモデルは状態に残し、単価表に足されるまで毎回通知する(一度出して消えると、
// そのセッションで見落とした時点で終わる)。
//
// 判定は lib.js の isUnknownModel() をそのまま使い、ここで新たに持たない。見るのは assistant
// レコードの message.model だけ。行の文字列から "model":"..." を拾うと、Agent ツールの入力
// ("model":"sonnet" のようなエイリアス)まで未知モデルとして誤検知する。
const fs = require('fs');
const path = require('path');
const { ROOT, walk, modelKey, isUnknownModel } = require('./lib');

// ROOT は ~/.claude/projects。状態は収集器・guard と同じ ~/.claude/usage-tracker に置く
const STATE = path.join(path.dirname(ROOT), 'usage-tracker', 'model-watch.json');
// 1 回に読む量の上限。前回からの差分が長いセッション 1 本分(数十 MB)になることがあるので、
// まとめて Buffer に載せず区切って読む
const CHUNK = 8 * 1024 * 1024;

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (s && typeof s.files === 'object' && typeof s.unknown === 'object') return s;
  } catch (e) { /* 無い・壊れている → 初回として全量を読む */ }
  return { files: {}, unknown: {} };
}

// 一時ファイルに書いてから rename する。複数セッションが同時に起動すると書き込みが重なるが、
// 途中まで書かれた JSON を次回読んで初回扱いになるよりは、どちらか一方が勝つ方がよい
// (負けた側の位置が古くても、次回に同じ範囲を読み直すだけ。件数が重複しうるが、件数は目安で
// 通知するかどうかは変わらない)。
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const tmp = `${STATE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s), 'utf8');
  fs.renameSync(tmp, STATE);
}

// from から読める完結した行だけを処理し、次に読み始める位置を返す。末尾の改行で終わっていない
// 行は書き込み中のセッションのものなので読まずに残し、次回そこから読み直す。
function scan(file, from, onModel) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let pos = from;
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      // 改行(0x0A)は UTF-8 の多バイト文字の途中に現れないので、バイト列のまま切ってよい
      const last = data.lastIndexOf(0x0a);
      if (last < 0) { carry = data; continue; }
      for (const line of data.subarray(0, last).toString('utf8').split('\n')) {
        // 大半の行は assistant でないので、JSON.parse の前に文字列で絞る
        if (!line.includes('"assistant"')) continue;
        let o;
        try { o = JSON.parse(line); } catch (e) { continue; }
        if (o.type === 'assistant' && o.message && o.message.model) onModel(o.message.model);
      }
      carry = data.subarray(last + 1);
    }
    return pos - carry.length;
  } finally {
    fs.closeSync(fd);
  }
}

function main() {
  // hook は Claude Code を使っていないマシンでも起動されうる。CLI の集計スクリプトと違い、
  // ここで落とすとセッション開始のたびにエラーが出るので黙って抜ける。
  if (!fs.existsSync(ROOT)) return;
  const files = walk(ROOT);
  const prev = loadState();
  const state = { files: {}, unknown: {} };

  // 前回までに見つけたものは単価表に足されていれば消し、残りは引き継ぐ
  for (const [key, v] of Object.entries(prev.unknown)) {
    if (isUnknownModel(key)) state.unknown[key] = v;
  }
  const now = new Date().toISOString();
  for (const f of files) {
    let from = prev.files[f] || 0;
    // 前回より小さい = 作り直された。最初から読み直す
    if (from > fs.statSync(f).size) from = 0;
    state.files[f] = scan(f, from, model => {
      if (!isUnknownModel(model)) return;
      const key = modelKey(model);
      const u = state.unknown[key] || (state.unknown[key] = { count: 0, firstSeen: now });
      u.count++;
    });
  }
  // 消えた transcript(cleanupPeriodDays で削除されたもの)の位置は、files を作り直すことで落ちる
  saveState(state);

  const keys = Object.keys(state.unknown);
  if (!keys.length) return;
  const list = keys.map(k => `${k}(${state.unknown[k].count}件)`).join(', ');
  const msg = `usage-tracker: pricing.js に単価が無いモデルが transcript に出ている: ${list}。`
    + 'コスト集計では $0 として数えられるので、usage-tracker/transcript/pricing.js に単価を足すこと。';
  process.stdout.write(JSON.stringify({
    systemMessage: msg,
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg },
  }));
}

// 通知は補助機能なので、自分の不具合でセッション開始を妨げない。原因は stderr に残す
try {
  main();
} catch (e) {
  console.error(`model-watch: ${e && e.message}`);
}
