'use strict';
// トランスクリプトから「どのモデル・どの層」でトークンを使っているかを集計する。
// ローカルLLMへ委譲した場合に削減しうる上限を見積もるのが目的。
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(process.env.USERPROFILE, '.claude', 'projects');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const agg = new Map(); // key: model|layer
const toolBytes = new Map(); // tool_result の生バイト量(委譲候補の目安)
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
  const files = walk(ROOT);
  for (const f of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(f), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }

      if (o.timestamp) {
        if (!minT || o.timestamp < minT) minT = o.timestamp;
        if (!maxT || o.timestamp > maxT) maxT = o.timestamp;
      }

      // アシスタント応答の usage を集計
      const u = o.message && o.message.usage;
      if (o.type === 'assistant' && u) {
        const model = (o.message.model || 'unknown').replace('claude-', '');
        const layer = o.isSidechain ? 'subagent' : 'main';
        bump(`${model}|${layer}`, u);
      }

      // ユーザー側の tool_result のサイズ = 「外から流し込まれた情報量」
      if (o.type === 'user' && o.message && Array.isArray(o.message.content)) {
        for (const c of o.message.content) {
          if (c.type === 'tool_result') {
            const s = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
            const name = o.toolUseResult && o.toolUseResult.type ? o.toolUseResult.type : 'result';
            toolBytes.set(name, (toolBytes.get(name) || 0) + s.length);
          }
        }
      }
    }
  }

  console.log(`ファイル数: ${files.length}`);
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

  console.log('\n--- tool_result の総量(文字数, 上位) ---');
  const tb = [...toolBytes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const [k, v] of tb) console.log(k.padEnd(24) + (v / 1000).toFixed(0).padStart(10) + ' K chars');
})();
