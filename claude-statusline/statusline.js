// Claude Code ステータスライン
//
// settings.json の statusLine から `node <このファイル>` として呼ばれ、stdin で渡される JSON から
// モデル・推論設定・コンテキスト使用率・コスト・差分行数・プラン利用枠(5時間/週次)を1行で出力する。
// 出力例:
//   claude @max | Opus5 hi | ctx 47k | $0.28 +12/-3 | 5h 16% 11:54 | 7d 2% Wed 09:20
// プラン枠の情報は claude.ai サブスク認証時にしか渡ってこないため、欠損時は黙って省く。
// `@max` は account-guard を併用している場合だけ出るアカウントスロット名(後述の readAccountSlot)。
//
// 幅の方針: ステータスラインは常時表示で横幅が貴重なため、区切り(" | ")の数を増やさないよう
// 関連する値をグループにまとめ、"Opus 5" は "Opus5" のように詰める。
// また「通常状態は出さない」方針を取る。thinking 有効・fast 無効・差分0行・コスト0は既定なので
// 省き、既定から外れたときだけ現れるようにして情報量あたりの幅を稼ぐ。
//
// なぜ PowerShell 版(statusline.ps1)ではなく Node なのか:
//   Windows PowerShell は -File 実行時に stdin を自ら読み切って $input に入れ、そのデコードに
//   コンソールのコードページ(日本語環境では cp932)を使う。そのため自前で UTF-8 として読み直す
//   余地がなく、JSON の session_name(日本語のセッション名)が壊れて引用符が欠落し、パースに
//   失敗してステータスラインが消えていた。実測値は src=input inputEnc=shift_jis で、pwsh 7 でも
//   親プロセスのコードページを継承するため同じく壊れる。Node は fs.readFileSync(0) で stdin を
//   生バイトから読めるためこの問題が構造的に起きず、起動も速い(約55ms 対 PowerShell 約520ms)。
//
// 出力は ASCII に限定する。曜日名を ja-JP ロケール(「土」など)にすると表示側が cp932 として
// 解釈して文字化けするため、曜日は英語3文字で出す。ディレクトリ名など入力由来の非 ASCII は
// 同じ理由で化ける可能性が残るが、そこは表示側の制約なのでこちらでは手を入れない。
//
// 設計上の要点:
//  - 各値は欠損・null・型違いを想定して個別に判定する。1箇所の不整合で行全体を失わないため。
//  - 異常時も必ず1行出す。無出力にするとステータスラインが消え、原因の切り分けが不能になる。

const fs = require('fs');
const os = require('os');
const path = require('path');

const ESC = '\x1b';

// ===========================================================================
//  ANSI エスケープ早見表
// ===========================================================================
// 書式は `ESC[<code>m`。複数指定は `;` 区切り(例: ESC[1;36;44m = 太字 + シアン文字 + 青背景)。
// このファイルでは下の c() ヘルパーで組み立てる:  c(ST.bold, FG.cyan, BG.blue)
// 色を開始したら必ず RESET で閉じる。閉じ忘れると以降の表示に色が漏れる。
//
//  スタイル(ST)     文字色(FG)        明るい文字色(FG)      背景色(BG)      明るい背景色(BG)
//   0 reset          30 black          90 gray               40 black        100 gray
//   1 bold           31 red            91 brightRed          41 red          101 brightRed
//   2 dim            32 green          92 brightGreen        42 green        102 brightGreen
//   3 italic         33 yellow         93 brightYellow       43 yellow       103 brightYellow
//   4 underline      34 blue           94 brightBlue         44 blue         104 brightBlue
//   5 blink          35 magenta        95 brightMagenta      45 magenta      105 brightMagenta
//   7 reverse        36 cyan           96 brightCyan         46 cyan         106 brightCyan
//   9 strike         37 white          97 brightWhite        47 white        107 brightWhite
//
//  256色:   文字 c(38, 5, n)          背景 c(48, 5, n)           n = 0-255
//           例: c(38, 5, 208) でオレンジ。n は 16-231 が 6x6x6 のカラーキューブ、
//               232-255 がグレースケール、0-15 は上の基本16色に対応する。
//  24bit:   文字 c(38, 2, r, g, b)    背景 c(48, 2, r, g, b)     各 0-255
//           例: c(38, 2, 255, 128, 0) でオレンジ。対応しない端末では無視される。
//
// 使うときの注意:
//  - italic / blink / strike は端末依存で無視されることがある。bold / dim / underline は概ね安全。
//  - 見え方は端末のカラーテーマに左右される。基本16色はテーマ側で色味が差し替えられるため、
//    「どのテーマでも同じ色」にしたいなら 256色か 24bit で直接指定する。
//  - 背景色を広い範囲に使うとステータスラインだけ浮くので、警告時など限定的に使うとよい。
//  - dim と bright系の組み合わせ(例: c(ST.dim, FG.brightBlack))は端末によって潰れて読めなくなる。
// ===========================================================================

const ST = { reset: 0, bold: 1, dim: 2, italic: 3, underline: 4, blink: 5, reverse: 7, strike: 9 };

const FG = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  gray: 90, brightRed: 91, brightGreen: 92, brightYellow: 93, brightBlue: 94,
  brightMagenta: 95, brightCyan: 96, brightWhite: 97,
};

const BG = {
  black: 40, red: 41, green: 42, yellow: 43, blue: 44, magenta: 45, cyan: 46, white: 47,
  gray: 100, brightRed: 101, brightGreen: 102, brightYellow: 103, brightBlue: 104,
  brightMagenta: 105, brightCyan: 106, brightWhite: 107,
};

// 複数のコードを1つのエスケープにまとめる。c(ST.bold, FG.cyan) -> "ESC[1;36m"
const c = (...codes) => `${ESC}[${codes.join(';')}m`;

const RESET = c(ST.reset);

// ===========================================================================
//  配色設定 -- 見た目を変えたいときはここだけ書き換える
// ===========================================================================
// 値は c() で作った開始シーケンス。上の早見表から名前を選んで組み合わせる。
// 例: dir を目立たせる      -> dir: c(ST.bold, FG.brightCyan)
//     コスト警告に背景色     -> costWarn: c(FG.black, BG.yellow)
//     テーマ非依存の色にする -> ok: c(38, 5, 71)
const THEME = {
  sep: c(ST.dim),                 // 項目の区切り " | "
  dir: c(FG.cyan),                // カレントディレクトリ名
  account: c(FG.magenta),         // アカウントスロット(account-guard 導入時のみ)
  model: c(ST.dim),               // モデル名
  modelAlt: c(FG.brightBlue),     // モデル名(利用枠が別建てのモデル。下の ALT_MODEL_RE を参照)
  effort: c(ST.dim),              // 推論エフォート(low/medium/high)
  effortHigh: c(FG.yellow),       // 推論エフォート(xhigh/max) -- 消費が跳ねるので警告色
  fast: c(FG.yellow),             // fast モード有効
  nothink: c(ST.dim),             // 拡張思考が無効
  tokens: c(ST.dim),              // コンテキスト残りトークン数
  cost: c(ST.dim),                // セッションコスト(通常)
  costWarn: c(FG.yellow),         // セッションコスト($5 以上)
  costHigh: c(FG.red),            // セッションコスト($20 以上)
  lines: c(ST.dim),               // 増減行数
  resetAt: c(ST.dim),             // プラン枠のリセット時刻
  ok: c(FG.green),                // 使用率 70% 未満
  warn: c(FG.yellow),             // 使用率 70% 以上
  crit: c(FG.red),                // 使用率 90% 以上
  fallback: c(ST.dim),            // "(statusline: ...)" の異常時表示
};

// 色が切り替わる閾値。THEME と対で調整する。
const PCT_WARN = 70;
const PCT_CRIT = 90;
const COST_WARN = 5;
const COST_HIGH = 20;

// 利用枠が他モデルと別建てになっているモデル。ここに載せた名前は THEME.modelAlt の色で出る。
// 下の `5h` / `7d` は入力に来た枠の使用率をそのまま出しているだけで、どのモデルの枠かは
// 区別しない。別枠のモデルへ切り替えたことに気づかないまま残量を読むと見込みを外すので、
// モデル名の色で切り分ける。警告色(黄/赤)を使わないのは、危険ではなく「別勘定」だから。
const ALT_MODEL_RE = /fable/i;

// コンテキストは比率ではなく絶対量でも警告する。
// 窓が 1M あると比率の閾値(70%)は 700k 相当になり、実質どこまで伸ばしても緑のままになる。
// 一方コストは絶対量で効く: 実測で 1 ターンの単価は 30〜60k 帯を 1.0 として
// 150k 超で 1.6 倍、200k 超で 2.0 倍、300k 超で 3.6 倍。会話履歴が毎ターン再送されるため。
// そこで単価が明確に上がり始める 150k を警告、切るべき水準の 250k を危険とする。
const CTX_WARN_TOKENS = 150e3;
const CTX_CRIT_TOKENS = 250e3;

// 使用率に応じた色。閾値は上の定数で決まる。
const colorFor = (pct) => (pct >= PCT_CRIT ? THEME.crit : pct >= PCT_WARN ? THEME.warn : THEME.ok);

// コンテキストの色。比率と絶対量のうち厳しい方を採る。
function ctxColor(pct, usedTokens) {
  if (pct >= PCT_CRIT || usedTokens >= CTX_CRIT_TOKENS) return THEME.crit;
  if (pct >= PCT_WARN || usedTokens >= CTX_WARN_TOKENS) return THEME.warn;
  return THEME.ok;
}

const write = (text) => process.stdout.write(Buffer.from(text + '\n', 'utf8'));

// fd 0 の同期読み取り。EOF まで読み切るので部分読みにならない。
let raw = '';
try {
  raw = fs.readFileSync(0, 'utf8');
} catch (e) {
  // パイプが無い/閉じている場合。黙って終わると行が消えて切り分け不能になるため理由を出す。
  write(`${THEME.fallback}(statusline: no stdin)${RESET}`);
  process.exit(0);
}

if (!raw.trim()) {
  write(`${THEME.fallback}(statusline: no input)${RESET}`);
  process.exit(0);
}

let d;
try {
  d = JSON.parse(raw);
} catch (e) {
  write(`${THEME.fallback}(statusline: bad json)${RESET}`);
  process.exit(0);
}

// リセット時刻の整形。当日中なら時刻のみ、翌日以降は曜日を添える。
// resets_at は Unix epoch 秒でも ISO 8601 文字列でも渡ってくる可能性があるため両対応にする。
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n).padStart(2, '0');

function formatReset(value) {
  if (value === null || value === undefined || value === '') return null;
  let t;
  if (typeof value === 'number') {
    t = new Date(value * 1000);
  } else if (/^\d+$/.test(String(value))) {
    t = new Date(Number(value) * 1000);
  } else {
    t = new Date(String(value));
  }
  if (isNaN(t.getTime())) return null;
  const hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  const now = new Date();
  const sameDay =
    t.getFullYear() === now.getFullYear() &&
    t.getMonth() === now.getMonth() &&
    t.getDate() === now.getDate();
  // "Sun11:54" と詰めると曜日と時刻が団子になって読みにくいため、ここはスペースを入れる。
  return sameDay ? hm : `${DAYS[t.getDay()]} ${hm}`;
}

// トークン数を3〜4文字に圧縮する。桁が読めれば十分なので有効数字は追わない。
function shortTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

// コストは桁が増えるほど小数を削り、常に5〜6文字に収める。
function shortCost(v) {
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 10) return `$${v.toFixed(1)}`;
  return `$${v.toFixed(2)}`;
}

// アカウントスロット。account-guard が `~/.claude/accounts/.current` に書く「前回 swap した先」。
// 起動バナーの組織名は `~/.claude.json` の 24 時間キャッシュで、swap してもプラン名だけが先に
// 変わり組織名は最大 1 日前のアカウントのまま残る(実測で確認済み)。バナーを信じて別プランの
// 枠を溶かす取り違えを防ぐため、常時見えるここに「いまどのスロットか」を出す。
// これは来歴であって現在のログインの証明ではない(swap を通さず /login し直すと古いまま残る)。
// それでもバナーより新しく、swap 運用の範囲では最も確かな手掛かりになる。
// account-guard を使っていない環境ではファイルごと存在しないので、そのときは何も出さない
// (「既定から外れたときだけ出す」の方針どおり、無関係な利用者の幅を奪わない)。
function readAccountSlot() {
  try {
    const home = os.homedir();
    if (!home) return null;
    const raw = fs.readFileSync(path.join(home, '.claude', 'accounts', '.current'), 'utf8');
    const name = raw.trim();
    // 壊れた・書き換えられたファイルから制御文字(ANSI エスケープ)や長大な文字列が
    // 表示へ流れ込まないようにする。許す字種は account-guard のスロット名に合わせる。
    return /^[a-zA-Z0-9_-]{1,20}$/.test(name) ? name : null;
  } catch (e) {
    return null; // 未導入(ENOENT)でも読めない場合でも、表示を諦めるだけにする。
  }
}

const parts = [];

// 先頭グループ。「どこで」「どのアカウントで」作業しているかをまとめ、区切りを増やさない。
const headBits = [];

// ディレクトリ名。パスの区切りは win32/posix の両方を見る。
const dirPath = d.workspace?.current_dir || d.cwd;
if (dirPath) {
  const leaf = String(dirPath).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  if (leaf) headBits.push(`${THEME.dir}${leaf}${RESET}`);
}

// `@` を付けるのはディレクトリ名との地続きを断つため。色だけに頼ると、色を落とす端末や
// 配色を変えた環境で "claude max" がパスの一部に見える。
const slot = readAccountSlot();
if (slot) headBits.push(`${THEME.account}@${slot}${RESET}`);

if (headBits.length) parts.push(headBits.join(' '));

// モデルと推論設定を1グループにまとめる。区切りを増やさずに済み、
// 「どのモデルをどの強度で回しているか」が一続きで読める。
const modelBits = [];
if (d.model?.display_name) {
  // 利用枠が他モデルと別建てのモデルは色を変える。同じ 5 時間枠を食っている前提で
  // 残量を読むと見込みを外すため、モデル名そのもので気づけるようにしておく。
  // id と表示名の両方を見るのは、表示名の付け方(世代番号の有無など)が変わりうるため。
  const alt = ALT_MODEL_RE.test(d.model.id || '') || ALT_MODEL_RE.test(d.model.display_name);
  // "Opus 5" -> "Opus5"。空白を潰しても識別性は落ちない。
  const name = String(d.model.display_name).replace(/\s+/g, '');
  modelBits.push(`${alt ? THEME.modelAlt : THEME.model}${name}${RESET}`);
}
// エフォートは2〜3文字に短縮。xhigh/max は消費が跳ねるので色で気づけるようにする。
const EFFORT = { low: 'lo', medium: 'md', high: 'hi', xhigh: 'xhi', max: 'max' };
const effort = EFFORT[d.effort?.level];
if (effort) {
  const style = effort === 'xhi' || effort === 'max' ? THEME.effortHigh : THEME.effort;
  modelBits.push(`${style}${effort}${RESET}`);
}
// 既定から外れた状態だけ出す。fast は挙動が変わるので目立たせ、thinking 無効は珍しいので明示する。
if (d.fast_mode === true) modelBits.push(`${THEME.fast}fast${RESET}`);
if (d.thinking?.enabled === false) modelBits.push(`${THEME.nothink}nothink${RESET}`);
if (modelBits.length) parts.push(modelBits.join(' '));

// コンテキストウィンドウ。セッション開始直後や /compact 直後は null になる。
// 主として出すのは % ではなく使用トークン数。判断に効くのは「あと何割か」ではなく「何 k か」で、
// 単価が跳ねる水準(CTX_WARN_TOKENS)も切り上げ時の目安も絶対量で決まっている。1M 窓では
// 250k 使っていても 25% にしかならず、比率は色が変わった理由すら説明できない。
// % を添えるのは窓そのものを使い切りそうなとき(PCT_WARN 以上)だけ。そこでは自動 compact が
// 近いという別種の情報になるので、他の項目と同じく「既定から外れたときだけ出す」に従う。
// 残量ではなく使用量を出すのは、色の閾値が使用量で決まっているため(残量では対応が読めない)。
const cw = d.context_window;
const ctx = cw?.used_percentage;
if (typeof ctx === 'number' && isFinite(ctx)) {
  const p = Math.floor(ctx);
  const used = (cw.total_input_tokens || 0) + (cw.total_output_tokens || 0);
  const color = ctxColor(p, used);
  // トークン数が取れないときだけ % で代替する。無言で消すと項目ごと失われる。
  let s = used > 0 ? `${color}ctx ${shortTokens(used)}${RESET}` : `${color}ctx ${p}%${RESET}`;
  if (used > 0 && p >= PCT_WARN) s += ` ${THEME.tokens}${p}%${RESET}`;
  parts.push(s);
}

// コストと差分行数を1グループに。どちらも「このセッションで何をどれだけ動かしたか」の指標。
const workBits = [];
const usd = d.cost?.total_cost_usd;
if (typeof usd === 'number' && isFinite(usd) && usd > 0) {
  // サブスク利用なので実課金額ではなく相対的な重さの目安。閾値は緩めに取る。
  const style = usd >= COST_HIGH ? THEME.costHigh : usd >= COST_WARN ? THEME.costWarn : THEME.cost;
  workBits.push(`${style}${shortCost(usd)}${RESET}`);
}
const added = d.cost?.total_lines_added || 0;
const removed = d.cost?.total_lines_removed || 0;
if (added > 0 || removed > 0) workBits.push(`${THEME.lines}+${added}/-${removed}${RESET}`);
if (workBits.length) parts.push(workBits.join(' '));

// プラン利用枠。5時間枠と週次枠はそれぞれ独立に欠ける可能性がある。
for (const [node, label] of [
  [d.rate_limits?.five_hour, '5h'],
  [d.rate_limits?.seven_day, '7d'],
]) {
  const used = node?.used_percentage;
  if (typeof used !== 'number' || !isFinite(used)) continue;
  const p = Math.floor(used);
  let s = `${colorFor(p)}${label} ${p}%${RESET}`;
  const r = formatReset(node.resets_at);
  // "31%>05:50" は数字と記号が連なって読み取りづらいので、記号を使わず空白で並べる。
  // リセット時刻は暗く落としてあり、使用率(緑/黄/赤)との明度差で別項目だと分かる。
  if (r) s += ` ${THEME.resetAt}${r}${RESET}`;
  parts.push(s);
}

if (parts.length === 0) {
  write(`${THEME.fallback}(statusline: no fields)${RESET}`);
  process.exit(0);
}

write(parts.join(`${THEME.sep} | ${RESET}`));

// --- usage-tracker hook (begin) ---
// プラン利用枠(5h/7d)の使用率は statusline の入力にしか現れず、transcript にも残らないため
// 後から復元できない。表示を出し終えたこの位置で時系列として書き出しておく。
// 表示とは無関係な副作用なので、収集側が壊れていても statusline の出力には影響しない。
try {
  // 明示指定(CLAUDE_STATUSLINE_HOOK)があれば無条件にそれを使う。誤っていても下の catch で
  // 気付ける。未指定のときは候補を順に試す。__dirname 基準の相対パスはこのリポジトリの中から
  // 直接動かしている場合に解決できるが、README の既定手順(statusline.js だけを
  // ~/.claude/statusline.js にコピーする)ではこのファイルがリポジトリの外に出るため解決できない。
  // そのケースを拾うため、このリポジトリを開いた状態で Claude Code を使っているなら指すはずの
  // CLAUDE_PROJECT_DIR も候補に加える。どちらも「実在すれば使う」だけなので、誤って
  // 個人マシン固有の絶対パスを焼き込む(=他環境で必ず失敗する)心配はない。
  const explicit = process.env.CLAUDE_STATUSLINE_HOOK;
  const fallbacks = [
    `${__dirname}/../usage-tracker/collect.js`,
    process.env.CLAUDE_PROJECT_DIR ? `${process.env.CLAUDE_PROJECT_DIR}/usage-tracker/collect.js` : null,
  ].filter(Boolean);
  const hookPath = explicit || fallbacks.find((p) => fs.existsSync(p));
  if (!hookPath) throw new Error(`usage-tracker hook not found (tried: ${fallbacks.join(', ')})`);
  require(hookPath).record(d);
} catch (e) {
  // 収集は捨てて表示を優先する。ただし無言のままだと usage.jsonl への追記が止まったことに
  // 誰も気付けない(枠切れ警告も出なくなる)。stdout は表示そのものなので汚さず、stderr に
  // だけ残す。通常運用では見えず、`claude --debug` で確認したときだけ表面化する控えめな形。
  process.stderr.write(`[statusline] usage-tracker hook 失敗: ${e.message}\n`);
}
// --- usage-tracker hook (end) ---
