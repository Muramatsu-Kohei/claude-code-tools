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
    // 窓を使い切ったときだけ末尾を捨てる(その 1 行は次の読み出し位置で切れている)。
    // 無条件に捨てると、ファイル全体が窓に収まりかつ末尾に改行が無い場合 — 書き込み途中の
    // transcript が該当する — 唯一の完全なレコードまで落ち、非対話セッションを取り逃がす。
    if (n === bytes) lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (isNonInteractive(o)) return true;
    }
    // 1 行も解せなかった場合(1 レコードが 64KB を超える、壊れたファイル)は判定材料が
    // 無いので false に倒す。ここで文字列一致に落とすと、上で消したはずの誤検知が
    // いちばん危ない条件で戻ってくる: 先頭レコードが 64KB を超えるのは巨大な貼り付けや
    // tool_result を含むレコードで、印の文字列が本文に混ざりやすいのはまさにその型。
    // 実測でも該当ファイルは 15 本あり、すべて対話セッションだった。非対話実行の
    // transcript は短いので、この分岐に落ちること自体がほぼない。
    return false;
  } catch {
    return false;   // 読めないファイルはここで判定せず、本処理側の例外処理に任せる
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* 既に閉じている */ }
  }
}

// ファイル単位で「このファイルは集計対象か」を判定する関数を作る。判定結果はパスごとに
// 覚える(サブエージェントは同じ親を何本も引くため)。集計スクリプト 4 本がここを共有する:
// 同じ規則を各スクリプトで新設すると、片方だけ直る状態(PR #16 で見つけた漏れ)に戻る。
// 戻り値は null(対象) / 'session'(そのファイル自身が非対話) / 'parent'(親が非対話の
// サブエージェント)。呼び出し側が「除外した本数」を数えるとき、親の巻き添えで落ちた子まで
// セッションとして数えないよう区別している。
function makeNonInteractiveFilter() {
  const cache = new Map();
  const judge = (p) => {
    if (!cache.has(p)) cache.set(p, fs.existsSync(p) && isNonInteractiveSession(p));
    return cache.get(p);
  };
  return (file) => {
    // サブエージェントの transcript に非対話の印は付かない(印は親のレコードにある)。
    // 親だけ落として子を読むと、除外したはずの架空プロジェクトが委譲の数え上げごと復活する
    // ので、子は親を見て落とす。走査順は保証されないため「既に見た親」ではなく親ファイルを
    // 直接引く。パスの解釈は fileIdentity() に集約してある。
    const { parentFile } = fileIdentity(file);
    if (parentFile) return judge(parentFile) ? 'parent' : null;
    return judge(file) ? 'session' : null;
  };
}

// パスからファイルの帰属(プロジェクト・セッションID・メイン/サブ)を決める。集計 4 本が
// ここを共有する。サブエージェントの transcript は
// projects/<プロジェクト>/<親セッションID>/subagents/agent-*.jsonl に置かれるので、
// dirname をそのままプロジェクト名にすると "subagents" という架空のプロジェクトができ、
// サブエージェントへの指示が人間の送信として数えられてしまう。パスの第 1 要素を実プロジェクト
// とし、サブ側は親セッション ID に合流させる。
//
// メイン/サブをレコードの isSidechain でなくパスで決めるのは、フラグがレコード単位で
// 欠落しうるのに対し、パスはファイル単位で必ず決まるため(README の「サブエージェントの
// transcript は親セッションの下にある」を参照)。実測ではサブ側 1048 ファイルの assistant
// レコードすべてにフラグが付いており、逆に親ファイル側のインライン sidechain は 0 件だった
// ので、現データでは両者は一致する。将来ずれても取りこぼさない側に倒してある。
function fileIdentity(file) {
  const parts = path.relative(ROOT, file).split(path.sep);
  const i = parts.indexOf('subagents');
  const isSub = i > 0;
  return {
    project: parts[0],
    sid: isSub ? parts[i - 1] : path.basename(file, '.jsonl'),
    isSub,
    // 非サブでは null。呼び出し側が「サブかどうか」をこの有無で判定できるようにしている。
    parentFile: isSub ? path.join(ROOT, ...parts.slice(0, i - 1), `${parts[i - 1]}.jsonl`) : null,
  };
}

// --resume / fork は前の会話をそのまま次のファイルへ複製する。複製はレコードの uuid まで
// 一致するので、全ファイルで共有する集合に通してレコードごと落とす。集計 4 本で共有する。
//
// message.id で落としてはいけない: 1 回の応答は複数レコードに分かれて同じ message.id を
// 持つため、正当な分割まで消える(分割の除去は makeUsageCollector の仕事)。逆に assistant の
// ターンだけ直すと、送信数(user レコード)とツール回数(tool_use)は複製されたまま残り、
// 「1 送信あたりのターン数」は分母だけが水増しされて実態より小さく出る。だからレコード単位。
//
// どちらのセッションに計上されるかは読み順で決まるので、セッション単位の内訳は継ぎ元に寄る。
// 総計を正しくすることを優先した扱い。実測は 30 日で 8 ファイル / 632 レコード / $19。
// 期間を最大に取ると全 transcript 分の uuid を抱えるが、実測 1436 本 / 19.6 万レコードで
// 15.5 万件・ヒープ 84MB。線形に増えるだけなので放置してよい。
function makeUuidDedupe() {
  const seen = new Set();
  // 戻り値 true = 複製なので飛ばす。uuid を持たないレコードは判別できないので残す側に倒す。
  return (o) => {
    if (!o || o.uuid == null) return false;
    if (seen.has(o.uuid)) return true;
    seen.add(o.uuid);
    return false;
  };
}

// 分割された同一応答の usage を 1 件にまとめる収集器。呼び出し側はファイルごとに作る。
//
// 1 回の API 応答は content ブロック(thinking / text / tool_use)ごとに複数レコードへ
// 分けて書かれ、その全部が同じ message.id を持つ。素朴に足すとターン数もコストも約 1.9 倍に
// 膨らむので、usage 由来の値(ターン数・コスト・コンテキスト長・トークン内訳)は id ごとに
// 1 回だけ数える。tool_use はレコードごとに別のブロックなので、こちらに通してはいけない
// (ツール回数が減る)。
//
// 「どのレコードの usage を採るか」を最初の 1 件にしてはいけない。書かれ方が 2 通りあるため:
//   - メインの transcript は分割された全レコードが完成形の同じ usage を持つ
//     (実測 26294 組のうち食い違うのは 1 組)。どれを採っても同じ。
//   - サブエージェントの transcript は途中のレコードが output_tokens: 2 のプレースホルダで、
//     最後のレコードだけが完成形(実測 12089 組中 10111 組が食い違い、最後が最大なのは
//     12089 組すべて)。最初を採ると output トークンが 12.25M → 1.29M と 1/10 に落ちる。
// そこで output_tokens が最大のレコードを採る。「最後」でなく「最大」にするのは走査順に
// 依存しない形にしておくため(実データではどちらでも同じ結果になる)。
//
// 跨ファイルの複製(--resume / fork)は uuid でレコードごと落とす対象で、こちらの仕事では
// ない(makeUuidDedupe)。message.id を跨ファイルに広げると正当な分割まで消える。
//
// fileIsSub には fileIdentity().isSub を渡す。層の判定をパス優先にしつつ、レコードの
// isSidechain との論理和を取るのは、将来また親ファイルへインラインで書かれる形に戻っても
// メインに数え込まないため。和を id 単位で単調に畳むので、分割された応答の一部にしか
// フラグが無くても走査順に依存しない(先頭だけ見ると、完成形が捨てられてプレースホルダの
// output_tokens: 2 だけが「ほぼ 0 円のメインターン」として残る形になりうる)。
function makeUsageCollector(fileIsSub = false) {
  const byId = new Map();
  let anon = 0;
  return {
    // assistant レコードを渡す。戻り値は「その応答を初めて見たか」= ターンとして数えるか。
    // usage を持たない応答もターンではあるので、id の登録は usage の有無に依らず行う。
    add(o) {
      const msg = o && o.message;
      if (!msg) return false;
      // id が無いと分割かどうか判別できないので、まとめずに 1 件ずつ数える側に倒す。
      const key = msg.id != null ? msg.id : ` ${anon++}`;
      const u = msg.usage || null;
      const prev = byId.get(key);
      if (!prev) {
        byId.set(key, { usage: u, model: msg.model, isSub: fileIsSub || !!o.isSidechain });
        return true;
      }
      if (o.isSidechain) prev.isSub = true;
      if (u && (!prev.usage || (u.output_tokens || 0) > (prev.usage.output_tokens || 0))) {
        prev.usage = u;
        prev.model = msg.model;
      }
      return false;
    },
    // usage を持つ応答だけを id ごとに 1 件返す。ファイルを読み終えてから回す。
    *entries() {
      for (const v of byId.values()) if (v.usage) yield v;
    },
  };
}

function warnUnknownModels() {
  if (!unknownModels.size) return;
  const list = [...unknownModels.entries()].map(([m, n]) => `${m}(${n}件)`).join(', ');
  console.error(`\n警告: pricing.js に単価が無いモデルを $0 として集計した: ${list}`);
}

module.exports = {
  PRICE, ROOT, modelKey, cost, ctxLen, walk, transcriptFiles, records,
  isNonInteractive, isNonInteractiveSession, makeNonInteractiveFilter, makeUsageCollector,
  fileIdentity, makeUuidDedupe, warnUnknownModels,
};
