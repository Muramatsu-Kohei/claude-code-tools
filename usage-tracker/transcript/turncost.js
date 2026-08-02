'use strict';
// コンテキスト長そのものが1ターンの単価をどれだけ押し上げるかを測る。
// セッションを「どこで切るべきか」の閾値を決めるのが目的。
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(process.env.USERPROFILE, '.claude', 'projects');
// 単価テーブル本体は sessions.js と共通化して pricing.js に切り出した。
const PRICE = require('./pricing');
function cost(model, u) {
  const p = PRICE[model]; if (!p) return 0;
  return ((u.input_tokens || 0) * p.in + (u.cache_creation_input_tokens || 0) * p.in * 1.25
    + (u.cache_read_input_tokens || 0) * p.in * 0.1 + (u.output_tokens || 0) * p.out) / 1e6;
}
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const BUCKETS = [
  [0, 30e3, '〜30K'], [30e3, 60e3, '30〜60K'], [60e3, 100e3, '60〜100K'],
  [100e3, 150e3, '100〜150K'], [150e3, 200e3, '150〜200K'],
  [200e3, 300e3, '200〜300K'], [300e3, Infinity, '300K〜'],
];

(async () => {
  const b = BUCKETS.map(() => ({ n: 0, cost: 0 }));
  // Opus 系メインスレッドのみに絞る(モデル混在による単価差を排除する)
  for (const f of walk(ROOT)) {
    const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== 'assistant' || o.isSidechain || !o.message || !o.message.usage) continue;
      const model = (o.message.model || '').replace('claude-', '');
      if (!model.startsWith('opus')) continue;
      const ctx = o.message.usage.cache_read_input_tokens || 0;
      const i = BUCKETS.findIndex(([lo, hi]) => ctx >= lo && ctx < hi);
      if (i < 0) continue;
      b[i].n++; b[i].cost += cost(model, o.message.usage);
    }
  }

  console.log('Opus メインスレッドのターン単価(コンテキスト長別)\n');
  console.log('コンテキスト長      ターン数    合計$    $/ターン  30〜60K比');
  // 基準は 30〜60K 帯。〜30K 帯はセッション冒頭でキャッシュ作成(1.25倍単価)が集中するため
  // 単価が跳ね上がっており、コンテキスト肥大の影響を測る基準としては使えない。
  // CLAUDE.md に載せている倍率(150K超で1.6倍・300K超で3.6倍)もこの基準で算出している。
  const BASE_IDX = 1;
  const base = b[BASE_IDX].n ? b[BASE_IDX].cost / b[BASE_IDX].n : 0;
  for (let i = 0; i < BUCKETS.length; i++) {
    if (!b[i].n) continue;
    const per = b[i].cost / b[i].n;
    console.log(BUCKETS[i][2].padEnd(18) + String(b[i].n).padStart(8)
      + ('$' + b[i].cost.toFixed(0)).padStart(9) + ('$' + per.toFixed(4)).padStart(11)
      + (per / base).toFixed(1).padStart(9) + '倍');
  }
  const tot = b.reduce((a, x) => a + x.cost, 0);
  const over150 = b.slice(4).reduce((a, x) => a + x.cost, 0);
  console.log(`\n合計 $${tot.toFixed(0)} のうち 150K 超のターンが $${over150.toFixed(0)} (${(over150/tot*100).toFixed(1)}%)`);
})();
