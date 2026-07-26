// ANSI カラープレビュー
//
// statusline.js の配色を決めるための見本表示。端末で実際にどう見えるかを確認できる。
//   node preview-colors.js                            同じフォルダの statusline.js を対象にする
//   node preview-colors.js ~/.claude/statusline.js    稼働中の設定を対象にする
//
// 引数で対象を指定できるのは、配布用のコピーと実際に動いている ~/.claude/statusline.js が
// 別ファイルとして存在しうるため。既定の __dirname 固定だけだと、稼働中の設定を編集したのに
// プレビューには配布用コピーの色が出る、という取り違えが起きる。
//
// 基本16色は端末のカラーテーマ側で色味が差し替えられるため、見え方は環境によって変わる。
// この表示はあくまで「今使っている端末での見え方」であり、配布先で同じに見えるとは限らない。
// どの環境でも同じ色にしたい場合は 256色か 24bit を選ぶこと。
//
// 出力は ASCII のみで構成する。色見本のブロックは「背景色を付けた空白」で描いており、
// 罫線用の非 ASCII 文字を使わずに済ませている(cp932 環境での文字化けを避けるため)。

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ESC = '\x1b';
const c = (...codes) => `${ESC}[${codes.join(';')}m`;
const RESET = c(0);

// statusline.js と同じ定義。ANSI のコード値は標準で不変なため、参照せず再掲している。
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

// 出力が長いので `| head` や `| more` に繋がれることを想定する。読み手が途中で閉じると
// EPIPE が未処理例外になりスタックトレースで画面が埋まるため、正常終了として扱う。
process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

const out = (s = '') => process.stdout.write(Buffer.from(s + '\n', 'utf8'));
const head = (title, note) => {
  out();
  out(`${c(ST.bold)}${title}${RESET}${note ? `  ${c(ST.dim)}${note}${RESET}` : ''}`);
  out(c(ST.dim) + '-'.repeat(76) + RESET);
};
const padEnd = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));

// --- スタイル ---------------------------------------------------------------
head('スタイル (ST)', 'c(ST.bold) のように指定');
for (const [name, code] of Object.entries(ST)) {
  if (name === 'reset') continue;
  const label = padEnd(`c(ST.${name})`, 18) + padEnd(String(code), 4);
  out(`  ${c(ST.dim)}${label}${RESET}${c(code)}Sample text 123${RESET}`);
}
// 複数指定の例。ラベルに全角を混ぜると padEnd の桁計算がずれるため、この行だけ整列させない。
out(`  ${c(ST.bold, ST.underline, FG.cyan)}複数のコードをまとめて指定できる${RESET}  ${c(ST.dim)}c(ST.bold, ST.underline, FG.cyan)${RESET}`);

// --- 文字色 -----------------------------------------------------------------
// 通常色と明るい色を左右に並べ、同系色を直接比べられるようにする。
head('文字色 (FG)', 'c(FG.red) のように指定。左が通常色、右が明るい色');
const FG_PAIRS = [
  ['black', 'gray'], ['red', 'brightRed'], ['green', 'brightGreen'], ['yellow', 'brightYellow'],
  ['blue', 'brightBlue'], ['magenta', 'brightMagenta'], ['cyan', 'brightCyan'], ['white', 'brightWhite'],
];
for (const [a, b] of FG_PAIRS) {
  const left = `${c(ST.dim)}${padEnd(`c(FG.${a})`, 20)}${padEnd(String(FG[a]), 4)}${RESET}${c(FG[a])}Sample${RESET}`;
  const right = `${c(ST.dim)}${padEnd(`c(FG.${b})`, 22)}${padEnd(String(FG[b]), 4)}${RESET}${c(FG[b])}Sample${RESET}`;
  out(`  ${padEnd(left, 0)}   ${right}`);
}

// --- 背景色 -----------------------------------------------------------------
head('背景色 (BG)', 'c(BG.red) のように指定。文字色と組み合わせて使う');
const BG_PAIRS = [
  ['black', 'gray'], ['red', 'brightRed'], ['green', 'brightGreen'], ['yellow', 'brightYellow'],
  ['blue', 'brightBlue'], ['magenta', 'brightMagenta'], ['cyan', 'brightCyan'], ['white', 'brightWhite'],
];
for (const [a, b] of BG_PAIRS) {
  const left = `${c(ST.dim)}${padEnd(`c(BG.${a})`, 20)}${padEnd(String(BG[a]), 4)}${RESET}${c(BG[a])}      ${RESET}`;
  const right = `${c(ST.dim)}${padEnd(`c(BG.${b})`, 22)}${padEnd(String(BG[b]), 4)}${RESET}${c(BG[b])}      ${RESET}`;
  out(`  ${left}   ${right}`);
}
out();
out(`  ${c(ST.dim)}読みやすい組み合わせの例:${RESET}`);
out(`    ${c(FG.black, BG.yellow)} WARN ${RESET}  ${c(ST.dim)}c(FG.black, BG.yellow)${RESET}`);
out(`    ${c(FG.brightWhite, BG.red)} CRIT ${RESET}  ${c(ST.dim)}c(FG.brightWhite, BG.red)${RESET}`);

// --- 256色 ------------------------------------------------------------------
// 番号を全て書くと表が埋まるため、行頭に開始番号を出して位置から読み取れるようにする。
head('256色', '文字は c(38, 5, n) / 背景は c(48, 5, n)   n = 0-255');
const swatchRow = (start, count, perRow) => {
  for (let i = 0; i < count; i += perRow) {
    let line = `  ${c(ST.dim)}${String(start + i).padStart(3)}${RESET} `;
    for (let j = 0; j < perRow && i + j < count; j++) {
      line += `${c(48, 5, start + i + j)}  ${RESET}`;
    }
    out(line);
  }
};
out(`  ${c(ST.dim)}0-15: 基本16色(端末テーマの影響を受ける)${RESET}`);
swatchRow(0, 16, 16);
out(`  ${c(ST.dim)}16-231: 6x6x6 カラーキューブ${RESET}`);
swatchRow(16, 216, 36);
out(`  ${c(ST.dim)}232-255: グレースケール${RESET}`);
swatchRow(232, 24, 24);
out();
out(`  ${c(ST.dim)}使いやすい色の例:${RESET}`);
for (const [n, label] of [[71, '落ち着いた緑'], [178, '落ち着いた黄'], [167, '落ち着いた赤'], [110, '落ち着いた青'], [208, 'オレンジ'], [244, '中間グレー']]) {
  out(`    ${c(38, 5, n)}${padEnd(`c(38, 5, ${n})`, 16)}${RESET}${c(ST.dim)}${label}${RESET}`);
}

// --- 24bit ------------------------------------------------------------------
head('24bit フルカラー', '文字は c(38, 2, r, g, b) / 背景は c(48, 2, r, g, b)   各 0-255');
const gradient = (from, to, steps) => {
  let line = '  ';
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const r = Math.round(from[0] + (to[0] - from[0]) * t);
    const g = Math.round(from[1] + (to[1] - from[1]) * t);
    const b = Math.round(from[2] + (to[2] - from[2]) * t);
    line += `${c(48, 2, r, g, b)} ${RESET}`;
  }
  return line;
};
out(gradient([255, 0, 0], [0, 0, 255], 72) + `  ${c(ST.dim)}赤 -> 青${RESET}`);
out(gradient([0, 0, 0], [255, 255, 255], 72) + `  ${c(ST.dim)}黒 -> 白${RESET}`);
out();
out(`  ${c(38, 2, 255, 128, 0)}c(38, 2, 255, 128, 0)${RESET}  ${c(ST.dim)}対応しない端末では無視される${RESET}`);

// --- 現在の配色 --------------------------------------------------------------
// THEME を再定義すると二重管理になるため、statusline.js を実際に走らせて実物を出す。
// PowerShell 経由だと `~` がシェルで展開されないまま渡ってくるので、自前で解決する。
const expandHome = (p) =>
  p === '~' || p.startsWith('~/') || p.startsWith('~\\')
    ? path.join(require('os').homedir(), p.slice(1))
    : p;

const script = process.argv[2]
  ? path.resolve(expandHome(process.argv[2]))
  : path.join(__dirname, 'statusline.js');
const sample = path.join(__dirname, 'sample-input.json');

// どのファイルを見ているかを必ず出す。取り違えたまま色を調整する事故を防ぐため。
head('現在の配色', `対象: ${script}`);
if (fs.existsSync(script) && fs.existsSync(sample)) {
  try {
    const line = execFileSync(process.execPath, [script], { input: fs.readFileSync(sample) }).toString().replace(/\n$/, '');
    out(`  ${line}`);
  } catch (e) {
    out(`  ${c(ST.dim)}(statusline.js の実行に失敗: ${e.message})${RESET}`);
  }
} else {
  // どちらが欠けているかを名指しする。引数でパスを間違えた場合もここに来るため。
  const missing = [script, sample].filter((p) => !fs.existsSync(p));
  out(`  ${c(ST.dim)}(見つかりません: ${missing.join(' / ')})${RESET}`);
}

out();
out(`${c(ST.dim)}色を変えるには対象ファイルの THEME を書き換えてから、このスクリプトを再実行して確認する。${RESET}`);
out();
