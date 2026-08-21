'use strict';
// 特定のディレクトリツリーを、許可したアカウント以外から触れないようにする。
//
// 想定している事故は「組織アカウントで書いたコードを、個人アカウントでログインしたまま
// 読ませてしまう」こと。Claude Code の認証情報(~/.claude/.credentials.json)はマシンに
// 1つしかなく、/login はマシン全体に即座に効く。一方で作業ツリーはアカウントと無関係に
// 到達できてしまうため、規約だけでは事故を防げない。
//
// == なぜ PreToolUse なのか ==
// 当初は SessionStart で `continue: false` を返して起動ごと止める設計を検討したが、
// 公式ドキュメントで SessionStart は "Context only / No blocking or decision control" と
// 明記されており、continue:false も exit 2 もセッションを止められない。ブロックできるのは
// PreToolUse の permissionDecision:"deny" だけなので、実際の防御はここに置く。
// SessionStart は警告を出すだけの補助に留める(session-start モード)。
//
// == 判定の考え方 ==
// フックの入力にアカウント情報は含まれないので、credentials の subscriptionType を読む。
// これはプラン種別であってアカウント identity ではないが、「組織は Team・個人は Pro」と
// いう構成なら判別条件として成立する。判別できないときは安全側(拒否)に倒す。
// 素通しになって気づかないより、止まって気づけるほうがよい。
//
// 最優先事項は「守れないなら止める」。ただし保護ツリーに関係ないツール呼び出しまで
// 巻き添えにはしない。判定できたものだけを拒否し、それ以外は通常の権限フローに委ねる。

const fs = require('fs');
const os = require('os');
const path = require('path');

// HOME として使える値か。空文字・空白のみは「無い」のと同じに扱う。os.homedir() や
// 環境変数は「存在するが空文字」を返すことがある(Windows で実測)。素通しにすると
// この先のパスが cwd 相対に解決され、設定の無い場所では保護ルールが 0 件になって
// 無言で全部通ってしまう(credentials.js 側にも同じ検証がある)。
function usableHome(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

// credentials の場所と読み方は swap.js と共有する(credentials.js のコメント参照)。
//
// require を素通しで書かないのは、これがトップレベルで投げると末尾の catch
// (異常終了を受け止めて保護側へ倒す仕組み)より先にプロセスが死ぬため。フックは
// 標準出力に何も出さないまま exit 1 で終わり、Claude Code はブロックせず処理を続ける。
// つまり credentials.js を隣に置き忘れた構成では、保護が丸ごと外れたことに誰も
// 気づけないまま素通しになる。読めなくても「判別不能」として動き続けるほうが安全。
//
// require が成功しても中身までは保証されない。account-guard.js を置いたディレクトリに
// 無関係な・古い credentials.js が同名で存在すると require 自体は成功するが、HOME 等が
// 期待する形でないことがあり、そのまま使うとこの先の path.join(HOME, ...) がトップレベルで
// 例外を投げて同じ無言 fail-open を起こす。必要なエクスポートの形を検証し、欠けていれば
// 「読み込めなかった」場合とまったく同じ経路(下の catch)に合流させる。
let credentials = null;
// 読めなかった理由は捨てない。ここで落ちると「正しいアカウントでログインしているのに
// 全部 deny される」状態になり、原因は隣のファイルなのに拒否メッセージが /login を促すと、
// 何度ログインし直しても直らない袋小路に入る(拒否の文面で真因を出すために使う)。
let credentialsLoadError = null;
try {
  const loaded = require('./credentials');
  if (
    !loaded
    || !usableHome(loaded.HOME)
    || typeof loaded.CREDENTIALS !== 'string' || !loaded.CREDENTIALS
    || typeof loaded.ACCOUNT_UNKNOWN !== 'string' || !loaded.ACCOUNT_UNKNOWN
    || typeof loaded.currentAccount !== 'function'
    // readCredentials / hasUsableCredentials は credentialsState() が使う。ここで検証して
    // おかないと、欠けている場合に credentialsState() の catch が拾って「credentials が
    // 壊れている」という別の案内に落ち、真因(credentials.js の形式不正)がどこにも出なくなる。
    // hasUsableCredentials を見落としていた頃は、それだけを欠く版が隣にあると、健全な
    // credentials に対して「失われる認証情報はない」と断言して /login を勧めていた
    // (まだ退避していないアカウントなら、その時点で refreshToken が失われる)。
    || typeof loaded.readCredentials !== 'function'
    || typeof loaded.hasUsableCredentials !== 'function'
    // hasRecoverableToken も同じ理由で必須。欠ける版が隣にあると credentialsState() の
    // catch が拾って「読み取れなかった」の案内に落ち、真因が出ないまま文面だけが変わる。
    || typeof loaded.hasRecoverableToken !== 'function'
    // probeFile は「ファイルが無い」と「あるのに読めない」を分ける唯一の場所。欠ける版が
    // 隣にあると loggedOut の判定が TypeError で落ち、下に書いてあるのと同じ無言 fail-open の
    // 経路(denyMessage を組み立てられないまま reportCrash に抜ける)に入る。
    || typeof loaded.probeFile !== 'function'
    // rawHasRecoverableToken は credentialsState() が生の中身を分類するのに使う。ここが
    // 抜けていた頃は、欠ける版が隣にあると credentialsState() が TypeError で落ち、
    // denyMessage を組み立てられないまま main() を抜けて reportCrash に到達していた。
    // reportCrash は cwd しか見ないので、対象パス指定の違反は無出力(exit 0)で許可されていた
    // ——このブロックが防ぐはずの無言 fail-open そのもの。swap.js は最初から検証しており、
    // 二者のリストがドリフトしていた(下のテストで両者が呼ぶメンバーを機械的に照合する)。
    || typeof loaded.rawHasRecoverableToken !== 'function'
  ) {
    throw new Error('credentials.js の形式が不正です(HOME / CREDENTIALS / ACCOUNT_UNKNOWN / currentAccount / readCredentials / hasUsableCredentials / hasRecoverableToken / rawHasRecoverableToken のいずれかが欠けています)');
  }
  credentials = loaded;
} catch (e) {
  // 単体配置・コピー漏れ・権限・形式不正。下のフォールバックで拒否側に倒す
  credentialsLoadError = e;
}

// HOME の導出だけは自前でも持つ(テストが USERPROFILE / HOME を差し替えるため、
// os.homedir() ではなく環境変数を先に見る。credentials.js と同じ規約)。
// credentials.js から受け取った値も usableHome に通す。上の検証で弾いているので通常は
// 有効なはずだが、二重チェックの費用は無視できるほど小さく、検証漏れの経路を一本化できる。
//
// 最後の砦を '.' にしないのは credentials.js と同じ理由で、こちらではさらに重い:
// 両方の環境変数を持たない・空文字な環境で config がカレントディレクトリ配下として
// 解決されると、ルールが 1 つも読めず、保護ツリーへの操作が黙って許可される
// (exit 0・出力なし)。credentialsLoadError を足して塞いだはずの「保護が無言で外れる」を、
// HOME 側から作っていた。
const HOME = usableHome(credentials && credentials.HOME)
  || usableHome(process.env.USERPROFILE)
  || usableHome(process.env.HOME)
  || usableHome(os.homedir());

// 環境変数も os.homedir() も使える値を返さない、極端に壊れた環境。相対パスへ逃げると
// 上と同じ無言 fail-open を再現するので逃げない。CONFIG はダミー値にして path.join の
// トップレベル即死だけ避け、以降は homeUnresolved で強制的に拒否側へ倒す(loadConfig 参照)。
const homeUnresolved = !HOME;
const ACCOUNT_UNKNOWN = credentials ? credentials.ACCOUNT_UNKNOWN : 'unknown';
// credentials.js が無ければ誰のログインかを知る手段が無い。ACCOUNT_UNKNOWN は判定側が
// 拒否に倒す値なので、保護ツリーへの操作は deny され、設定漏れに気づける。
const currentAccount = credentials ? credentials.currentAccount : () => ACCOUNT_UNKNOWN;

const GUARD_DIR = path.join(homeUnresolved ? '(home-unresolved)' : HOME, '.claude', 'account-guard');
const CONFIG = path.join(GUARD_DIR, 'config.json');

// 一時解除(unlock)の状態。unlocks.json が現に効いている解除の集合で、unlock.log は
// 追記型の履歴。config.json と同じディレクトリに置くのは、どちらも「ガードの判定を変える
// 設定」で、保護も後始末も同じ場所で扱えるため。
const UNLOCKS = path.join(GUARD_DIR, 'unlocks.json');
const UNLOCK_LOG = path.join(GUARD_DIR, 'unlock.log');
// 状態ファイルの読み→書き戻しを直列化するためのロック(withUnlockLock 参照)。
const UNLOCK_LOCK = path.join(GUARD_DIR, 'unlocks.lock');

// 解除エントリを残す日数。解除は sessionId で照合するので他セッションのぶんは元々効かない。
// これは失効のためではなく、ファイルが際限なく伸びるのを防ぐためだけの掃除。
// 有効期限を設けないのは意図的で、想定用途(リミット回復まで数時間)の途中で切れる期限は
// 再解除を促し、「とりあえず解除」を習慣化させる。歯止めのつもりが逆に効く。
const UNLOCK_KEEP_DAYS = 7;

// 既定では何も保護しない。守るべきツリーは環境ごとに違ううえ、実在するパスを
// 公開リポジトリに焼き込みたくないため、設定ファイルで明示させる。
// 設定していない状態に気づけるよう `status` サブコマンドで確認できるようにしてある。
const DEFAULT_RULES = [];

// 現在ログイン中のアカウントの取得(currentAccount)は credentials.js にある。
// トークン本体には触れないし記録もしない。

// パスを比較可能な形に揃える。区切りをスラッシュに統一し、ドライブ文字の大小と
// 末尾スラッシュの差を吸収する。JSON.stringify を通した文字列ではバックスラッシュが
// `\\` に増えるため、連続分もまとめて1つに潰す。
function normalize(p) {
  return String(p)
    .replace(/\\+/g, '/')
    // 連続する区切りは1つに畳む。`/c//org-tree` や `C://org-tree` のように区切りを
    // 重ねるだけで、下の書き換えとツリー名の突き合わせをすり抜けられるため。
    .replace(/\/{2,}/g, '/')
    // Git Bash / MSYS のドライブ表記を Windows 形式に寄せる。この環境の Bash ツールは
    // Git Bash なので、`/c/<tree>` や `/cygdrive/c/<tree>` でも同じ場所に到達できる。
    // 変換しないと表記を替えるだけで保護をすり抜けられる(実際に素通りしていた)。
    //
    // 直前の文字には「識別子の一部でないこと」だけを求める。区切り記号を列挙する形にすると
    // リダイレクト(`</c/...`、`>/c/...`)やブレース展開(`{/c/...`)が漏れる。実際、
    // 列挙していた頃は `echo x >/c/<tree>/f` で保護ツリーへの書き込みが通っていた。
    // パスの途中にある `/c/`(例 `C:/x/c/tree`)は直前が英数字なので巻き込まない。
    // ドライブのコロン直後(`D:/c/tree`)は Windows パスの一部なので変換しない。
    // ここを含めると `d:c:/tree` という壊れた文字列になり、ツリー名に当たって誤検知する。
    .replace(/(^|[^a-z0-9_.:-])\/cygdrive\/([a-z])\//gi, '$1$2:/')
    .replace(/(^|[^a-z0-9_.:-])\/([a-z])\//gi, '$1$2:/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

// 保護ツリーを指す絶対パスが文字列中に現れるか。
//
// 単純な部分一致にすると `c:/org-tree` が `c:/org-treeo` にも当たってしまうので、
// ツリー名の直後がパス区切りか非識別子文字であることまで見る。
// 逆にツリー名だけ(`org-tree`)での一致は採らない。ドキュメントや会話でツリー名に
// 言及しただけで拒否され、誤検知のほうが実害になるため。
function mentionsTree(haystack, tree) {
  const t = normalize(tree).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(t + '(?![a-z0-9_.-])').test(normalize(haystack));
}

// パス風のトークンをどこで切るか。シェルのメタ文字はパスの一部になりえないので、必ず
// トークンの終わりとして扱う。切り出しを行う 4 箇所(treeRefsIn / ABSOLUTE_PATH_TOKEN /
// MSYS_PATH_TOKEN / RELATIVE_PATH_TOKEN)で同じものを使う ―― ここが箇所ごとにずれていると、
// 片方だけが知っている書き方が抜け道になる。
//
// リダイレクト(`>` `<`)が抜けていた頃は、隣り合う 2 つのパスが 1 つのトークンに結合し、
// 前方一致の範囲判定が「前半が範囲内なら後半も範囲内」と誤って答えていた。`cp <範囲内>/x
// <範囲外>/y` は拒否できるのに、空白を詰めた `cat <範囲内>/x><範囲外>/y` は通る、という
// 空白ひとつで結論が変わる状態になっていた(解除の状態ファイルの一致判定も同じ理由で外れた)。
const TOKEN_STOP = '"\'`\\s,;|&()<>[\\]{}';
const NOT_STOP = `[^${TOKEN_STOP}]`;

// 切り出したトークンの「直後の文字」が、そこで本当にパスが終わっていることを示すか。
// シェルの区切り(空白・`;` `|` `&` `<` `>`)なら終わり。それ以外の停止文字 ―― ブレース展開の
// `{`、glob の `[`、カンマ、括弧 ―― は前後を連結したり別名へ展開したりするので、切り出した
// 文字列は実際に触る場所の「先頭部分」でしかない。
//
// この区別を持たなかった頃、`tool-a` だけを解除した状態で `<tree>/tool-a{,bc}` と書くと、
// 参照が `<tree>/tool-a` に切り詰められ、前方一致の範囲判定が「解除の範囲内」と答えて
// 兄弟の `tool-abc` に触れていた(`tool-a[bc]` でも `tool-a,bc` でも同じ)。切り詰めは
// 解除の範囲判定と解除の状態ファイルの一致判定の両方を外すので、印を 1 箇所で付けて
// 双方に配る ―― 箇所ごとに終端の見方を決めると、片方だけが知っている書き方が抜け道になる。
const SAFE_TOKEN_END = /[\s;|&<>]/;

// text の index から length 文字を切り出したトークンが、まだ伸びうるか。
function isTruncated(text, index, length) {
  const after = text[index + length];
  return after !== undefined && !SAFE_TOKEN_END.test(after);
}

// 正規表現で切り出したトークンを、切り詰めの印付きで返す。切り出しを行う箇所すべてが
// これを通ることで、印の付け方が 1 箇所に集まる。
function tokensIn(text, re) {
  const out = [];
  for (const m of text.matchAll(re)) {
    out.push({ token: m[0], truncated: isTruncated(text, m.index, m[0].length) });
  }
  return out;
}

// 文字列に現れる「ツリーを指す参照」をすべて取り出す。mentionsTree が真偽しか返さないのに対し、
// こちらは当たった箇所そのものを返す。解除の判定に要る: シェルのコマンド文字列は 1 本で複数の
// パスに触れるので、「ツリーに当たったか」だけを見ると、`tool-a` だけを解除した状態で
// `cp <tree>/tool-a/x <tree>/tool-b/` のような呼び出しまで通してしまう。
//
// 一致の条件(ツリー名の直後が識別子の文字でないこと)は mentionsTree と同じにする。境界の
// 見方がずれると「拒否には当たるのに解除の判定では見えない参照」ができ、そこだけ素通りする。
// 切り詰めの印(SAFE_TOKEN_END のコメント)を付けて返すのは、前方一致の範囲判定が
// 「先頭部分だけを見て範囲内」と答えるのを呼び出し側で止められるようにするため。
function treeRefsIn(text, tree) {
  const t = normalize(tree).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const s = normalize(text);
  // ツリー名に続く部分は、シェルの区切りに当たらない限りパスの一部として取り込む。
  return tokensIn(s, new RegExp(`${t}(?![a-z0-9_.-])${NOT_STOP}*`, 'g'))
    .map((m) => ({ value: m.token, truncated: m.truncated }));
}

// cwd がツリーの内側か。ツリー自身もツリー配下として扱う。
function isInsideTree(cwd, tree) {
  const c = normalize(cwd);
  const t = normalize(tree);
  return c === t || c.startsWith(t + '/');
}

// ドライブ文字から始まる絶対パスか。
//
// issue #6 のとおり path.isAbsolute は Windows でも `/org-tree` に true を返すため、それだけを
// 根拠にすると「ドライブ不問・パスの途中でも一致する」広すぎる範囲を作れてしまう。config.json の
// tree 側では過剰に拒否する方向の誤りで済むが、解除の範囲に同じ緩さを持ち込むと逆向き ――
// 意図より広く保護が外れる ―― になる。解除側は書くときも読むときもドライブ文字を必須にする。
function hasDriveLetter(p) {
  return /^[a-z]:[\\/]/i.test(String(p));
}

// 解除を紐づけるセッションの ID。
//
// フック入力の session_id が本筋。あればそれだけを使い、環境変数は見ない。環境変数は
// フック入力を持たない `guard unlock` のための代替であって、両方を候補にして「どちらかに
// 一致すれば有効」とすると、CLAUDE_CODE_SESSION_ID に別セッションの値が残っている環境
// (シェルを引き継いだ起動、外から明示的に設定された場合)で、そのセッションの解除が
// 今のセッションにも効いてしまう。解除の漏れは保護が緩む向きの誤りなので、確かな方を採る。
function sessionCandidates(input) {
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const fromHook = pick(input && input.session_id);
  if (fromHook) return [fromHook];
  const fromEnv = pick(process.env.CLAUDE_CODE_SESSION_ID);
  return fromEnv ? [fromEnv] : [];
}

// 現に効いている解除のパス一覧。
//
// 読めない・壊れている・セッションを特定できないときは空を返す。つまり解除が無かったことに
// なり、判定は従来どおり拒否側に倒れる。ここで例外を投げると reportCrash の縮小判定に落ちて
// かえって保護が緩むので、投げずに握り潰すのが正しい向き。
function activeUnlocks(input) {
  const ids = sessionCandidates(input);
  if (!ids.length) return [];
  try {
    const data = JSON.parse(fs.readFileSync(UNLOCKS, 'utf8'));
    if (!Array.isArray(data?.unlocks)) return [];
    return data.unlocks
      .filter((u) => u && ids.includes(u.sessionId) && typeof u.path === 'string' && hasDriveLetter(u.path));
  } catch {
    // 未作成(解除なし)・壊れている・権限。いずれも「解除されていない」として扱う。
    return [];
  }
}

function unlockedPaths(input) {
  return activeUnlocks(input).map((u) => u.path);
}

// このパスが解除の範囲に入っているか。解除は「ツリー配下の任意のディレクトリ」単位なので、
// 判定はツリーと同じ前方一致(isInsideTree)を使う。
function coveredByUnlock(value, unlocked) {
  return unlocked.some((u) => isInsideTree(value, u));
}

// ツリーに当たった対象が、すべて解除の範囲に収まっているか。1 つでも外れていれば解除しない。
//
// 厳しめだが、`tool-a` を解除した状態で `tool-a` と `tool-b` を同時に触るコマンドが通る穴を
// 塞ぐにはこれが要る。kind が 'text'(シェルのコマンド文字列そのもの)の対象は、それ自体を
// パスとして扱えないので、中に現れるツリー参照を取り出して 1 つずつ見る。参照を 1 つも
// 取り出せなかったときは通さない ―― 拒否には当たったのに解除の判定では見えない、という
// 食い違いが起きている状態なので、安全側に倒す。
//
// 切り詰められた参照(SAFE_TOKEN_END のコメント)も同じく通さない。前方一致は「先頭が
// 範囲内なら全体も範囲内」と答えるが、切り詰められた文字列の続きは展開してみるまで
// 分からず、範囲内である根拠がない。
// 対象の参照が切り詰められていて、範囲内である根拠が得られないか。
//
// 「解除を通さない条件」と「拒否の見出しを判定不能にする条件」は同じものを指す。別々に
// 書くと片方だけ直って食い違い、拒否はされるのに見出しは断定形、という読み手が判断を
// 誤る状態になる(SAFE_TOKEN_END のコメントにある「印を 1 箇所で付けて双方に配る」と同じ理由)。
function hasTruncatedRef(t, tree) {
  if (t.kind === 'path') return t.truncated;
  return treeRefsIn(t.value, tree).some((r) => r.truncated);
}

function unlockCoversTargets(tree, hits, unlocked) {
  if (!hits.length) return false;
  return hits.every((t) => {
    if (hasTruncatedRef(t, tree)) return false;
    if (t.kind === 'path') return coveredByUnlock(t.value, unlocked);
    const refs = treeRefsIn(t.value, tree);
    return refs.length > 0 && refs.every((r) => coveredByUnlock(r.value, unlocked));
  });
}

// ツールごとに「操作対象のパス」が入るフィールド。判定はここだけを見る。
//
// 当初は tool_input を丸ごと文字列化して走査していたが、それでは書き込む内容や指示文に
// ツリー名が出てくるだけで拒否されてしまう。実際、このツリーについて書いたドキュメントを
// 編集しようとして止まった。保護ツリーのファイルには一切触れていないのに拒否されるのは
// 明確な誤りで、日常の邪魔になる分だけガードを外したくなる圧力になる。
//
// Glob / Grep はパスが入るフィールドが複数ある。`path` だけを見ていた頃は
// `Glob{pattern:"C:/tree/**"}` や `Grep{glob:"C:/tree/**"}` が素通りし、保護ツリーの
// 列挙と内容の読み取りができてしまっていた。
// ただし Grep の `pattern` は検索語(正規表現)であってパスではないので見ない。
// ここを含めると、ツリー名を検索語にしただけで拒否される上記の誤検知が復活する。
const PATH_FIELDS = {
  Read: ['file_path'],
  Edit: ['file_path'],
  Write: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path', 'pattern'],
  Grep: ['path', 'glob'],
};

// シェルと委譲は文字列全体を見る。パスがどの位置に現れるか決まっていないうえ、
// 「保護ツリーを読め」という指示そのものを止めたいため。
const COMMAND_FIELDS = {
  Bash: ['command'],
  PowerShell: ['command'],
  Agent: ['prompt', 'description'],
  Task: ['prompt', 'description'],
};

// 文字列に埋もれた絶対パス。ドライブ文字から始まる形。
const ABSOLUTE_PATH_TOKEN = new RegExp(`[a-z]:[\\\\/]${NOT_STOP}*`, 'gi');

// Git Bash / MSYS 形式の絶対パス。直前がドライブのコロンや識別子の文字なら、それは
// Windows パスの途中(`D:/c/...`)なので拾わない。
const MSYS_PATH_TOKEN = new RegExp(`(?<![a-z0-9_.:\\-])(?:/cygdrive)?/[a-z]/${NOT_STOP}*`, 'gi');

// 文字列に現れるホーム表記(`~` / `$HOME` / `%USERPROFILE%`)をホームディレクトリへ展開する。
//
// path.resolve はこれらを知らないので、展開しないまま解決すると `<cwd>/~/.claude/...` という
// 実在しないパスになる。トークンの切り出し側も `~` や `$` で始まる形を 1 つのパスとしては
// 認識しない。つまり展開は「切り出す前の文字列」に対して行う必要がある。
// これが無かった頃は、解除の状態ファイルへの書き込み遮断が
// `echo {} > ~/.claude/account-guard/unlocks.json` という、ホームを指すいちばん普通の
// 書き方だけを素通ししていた(絶対パスで書けば拒否される、という食い違い)。
function expandHomeIn(value) {
  if (!HOME || typeof value !== 'string') return value;
  // パスの先頭として現れる形(直後が区切り)だけを展開する。`~user` や `$HOME_DIR` のような
  // パスでない語まで置き換えると、無関係な文字列を cwd 配下のパスとして解決してしまう。
  // 置換は関数で返す ―― HOME に `$&` 等が含まれると文字列指定では化ける。
  return value.replace(/(?<![a-z0-9_.\-])(?:~|\$\{?HOME\}?|%USERPROFILE%|\$env:USERPROFILE)(?=[\\/])/gi, () => HOME);
}

// MSYS 形式を Windows 形式へ直す。そのまま path.resolve に渡すと `C:\c\...` と
// 誤変換されるが、ドライブ表記に直してからなら渡せる。これをしないと `/c/x/../<tree>` の
// ように `.` / `..` を含む形が畳まれず、文字列の突き合わせをすり抜ける。
function fromMsys(token) {
  const m = /^(?:\/cygdrive)?\/([a-z])\/(.*)$/i.exec(token);
  return m ? `${m[1]}:/${m[2]}` : null;
}

// 文字列に埋もれた相対パス。上に登る `../` 形と、cwd の配下へ降りていく形の両方を拾う。
//
// 当初は `../` を含む形だけを見ていた。降りていく形は cwd の配下にしか届かず、cwd が
// 保護ツリーの内側なら isInsideTree が先に拒否する、という理屈だったが、cwd が保護ツリーの
// 「親」にいる場合を見落としていた。`C:/` で作業していると `Bash{cat <tree>/secret}` は
// 文字列全体にも絶対パスの形にも当たらず素通りする一方、同じ指定でも Read はフィールドの
// 値として解決されて拒否される、という食い違いが起きていた。
//
// パス区切りを含むトークンだけを拾うのは、区切りのない語まで cwd 基準で解決すると、
// 散文中でツリー名に言及しただけで拒否される誤検知(PATH_FIELDS のコメント)が復活するため。
// 直前が識別子の文字・コロン・区切りなら拾わない。これがないと `D:/<tree>` や
// `https://host/<tree>` の途中を切り出し、別ドライブや URL を cwd 配下へ解決してしまう。
const RELATIVE_PATH_TOKEN = new RegExp(`(?<![a-z0-9_.:\\-\\\\/])[a-z0-9_.\\-]*(?:[\\\\/]${NOT_STOP}*)+`, 'gi');

// 相対パスを cwd 基準の絶対パスへ直す。解決できない値(null 文字を含む等)は捨てる。
function resolveFrom(cwd, value) {
  try {
    return path.resolve(cwd || process.cwd(), expandHomeIn(value));
  } catch {
    return null;
  }
}

// 判定対象にする文字列を取り出す。
//
// 相対パス指定は必ず cwd 基準で解決してから突き合わせる。これをしていなかった頃は
// 保護ツリーの外の cwd から `Read{file_path:"../../<tree>/secret"}` と上に登る指定が
// 素通りしていた(絶対パス版だけが拒否され、テストも絶対パスしか見ていなかった)。
// trees は設定中の保護ツリー一覧。区切りを含まない「裸のツリー名」を拾うためだけに使う
// (下のコメント参照)。判定そのものは呼び出し側がルールごとに行う。
// 判定対象を 1 件ずつ表す。kind は解除の判定でだけ意味を持つ(拒否そのものはどちらも同じに扱う)。
//   'path' … パスとして解決済み、またはパスとして書かれた値。そのまま範囲判定にかけられる
//   'text' … シェルのコマンド文字列そのもの。1 本に複数のパスが混ざりうるので、範囲判定は
//            中のツリー参照を取り出してから行う(unlockCoversTargets 参照)
//   truncated … 切り出しがシェルの区切り以外で終わっている(SAFE_TOKEN_END のコメント)。
//                実際に触る場所の先頭部分でしかないので、前方一致の範囲判定に使ってはいけない
const asPath = (value, truncated = false) => ({ value, kind: 'path', truncated });

// `cd <dir>` を含むコマンドは、それ以降の相対パスが移動先を基準に解決される。フック入力の
// cwd だけで解決していた頃は、`cd <tree>/tool-a && cat ../tool-b/secret` のように「移動して
// から相対で指す」形が別の場所(cwd の親)に解決されて素通りしていた。同じ場所を絶対パスで
// 書けば拒否されるので、書き方だけで結論が変わっていた。
//
// 実行順や条件分岐は再現しない。現れた移動先をすべて独立した基準として積み、相対トークンは
// そのすべてで解決する。過剰に積む(実際には移動しない基準でも解決してしまう)向きの誤りに
// 倒すのは、順序を追う実装にすると、その解析の粗さがそのまま抜け道になるため。
// 先頭の区切りには改行も含める。`&&` だけを見ていた頃は、同じ内容を複数行で書くと cd が
// 拾われず、相対パスがフック入力の cwd で解決されて素通りしていた(ヒアドキュメントや
// 複数行のスクリプトは実際にこの形で来る)。`m` フラグではなくクラスに `\n` を足すのは、
// `^` の意味を変えると「行頭のように見えるだけの位置」まで拾い、基準が増えすぎるため。
// cd の直前に認める位置。行頭とコマンド区切りに加えて「空白のあと」も認める。区切りだけを
// 見ていた頃は、ラッパーの引数として渡された cd が丸ごと見えなかった ―― 引用符は判定より前に
// 外れるので `bash -c "cd .. && cat tool-b/secret"` は `bash -c cd .. && …` になり、cd の直前が
// `-c ` で区切りにも行頭にも当たらない。基準が cwd のままになるため相対パスが解除範囲内に
// 解決され、解除したディレクトリの外を実際に読めていた(`sh -c`・`eval`・`sudo` でも同じ)。
// ラッパーを名前で列挙しないのは、列挙から漏れた 1 つがそのまま穴として残るため。
// 空白のあとをすべて候補にすると、コマンド位置でない `cd` という語まで基準に積むことになるが、
// それは基準が増える向きの誤りで、範囲判定は候補が増えるほど拒否側に倒れる(上の設計方針)。
const CD_HEAD = '(?:^|[;&|(\\n]|\\s)\\s*(?:cd|chdir|pushd|set-location|sl|push-location)\\s+';

const CD_COMMAND = new RegExp(`${CD_HEAD}(?:-[a-z]+\\s+)*(${NOT_STOP}+)`, 'gi');

// 解除の範囲判定に使えるのは「どこを触るかが字面から決まる」コマンドだけ。cd の移動先に
// 実行時にしか決まらない要素($VAR / ${VAR} / %VAR% / $(...) / `...` / (Get-Item …))が
// 入ると、相対パスの基準が定まらない。resolveFrom はそれを字面どおりのディレクトリ名として
// 解決してしまうので、解除したディレクトリの「配下」に実在しない基準ができ、ツリー内のどこを
// 指す相対パスも解除の範囲内に見えていた ―― `tool-a` だけを解除した状態で
// `cd $PARENT && cat tool-b/secret` が通り、兄弟ディレクトリが読めていた。
//
// 移動先の切り出しは CD_COMMAND と分ける。CD_COMMAND のキャプチャは TOKEN_STOP で切れるので、
// バッククォートや `$(` で始まる移動先はキャプチャに現れない(`` cd `dirname $PWD` `` では
// CD_COMMAND 自体がマッチしない)。ここでは次のコマンド区切りまでを移動先の記述として丸ごと
// 見る。引用符を外す前の値を見るのも同じ理由で、外した後では `` `pwd` `` が `pwd` という
// ディレクトリ名に化け、実行時要素だったことが分からなくなる。
//
// `(` まで実行時要素に数えるのは PowerShell の `(Get-Item …).FullName` を取り逃さないため。
// 引用符なしで括弧を含むディレクトリ名を書くことはまず無いが、誤って数えても拒否側に倒れる
// (解除が効かなくなるだけで、保護が緩む向きには倒れない)。
const CD_DEST_RAW = new RegExp(`${CD_HEAD}([^;&|\\n]*)`, 'gi');
const RUNTIME_DEST = /[$%`(]/;

function hasRuntimeCd(toolName, toolInput) {
  const ti = toolInput ?? {};
  // パスのフィールドが決まっているツールでは、そのフィールドが操作対象そのもので、相対パスの
  // 基準は cwd しかない ―― cd は関係しない。ここで引数全体を見ると、`Write` の content に
  // 書いた `cd $x` のような「文面」で解除が効かなくなる(targetStrings が PATH_FIELDS を
  // 優先するのと同じ理由で、判断の根拠にしてよいのは操作対象のフィールドだけ)。
  if (PATH_FIELDS[toolName]) return false;
  const commandFields = COMMAND_FIELDS[toolName];
  // 知らないツールは targetStrings と同じく引数全体を見る。どの引数がコマンドかは判断
  // できないので、cd の記述がどこに入っていても拾える形に倒す。
  //
  // ただし `{"command":"cd $X && …"}` のように引用符が cd の直前に来る形は、移動先の切り出しに
  // 当たらない(CD_HEAD が行頭・区切り・空白のいずれかを要求するので、`"` の直後は当たらない)。いまはそれでも穴にならない ―― 知らないツールから
  // 取り出した参照は JSON の `"` で必ず切り詰め扱いになり(SAFE_TOKEN_END)、解除の範囲判定を
  // 通らないので、解除の有無に関係なく拒否される。逆に言えば、JSON の `"` を切り詰めの対象外に
  // する(= 知らないツールでも解除を効かせる)なら、この検出も同時に JSON 対応させなければ
  // そこが穴になる。
  const texts = commandFields
    ? commandFields.map((f) => ti[f]).filter((v) => typeof v === 'string')
    : [JSON.stringify(ti)];
  return texts.some((t) => [...t.matchAll(CD_DEST_RAW)].some((m) => RUNTIME_DEST.test(m[1])));
}

// 相対パスの解決に使う基準ディレクトリ一覧。先頭は必ずフック入力の cwd。
function cwdCandidates(texts, cwd) {
  const out = [cwd];
  for (const text of texts) {
    for (const m of text.matchAll(CD_COMMAND)) {
      // MSYS 形式のまま path.resolve に渡すと `C:\c\...` に化けるので、先に直す(fromMsys)。
      const dest = resolveFrom(cwd, fromMsys(m[1]) || m[1]);
      if (dest && !out.includes(dest)) out.push(dest);
    }
  }
  return out;
}

// ブレース展開は 1 本の記述を複数のパスに分けて実行する。切り出しはブレースをトークンの
// 終わりとして扱う(SAFE_TOKEN_END)ので、ツリー名そのものが割れた `C:/{org-tree,other}/secret`
// からは `C:/` までしか取れず、コマンド文字列にも連続した `c:/org-tree` は現れない ――
// ツリーへの言及が 1 つも見つからないまま、解除の範囲どころか拒否そのものが素通りする。
// 判定の前に展開して、展開後の文字列も判定材料に加える。
//
// 展開しきることは狙わない(入れ子・連番・掛け合わせは際限がなく、正確に真似ようとするほど
// 実装のずれが抜け道になる)。実際に書かれる単純な `{a,b}` を左から順に潰し、深さと本数の
// 上限で打ち切る。
//
// 打ち切ったことは呼び出し側に伝える。ここが真偽を返さず黙って諦めていた頃は、上限そのものが
// 抜け道だった ―― ツリー名が割れているとき、判定材料は展開後の variant しかないのに、
// 上限を超えた variant は誰も見ないまま捨てられていた(`C:/{d0,…,d39,<ツリー名>}/secret` の
// ように選択肢を 32 個並べる、`{a,{b,{c,{d,{e,<ツリー名>}}}}}` のように 5 段重ねる、の
// どちらでも素通りした)。上限を上げても同じ手が使えるので、打ち切りは「判定できなかった」
// として扱い、拒否側に倒すしかない(targetStrings の undecidable)。
// 数える対象は「シェルが展開するブレース」に絞る。JS / JSON のオブジェクトリテラルや
// jq のフィルタ・PowerShell のスクリプトブロックも `{...}` にカンマを含むが、シェルはこれを
// 展開しない ―― 一緒に数えると数個並んだだけで上限に達し、保護ツリーに一切触れない
// コマンドが「判定できない」で拒否される。
//
// 引用符の外だけを数えていた頃は、この選別を「引用符に囲まれているか」で代用していた。
// ところが引用符の中もラッパー越しに展開される ―― `bash -c "… {a,b} …"` の中身は内側の
// シェルが展開するのに、数える側からは丸ごと消えていた。展開する側(texts)は引用符を
// 外してから展開するので、上限を超えた展開が黙って捨てられ、「ツリー名をブレースで割る」
// 手(上のコメント)が引用符の中に対してだけ生き残っていた。
//
// 代わりに中身の形で選別する。シェルのブレース展開に書く選択肢はそのままパスの一部になるので、
// 空白も引用符も含まないのがふつう。逆に JSON / jq はどの選択肢にも引用符か空白が入る。
// 「すべての選択肢が該当する」ことを条件にするのは、1 つでも素の選択肢があれば展開の側
// (= 数える側 = 拒否側)に倒すため。`{org-tre,"x"}` のような混ぜ方では逃げられない。
const DATA_ALTERNATIVE = /["\s]/;
const BRACE_ALTERNATION = /\{([^{}]*,[^{}]*)\}/g;

// 左から順に見て、シェルが展開するブレースの最初の 1 つを返す。無ければ null。
function firstShellBrace(text) {
  for (const m of text.matchAll(BRACE_ALTERNATION)) {
    if (!m[1].split(',').every((alt) => DATA_ALTERNATIVE.test(alt))) return m;
  }
  return null;
}
// 上限は「打ち切りが即拒否になる」ことを踏まえて決める。本数は各段の累積で数えるので、2 択の
// グループ n 個で 2+4+…+2^n になり、32 では 4 グループで頭打ちだった ―― `mkdir -p a/{x,y}
// b/{x,y} c/{x,y} d/{x,y} e/{x,y}` のように保護ツリーに一切触れないふつうの Bash が拒否される。
// 256 なら 2 択 7 グループまで展開しきる。上限を上げても打ち切り自体は拒否のままなので
// (上のコメント)、ここで買えるのは誤拒否の減少だけで、抜け道は広がらない。
const BRACE_MAX_DEPTH = 8;
const BRACE_MAX_VARIANTS = 256;

function braceVariants(text) {
  const out = [];
  let frontier = [text];
  for (let depth = 0; depth < BRACE_MAX_DEPTH; depth++) {
    const next = [];
    for (const t of frontier) {
      const m = firstShellBrace(t);
      if (!m) continue;
      for (const alt of m[1].split(',')) {
        next.push(t.slice(0, m.index) + alt + t.slice(m.index + m[0].length));
      }
    }
    if (!next.length) break;
    out.push(...next);
    if (out.length >= BRACE_MAX_VARIANTS) {
      return { variants: out.slice(0, BRACE_MAX_VARIANTS), truncated: true };
    }
    frontier = next;
  }
  // 本数の上限に当たらずに抜けても、深さの上限で展開しきれていないことがある。展開の
  // 打ち切りはこの 2 経路しかないので、どちらも同じ印にまとめる。
  return { variants: out, truncated: frontier.some((t) => firstShellBrace(t) !== null) };
}

// markUndecidable は「対象を判定できなかった」印(下の braceTruncated)を混ぜてよいかどうか。
// 既定は false。この印は trees の各要素を操作対象として偽造するので、trees に保護ツリー以外を
// 渡す呼び出し ―― isUnlockStateWrite は解除の状態ファイル自身を渡す ―― でそのまま混ぜると、
// 無関係なコマンドが「状態ファイルへの書き込み」として拒否される(保護ルールが空でも起きる)。
// 判定不能を拒否に倒す意味があるのはツリー保護の判定だけなので、そこからの呼び出しに限る。
function targetStrings(toolName, toolInput, cwd, trees = [], markUndecidable = false) {
  const ti = toolInput ?? {};
  const pathFields = PATH_FIELDS[toolName];
  const commandFields = COMMAND_FIELDS[toolName];

  // フィールドの値そのものが操作対象のパス。書かれたままと解決後の両方を見る。
  if (pathFields) {
    const out = [];
    for (const f of pathFields) {
      const v = ti[f];
      if (typeof v !== 'string' || !v) continue;
      out.push(v, resolveFrom(cwd, v));
    }
    // asPath を直接渡さない。map は第 2 引数に添字を渡すので、それが truncated に入ってしまう。
    return out.filter(Boolean).map((v) => asPath(v));
  }

  // ここから先はパスがどの位置に現れるか決まっていない文字列。
  // 知らないツール(MCP のファイルシステム系など)はどの引数が操作対象か判断できない。
  // 素通しにすると保護が丸ごと外れるので引数全体から拾うが、文字列全体を突き合わせると
  // 散文中のツリー名にも反応する(上の PATH_FIELDS のコメントにある誤検知)。
  // 絶対パスの形をした部分文字列だけを取り出せば、実際の操作対象を捉えつつ言及は見逃せる。
  // ホーム表記は切り出す前に展開する(expandHomeIn のコメント参照)。展開後の文字列を
  // そのまま以降の判定にも使う ―― 元の文字列を併せて見ても、`~` を含む形は
  // どのトークンにも当たらないので判定材料が増えない。
  //
  // 引用符はその前に外す。シェルにとって引用符は区切りではなく前後をそのまま連結するので、
  // 残したままだと `"<tree>"/secret` や `<dir>/"unlocks.json"` のように引用符を挟んだ 1 本の
  // パスが別々のトークンに割れ、突き合わせが外れる(解除の状態ファイルの完全一致が実際に
  // これで外れ、引用符を1つ入れるだけで書き込みが通っていた)。外すことでスペースを含むパスが
  // 割れるが、引用符を残しても空白で切れるのは同じなので悪化しない。展開より先に外すのは、
  // `"~"/x` のように引用符付きで書かれたホーム表記を展開できるようにするため。
  //
  // 外すのはシェルのコマンド文字列だけにする。知らないツールで見る JSON.stringify の引用符は
  // 値の区切りそのもので、外すとトークンの直前が `:` になり、URL や `D:/x` を巻き込まない
  // ための後読みに引っかかって、相対パスと MSYS 形式がまるごと拾えなくなる(実際に
  // `{"path":"org-tree/secret"}` と `{"p":"/c/org-tree/x"}` が素通りした)。自然文である
  // Agent / Task の prompt も、引用符が連結を意味しないので同じく外さない。
  const isShell = toolName === 'Bash' || toolName === 'PowerShell';
  const rawTexts = commandFields
    ? commandFields.map((f) => ti[f]).filter((v) => typeof v === 'string')
    : [JSON.stringify(ti)];
  const texts = rawTexts.map((t) => expandHomeIn(isShell ? t.replace(/["'`]/g, '') : t));

  // ブレースの展開もシェルのコマンド文字列に限る(引用符除去と同じ理由)。知らないツールで
  // 見る JSON にはオブジェクトの `{...}` がそのまま含まれ、展開すると実在しない文字列を
  // 判定材料に増やしてしまう。PowerShell は実際にはブレース展開しないが、展開版を足すだけなら
  // 判定材料が増えるだけなので Bash と分けない(展開しきれなかったときの印は別。即拒否に
  // つながるので Bash に限る ―― 下の braceTruncated 参照)。
  //
  // 打ち切りは展開そのものから受け取る。別の文字列で数え直すと、展開した側と数えた側が
  // 食い違い、その差がそのまま抜け道になる(firstShellBrace のコメント)。
  //
  // 数えるのは Bash だけにする。ブレース展開をするシェルは Bash であって PowerShell ではない。
  // 展開版を足すだけなら判定材料が増えるだけで済んでいたが、markUndecidable が入って以降は
  // 打ち切りが即拒否になるため、保護ツリーに一切触れないふつうの PowerShell が並べただけで
  // 拒否されていた(拒否側なら安全、が成り立たない)。
  let braceTruncated = false;
  if (isShell) {
    for (const t of [...texts]) {
      const expanded = braceVariants(t);
      texts.push(...expanded.variants);
      if (toolName === 'Bash' && expanded.truncated) braceTruncated = true;
    }
  }

  // 相対パスの基準は cwd だけとは限らない(cwdCandidates のコメント)。
  const bases = cwdCandidates(texts, cwd);

  const out = [];
  for (const text of texts) {
    const absolute = tokensIn(text, ABSOLUTE_PATH_TOKEN);
    const relative = tokensIn(text, RELATIVE_PATH_TOKEN);
    const msys = tokensIn(text, MSYS_PATH_TOKEN);

    // シェルや委譲は「保護ツリーを読め」という指示そのものを止めたいので文字列全体も見る。
    if (commandFields) out.push({ value: text, kind: 'text', truncated: false });
    else out.push(...[...absolute, ...msys].map((m) => asPath(m.token, m.truncated)));

    // 埋もれたパスは切り出して個別に解決する。文字列全体のままでは `.` / `..` を畳めず、
    // `C:/x/../<tree>/secret` や `/c/./<tree>` のような形が素通りしていた
    // (mentionsTree は文字列を突き合わせるだけで、パスとしての正規化はしない)。
    // 絶対パスは基準に依存しないので cwd だけで解決する。
    for (const m of absolute) out.push(asPath(resolveFrom(cwd, m.token), m.truncated));
    for (const m of relative) {
      for (const base of bases) out.push(asPath(resolveFrom(base, m.token), m.truncated));
    }
    for (const m of msys) {
      const win = fromMsys(m.token);
      if (win) out.push(asPath(win, m.truncated), asPath(resolveFrom(cwd, win), m.truncated));
    }
  }

  // 区切りを含まない裸のトークンは cwd 基準で解決しない(RELATIVE_PATH_TOKEN のコメント。
  // 散文中でツリー名に言及しただけで拒否される誤検知を避けるため)。ただし保護ツリー
  // 自身の名前だけは例外にする。cwd がツリーの「親」にいるとき、`cd <ツリー名> && type
  // secret` は絶対パスの形にも区切り付き相対パスの形にもならず、文字列全体の突き合わせ
  // にも当たらないため、実際の読み出しがそのまま通っていた(`cd <ツリー名>/ && …` と
  // 末尾に区切りを付けただけで拒否されるのに、付けないと通るという食い違い)。
  //
  // この例外はシェルのコマンド文字列に限る。裸の名前が「操作対象」を意味するのは cd で
  // 潜れるシェルだけで、Agent / Task の prompt・description は自然文だからである。
  // 同じ扱いにすると、基底名が `private` のようなありふれた語のとき、その語を含むだけの
  // 無関係な委譲まで「配下を操作している」として拒否される。cwd がツリーの親であるのは
  // (親が作業リポジトリなら)ごく普通の状態なので、cwd 条件は歯止めにならない。
  for (const tree of isShell ? trees : []) {
    const base = path.basename(String(tree || '').replace(/[\\/]+$/, ''));
    if (!base) continue;
    // 前後の境界を見るのは、別ドライブの `D:/<ツリー名>` を切り出して cwd 配下へ
    // 解決してしまうことと、`<ツリー名>-backup` のような別ディレクトリに当てることを防ぐため。
    //
    // 直後に区切りが続く形(`<ツリー名>/tool-a`)もここでは拾わない。それは区切りを含む相対
    // パスとして上の RELATIVE_PATH_TOKEN が正しい深さで拾っており、ここで重ねて拾うと
    // 「ツリーのルート」まで操作対象に積まれる。ルートは解除の範囲に入らないので、配下を
    // 解除していても `cd <ツリー名>/tool-a` が拒否される ―― 絶対パスで同じ場所を指せば
    // 通るのに相対形だけ通らない、という食い違いになっていた。
    const re = new RegExp(`(?<![\\w.\\-\\\\/:])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.\\-\\\\/])`, 'i');
    if (texts.some((t) => re.test(t))) {
      for (const b of bases) out.push(asPath(resolveFrom(b, base)));
    }
  }

  // 展開を打ち切ったときは、見ていない variant にツリー名が割れて入っている可能性を排除
  // できない(braceVariants のコメント)。どのツリーを指しているかも分からないので、全ツリーの
  // ルートを対象として積む。切り詰めの印を付けるのは、解除の範囲判定(unlockCoversTargets)も
  // 通さないため ―― 展開してみるまで何を触るか分からないので、範囲内である根拠が無い。
  if (markUndecidable && braceTruncated) {
    for (const tree of trees) out.push({ ...asPath(normalize(tree), true), undecidable: 'brace' });
  }
  return out.filter((t) => t.value);
}

// 設定を読む。`broken` は「保護すべきなのに読めない」状態を表す。
//
// 「ファイルが無い」と「あるが壊れている」を区別するのが要点。以前はどちらも
// DEFAULT_RULES(= 保護なし)にしていたため、config.json に末尾カンマを1つ入れただけで
// 全ての保護が無言で消えていた。設定していないのは意図した状態だが、壊れているのは
// 事故であって、素通しにしてよい理由がない。冒頭の方針どおり後者は拒否側に倒す。
function loadConfig() {
  // HOME を導出できていない場合、CONFIG はダミー値でしかなく、どこを読んでも意味がない。
  // ここで確定的に broken 扱いにする(素通しにすると保護が無言で外れるのは他の broken と同じ)。
  if (homeUnresolved) return { rules: DEFAULT_RULES, broken: true, homeUnresolved: true };

  let text;
  try {
    text = fs.readFileSync(CONFIG, 'utf8');
  } catch (e) {
    // 未作成なら保護なし(意図した状態)。読めない場合は権限などの異常なので壊れた扱い。
    return { rules: DEFAULT_RULES, broken: e && e.code !== 'ENOENT' };
  }

  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    return { rules: DEFAULT_RULES, broken: true };
  }

  // rules が配列でないのも書き損じ。空配列を明示した場合だけ「保護なし」として通す。
  if (!Array.isArray(cfg?.rules)) return { rules: DEFAULT_RULES, broken: true };

  // tree を書き損じた(キー名の誤記・空文字・非文字列など)ルールは黙って捨てない。
  // 以前は filter で無言で除外していたため、有効なルールが他になければ rules が [] になり、
  // 保護が丸ごと外れているのに configBroken は false のまま = 警告も出ないという事故があった。
  // allow の書き損じは「許可なし」に倒せば安全だが、tree が読めないとどのツリーを
  // 守るべきかそもそも分からないので、rules 非配列などと同じ扱い(config ごと壊れた=拒否側)に揃える。
  //
  // 相対パスも書き損じ扱いにする(姉妹ツールの worklog loadConfig と同じ判断)。判定に使う
  // resolveFrom / normalize は path.resolve なので、相対の tree はフックを呼んだ cwd を基準に
  // 解決され、同じ設定でも作業場所によって守る対象が変わる。加えて裸のツリー名の突き合わせは
  // 前後の境界しか見ないため、`tree: "org-tree"` は無関係な `D:/other/org-tree/x` にも当たる。
  const badRule = cfg.rules.find((r) => !r || typeof r.tree !== 'string' || !r.tree || !path.isAbsolute(r.tree));
  if (badRule) return { rules: DEFAULT_RULES, broken: true };

  const rules = cfg.rules.map((r) => ({ tree: r.tree, allow: Array.isArray(r.allow) ? r.allow : [] }));
  return { rules, broken: false };
}

// Claude 自身に解除を実行させない。
//
// 依拠するのは「PreToolUse フックは Claude のツール呼び出しにだけ発火し、ユーザーの `!` 実行では
// 発火しない」という実測。ここで落とせば経路そのものが分かれ、Claude からは解除できず、ユーザーは
// `!` で打てる。承認ダイアログ(permissions.ask)にしないのは、押せば通る以上「もっともらしい理由を
// 添えて要求する」が流し読みで通る余地が残るため。歯止めは経路の分離に置く。
//
// 解除中のセッションでも拒否する。Claude が解除を延長・再発行できると、ユーザーが範囲を絞って
// 開けた意味がなくなる。この判定が解除フィルタより先に来るのはそのため。
//
// 過剰検出は許容する。`grep "guard unlock" README.md` のような参照目的のコマンドも止まるが、
// 実害は「その文字列を含むコマンドを打てない」ことだけで、必要ならユーザーに `!` で代行を頼める。
// コマンド文字列から意図を読み分けようとすると、その解析自体が迂回の余地になる。
//
// 対象から外すのは PATH_FIELDS に載るツール(Read / Edit / Write / Glob / Grep / NotebookEdit)
// だけにする。これらは「操作対象がパスのフィールドに入る」ことが分かっているツールで、渡した値が
// コマンドとして実行されることはない。それ以外 ―― シェル・委譲・そして知らないツール ―― は
// どの引数が実行されるか決められないので、引数全体を見る。塞ぐ側ではなく通す側を列挙するのは
// READ_ONLY_TOOLS と同じ理由で、Bash / PowerShell だけを列挙していた頃は、MCP のシェル実行系や
// 別名のシェルツールがそのまま素通りしていた(ツールは増えるので、増えるたびに穴が開く向きの
// 列挙にしてはいけない)。
function isUnlockAttempt(input) {
  const tool = input.tool_name;
  if (PATH_FIELDS[tool]) return false;
  const ti = input.tool_input ?? {};
  const fields = COMMAND_FIELDS[tool];
  const texts = fields
    ? fields.map((f) => ti[f]).filter((v) => typeof v === 'string')
    : [JSON.stringify(ti)];
  // 語として現れることだけを見る。`guard` は `account-guard` の一部としても現れるが、直前の
  // ハイフンは語の境界にならないので、両方の綴りを別々に試す。
  const word = (w, s) => new RegExp(`(?:^|[^a-z0-9_-])${w}(?![a-z0-9_-])`, 'i').test(s);
  return texts.some((s) => s && (word('guard', s) || word('account-guard', s)) && word('unlock', s));
}

// 解除の状態ファイルを直接書き換える経路を塞ぐ。上のコマンド遮断をすり抜けても、unlocks.json を
// Write すれば同じことができてしまうので、書き込み側も塞いで歯止めを 2 層にする。
//
// 読み取りは止めない(status が表示するのと同じ内容で、隠す意味がない)。ただし Bash / PowerShell は
// 読みと書きを区別できないので、そのパスが現れた時点で拒否する。相対パス指定を取りこぼさないよう、
// 判定は既存のパス検出(targetStrings)に合流させる ―― ここだけ別の検出を新設すると、片方だけが
// 知っている書き方が抜け道になる。
//
// 塞ぐ側ではなく通す側を列挙するのは、知らないツールを既定で歯止めの内側に置くため。
// 書き込むツール(Write / Edit / NotebookEdit)を列挙していた頃は、そこに載っていない
// MCP のファイルシステムサーバや MultiEdit がすべて素通りし、状態ファイルを書き換えられた。
// ツールは増えるので、増えるたびに穴が開く向きの列挙にしてはいけない。
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep']);

function isUnlockStateWrite(input) {
  // HOME を導出できていないときの UNLOCKS はダミー値で、実在のパスと一致しない。その状態では
  // config.broken 側がすべて拒否するので、ここで無理に判定しなくてよい。
  if (homeUnresolved) return false;
  const tool = input.tool_name;
  if (READ_ONLY_TOOLS.has(tool)) return false;
  // trees に状態ファイルを渡すと、シェルのコマンド文字列中の裸のファイル名(`unlocks.json`)も
  // cwd 基準で解決される。別の場所の同名ファイルは違うパスに解決されるので巻き込まない。
  // 裸の名前を拾うのはシェルだけ(targetStrings のコメント)だが、それ以外のツールは操作対象が
  // パスのフィールドに入っており、そこに書かれた `unlocks.json` は同じく cwd 基準で解決される
  // ので取りこぼしはない。
  // kind が 'text'(シェルのコマンド文字列そのもの)は見ない。文字列全体が状態ファイルの
  // パスと完全一致することはないうえ、ここで部分一致を採ると単に言及しただけで拒否される。
  //
  // 履歴(unlock.log)も同じ扱いにする。誰がいつ何のために解除したかを後から確かめるための
  // 記録で、この設計は「ユーザーが `!` で打った」ことに全体重を預けている ―― 記録を書き換え
  // られると、その確かめようがなくなる。読み取りは READ_ONLY_TOOLS 側で通したままにする。
  const targets = [normalize(UNLOCKS), normalize(UNLOCK_LOG)];
  const guardDir = normalize(GUARD_DIR);
  return targetStrings(tool, input.tool_input ?? {}, input.cwd, [UNLOCKS, UNLOCK_LOG]).some((t) => {
    if (t.kind !== 'path') return false;
    const value = normalize(t.value);
    // ガード自身のディレクトリを指しているものは、それだけで書き込み扱いにする。ファイル名まで
    // 一致することを求めていた頃は、ディレクトリ宛ての書き込みが丸ごと素通りしていた ――
    // `cp <偽の unlocks.json> ~/.claude/account-guard/` は cp がファイル名を補うので、
    // 状態ファイルを名指ししないまま置き換えられた(同じ操作を `cd` してファイル名で書けば
    // 拒否されるので、書き方だけで結論が変わっていた)。
    if (value === guardDir) return true;
    // 切り詰められたトークン(SAFE_TOKEN_END のコメント)は実際に書かれるパスの先頭部分でしか
    // ないので、完全一致では捉えられない。`unlocks{.json,}` や `unlocks[.]json` のように末尾を
    // 展開で作る形が、それだけで素通りしていた。前方一致に緩めるのはガード自身のディレクトリを
    // 指しているときに限る ―― 無条件に緩めると `ls C:/{a,b}` のような `C:/` で切り詰められた
    // トークンまで状態ファイルへの書き込み扱いになる。
    return t.truncated
      ? value.startsWith(guardDir) && targets.some((target) => target.startsWith(value))
      : targets.includes(value);
  });
}

// 壊れた設定を直す操作だけは通す。これがないと Claude Code の中から復旧できず、
// エディタや git を外部から使うしか手がなくなる(全停止させたときに実際に困った)。
function isConfigRepair(input) {
  const tool = input.tool_name;
  if (tool !== 'Read' && tool !== 'Edit' && tool !== 'Write') return false;
  const target = input.tool_input?.file_path;
  if (typeof target !== 'string' || !target) return false;
  const abs = resolveFrom(input.cwd, target);
  return Boolean(abs) && normalize(abs) === normalize(CONFIG);
}

// HOME を導出できないときの逃げ道。この状態では CONFIG がダミー値なので isConfigRepair は
// 決して成立せず(絶対パスとダミー相対パスが一致することはない)、修復操作まで拒否されて
// Claude Code の中から手が出せなくなる。上の isConfigRepair が無いと全停止する、というのと
// 同じ理由で、ここにも逃げ道が要る。
//
// 通すのはフック登録を外す操作だけにする。HOME が不明でも `.claude/settings.json` で終わる
// 絶対パスかどうかは文字列として判定できる。この状態では保護ツリーも特定できていない
// (=何も保護できていない)ので、これを通すことで保護の穴が増えることはない。
function isHookDisable(input) {
  const tool = input.tool_name;
  if (tool !== 'Read' && tool !== 'Edit' && tool !== 'Write') return false;
  const target = input.tool_input?.file_path;
  if (typeof target !== 'string' || !target) return false;
  const abs = resolveFrom(input.cwd, target);
  return Boolean(abs) && /[\\/]\.claude[\\/]settings(\.local)?\.json$/.test(normalize(abs));
}

// 設定が壊れていても通す逃げ道。判定は violation()(通常経路)と reportCrash()(ガード自身が
// 例外で落ちた経路)の両方が必要とするので、ここ 1 箇所にまとめる。
//
// 以前は両関数がそれぞれ同じ条件を別の書き方(!isConfigRepair(...) && !(...) / isConfigRepair(...)
// || (...))で持っていて、HOME 未解決とガード自身の異常終了が重なった場合だけドリフトが表面化した。
// main() 側(violation)には settings.json の逃げ道があるのに reportCrash 側だけ isConfigRepair
// しか見ておらず、その組み合わせでだけ「Claude Code の中から復旧する手段が 1 つも無い」状態が
// 残っていた(CONFIG が HOME 未解決時のダミー相対パスになるため isConfigRepair は決して成立しない)。
function isEscapeHatch(input, config) {
  return isConfigRepair(input) || (config.homeUnresolved && isHookDisable(input));
}

// このツール呼び出しが保護ツリーに触れるか判定し、触れるなら拒否理由を返す。
// 触れない、または現在のアカウントが許可されているなら null。
// unlocked は現セッションで解除中のパス一覧、notes は解除が実際に効いた(本来なら拒否していた)
// ことを呼び出し元へ伝えるための出力先。unlocked を引数で受けるのは、呼び出し元がその一覧を
// 案内文にも使うため ―― ここで読み直すと、読めなかったときに判定と文面で食い違いが出る。
// unlocked に既定値を置くのは、渡し忘れたときに coveredByUnlock が TypeError を投げ、
// reportCrash 経由で cwd だけを見る縮小判定へ静かに落ちるのを防ぐため(このファイルの方針は
// 「分からないときは拒否側」なので、例外で判定が緩むのは向きが逆)。
function violation(input, account, config, unlocked = [], notes = []) {
  const cwd = input.cwd || process.cwd();

  // 解除に関わる操作は、設定の状態にも解除の有無にも関係なく真っ先に落とす。解除中のセッションで
  // あっても拒否する(isUnlockAttempt のコメント)ので、下の解除フィルタより前でなければならない。
  if (isUnlockAttempt(input)) return { unlockAttempt: true };
  if (isUnlockStateWrite(input)) return { unlockState: true };

  // 設定が壊れているときは、どのツリーを守るべきかが分からない。素通しにすると
  // 保護が丸ごと外れるので、修復操作を除いて拒否する。HOME 未解決もこの扱いに合流するが、
  // そのときは CONFIG がダミー値で isConfigRepair が成立しないため、代わりに
  // フック解除(settings.json の編集)を逃げ道にする。
  if (config.broken && !isEscapeHatch(input, config)) {
    return {
      broken: true,
      tree: CONFIG,
      reason: config.homeUnresolved ? 'HOME を特定できません' : '設定ファイルを読めません',
      allow: [],
      homeUnresolved: !!config.homeUnresolved,
    };
  }

  // 解除は「触る場所が字面から決まる」ことを前提にする(hasRuntimeCd のコメント)。決まらない
  // コマンドでは解除を適用せず、解除を入れる前と同じ「保護ツリーの中は無条件に拒否」へ戻す。
  // 解除が無いときは判定が変わらないので、余計な拒否は生まない。
  const runtimeCd = unlocked.length > 0 && hasRuntimeCd(input.tool_name, input.tool_input);
  const scoped = runtimeCd ? [] : unlocked;
  // 解除中に拒否されると、理由が書かれていない限り「解除が壊れている」ように見え、解除の
  // やり直しやガード外しに向かってしまう。適用しなかったことまで文面に出す。
  const runtimeNote = runtimeCd ? '(cd の移動先が実行時に決まるため、一時解除を適用できません)' : '';

  const targets = targetStrings(input.tool_name, input.tool_input, cwd, config.rules.map((r) => r.tree), true);
  // どのフィールドが操作対象か分からないツール(MCP のファイルシステム系など)は、入力を
  // JSON にしてから拾う。トークンは必ず JSON の `"` で終わるので SAFE_TOKEN_END から見れば
  // 常に切り詰め扱いになり、解除の範囲判定を通らない ―― これは意図した設計(hasRuntimeCd の
  // コメント)だが、拒否の文面まで「指定がそこで終わっている」と説明すると、書き換えれば
  // 通るように読める。実際には書き換えようがないので、理由の側を分ける。
  const opaqueTool = !PATH_FIELDS[input.tool_name] && !COMMAND_FIELDS[input.tool_name];

  // 案内する swap は Bash 経由なので、cwd が拒否対象ツリーの内側だとその呼び出し自体が
  // 同じ判定に当たって拒否される。当たったルールが cwd を含むとは限らない(別の保護ツリーに
  // 居ながら、このツリーのファイルを触ることがある)ため、ヒットしたルールだけでなく
  // 全ルールから探す。ここを「ヒットしたルール = cwd のツリー」と決め打ちしていたせいで、
  // 保護ツリーが 2 つ以上ある構成では注記が出ず、案内どおり打つと同じ deny に戻っていた。
  // 解除済みの cwd では swap の注記は要らない(その cwd のままで swap を打てる)ので、
  // 解除を反映した上で「拒否対象のツリーの内側にいるか」を見る。
  const cwdRule = config.rules.find((r) => !r.allow.includes(account) && isInsideTree(cwd, r.tree)
    && !coveredByUnlock(cwd, scoped));
  const cwdTree = cwdRule ? cwdRule.tree : null;

  for (const rule of config.rules) {
    if (rule.allow.includes(account)) continue;

    // 解除フィルタは、判定の冒頭ではなくヒットが確定した後に置く。冒頭で早期 return すると
    // 「どのパスが原因で拒否されたか」が分からず、解除の範囲を絞れているかも確かめられない。
    if (isInsideTree(cwd, rule.tree)) {
      if (!coveredByUnlock(cwd, scoped)) {
        return {
          tree: rule.tree,
          reason: `作業ディレクトリが ${rule.tree} 配下にあります${runtimeNote}`,
          allow: rule.allow,
          cwdTree: rule.tree,
        };
      }
      notes.push(`作業ディレクトリ(${cwd})`);
    }

    // cwd が解除されていても、操作の対象は別に見る。cwd の解除は「そのディレクトリで作業してよい」
    // であって、同じツリーの解除範囲外を触ってよいことにはならない。
    const hits = targets.filter((t) => mentionsTree(t.value, rule.tree));
    if (hits.length) {
      if (!unlockCoversTargets(rule.tree, hits, scoped)) {
        // 判定できなかったのか、配下だと分かったのかは呼び出し側にも伝える。理由文だけに
        // 混ぜていた頃は、denyMessage の見出しが「操作の対象は配下です」と断定したまま
        // 本文で「判定できません」と続き、読んだ側がどちらを信じればよいか分からなかった。
        // 判定不能の原因は 2 通りある。ブレース展開を展開しきれなかった場合と、対象の指定が
        // そこで終わっておらず(glob・カンマ・括弧が続く)切り出した文字列が先頭部分でしか
        // ない場合。後者を見ていなかったため、切り詰めで拒否したときだけ見出しが断定形に
        // 戻り、書き方を直せば通ると気づけなかった。
        const braceHit = hits.some((t) => t.undecidable === 'brace');
        const truncatedHit = hits.some((t) => hasTruncatedRef(t, rule.tree));
        const undecidable = braceHit || truncatedHit;
        let reason = `操作の対象が ${rule.tree} 配下です${runtimeNote}`;
        if (braceHit) {
          reason = `ブレース展開を展開しきれないため、対象が ${rule.tree} 配下かどうか判定できません`;
        } else if (truncatedHit) {
          reason = opaqueTool
            ? `このツールは入力の形が決まっておらず、対象の指定がどこで終わるかを特定できないため、${rule.tree} 配下かどうか判定できません`
            : `対象の指定がそこで終わっておらず、実際に触る場所を特定できないため、${rule.tree} 配下かどうか判定できません`;
        }
        return {
          tree: rule.tree,
          undecidable,
          reason,
          allow: rule.allow,
          // cwd はこのツリーの内側ではないが、別の保護ツリーの内側かもしれない。
          cwdTree,
        };
      }
      notes.push(`操作の対象(${rule.tree} 配下)`);
    }
  }
  return null;
}

// credentials ファイルが存在していても、書き込み途中の中断やディスク不足で 0 バイト・
// 破損していることがある。existsSync は true を返すので、それだけでは「未ログイン」と
// 区別できない。実際に読めて、かつ復元に使える中身であるかまで確認する。
//
// JSON.parse が通るかだけを見ていたときは、`{}` や `{"claudeAiOauth":{}}` を「正常」と
// 分類していた。swap.js は accessToken を必須にするので、正常と見なした先で案内する
// `swap save <name>` が必ず失敗し、退避が無ければ行き止まりになる。判定は credentials.js の
// hasUsableCredentials に一本化し、ガードと swap で基準がずれないようにする。
//
// 真偽ではなく 3 つに分けるのは、「読めなかった」を「中身が使えない」と同じ扱いにすると
// 嘘の案内になるため。ウイルス対策やバックアップツールが一時的に掴んでいるだけ、ACL が
// 一時的に変わっているだけ、書き込みの途中を読んだだけ、のいずれでも読み取りは失敗するが、
// ファイルの中身は健全なまま(あるいは書き終われば健全になる)。それを「失われる認証情報は
// ない」と断言して /login を勧めると、まだ退避していないアカウントの refreshToken がそこで
// 消える(復旧はブラウザ OAuth のやり直し)。swap.js 側は同じ状況を捨ててよいとは扱わず、
// `.unreadable-current-N.json` に控えを取ってから進む設計になっている。
//   'usable'     … 読めて、復元にも使える
//   'stale'      … 読めたが復元に使えない(accessToken が無い)。ただし refreshToken は残っている
//   'unusable'   … 読めたが復元に使えず、refreshToken も無い。失って困るものは無い
//   'unreadable' … 読み取れなかった。中身に価値があるかは判断できない
// stale を unusable に混ぜていた頃は、accessToken だけが欠けた状態(書き込みの途中が典型)に
// 対して「失われる認証情報はない」と断言して /login を勧めていた。refreshToken は交換すれば
// また使えるので、そこで消せば復旧はブラウザ OAuth のやり直しになる。
function credentialsState() {
  let json;
  try {
    json = credentials.readCredentials(credentials.CREDENTIALS).json;
  } catch (e) {
    // ファイルに手が届かない(権限・他プロセスのロック・EBUSY)のは、中身が健全なまま
    // 読めないだけのことがある。「失われる認証情報はない」と断言すると、まだ退避していない
    // アカウントに /login させて refreshToken を消す。
    if (!(e instanceof SyntaxError)) return 'unreadable';
    // JSON として壊れているだけを根拠に unusable(失って困るものは無い)へ倒してはいけない。
    // Claude Code がこのファイルを書き換えている最中に読むと、切り詰められた中身が
    // JSON.parse に失敗する一方、切れた位置より手前には refreshToken がそのまま残っている。
    // そこで /login を勧めると、未退避アカウントの唯一のコピーを上書きさせることになる
    // (swap.js の unreadableReason は同じ状況を「/login はまだ試さないでください」と案内
    //  しており、生きた credentials を見るガード側だけが逆を言っていた)。
    // 判定は credentials.js の rawHasRecoverableToken に合流させ、ここでは書き起こさない。
    return credentials.rawHasRecoverableToken(e.raw) ? 'stale' : 'unusable';
  }
  try {
    if (credentials.hasUsableCredentials(json)) return 'usable';
    return credentials.hasRecoverableToken(json) ? 'stale' : 'unusable';
  } catch {
    // 形式検証をすり抜けた版の hasUsableCredentials / hasRecoverableToken が投げた場合。
    // 中身の判断はできないので、「失って困るものは無い」側には倒さない。
    return 'unreadable';
  }
}

// swap は Bash 経由の呼び出しになる。cwd が保護ツリーの内側だと、案内した swap コマンドの
// 呼び出しそのものが violation() の cwd 判定に先に当たり、同じ deny を返す堂々巡りになる
// (/login はスラッシュコマンドでフックを通らないため影響を受けない)。cwd の内外は
// violation() が既に判定しているので、その結果をそのまま案内に使う
// (コマンド文字列を見て swap を特別扱いする例外は作らない。パースは容易に迂回できるため)。
// 逃げ道として `cd` を案内しないのは、コマンド文字列の中の cd がフックの判定に効かないため。
// violation() が見るのは PreToolUse 入力の cwd(= セッションの作業ディレクトリ)なので、
// `cd ~ && swap team` と書いても同じ deny が返る。セッション内から抜ける手は無く、ここを
// 「cd してから実行」と書いていた頃は、Claude が何度打ち直しても同じ拒否に当たり続けた。
function swapCwdNote(hit) {
  if (!hit.cwdTree) return [];
  return [
    '',
    `swap は Bash 経由の呼び出しのため、作業ディレクトリが ${hit.cwdTree} 配下のままだと同じ理由で`,
    '拒否されます。コマンドの中で `cd` しても判定は変わりません(セッションの作業ディレクトリで',
    '判定するため)。このセッションからは実行できないので、ツリーの外で開いた別のターミナルで',
    '打つよう、ユーザーに依頼してください。',
  ];
}

// swap は同梱の別ツールで、swap.cmd を PATH の通った場所に置く手動セットアップが要る
// (README 参照)。ガードだけを入れた構成では `swap` は存在せず、それでも文面が /login を
// 抑止していると、実行できる次の一手が 1 つも残らない。ガードを外す方向の回避を誘発するので、
// swap が無い場合の逃げ道まで書く。
const SWAP_MISSING_NOTE = [
  '',
  '`swap` が見つからない場合は、まだ設置していません(account-guard/README.md のセットアップ)。',
  'その場合は勝手に `/login` せず、ユーザーに切り替えを依頼してください',
  '(退避していないアカウントは `/login` の時点で失われます)。',
];

// 失って困る認証情報が無い状態(未ログイン/破損)で共通に使う案内。どちらも
// `swap save <name>` は必ず失敗し、退避が 1 つも無ければ `swap <name>` も必ず失敗するので、
// /login を抑止したままだと打つ手が無くなる。
//
// swap に --force を添えるのは、この経路では現在の credentials が読めないため。swap 側は
// 「読めない現在を退避せずに上書きしてよいか」を --force で確かめるので、付けずに案内すると
// 必ず中止される。ここでは失って困るものが無いことをガード側で確認済みなので、承知のうえで
// 進む形にしておく(案内どおり打って止まるのは、案内していないのと同じ)。
function noCredentialsAtStakeMessage(head, situation, hit, needForce) {
  const restore = needForce ? '  swap <name> --force' : '  swap <name>        ';
  return head.concat([
    situation,
    'この状態で失われる認証情報はないので、次のどちらかで復帰してください。',
    restore + ' … 退避済みのアカウントがあれば復元する(`swap` で一覧を確認できます)',
    '  /login              … 退避が無い場合はログインし直す(消える退避はありません)',
    ...swapCwdNote(hit),
    ...SWAP_MISSING_NOTE,
    '回避しようとせず、ユーザーに許可アカウントでのログインが必要であることを伝えてください。',
  ]).join('\n');
}

function denyMessage(hit, account) {
  if (hit.unlockAttempt) return unlockAttemptMessage();
  if (hit.unlockState) return unlockStateMessage();
  if (hit.broken) return hit.homeUnresolved ? homeUnresolvedMessage() : brokenConfigMessage();

  const allowed = hit.allow.length ? hit.allow.join(' / ') : '(許可アカウントの設定なし)';
  // 判定不能で拒否したときは見出しも「判定できなかった」にする。断定形の見出しのまま本文で
  // 判定不能と続けると、対象が実際にツリー配下にあると読めてしまい、書き方を変えれば通ると
  // 気づけない(実際には字面を判定できる形に直せば通る)。
  const head = hit.undecidable
    ? [
      `[account-guard] 対象が ${hit.tree} 配下かどうか判定できないため拒否しました。`,
      `${hit.reason}。${hit.tree} は別アカウント専用のツリーで、現在ログイン中のアカウントは "${account}" です(許可: ${allowed})。`,
      '',
    ]
    : [
      `[account-guard] ${hit.tree} は別アカウント専用のツリーです。`,
      `${hit.reason}が、現在ログイン中のアカウントは "${account}" です(許可: ${allowed})。`,
      '',
    ];

  // 判別不能の原因が「credentials.js を隣に置き忘れた・形式が壊れている」ときは、
  // ログインし直しても直らない。ここで /login を促すと、正しいアカウントで入っている人に
  // 効かない操作を繰り返させる。
  if (account === ACCOUNT_UNKNOWN && credentialsLoadError) {
    return head.concat([
      'アカウントを判別できません。account-guard.js の隣にある credentials.js を読み込めなかったか、',
      `想定した形式ではありませんでした`,
      `(${path.join(__dirname, 'credentials.js')}: ${credentialsLoadError.code || credentialsLoadError.message})。`,
      '',
      'ログインの問題ではないため `/login` では直りません。account-guard.js だけを別の場所へ',
      'コピーした場合は、正しい形式の credentials.js も同じディレクトリへ置いてください。',
      '判別できない間は保護ツリーへの操作をすべて拒否します(素通しにすると保護が無言で外れるため)。',
      // 他の deny 経路と同じ一文をここにも置く。設置ミスだと読んだ Claude が「ガードの都合だから」と
      // 別経路(ツリー名を書かない Bash など)で読み直すと、保護の目的そのものが崩れる。
      '回避しようとせず、ユーザーに状況を伝えてください。',
    ]).join('\n');
  }

  // 未ログイン(credentials がそもそも無い)なら、失って困る認証情報も存在しない。
  // このとき swap だけを案内すると打つ手が 1 つも残らない: `swap save <name>` は
  // 「現在 credentials がありません」で、退避が 1 つも無ければ `swap <name>` も
  // 「退避されていません」で、どちらも必ず失敗する。/login を抑止したまま行き止まりになる。
  // ここも account では門番しない(下の state と同じ理由)。打つ手を決めるのは
  // 「失って困る認証情報が現にあるか」で、ファイルが無ければアカウントの判別結果によらない。
  // 「無い」ときだけ未ログインと断じる。existsSync は権限やロックで stat が失敗しても false を
  // 返すため、読めないだけで中身は生きている credentials を「ログインしていません」と判定し、
  // /login を抑止しないまま案内していた。案内どおり /login すれば、まだ退避していない
  // アカウントの refreshToken はその時点で消える。判定は swap 側と同じ probeFile に合流させる。
  const loggedOut = !!credentials && !credentials.probeFile(credentials.CREDENTIALS).exists;
  if (loggedOut) {
    // ファイルが無い場合、swap は「現在なし」として素直に復元へ進むので --force は要らない。
    return noCredentialsAtStakeMessage(head, 'ログインしていません(認証情報のファイルがありません)。', hit, false);
  }

  // ファイルはあるが中身を確かめられた結果 accessToken が無い。存在の有無だけでは上の
  // loggedOut と区別できず、下の「切り替え手順」に落ちて swap save を勧めてしまうが、それは
  // 「現在の credentials を読めません」で必ず失敗し、退避も無ければ行き止まりになる。
  // ここで残っているファイルの中身はもう使えないので、失って困るものは無い。
  // swap 側は「読めない現在」を上書きする前に --force を要求するため、それも添える。
  //
  // 「読めなかった」をこちらに混ぜないのが要点(credentialsState のコメント)。読めない
  // だけで中身が健全な場合まで「失われる認証情報はない」と断言すると、まだ退避していない
  // アカウントに /login させて refreshToken を消すことになる。
  //
  // 判定を account === ACCOUNT_UNKNOWN で門番しないのは、subscriptionType だけ読めて
  // accessToken が無い中身(書き込み途中が典型)では account が "pro" などに判別でき、
  // 門番があると下の汎用文へ落ちるため。汎用文が案内する swap save / swap は swap 側の
  // hasUsableCredentials に弾かれて必ず止まり、ガードと swap で基準がずれた袋小路に戻る。
  // 打つ手を決めるのは「中身が使えるか」であって「どのアカウントか」ではない。
  const state = !loggedOut && !!credentials && credentials.probeFile(credentials.CREDENTIALS).exists
    ? credentialsState()
    : null;
  if (state === 'unusable') {
    return noCredentialsAtStakeMessage(
      head, '認証情報のファイルはありますが、復元に使える中身ではありません(accessToken がありません)。', hit, true
    );
  }

  // 読めたが accessToken が無く、refreshToken だけが残っている。復元には使えないので
  // swap の hasUsableCredentials は false になるが、refreshToken は交換すればまた使えるため、
  // 「失われる認証情報はない」とは言えない(unusable と同じ扱いにしていた頃は、この状態で
  // /login を勧めていた)。swap 側はこの中身も「読めない現在」として控えを取ってから進むので、
  // どちらの手にも --force が要る(付けずに案内すると必ず中止される)。
  if (state === 'stale') {
    return head.concat([
      // 「読めますが」と断定しない。この分岐には、accessToken だけが欠けた健全な JSON と、
      // 書き込みの途中で切り詰められて JSON としては壊れている中身の両方が来る(後者を
      // unusable に落として /login を勧めていたのが、資格情報を失う経路だった)。
      // 同じ理由でトークンの名前も挙げない。前者は refreshToken が残っていると確定できるが、
      // 後者について分かっているのは rawHasRecoverableToken がバイト列から refreshToken か
      // accessToken のどちらかを見つけたことまでで、どちらだったかは確かめていない。
      // accessToken だけが残った控えに「refreshToken は残っています」と言うと、存在しない
      // 復旧手段を探させることになる(勧める手 ―― 控えを残す・先に /login しない ―― は
      // どちらでも同じなので、名前を落としても案内の実効は変わらない)。
      '認証情報のファイルはありますが、復元に使える中身として読み取れませんでした。',
      'ただし交換すればまた使えるトークンが残っています。先に `/login` すると、',
      'まだ退避していないアカウントはその時点で失われます(復旧はブラウザ OAuth のやり直しです)。',
      '',
      '退避済みの別アカウントへ切り替えるか、先に現在の中身の控えを残してください。',
      '  swap save <name> --force … 現在の中身の控えを残したうえで退避を試みる',
      '  swap <name> --force      … 退避済みの別アカウントへ切り替える(`swap` で一覧を確認できます)',
      ...swapCwdNote(hit),
      ...SWAP_MISSING_NOTE,
      '回避しようとせず、ユーザーにアカウントの切り替えが必要であることを伝えてください。',
    ]).join('\n');
  }

  // 読み取り自体に失敗した。中身が健全なまま手が届かないだけかもしれないので、
  // 「失うものは無い」とは言わない。/login を最後の手段として残しつつ、まず控えを
  // 取れる swap を先に案内する(swap 側は読めない現在も .replaced へ控えてから進む)。
  if (state === 'unreadable') {
    return head.concat([
      '認証情報のファイルを読み取れませんでした(権限・他プロセスによるロック・書き込みの途中など)。',
      '中身が健全なまま読めないだけの可能性があるため、失われるものが無いとは判断できません。',
      '',
      'まず、このファイルを掴んでいるプロセス(ウイルス対策・バックアップツール・稼働中の',
      '別セッション)を終えてから、もう一度実行してください。それで読めるようになることがあります。',
      '読めないままでも切り替えるなら、次の順で打ってください。',
      '  swap save <name> --force … 読めない現在の控えを残したうえで退避を試みる',
      // 2 手目にも --force が要る。控えを取っても CREDENTIALS 自体は読めないままなので、
      // 付けずに案内すると swap 側の同じ判定で必ず中止され、案内どおり打つと止まる。
      '  swap <name> --force      … 退避済みの別アカウントへ切り替える(`swap` で一覧を確認できます)',
      // 控えは copyFileSync で取るので、ファイルに手が届かない種類の「読めない」では
      // どちらの手も「控えを取れませんでした」で止まる。swap は控えを取れない限り上書き
      // しない設計なので、その場合は swap で進む道が無い。手で控えを取る逃げ道まで書く。
      'どちらも「控えを取れませんでした」で止まるなら、ファイルに手が届いていません',
      '(権限・読み取り専用属性・掴んだままのプロセス)。この場合 swap では進めないので、',
      `${credentials ? credentials.CREDENTIALS : '認証情報のファイル'} を手で別名コピーして`,
      '控えを取ってから、ユーザーに `/login` を依頼してください。',
      '先に `/login` すると、まだ退避していないアカウントの認証情報はその時点で消えます',
      '(このファイルが健全だった場合、復旧はブラウザ OAuth のやり直しになります)。',
      ...swapCwdNote(hit),
      ...SWAP_MISSING_NOTE,
      '回避しようとせず、ユーザーにアカウントの切り替えが必要であることを伝えてください。',
    ]).join('\n');
  }

  return head.concat([
    account === ACCOUNT_UNKNOWN
      ? 'アカウントを判別できませんでした。認証情報の形式が変わったか、読み取れない状態です。'
      : 'このツリーのコードを現在のアカウントに読み込ませないため、操作を拒否しました。',
    // 先に `/login` させない。/login は credentials を上書きするので、まだ swap で退避して
    // いないアカウントはその場で失われ、復旧はブラウザ OAuth のやり直しになる
    // (account-guard/README.md の「拒否されたときの挙動」と同じ順序をここでも案内する)。
    // 未ログイン・破損で swap が効かない場合は上の分岐が /login を案内するので、ここは
    // 行き止まりにならない(この経路には失って困る認証情報が現に存在する)。
    'アカウントを切り替えてから操作してください。手順は次のとおりです。',
    '  swap save <name>   … 現在のアカウントを先に退避する(まだ退避していない場合)',
    '  swap <name>        … 退避済みの別アカウントへ切り替える',
    '先に `/login` すると、まだ退避していないアカウントの認証情報はその時点で消えます。',
    // 切り替え先をまだ一度も退避していないと、上の 2 手だけでは `swap <name>` が
    // 「退避されていません」で止まり、そこから先へ進む道が文面のどこにも無くなる
    // (直前で /login を否定しているため、案内だけを頼りに動くと堂々巡りになる)。
    // /login 自体は禁止ではなく「退避より先に打つと失う」という順序の問題なので、
    // 安全な順序(退避 → /login → 退避)を README の初回手順どおりに書いておく。
    '切り替え先のアカウントをまだ一度も退避していない場合は、この順で進めてください。',
    '  1. swap save <name>      … いまのアカウントを退避する(ここまで済めば失うものはありません)',
    '  2. /login                … 切り替え先のアカウントでログインし直す',
    '  3. swap save <別名>      … 切り替え先も退避する(以後は swap <name> だけで往復できます)',
    ...swapCwdNote(hit),
    ...SWAP_MISSING_NOTE,
    '回避しようとせず、ユーザーにアカウントの切り替えが必要であることを伝えてください。',
  ]).join('\n');
}

function homeUnresolvedMessage() {
  return [
    '[account-guard] ホームディレクトリを特定できないため、操作を拒否しました。',
    'USERPROFILE / HOME のいずれも使える値を持たず、os.homedir() も空文字を返しています。',
    'この状態では設定ファイルの場所も特定できず、どのツリーを保護すべきか判断できません。',
    '',
    '素通しにすると保護が無言で外れるため、安全側に倒しています。',
    'USERPROFILE または HOME 環境変数に実在するホームディレクトリを設定してから、',
    'もう一度実行してください。',
    '',
    // 逃げ道を文面にも書く。書かないと「全部拒否された」だけが伝わり、Claude Code の外へ
    // 出るしかないと判断されてしまう(設定の場所が特定できない以上、通常の修復経路である
    // config.json の編集はここでは成立しない)。
    'この状態でも `.claude/settings.json` の読み書きだけは許可しています。環境変数を直せない',
    '場合は、そこから account-guard のフック登録を外せば、ひとまず作業を続けられます',
    '(保護は外れるので、直したあとに戻してください)。',
    '回避しようとせず、ユーザーに状況を伝えてください。',
  ].join('\n');
}

// 解除を実行しようとしたときの文面。Claude がこれを読んで「ここは自分で通す場所ではない、
// ユーザーに依頼する」と判断できることが目的なので、代わりに打てる手(lock / status)まで書く。
function unlockAttemptMessage() {
  return [
    '[account-guard] 保護の一時解除(unlock)は Claude からの実行を止めています。',
    '',
    '解除はユーザーが `!` で直接打つ操作に限っています(ユーザーの `!` 実行にはこのフックが',
    '発火しないため、経路そのものが分かれています)。解除が必要なら、次をユーザーに依頼してください。',
    '  ! guard unlock "<理由>"              … いまの作業ディレクトリを、このセッションに限って解除する',
    '  ! guard unlock --path <dir> "<理由>" … 範囲を指定して解除する',
    '',
    '解除中のセッションでもこの拒否は変わりません(解除の延長・再発行を防ぐため)。',
    '`guard lock`(解除の取り消し)と `guard status`(状態の確認)は Claude からも実行できます。',
    '',
    // 過剰検出であることを書かないと、参照目的で止まった場合に原因が分からず同じコマンドを
    // 打ち直すことになる(この文面が出る回のうち、実際の解除要求でないものは珍しくない)。
    '参照目的でこの語を含むコマンドを打った場合も、意図を区別できないため同じく拒否されます。',
    // この遮断はコマンド文字列の照合でしかなく、間接的な呼び出しまでは止められない。書かずに
    // 「実行できません」とだけ伝えると、技術的に不可能だと読めてしまう ―― 実際には要請であり、
    // 守るかどうかは Claude 側に委ねられている。そこを曖昧にしない。
    '',
    'なおこの遮断は文字列の照合なので、呼び出しを間接化すれば機械的には止まりません。',
    'それでも回避しないでください。ここはユーザーの承認を経るための境界です。',
    '必要ならユーザーに `!` での代行を依頼してください。',
  ].join('\n');
}

// 解除の状態ファイルへの書き込みを止めたときの文面。コマンド遮断をすり抜けてファイルを直接
// 書く経路を塞ぐための拒否なので、「別の書き方なら通る」と読めない文面にする。
function unlockStateMessage() {
  return [
    '[account-guard] 解除の状態ファイルへの書き込みは拒否しました。',
    `${UNLOCKS} はガードの判定そのものを決めるファイルで、Claude からの書き換えを常に禁じています。`,
    '',
    '解除の追加・取り消しはコマンドで行ってください。',
    '  ! guard unlock "<理由>" … ユーザーが打つ(解除の追加)',
    '  guard lock              … 解除の取り消し(Claude からも実行できます)',
    '  guard status            … 現在の解除状態の確認',
    '',
    '読み取りは禁じていないので、中身を確認するだけなら Read で開けます。',
    '回避しようとせず、必要ならユーザーに状況を伝えてください。',
  ].join('\n');
}

// 解除が実際に効いた(本来なら拒否していた)回にだけ返す注記。毎回出すと文脈を圧迫するうえ、
// 「解除中である」という重要な事実が日常の雑音に埋もれる。
function unlockAppliedMessage(unlocked, notes) {
  return [
    '[account-guard] この操作は保護ツリーに触れていますが、現在のセッションで一時解除されている',
    'ため許可しました。解除中の範囲は次のとおりです。',
    ...unlocked.map((p) => `  ${p}`),
    `解除が効いた理由: ${[...new Set(notes)].join(' / ')}`,
    '',
    '範囲外のパスは従来どおり拒否されます。解除を取り消すには `guard lock` を実行してください。',
  ].join('\n');
}

function brokenConfigMessage() {
  return [
    '[account-guard] 設定ファイルを読めないため、操作を拒否しました。',
    `${CONFIG} が壊れています(JSON として解析できないか、rules が配列ではありません)。`,
    '',
    'どのツリーを保護すべきか判断できない状態です。素通しにすると保護が無言で外れるため、',
    '安全側に倒しています。設定ファイル自体の読み書きだけは許可しているので、',
    'JSON の構文(末尾カンマなど)を直せば元に戻ります。',
    '設定を削除して保護ごと無効化するような回避はせず、ユーザーに状況を伝えてください。',
  ].join('\n');
}

// stdin(fd 0)は一度読むと消費されるため、読んだ結果を保持して以降は使い回す。
// これで main() の外 — 異常終了を受け止める catch — からも同じ入力を参照できる。
// main() に引数で渡す形にしないのは、シグネチャと呼び出し元を別々に書き換える途中で
// ガードが壊れると、それを直す手段ごと失われるため(実際に起きた)。
let hookInputCache = null;
function readHookInput() {
  if (hookInputCache) return hookInputCache;
  if (process.stdin.isTTY) return (hookInputCache = {});
  try {
    hookInputCache = JSON.parse(fs.readFileSync(0, 'utf8')) || {};
  } catch {
    hookInputCache = {};
  }
  return hookInputCache;
}

// --- 解除の追加・取り消し(手打ち用。フックからは呼ばれない) ---

// 状態ファイルの全エントリ。壊れていれば投げる。呼び出し元(unlock / lock)はそこで中止する:
// 壊れたファイルを黙って書き直すと、他セッションの解除まで巻き込んで消すことになる。
// 判定側(activeUnlocks)が同じ状況を握り潰して空を返すのと向きが違うのは、あちらが「解除が
// 効かない = 保護が強いまま」なのに対し、こちらは書き換えで状態を失うため。
function readAllUnlocks() {
  let text;
  try {
    text = fs.readFileSync(UNLOCKS, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return []; // まだ 1 度も解除していない
    throw e;
  }
  const data = JSON.parse(text);
  if (!Array.isArray(data?.unlocks)) throw new Error('unlocks が配列ではありません');
  return data.unlocks;
}

// 書き込みは一時ファイル経由で差し替える(swap.js の writeAtomic と同じ方針)。中身は秘密では
// ないので mode は落とさない。rename まで届かなかったときに .tmp を残さないのは、次回の読み取りが
// 書きかけを拾わないようにするため。
function writeUnlocks(list) {
  fs.mkdirSync(path.dirname(UNLOCKS), { recursive: true });
  const tmp = UNLOCKS + '.tmp';
  let renamed = false;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ unlocks: list }, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, UNLOCKS);
    renamed = true;
  } finally {
    if (!renamed) { try { fs.unlinkSync(tmp); } catch {} }
  }
}

// ロックを取り残したプロセスがいたと判断するまでの時間。
const LOCK_STALE_MS = 30000;

// 状態ファイルの「読み → 加工 → 書き戻し」を直列化する。unlock / lock は人が打つコマンドなので
// 競合はまれだが、重なると後から書いた側が、相手の読み取り後に増えたエントリを知らないまま
// 上書きし、片方の解除が黙って消える。気づきにくい壊れ方の割に、排他はファイルを 1 つ作るだけで足りる。
// 判定側(フック)はこの状態ファイルを読むだけなので、ロックは取らない ―― 判定のたびに
// ロックを作ると、ツール呼び出し 1 回ごとにファイルを書くことになる。
//
// 待たずに失敗させるのは、待つ実装だと取り残されたロックでコマンドが固まるため。代わりに
// 古いロックは奪う。プロセスが強制終了されるとロックは残るので、奪えないと以後ずっと
// 解除できなくなり、ロックのほうが本体より厄介な行き止まりになる。
//
// ロックの取得で落ちた例外には印を付けて上げる。呼び出し元は「読みで落ちた」既定の案内として
// 状態ファイルの修復・削除を勧めるが、ロックはまだ状態ファイルに触れる前の段階であり、
// 削除を勧めると他セッションの解除まで巻き添えで消させることになる(readAllUnlocks の
// コメントにある、この設計が避けたかった結末そのもの)。
function withUnlockLock(fn) {
  let fd;
  try {
    fs.mkdirSync(path.dirname(UNLOCK_LOCK), { recursive: true });
    fd = fs.openSync(UNLOCK_LOCK, 'wx');
  } catch (e) {
    if (e.code !== 'EEXIST') { e.lockFailure = true; throw e; }
    let age = Infinity;
    try { age = Date.now() - fs.statSync(UNLOCK_LOCK).mtimeMs; } catch { /* 消えた = 奪ってよい */ }
    if (age < LOCK_STALE_MS) {
      const busy = new Error('別の解除操作が進行中です');
      busy.code = 'ELOCKED';
      throw busy;
    }
    try { fs.unlinkSync(UNLOCK_LOCK); } catch { /* 相手が先に消したなら、そのまま取り直す */ }
    // ここで再び EEXIST なら、奪おうとした先を別のプロセスが取った。呼び出し元へそのまま上げる。
    try {
      fd = fs.openSync(UNLOCK_LOCK, 'wx');
    } catch (e2) {
      e2.lockFailure = true;
      throw e2;
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* 閉じられなくても消す */ }
    try { fs.unlinkSync(UNLOCK_LOCK); } catch { /* 消せなくても次回 stale として奪える */ }
  }
}

// 古いエントリを落とす。他セッションのぶんは sessionId が違うので元々効かず、これは失効では
// なくファイルが際限なく伸びるのを防ぐためだけの掃除。掃除の機会を unlock / lock の実行時に
// 限るのは、判定側(フック)は 1 回のツール呼び出しごとに走るので、そこで書き込みを起こすと
// 判定のたびにファイルを書き換えることになるため。
//
// at を読めないエントリも落とす。この状態ファイルを書くのは unlock / lock だけなので、日時が
// 壊れているものは手書きの改竄が疑わしく、残す理由がない。
function pruneUnlocks(list, now) {
  const limit = now - UNLOCK_KEEP_DAYS * 86400000;
  return list.filter((u) => {
    if (!u || typeof u.path !== 'string' || !u.path) return false;
    const at = Date.parse(u.at);
    return Number.isFinite(at) && at >= limit;
  });
}

// 追記型の履歴。いつ・どのセッションが・どの範囲を・どのアカウントで・なぜ解除したかを残す。
// 書けなくても解除自体は成立させる。履歴は付随情報で、これを理由に失敗させると「ログを書けない
// から作業できない」という本筋と無関係な行き止まりを作る。
function appendUnlockLog(action, entry) {
  const cell = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const line = [entry.at, action, cell(entry.sessionId), cell(entry.account), cell(entry.path), cell(entry.reason)]
    .join('\t');
  try {
    fs.mkdirSync(path.dirname(UNLOCK_LOG), { recursive: true });
    fs.appendFileSync(UNLOCK_LOG, line + '\n', 'utf8');
  } catch { /* 履歴が書けないことは解除の成否に影響させない */ }
}

// エラーは stderr に出し、終了コードだけ立てて自然に抜ける(swap.js と同じ理由: Windows では
// 出力先がパイプだと書き込みが非同期になり、process.exit を即座に呼ぶと最後の行が届かない)。
function failUnlock(lines) {
  for (const line of [].concat(lines)) console.error(line);
  process.exitCode = 1;
}

// `--path <dir>` / `--path=<dir>` を抜き出し、残りを理由として結合する。理由を引用符で囲み忘れて
// 単語が分かれても意味が変わらないよう、残りは全部つなげて 1 つの理由として扱う。
// 知らないオプションは理由へ吸い込まず、そのまま返して呼び出し側に失敗させる。`--paht` の
// ような打ち間違いを理由の一部として受け取ると、範囲指定のない解除として成立し、指定した
// つもりのディレクトリではなく cwd(たいていもっと広い)が黙って開く。
function parseUnlockArgs(argv) {
  let target;
  let sawPath = false;
  let unknownOption = null;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--path') { sawPath = true; target = argv[++i]; continue; }
    if (a.startsWith('--path=')) { sawPath = true; target = a.slice('--path='.length); continue; }
    if (!unknownOption && /^--?\S/.test(a)) { unknownOption = a; continue; }
    rest.push(a);
  }
  return { sawPath, target, reason: rest.join(' ').trim(), unknownOption };
}

// unlock と lock で共通の失敗。取り違えの向きは逆(unlock は意図より広く開き、lock は範囲を
// 指定したつもりで全部消える)だが、原因は同じ「オプションの打ち間違いが黙って通ること」なので
// 判定も文面も 1 箇所にまとめる。
// ロックを取れなかったときの案内。奪えるようになるまで LOCK_STALE_MS 待てばよいので、
// 手で消させる指示は出さない(消させると、動いている相手の書き込みと重なる)。
function lockedMessage() {
  return [
    '[account-guard] 別の解除操作が進行中です(何もしていません)。',
    '数秒おいてから、もう一度実行してください。',
  ];
}

// ロックそのものを作れなかったとき(権限不足、あるいは古いロックを奪おうとした先を別の
// プロセスに取られたとき)。状態ファイルにはまだ触れていないので、その修復や削除を勧めない。
function lockFailureMessage(e) {
  return [
    `[account-guard] 解除の排他ロックを取得できません(${e.code || e.message})。何もしていません。`,
    `数秒おいてから、もう一度実行してください。続くなら ${UNLOCK_LOCK} を確認してください。`,
  ];
}

function failUnknownOption(option) {
  return failUnlock([
    `[account-guard] 知らないオプションです: ${option}(何もしていません)。`,
    '指定できるのは --path <dir> だけです。理由は引用符で囲んで渡してください。',
  ]);
}

function cmdUnlock(argv, config, account) {
  const ids = sessionCandidates({});
  if (!ids.length) {
    return failUnlock([
      '[account-guard] セッション ID を取得できないため、解除できません。',
      '解除は必ずセッションに紐づけます(CLAUDE_CODE_SESSION_ID が空です)。',
      'Claude Code の中から、先頭に `!` を付けて実行してください。',
    ]);
  }

  const { sawPath, target, reason, unknownOption } = parseUnlockArgs(argv);
  if (unknownOption) return failUnknownOption(unknownOption);
  if (sawPath && !target) return failUnlock('[account-guard] --path にディレクトリを指定してください。');
  if (!reason) {
    return failUnlock([
      '[account-guard] 解除には理由が必要です(何も解除していません)。',
      '  guard unlock "<理由>"              … いまの作業ディレクトリを解除する',
      '  guard unlock --path <dir> "<理由>" … 範囲を指定して解除する',
    ]);
  }
  if (config.broken) {
    return failUnlock([
      '[account-guard] 設定を読めないため、解除する範囲がどの保護ツリーに属するか判定できません。',
      `${CONFIG} を直してから、もう一度実行してください。`,
    ]);
  }

  // --path はドライブ文字から始まる絶対パスだけを受け付ける(hasDriveLetter のコメント参照)。
  // 既定の cwd は process.cwd() なので必ずこの形になる。
  const raw = sawPath ? target : process.cwd();
  if (!hasDriveLetter(raw)) {
    return failUnlock([
      `[account-guard] --path はドライブ文字から始まる絶対パスで指定してください(受け取った値: ${raw})。`,
      '相対パスやドライブ文字を省いた形は、意図より広い範囲に効くことがあるため受け付けません。',
    ]);
  }
  const abs = path.resolve(raw);

  const owner = config.rules.find((r) => isInsideTree(abs, r.tree));
  if (!owner) {
    // どの保護ツリーにも属さない場所を「念のため」解除してしまうと、範囲を絞った意味が薄れる。
    // 黙って全体を解除することはしない(仕様)。
    return failUnlock(sawPath ? [
      `[account-guard] ${abs} はどの保護ツリーの内側でもありません(何も解除していません)。`,
      '保護されていない場所は解除する必要がありません。`guard status` で保護ツリーを確認できます。',
    ] : [
      '[account-guard] 解除対象を特定できません。いまの作業ディレクトリはどの保護ツリーにも属しません。',
      '  guard unlock --path <dir> "<理由>" のように範囲を指定してください。',
    ]);
  }

  const now = Date.now();
  const entry = { sessionId: ids[0], path: abs, reason, account, at: new Date(now).toISOString() };
  // 読みと書き戻しは 1 つのロックの中で行う(withUnlockLock)。失敗の案内は読みと書きで違うので、
  // どちらで落ちたかを stage で覚えておく。
  let stage = 'read';
  try {
    withUnlockLock(() => {
      const all = readAllUnlocks();
      stage = 'write';
      // 同じセッションの同じ範囲は重ねず、理由と日時を新しいもので置き換える。
      const kept = pruneUnlocks(all, now)
        .filter((u) => !(ids.includes(u.sessionId) && normalize(u.path) === normalize(abs)));
      writeUnlocks([...kept, entry]);
    });
  } catch (e) {
    if (e.code === 'ELOCKED') return failUnlock(lockedMessage());
    // ロックの取得で落ちた場合は stage がまだ 'read' のままだが、状態ファイルは読んでいない
    // (withUnlockLock のコメント)。読みの案内より先に判定する。
    if (e.lockFailure) return failUnlock(lockFailureMessage(e));
    if (stage === 'read') {
      return failUnlock([
        `[account-guard] 解除の状態ファイルを読めません(${e.code || e.message})。`,
        `${UNLOCKS} を直すか削除してから、もう一度実行してください。`,
        '(黙って書き直すと、他のセッションの解除まで消えます)',
      ]);
    }
    return failUnlock(`[account-guard] 解除を保存できません(${e.code || e.message}): ${UNLOCKS}`);
  }
  appendUnlockLog('unlock', entry);

  console.log(`[account-guard] 解除しました: ${abs}`);
  console.log(`  保護ツリー: ${owner.tree}(許可: ${owner.allow.length ? owner.allow.join(' / ') : 'なし'})`);
  console.log(`  現在のアカウント: ${account}`);
  console.log(`  理由: ${reason}`);
  console.log('  このセッションでだけ有効です。セッションが終われば自動的に失効します。');
  console.log('  取り消すには guard lock(範囲を指定するなら guard lock --path <dir>)。');
  // 元々許可されているツリーを解除しても実害はないが、「解除したのに何も変わらない」と
  // 受け取られると、効いていないのは別の原因だと探し始めることになる。
  if (owner.allow.includes(account)) {
    console.log('  なお現在のアカウントはこのツリーで元々許可されているため、いまは解除の効果がありません。');
  }
}

function cmdLock(argv, account) {
  const ids = sessionCandidates({});
  if (!ids.length) {
    return failUnlock([
      '[account-guard] セッション ID を取得できないため、取り消す解除を特定できません。',
      'Claude Code の中から実行してください(CLAUDE_CODE_SESSION_ID が空です)。',
    ]);
  }
  const { sawPath, target, reason, unknownOption } = parseUnlockArgs(argv);
  if (unknownOption) return failUnknownOption(unknownOption);
  if (sawPath && !target) return failUnlock('[account-guard] --path にディレクトリを指定してください。');
  // 裸の引数は捨てずに止める。unlock では理由が入る位置だが lock に理由は無く、`guard lock <dir>`
  // と書いた人は範囲を絞ったつもりでいる。黙って捨てると sawPath が false のまま全部消して
  // 「取り消しました」と返るので、取り違えに気づく機会がない(打ち間違いを弾く上の判定は
  // `--paht` のようなオプション形しか拾えず、この形は素通りする)。
  if (reason) {
    return failUnlock([
      `[account-guard] 範囲を指定するには --path が要ります(何もしていません): ${reason}`,
      `範囲を絞るなら guard lock --path <dir>、このセッションの解除をすべて取り消すなら引数なしの guard lock です。`,
    ]);
  }
  // --path の形も cmdUnlock と揃える。ここだけ緩いと `--path /org-tree/tool-a` が cwd 基準で
  // 解決され、実際にはまだ開いている範囲に対して「解除はありません」と返っていた。
  if (sawPath && !hasDriveLetter(target)) {
    return failUnlock([
      `[account-guard] --path はドライブ文字から始まる絶対パスで指定してください(受け取った値: ${target})。`,
      '相対パスやドライブ文字を省いた形は、意図より広い範囲に効くことがあるため受け付けません。',
    ]);
  }
  const abs = sawPath ? path.resolve(target) : null;

  const now = Date.now();
  // cmdUnlock と同じく、読みと書き戻しは 1 つのロックの中で行う(withUnlockLock)。
  let removed = [];
  let stage = 'read';
  try {
    withUnlockLock(() => {
      const all = readAllUnlocks();
      // --path は完全一致で照合する。配下を指定して親の解除を消せるようにすると、「取り消した
      // つもりなのに範囲が残る/意図より広く消える」のどちらかが必ず起きる。
      removed = all.filter((u) => u && ids.includes(u.sessionId)
        && (!abs || normalize(u.path) === normalize(abs)));
      // 消すものが無いなら書き戻さない。掃除だけのために状態ファイルを触ると、他のセッションと
      // 競合する機会が増えるだけで得るものがない。
      if (!removed.length) return;
      stage = 'write';
      writeUnlocks(pruneUnlocks(all.filter((u) => !removed.includes(u)), now));
    });
  } catch (e) {
    if (e.code === 'ELOCKED') return failUnlock(lockedMessage());
    // cmdUnlock と同じ理由でロック取得の失敗を先に分ける(withUnlockLock のコメント)。
    if (e.lockFailure) return failUnlock(lockFailureMessage(e));
    if (stage === 'read') {
      return failUnlock([
        `[account-guard] 解除の状態ファイルを読めません(${e.code || e.message})。`,
        `${UNLOCKS} を直すか削除してください(削除すれば解除はすべて無効になります)。`,
      ]);
    }
    return failUnlock(`[account-guard] 解除の取り消しを保存できません(${e.code || e.message}): ${UNLOCKS}`);
  }

  if (!removed.length) {
    console.log(abs
      ? `[account-guard] ${abs} に対する解除はありません(照合は完全一致です。guard status で範囲を確認できます)。`
      : '[account-guard] このセッションで有効な解除はありません。');
    return;
  }
  for (const u of removed) appendUnlockLog('lock', { ...u, account, at: new Date(now).toISOString() });

  console.log('[account-guard] 解除を取り消しました。');
  for (const u of removed) console.log(`  ${u.path}`);
}

// status の一部。判定を変えている要素なので、保護ルールと並べて必ず出す。
function printUnlockStatus() {
  if (homeUnresolved) {
    console.log('解除: ホームディレクトリを特定できないため、状態を確認できません');
    return;
  }
  if (!sessionCandidates({}).length) {
    console.log('解除: セッション ID を取得できないため確認できません(Claude Code の外から実行しています)');
    return;
  }
  const active = activeUnlocks({});
  if (!active.length) {
    console.log('解除: なし(このセッションで解除中の範囲はありません)');
    return;
  }
  console.log('解除: このセッションでは次の範囲だけ保護を外しています');
  for (const u of active) {
    console.log(`  ${u.path}`);
    console.log(`    理由: ${u.reason || '(記録なし)'} / 解除時のアカウント: ${u.account || '不明'} / ${u.at || '日時不明'}`);
  }
  console.log('  取り消すには guard lock(範囲を指定するなら guard lock --path <dir>)。');
}

function main() {
  const mode = process.argv[2] || '';
  const account = currentAccount();
  const config = loadConfig();

  // 解除の追加・取り消し。どちらも手打ち用で、フックからは呼ばれない。unlock はユーザーが `!` で
  // 打つ経路だけを想定している(Claude のツール呼び出しは isUnlockAttempt が先に拒否するので、
  // そもそもここへ届かない)。lock は安全側に戻す操作なので Claude からも打てる。
  if (mode === 'unlock') { cmdUnlock(process.argv.slice(3), config, account); return; }
  if (mode === 'lock') { cmdLock(process.argv.slice(3), account); return; }

  // 手元での確認用。フックからは呼ばれない。
  if (mode === 'status') {
    console.log(`アカウント: ${account}`);
    // 判別不能の原因が credentials.js の置き忘れなら、ここで言わないと未ログインと区別が
    // 付かない。deny メッセージ側でわざわざ塞いだ袋小路(/login を繰り返しても直らない)を、
    // 確認用の入り口で踏ませないため。
    if (credentialsLoadError && credentialsLoadError.code === 'HOME_UNRESOLVED') {
      // credentials.js は読めている(=置き場所は合っている)。原因は環境変数なので、
      // 下の「隣に置いてください」を出すと、既に隣にある正しいファイルをコピーし直せと
      // 効かない指示を繰り返させることになる。swap.js が同じ例外を特別扱いしているのと
      // 同じ理由で、ここでも分ける(案内する対処も homeUnresolvedMessage() に合わせる)。
      console.log('  ホームディレクトリを特定できません'
        + ' (USERPROFILE / HOME / os.homedir() のいずれも使える値を返していません)');
      console.log('  credentials.js の置き場所は正しいので、コピーし直しても直りません。');
      console.log('  USERPROFILE または HOME に実在するホームディレクトリを設定してください。');
    } else if (credentialsLoadError) {
      console.log(`  credentials.js を読み込めません (${path.join(__dirname, 'credentials.js')}: `
        + `${credentialsLoadError.code || credentialsLoadError.message})`);
      console.log('  未ログインではなく、判別する手段が無い状態です。`/login` では直りません。');
      console.log('  account-guard.js の隣に credentials.js を置いてください。');
    }
    // 解除は判定を変える要素なので、設定の表示より先に出す。config が壊れている・HOME を
    // 特定できないときは下で早期 return するため、ここに置かないと解除だけが見えなくなる。
    printUnlockStatus();
    // HOME が解決できないときの CONFIG はダミーの相対パスで、実在しない。共通の書式に
    // 任せると「未作成 — 保護は無効」と出るが、実態は逆でこの状態は全操作を拒否している。
    // しかも「設定ファイル自身の編集以外は拒否」と案内しても、実在しないパスでは
    // isConfigRepair が成立しないので、そのファイルを直しても何も通らない。status は
    // 「全部拒否される」原因を調べに来る入り口なので、ここで行き止まりに入れてしまうと、
    // ガードを外す方向の回避しか残らない。逃げ道は homeUnresolvedMessage() と揃える。
    if (config.homeUnresolved) {
      console.log('設定: ホームディレクトリを特定できないため、場所を決められません');
      console.log('  (USERPROFILE / HOME / os.homedir() のいずれも使える値を返していません)');
      console.log('保護は無効ではありません — この状態ではすべての操作を拒否しています(安全側)。');
      console.log('  USERPROFILE または HOME に実在するホームディレクトリを設定すれば直ります。');
      console.log('  直せない場合は .claude/settings.json から account-guard のフック登録を'
        + '外してください(保護は外れるので、直したあとに戻してください)。');
      return;
    }
    // 「未作成 — 保護は無効」と言い切れるのは、設定が本当に無いときだけ。existsSync は
    // 読めないだけの設定も false にするので、broken(修復するまで全拒否 = 保護は最も強く
    // 効いている)状態に対して「保護は無効」と正反対の表示を出していた。判定は probeFile に
    // 合流させ、broken が分かっているときはそちらの表示に任せる(すぐ下で出す)。
    // credentials.js を読み込めなかった構成では probeFile が使えない。そこで判定ごと諦めると、
    // 設定が本当に無くても「未作成 — 保護は無効」が出なくなる。status は「なぜ拒否される/
    // されない」を調べに来る入り口なので、精度は落ちても存在の有無だけは伝える
    // (existsSync は読めないだけの設定も false にするが、その場合は config.broken 側の
    // 表示がすぐ下で出るため、ここで取り違えたまま終わることはない)。
    const configExists = credentials ? credentials.probeFile(CONFIG).exists : fs.existsSync(CONFIG);
    const configMissing = !config.broken && !configExists;
    console.log(`設定: ${CONFIG}${configMissing ? ' (未作成 — 保護は無効)' : ''}`);
    if (config.broken) {
      console.log('設定を読めません — 修復するまで、設定ファイル自身の編集以外は拒否します。');
      return;
    }
    if (!config.rules.length) {
      console.log('保護ルール: なし。config.json に rules を書くまで何も拒否しません。');
      return;
    }
    for (const r of config.rules) {
      const state = r.allow.includes(account) ? '許可' : '拒否';
      console.log(`  ${r.tree}  allow=[${r.allow.join(', ')}]  → 現在は ${state}`);
    }
    const probe = process.argv[3];
    if (probe) {
      // 解除も反映して判定する。status は「なぜ拒否される/されない」を確かめに来る入り口なので、
      // 実際の判定と食い違う結果を出すと、解除が効いているかどうかを確かめる手段が無くなる。
      const hit = violation({ cwd: probe, tool_input: {} }, account, config, unlockedPaths({}));
      console.log(`判定(cwd=${probe}): ${hit ? '拒否 — ' + hit.reason : '通過'}`);
    }
    return;
  }

  const input = readHookInput();
  const event = input.hook_event_name || mode || 'PreToolUse';
  const isPreTool = event === 'PreToolUse';

  // PreToolUse 以外のイベントには「操作の対象」が無いので cwd だけで判定する。
  // SessionStart / CwdChanged の入力にツール引数は含まれず、含まれない値を見に行くと
  // 判定の根拠が曖昧になるため、明示的に絞る。
  // 解除はセッションに紐づくので、PreToolUse 以外の経路でも同じ入力から読む(session_id は
  // SessionStart / CwdChanged の入力にも入る)。
  const unlocked = unlockedPaths(input);
  const notes = [];
  const hit = violation(
    isPreTool ? input : { cwd: input.cwd, session_id: input.session_id, tool_input: {} },
    account, config, unlocked, notes
  );
  if (!hit) {
    // 解除が実際に効いた(本来なら拒否していた)回だけ、解除中であることを文脈に載せる。毎回
    // 出すと雑音になり、肝心の「いま保護が外れている」が埋もれる。
    // PreToolUse の additionalContext が文脈へ載るかは Claude Code の実装次第だが、載らなくても
    // 害はない(permissionDecision を返さないので、判定は通常の権限フローに委ねられたまま)。
    if (notes.length) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: unlockAppliedMessage(unlocked, notes) },
      }));
    }
    return; // 何も出力しなければ通常の権限フローに委ねられる。
  }

  // 拒否できるのは PreToolUse だけ。SessionStart / CwdChanged は公式に
  // "No blocking or decision control" とされており、将来このフックを別のイベントに
  // 登録した場合も同じ。deny 形式を返しても破棄されるので、警告として文脈に載せる
  // (reportCrash と同じ方針)。ここで気づければ無駄な往復を減らせる。
  if (!isPreTool) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: denyMessage(hit, account) },
      })
    );
    return;
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denyMessage(hit, account),
      },
    })
  );
}

// ガード自身が異常終了したときの後始末。
//
// 以前はここで無条件に deny を返していたが、それではガードが壊れた瞬間に
// 「このマシンの全ツール呼び出し」が止まる。実際に起きたとき、ガード自身を直す Edit も
// 止まったファイルを読む Read も通らず、Claude Code の外から git で戻すしか手が
// なくなった。保護ツリーと無関係な作業まで巻き添えにするのは、冒頭に書いた
// 「判定できたものだけを拒否する」方針にも反する。
//
// そこで、例外が起きても判定できる範囲 — cwd が保護ツリーの内側かどうか — だけを見る。
// 内側なら止め、外側なら通す。内側での取りこぼしは残るが、それは「ガードが壊れている」
// という異常時に限られ、全停止の代償のほうが大きい。
function reportCrash(e) {
  const config = loadConfig();
  const input = readHookInput();
  const account = currentAccount();
  const cwd = input.cwd || process.cwd();

  // 設定が壊れているなら、この経路でも main と同じく拒否側に倒す(修復操作だけは通す)。
  // 逃げ道の判定は isEscapeHatch に集約してあり、main(violation)と揃う(過去にここだけ
  // isConfigRepair しか見ずにドリフトした経緯は isEscapeHatch のコメント参照)。
  // 保護ルール未設定なら find が何も返さず、何も拒否しない。
  // ガードが壊れている間だけ解除の遮断が外れる、という穴を作らない。判定は通常経路と同じ関数に
  // 合流させる(ここだけ別の条件を書くと、片方を直したときにドリフトする ―― isEscapeHatch を
  // 切り出した経緯と同じ)。
  //
  // ただしこの 3 つは targetStrings 系(expandHomeIn / tokensIn / cwdCandidates / ブレース展開)を
  // 通る。最初の例外がそこから出ていた場合、ここで同じ例外が再発して reportCrash 自体が落ち、
  // 外側の catch は stderr に書くだけ ―― 拒否が出力されず呼び出しは通ってしまう。縮小判定の
  // 本体である cwd の拒否まで巻き添えにしないよう、個別に握りつぶして安全側の既定に倒す
  // (解除の遮断は失われるが、cwd がツリー内なら下の find が拒否する)。
  let unlockBlocked = null;
  try {
    unlockBlocked = isUnlockAttempt(input) ? 'attempt' : isUnlockStateWrite(input) ? 'state' : null;
  } catch {
    unlockBlocked = null;
  }

  // 解除はこの縮小判定にも効かせる。反映しないと「ガードが壊れている間だけ解除が無視されて
  // 詰む」穴が残る。読めなければ unlockedPaths が空を返し、従来どおり拒否側に倒れる。
  // 例外時も同じく空にする ―― 解除なしと見なすので拒否側。
  let unlocked = [];
  try {
    unlocked = unlockedPaths(input);
  } catch {
    unlocked = [];
  }
  const repairable = isEscapeHatch(input, config);
  const hit = unlockBlocked
    ? { unlockBlocked }
    : config.broken
      ? repairable
        ? null
        : { tree: CONFIG, broken: true, homeUnresolved: !!config.homeUnresolved }
      : config.rules.find((r) => !r.allow.includes(account) && isInsideTree(cwd, r.tree)
        && !coveredByUnlock(cwd, unlocked));
  if (!hit) return;

  const detail = hit.unlockBlocked
    ? (hit.unlockBlocked === 'attempt' ? unlockAttemptMessage() : unlockStateMessage())
    : [
    `[account-guard] ガードが異常終了しました(原因: ${e && e.message})。`,
    // HOME 未解決のときの CONFIG はダミー値なので、そのパスを「読めない設定ファイル」として
    // 出すと存在しない場所を直しに行かせることになる。原因も逃げ道も違うので文面を分ける。
    hit.broken
      ? hit.homeUnresolved
        ? 'ホームディレクトリを特定できず、設定ファイルの場所も決められないため、安全側に倒します。'
        : `設定ファイル ${CONFIG} も読めないため、安全側に倒します。`
      : `作業ディレクトリが ${hit.tree} 配下にあるため、安全側に倒します。`,
    '',
    'ガード自体の不具合の可能性があります。保護ツリーの外での作業は影響を受けません。',
    ...(hit.homeUnresolved
      // 逃げ道は文面にも書く。書かないと「全部拒否された」だけが伝わり、Claude Code の
      // 外へ出るしかないと判断される(homeUnresolvedMessage() と同じ理由)。
      ? ['この状態でも `.claude/settings.json` の読み書きだけは許可しています。'
        + '環境変数(USERPROFILE / HOME)を直せない場合は、そこからフック登録を外してください。']
      : []),
    'ガードを戻すには Claude Code の外から:',
    '  git checkout -- account-guard/account-guard.js',
  ].join('\n');

  // 拒否できるのは PreToolUse だけ。それ以外のイベントで deny 形式を返しても破棄されるので、
  // 警告として文脈に載せる(hookEventName は受け取ったイベントをそのまま返す必要がある)。
  const event = input.hook_event_name || process.argv[2] || 'PreToolUse';
  if (event !== 'PreToolUse') {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: detail } })
    );
    return;
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: detail,
      },
    })
  );
}

try {
  main();
} catch (e) {
  try {
    reportCrash(e);
  } catch (e2) {
    // 縮小判定すら組み立てられなかった(設定もフック入力も読めない)。ここで deny を出すと
    // 原因の分からないまま全停止になるので、reportCrash 本体と同じく通す側に倒す。ただし
    // 黙って消えると「ガードが動いていない」ことに気づけないので、痕跡だけ stderr に残す
    // ―― stderr はフックの判定結果として解釈されないため、これで結論は変わらない。
    try {
      console.error(`[account-guard] ガードが二重に失敗しました: ${e && e.message} / ${e2 && e2.message}`);
    } catch {
      // 出力すらできない状況では何もできない。
    }
  }
}
