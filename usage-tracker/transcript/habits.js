'use strict';
// transcript から「いつ・どれだけ・どう使ったか」を集計する。
// sessions.js が「1セッションの中身(コンテキスト長・委譲率・コスト)」を見るのに対し、
// こちらは時間軸の習慣 — 作業時間・時間帯・並行度・入力の癖・ツールの偏り — を見る。
// usage.jsonl ではなく transcript を使うのは、usage.jsonl が statusline 更新時の記録で
// サンプリングが粗く、無操作の切れ目を実際より長く見積もるため。
//
// 使い方: node habits.js [--days 14] [--gap 分] [--since YYYY-MM-DD] [--json]
const fs = require('fs');
const path = require('path');
const { ROOT, cost, ctxLen, transcriptFiles, records, warnUnknownModels } = require('./lib');

// 作業時間の既定のギャップ閾値(分)。これより長い無操作は「作業していない」とみなす。
// 5分だと 1 回の長い実行待ちで切れ、60分だと食事や仮眠を含んでしまう。
// 出力では複数の閾値を並べて、推定が閾値にどれだけ依存するかを見えるようにする。
const GAP_DEFAULT = 15;
const GAP_SWEEP = [5, 10, 15, 20, 30];
// 単発イベントだけの区間は長さ 0 になるが、実際には数分は使っている。最低これだけ割り当てる。
const MIN_BLOCK_MIN = 2;

const USAGE = 'node habits.js [--days N] [--since YYYY-MM-DD] [--gap 分] [--json]';

function die(msg) {
  console.error(`${msg}\n${USAGE}`);
  process.exit(2);
}

// 数値引数を検証して返す。Number() の結果を素通しすると、値の欠落や打ち間違いが NaN として
// 下流に流れ、比較が常に false になって「全期間を読む」「全イベントが 1 ブロックに繋がって
// 作業時間が実時間になる」といった、エラーにならない誤集計になる。入口で止める。
function numArg(v, name, min) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min) die(`${name} には ${min} 以上の数値を指定してください(受け取った値: ${v === undefined ? '(なし)' : v})`);
  return n;
}

function parseArgs(argv) {
  const o = { days: 14, json: false, since: null, gap: GAP_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--days') o.days = numArg(argv[++i], '--days', 1);
    else if (a === '--since') o.since = argv[++i];
    else if (a === '--gap') o.gap = numArg(argv[++i], '--gap', 1);
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else die(`不明な引数: ${a}`);
  }
  if (o.since !== null) {
    // 形式と実在の両方を見る。'2026-8-1' のような不揃いな表記や '2026-02-30' は
    // Date.parse が NaN や別の日に倒すので、後段の toISOString() まで壊れが伝わる。
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(o.since))) die(`--since は YYYY-MM-DD で指定してください(受け取った値: ${o.since === undefined ? '(なし)' : o.since})`);
    const t = new Date(o.since + 'T00:00:00').getTime();
    if (!Number.isFinite(t)) die(`--since に存在しない日付が指定されています: ${o.since}`);
    if (t > Date.now()) die(`--since が未来の日付です: ${o.since}`);
  }
  return o;
}

// ローカル時刻の 0 時境界。UTC で切ると日本時間の深夜作業が前日に寄って日別集計が崩れる。
function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const dayKey = t => {
  const d = new Date(t);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
};

// 時系列を gap で切り、各区間の長さの合計(分)とブロック数を返す。
// 区間の先頭イベントには MIN_BLOCK_MIN を割り当てる(単発でも 0 分にはしない)。
function activeMinutes(sorted, gapMin) {
  let total = 0, blocks = 0, prev = null;
  for (const t of sorted) {
    if (prev === null || t - prev > gapMin * 60000) { blocks++; total += MIN_BLOCK_MIN; }
    else total += (t - prev) / 60000;
    prev = t;
  }
  return { minutes: total, blocks };
}

(async () => {
  const opt = parseArgs(process.argv.slice(2));
  const now = Date.now();
  const since = opt.since
    ? new Date(opt.since + 'T00:00:00').getTime()
    : startOfDay(now) - (opt.days - 1) * 86400000;

  const stat = {
    events: [], firstTs: null, lastTs: null,
    sessions: new Map(),           // sid -> {project, first, last, mainTurns, maxCtx, cost}
    perProject: new Map(),         // project -> 時刻配列
    hours: new Array(24).fill(0),
    userMsgs: 0, userChars: 0, msgLens: [], commands: 0, interrupts: 0,
    assistantTurns: 0, toolUses: 0, totalCost: 0,
    subTurns: 0, subToolUses: 0, subCost: 0, subTools: new Map(),
    tools: new Map(), skills: new Map(), agents: new Map(), cmds: new Map(),
    models: new Map(),
  };
  const bump = (m, k, n = 1) => m.set(k, (m.get(k) || 0) + n);

  for (const f of transcriptFiles()) {
    // 期間外のファイルは開かない。全 transcript は数百 MB あり、mtime で落とすと大幅に速い。
    // (追記のみのファイルなので mtime < since なら中身も必ず期間外)
    let mtime;
    try { mtime = fs.statSync(f).mtimeMs; } catch { continue; }
    if (mtime < since) continue;

    // サブエージェントの transcript は projects/<プロジェクト>/<親セッションID>/subagents/agent-*.jsonl
    // に置かれる。dirname をそのままプロジェクト名にすると "subagents" という架空の
    // プロジェクトができ、しかもサブエージェントへの指示が人間の送信として数えられてしまう。
    // パスの第1要素を実プロジェクトとし、サブ側は親セッションに合流させて別枠で数える。
    const parts = path.relative(ROOT, f).split(path.sep);
    const project = parts[0];
    const isSub = parts.includes('subagents');
    const sid = isSub ? parts[1] : path.basename(f, '.jsonl');

    for await (const o of records(f)) {
      const t = o.timestamp ? Date.parse(o.timestamp) : 0;
      if (!t || t < since) continue;

      stat.events.push(t);
      stat.hours[new Date(t).getHours()]++;
      if (!stat.perProject.has(project)) stat.perProject.set(project, []);
      stat.perProject.get(project).push(t);
      if (stat.firstTs === null || t < stat.firstTs) stat.firstTs = t;
      if (stat.lastTs === null || t > stat.lastTs) stat.lastTs = t;

      let s = stat.sessions.get(sid);
      if (!s) {
        s = { project, first: t, last: t, mainTurns: 0, maxCtx: 0, cost: 0 };
        stat.sessions.set(sid, s);
      }
      if (t < s.first) s.first = t;
      if (t > s.last) s.last = t;

      if (o.type === 'user' && !isSub) {
        const c = o.message && o.message.content;
        // 文字列の content は人間の入力かシステム挿入。配列の content は tool_result を含む。
        // どちらもフックやリマインダが混ざるので、人間が打った分だけを数える。
        let text = null;
        if (typeof c === 'string') text = o.isMeta ? null : c;
        else if (Array.isArray(c)) {
          const t2 = c.filter(x => x.type === 'text').map(x => x.text || '').join('');
          text = t2 || null;
        }
        if (text === null) continue;
        const cmd = text.match(/<command-name>([^<]+)<\/command-name>/);
        if (cmd) { stat.commands++; bump(stat.cmds, cmd[1].trim()); continue; }
        if (/\[Request interrupted/.test(text)) { stat.interrupts++; continue; }
        // ローカルコマンドの出力やリマインダは人間の発話ではない
        if (/^<(local-command|command-message|system-reminder)/.test(text.trim())) continue;
        stat.userMsgs++;
        stat.userChars += text.length;
        stat.msgLens.push(text.length);
      } else if (o.type === 'assistant' && o.message) {
        // サブエージェントのターンは委譲先の作業なので、メインの「1送信あたり何ターン
        // 回したか」やツールの偏りには混ぜない。ただし時間軸には含める(委譲が走っている
        // 間も作業時間ではある)。コストは合算しないと総額が実態より小さく出る。
        if (!isSub) {
          stat.assistantTurns++;
          const u = o.message.usage;
          if (u) {
            s.mainTurns++;
            s.maxCtx = Math.max(s.maxCtx, ctxLen(u));
            const c = cost(o.message.model, u);
            s.cost += c;
            stat.totalCost += c;
            bump(stat.models, String(o.message.model || 'unknown'), 1);
          }
          if (Array.isArray(o.message.content)) {
            for (const x of o.message.content) {
              if (x.type !== 'tool_use') continue;
              stat.toolUses++;
              bump(stat.tools, x.name);
              if (x.name === 'Skill' && x.input && x.input.skill) bump(stat.skills, x.input.skill);
              if ((x.name === 'Task' || x.name === 'Agent') && x.input) {
                bump(stat.agents, x.input.subagent_type || '(default)');
              }
            }
          }
        } else {
          const u = o.message.usage;
          if (u) {
            const c = cost(o.message.model, u);
            s.cost += c; stat.totalCost += c; stat.subCost += c; stat.subTurns++;
            bump(stat.models, String(o.message.model || 'unknown'), 1);
          }
          if (Array.isArray(o.message.content)) {
            for (const x of o.message.content) {
              if (x.type !== 'tool_use') continue;
              stat.subToolUses++;
              bump(stat.subTools, x.name);
            }
          }
        }
      }
    }
  }

  if (!stat.events.length) {
    console.error(`対象期間(${new Date(since).toLocaleDateString('ja-JP')} 以降)の transcript がありません。`);
    process.exit(1);
  }
  stat.events.sort((a, b) => a - b);

  // --- 集計 ---
  const days = [];
  // 期間は「since から今日まで」で固定する。最後のイベントで打ち切ると、末尾の無操作日だけが
  // 落ちて先頭の無操作日は残る非対称になり、同じ作業量でも窓のどこに寄っているかで
  // perDay が倍近く変わる(--days 30 で最初の週だけ働いた場合と最後の週だけの場合)。
  const nDays = Math.round((startOfDay(now) - startOfDay(since)) / 86400000) + 1;
  // stat.events は昇順なので、日ごとに filter せず索引を進めて 1 パスで切る
  // (--since を古く取ると日数×イベント数の全走査になり、これが支配的になる)。
  let ei = 0;
  for (let i = 0; i < nDays; i++) {
    const d0 = startOfDay(since) + i * 86400000;
    const d1 = d0 + 86400000;
    const seg = [];
    while (ei < stat.events.length && stat.events[ei] < d1) {
      if (stat.events[ei] >= d0) seg.push(stat.events[ei]);
      ei++;
    }
    // 日をまたぐ作業は日付境界で切る。前日の最後のイベントとの間隔は繰り越さない
    // (繰り越すと徹夜が翌日の 0 時台に数時間まとめて計上され、実態とずれる)。
    const a = activeMinutes(seg, opt.gap);
    days.push({
      day: dayKey(d0), dow: new Date(d0).getDay(),
      hours: a.minutes / 60, blocks: a.blocks, events: seg.length,
      first: seg.length ? seg[0] : null, last: seg.length ? seg[seg.length - 1] : null,
    });
  }

  const sweep = GAP_SWEEP.map(g => {
    const a = activeMinutes(stat.events, g);
    return { gap: g, hours: a.minutes / 60, blocks: a.blocks };
  });
  const totalHours = activeMinutes(stat.events, opt.gap).minutes / 60;

  const projects = [...stat.perProject].map(([name, list]) => {
    list.sort((a, b) => a - b);
    const a = activeMinutes(list, opt.gap);
    return { name, hours: a.minutes / 60, events: list.length };
  }).sort((a, b) => b.hours - a.hours);
  // プロジェクト別の合計は実時間を超える。超過分がそのまま「並行して進めた度合い」になる。
  const projectSum = projects.reduce((a, p) => a + p.hours, 0);

  // 長時間ブロック: 区間の実時間と、その中の最大の間隔
  const longBlocks = [];
  {
    let cur = null, prev = null;
    for (const t of stat.events) {
      if (prev === null || t - prev > opt.gap * 60000) {
        cur = { start: t, end: t, events: 0, maxGap: 0 };
        longBlocks.push(cur);
      } else if (t - prev > cur.maxGap) cur.maxGap = t - prev;
      cur.end = t; cur.events++;
      prev = t;
    }
  }
  longBlocks.sort((a, b) => (b.end - b.start) - (a.end - a.start));

  const sessions = [...stat.sessions.values()].filter(s => s.mainTurns > 0);
  const med = arr => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const ctxBuckets = [
    ['〜50K', 0, 50e3], ['50K〜150K', 50e3, 150e3],
    ['150K〜250K', 150e3, 250e3], ['250K〜', 250e3, Infinity],
  ].map(([label, lo, hi]) => ({ label, count: sessions.filter(s => s.maxCtx >= lo && s.maxCtx < hi).length }));

  const top = (m, n = 30) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ name: k, count: v }));
  const agentTotal = [...stat.agents.values()].reduce((a, c) => a + c, 0);
  // 人間が Enter を押した回数。文章もスラッシュコマンドも 1 送信として同じに数える。
  const sends = stat.userMsgs + stat.commands;

  const result = {
    period: {
      since: new Date(since).toISOString(), first: new Date(stat.firstTs).toISOString(),
      last: new Date(stat.lastTs).toISOString(), days: nDays,
      activeDays: days.filter(d => d.events > 0).length,
      gapMinutes: opt.gap,
    },
    time: {
      totalHours, perDay: totalHours / nDays,
      perActiveDay: totalHours / Math.max(1, days.filter(d => d.events > 0).length),
      sweep, days, hours: stat.hours,
      longestBlocks: longBlocks.slice(0, 8).map(b => ({
        start: new Date(b.start).toISOString(), end: new Date(b.end).toISOString(),
        hours: (b.end - b.start) / 3600000, events: b.events, maxGapMin: b.maxGap / 60000,
      })),
    },
    projects, projectSum, concurrency: projectSum / totalHours,
    input: {
      sends, userMsgs: stat.userMsgs, commands: stat.commands, interrupts: stat.interrupts,
      // 文字数は「打った文章」の話なので、本文を持たないスラッシュコマンドは分母に入れない。
      medianChars: med(stat.msgLens), meanChars: stat.userChars / Math.max(1, stat.userMsgs),
      maxChars: Math.max(...stat.msgLens, 0),
      // 「1送信あたり」の分子はスラッシュコマンドが起こしたターン・ツールも含むので、
      // 分母もコマンドを数える。文章だけを分母にすると、コマンドの比率のぶん過大に出る
      // (実データで 22% 上振れした)。
      toolsPerMsg: stat.toolUses / Math.max(1, sends),
      turnsPerMsg: stat.assistantTurns / Math.max(1, sends),
    },
    tools: { total: stat.toolUses, top: top(stat.tools) },
    delegation: {
      total: agentTotal, byType: top(stat.agents),
      ratioOfMsgs: agentTotal / Math.max(1, sends),
      subTurns: stat.subTurns, subToolUses: stat.subToolUses, subCost: stat.subCost,
      subTools: top(stat.subTools, 10),
      // 委譲したツール実行が全体の何割か。メインの文脈を太らせずに済んだ分の目安。
      offloadRatio: stat.subToolUses / Math.max(1, stat.toolUses + stat.subToolUses),
      costRatio: stat.subCost / Math.max(1e-9, stat.totalCost),
    },
    skills: top(stat.skills), commands: top(stat.cmds, 20), models: top(stat.models),
    sessions: {
      count: sessions.length,
      medianTurns: med(sessions.map(s => s.mainTurns)),
      maxTurns: Math.max(...sessions.map(s => s.mainTurns), 0),
      medianDurationMin: med(sessions.map(s => (s.last - s.first) / 60000)),
      medianMaxCtx: med(sessions.map(s => s.maxCtx)),
      ctxBuckets,
    },
    cost: stat.totalCost,
  };

  if (opt.json) {
    console.log(JSON.stringify(result, null, 2));
    warnUnknownModels();
    return;
  }

  // --- 表示 ---
  const wd = ['日', '月', '火', '水', '木', '金', '土'];
  const hhmm = t => t === null ? '--:--' : new Date(t).toTimeString().slice(0, 5);
  const f1 = n => n.toFixed(1);

  // 集計の窓(since〜今日)と、その中で実際に記録があった範囲は別物。perDay は前者で割るので、
  // 「14日と出ているのに記録は 9 日ぶんしかない」ことが読み手に分かるよう両方を出す。
  console.log(`期間: ${new Date(since).toLocaleDateString('ja-JP')} 〜 ${new Date(now).toLocaleDateString('ja-JP')}`
    + `  (${nDays}日, ギャップ ${opt.gap} 分で区切り)`);
  console.log(`記録: ${new Date(stat.firstTs).toLocaleString('ja-JP')} 〜 ${new Date(stat.lastTs).toLocaleString('ja-JP')}`);
  console.log(`作業時間 ${f1(totalHours)}h  稼働日 ${result.period.activeDays}/${nDays}日  `
    + `1稼働日あたり ${f1(result.time.perActiveDay)}h  換算コスト $${stat.totalCost.toFixed(0)}`);

  console.log('\n--- ギャップ閾値ごとの作業時間(推定の振れ幅) ---');
  for (const s of sweep) console.log(`gap=${String(s.gap).padStart(2)}分  ${f1(s.hours).padStart(6)}h  ブロック ${s.blocks}`);

  console.log('\n--- 日別 ---');
  console.log('日付  曜   作業h  ブロック  イベント  最初   最後');
  for (const d of days) {
    console.log(`${d.day} ${wd[d.dow]}  ${f1(d.hours).padStart(5)}  ${String(d.blocks).padStart(8)}`
      + `  ${String(d.events).padStart(8)}  ${hhmm(d.first)}  ${hhmm(d.last)}  `
      + '█'.repeat(Math.round(d.hours * 2)));
  }

  console.log('\n--- 時間帯分布(イベント数) ---');
  const maxH = Math.max(...stat.hours);
  for (let h = 0; h < 24; h++) {
    console.log(`${String(h).padStart(2, '0')}時 ${String(stat.hours[h]).padStart(6)} `
      + '#'.repeat(maxH ? Math.round(stat.hours[h] / maxH * 40) : 0));
  }

  console.log('\n--- 長時間ブロック上位 ---');
  for (const b of result.time.longestBlocks) {
    const s = new Date(b.start), e = new Date(b.end);
    console.log(`${s.toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
      + ` → ${e.toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`
      + `  ${f1(b.hours)}h  イベント ${b.events}  最大の間隔 ${b.maxGapMin.toFixed(0)}分`);
  }

  console.log('\n--- プロジェクト別 ---');
  for (const p of projects) {
    if (p.hours < 0.2) continue;
    console.log(`${p.name.slice(0, 36).padEnd(37)} ${f1(p.hours).padStart(6)}h  イベント ${p.events}`);
  }
  console.log(`プロジェクト別の合計 ${f1(projectSum)}h / 実時間 ${f1(totalHours)}h = 並行度 ${result.concurrency.toFixed(2)}`);

  console.log('\n--- 入力の癖 ---');
  console.log(`送信 ${sends} 回(文章 ${stat.userMsgs} / スラッシュコマンド ${stat.commands})  中断 ${stat.interrupts} 回`
    + ` (送信の ${(stat.interrupts / Math.max(1, sends) * 100).toFixed(1)}%)`);
  console.log(`1メッセージ 中央値 ${result.input.medianChars} 文字 / 平均 ${result.input.meanChars.toFixed(0)} 文字 / 最長 ${result.input.maxChars} 文字`);
  console.log(`1送信あたり ツール ${result.input.toolsPerMsg.toFixed(1)} 回 / 応答 ${result.input.turnsPerMsg.toFixed(1)} ターン`);

  console.log(`\n--- ツール ${stat.toolUses} 回の内訳 ---`);
  for (const t of result.tools.top) {
    console.log(`${t.name.padEnd(20)} ${String(t.count).padStart(6)}  ${(t.count / stat.toolUses * 100).toFixed(1)}%`);
  }

  console.log(`\n--- 委譲 ${agentTotal} 回(送信の ${(result.delegation.ratioOfMsgs * 100).toFixed(0)}%) ---`);
  for (const a of result.delegation.byType) console.log(`  ${a.name.padEnd(22)} ${a.count}`);
  console.log(`サブエージェント側: ${stat.subTurns} ターン / ツール ${stat.subToolUses} 回 / $${stat.subCost.toFixed(0)}`
    + `  → ツール実行の ${(result.delegation.offloadRatio * 100).toFixed(0)}% ・ コストの ${(result.delegation.costRatio * 100).toFixed(0)}% を肩代わり`);
  console.log('  サブ側のツール: ' + result.delegation.subTools.map(t => `${t.name}:${t.count}`).join(' '));

  console.log('\n--- スキル / スラッシュコマンド ---');
  for (const s of result.skills) console.log(`  skill  ${s.name.padEnd(24)} ${s.count}`);
  for (const c of result.commands) console.log(`  cmd    ${c.name.padEnd(24)} ${c.count}`);

  console.log('\n--- セッション ---');
  console.log(`本数 ${result.sessions.count}  ターン中央値 ${result.sessions.medianTurns} (最大 ${result.sessions.maxTurns})`
    + `  経過時間中央値 ${result.sessions.medianDurationMin.toFixed(0)}分`);
  console.log(`到達コンテキストの中央値 ${Math.round(result.sessions.medianMaxCtx / 1000)}K`);
  for (const b of ctxBuckets) console.log(`  ${b.label.padEnd(12)} ${b.count} 本`);

  warnUnknownModels();
})();
