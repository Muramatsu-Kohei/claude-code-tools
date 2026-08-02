'use strict';
// Claude Code のプラン利用枠(5時間枠 / 週次枠)の使用率を時系列で記録する。
//
// 使用率は statusline に渡される JSON の rate_limits にしか現れず、transcript にも
// API レスポンスにも残らない。したがって statusline から相乗りして拾うのが唯一の経路。
// statusline は表示更新ごとに何度も呼ばれるため、変化がないときは書かずにログの肥大化を防ぐ。
//
// 最優先事項は「statusline を壊さないこと」。ここでの失敗は全て飲み込み、呼び出し側も
// try/catch で包む。1行でも欠けたら分析が破綻するようなデータではないので、
// 取りこぼしよりも表示の安定を選ぶ。

const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || '.';
const DIR = path.join(HOME, '.claude', 'usage-tracker');
const LOG = path.join(DIR, 'usage.jsonl');
const STATE = path.join(DIR, 'collect-state.json');

// 使用率が動かない区間も「消費が止まっていた」という情報なので、変化なしでも
// この間隔で1点だけ残す。5時間枠の傾きを見るのに十分な粒度。
const HEARTBEAT_MS = 10 * 60 * 1000;
// 使用率は小数で来るため、丸め誤差程度の揺れを変化と誤認しないための閾値。
const EPS = 0.05;

const num = (v) => typeof v === 'number' && isFinite(v);

// 前回書いた点。読めなければ「初回」として扱えばよいだけなので例外は無視する。
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return null;
  }
}

// 記録すべきか。使用率かリセット時刻が動いたとき、または一定時間が経ったとき。
// リセット時刻の変化は枠の切り替わりそのものなので、%が同じでも必ず残す。
function shouldWrite(prev, row, nowMs) {
  if (!prev) return true;
  if (prev.five_reset !== row.five_reset) return true;
  if (prev.seven_reset !== row.seven_reset) return true;
  if (num(row.five_pct) && Math.abs((prev.five_pct ?? -1) - row.five_pct) >= EPS) return true;
  if (num(row.seven_pct) && Math.abs((prev.seven_pct ?? -1) - row.seven_pct) >= EPS) return true;
  const prevMs = Date.parse(prev.ts);
  if (!isFinite(prevMs)) return true;
  return nowMs - prevMs >= HEARTBEAT_MS;
}

function record(d) {
  const five = d && d.rate_limits && d.rate_limits.five_hour;
  const seven = d && d.rate_limits && d.rate_limits.seven_day;
  // どちらの枠も欠けている入力は分析に使えない。セッション開始直後に起こりうる。
  if (!num(five && five.used_percentage) && !num(seven && seven.used_percentage)) return;

  const cw = d.context_window || {};
  const now = new Date();
  const row = {
    ts: now.toISOString(),
    five_pct: num(five && five.used_percentage) ? five.used_percentage : null,
    five_reset: (five && five.resets_at) || null,
    seven_pct: num(seven && seven.used_percentage) ? seven.used_percentage : null,
    seven_reset: (seven && seven.resets_at) || null,
    // どのモデルをどの強度で回していたかで枠の減り方が変わるため、消費の内訳を推定する材料にする。
    model: (d.model && d.model.display_name) || null,
    effort: (d.effort && d.effort.level) || null,
    fast: d.fast_mode === true ? 1 : 0,
    // コンテキスト窓の累積入出力。セッション単位でリセットされるので絶対量ではないが、
    // 同一セッション内では単調増加するため「%あたり何トークン」の手掛かりになる。
    in_tok: num(cw.total_input_tokens) ? cw.total_input_tokens : null,
    out_tok: num(cw.total_output_tokens) ? cw.total_output_tokens : null,
    cost: num(d.cost && d.cost.total_cost_usd) ? d.cost.total_cost_usd : null,
    sid: d.session_id || null,
  };

  const prev = readState();
  if (!shouldWrite(prev, row, now.getTime())) return;

  fs.mkdirSync(DIR, { recursive: true });
  fs.appendFileSync(LOG, JSON.stringify(row) + '\n');
  // state は「最後に書いた行」そのもの。ログを読み直さずに差分判定できるようにしている。
  fs.writeFileSync(STATE, JSON.stringify(row));
}

module.exports = {
  record(d) {
    try {
      record(d);
    } catch {
      // 収集の失敗で statusline を落とさない。
    }
  },
  LOG,
  DIR,
};
