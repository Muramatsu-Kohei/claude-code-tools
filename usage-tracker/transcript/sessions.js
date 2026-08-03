'use strict';
// セッション単位で「コンテキストがどこまで膨らんだか」「委譲したか自分で読んだか」を集計する。
// 目的は運用ルール(委譲率を上げる/セッションを短く保つ)を実データで裏付けること。
const path = require('path');
const { cost, ctxLen, transcriptFiles, records, warnUnknownModels } = require('./lib');

// メインスレッドで直接使うと文脈を太らせるツール群(委譲候補)
const HEAVY = new Set(['Read', 'Grep', 'Glob', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch']);

(async () => {
  const files = transcriptFiles();
  const sessions = [];

  for (const f of files) {
    const s = {
      project: path.basename(path.dirname(f)),
      id: path.basename(f, '.jsonl').slice(0, 8),
      mainTurns: 0, subTurns: 0,
      maxCtx: 0,          // メインの総プロンプト長の最大値 = 到達したコンテキスト長
      heavy: 0, task: 0,  // メインでの重いツール呼び出し数 / サブエージェント委譲回数
      costMain: 0, costSub: 0,
      start: null, end: null,
    };

    for await (const o of records(f)) {
      if (o.timestamp) {
        if (!s.start || o.timestamp < s.start) s.start = o.timestamp;
        if (!s.end || o.timestamp > s.end) s.end = o.timestamp;
      }
      if (o.type !== 'assistant' || !o.message) continue;

      const sub = !!o.isSidechain;
      const u = o.message.usage;
      if (u) {
        const c = cost(o.message.model, u);
        if (sub) { s.subTurns++; s.costSub += c; }
        else {
          s.mainTurns++; s.costMain += c;
          s.maxCtx = Math.max(s.maxCtx, ctxLen(u));
        }
      }
      // ツール呼び出しの内訳はメインスレッド分だけ見る(サブは委譲済みなので対象外)
      if (!sub && Array.isArray(o.message.content)) {
        for (const c of o.message.content) {
          if (c.type !== 'tool_use') continue;
          if (c.name === 'Task' || c.name === 'Agent') s.task++;
          else if (HEAVY.has(c.name)) s.heavy++;
        }
      }
    }
    if (s.mainTurns > 0) sessions.push(s);
  }

  const totalCost = sessions.reduce((a, s) => a + s.costMain + s.costSub, 0);
  const totHeavy = sessions.reduce((a, s) => a + s.heavy, 0);
  const totTask = sessions.reduce((a, s) => a + s.task, 0);

  console.log(`セッション数: ${sessions.length}  総換算コスト: $${totalCost.toFixed(0)}`);
  // 対象ツールを一度も使っていない集計(絞り込みすぎ/空の transcript)では率が定義できない
  const delegation = totHeavy + totTask ? (totTask / (totHeavy + totTask) * 100).toFixed(1) + '%' : '-';
  console.log(`メインでの重いツール呼び出し: ${totHeavy} 回 / サブエージェント委譲: ${totTask} 回`
    + `  → 委譲率 ${delegation}\n`);

  // コンテキスト長の分布: どの帯域にコストが集中しているか
  const buckets = [
    [0, 50e3, '〜50K'], [50e3, 100e3, '50K〜100K'], [100e3, 150e3, '100K〜150K'],
    [150e3, 200e3, '150K〜200K'], [200e3, Infinity, '200K〜'],
  ];
  console.log('到達コンテキスト長  セッション数   換算コスト   コスト比');
  for (const [lo, hi, label] of buckets) {
    const g = sessions.filter(s => s.maxCtx >= lo && s.maxCtx < hi);
    const c = g.reduce((a, s) => a + s.costMain + s.costSub, 0);
    const share = totalCost ? (c / totalCost * 100).toFixed(1) : '0.0';
    console.log(label.padEnd(20) + String(g.length).padStart(8)
      + ('$' + c.toFixed(0)).padStart(13) + share.padStart(9) + '%');
  }

  console.log('\n--- コスト上位15セッション ---');
  console.log('project              id        main  sub   maxCtx   heavy  task    cost');
  for (const s of sessions.sort((a, b) => (b.costMain + b.costSub) - (a.costMain + a.costSub)).slice(0, 15)) {
    console.log(
      s.project.slice(0, 20).padEnd(21) + s.id.padEnd(10) +
      String(s.mainTurns).padStart(4) + String(s.subTurns).padStart(5) +
      (Math.round(s.maxCtx / 1000) + 'K').padStart(9) +
      String(s.heavy).padStart(8) + String(s.task).padStart(6) +
      ('$' + (s.costMain + s.costSub).toFixed(1)).padStart(9));
  }

  // 「長く続けたセッション」の限界コスト: ターンが進むほど1ターンの単価は上がる
  console.log('\n--- メインターン数の帯域別の平均コスト/セッション ---');
  for (const [lo, hi, label] of [[0,20,'〜20'],[20,50,'20〜50'],[50,100,'50〜100'],[100,200,'100〜200'],[200,Infinity,'200〜']]) {
    const g = sessions.filter(s => s.mainTurns >= lo && s.mainTurns < hi);
    if (!g.length) continue;
    const c = g.reduce((a, s) => a + s.costMain + s.costSub, 0);
    const t = g.reduce((a, s) => a + s.mainTurns, 0);
    console.log(('ターン ' + label).padEnd(16) + String(g.length).padStart(5) + '本'
      + ('$' + (c / g.length).toFixed(1) + '/本').padStart(12)
      + ('$' + (c / t).toFixed(3) + '/ターン').padStart(16));
  }
  warnUnknownModels();
})();
