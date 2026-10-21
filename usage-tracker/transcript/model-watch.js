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
// 判定は lib.js の isUnknownKey() をそのまま使い、ここで新たに持たない。見るのは
// assistant レコードの message.model だけ。行の文字列から "model":"..." を拾うと、Agent ツールの入力
// ("model":"sonnet" のようなエイリアス)まで未知モデルとして誤検知する。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT, walk, modelKey, isUnknownKey, fileIdentity } = require('./lib');

// ROOT は ~/.claude/projects。状態は収集器・guard と同じ ~/.claude/usage-tracker に置く
const STATE = path.join(path.dirname(ROOT), 'usage-tracker', 'model-watch.json');
// 1 回に読む量の上限。前回からの差分が長いセッション 1 本分になることがあるので、
// まとめて Buffer に載せず区切って読む
const CHUNK = 8 * 1024 * 1024;
// 作り直しの検出に使う、読み終えた範囲の先頭と末尾のバイト数。transcript の 1 行目にはセッション ID や
// uuid が入るので、別の内容に置き換わればここが変わる。先頭を保ったまま切り詰めてから前回の位置を
// 超えて書き足された場合は、先頭もサイズも手がかりにならないので、前回の位置の直前で見分ける。
const EDGE = 256;
// 走査に使ってよい時間。フックの timeout(guard-hooks-snippet.json の 30 秒)で殺されると状態が
// 保存されず、次のセッションも同じ全量走査からやり直して永久に進まない。超えたら 1 本の途中でも
// 打ち切り、読めた分の位置を保存して残りは次回に回す。SessionStart フックは終わるまでセッション開始を
// 待たせるので短く取る。timeout まで残る時間は、予算の外にある walk と stat、長い 1 行の読み切りに充てる。
// 環境変数はテスト用。
const BUDGET_ENV = process.env.USAGE_TRACKER_MODEL_WATCH_BUDGET_MS;
const BUDGET_MS = BUDGET_ENV && Number(BUDGET_ENV) >= 0 ? Number(BUDGET_ENV) : 5000;
// 途中で打ち切ったファイルのサイズとして記録する値。実際のサイズと一致しないので、次回は
// 「変わっていない」と見なされず、記録した位置から続きを読む
const UNFINISHED = -1;

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
// (負けた側の位置が古くても、次回に同じ範囲を読み直すだけ。件数は出現した transcript の集合で
// 数えているので、読み直しで増えることはない)。
// Windows では相手の rename やウイルス対策ソフトが掴んでいる間、rename が EPERM などで失敗する。
// 一時的なものなので少し待って数回やり直し、それでも駄目なときだけ失敗として扱う。
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const tmp = `${STATE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(s), 'utf8');
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, STATE); break; } catch (e) {
        if (i >= 2 || !TRANSIENT.has(e.code)) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// [from, to) のハッシュ。読み終えた範囲の先頭と末尾を前回と比べて、作り直しを見分けるのに使う
function rangeHash(fd, from, to) {
  const buf = Buffer.alloc(Math.max(0, to - from));
  const n = buf.length ? fs.readSync(fd, buf, 0, buf.length, from) : 0;
  return crypto.createHash('sha1').update(buf.subarray(0, n)).digest('hex');
}
const headOf = (fd, pos) => rangeHash(fd, 0, Math.min(EDGE, pos));
const tailOf = (fd, pos) => rangeHash(fd, Math.max(0, pos - EDGE), pos);

// prev(前回の記録)から先の、完結した行だけを読み、新しい記録・出てきた単価表に無いモデルのキーと、先頭からの通読か・
// 読み終えたかを返す。末尾の改行で終わっていない行は書き込み中のセッションのものなので読まずに残し、
// 次回そこから読み直す。
function scan(file, st, prev, deadline, stats) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = st.size;
    let pos = 0;
    // 先頭からの通読を前回途中で打ち切ったときに、そこまでに見つけていたモデル。続きを読み終えるまで
    // 持ち越し、通読が済んだ時点でこのファイルの所属をまとめて入れ替える
    let pending = null;
    // 前回の位置より短い、または読み終えた範囲の先頭か末尾が変わった = 作り直された。最初から読み直す。
    // 末尾のハッシュを持たない古い状態も一度だけ読み直しになる(出現した transcript の集合で数えるので件数は増えない)
    if (prev && prev.pos <= size && headOf(fd, prev.pos) === prev.head && tailOf(fd, prev.pos) === prev.tail) {
      pos = prev.pos;
      // 持ち越した間に単価表へ足されたものは落とす
      if (Array.isArray(prev.pending)) pending = prev.pending.filter(k => isUnknownKey(k));
    }
    const start = pos;
    const fromStart = start === 0 || !!pending;
    const models = new Set(pending || []);
    let unfinished = false;
    // 改行が来るまでの断片。改行が来たときに 1 回だけ連結する(1 行が何チャンクにも
    // またがるときに、チャンクごとにつなぎ直すと長さの 2 乗でコピーが増える)
    let carry = [];
    let carryLen = 0;
    while (pos < size) {
      // 期限は区切りごとに見る(巨大な 1 本で timeout を超えないため)。完結した行を 1 つも読めて
      // いないうちは打ち切らない(区切りより長い行の途中で止めると、次回も同じ位置からで永久に進まない)
      if (pos - carryLen > start && Date.now() >= deadline) { unfinished = true; break; }
      // 読めた n バイトしか使わないので、ゼロ埋めは要らない(初回の全量走査で数百 MB を無駄に埋める)
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      stats.bytes += n;
      const chunk = buf.subarray(0, n);
      // 改行(0x0A)は UTF-8 の多バイト文字の途中に現れないので、バイト列のまま切ってよい
      const last = chunk.lastIndexOf(0x0a);
      if (last < 0) { carry.push(chunk); carryLen += n; continue; }
      const data = carry.length ? Buffer.concat([...carry, chunk.subarray(0, last)]) : chunk.subarray(0, last);
      carry = [chunk.subarray(last + 1)];
      carryLen = n - last - 1;
      for (const line of data.toString('utf8').split('\n')) {
        // 大半の行は assistant でないので、JSON.parse の前に文字列で絞る
        if (!line.includes('"assistant"')) continue;
        let o;
        try { o = JSON.parse(line); } catch (e) { continue; }
        if (o.type !== 'assistant' || !o.message || !o.message.model) continue;
        // 単価表に無いものだけを modelKey() 済みのキーで持つ(pending にも既知のモデルを溜めない)
        const key = modelKey(o.message.model);
        if (isUnknownKey(key)) models.add(key);
      }
    }
    if (unfinished) stats.deferred++;
    const end = pos - carryLen;
    const rec = { pos: end, size: unfinished ? UNFINISHED : size, mtime: st.mtimeMs, head: headOf(fd, end), tail: tailOf(fd, end) };
    if (unfinished && fromStart) rec.pending = [...models];
    return { rec, models, fromStart, done: !unfinished };
  } finally {
    fs.closeSync(fd);
  }
}

// transcript の ID の一覧を、何セッション分かに数える。サブエージェントの transcript は親セッションの
// 下の別ファイルなので、ファイルの本数のままだと Agent を 10 回呼んだ 1 セッションが 11 と数えられる。
// 帰属の決め方は集計スクリプトと同じ fileIdentity() に任せる
function sessionCount(ids) {
  return new Set(ids.map(id => {
    const f = fileIdentity(path.join(ROOT, id));
    return `${f.project}/${f.sid}`;
  })).size;
}

function main() {
  // hook は Claude Code を使っていないマシンでも起動されうる。CLI の集計スクリプトと違い、
  // ここで落とすとセッション開始のたびにエラーが出るので黙って抜ける。
  if (!fs.existsSync(ROOT)) return;
  const deadline = Date.now() + BUDGET_MS;
  const prev = loadState();
  // files のキーは ROOT からの相対パスで、unknown の各モデルが持つ transcript の ID と同じもの。
  // 揃えておくと、最後に「まだ記録に残っている transcript」だけを数える処理が突き合わせ 1 回で済む
  const state = { files: {}, unknown: {} };
  const stats = { bytes: 0, opened: 0, deferred: 0, failed: [] };
  // モデルごとの出現 transcript。走査中は Set で持ち(重複判定を線形探索にしない)、保存時に配列へ戻す
  const seen = new Map();

  // 前回までに見つけたものは単価表に足されていれば消し、残りは引き継ぐ。キーは modelKey() 済みなので
  // isUnknownKey() で見る(isUnknownModel() に通すと modelKey() がもう一度掛かって別のキーになりうる)
  for (const [key, v] of Object.entries(prev.unknown)) {
    if (isUnknownKey(key) && v && Array.isArray(v.files)) seen.set(key, new Set(v.files));
  }
  // 読めなかったディレクトリ。配下のファイルは walk に出てこないが、消えたわけではないので
  // 前回の記録をそのまま引き継ぐ(落とすと、次回に全部を先頭から読み直し、件数からも外れる)
  const failedDirs = [];
  // walk は readdir だけでファイルを開かないので予算の対象にしない。時間を食うのは中身の読み込み
  const files = walk(ROOT, [], (dir, e) => {
    const id = path.relative(ROOT, dir);
    failedDirs.push(id + path.sep);
    stats.failed.push(`${id}${path.sep}(${e.code || e.message})`);
  });
  for (const [id, rec] of Object.entries(prev.files)) {
    if (failedDirs.some(d => id.startsWith(d))) state.files[id] = rec;
  }
  for (const f of files) {
    // 件数は「何セッションに出たか」で数え、そのためにモデルごとの出現 transcript を持つ。レコード数だと、
    // 作り直しや状態の破損で同じファイルを読み直したときに増えてしまう。ただし --resume / fork は履歴を
    // 複製した新しいセッションを作るので、同じ応答が 2 つとして数えられる(規模の目安で、利用回数ではない)
    const id = path.relative(ROOT, f);
    const p = prev.files[id];
    // 位置が数値でない記録(手で直した・壊れた状態)は使わない。文字列のまま足すと連結になって位置が壊れる
    const known = p && typeof p === 'object' && Number.isFinite(p.pos) ? p : null;
    try {
      const st = fs.statSync(f);
      if (known && known.size === st.size && known.mtime === st.mtimeMs) { state.files[id] = known; continue; }
      // 時間切れ。前回の記録は残し(次回そこから読む)、記録の無いファイルは次回に先頭から読む。
      // 変わっていないファイルは上で済んでいるので、ここで数えるのは実際に読み残したものだけ
      if (Date.now() >= deadline) {
        if (known) state.files[id] = known;
        stats.deferred++;
        continue;
      }
      stats.opened++;
      const r = scan(f, st, known, deadline, stats);
      state.files[id] = r.rec;
      // 先頭から読み直したファイルは、作り直されて前回のモデルを含まなくなっているかもしれないので、
      // 前回までの所属をいったん外してから今回読んだ分で入れ直す。ただし通読を途中で打ち切ったときは
      // 外さない(未読の後半にしか出ないモデルが、続きを読むまでの間だけ通知から消えてしまう)
      if (r.fromStart && r.done) for (const ids of seen.values()) ids.delete(id);
      for (const key of r.models) {
        if (!seen.has(key)) seen.set(key, new Set());
        seen.get(key).add(id);
      }
    } catch (e) {
      // 走査の途中で消えた transcript(別セッションの後片付けや cleanupPeriodDays の削除)は記録ごと落とす。
      // それ以外(ウイルス対策ソフトのロックによる EBUSY など)は、その 1 本だけ前回の記録のまま残して
      // 続ける。1 本の不調で全体を止めると、そのあいだ毎セッション通知が出なくなる
      if (e.code !== 'ENOENT') {
        if (known) state.files[id] = known;
        stats.failed.push(`${id}(${e.code || e.message})`);
      }
    }
  }
  // 記録に残っていない transcript(消えたもの)は数から外す。どの transcript にも残っていない
  // モデルは、集計でももう $0 として数えられないので通知をやめる
  for (const [key, ids] of seen) {
    const alive = [...ids].filter(id => id in state.files);
    if (alive.length) state.unknown[key] = { files: alive };
  }

  if (process.env.USAGE_TRACKER_MODEL_WATCH_STATS) {
    console.error(`model-watch: ${stats.opened} 本を開き ${stats.bytes} バイト読んだ`
      + (stats.deferred ? `(時間切れで ${stats.deferred} 本を次回に回した)` : ''));
  }
  if (stats.failed.length) console.error(`model-watch: 読めなかった transcript: ${stats.failed.join(', ')}`);

  // 通知は状態の保存より先に出す
  const keys = Object.keys(state.unknown);
  if (keys.length) {
    const list = keys.map(k => `${k}(${sessionCount(state.unknown[k].files)} セッション)`).join(', ');
    const msg = `usage-tracker: pricing.js に単価が無いモデルが transcript に出ている: ${list}。`
      + 'コスト集計では $0 として数えられるので、usage-tracker/transcript/pricing.js に単価を足すこと。';
    process.stdout.write(JSON.stringify({
      systemMessage: msg,
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg },
    }));
  }
  // 何も変わっていなければ書かない。毎セッション(resume / clear / compact も)全体を書き直すと、
  // 同時起動の rename 競合を自分から増やすことになる
  if (JSON.stringify(state) === JSON.stringify(prev)) return;
  try {
    saveState(state);
  } catch (e) {
    // 再試行しても保存できなかった。Claude Code は終了コード 0 のときしか stdout の JSON を読まないので、
    // 通知を出したなら 0 のまま終える(通知を捨ててまで不具合を見せない)。出していなければ 1 で見せる
    console.error(`model-watch: 状態を保存できなかった: ${e && e.message}`);
    if (!keys.length) process.exitCode = 1;
  }
}

// 自分の不具合でセッション開始を妨げない。SessionStart フックは終了コード 2 以外ならブロック
// しないので、原因を stderr に出して 1 で終わる(0 にすると不具合が誰にも見えない)
try {
  main();
} catch (e) {
  console.error(`model-watch: ${e && e.message}`);
  process.exitCode = 1;
}
