'use strict';
// トランスクリプトから「どのモデル・どの層」でトークンを使っているかを集計する。
// 委譲やモデル切り替えで削減しうる上限を見積もるのが目的。
const { modelKey, transcriptFiles, records, isNonInteractive, makeNonInteractiveFilter, makeUsageCollector } = require('./lib');

const agg = new Map();       // key: model|layer
const toolChars = new Map(); // ツール名 → tool_result の総文字数(委譲候補の目安)
let minT = null, maxT = null;

function bump(key, u) {
  if (!agg.has(key)) agg.set(key, { n: 0, in: 0, cc: 0, cr: 0, out: 0 });
  const a = agg.get(key);
  a.n++;
  a.in += u.input_tokens || 0;
  a.cc += u.cache_creation_input_tokens || 0;
  a.cr += u.cache_read_input_tokens || 0;
  a.out += u.output_tokens || 0;
}

(async () => {
  const files = transcriptFiles();
  // 非対話実行(claude -p / SDK)は集計から外す。判定は lib.js に集約してある。
  const nonInteractiveFile = makeNonInteractiveFilter();
  let sdkSessions = 0, sdkRecords = 0, skippedFiles = 0;
  for (const f of files) {
    const sdk = nonInteractiveFile(f);
    if (sdk) { skippedFiles++; if (sdk === 'session') sdkSessions++; continue; }
    // 分割された同一応答の二重計上を防ぐ(規則と実測は lib.js の makeUsageCollector を参照)。
    // トークン内訳も usage 由来なので、除かないと req もトークン数も約 1.9 倍で出る。
    const usages = makeUsageCollector();
    // tool_result 側にツール名は入っていないので、直前の assistant の tool_use から
    // id → 名前を覚えておいて引く。対応表をファイル単位で捨てるのは、id が一意なのは
    // セッション内で十分であり、全ファイル分を抱えるとメモリが伸び続けるため。
    const toolName = new Map();

    for await (const o of records(f)) {
      // セッション単位の判定を抜けた個別レコードの保険。期間(minT/maxT)にも入れない。
      if (isNonInteractive(o)) { sdkRecords++; continue; }
      if (o.timestamp) {
        if (!minT || o.timestamp < minT) minT = o.timestamp;
        if (!maxT || o.timestamp > maxT) maxT = o.timestamp;
      }

      // アシスタント応答の usage は収集器に預け、読み終えてから応答ごとに 1 回だけ足す。
      // tool_use の対応表(下)はブロックごとに別物なので、こちらに通してはいけない。
      if (o.type === 'assistant') usages.add(o);
      if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
        for (const c of o.message.content) {
          if (c.type === 'tool_use' && c.id) toolName.set(c.id, c.name || 'unknown');
        }
      }

      // ユーザー側の tool_result のサイズ = 「外から流し込まれた情報量」
      if (o.type === 'user' && o.message && Array.isArray(o.message.content)) {
        for (const c of o.message.content) {
          if (c.type !== 'tool_result') continue;
          const s = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
          const name = toolName.get(c.tool_use_id) || 'unknown';
          toolChars.set(name, (toolChars.get(name) || 0) + s.length);
        }
      }
    }
    for (const { usage, model, isSub } of usages.entries()) {
      bump(`${modelKey(model)}|${isSub ? 'subagent' : 'main'}`, usage);
    }
  }

  // 集計に使った本数を出す(走査した全本数ではない)。除外の内訳を添えないと、
  // 数が減った理由が集計の変更なのか使い方の変化なのか読み手に分からない。
  console.log(`ファイル数: ${files.length - skippedFiles}`);
  if (sdkSessions || sdkRecords) {
    const excluded = [`セッション ${sdkSessions} 本`];
    if (sdkRecords) excluded.push(`単独レコード ${sdkRecords} 件`);
    console.log(`(非対話実行 claude -p の${excluded.join(' / ')}は集計から除外)`);
  }
  console.log(`期間: ${minT} 〜 ${maxT}\n`);

  const rows = [...agg.entries()].sort((a, b) => b[1].out - a[1].out);
  console.log('model               layer      req      output      input   cache_cr   cache_read');
  let tot = { out: 0, in: 0, cc: 0, cr: 0 };
  for (const [k, a] of rows) {
    const [m, l] = k.split('|');
    console.log(
      m.padEnd(20) + l.padEnd(10) +
      String(a.n).padStart(5) + String(a.out).padStart(12) +
      String(a.in).padStart(11) + String(a.cc).padStart(11) + String(a.cr).padStart(13)
    );
    tot.out += a.out; tot.in += a.in; tot.cc += a.cc; tot.cr += a.cr;
  }
  console.log('\n合計 output=' + tot.out + ' input=' + tot.in + ' cache_creation=' + tot.cc + ' cache_read=' + tot.cr);

  console.log('\n--- tool_result の総量(ツール別・文字数, 上位) ---');
  const tb = [...toolChars.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const [k, v] of tb) console.log(k.padEnd(24) + (v / 1000).toFixed(0).padStart(10) + ' K chars');
})();
