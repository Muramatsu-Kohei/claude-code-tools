// Claude Code ステータスライン
// カラーカスタマイズは90行付近だけ変更

// settings.json の statusLine から `node <このファイル>` として呼ばれ、stdin で渡される JSON から
// モデル・推論設定・コンテキスト使用率・コスト・差分行数・プラン利用枠(5時間/週次)を1行で出力する。
// 出力例:
//   claude | Opus5 hi | ctx 5% 950k | $0.28 +12/-3 | 5h 16% 11:54 | 7d 2% Wed 09:20
// プラン枠の情報は claude.ai サブスク認証時にしか渡ってこないため、欠損時は黙って省く。
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

// ANSI エスケープシーケンスの先頭文字
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

// スタイル
const ST = { reset: 0, bold: 1, dim: 2, italic: 3, underline: 4, blink: 5, reverse: 7, strike: 9 };

// 文字色
const FG = {
  black: 30, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, white: 37,
  gray: 90, brightRed: 91, brightGreen: 92, brightYellow: 93, brightBlue: 94,
  brightMagenta: 95, brightCyan: 96, brightWhite: 97,
};

// 背景
const BG = {
  black: 40, red: 41, green: 42, yellow: 43, blue: 44, magenta: 45, cyan: 46, white: 47,
  gray: 100, brightRed: 101, brightGreen: 102, brightYellow: 103, brightBlue: 104,
  brightMagenta: 105, brightCyan: 106, brightWhite: 107,
};

// 複数のコードを1つのエスケープにまとめて、指定できるような形式に変換する。c(ST.bold, FG.cyan) -> "ESC[1;36m"
// スタイル = エスケープ頭文字 + [ + スタイル + ; + 文字色 + ; + 背景色 + m
const c = (...codes) => `${ESC}[${codes.join(';')}m`;

// スタイルリセット
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
  model: c(ST.dim),               // モデル名
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
// 100%上限の場合
const PCT_WARN = 70;
const PCT_CRIT = 90;
// 使用コストの場合
const COST_WARN = 5;
const COST_HIGH = 20;

// 使用率に応じた色。閾値は上の定数で決まる。
const colorFor = (pct) => (pct >= PCT_CRIT ? THEME.crit : pct >= PCT_WARN ? THEME.warn : THEME.ok);

const write = (text) => process.stdout.write(Buffer.from(text + '\n', 'utf8'));
 
// ファイルディスクリプタ0番（fd 0 = 標準入力）の同期読み取り。End Of File まで読み切るので部分読みにならない。
let raw = '';
try {
  raw = fs.readFileSync(0, 'utf8');
} catch (e) {
  // パイプが無い/閉じている場合。黙って終わると行が消えて切り分け不能になるため理由を出す。
  write(`${THEME.fallback}(statusline: no stdin)${RESET}`);
  process.exit(0);
}

// 空行チェック
if (!raw.trim()) {
  write(`${THEME.fallback}(statusline: no input)${RESET}`);
  process.exit(0);
}

// Jsonへのパース
let d;
try {
  d = JSON.parse(raw);
} catch (e) {
  write(`${THEME.fallback}(statusline: bad json)${RESET}`);
  process.exit(0);
}

// リセット時刻の整形。当日中なら時刻のみ、翌日以降は曜日を添える。
// resets_at は Unix epoch 秒でも ISO 8601 文字列でも渡ってくる可能性があるため両対応にする。
// 日本語を使うと文字コード関連でおかしくなるので、英語(ASCII)推奨
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// 1時5分を01時05分のように2桁に合わせ込む
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

  if (isNaN(t.getTime())) {
    return null;
  }

  // 時刻
  const hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  const now = new Date();
  const sameDay =
    t.getFullYear() === now.getFullYear() &&
    t.getMonth() === now.getMonth() &&
    t.getDate() === now.getDate();
  // "Sun11:54" と詰めると曜日と時刻が読みにくいため、ここはスペースを入れる。
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

const parts = [];

// ディレクトリ名。パスの区切りは win32/posix の両方を見る。
const dirPath = d.workspace?.current_dir || d.cwd;
if (dirPath) {
  const leaf = String(dirPath).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  if (leaf) parts.push(`${THEME.dir}${leaf}${RESET}`);
}

// モデルと推論設定を1グループにまとめる。区切りを増やさずに済み、
// 「どのモデルをどの強度で回しているか」が一続きで読める。
const modelBits = [];
if (d.model?.display_name) {
  // "Opus 5" -> "Opus5"。空白を潰しても識別性は落ちない。
  modelBits.push(`${THEME.model}${String(d.model.display_name).replace(/\s+/g, '')}${RESET}`);
}
// エフォートは2〜3文字に短縮。
const EFFORT = { low: 'lo', medium: 'md', high: 'hi', xhigh: 'xhi', max: 'max' };
const effort = EFFORT[d.effort?.level];
if (effort) {
  // xhigh/max は消費が跳ねるので色で気づけるようにする。
  const style = effort === 'xhi' || effort === 'max' ? THEME.effortHigh : THEME.effort;
  modelBits.push(`${style}${effort}${RESET}`);
}
// 既定から外れた状態だけ出す。fast は挙動が変わるので目立たせ、thinking 無効は珍しいので明示する。
if (d.fast_mode === true) modelBits.push(`${THEME.fast}fast${RESET}`);
if (d.thinking?.enabled === false) modelBits.push(`${THEME.nothink}nothink${RESET}`);
if (modelBits.length) parts.push(modelBits.join(' '));

// コンテキストウィンドウ。セッション開始直後や /compact 直後は null になる。
// 窓が 1M あると % だけでは残量の絶対感が掴めないため、残りトークン数を併記する。
const cw = d.context_window;
const ctx = cw?.used_percentage;
if (typeof ctx === 'number' && isFinite(ctx)) {
  const p = Math.floor(ctx);
  let s = `${colorFor(p)}ctx ${p}%${RESET}`;
  const size = cw.context_window_size;
  const used = (cw.total_input_tokens || 0) + (cw.total_output_tokens || 0);
  if (typeof size === 'number' && size > 0 && used > 0) {
    s += ` ${THEME.tokens}${shortTokens(Math.max(0, size - used))}${RESET}`;
  }
  parts.push(s);
}

// コストと差分行数を1グループに。どちらも「このセッションで何をどれだけ動かしたか」の指標。
const workBits = [];
const usd = d.cost?.total_cost_usd;
if (typeof usd === 'number' && isFinite(usd) && usd > 0) {
  // サブスク利用の場合は実課金額ではなく相対的な重さの目安。
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
