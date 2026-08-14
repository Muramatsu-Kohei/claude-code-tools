'use strict';
// transcript/ 配下の集計スクリプトの回帰テスト。
// 主眼は「コンテキスト長をどう数えるか」で、cache_read だけを見ていた頃はキャッシュ
// 再作成ターン(同じ量が cache_creation 側に乗る)が最小の帯に誤分類され、単価の倍率が
// 実際より小さく出ていた。同じ総長で内訳だけ違う2ターンが同じ帯に入ることを確かめる。
//
// 偽 HOME を作って USERPROFILE を差し替えるので、実際の ~/.claude/projects は読まない。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('../transcript/lib');

const BASE = path.join(__dirname, '.tmp');
const TRANSCRIPT = path.join(__dirname, '..', 'transcript');
fs.rmSync(BASE, { recursive: true, force: true });

const state = { pass: 0, fail: 0 };
// extra は失敗時の手掛かり。落ちた行だけでは原因が分からないことが多いので実出力を添える
function check(label, cond, extra) {
  if (cond) state.pass++; else state.fail++;
  const tail = extra && !cond ? `\n      ${String(extra).replace(/\n/g, '\n      ')}` : '';
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}${tail}`);
}

function sandbox(name) {
  const home = path.join(BASE, name);
  fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  return home;
}

function writeTranscript(home, project, id, recs) {
  const dir = path.join(home, '.claude', 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), recs.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

// 偽 HOME を向けてスクリプトを実行する。非 0 終了も検証対象なので投げずに返す
function run(script, home) {
  const env = { ...process.env, USERPROFILE: home, HOME: home, NO_COLOR: '1' };
  // 孤児プロセスが残る事故(issue #8)の検出網として timeout を掛ける。stdin は既に
  // 'ignore' で閉じているのでこのスクリプト自体がハングする経路は無いはずだが、
  // 念のための保険。
  const timeout = 30000;
  try {
    const out = execFileSync(process.execPath, [path.join(TRANSCRIPT, script)], {
      encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      timeout, killSignal: 'SIGKILL',
    });
    return { code: 0, out, err: '' };
  } catch (e) {
    // 終了ステータスが無いまま死んだ場合(e.status が null / undefined)は、呼び出し側の
    // 「非ゼロ終了 = 想定どおり失敗した」という判定に混ぜてはいけない。timeout(ETIMEDOUT)
    // のほかに maxBuffer 超過(ENOBUFS)・外部や OOM による kill も同じ形で来るので、
    // code ではなく status の有無で判別する。ここで -1 に潰すと基盤の異常が
    // PASS として集計される。
    if (e.status == null) {
      const why = e.code === 'ETIMEDOUT'
        ? `timeout(${timeout}ms)で強制終了された`
        : `終了コードを残さずに落ちた(code=${e.code || '不明'} signal=${e.signal || 'なし'})`;
      throw new Error(`子プロセスが${why}: ${script}`);
    }
    return { code: e.status, out: e.stdout || '', err: e.stderr || '' };
  }
}

const usage = (o = {}) => ({
  input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, ...o,
});
const assistant = (u, content) => ({
  type: 'assistant', timestamp: '2026-01-01T00:00:00.000Z', isSidechain: false,
  message: { model: 'claude-opus-5', usage: u, ...(content ? { content } : {}) },
});

// ---- 単価換算とコンテキスト長の計算 ----
console.log('cost / ctxLen');
check('ctxLen は input + cache_creation + cache_read の和',
  lib.ctxLen(usage({ input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 4 })) === 7);
check('ctxLen は usage 無しを 0 として扱う', lib.ctxLen(undefined) === 0);
check('ctxLen は cache_read だけの回帰(内訳が偏っても総長は変わらない)',
  lib.ctxLen(usage({ cache_read_input_tokens: 210e3 })) === lib.ctxLen(usage({ cache_creation_input_tokens: 210e3 })));

// opus-5 は in=$5/MTok, out=$25/MTok。cache_creation=1.25x, cache_read=0.1x
check('input は定価どおり', lib.cost('claude-opus-5', usage({ input_tokens: 1e6 })) === 5);
check('output は定価どおり', lib.cost('claude-opus-5', usage({ output_tokens: 1e6 })) === 25);
check('cache_creation は 1.25 倍', lib.cost('claude-opus-5', usage({ cache_creation_input_tokens: 1e6 })) === 6.25);
check('cache_read は 0.1 倍', lib.cost('claude-opus-5', usage({ cache_read_input_tokens: 1e6 })) === 0.5);
check('欠損フィールドは 0 扱い', lib.cost('claude-opus-5', {}) === 0);

// 単価表に無いモデルは $0 になるが、課金対象でないものと新モデルは区別する
function captureWarn() {
  const orig = console.error;
  let buf = '';
  console.error = (...a) => { buf += a.join(' ') + '\n'; };
  try { lib.warnUnknownModels(); } finally { console.error = orig; }
  return buf;
}
check('<synthetic> は $0 かつ警告しない',
  lib.cost('<synthetic>', usage({ input_tokens: 1e6 })) === 0 && captureWarn() === '');
lib.cost('claude-madeup-9', usage({ input_tokens: 1e6 }));
const warned = captureWarn();
check('単価表に無いモデルは名前と件数を警告する', /madeup-9\(1件\)/.test(warned), warned);

// ---- コンテキスト長の帯域分類(指摘の本体) ----
console.log('\nturncost.js');
const homeA = sandbox('bucket');
writeTranscript(homeA, 'proj', 'aaaaaaaa-0000-0000-0000-000000000001', [
  // 総プロンプト長は同じ 210,010。片方は全部キャッシュ読み、もう片方は全部キャッシュ作成
  assistant(usage({ input_tokens: 10, cache_read_input_tokens: 210e3, output_tokens: 100 })),
  assistant(usage({ input_tokens: 10, cache_creation_input_tokens: 210e3, output_tokens: 100 })),
]);
const tc = run('turncost.js', homeA);
check('turncost.js が正常終了する', tc.code === 0, tc.err);
check('内訳の違う2ターンが同じ 200〜300K 帯に入る', /^200〜300K\s+2\s/m.test(tc.out), tc.out);
check('キャッシュ作成ターンが 〜30K 帯に落ちない', !/^〜30K/m.test(tc.out), tc.out);
check('基準帯が空でも倍率欄が壊れない(- を出す)', !/NaN|Infinity/.test(tc.out), tc.out);

// ---- tool_result をツール名で集計できているか ----
console.log('\nbreakdown.js');
writeTranscript(homeA, 'proj', 'aaaaaaaa-0000-0000-0000-000000000002', [
  assistant(usage({ input_tokens: 10, output_tokens: 10 }), [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
  { type: 'user', timestamp: '2026-01-01T00:00:01.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(2000) }] } },
]);
const bd = run('breakdown.js', homeA);
check('breakdown.js が正常終了する', bd.code === 0, bd.err);
check('tool_result が結果種別ではなくツール名で集計される', /^Read\s+2 K chars/m.test(bd.out), bd.out);
check('id を引けたものが unknown に落ちない', !/^unknown\s+\d+ K chars/m.test(bd.out), bd.out);

// ---- 委譲率の分母が 0 のとき ----
console.log('\nsessions.js');
const homeB = sandbox('notools');
writeTranscript(homeB, 'proj', 'bbbbbbbb-0000-0000-0000-000000000001', [
  assistant(usage({ input_tokens: 10, cache_read_input_tokens: 40e3, output_tokens: 10 })),
]);
const ss = run('sessions.js', homeB);
check('sessions.js が正常終了する', ss.code === 0, ss.err);
check('対象ツールが 0 回でも委譲率が NaN にならない', /委譲率 -/.test(ss.out) && !/NaN/.test(ss.out), ss.out);

// ---- transcript が無い環境 ----
console.log('\ntranscript が無い場合');
const homeC = path.join(BASE, 'empty');
fs.mkdirSync(homeC, { recursive: true });
const miss = run('turncost.js', homeC);
check('探した場所を示して非 0 で終わる',
  miss.code === 1 && miss.err.includes(path.join(homeC, '.claude', 'projects')), `code=${miss.code} err=${miss.err}`);

console.log(`\n  ${state.pass} PASS / ${state.fail} FAIL`);
process.exitCode = state.fail ? 1 : 0;
