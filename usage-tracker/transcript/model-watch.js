'use strict';
// 単価表(pricing.js)に無いモデルが transcript に現れたら、セッション開始時に知らせる SessionStart フック。
// 5.5 世代の追加漏れで集計が数週間 $0 になっていた実例がある。sessions.js / turncost.js も実行の
// 最後に警告するが、集計を回さない限り気づけないので、毎セッションの入口で見る。
//
// transcript は使い続けるほど大きくなり、毎回全量を読むとセッション開始が遅くなる。ファイルごとに
// 前回読み終えたバイト位置を状態ファイルに持ち、伸びた分だけを読む。サイズも更新時刻も変わって
// いないファイルは開かない。初回と状態ファイルが壊れたときだけ全量を読む。
// 見つけたモデルは状態に残し、単価表に足されるまで毎回通知する(一度出して消えると、
// そのセッションで見落とした時点で終わる)。
//
// 判定は lib.js の isUnknownModel() をそのまま使い、ここで新たに持たない。見るのは assistant
// レコードの message.model だけ。行の文字列から "model":"..." を拾うと、Agent ツールの入力
// ("model":"sonnet" のようなエイリアス)まで未知モデルとして誤検知する。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT, walk, modelKey, isUnknownModel } = require('./lib');

// ROOT は ~/.claude/projects。状態は収集器・guard と同じ ~/.claude/usage-tracker に置く
const STATE = path.join(path.dirname(ROOT), 'usage-tracker', 'model-watch.json');
// 1 回に読む量の上限。前回からの差分が長いセッション 1 本分になることがあるので、
// まとめて Buffer に載せず区切って読む
const CHUNK = 8 * 1024 * 1024;
// 作り直しの検出に使う先頭のバイト数。transcript の 1 行目にはセッション ID や uuid が入るので、
// 別の内容に置き換わればここが変わる。同じ長さ以上で作り直された場合もサイズだけでは分からない。
const HEAD = 256;

// 前回の状態。無い・壊れている・形が違うときは初回として全量を読む
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v);
    if (isMap(s) && isMap(s.files) && isMap(s.unknown)) return s;
  } catch (e) { /* 下で初回として扱う */ }
  return { files: {}, unknown: {} };
}

// 一時ファイルに書いてから rename する。複数セッションが同時に起動すると書き込みが重なるが、
// 途中まで書かれた JSON を次回読んで初回扱いになるよりは、どちらか一方が勝つ方がよい
// (負けた側の位置が古くても、次回に同じ範囲を読み直すだけ。件数は transcript の本数で
// 数えているので、読み直しで増えることはない)。
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const tmp = `${STATE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(s), 'utf8');
    fs.renameSync(tmp, STATE);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function headHash(fd, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, 0);
  return crypto.createHash('sha1').update(buf.subarray(0, n)).digest('hex');
}

// prev(前回の記録)から先の、完結した行だけを処理して新しい記録を返す。末尾の改行で
// 終わっていない行は書き込み中のセッションのものなので読まずに残し、次回そこから読み直す。
function scan(file, st, prev, onModel, stats) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = st.size;
    let pos = 0;
    // 前回の位置より短い、または先頭が変わった = 作り直された。最初から読み直す
    if (prev && prev.pos <= size && headHash(fd, Math.min(HEAD, prev.pos)) === prev.head) pos = prev.pos;
    let carry = Buffer.alloc(0);
    while (pos < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      stats.bytes += n;
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
    const end = pos - carry.length;
    return { pos: end, size, mtime: st.mtimeMs, head: headHash(fd, Math.min(HEAD, end)) };
  } finally {
    fs.closeSync(fd);
  }
}

function main() {
  // hook は Claude Code を使っていないマシンでも起動されうる。CLI の集計スクリプトと違い、
  // ここで落とすとセッション開始のたびにエラーが出るので黙って抜ける。
  if (!fs.existsSync(ROOT)) return;
  const prev = loadState();
  const state = { files: {}, unknown: {} };
  const stats = { bytes: 0, opened: 0 };

  // 前回までに見つけたものは単価表に足されていれば消し、残りは引き継ぐ
  for (const [key, v] of Object.entries(prev.unknown)) {
    if (isUnknownModel(key) && v && Array.isArray(v.files)) state.unknown[key] = v;
  }
  const now = new Date().toISOString();
  for (const f of walk(ROOT)) {
    // 件数は「何本の transcript に出たか」で数える。レコード数だと、作り直しの読み直しや
    // --resume / fork で複製された履歴で同じ応答を二重に数えてしまう
    const id = path.relative(ROOT, f);
    const p = prev.files[f];
    const known = p && typeof p === 'object' ? p : null;
    try {
      const st = fs.statSync(f);
      if (known && known.size === st.size && known.mtime === st.mtimeMs) { state.files[f] = known; continue; }
      stats.opened++;
      state.files[f] = scan(f, st, known, model => {
        if (!isUnknownModel(model)) return;
        const key = modelKey(model);
        const u = state.unknown[key] || (state.unknown[key] = { files: [], firstSeen: now });
        if (!u.files.includes(id)) u.files.push(id);
      }, stats);
    } catch (e) {
      // 走査の途中で消えた transcript(別セッションの後片付けや cleanupPeriodDays の削除)。
      // 1 本の消失で全体を止めず、そのファイルの記録だけ落として続ける
      if (e.code !== 'ENOENT') throw e;
    }
  }
  // 消えた transcript の位置は、files を作り直すことで落ちる

  if (process.env.USAGE_TRACKER_MODEL_WATCH_STATS) {
    console.error(`model-watch: ${stats.opened} 本を開き ${stats.bytes} バイト読んだ`);
  }

  // 通知は状態の保存より先に出す。保存が失敗しても(同時起動の rename 競合など)、
  // そのセッションへの通知は失わない
  const keys = Object.keys(state.unknown);
  if (keys.length) {
    const list = keys.map(k => `${k}(transcript ${state.unknown[k].files.length} 本)`).join(', ');
    const msg = `usage-tracker: pricing.js に単価が無いモデルが transcript に出ている: ${list}。`
      + 'コスト集計では $0 として数えられるので、usage-tracker/transcript/pricing.js に単価を足すこと。';
    process.stdout.write(JSON.stringify({
      systemMessage: msg,
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg },
    }));
  }
  saveState(state);
}

// 自分の不具合でセッション開始を妨げない。SessionStart フックは終了コード 2 以外ならブロック
// しないので、原因を stderr に出して 1 で終わる(0 にすると不具合が誰にも見えない)
try {
  main();
} catch (e) {
  console.error(`model-watch: ${e && e.message}`);
  process.exitCode = 1;
}
