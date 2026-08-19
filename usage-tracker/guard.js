'use strict';
// プラン利用枠(5時間枠 / 週次枠)が閾値を超えたら、作業を畳んで引き継ぎを残すよう
// Claude に促す。
//
// 枠を使い切ると会話は途中で強制的に打ち切られ、何をしていたかの記録が残らない。
// 実測では 5h枠は 90% から 99% まで約20分、持続的な最速消費でも 1.2pt/分だったので、
// 90% で気付ければ引き継ぎを書く余裕は十分にある。
//
// 設計上の要点は「ブロックしないこと」。PreToolUse で止めると引き継ぎを書くための
// worklog 実行まで巻き添えになり、それを避けるための例外処理が必要になる。
// PostToolUse ならツールは実行済みなので止めようがなく、Claude への通知だけが残る。
// あとは Claude が区切りのよい場所を選べばよい。強制はしない。
//
// 使用率は statusline に渡される JSON にしか現れず、フックの入力には含まれない。
// そのため collect.js が最後に書いた collect-state-<アカウント>.json を読む。statusline は
// 数十秒おきに描画されるため、この値はフック実行時点でほぼ最新とみなせる。
//
// 枠はアカウントごとに独立しているため、判定材料も発火フラグもアカウント別に持つ。
// 共有すると「いま使っていない方のアカウントの使用率」で促してしまう。
//
// 最優先事項は「セッションを壊さないこと」。判断に必要な材料が揃わなければ黙って
// 何もしない。促しそこねても失うのは引き継ぎ1回分だが、誤動作すれば作業が止まる。

const fs = require('fs');
const path = require('path');
// アカウントの判別とファイル命名は collect.js と必ず一致させる必要がある。
// 書き手と読み手で規則がずれると、guard は黙って何も読めなくなる。
const collect = require('./collect.js');

const HOME = process.env.USERPROFILE || process.env.HOME || '.';
const DIR = path.join(HOME, '.claude', 'usage-tracker');
const ACCOUNT = collect.currentAccount();
const COLLECT_STATE = collect.statePath(ACCOUNT);
// 発火済みフラグはセッションごとに別ファイルにする。Claude Code は同時に何本も
// 動かせるため、1ファイルを共有すると read-modify-write が衝突するうえ、
// 最初に閾値を踏んだ1本だけが通知を受けて残りが引き継ぎを残せなくなる。
const STATE_DIR = path.join(DIR, 'guard-state');

// 各枠を2段構えで見る。1段目で気付かせ、無視されても2段目で最後にもう一度促す。
// 1段目だけだと、そこで作業を続ける判断をしたセッションは警告なしで上限に激突する。
//
// 閾値はアカウントごとに変わる。枠の容量比(5h枠1本が週次の何%を食うか)がプランで
// 違うため、同じ「残り x%」でも意味が違う。既定値は下の DEFAULTS に実測から置き、
// `CLAUDE_USAGE_GUARD_WEEK_THRESHOLD_MAX` のようにアカウント名のサフィックスを付けた
// 環境変数か、サフィックス無しの共通変数があればそちらを優先する。
//
// 既定値の根拠(usage-tracker のログ 2026-07-31〜08-19 の実測。analyze.js で再計算できる):
//   5h枠1本を使い切ったときに進む週次 pt … team 12.4 / max 9.8 / pro 9.8
//   → 週次枠が持つ 5h枠の本数        … team  8.0 / max 10.3 / pro 10.2
//   1リクエストあたりの消費          … 5h枠 平均 1.5pt / 週次 平均 0.1pt
// 週次の1段目は「残りが 5h枠1本を切ったら知らせる」を狙う。旧既定の 85% は Team 時代に
// 決めた値だが、どのプランでも残り 15% は 5h枠 1.2〜1.5 本分あり、まだ数時間は普通に
// 作業できる段階で促してしまっていた(容量の大きい max ほどこのずれが大きい)。
const DEFAULTS = {
  // 週次 90% で残り 12.4pt ≒ 5h枠ちょうど1本。
  team: { five: 92, fiveFinal: 97, week: 90, weekFinal: 97 },
  // 週次 92% で残り 9.8pt ≒ 5h枠ちょうど1本。
  max: { five: 92, fiveFinal: 97, week: 92, weekFinal: 97 },
  pro: { five: 92, fiveFinal: 97, week: 92, weekFinal: 97 },
};
// 未知のアカウントは実測が無いので、最も容量の小さい team の値を当てて安全側に倒す。
const BASE = DEFAULTS[ACCOUNT] || DEFAULTS.team;

function threshold(name, fallback) {
  const suffix = /^[a-zA-Z0-9_]+$/.test(ACCOUNT) ? `${name}_${ACCOUNT.toUpperCase()}` : null;
  return Number(suffix && process.env[suffix]) || Number(process.env[name]) || fallback;
}

// 5h枠の1段目。実測では 90% から枠切れまで中央 11〜12 分・最短 4 分しかなく、ここは
// 「余裕がある段階」ではないので大きくは上げられない。92% でも中央 9 分は残り、/wrap
// 1回(数リクエスト = 5h枠で 5〜10pt)には間に合う。
const FIVE_THRESHOLD = threshold('CLAUDE_USAGE_GUARD_THRESHOLD', BASE.five);
// 5h枠の2段目。95% を超えると枠切れまで 0 分のことがあるため、これ以上は上げない。
const FIVE_FINAL = threshold('CLAUDE_USAGE_GUARD_FINAL_THRESHOLD', BASE.fiveFinal);
// 週次枠の1段目。ここではまだ畳ませず、残量だけ意識させる。
const WEEK_THRESHOLD = threshold('CLAUDE_USAGE_GUARD_WEEK_THRESHOLD', BASE.week);
// 週次枠の2段目。5h枠のガードは週次枠切れを一切防げない(週次が尽きるとき 5h枠は低い
// ままでありうる)ため、この段がないと週次の枠切れは必ず予告なしに来る。週次1pt は
// 5h枠の約 8〜10pt に相当するので、残り3%あれば /wrap には桁違いに足りる。99% にしない
// のは、使用率が整数で返るうえ collect-state に最大15分の遅れがあるため(実測で週次は
// 30分に最大 7〜10pt 進むので、98% では気付いた時点で尽きていることがある)。
const WEEK_FINAL = threshold('CLAUDE_USAGE_GUARD_WEEK_FINAL_THRESHOLD', BASE.weekFinal);
// collect.js のハートビートは10分間隔。それを超えて古い値は信用しない。
// 古い値で促すと、枠が切り替わった直後に誤発火しかねない。
const STALE_MS = 15 * 60 * 1000;
// 使い終わったセッションのフラグを溜め続けないための保持期間。
const PRUNE_MS = 14 * 24 * 60 * 60 * 1000;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// セッションIDはUUIDだが、フックの入力を無検証でパスに使わない。
const stateFileFor = (sid) =>
  path.join(STATE_DIR, (sid || '_unknown').replace(/[^A-Za-z0-9_.-]/g, '_') + '.json');

// リセット時刻は実測では Unix epoch 秒で来るが、analyze.js は ISO8601 文字列も
// 受け付ける。こちらだけ数値前提にすると、将来表現が変わったとき「期限切れの枠で
// 発火する」「時刻が Invalid Date になる」という形で静かに壊れるので同じ扱いにする。
function normalizeResetMs(v) {
  if (typeof v === 'number' && isFinite(v)) return v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isFinite(t) ? t : null;
  }
  return null;
}

const fmtTime = (ms) => {
  if (ms == null || !isFinite(ms)) return '不明';
  try {
    return new Date(ms).toLocaleString('ja-JP', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '不明';
  }
};

// 促し文。コミットさせないのは意図的で、この時点のコードは検証を通っていない。
// 代わりに dirty かどうかを引き継ぎに残させ、次のセッションが気付けるようにする。
function buildMessage(stages, st, resets) {
  const anyFinal = stages.five === 'final' || stages.seven === 'final';
  const lines = [
    anyFinal
      ? '[usage-tracker] プラン利用枠の上限が目前です。'
      : '[usage-tracker] プラン利用枠が閾値に達しました。',
  ];

  if (stages.five) {
    const tag = stages.five === 'final' ? '【最終】' : '【警告】';
    lines.push(
      `- 5時間枠: ${Math.round(st.five_pct)}% ${tag} 残り約 ${Math.max(0, 100 - Math.round(st.five_pct))}% / リセット ${fmtTime(resets.five)}`
    );
  }
  if (stages.seven) {
    const tag = stages.seven === 'final' ? '【最終】' : '【警告】';
    lines.push(
      `- 週次枠: ${Math.round(st.seven_pct)}% ${tag} 残り約 ${Math.max(0, 100 - Math.round(st.seven_pct))}% / リセット ${fmtTime(resets.seven)}`
    );
  }
  lines.push('');

  // 畳ませるのは最終段だけにする。1段目はどちらの枠でも「残量を意識させる」に留める。
  // 5h枠の1段目でも畳ませていた頃は、リセットまで最大5時間しかない枠のために作業を
  // 止めており、中断のコストの割に守れるものが小さかった。最終段は逆に、次に止まる
  // ときは枠切れなので、最短で切り上げさせる。
  if (anyFinal) {
    lines.push('これが最後の通知です。次に止まるときは枠切れで、記録を残す機会はありません。');
    lines.push('新しい作業には着手せず、いま動かしている処理を最短で切り上げてください。');
    lines.push('ただちに以下を実行してください:');
    lines.push('');
    lines.push('1. `git status --short` を実行し、未コミット変更の有無を確認する');
    lines.push('2. その結果(dirty ならファイル名も)を引き継ぎに含める形で `/wrap` を実行する');
    lines.push('');
    lines.push('コミット・ビルド・テストは行わないでください(検証を通していない状態のため)。');
    lines.push('`/wrap` が終わったらそこでセッションを終了し、続きは枠のリセット後にしてください。');
    if (stages.seven === 'final') {
      lines.push('週次枠を使い切るとリセットまで数日間まったく作業できません。5時間枠の残量とは');
      lines.push('無関係に打ち切られるため、残量に余裕があるように見えても続行しないでください。');
    }
  } else {
    // 1段目。緊急性が違うので、いま畳ませるのではなく残量を意識させる。
    // 枠によって使い切ったときに失うものが違うので、理由はそれぞれの枠に即して書く。
    lines.push('このセッションを直ちに畳む必要はありませんが、残量が少なくなっています。');
    if (stages.seven) {
      lines.push('週次枠を使い切るとリセットまで数日間まったく作業できなくなります。');
    }
    if (stages.five) {
      lines.push('5時間枠を使い切ると、リセットまで会話は打ち切られたままになります。');
    }
    lines.push('大きな作業に着手する前に、残量で足りるかをユーザーに確認してください。区切りが');
    lines.push('ついた時点で `/wrap` を実行し、引き継ぎを残しておくことを勧めます');
    lines.push('(コミット・ビルド・テストは不要)。');
  }

  lines.push('');
  lines.push('この通知は枠ごと・段階ごとに1回だけです。作業を続けるかどうかはユーザーの判断に従ってください。');
  return lines.join('\n');
}

// ある枠について、いま promote すべき段階を返す('final' / 'warn' / null)。
// 記録された枠が既にリセット済みなら、その使用率は前の枠のもの。発火済みかは枠の
// リセット時刻をキーに判定するので、枠が変われば自動的に解除される。
// resetMs / prevResetMs は normalizeResetMs 済みの ms 値。
function stageFor(pct, resetMs, prevResetMs, prevStage, warnAt, finalAt) {
  if (typeof pct !== 'number' || resetMs == null) return null;
  if (resetMs <= Date.now()) return null;

  // 同じ枠での発火済み段階。枠が変わっていれば未発火として扱う。
  const done = prevResetMs === resetMs ? prevStage : null;

  if (pct >= finalAt && done !== 'final') return 'final';
  // 最終段を出したあとに警告段を出しても意味がないので抑止する。
  if (pct >= warnAt && !done) return 'warn';
  return null;
}

// 促すべき枠と段階を返す。促さない理由が一つでもあればその枠は対象外。
function evaluate(sid) {
  const st = readJson(COLLECT_STATE);
  if (!st) return null;

  const age = Date.now() - Date.parse(st.ts);
  if (!isFinite(age) || age > STALE_MS) return null;

  // セッションの途中で /login すると、以降は別アカウントの枠を消費する。前のアカウントの
  // 発火済みフラグを引き継ぐと新しい枠の枠切れを予告しそこねるため、未発火として扱う。
  const stored = readJson(stateFileFor(sid)) || {};
  // acct を持たない旧形式のフラグは、複数アカウント対応(acct フィールド追加)より前に
  // 書かれたものなので、当時の唯一のアカウント = 今のアカウントとして引き継ぐ(移行)。
  // ここを厳密一致だけにすると、アップグレード直後は全ての古いフラグが無効と見なされ、
  // 同じ枠・同じ段階の警告が一回分だけ二重に出てしまう。markFired は常に acct 付きで
  // 書き直すため、この移行は初回だけ効き、以降は通常の厳密一致に戻る。
  const prev = stored.acct == null || stored.acct === ACCOUNT ? stored : {};
  // フラグ側も ms で持つ。書き出しと読み出しで同じ正規化を通すので、
  // 表現が混在しても同じ枠は同じキーに落ちる。
  const resets = {
    five: normalizeResetMs(st.five_reset),
    seven: normalizeResetMs(st.seven_reset),
  };
  const stages = {
    five: stageFor(st.five_pct, resets.five, prev.five_reset_ms, prev.five_stage, FIVE_THRESHOLD, FIVE_FINAL),
    seven: stageFor(st.seven_pct, resets.seven, prev.seven_reset_ms, prev.seven_stage, WEEK_THRESHOLD, WEEK_FINAL),
  };

  if (!stages.five && !stages.seven) return null;
  return { stages, st, prev, resets };
}

function markFired(sid, stages, resets, prev) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const next = {
      // どのアカウントの枠で発火したか。次回の evaluate がこれを見て、
      // アカウントが変わっていればフラグを引き継がない。
      acct: ACCOUNT,
      // 発火していない側は以前の記録を保つ。片方の発火でもう片方が消えると
      // 同じ枠で二重に促してしまう。
      five_reset_ms: stages.five ? resets.five : prev.five_reset_ms,
      five_stage: stages.five || prev.five_stage || null,
      seven_reset_ms: stages.seven ? resets.seven : prev.seven_reset_ms,
      seven_stage: stages.seven || prev.seven_stage || null,
      ts: new Date().toISOString(),
    };
    fs.writeFileSync(stateFileFor(sid), JSON.stringify(next));
    prune();
  } catch {
    // 記録できなくても促し自体は済んでいる。最悪もう一度促すだけ。
  }
}

// 終了したセッションのフラグは誰も消さないので、発火のついでに古いものを掃除する。
// 発火は枠あたり1回なので、この走査が頻繁に走ることはない。
function prune() {
  try {
    const cutoff = Date.now() - PRUNE_MS;
    for (const name of fs.readdirSync(STATE_DIR)) {
      const file = path.join(STATE_DIR, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch {}
    }
  } catch {}
}

// フックの入力。session_id でフラグを分け、Stop では stop_hook_active を見る。
function readHookInput() {
  if (process.stdin.isTTY) return {};
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8')) || {};
  } catch {
    return {};
  }
}

function main() {
  const mode = process.argv[2] || '';

  // 手元での確認用。フックからは呼ばれない。
  if (mode === 'status') {
    const st = readJson(COLLECT_STATE);
    const sid = process.argv[3] || '_unknown';
    console.log(`アカウント: ${ACCOUNT} (${COLLECT_STATE})`);
    console.log(`閾値: 5h 警告${FIVE_THRESHOLD}%/最終${FIVE_FINAL}% , 7d 警告${WEEK_THRESHOLD}%/最終${WEEK_FINAL}%`);
    console.log(
      'collect-state:',
      st ? `5h=${st.five_pct}% 7d=${st.seven_pct}% (ts=${st.ts})` : '(なし)'
    );
    let files = [];
    try { files = fs.readdirSync(STATE_DIR); } catch {}
    console.log(`guard-state: ${files.length} セッション分`);
    for (const f of files) console.log('  ', f, JSON.stringify(readJson(path.join(STATE_DIR, f))));
    const hit = evaluate(sid);
    console.log(`判定(sid=${sid}):`, hit ? JSON.stringify(hit.stages) : '促さない');
    return;
  }
  if (mode === 'reset') {
    try {
      for (const f of fs.readdirSync(STATE_DIR)) fs.unlinkSync(path.join(STATE_DIR, f));
    } catch {}
    console.log('guard-state を削除しました');
    return;
  }

  const input = readHookInput();
  const event = input.hook_event_name || mode;

  // Stop フックの再帰。ここで促すと自分が止めたターンでまた止めることになる。
  if (event === 'Stop' && input.stop_hook_active) return;

  const hit = evaluate(input.session_id);
  if (!hit) return;

  markFired(input.session_id, hit.stages, hit.resets, hit.prev);
  const message = buildMessage(hit.stages, hit.st, hit.resets);

  if (event === 'Stop') {
    // exit 2 でターンの終了を差し止め、stderr を Claude に渡す。
    // ツールを使わないターンでは PostToolUse が発火しないため、その取りこぼしを拾う。
    process.stderr.write(message + '\n');
    process.exit(2);
  }

  // PostToolUse。ツールは既に実行済みなので何も妨げない。エラー扱いを避けるため
  // exit 2 の stderr ではなく additionalContext で渡す。
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: message,
      },
    })
  );
}

try {
  main();
} catch {
  // 判定の失敗でセッションを止めない。
}
