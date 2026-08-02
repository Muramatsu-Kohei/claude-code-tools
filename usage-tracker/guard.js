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
// 発火済みフラグはセッションごとに別ファイルにする。Claude Code は同時に何本も
// 動かせるため、1ファイルを共有すると read-modify-write が衝突するうえ、
// 最初に閾値を踏んだ1本だけが通知を受けて残りが引き継ぎを残せなくなる。
const STATE_DIR = path.join(DIR, 'guard-state');

// 5h枠は既定 90%。/wrap を完走させる余裕を残しつつ、早すぎて邪魔にならない値。
const FIVE_THRESHOLD = Number(process.env.CLAUDE_USAGE_GUARD_THRESHOLD) || 90;
// 週次枠は既定 85%。実測で「5h枠を満タンにすると週次が約12%進む」ため、
// 15% 残っていれば満タン1回強の余裕がある。週次はリセットまで最大7日あり、
// 使い切ると数日間まったく動けなくなるので 5h枠より早めに知らせる。
const WEEK_THRESHOLD = Number(process.env.CLAUDE_USAGE_GUARD_WEEK_THRESHOLD) || 85;
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

const fmtTime = (epochSec) => {
  try {
    return new Date(epochSec * 1000).toLocaleString('ja-JP', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '不明';
  }
};

// 促し文。コミットさせないのは意図的で、この時点のコードは検証を通っていない。
// 代わりに dirty かどうかを引き継ぎに残させ、次のセッションが気付けるようにする。
function buildMessage(hits, st) {
  const lines = ['[usage-tracker] プラン利用枠が閾値に達しました。'];

  if (hits.five) {
    lines.push(
      `- 5時間枠: ${Math.round(st.five_pct)}%(閾値 ${FIVE_THRESHOLD}%)/ リセット ${fmtTime(st.five_reset)}`
    );
  }
  if (hits.seven) {
    lines.push(
      `- 週次枠: ${Math.round(st.seven_pct)}%(閾値 ${WEEK_THRESHOLD}%)/ リセット ${fmtTime(st.seven_reset)}`
    );
  }
  lines.push('');

  if (hits.five) {
    // 5h枠は数時間で戻る。問題は「いま打ち切られること」なので、畳ませる。
    lines.push('新しい作業には着手せず、いま手を付けている処理を安全に区切ってください。そのうえで:');
    lines.push('');
    lines.push('1. `git status --short` を実行し、未コミット変更の有無を確認する');
    lines.push('2. その結果(dirty ならファイル名も)を引き継ぎに含める形で `/wrap` を実行する');
    lines.push('');
    lines.push('コミット・ビルド・テストは行わないでください(検証を通していない状態のため)。');
  } else {
    // 週次枠だけの場合は緊急性が違う。いま畳む必要はないが、残量を意識させる。
    lines.push('このセッションを直ちに畳む必要はありませんが、週次枠を使い切るとリセットまで');
    lines.push('数日間まったく作業できなくなります。大きな作業に着手する前に、残量で足りるかを');
    lines.push('ユーザーに確認してください。区切りがついた時点で `/wrap` を実行し、引き継ぎを');
    lines.push('残しておくことを勧めます(コミット・ビルド・テストは不要)。');
  }

  lines.push('');
  lines.push('この通知は枠ごとに1回だけです。作業を続けるかどうかはユーザーの判断に従ってください。');
  return lines.join('\n');
}

// 促すべき枠を返す。促さない理由が一つでもあればその枠は対象外。
function evaluate(sid) {
  const st = readJson(COLLECT_STATE);
  if (!st) return null;

  const age = Date.now() - Date.parse(st.ts);
  if (!isFinite(age) || age > STALE_MS) return null;

  const prev = readJson(stateFileFor(sid)) || {};
  const now = Date.now();
  const hits = { five: false, seven: false };

  // 記録された枠が既にリセット済みなら、その使用率は前の枠のもの。
  // 発火済みかは枠のリセット時刻をキーに判定するので、枠が変われば自動的に解除される。
  if (
    typeof st.five_pct === 'number' && st.five_reset &&
    st.five_reset * 1000 > now && st.five_pct >= FIVE_THRESHOLD &&
    !(prev.five_reset === st.five_reset && prev.five_fired)
  ) {
    hits.five = true;
  }

  if (
    typeof st.seven_pct === 'number' && st.seven_reset &&
    st.seven_reset * 1000 > now && st.seven_pct >= WEEK_THRESHOLD &&
    !(prev.seven_reset === st.seven_reset && prev.seven_fired)
  ) {
    hits.seven = true;
  }

  if (!hits.five && !hits.seven) return null;
  return { hits, st, prev };
}

function markFired(sid, hits, st, prev) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const next = {
      // 発火していない側は以前の記録を保つ。片方の発火でもう片方が消えると
      // 同じ枠で二重に促してしまう。
      five_reset: hits.five ? st.five_reset : prev.five_reset,
      five_fired: hits.five ? true : !!prev.five_fired,
      seven_reset: hits.seven ? st.seven_reset : prev.seven_reset,
      seven_fired: hits.seven ? true : !!prev.seven_fired,
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
    console.log(`閾値: 5h=${FIVE_THRESHOLD}% / 7d=${WEEK_THRESHOLD}%`);
    console.log(
      'collect-state:',
      st ? `5h=${st.five_pct}% 7d=${st.seven_pct}% (ts=${st.ts})` : '(なし)'
    );
    let files = [];
    try { files = fs.readdirSync(STATE_DIR); } catch {}
    console.log(`guard-state: ${files.length} セッション分`);
    for (const f of files) console.log('  ', f, JSON.stringify(readJson(path.join(STATE_DIR, f))));
    const hit = evaluate(sid);
    console.log(`判定(sid=${sid}):`, hit ? JSON.stringify(hit.hits) : '促さない');
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

  markFired(input.session_id, hit.hits, hit.st, hit.prev);
  const message = buildMessage(hit.hits, hit.st);

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
