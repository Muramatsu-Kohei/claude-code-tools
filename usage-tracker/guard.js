'use strict';
// 5時間枠の使用率が閾値を超えたら、作業を畳んで引き継ぎを残すよう Claude に促す。
//
// 枠を使い切ると会話は途中で強制的に打ち切られ、何をしていたかの記録が残らない。
// 実測では 90% から 99% まで約20分、持続的な最速消費でも 1.2pt/分だったので、
// 90% で気付ければ引き継ぎを書く余裕は十分にある。
//
// 設計上の要点は「ブロックしないこと」。PreToolUse で止めると引き継ぎを書くための
// worklog 実行まで巻き添えになり、それを避けるための例外処理が必要になる。
// PostToolUse ならツールは実行済みなので止めようがなく、Claude への通知だけが残る。
// あとは Claude が区切りのよい場所を選べばよい。強制はしない。
//
// 使用率は statusline に渡される JSON にしか現れず、フックの入力には含まれない。
// そのため collect.js が最後に書いた collect-state.json を読む。statusline は
// 数十秒おきに描画されるため、この値はフック実行時点でほぼ最新とみなせる。
//
// 最優先事項は「セッションを壊さないこと」。判断に必要な材料が揃わなければ黙って
// 何もしない。促しそこねても失うのは引き継ぎ1回分だが、誤動作すれば作業が止まる。

const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || '.';
const DIR = path.join(HOME, '.claude', 'usage-tracker');
const COLLECT_STATE = path.join(DIR, 'collect-state.json');
const GUARD_STATE = path.join(DIR, 'guard-state.json');

// 既定 90%。/wrap を完走させる余裕を残しつつ、早すぎて邪魔にならない値。
const THRESHOLD = Number(process.env.CLAUDE_USAGE_GUARD_THRESHOLD) || 90;
// collect.js のハートビートは10分間隔。それを超えて古い値は信用しない。
// 古い値で促すと、枠が切り替わった直後に誤発火しかねない。
const STALE_MS = 15 * 60 * 1000;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// 促し文。コミットさせないのは意図的で、この時点のコードは検証を通っていない。
// 代わりに dirty かどうかを引き継ぎに残させ、次のセッションが気付けるようにする。
function buildMessage(pct) {
  return [
    `[usage-tracker] 5時間枠の使用率が ${pct}% に達しました(閾値 ${THRESHOLD}%)。`,
    '新しい作業には着手せず、いま手を付けている処理を安全に区切ってください。そのうえで:',
    '',
    '1. `git status --short` を実行し、未コミット変更の有無を確認する',
    '2. その結果(dirty ならファイル名も)を引き継ぎに含める形で `/wrap` を実行する',
    '',
    'コミット・ビルド・テストは行わないでください(検証を通していない状態のため)。',
    'この通知はこの5時間枠で1回だけです。作業を続けたい場合はユーザーの判断に従ってください。',
  ].join('\n');
}

// 促すべきか。促さない理由が一つでもあれば促さない。
function evaluate() {
  const st = readJson(COLLECT_STATE);
  if (!st || typeof st.five_pct !== 'number' || !st.five_reset) return null;

  // 記録された枠が既にリセット済みなら、その使用率は前の枠のもの。
  if (st.five_reset * 1000 <= Date.now()) return null;

  const age = Date.now() - Date.parse(st.ts);
  if (!isFinite(age) || age > STALE_MS) return null;

  if (st.five_pct < THRESHOLD) return null;

  // 発火済みかは枠単位で持つ。five_reset が変われば別の枠なので自動的に解除される。
  const guard = readJson(GUARD_STATE);
  if (guard && guard.five_reset === st.five_reset && guard.fired) return null;

  return { pct: Math.round(st.five_pct), five_reset: st.five_reset };
}

function markFired(five_reset) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(
      GUARD_STATE,
      JSON.stringify({ five_reset, fired: true, ts: new Date().toISOString() })
    );
  } catch {
    // 記録できなくても促し自体は済んでいる。最悪もう一度促すだけ。
  }
}

// フックの入力。PostToolUse では使わないが、Stop では stop_hook_active を見る必要がある。
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
    const guard = readJson(GUARD_STATE);
    console.log('threshold:', THRESHOLD + '%');
    console.log('collect-state:', st ? `${st.five_pct}% (ts=${st.ts})` : '(なし)');
    console.log('guard-state:', guard ? JSON.stringify(guard) : '(なし)');
    console.log('判定:', evaluate() ? '促す' : '促さない');
    return;
  }
  if (mode === 'reset') {
    try { fs.unlinkSync(GUARD_STATE); } catch {}
    console.log('guard-state を削除しました');
    return;
  }

  const input = readHookInput();
  const event = input.hook_event_name || mode;

  // Stop フックの再帰。ここで促すと自分が止めたターンでまた止めることになる。
  if (event === 'Stop' && input.stop_hook_active) return;

  const hit = evaluate();
  if (!hit) return;

  markFired(hit.five_reset);
  const message = buildMessage(hit.pct);

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
