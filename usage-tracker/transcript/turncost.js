'use strict';
// コンテキスト長そのものが1ターンの単価をどれだけ押し上げるかを測る。
// セッションを「どこで切るべきか」の閾値を決めるのが目的。
const { cost, ctxLen, modelKey, transcriptFiles, records, warnUnknownModels } = require('./lib');

const BUCKETS = [
  [0, 30e3, '〜30K'], [30e3, 60e3, '30〜60K'], [60e3, 100e3, '60〜100K'],
  [100e3, 150e3, '100〜150K'], [150e3, 200e3, '150〜200K'],
  [200e3, 300e3, '200〜300K'], [300e3, Infinity, '300K〜'],
];

// 倍率の基準帯と「肥大側」の下限。BUCKETS を編集しても追従するよう、
// 添字を直書きせずラベルと下限値から引く。
// 基準を 30〜60K に置くのは、〜30K 帯が実データでは常に空になるため。
// システムプロンプト・ツール定義・CLAUDE.md だけでプロンプト長の下限が 30K を超える。
// (この帯にターンが入るなら ctxLen の算入漏れを疑う。cache_read だけを見ていた頃は
//  キャッシュ再作成ターンが誤ってここに落ち、単価が 2.8 倍に見えていた)
const BASE_LABEL = '30〜60K';
const HEAVY_FROM = 150e3;

(async () => {
  const b = BUCKETS.map(() => ({ n: 0, cost: 0 }));
  // Opus 系メインスレッドのみに絞る(モデル混在による単価差を排除する)
  for (const f of transcriptFiles()) {
    for await (const o of records(f)) {
      if (o.type !== 'assistant' || o.isSidechain || !o.message || !o.message.usage) continue;
      const model = modelKey(o.message.model);
      if (!model.startsWith('opus')) continue;
      const ctx = ctxLen(o.message.usage);
      const i = BUCKETS.findIndex(([lo, hi]) => ctx >= lo && ctx < hi);
      if (i < 0) continue;
      b[i].n++; b[i].cost += cost(o.message.model, o.message.usage);
    }
  }

  console.log('Opus メインスレッドのターン単価(コンテキスト長別)\n');
  console.log(`コンテキスト長      ターン数    合計$    $/ターン  ${BASE_LABEL}比`);
  const baseIdx = BUCKETS.findIndex(([, , label]) => label === BASE_LABEL);
  const base = b[baseIdx].n ? b[baseIdx].cost / b[baseIdx].n : 0;
  for (let i = 0; i < BUCKETS.length; i++) {
    if (!b[i].n) continue;
    const per = b[i].cost / b[i].n;
    console.log(BUCKETS[i][2].padEnd(18) + String(b[i].n).padStart(8)
      + ('$' + b[i].cost.toFixed(0)).padStart(9) + ('$' + per.toFixed(4)).padStart(11)
      + (base ? (per / base).toFixed(1) : '-').padStart(9) + '倍');
  }
  const tot = b.reduce((a, x) => a + x.cost, 0);
  const heavy = BUCKETS.reduce((a, [lo], i) => a + (lo >= HEAVY_FROM ? b[i].cost : 0), 0);
  const pct = tot ? (heavy / tot * 100).toFixed(1) : '0.0';
  console.log(`\n合計 $${tot.toFixed(0)} のうち ${HEAVY_FROM / 1e3}K 超のターンが $${heavy.toFixed(0)} (${pct}%)`);
  warnUnknownModels();
})();
