'use strict';
// usage.jsonl を集計し、「5時間枠を何回使い切ったら週次(7日)枠に当たるか」を推定する。
//
// 考え方: 5時間枠の到達幅(five_pct の最大−最小)と、その間に週次枠が進んだ幅
// (seven_pct の最後−最初)には比例関係があるはずなので、原点を通る線形回帰で
// 「5h枠を100%まで使い切ったら7dが何%進むか」の傾きを推定する。その逆数が
// 「週次枠に当たるまでの5h枠満タン回数」。
//
// collect.js / statusline.js は動作確認済みなので変更しない。ここは読み取り専用の
// 集計ツールで、外部パッケージには依存しない(Node 標準ライブラリのみ)。

const fs = require('fs');
const path = require('path');
// currentAccount() は「いまログイン中のアカウント」を判別するために collect.js から
// そのまま借りる(collect.js が書き込む acct フィールドと同じ判定基準に揃えるため)。
// collect.js 側は書き込み専用の関数を呼ばない限り副作用を持たないので require して安全。
const { ACCOUNT_UNKNOWN, currentAccount } = require('./collect.js');

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

// five_pct の到達幅がこれ未満の window は、傾き推定に対してノイズが大きすぎるので
// 回帰からは除外する(ただし一覧には出す)。値そのものは要件で指定された既定値。
const MIN_FIVE_RANGE_FOR_REGRESSION = 5;

// --account all の特殊値。定数化しているのは、比較箇所が複数あるため打ち間違いで
// フィルタが無効化される事故を避けるため。
const ACCOUNT_ALL = 'all';

const HOME = process.env.USERPROFILE || process.env.HOME || '.';
const DEFAULT_LOG = path.join(HOME, '.claude', 'usage-tracker', 'usage.jsonl');

// ---------------------------------------------------------------------------
// CLI 引数
// ---------------------------------------------------------------------------

// 時系列グラフの既定の表示範囲。ログは消さずに増え続けるので、描画側で範囲を切らないと
// 横軸が青天井に伸びて波形が潰れる。単位を日数ではなく週次枠の窓にしているのは、7日固定だと
// リセットを跨いだ位置で切れてしまい、一番見たい「いまの週次枠をどれだけ使ったか」が
// 読めなくなるため。窓で切れば 7d% の線は必ずリセット直後から始まる。
// 集計・回帰はこの値に影響されない(常に全期間を使う)。
const CHART_WEEKS_DEFAULT = 1;
// --days を明示したときにだけ使うフォールバック値。
const CHART_DAYS_FALLBACK = 7;

// 'all' / '0' は「制限なし」を意味する null に落とす。
// 不正な値でグラフを空にしないよう、解釈できなければ既定値に戻す。
function parseCount(raw, fallback) {
  if (raw === 'all' || raw === '0') return null;
  const n = Number(raw);
  return isFinite(n) && n > 0 ? n : fallback;
}

// 値を伴う引数で値が欠けたまま進むと、後段のパス操作が undefined で例外になり
// スタックトレースだけが出る。原因の分かるメッセージにしてここで止める。
function takeValue(name, v) {
  if (v == null) {
    console.error(`${name} には値が必要です`);
    process.exit(1);
  }
  return v;
}

function parseArgs(argv) {
  // weeks と days は排他。両方を同時に効かせると範囲の意味が曖昧になるので、
  // 後から指定された方を採用してもう一方を無効化する。
  // account は null のままにしておき、ループ後に「未指定なら現在ログイン中のアカウント」を
  // 埋める。ここで即座に currentAccount() を呼ばないのは、--account 指定の有無をループ内で
  // 判定できるようにするため。
  const opts = { log: DEFAULT_LOG, html: null, json: false, weeks: CHART_WEEKS_DEFAULT, days: null, account: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--log') opts.log = takeValue('--log', argv[++i]);
    else if (a === '--html') opts.html = takeValue('--html', argv[++i]);
    else if (a === '--json') opts.json = true;
    else if (a === '--weeks') { opts.weeks = parseCount(argv[++i], CHART_WEEKS_DEFAULT); opts.days = null; }
    else if (a === '--days') { opts.days = parseCount(argv[++i], CHART_DAYS_FALLBACK); opts.weeks = null; }
    else if (a === '--account') opts.account = takeValue('--account', argv[++i]);
    // 未知の引数は無視する。フラグの追加で古い呼び出しを壊さないため。
  }
  // --html 省略時は「ログと同じ usage-tracker ディレクトリ配下の report.html」。
  // --log を差し替えても、その隣に出す方が使いやすいのでログのディレクトリに合わせる。
  if (!opts.html) opts.html = path.join(path.dirname(opts.log), 'report.html');
  // 既定は「いまログイン中のアカウント」に絞る。2アカウントのデータが1本の時系列に
  // 混ざると window の同一性判定や週次枠の窓分割が壊れる(詳細は buildWindows /
  // weekWindowStarts のコメント参照)ため、明示的に --account all を指定しない限り
  // 常に単一アカウントだけを見る設計にしている。
  // 明示指定の有無を残す。指定がなかった回に限り、acct を書いていなかった頃のログを
  // 今のアカウントのものとして拾う(filterRowsByAccount の includeLegacy)。
  opts.accountExplicit = opts.account != null;
  if (opts.account == null) opts.account = currentAccount();
  return opts;
}

// ---------------------------------------------------------------------------
// 数値・日時ヘルパー
// ---------------------------------------------------------------------------

const isNum = (v) => typeof v === 'number' && isFinite(v);

// five_reset / seven_reset は実測では Unix epoch 秒(数値)だが、将来 ISO8601 文字列
// で来る可能性も考えて両対応にする。どちらも「その瞬間」を表す ms 値に正規化し、
// 数値表現・文字列表現のどちらで来ても同じ window として束ねられるようにする。
function normalizeResetMs(v) {
  if (v == null) return null;
  if (typeof v === 'number' && isFinite(v)) return v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isFinite(t) ? t : null;
  }
  return null;
}

function fmtPct(v, digits = 1) {
  return v == null ? '—' : `${v.toFixed(digits)}%`;
}

function fmtDateTime(ms) {
  if (ms == null || !isFinite(ms)) return '—';
  return new Date(ms).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

// ---------------------------------------------------------------------------
// 読み込み・パース
// ---------------------------------------------------------------------------

function loadRows(logPath) {
  let text;
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch (e) {
    return { rows: [], totalLines: 0, skipped: 0, readError: e.message };
  }

  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const rows = [];
  let skipped = 0;

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    const tsMs = Date.parse(obj.ts);
    if (!isFinite(tsMs)) {
      // ts が読めない行は時系列に置けないので集計に使えない。
      skipped++;
      continue;
    }
    rows.push({
      tsMs,
      // acct が無い行(マイグレーション前の既存ログ)は 'unknown' として扱う。
      // collect.js の ACCOUNT_UNKNOWN と同じ値にして、新旧のデータで判別不能行が
      // 別々の名前で分裂しないようにする。
      acct: typeof obj.acct === 'string' && obj.acct ? obj.acct : ACCOUNT_UNKNOWN,
      // フィールドそのものが無い = アカウント分離を入れる前の記録。値が 'unknown' で
      // あることとは区別する。collect.js は記録時に credentials を読めなかった回にも
      // 'unknown' を書くので(未ログイン、/login 中、権限エラー)、値だけを見て
      // 「移行前だから今のアカウントのもの」と決めると、実際には別アカウントで
      // 動いていた回の記録を混ぜてしまう。filterRowsByAccount がここを見る。
      acctLegacy: !('acct' in obj),
      five_pct: isNum(obj.five_pct) ? obj.five_pct : null,
      five_reset_ms: normalizeResetMs(obj.five_reset),
      seven_pct: isNum(obj.seven_pct) ? obj.seven_pct : null,
      seven_reset_ms: normalizeResetMs(obj.seven_reset),
      model: obj.model || null,
    });
  }

  rows.sort((a, b) => a.tsMs - b.tsMs);
  return { rows, totalLines: lines.length, skipped, readError: null };
}

// ---------------------------------------------------------------------------
// アカウント絞り込み
// ---------------------------------------------------------------------------

// account ごとの行数内訳。--account all 実行時にどれだけ混在しているかの警告や、
// 対象0件になったときに「他のどのアカウントなら行があるか」を示すのに使う。
function accountBreakdown(rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.acct, (counts.get(r.acct) || 0) + 1);
  return counts;
}

// 5時間枠/週次枠はアカウントごとに容量が独立しているため、既定では単一アカウントの
// 行だけを残す。ACCOUNT_ALL のときだけ素通しし、後段(buildWindows のキーや HTML の
// 警告表示)で「混在している」ことを扱えるようにする。
//
// includeLegacy は --account を明示しなかった回だけ真になる。acct フィールドを書いて
// いなかった頃のログは単一アカウント運用時代の記録なので、いまのアカウントのものとして
// 扱う。これが無いと migrate-account.js をまだ実行していない環境では既定の実行が常に
// 0件になり、対象が無いまま HTML を作って既存のレポートを空で上書きしていた。
//
// 見るのは acctLegacy(フィールドの不在)であって acct の値ではない。値が 'unknown' の行は
// 記録時にアカウントを判別できなかっただけで、実際には別アカウントの記録でありうる。
// これを既定の実行で取り込むと、--account の設計そのものが防ごうとしている混在が起きる。
// --account を明示した回は合流させず、指定した acct を持つ行だけを見る(移行前の行は
// acct が 'unknown' に落ちるので、--account unknown と明示したときだけ対象に入る)。
function filterRowsByAccount(rows, account, includeLegacy = false) {
  if (account === ACCOUNT_ALL) return rows;
  // admit 判定(何を対象アカウントの記録とみなすか)はあくまで acctLegacy(フィールドの
  // 不在)で行う。値が 'unknown' なだけの行(記録時に判別できなかった行)は今までどおり
  // 弾く。ここまでは従来どおり変えない。
  //
  // admit された legacy 行は、そのままだと acct が ACCOUNT_UNKNOWN のまま残り、
  // buildWindows / clipToRecentWeekWindows / windowsWithinRows がキーやレンジ集計に
  // r.acct を使っているせいで、対象アカウントの行と別グループに分裂してしまう
  // (5h枠が更新の前後で2つに割れて回帰対象から漏れる、週次枠の直近 N 窓の絞り込みが
  // legacy 分と現行分の2系統になり古い legacy 窓まで表示に残る、等)。移行前のログは
  // 「今のアカウントの記録」として合流させると決めた行なので、グルーピング用に acct を
  // 対象アカウント値へ付け替えたコピーを返す。元の行オブジェクトは書き換えない
  // (accountBreakdown など、フィルタ前の allRows を見る側に影響させないため)。
  return rows.filter((r) => r.acct === account || (includeLegacy && r.acctLegacy))
    .map((r) => (r.acctLegacy && r.acct !== account ? { ...r, acct: account } : r));
}

// ---------------------------------------------------------------------------
// window(5時間枠)への集約
// ---------------------------------------------------------------------------

function buildWindows(rows) {
  // five_reset_ms が同じ行の集まりが1つの window。Map は挿入順を保持するので、
  // rows が ts 昇順である限り、window も自然に時系列順になる。
  const map = new Map();

  for (const r of rows) {
    // five_reset が読めない行は「どの window か」を確定できないので 'unknown' に
    // まとめる。実運用ではまず起きないはずだが、集計を壊さないための保険。
    // キーに acct も含めるのは、--account all で複数アカウントの行が同じ関数を通っても
    // 「同じ時刻に別アカウントの5h枠が始まった」偶然の一致で1つの window に融合しない
    // ようにするため。融合すると crossedWeeklyReset が誤って立ち、正しい window が
    // 「週次リセット跨ぎ」という誤った理由で回帰から除外されてしまう。
    const fiveKey = r.five_reset_ms == null ? 'unknown' : String(r.five_reset_ms);
    const key = `${r.acct}\u0000${fiveKey}`;
    let w = map.get(key);
    if (!w) {
      w = {
        acct: r.acct,
        fiveResetMs: r.five_reset_ms,
        startMs: r.tsMs,
        endMs: r.tsMs,
        rowCount: 0,
        fiveMin: null,
        fiveMax: null,
        sevenFirst: null,
        sevenLast: null,
        sevenResetFirst: r.seven_reset_ms,
        crossedWeeklyReset: false,
        models: new Map(),
      };
      map.set(key, w);
    }

    w.endMs = r.tsMs;
    w.rowCount++;

    if (r.five_pct != null) {
      w.fiveMin = w.fiveMin == null ? r.five_pct : Math.min(w.fiveMin, r.five_pct);
      w.fiveMax = w.fiveMax == null ? r.five_pct : Math.max(w.fiveMax, r.five_pct);
    }
    if (r.seven_pct != null) {
      if (w.sevenFirst == null) w.sevenFirst = r.seven_pct;
      w.sevenLast = r.seven_pct;
    }
    // seven_reset が window の途中で変わった = 週次枠がリセットされた瞬間を跨いだ。
    // このとき seven_pct の増分は「リセット後の低い値 − リセット前の高い値」で
    // 負に振れて回帰を汚すので、あとでフラグとして落とす。
    if (r.seven_reset_ms != null) {
      if (w.sevenResetFirst == null) w.sevenResetFirst = r.seven_reset_ms;
      else if (w.sevenResetFirst !== r.seven_reset_ms) w.crossedWeeklyReset = true;
    }

    const modelKey = r.model || '不明';
    w.models.set(modelKey, (w.models.get(modelKey) || 0) + 1);
  }

  const windows = [];
  for (const w of map.values()) {
    const fiveRange = (w.fiveMin != null && w.fiveMax != null) ? w.fiveMax - w.fiveMin : null;
    const sevenDelta = (w.sevenFirst != null && w.sevenLast != null) ? w.sevenLast - w.sevenFirst : null;

    let mainModel = null, mainModelCount = -1;
    for (const [name, count] of w.models) {
      if (count > mainModelCount || (count === mainModelCount && name < mainModel)) {
        mainModel = name;
        mainModelCount = count;
      }
    }

    // 回帰から除外する理由。null なら回帰に使える window。
    let excludedReason = null;
    if (w.crossedWeeklyReset) excludedReason = 'weekly_reset_crossed';
    else if (fiveRange == null) excludedReason = 'five_pct_unavailable';
    else if (fiveRange < MIN_FIVE_RANGE_FOR_REGRESSION) excludedReason = 'five_range_below_threshold';
    else if (sevenDelta == null) excludedReason = 'seven_pct_unavailable';

    windows.push({
      acct: w.acct,
      fiveResetMs: w.fiveResetMs,
      startMs: w.startMs,
      endMs: w.endMs,
      rowCount: w.rowCount,
      fiveMin: w.fiveMin,
      fiveMax: w.fiveMax,
      fiveRange,
      sevenFirst: w.sevenFirst,
      sevenLast: w.sevenLast,
      sevenDelta,
      crossedWeeklyReset: w.crossedWeeklyReset,
      mainModel,
      models: Object.fromEntries(w.models),
      excludedReason,
    });
  }
  return windows;
}

// ---------------------------------------------------------------------------
// 回帰(原点を通る直線)
// ---------------------------------------------------------------------------

function regress(points) {
  // points: [{x: five到達幅, y: seven増分}]。x, y はどちらも「%」単位。
  const n = points.length;
  if (n < 2) return { n, insufficient: true, reason: 'few_samples' };

  let sxy = 0, sxx = 0, sx = 0, sy = 0;
  for (const p of points) {
    sxy += p.x * p.y;
    sxx += p.x * p.x;
    sx += p.x;
    sy += p.y;
  }

  // 最小二乗(原点通過): slope = Σxy / Σxx
  const slopeLS = sxx > 0 ? sxy / sxx : null;
  // 単純平均: 各 window の「%あたり進み幅」の合計比。外れ値1点に引っ張られにくい
  // 目安として、最小二乗の結果と並べて外れ値の影響を見るために出す。
  const slopeAvg = sx > 0 ? sy / sx : null;

  // 決定係数 R^2。原点通過モデルなので、平均で中心化する通常の R^2 は定義が崩れる
  // (切片ゼロの制約下では残差平方和が Σ(y-ȳ)^2 より大きくなり得て負値になりうる)。
  // ここでは原点基準の非中心 R^2 = 1 - Σ(y-ŷ)^2 / Σy^2 を使う。
  let r2 = null;
  if (slopeLS != null) {
    let sse = 0, sst = 0;
    for (const p of points) {
      const yhat = slopeLS * p.x;
      sse += (p.y - yhat) ** 2;
      sst += p.y * p.y;
    }
    r2 = sst > 0 ? 1 - sse / sst : null;
  }

  // 傾きが正でなければ「満タン何回で上限か」は計算できない(1/slope が無限大か負になる)。
  // 週次枠の分解能は1%しかないため、7d の増分が全 window で0に丸められる期間は実際に
  // 起こりうる。負に振れるのは、取りこぼした週次リセットを跨いだ window が紛れた場合。
  // どちらも「まだ測れていない」だけなので、数字を出さずにその旨を返す。
  if (slopeLS == null || !(slopeLS > 0)) {
    return { n, insufficient: true, reason: 'no_slope', slopeLS, slopeAvg, r2 };
  }

  // 「5h枠を100%まで使い切ったら7dが何%進むか」= slope * 100
  // 「週次リミットに当たるまでの5h枠満タン回数」= 100 / (slope * 100) = 1 / slope
  const fullFillPctLS = slopeLS * 100;
  const fullFillPctAvg = slopeAvg != null ? slopeAvg * 100 : null;
  const windowsToLimitLS = 100 / fullFillPctLS;
  // 単純平均側は最小二乗と独立に符号が変わりうるので、こちらも正のときだけ出す。
  const windowsToLimitAvg = fullFillPctAvg > 0 ? 100 / fullFillPctAvg : null;

  return {
    n, insufficient: false, slopeLS, slopeAvg, r2,
    fullFillPctLS, fullFillPctAvg, windowsToLimitLS, windowsToLimitAvg,
  };
}

// ---------------------------------------------------------------------------
// 集計本体
// ---------------------------------------------------------------------------

// account: 対象アカウント名(ACCOUNT_ALL なら絞り込まない)。省略時は ACCOUNT_ALL を
// 既定値とし、全アカウント混在の生ログをそのまま扱う。undefined のまま filterRowsByAccount
// に渡すと r.acct(loadRows が必ず文字列に正規化する)と一致せず全行が0件に落ちてしまうため、
// 「絞り込まない」を表す既存の定数を既定値にして空振りを防ぐ。単一アカウントに絞りたい
// 呼び出し側(main / CLI)は必ず currentAccount() などで解決した値を明示的に渡すこと。
function analyze(logPath, account = ACCOUNT_ALL, includeLegacy = false) {
  const { rows: allRows, totalLines, skipped, readError } = loadRows(logPath);
  const accountCounts = accountBreakdown(allRows);
  const rows = filterRowsByAccount(allRows, account, includeLegacy);
  const windows = buildWindows(rows);
  const regressionPoints = windows
    .filter((w) => w.excludedReason == null)
    .map((w) => ({ x: w.fiveRange, y: w.sevenDelta }));
  const regression = regress(regressionPoints);

  return {
    logPath,
    account,
    // 「対象アカウントの行が0件」のときに他アカウントの件数を案内するための内訳。
    // Map のままだと JSON.stringify で {} になってしまうので素のオブジェクトに変換する。
    accountCounts: Object.fromEntries(accountCounts),
    allRowsCount: allRows.length,
    readError,
    totalLines,
    skippedLines: skipped,
    parsedRows: rows.length,
    periodStart: rows.length ? rows[0].tsMs : null,
    periodEnd: rows.length ? rows[rows.length - 1].tsMs : null,
    windows,
    effectiveWindowCount: regressionPoints.length,
    regression,
    rowsForChart: rows,
  };
}

// ---------------------------------------------------------------------------
// コンソール出力
// ---------------------------------------------------------------------------

const EXCLUDE_LABEL = {
  weekly_reset_crossed: '週次リセット跨ぎ',
  five_pct_unavailable: '5h%データなし',
  five_range_below_threshold: `到達幅<${MIN_FIVE_RANGE_FOR_REGRESSION}%`,
  seven_pct_unavailable: '7d%データなし',
};

// 推定が出せないときの説明。コンソールと HTML で同じ文言を使う。
// 「なぜ出ないか」と「何を待てばよいか」まで書かないと、壊れているのか
// データ待ちなのかが読み手に区別できない。
function fewSamplesNote(reg) {
  return `データ不足: 回帰に使える window が ${reg.n} 件しかない。あと最低 ${2 - reg.n} 窓分のデータが必要。`;
}

function noSlopeNote(reg) {
  const slope = reg.slopeLS == null ? '—' : reg.slopeLS.toFixed(4);
  // 傾きが0か負かで疑うべき原因が違う。0 は単に測れていないだけだが、
  // 負は週次枠が減ったことを意味するので、データ側の異常を疑う必要がある。
  const cause =
    reg.slopeLS < 0
      ? '7d 増分が負になっている。取りこぼした週次リセットを跨いだ window が混ざっている可能性がある。'
      : '7d% の分解能は1%しかないため増分が0に丸められた可能性が高い。5h枠を大きく使った window が溜まれば出るようになる。';
  return `推定不可: 回帰に使えた ${reg.n} window では 7d 増分に正の傾きが出ていない(傾き ${slope})。${cause}`;
}

// アカウント名の表示用ラベル。'all' は特殊値なので日本語に直す。
function accountLabel(account) {
  return account === ACCOUNT_ALL ? '全アカウント(混在)' : account;
}

// --account all のときに出す警告文。傾き・満タン回数の推定は各アカウントの容量に
// 対する割合(%)を混ぜて計算するため無意味になる、という理由まで明記する
// (何が壊れているかを書かないと「バグって0が出た」のと区別が付かない)。
const MIXED_ACCOUNT_WARNING_LINES = [
  '警告: --account all は複数アカウントのデータを混在させています。',
  '5h枠/週次枠の使用率は各アカウントの容量に対する割合(%)であり、アカウントごとに容量が',
  '異なるため、回帰の傾き・週次リミットまでの満タン回数の推定値は意味を持ちません。',
  '参考値として表示していますが、正確な推定には --account <名前> で単一アカウントに絞ってください。',
];

function printSummary(result) {
  console.log('=== Claude Code 使用量レポート ===');
  console.log(`ログ: ${result.logPath}`);
  if (result.readError) {
    console.log(`ログを読み込めませんでした: ${result.readError}`);
    return;
  }
  console.log(`対象アカウント: ${accountLabel(result.account)}(対象行数 ${result.parsedRows} / 全体行数 ${result.allRowsCount})`);
  if (result.account === ACCOUNT_ALL) {
    console.log('');
    for (const line of MIXED_ACCOUNT_WARNING_LINES) console.log(`!!! ${line}`);
    console.log('');
  }
  if (result.parsedRows === 0) {
    // フィルタの結果0行になった場合、異常終了させずに「他のどのアカウントなら
    // 行があるか」の内訳を出す。指定ミス(綴り間違いなど)にその場で気付けるように。
    console.log('対象アカウントの行が usage.jsonl に見つかりませんでした。');
    if (result.allRowsCount > 0) {
      console.log('内訳(全アカウント):');
      for (const [acct, count] of Object.entries(result.accountCounts)) {
        console.log(`  ${acct}: ${count} 行`);
      }
    } else {
      console.log('usage.jsonl 自体に行がありません。');
    }
    return;
  }
  console.log(`期間: ${fmtDateTime(result.periodStart)} 〜 ${fmtDateTime(result.periodEnd)}`);
  console.log(`総行数: ${result.totalLines}(パース不能行: ${result.skippedLines})`);
  console.log(`5h枠 window 数: ${result.windows.length}(回帰に使えた window: ${result.effectiveWindowCount})`);
  console.log('');

  console.log('--- window 一覧 ---');
  console.log('開始時刻              5h到達%   7d増分%   主モデル        備考');
  for (const w of result.windows) {
    const note = w.excludedReason ? `除外: ${EXCLUDE_LABEL[w.excludedReason] || w.excludedReason}` : '';
    console.log(
      `${fmtDateTime(w.startMs).padEnd(20)}  ${fmtPct(w.fiveRange).padStart(7)}  ${fmtPct(w.sevenDelta).padStart(7)}  ${(w.mainModel || '—').padEnd(14)}  ${note}`
    );
  }
  console.log('');

  const reg = result.regression;
  if (reg.insufficient) {
    console.log(`--- 推定 ---`);
    console.log(reg.reason === 'no_slope' ? noSlopeNote(reg) : fewSamplesNote(reg));
    return;
  }

  console.log('--- 推定(5h枠を100%使い切ったときの7d進み幅、および週次リミットまでの満タン回数) ---');
  console.log(`サンプル数: ${reg.n} window`);
  console.log(`最小二乗(原点通過): 5h100%あたり 7d ${reg.fullFillPctLS.toFixed(3)}% 進む → 満タン ${reg.windowsToLimitLS.toFixed(2)} 回で週次リミット`);
  console.log(
    reg.windowsToLimitAvg != null
      ? `単純平均:           5h100%あたり 7d ${reg.fullFillPctAvg.toFixed(3)}% 進む → 満タン ${reg.windowsToLimitAvg.toFixed(2)} 回で週次リミット`
      : `単純平均:           傾きが正にならないため算出せず`
  );
  console.log(`決定係数 R^2(原点基準): ${reg.r2 != null ? reg.r2.toFixed(4) : '—'}`);
}

// ---------------------------------------------------------------------------
// HTML レポート生成(自己完結・外部参照なし・SVG は自前生成)
// ---------------------------------------------------------------------------

// XSS 対策というより「model 名などに `<` `&` が混じっても壊れない」ための最低限の
// エスケープ。HTML はここで node 側が一括生成するので innerHTML 相当の埋め込みに
// なるが、動的な DOM 挿入(ツールチップ描画)側は textContent を使う(下記 JS)。
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---- 時系列チャート(5h% と 7d% を同じ 0-100 軸に重ねる。二軸化はしない) ----
// 時系列グラフの表示範囲を直近 days 日に絞る。基準を「いま」ではなく最後の観測点に取るのは、
// 何日か前のログを後から解析したときに全点が範囲外へ落ちてグラフが空になるのを避けるため。
function clipToRecentDays(rows, days) {
  if (!days || rows.length === 0) return rows;
  const cutoff = rows[rows.length - 1].tsMs - days * 24 * 60 * 60 * 1000;
  return rows.filter((r) => r.tsMs >= cutoff);
}

// 週次枠の各窓が始まる行のインデックス。seven_reset_ms が変わった点が窓の境界そのもの
// (リセット時刻が別の値になった = 枠が入れ替わった)なので、日付計算をせずに区切れる。
// resets_at が欠けた行(セッション開始直後などに起こりうる)は境界の判定に使わない。
// 欠けを境界とみなすと、実際にはリセットしていない場所で窓が increments されてしまう。
//
// prev はアカウントごとに別々に持つ(buildWindows が acct を含む複合キーで window を
// 区切っているのと同じ理由)。--account all では2アカウントの行が ts 順に交互に並ぶため、
// 単一の prev で追うと「別アカウントの seven_reset に切り替わった」だけで境界と誤判定し、
// ほぼ全行が窓の開始点になってしまう。
function weekWindowStarts(rows) {
  const starts = [];
  const prevByAcct = new Map();
  for (let i = 0; i < rows.length; i++) {
    const reset = rows[i].seven_reset_ms;
    if (reset == null) continue;
    const acct = rows[i].acct;
    const prev = prevByAcct.has(acct) ? prevByAcct.get(acct) : null;
    if (prev === null || reset !== prev) {
      starts.push(i);
      prevByAcct.set(acct, reset);
    }
  }
  return starts;
}

// 週次枠の窓単位で直近 weeks 個ぶんに絞る。
//
// 窓の境界はアカウントごとに刻まれる(weekWindowStarts のコメント参照)ため、--account all
// では starts に両アカウントの境界が混ざる。総数をそのまま週数と数えていた頃は、2アカウント
// 分の記録があるだけで要求した窓数の半分ほどしかカバーしない範囲に切り詰められていた。
// グラフの注記は要求値のまま出るので、狭まったことに気付けない。
// アカウントごとに「直近 weeks 個目の窓の開始位置」を求め、その中で最も古い位置から残す。
function clipToRecentWeekWindows(rows, weeks) {
  if (!weeks || rows.length === 0) return rows;
  const startsByAcct = new Map();
  for (const i of weekWindowStarts(rows)) {
    const acct = rows[i].acct;
    if (!startsByAcct.has(acct)) startsByAcct.set(acct, []);
    startsByAcct.get(acct).push(i);
  }
  // 切り出し位置はアカウントごとに持つ。全体を1点で切ると、窓の少ないアカウントに
  // 引きずられて他方まで切れなくなる(既定の --weeks 1 では、2アカウント目に週次窓が
  // 1つあるだけで絞り込みが丸ごと効かなくなっていた)。
  const cutByAcct = new Map();
  for (const [acct, starts] of startsByAcct) {
    // 手持ちの窓が要求数以下のアカウントは全部残す。先頭の窓は途中から記録が
    // 始まっていることが多いが、それを捨てると初回利用時にグラフが空になる。
    cutByAcct.set(acct, starts.length <= weeks ? -1 : starts[starts.length - weeks]);
  }
  // 窓の境界が1つも無いアカウント(seven_reset がまだ記録されていない)は絞り込めないので残す。
  return rows.filter((r, i) => {
    const cut = cutByAcct.get(r.acct);
    return cut === undefined || i >= cut;
  });
}

// 表示中の行が実際にカバーしている 5h枠の window だけを選ぶ。
//
// 単純に「表示行の最小時刻〜最大時刻」で絞れないのは、clipToRecentWeekWindows が
// アカウントごとに切り出すため、絞った結果が単一の連続した時間帯にならないから。
// --account all では「A は直近1窓ぶんだけ、B は全期間」のような状態になり、全体の
// レンジで数えると A の落としたはずの古い window まで入って過大になる(注記の
// window 数が水増しされ、グラフには表示していないデータの境界線が引かれる)。
// アカウントごとのレンジで判定すれば、どちらの用途でも表示と数字が一致する。
function windowsWithinRows(windows, rows) {
  const rangeByAcct = new Map();
  for (const r of rows) {
    const cur = rangeByAcct.get(r.acct);
    if (!cur) rangeByAcct.set(r.acct, { min: r.tsMs, max: r.tsMs });
    else {
      if (r.tsMs < cur.min) cur.min = r.tsMs;
      if (r.tsMs > cur.max) cur.max = r.tsMs;
    }
  }
  return windows.filter((w) => {
    const range = rangeByAcct.get(w.acct);
    return range && w.startMs >= range.min && w.startMs <= range.max;
  });
}

// 表示範囲の決定。--days を明示したときだけ日数で切り、既定は週次枠の窓単位。
function clipForChart(rows, opts) {
  if (opts.days) return clipToRecentDays(rows, opts.days);
  return clipToRecentWeekWindows(rows, opts.weeks);
}

function buildTimeSeriesSvg(rows, windows) {
  const W = 960, H = 320;
  const M = { top: 20, right: 20, bottom: 32, left: 40 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  if (rows.length === 0) {
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="使用率の時系列データがありません"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="empty-note">データがありません</text></svg>`;
  }

  const tMin = rows[0].tsMs, tMax = rows[rows.length - 1].tsMs;
  // 点が1つ(または全点が同じ時刻)しかないと時間軸のレンジが0になるので、
  // 目盛りが潰れないよう横1本分だけ幅を持たせる。
  const tSpan = Math.max(tMax - tMin, 60 * 1000);
  const x = (t) => M.left + ((t - tMin) / tSpan) * plotW;
  const y = (v) => M.top + (1 - v / 100) * plotH;

  // window 境界(先頭を除く)に薄い縦線を引く。5h枠の切り替わりが一目で分かるように。
  // 表示範囲の外にある境界は捨てる。SVG は overflow: visible なので、残すとプロット領域を
  // はみ出した位置に縦線が描かれてしまう。範囲判定は windowsWithinRows に任せる
  // (アカウントごとに切り出された表示範囲を、全体のレンジで見ないため)。
  const boundaries = windowsWithinRows(windows.slice(1), rows).map((w) => x(w.startMs));

  // 5h%/7d% はそれぞれ null で途切れることがあるので、連続する区間ごとに path を切る。
  function buildSegments(key) {
    const segs = [];
    let cur = [];
    for (const r of rows) {
      const v = r[key];
      if (v == null) {
        if (cur.length) segs.push(cur);
        cur = [];
        continue;
      }
      cur.push({ t: r.tsMs, v });
    }
    if (cur.length) segs.push(cur);
    return segs;
  }

  function pathsFor(key) {
    return buildSegments(key).map((seg) =>
      seg.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
    );
  }

  const fivePaths = pathsFor('five_pct');
  const sevenPaths = pathsFor('seven_pct');

  // 個々の実測点。データが疎な現状(1〜数点)でも見えるように小さめの丸を打つ。
  // 密になると半径3.5の丸が隣と重なって帯にしか見えなくなるので、間隔が6pxを切る量に
  // なったら等間隔で間引く。折れ線は全点で描いたままなので波形自体は失われない。
  const maxDots = Math.max(1, Math.floor(plotW / 6));
  function dotsFor(key, cls) {
    const pts = rows.filter((r) => r[key] != null);
    const step = Math.max(1, Math.ceil(pts.length / maxDots));
    return pts
      // 最新の点だけは間引きの位相に関係なく残す。現在値の位置は常に見えていてほしい。
      .filter((_, i) => i % step === 0 || i === pts.length - 1)
      .map((r) => `<circle class="${cls} dot" cx="${x(r.tsMs).toFixed(1)}" cy="${y(r[key]).toFixed(1)}" r="3.5" data-t="${r.tsMs}" data-v="${r[key]}"></circle>`)
      .join('');
  }

  // y軸目盛り(0/25/50/75/100)
  const yTicks = [0, 25, 50, 75, 100].map((v) => `
    <line x1="${M.left}" x2="${W - M.right}" y1="${y(v)}" y2="${y(v)}" class="grid"></line>
    <text x="${M.left - 8}" y="${y(v)}" class="axis-label" text-anchor="end" dominant-baseline="middle">${v}</text>
  `).join('');

  const boundaryLines = boundaries.map((bx) => `<line x1="${bx.toFixed(1)}" x2="${bx.toFixed(1)}" y1="${M.top}" y2="${H - M.bottom}" class="window-boundary"></line>`).join('');

  // 横軸のラベルは開始・終了のみ(密な時系列に全点ラベルを打つと読めなくなるため)。
  const xLabels = `
    <text x="${M.left}" y="${H - 8}" class="axis-label" text-anchor="start">${esc(fmtDateTime(tMin))}</text>
    <text x="${W - M.right}" y="${H - 8}" class="axis-label" text-anchor="end">${esc(fmtDateTime(tMax))}</text>
  `;

  return `
<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="5h枠・7d枠使用率の時系列" data-plot-left="${M.left}" data-plot-right="${W - M.right}" data-plot-top="${M.top}" data-plot-bottom="${H - M.bottom}" data-t-min="${tMin}" data-t-span="${tSpan}">
  <g>${yTicks}</g>
  <line x1="${M.left}" x2="${W - M.right}" y1="${H - M.bottom}" y2="${H - M.bottom}" class="axis-line"></line>
  ${boundaryLines}
  ${fivePaths.map((d) => `<path d="${d}" class="line line-five"></path>`).join('')}
  ${sevenPaths.map((d) => `<path d="${d}" class="line line-seven"></path>`).join('')}
  ${dotsFor('five_pct', 'series-five')}
  ${dotsFor('seven_pct', 'series-seven')}
  ${xLabels}
  <g class="crosshair-layer">
    <line class="crosshair-line" x1="0" x2="0" y1="${M.top}" y2="${H - M.bottom}" style="display:none"></line>
  </g>
  <rect class="hover-capture" x="${M.left}" y="${M.top}" width="${plotW}" height="${plotH}" fill="transparent"></rect>
</svg>
<div class="tooltip" data-tooltip-for="timeseries" hidden></div>
`;
}

// ---- 散布図(x=5h到達幅 / y=7d増分) + 原点通過の回帰直線 ----
function buildScatterSvg(windows, regression) {
  const W = 480, H = 420;
  const M = { top: 20, right: 20, bottom: 36, left: 44 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  const points = windows.filter((w) => w.fiveRange != null && w.sevenDelta != null);
  if (points.length === 0) {
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="散布図データがありません"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="empty-note">データがありません</text></svg>`;
  }

  const xMax = Math.max(100, ...points.map((p) => p.fiveRange));
  const yMax = Math.max(10, ...points.map((p) => Math.abs(p.sevenDelta)));
  const yMin = Math.min(0, ...points.map((p) => p.sevenDelta));

  const sx = (v) => M.left + (v / xMax) * plotW;
  const sy = (v) => M.top + (1 - (v - yMin) / (yMax - yMin)) * plotH;

  const xTicks = [0, 25, 50, 75, 100].filter((v) => v <= xMax + 1e-9).map((v) => `
    <line x1="${sx(v)}" x2="${sx(v)}" y1="${M.top}" y2="${H - M.bottom}" class="grid"></line>
    <text x="${sx(v)}" y="${H - M.bottom + 16}" class="axis-label" text-anchor="middle">${v}</text>
  `).join('');

  const dots = points.map((p) => {
    const excluded = p.excludedReason != null;
    const cls = excluded ? 'scatter-dot excluded' : 'scatter-dot';
    return `<circle class="${cls}" cx="${sx(p.fiveRange).toFixed(1)}" cy="${sy(p.sevenDelta).toFixed(1)}" r="6"
      data-five="${p.fiveRange.toFixed(2)}" data-seven="${p.sevenDelta.toFixed(2)}"
      data-note="${excluded ? esc(EXCLUDE_LABEL[p.excludedReason] || p.excludedReason) : ''}"></circle>`;
  }).join('');

  let regressionLine = '';
  if (!regression.insufficient && regression.slopeLS != null) {
    const x1 = 0, y1 = 0;
    const x2 = xMax, y2 = regression.slopeLS * xMax;
    regressionLine = `<line x1="${sx(x1)}" y1="${sy(y1)}" x2="${sx(x2)}" y2="${sy(y2)}" class="regression-line"></line>`;
  }

  return `
<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="5h到達幅と7d増分の散布図と回帰直線">
  <g>${xTicks}</g>
  <line x1="${M.left}" x2="${M.left}" y1="${M.top}" y2="${H - M.bottom}" class="axis-line"></line>
  <line x1="${M.left}" x2="${W - M.right}" y1="${sy(0)}" y2="${sy(0)}" class="axis-line"></line>
  ${regressionLine}
  ${dots}
  <text x="${M.left + plotW / 2}" y="${H - 6}" class="axis-title" text-anchor="middle">5h枠 到達幅(%)</text>
  <text x="14" y="${M.top + plotH / 2}" class="axis-title" text-anchor="middle" transform="rotate(-90 14 ${M.top + plotH / 2})">7d枠 増分(%)</text>
</svg>
<div class="tooltip" data-tooltip-for="scatter" hidden></div>
`;
}

function buildWindowTableRows(windows) {
  return windows.map((w) => {
    const note = w.excludedReason ? `<span class="badge">除外: ${esc(EXCLUDE_LABEL[w.excludedReason] || w.excludedReason)}</span>` : '';
    return `<tr>
      <td>${esc(fmtDateTime(w.startMs))}</td>
      <td class="num">${esc(fmtPct(w.fiveRange))}</td>
      <td class="num">${esc(fmtPct(w.sevenDelta))}</td>
      <td>${esc(w.mainModel || '—')}</td>
      <td class="num">${w.rowCount}</td>
      <td>${note}</td>
    </tr>`;
  }).join('\n');
}

function buildHtml(result, opts = {}) {
  const reg = result.regression;

  // --account all の混在警告。コンソール版(MIXED_ACCOUNT_WARNING_LINES)と同じ文言を使い、
  // 出力先が違っても同じ注意書きが読めるようにする。
  const accountWarningHtml = result.account === ACCOUNT_ALL ? `
    <section class="account-warning">
      <h2>警告: 複数アカウントのデータが混在しています</h2>
      ${MIXED_ACCOUNT_WARNING_LINES.map((line) => `<p>${esc(line)}</p>`).join('\n')}
    </section>
  ` : '';

  const heroValue = !reg.insufficient
    ? `${reg.windowsToLimitLS.toFixed(1)} 回`
    : reg.reason === 'no_slope' ? '推定不可' : 'データ不足';
  const heroSub = !reg.insufficient
    ? `5h枠を満タンにした回数がこれに達すると週次リミットに当たる見込み(最小二乗推定)`
    : reg.reason === 'no_slope' ? noSlopeNote(reg) : fewSamplesNote(reg);

  const secondaryStats = reg.insufficient ? '' : `
    <div class="stat-row">
      <div class="stat-tile">
        <div class="stat-label">5h100%あたりの7d進み幅(最小二乗)</div>
        <div class="stat-value">${reg.fullFillPctLS.toFixed(2)}%</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">単純平均による満タン回数</div>
        <div class="stat-value">${reg.windowsToLimitAvg != null ? `${reg.windowsToLimitAvg.toFixed(1)} 回` : '—'}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">決定係数 R²(原点基準)</div>
        <div class="stat-value">${reg.r2 != null ? reg.r2.toFixed(3) : '—'}</div>
      </div>
      <div class="stat-tile">
        <div class="stat-label">回帰に使った window 数</div>
        <div class="stat-value">${reg.n}</div>
      </div>
    </div>
  `;

  // 表示範囲を絞るのは時系列グラフだけ。サマリ・回帰・window 一覧は常に全期間を使う。
  // グラフの見た目を変えたつもりが推定値まで変わっていた、という事故を避けるための線引き。
  const chartRows = clipForChart(result.rowsForChart, opts);
  const shownWindows = windowsWithinRows(result.windows, chartRows).length;
  const totalWeeks = weekWindowStarts(result.rowsForChart).length;
  const shownWeeks = weekWindowStarts(chartRows).length;
  // --account all では窓数(totalWeeks / shownWeeks)が両アカウントの合計になる一方、
  // 絞り込みはアカウントごとに直近 N 窓を確保する。指定値と数字が食い違って見えるので、
  // 何に対する N なのかを文言で示す。
  const scope = opts.days
    ? `直近 ${opts.days} 日`
    : opts.account === ACCOUNT_ALL
      ? `週次枠の直近 ${opts.weeks} 窓(アカウントごと)`
      : `週次枠の直近 ${opts.weeks} 窓`;
  // 何を省いたかは必ず書く。黙って切ると「これが全データ」と読まれてしまう。
  const chartNote =
    chartRows.length < result.rowsForChart.length
      ? `${scope}を表示(週次枠 ${totalWeeks} 窓中 ${shownWeeks} 窓 / 全 ${result.rowsForChart.length} 点中 ${chartRows.length} 点 / 5h枠 ${shownWindows} window)。--weeks N で過去N窓、--days N で日数指定、--weeks all で全期間。`
      : `全期間を表示(週次枠 ${totalWeeks} 窓 / ${chartRows.length} 点 / 5h枠 ${result.windows.length} window)。--weeks N・--days N で範囲を絞れます。`;
  const timeseriesSvg = buildTimeSeriesSvg(chartRows, result.windows);
  const scatterSvg = buildScatterSvg(result.windows, reg);
  const tableRows = buildWindowTableRows(result.windows);

  // クライアント側でツールチップを描くための最小データ。model 名などは統計情報
  // から来た文字列(基本は Claude Code 自身が出すものだが)を疑わずに innerHTML で
  // 埋め込むのは避け、必ず textContent 経由で挿入する(下記スクリプト参照)。
  const chartData = {
    // hover は SVG の x 変換(表示範囲基準)と対応させる必要があるため、描画に使ったのと
    // 同じ範囲の行だけ渡す。全点渡すと範囲外の点が最近傍に選ばれて値がずれる。
    rows: chartRows.map((r) => ({ t: r.tsMs, five: r.five_pct, seven: r.seven_pct })),
  };

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>Claude Code 使用量レポート</title>
<style>
  /* 変数は :root にも置く。body は .viz-root の祖先なので .viz-root だけに定義すると
     body の color/background から var() が解決できず、文字色が初期値の黒に落ちる
     (= 濃いグレーの surface 上に黒文字という読めない組み合わせになる)。
     .viz-root 側の定義はブロック単位で他所に移植したときのために残す。 */
  :root, .viz-root {
    color-scheme: light;
    --surface:   #fcfcfb;
    --page:      #f9f9f7;
    --ink:       #0b0b0b;
    --ink-2:     #52514e;
    --ink-muted: #898781;
    --grid:      #e1e0d9;
    --axis:      #c3c2b7;
    --border:    rgba(11,11,11,0.10);
    --series-five:  #2a78d6; /* categorical slot1: blue */
    --series-seven: #eb6834; /* categorical slot2: orange */
    --regression:   #52514e; /* データではなく推定モデルなので secondary ink */
    --warn-bg:      #fdf1e6; /* --account all の混在警告バナー用。他の section と混同しないよう暖色にする */
    --warn-border:  #e0a33d;
    --warn-ink:     #7a4a06;
  }
  @media (prefers-color-scheme: dark) {
    :root, .viz-root {
      color-scheme: dark;
      --surface:   #1a1a19;
      --page:      #0d0d0d;
      --ink:       #ffffff;
      --ink-2:     #c3c2b7;
      --ink-muted: #898781;
      --grid:      #2c2c2a;
      --axis:      #383835;
      --border:    rgba(255,255,255,0.10);
      --series-five:  #3987e5;
      --series-seven: #d95926;
      --regression:   #c3c2b7;
      --warn-bg:      #2e2410;
      --warn-border:  #a5761f;
      --warn-ink:     #f2c877;
    }
  }

  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; background: var(--page); color: var(--ink);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .viz-root { padding: 24px; max-width: 1040px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: var(--ink-2); font-size: 13px; margin: 0 0 20px; }
  section { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
  section h2 { font-size: 14px; color: var(--ink-2); margin: 0 0 14px; font-weight: 600; }

  /* --account all の混在警告。他の section と見た目で区別できるよう
     暖色にして目立たせる(数値だけ見て気付かず誤読するのを防ぐため)。 */
  section.account-warning { background: var(--warn-bg); border-color: var(--warn-border); color: var(--warn-ink); }
  section.account-warning h2 { color: var(--warn-ink); }
  section.account-warning p, section.account-warning li { margin: 0 0 6px; font-size: 13px; }
  section.account-warning ul { margin: 8px 0 0; padding-left: 20px; }

  .hero { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
  .hero-value { font-size: 48px; font-weight: 600; line-height: 1; }
  .hero-sub { color: var(--ink-2); font-size: 13px; max-width: 480px; }

  .stat-row { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
  .stat-tile { flex: 1 1 160px; padding: 12px; border: 1px solid var(--border); border-radius: 8px; }
  .stat-label { font-size: 12px; color: var(--ink-2); margin-bottom: 4px; }
  .stat-value { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }

  .chart-grid { display: grid; grid-template-columns: 1.6fr 1fr; gap: 20px; align-items: start; }
  @media (max-width: 800px) { .chart-grid { grid-template-columns: 1fr; } }
  .chart { width: 100%; height: auto; overflow: visible; }
  .empty-note { fill: var(--ink-muted); font-size: 13px; }

  .grid { stroke: var(--grid); stroke-width: 1; }
  .axis-line { stroke: var(--axis); stroke-width: 1; }
  .axis-label { fill: var(--ink-muted); font-size: 10px; }
  .axis-title { fill: var(--ink-2); font-size: 11px; }
  .window-boundary { stroke: var(--border); stroke-width: 1; }
  .line { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .line-five { stroke: var(--series-five); }
  .line-seven { stroke: var(--series-seven); }
  .dot { stroke: var(--surface); stroke-width: 1.5; }
  .series-five.dot { fill: var(--series-five); }
  .series-seven.dot { fill: var(--series-seven); }
  .scatter-dot { fill: var(--series-five); stroke: var(--surface); stroke-width: 2; cursor: pointer; }
  .scatter-dot.excluded { fill: none; stroke: var(--ink-muted); stroke-width: 1.5; opacity: 0.7; }
  .regression-line { stroke: var(--regression); stroke-width: 2; stroke-dasharray: 5 4; }
  .hover-capture { cursor: crosshair; }
  .crosshair-line { stroke: var(--ink-muted); stroke-width: 1; pointer-events: none; }

  .legend { display: flex; gap: 16px; font-size: 12px; color: var(--ink-2); margin-bottom: 8px; flex-wrap: wrap; }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .legend-swatch { width: 16px; height: 2px; display: inline-block; }
  .legend-swatch.five { background: var(--series-five); }
  .legend-swatch.seven { background: var(--series-seven); }
  .legend-swatch.regression { background: none; border-top: 2px dashed var(--regression); width: 16px; height: 0; }

  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 6px 10px; border-bottom: 1px solid var(--border); text-align: left; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  th { color: var(--ink-2); font-weight: 600; font-size: 12px; }
  .badge { font-size: 11px; color: var(--ink-muted); }
  .chart-note { font-size: 11px; color: var(--ink-muted); margin: 0 0 8px; }
  .table-wrap { overflow-x: auto; }

  .tooltip {
    position: fixed; pointer-events: none; z-index: 10;
    background: var(--surface); border: 1px solid var(--border); border-radius: 6px;
    padding: 8px 10px; font-size: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    max-width: 220px;
  }
  .tooltip[hidden] { display: none; }
  .tooltip .tt-value { font-weight: 600; font-variant-numeric: tabular-nums; }
  .tooltip .tt-label { color: var(--ink-2); }
</style>
</head>
<body>
<div class="viz-root">
  <h1>Claude Code 使用量レポート — ${esc(accountLabel(result.account))}</h1>
  <p class="meta">ログ: ${esc(result.logPath)} / 対象アカウント: ${esc(accountLabel(result.account))}(対象 ${result.parsedRows} 行 / 全体 ${result.allRowsCount} 行) / 期間: ${esc(fmtDateTime(result.periodStart))} 〜 ${esc(fmtDateTime(result.periodEnd))} / 総行数 ${result.totalLines}(パース不能 ${result.skippedLines}) / window数 ${result.windows.length}</p>
  ${accountWarningHtml}

  <section>
    <h2>週次リミットまでの5h枠満タン回数</h2>
    <div class="hero">
      <div class="hero-value">${esc(heroValue)}</div>
      <div class="hero-sub">${esc(heroSub)}</div>
    </div>
    ${secondaryStats}
  </section>

  <section>
    <h2>時系列(5h枠% / 7d枠%)</h2>
    <div class="legend">
      <span class="legend-item"><span class="legend-swatch five"></span>5h枠 使用率</span>
      <span class="legend-item"><span class="legend-swatch seven"></span>7d枠 使用率</span>
    </div>
    <p class="chart-note">${esc(chartNote)}</p>
    ${timeseriesSvg}
  </section>

  <div class="chart-grid">
    <section>
      <h2>window 一覧</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>開始時刻</th><th class="num">5h到達%</th><th class="num">7d増分%</th><th>主モデル</th><th class="num">行数</th><th>備考</th></tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </section>
    <section>
      <h2>散布図: 5h到達幅 × 7d増分</h2>
      <div class="legend">
        <span class="legend-item"><span class="legend-swatch five" style="width:8px;height:8px;border-radius:50%;"></span>window(実測)</span>
        <span class="legend-item"><span class="legend-swatch regression"></span>回帰直線(原点通過)</span>
      </div>
      ${scatterSvg}
    </section>
  </div>
</div>
<script id="chart-data" type="application/json">${JSON.stringify(chartData)}</script>
<script>
(function () {
  'use strict';
  // model 名など外部起源の文字列をツールチップに出すときは textContent を使い、
  // innerHTML 経由での注入を避ける(dataviz skill の指針どおり)。
  function setText(el, text) {
    el.textContent = '';
    el.appendChild(document.createTextNode(text));
  }

  function fmtDate(ms) {
    return new Date(ms).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  // --- 時系列チャートのクロスヘア + ツールチップ ---
  var tsSvg = document.querySelector('svg[aria-label*="時系列"]');
  if (tsSvg) {
    var raw = document.getElementById('chart-data');
    var rows = raw ? (JSON.parse(raw.textContent).rows || []) : [];
    var capture = tsSvg.querySelector('.hover-capture');
    var crosshair = tsSvg.querySelector('.crosshair-line');
    var tooltip = document.querySelector('.tooltip[data-tooltip-for="timeseries"]');
    var left = parseFloat(tsSvg.dataset.plotLeft);
    var right = parseFloat(tsSvg.dataset.plotRight);
    var tMin = parseFloat(tsSvg.dataset.tMin);
    var tSpan = parseFloat(tsSvg.dataset.tSpan);

    function nearestRow(t) {
      var best = null, bestDiff = Infinity;
      for (var i = 0; i < rows.length; i++) {
        var diff = Math.abs(rows[i].t - t);
        if (diff < bestDiff) { bestDiff = diff; best = rows[i]; }
      }
      return best;
    }

    if (capture && rows.length) {
      capture.addEventListener('pointermove', function (ev) {
        var rect = tsSvg.getBoundingClientRect();
        // viewBox 座標系に変換(SVG が CSS でスケールされていても崩れないように)
        var px = (ev.clientX - rect.left) / rect.width * tsSvg.viewBox.baseVal.width;
        var t = tMin + ((px - left) / (right - left)) * tSpan;
        var row = nearestRow(t);
        if (!row) return;

        crosshair.setAttribute('x1', px);
        crosshair.setAttribute('x2', px);
        crosshair.style.display = '';

        tooltip.innerHTML = '';
        var title = document.createElement('div');
        setText(title, fmtDate(row.t));
        tooltip.appendChild(title);
        if (row.five != null) {
          var l1 = document.createElement('div');
          setText(l1, '5h枠: ' + row.five.toFixed(1) + '%');
          tooltip.appendChild(l1);
        }
        if (row.seven != null) {
          var l2 = document.createElement('div');
          setText(l2, '7d枠: ' + row.seven.toFixed(1) + '%');
          tooltip.appendChild(l2);
        }
        tooltip.hidden = false;
        tooltip.style.left = (ev.clientX + 12) + 'px';
        tooltip.style.top = (ev.clientY + 12) + 'px';
      });
      capture.addEventListener('pointerleave', function () {
        crosshair.style.display = 'none';
        tooltip.hidden = true;
      });
    }
  }

  // --- 散布図の各点のツールチップ ---
  var scatterTooltip = document.querySelector('.tooltip[data-tooltip-for="scatter"]');
  document.querySelectorAll('.scatter-dot').forEach(function (dot) {
    dot.addEventListener('pointerenter', function (ev) {
      if (!scatterTooltip) return;
      scatterTooltip.innerHTML = '';
      var l1 = document.createElement('div');
      setText(l1, '5h到達幅: ' + dot.dataset.five + '%');
      var l2 = document.createElement('div');
      setText(l2, '7d増分: ' + dot.dataset.seven + '%');
      scatterTooltip.appendChild(l1);
      scatterTooltip.appendChild(l2);
      if (dot.dataset.note) {
        var l3 = document.createElement('div');
        setText(l3, dot.dataset.note);
        scatterTooltip.appendChild(l3);
      }
      scatterTooltip.hidden = false;
    });
    dot.addEventListener('pointermove', function (ev) {
      if (!scatterTooltip) return;
      scatterTooltip.style.left = (ev.clientX + 12) + 'px';
      scatterTooltip.style.top = (ev.clientY + 12) + 'px';
    });
    dot.addEventListener('pointerleave', function () {
      if (scatterTooltip) scatterTooltip.hidden = true;
    });
  });
})();
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = analyze(opts.log, opts.account, !opts.accountExplicit);

  // 対象行が0件のときは HTML を書かない。空のレポートで上書きすると、直前まで見えていた
  // 実績まで消える。--account の綴り間違いや、ログを読めなかったときにも起こる。
  // 書き換えずに理由だけ出せば、元のレポートは残るしやり直しも効く。
  const wroteHtml = !(result.readError || result.parsedRows === 0);
  if (wroteHtml) {
    fs.mkdirSync(path.dirname(opts.html), { recursive: true });
    fs.writeFileSync(opts.html, buildHtml(result, opts));
  }

  if (opts.json) {
    // rowsForChart は HTML 用の内部データなので JSON 出力からは外す。
    const { rowsForChart, ...jsonResult } = result;
    console.log(JSON.stringify({ ...jsonResult, htmlPath: wroteHtml ? opts.html : null }, null, 2));
  } else {
    printSummary(result);
    console.log('');
    console.log(wroteHtml ? `HTML レポート: ${opts.html}` : `対象行が無いため ${opts.html} は更新していません。`);
  }
}

// 直接実行されたときだけ走らせる。require で読み込んだだけで report.html を
// 書き換えてしまうと、集計関数を再利用する側が本番のレポートを壊す。
if (require.main === module) main();

module.exports = { analyze, regress, buildWindows, loadRows, buildHtml };
