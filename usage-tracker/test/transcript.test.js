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

// .tmp 直下ではなく自分専用のサブディレクトリを使う(account-guard / claude-worklog と同じ規約)。
// guard.test.js が同じ .tmp を使うので、直下を消すと他スイートのサンドボックスを実行中に
// 巻き添えで消す(account-guard/test/account-guard.test.js:15-18 が記録した事故と同型)。
const BASE = path.join(__dirname, '.tmp', 'transcript');
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
function run(script, home, args = []) {
  const env = { ...process.env, USERPROFILE: home, HOME: home, NO_COLOR: '1' };
  // 孤児プロセスが残る事故(issue #8)の検出網として timeout を掛ける。stdin は既に
  // 'ignore' で閉じているのでこのスクリプト自体がハングする経路は無いはずだが、
  // 念のための保険。
  const timeout = 30000;
  try {
    const out = execFileSync(process.execPath, [path.join(TRANSCRIPT, script), ...args], {
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
      // stderr は末尾 3 行だけ添える(全部出すと ENOBUFS で ~1MB がログに流れる)。
      // cause で stdout を含む元の例外を残す(issue #8 の原因究明の材料にするため)。
      const tail = (e.stderr || '').trim().split('\n').slice(-3).join('\n');
      const msg = `子プロセスが${why}: ${script}`;
      throw new Error(tail ? `${msg}\n  stderr(末尾): ${tail}` : msg, { cause: e });
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

// ---- サブエージェントの transcript を人間の操作と混ぜない ----
// サブエージェントのログは projects/<プロジェクト>/<親セッションID>/subagents/agent-*.jsonl
// に置かれる。ディレクトリ名をそのままプロジェクト名にすると "subagents" という架空の
// プロジェクトが生まれ、さらにサブエージェントへの指示文が「自分の送信」として数えられて
// 送信回数が実際より多く見える(実際に一度そう出した)。
console.log('\nhabits.js');
const homeH = sandbox('habits');
const at = hhmm => `2026-01-01T${hhmm}:00.000Z`;
const aTurn = (time, content) => ({
  type: 'assistant', timestamp: at(time), isSidechain: false,
  message: { model: 'claude-opus-5', usage: usage({ input_tokens: 10, output_tokens: 5 }), content },
});
const uTurn = (time, text) => ({ type: 'user', timestamp: at(time), message: { content: text } });
const SID = 'cccccccc-0000-0000-0000-000000000001';

// メイン: 送信 1 回・ツール 2 回。20 分間隔を空けて 0.2h の表示閾値を超えさせる
writeTranscript(homeH, 'proj', SID, [
  uTurn('00:00', '調べて直して'),
  aTurn('00:10', [{ type: 'tool_use', id: 'm1', name: 'Agent', input: { subagent_type: 'sonnet-explorer' } }]),
  aTurn('00:20', [{ type: 'tool_use', id: 'm2', name: 'Edit', input: {} }]),
]);
// サブ: 指示文(user)1 件とツール 2 回。指示文は人間の送信ではない。
// 時刻を散らして 0.2h(プロジェクト一覧の表示閾値)を超えさせる — 短いと帰属を
// 間違えても一覧から消えるだけになり、テストが素通りする。
writeTranscript(homeH, path.join('proj', SID, 'subagents'), 'agent-abc123', [
  uTurn('00:11', 'この関数の呼び出し元を全部挙げて'),
  aTurn('00:25', [{ type: 'tool_use', id: 's1', name: 'Read', input: {} }]),
  aTurn('00:40', [{ type: 'tool_use', id: 's2', name: 'Grep', input: {} }]),
]);
const hb = run('habits.js', homeH, ['--since', '2026-01-01']);
check('habits.js が正常終了する', hb.code === 0, hb.err);
check('サブエージェントへの指示を自分の送信として数えない', /送信 1 回/.test(hb.out), hb.out);
check('"subagents" が架空のプロジェクトとして現れない', !/^subagents\s/m.test(hb.out), hb.out);
// 親に合流していれば 00:00〜00:40 の 0.6h 台。合流に失敗すると proj は 0.3h に縮む
check('サブの作業が親プロジェクトに帰属する', /^proj\s+0\.[67]h/m.test(hb.out), hb.out);
check('委譲が担ったツール実行を数える(サブ 2 / 全 4 = 50%)',
  /ツール 2 回/.test(hb.out) && /ツール実行の 50%/.test(hb.out), hb.out);
check('委譲先の種別を集計する', /sonnet-explorer\s+1/.test(hb.out), hb.out);

// 作業時間は無操作の空白で切る。既定 15 分に対し 2 時間空ければ別ブロックになる
writeTranscript(homeH, 'proj2', 'cccccccc-0000-0000-0000-000000000002', [
  uTurn('02:00', '別の作業'),
  aTurn('02:01', [{ type: 'tool_use', id: 'x1', name: 'Bash', input: {} }]),
]);
const hb2 = run('habits.js', homeH, ['--since', '2026-01-01']);
check('離れた時刻の操作を1つの区間に繋げない', /gap=15分\s+0\.\d+h\s+ブロック 2/.test(hb2.out), hb2.out);

const hbj = run('habits.js', homeH, ['--since', '2026-01-01', '--json']);
let parsed = null;
try { parsed = JSON.parse(hbj.out); } catch (e) { parsed = null; }
check('--json が機械可読な集計を返す',
  parsed && parsed.input.userMsgs === 2 && parsed.delegation.subToolUses === 2,
  parsed ? JSON.stringify(parsed.input) : hbj.out.slice(0, 200));

// ---- transcript が無い環境 ----
console.log('\ntranscript が無い場合');
const homeC = path.join(BASE, 'empty');
fs.mkdirSync(homeC, { recursive: true });
const miss = run('turncost.js', homeC);
check('探した場所を示して非 0 で終わる',
  miss.code === 1 && miss.err.includes(path.join(homeC, '.claude', 'projects')), `code=${miss.code} err=${miss.err}`);

console.log(`\n  ${state.pass} PASS / ${state.fail} FAIL`);
process.exitCode = state.fail ? 1 : 0;
