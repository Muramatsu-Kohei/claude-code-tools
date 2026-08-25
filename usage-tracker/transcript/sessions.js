'use strict';
// セッション単位で「コンテキストがどこまで膨らんだか」「委譲したか自分で読んだか」を集計する。
// 目的は運用ルール(委譲率を上げる/セッションを短く保つ)を実データで裏付けること。
const path = require('path');
const { cost, ctxLen, transcriptFiles, records, isNonInteractive, makeNonInteractiveFilter, makeUsageCollector, warnUnknownModels } = require('./lib');

// メインスレッドで直接使うと文脈を太らせるツール群(委譲候補)
const HEAVY = new Set(['Read', 'Grep', 'Glob', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch']);

(async () => {
  const files = transcriptFiles();
  const sessions = [];
  // 非対話実行(claude -p / SDK)は「使い方」ではないので集計から外す。判定は lib.js に
  // 集約してある(claude-window-keeper の ping が 1 セッション 1 送信でセッション数を
  // 押し上げ、cwd 由来の架空プロジェクト C--WINDOWS-system32 としても現れる)。
  const nonInteractiveFile = makeNonInteractiveFilter();
  let sdkSessions = 0, sdkRecords = 0;

  for (const f of files) {
    const sdk = nonInteractiveFile(f);
    if (sdk === 'session') { sdkSessions++; continue; }
    if (sdk) continue;   // 親が非対話のサブエージェント。本数には数えない(親で 1 本数えた)
    // 分割された同一応答の二重計上を防ぐ(規則と実測は lib.js の makeUsageCollector を参照)。
    const usages = makeUsageCollector();

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
      // セッション単位の判定を抜けた個別レコードの保険(対話セッションに sdk 由来の
      // レコードが混ざる形が将来出ても、ここで落ちる)。
      if (isNonInteractive(o)) { sdkRecords++; continue; }
      if (o.timestamp) {
        if (!s.start || o.timestamp < s.start) s.start = o.timestamp;
        if (!s.end || o.timestamp > s.end) s.end = o.timestamp;
      }
      if (o.type !== 'assistant' || !o.message) continue;

      const sub = !!o.isSidechain;
      // usage 由来の値は収集器に預け、ファイルを読み終えてから応答ごとに 1 回だけ足す。
      usages.add(o);
      // ツール呼び出しの内訳はメインスレッド分だけ見る(サブは委譲済みなので対象外)
      if (!sub && Array.isArray(o.message.content)) {
        for (const c of o.message.content) {
          if (c.type !== 'tool_use') continue;
          if (c.name === 'Task' || c.name === 'Agent') s.task++;
          else if (HEAVY.has(c.name)) s.heavy++;
        }
      }
    }
    // 応答ごとに 1 回。ターン数・コスト・到達コンテキスト長はすべてここから出す。
    for (const { usage, model, isSub } of usages.entries()) {
      const c = cost(model, usage);
      if (isSub) { s.subTurns++; s.costSub += c; }
      else {
        s.mainTurns++; s.costMain += c;
        s.maxCtx = Math.max(s.maxCtx, ctxLen(usage));
      }
    }
    if (s.mainTurns > 0) sessions.push(s);
  }

  const totalCost = sessions.reduce((a, s) => a + s.costMain + s.costSub, 0);
  const totHeavy = sessions.reduce((a, s) => a + s.heavy, 0);
  const totTask = sessions.reduce((a, s) => a + s.task, 0);

  console.log(`セッション数: ${sessions.length}  総換算コスト: $${totalCost.toFixed(0)}`);
  // 0 でなければ ping などが走っている。何本を外したかを出さないと、セッション数が
  // 減った理由が集計の変更なのか使い方の変化なのか読み手に分からない。
  if (sdkSessions || sdkRecords) {
    const excluded = [`セッション ${sdkSessions} 本`];
    if (sdkRecords) excluded.push(`単独レコード ${sdkRecords} 件`);
    console.log(`(非対話実行 claude -p の${excluded.join(' / ')}は集計から除外)`);
  }
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
