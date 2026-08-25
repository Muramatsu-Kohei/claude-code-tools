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
function run(script, home, args = [], extraEnv = {}) {
  const env = { ...process.env, USERPROFILE: home, HOME: home, NO_COLOR: '1', ...extraEnv };
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
// agent-abc123 は s1/s2 の2レコードを持つ。1ファイル=1本のはずで、レコードごとに
// 数えると2本になってしまう(subAgentRuns はファイル内で最初のレコードを見た時点で
// 1回だけ加算する実装なので、2レコードでも 1 のままであるべき)。
check('複数レコードを持つサブエージェントも1本と数える',
  parsed && parsed.delegation.runs === 1,
  parsed ? JSON.stringify(parsed.delegation) : hbj.out.slice(0, 200));

// ---- 数値引数の検証 ----
// Number() を素通しすると NaN が下流の比較を常に false にし、エラーにならないまま
// 誤った集計が出る(--gap x で全イベントが 1 ブロックに繋がり、作業時間が実時間になった)。
const badGap = run('habits.js', homeH, ['--since', '2026-01-01', '--gap', 'x']);
check('不正な --gap は集計せず非 0 で終わる',
  badGap.code === 2 && !/作業時間/.test(badGap.out), `code=${badGap.code} out=${badGap.out.slice(0, 120)}`);
const noVal = run('habits.js', homeH, ['--days']);
check('値の無い --days を弾く', noVal.code === 2, `code=${noVal.code} err=${noVal.err.slice(0, 120)}`);
const badSince = run('habits.js', homeH, ['--since', '2026-1-1']);
check('形式の崩れた --since を弾く', badSince.code === 2, `code=${badSince.code} err=${badSince.err.slice(0, 120)}`);
// '2026-02-30' は Invalid Date にならず 3/2 へ繰り上がるので、Invalid の有無では捕まらない。
// 弾き損ねると 2 月末からのつもりで 3 月からの数字を読むことになる。
const rollover = run('habits.js', homeH, ['--since', '2026-02-30']);
check('存在しない日付の --since を弾く(黙って翌月に繰り上げない)',
  rollover.code === 2, `code=${rollover.code} out=${rollover.out.slice(0, 120)}`);
// 上限が無いと since が Date の表現範囲を外れ、使い方エラーではなく RangeError で落ちる。
const hugeDays = run('habits.js', homeH, ['--days', '1e9']);
check('大きすぎる --days は使い方エラーとして弾く',
  hugeDays.code === 2 && !/RangeError/.test(hugeDays.err), `code=${hugeDays.code} err=${hugeDays.err.slice(0, 160)}`);

// ---- スラッシュコマンドも 1 送信として数える ----
// 分子(ターン・ツール)はコマンドが起こした分を含むので、分母から外すとコマンドの
// 比率のぶん「1送信あたり」が過大に出る。
const homeS = sandbox('habits-sends');
writeTranscript(homeS, 'proj', 'cccccccc-0000-0000-0000-000000000004', [
  uTurn('00:00', 'ふつうの送信'),
  aTurn('00:01', [{ type: 'tool_use', id: 'c1', name: 'Bash', input: {} }]),
  uTurn('00:05', '<command-name>/wrap</command-name>'),
  aTurn('00:06', [{ type: 'tool_use', id: 'c2', name: 'Read', input: {} }]),
]);
const hbs = run('habits.js', homeS, ['--since', '2026-01-01', '--json']);
let ps = null;
try { ps = JSON.parse(hbs.out); } catch (e) { ps = null; }
check('スラッシュコマンドも 1 送信として分母に数える',
  ps && ps.input.sends === 2 && ps.input.userMsgs === 1 && ps.input.commands === 1
    && Math.abs(ps.input.turnsPerMsg - 1) < 1e-9 && Math.abs(ps.input.toolsPerMsg - 1) < 1e-9,
  ps ? JSON.stringify(ps.input) : hbs.out.slice(0, 200));

// ---- 配列 content のスラッシュコマンドも commands と送信に数える ----
// 実データのコマンド記録の 59% は <command-message> で始まり、これは INJECTED_HEAD に
// 当たる。配列 content ではブロック単位で先に落ちるため、<command-name> を含む
// ブロックを挿入除外より先に救わないと、コマンドが commands からも送信からも消える。
const homeAC = sandbox('habits-array-cmd');
writeTranscript(homeAC, 'proj', 'cccccccc-0000-0000-0000-00000000000d', [
  {
    type: 'user', timestamp: at('00:00'),
    message: {
      content: [
        { type: 'text', text: '<command-message>wrap is running…</command-message>\n<command-name>/wrap</command-name>' },
      ],
    },
  },
  aTurn('00:01', [{ type: 'tool_use', id: 'ac1', name: 'Bash', input: {} }]),
]);
const hbac = run('habits.js', homeAC, ['--since', '2026-01-01', '--json']);
let pac = null;
try { pac = JSON.parse(hbac.out); } catch (e) { pac = null; }
check('配列 content のスラッシュコマンドも commands と送信に数える',
  pac && pac.input.commands === 1 && pac.input.sends === 1 && pac.commands.some(c => c.name === '/wrap'),
  pac ? `${JSON.stringify(pac.input)} commands=${JSON.stringify(pac.commands)}` : hbac.out.slice(0, 200));

// ---- 期間は since から今日まで ----
// 最後のイベントで打ち切ると末尾の無操作日だけが落ちる非対称になり、同じ作業量でも
// 窓のどこに寄っているかで perDay が倍近く変わる。
const homeD = sandbox('habits-days');
const ago = (d, min = 0) => new Date(Date.now() - d * 86400000 + min * 60000).toISOString();
writeTranscript(homeD, 'proj', 'cccccccc-0000-0000-0000-000000000005', [
  { type: 'user', timestamp: ago(3), message: { content: '3日前の作業' } },
  {
    type: 'assistant', timestamp: ago(3, 10), isSidechain: false,
    message: {
      model: 'claude-opus-5', usage: usage({ input_tokens: 10, output_tokens: 5 }),
      content: [{ type: 'tool_use', id: 'd1', name: 'Bash', input: {} }],
    },
  },
]);
const hbd = run('habits.js', homeD, ['--days', '7', '--json']);
let pd = null;
try { pd = JSON.parse(hbd.out); } catch (e) { pd = null; }
check('--days N の期間は末尾の無操作日を落とさない',
  pd && pd.period.days === 7 && pd.time.days.length === 7,
  pd ? JSON.stringify(pd.period) : hbd.out.slice(0, 200) + hbd.err.slice(0, 200));
check('日別の合計イベント数が全体と一致する',
  pd && pd.time.days.reduce((a, d) => a + d.events, 0) === 2,
  pd ? JSON.stringify(pd.time.days.map(d => d.events)) : '');

// ---- ハーネスが挿入したレコードを人間の送信として数えない ----
// isMeta は content が文字列でも配列でも同じ意味なのに、配列側だけ見落としていたときは
// スキル本文の展開(数十万文字)が「最長のメッセージ」として出ていた。
const homeM = sandbox('habits-meta');
writeTranscript(homeM, 'proj', 'cccccccc-0000-0000-0000-000000000006', [
  uTurn('00:00', 'ふつうの送信'),
  {
    type: 'user', timestamp: at('00:02'), isMeta: true,
    message: { content: [{ type: 'text', text: 'Base directory for this skill: /skills/wrap ' + 'x'.repeat(5000) }] },
  },
  aTurn('00:03', [{ type: 'tool_use', id: 'm9', name: 'Bash', input: {} }]),
]);
const hbm = run('habits.js', homeM, ['--since', '2026-01-01', '--json']);
let pm = null;
try { pm = JSON.parse(hbm.out); } catch (e) { pm = null; }
check('配列 content の isMeta レコードを送信として数えない',
  pm && pm.input.sends === 1 && pm.input.userMsgs === 1 && pm.input.maxChars < 1000,
  pm ? JSON.stringify(pm.input) : hbm.out.slice(0, 200));

// ---- ハーネスが user ロールで挿入する通知・出力を送信として数えない ----
// isMeta が付かない挿入もある(バックグラウンド完了通知・! 実行の記録・compact の継続要約)。
// 実データではこれで送信が 3 割水増しされ、文字数の 9 割が通知由来だった。
// あわせて「本文 + 挿入ブロック」の混在レコードで挿入ぶんの文字数を数えないことも見る。
const homeI = sandbox('habits-injected');
writeTranscript(homeI, 'proj', 'cccccccc-0000-0000-0000-000000000008', [
  uTurn('00:00', 'ふつうの送信'),
  uTurn('00:01', '<task-notification>\n<task-id>abc</task-id>\n' + 'y'.repeat(4000) + '\n</task-notification>'),
  uTurn('00:02', '<bash-stdout>' + 'z'.repeat(3000) + '</bash-stdout>'),
  uTurn('00:03', 'This session is being continued from a previous conversation. ' + 'w'.repeat(3000)),
  {
    type: 'user', timestamp: at('00:04'),
    message: {
      content: [
        { type: 'text', text: 'hi' },
        { type: 'text', text: '<system-reminder>' + 'q'.repeat(2000) + '</system-reminder>' },
      ],
    },
  },
  aTurn('00:05', [{ type: 'tool_use', id: 'i1', name: 'Bash', input: {} }]),
]);
const hbi = run('habits.js', homeI, ['--since', '2026-01-01', '--json']);
let pi = null;
try { pi = JSON.parse(hbi.out); } catch (e) { pi = null; }
check('通知・! 実行の記録・compact 要約を送信として数えない',
  pi && pi.input.sends === 2 && pi.input.userMsgs === 2,
  pi ? JSON.stringify(pi.input) : hbi.out.slice(0, 200));
check('本文に続く挿入ブロックを入力の文字数に数えない',
  pi && pi.input.maxChars === 6, pi ? `maxChars=${pi.input.maxChars}` : hbi.out.slice(0, 200));

// ---- 非対話実行(claude -p / SDK)を集計に入れない ----
// claude-window-keeper の ping がこれ。送信としてだけでなく、ターン・コスト・時間軸からも
// 外れる必要がある(深夜に走るので時間帯分布が歪み、cwd 由来の架空プロジェクトも生む)。
const homeP = sandbox('habits-sdk');
writeTranscript(homeP, 'proj', 'cccccccc-0000-0000-0000-00000000000a', [
  uTurn('00:00', '人間の送信'),
  aTurn('00:01', [{ type: 'tool_use', id: 'p1', name: 'Bash', input: {} }]),
]);
writeTranscript(homeP, 'C--WINDOWS-system32', 'cccccccc-0000-0000-0000-00000000000b', [
  // queue-operation は entrypoint を持たないのに timestamp は持つ。レコード単位の判定だけだと
  // これが残り、時間軸と架空プロジェクト(cwd 由来)に現れる。実データでも 18 件残っていた。
  { type: 'queue-operation', timestamp: at('03:00'), operation: 'add' },
  { ...uTurn('03:00', 'Reply with only the word: ok'), entrypoint: 'sdk-cli', promptSource: 'sdk' },
  { ...aTurn('03:01', [{ type: 'tool_use', id: 'p2', name: 'Bash', input: {} }]), entrypoint: 'sdk-cli' },
]);
// 時間帯の検証があるので TZ を固定する。既定のローカル時刻では at() の UTC 時刻が
// 何時に落ちるかが実行環境で変わり、時間帯のチェックが素通りする。
const hbp = run('habits.js', homeP, ['--since', '2026-01-01', '--json'], { TZ: 'UTC' });
let pp = null;
try { pp = JSON.parse(hbp.out); } catch (e) { pp = null; }
check('非対話実行を送信・ツール・プロジェクトのどれにも数えない',
  pp && pp.input.sends === 1 && pp.tools.total === 1
    && !pp.projects.some(p => p.name === 'C--WINDOWS-system32')
    && pp.period.excludedSdkSessions === 1,
  pp ? `sends=${pp.input.sends} tools=${pp.tools.total} projects=${pp.projects.map(p => p.name)} excludedSessions=${pp.period.excludedSdkSessions}` : hbp.out.slice(0, 200));
check('非対話実行の時刻を作業時間に入れない',
  pp && pp.time.hours[3] === 0, pp ? `hours[3]=${pp.time.hours[3]}` : '');

// ---- 会話本文の文字列で非対話と誤判定しない (lib.js: isNonInteractiveSession) ----
// 先頭 64KB を正規表現で見ていた旧実装は、transcript のレコードを会話に貼り付けただけで
// "entrypoint": "sdk-cli" という文字列に反応し、対話セッションが丸ごと集計から消えていた。
// 行ごとに JSON として解し entrypoint をフィールドとしてのみ見る新実装を、
// lib.js を直接 require して確かめる(habits.js を経由するより直接的)。
// 注意: content がただの文字列だと、貼り付けたテキスト中の引用符は JSON.stringify で
// \" にエスケープされ、生バイト上では旧正規表現も素通りしてしまい再現にならない
// (実測済み)。tool_result の content をオブジェクトのまま埋め込む形にすると、
// ネストした entrypoint フィールドがエスケープなしの生の "entrypoint":"sdk-cli" として
// バイト列に現れ、かつレコード自身の(トップレベルの)entrypoint ではないので、
// 新実装が見るべきものと旧実装が誤反応するものを正しく作り分けられる。
console.log('\nisNonInteractiveSession');
const libDir = path.join(BASE, 'lib-entrypoint');
fs.mkdirSync(libDir, { recursive: true });
const pastedFile = path.join(libDir, 'pasted.jsonl');
fs.writeFileSync(pastedFile, JSON.stringify({
  type: 'user', timestamp: at('00:00'),
  message: {
    content: [{
      type: 'tool_result', tool_use_id: 't1',
      // ネストした値としての entrypoint。トップレベルのフィールドではない。
      content: { note: '貼り付けた transcript レコードの例', entrypoint: 'sdk-cli', other: 'x' },
    }],
  },
}) + '\n', 'utf8');
check('レコード内にネストした "entrypoint":"sdk-cli" という文字列だけでは非対話と判定しない',
  lib.isNonInteractiveSession(pastedFile) === false);
const fieldFile = path.join(libDir, 'field.jsonl');
fs.writeFileSync(fieldFile, JSON.stringify({
  type: 'user', timestamp: at('00:00'), entrypoint: 'sdk-cli',
  message: { content: 'ping' },
}) + '\n', 'utf8');
check('entrypoint がレコードのフィールドにあるセッションは従来どおり非対話と判定する',
  lib.isNonInteractiveSession(fieldFile) === true);
// 先頭レコードが 64KB を超えると読んだ範囲に改行が1つも収まらず、1行も JSON として
// 解せない(parsed === 0)。この分岐は以前「文字列一致にフォールバック」しており、
// 巨大な貼り付けやツール結果を含むレコードほど誤検知しやすい最悪のケースだった。
// 今は false に倒す実装なので、ネストした entrypoint 文字列があっても非対話と判定しない。
const hugeFile = path.join(libDir, 'huge.jsonl');
fs.writeFileSync(hugeFile, JSON.stringify({
  type: 'user', timestamp: at('00:00'),
  message: {
    content: [
      {
        type: 'tool_result', tool_use_id: 't1',
        content: { note: '貼り付けた transcript レコードの例', entrypoint: 'sdk-cli', other: 'x' },
      },
      { type: 'text', text: 'y'.repeat(70000) }, // レコード全体を 64KB 超に押し上げるパディング
    ],
  },
}) + '\n', 'utf8');
check('先頭レコードが64KBを超えるとき、本文中の entrypoint 文字列があっても非対話と判定しない',
  lib.isNonInteractiveSession(hugeFile) === false);
// 書き込み途中の transcript は末尾に改行が無いことがある。ファイル全体が 64KB の窓に
// 収まる場合、無条件に lines.pop() すると唯一の完全なレコードまで捨ててしまい、
// 非対話セッションを取り逃がす。
const noNewlineFile = path.join(libDir, 'no-newline.jsonl');
fs.writeFileSync(noNewlineFile, JSON.stringify({
  type: 'user', timestamp: at('00:00'), entrypoint: 'sdk-cli',
  message: { content: 'ping' },
}), 'utf8'); // 末尾に改行を付けない
check('末尾に改行が無い1レコードだけの transcript でも非対話と判定する',
  lib.isNonInteractiveSession(noNewlineFile) === true);

// ---- 非対話セッションのサブエージェント transcript もファイルごと外す ----
// 親セッション(entrypoint: sdk-cli)を落としても、配下の subagents/agent-*.jsonl を
// 素通りさせると、子には印が付かないぶん統計に残ってしまう。対話セッションのデータも
// 混ぜて集計を空にせず(空だと非0終了する)、除外対象のプロジェクトが結果に一切
// 現れないこと・委譲の本数やツール数がそのぶん増えていないことを確かめる。
console.log('\nhabits.js (非対話セッションの子)');
const homeK = sandbox('habits-sdk-child');
writeTranscript(homeK, 'proj', 'ffffffff-0000-0000-0000-000000000001', [
  uTurn('00:00', '人間の送信'),
  aTurn('00:01', [{ type: 'tool_use', id: 'k1', name: 'Bash', input: {} }]),
]);
const SDKSID = 'ffffffff-0000-0000-0000-000000000002';
writeTranscript(homeK, 'proj2', SDKSID, [
  { ...uTurn('01:00', 'ping'), entrypoint: 'sdk-cli' },
  { ...aTurn('01:01', [{ type: 'tool_use', id: 'k2', name: 'Bash', input: {} }]), entrypoint: 'sdk-cli' },
]);
writeTranscript(homeK, path.join('proj2', SDKSID, 'subagents'), 'agent-child1', [
  aTurn('01:02', [{ type: 'tool_use', id: 'k3', name: 'Read', input: {} }]),
]);
const hbk = run('habits.js', homeK, ['--since', '2026-01-01', '--json']);
let pk = null;
try { pk = JSON.parse(hbk.out); } catch (e) { pk = null; }
check('非対話セッションの子プロジェクトが perProject に現れない',
  pk && !pk.projects.some(p => p.name === 'proj2'),
  pk ? JSON.stringify(pk.projects.map(p => p.name)) : hbk.out.slice(0, 200));
check('非対話セッションの子はサブエージェントの本数に数えない',
  pk && pk.delegation.runs === 0,
  pk ? JSON.stringify(pk.delegation) : hbk.out.slice(0, 200));
// 子は isSub 側の集計(subToolUses / subCost)に乗るので、そちらで確かめる。
// tools.total は元から isSub のレコードを含まない集計なので、この観点の検証にはならない。
check('非対話セッションの子のツール実行・コストをサブ側の集計に含めない',
  pk && pk.delegation.subToolUses === 0 && pk.delegation.subCost === 0,
  pk ? JSON.stringify(pk.delegation) : hbk.out.slice(0, 200));

// ---- 同じ API 応答の分割レコードを二重に数えない ----
// 1 回の応答は content ブロックごとに複数レコードへ分けて書かれ、その全部が同じ
// message.id と完全に同じ usage を持つ。素朴に足すとターン数もコストも約 1.9 倍になる。
// 一方 tool_use はレコードごとに別のブロックなので、そちらは全部数える必要がある。
const homeU = sandbox('habits-dup');
const dupUsage = usage({ input_tokens: 100, output_tokens: 50 });
const dupRec = (time, content) => ({
  type: 'assistant', timestamp: at(time), isSidechain: false,
  message: { id: 'msg_dup_1', model: 'claude-opus-5', usage: dupUsage, content },
});
writeTranscript(homeU, 'proj', 'cccccccc-0000-0000-0000-00000000000c', [
  uTurn('00:00', '送信'),
  dupRec('00:01', [{ type: 'thinking', thinking: '考える' }]),
  dupRec('00:01', [{ type: 'tool_use', id: 'u1', name: 'Bash', input: {} }]),
  dupRec('00:01', [{ type: 'tool_use', id: 'u2', name: 'Read', input: {} }]),
]);
const hbu = run('habits.js', homeU, ['--since', '2026-01-01', '--json']);
let pu = null;
try { pu = JSON.parse(hbu.out); } catch (e) { pu = null; }
check('分割された同一応答をターン数・コストで二重に数えない',
  pu && pu.input.turnsPerMsg === 1 && pu.sessions.medianTurns === 1,
  pu ? `turnsPerMsg=${pu.input.turnsPerMsg} medianTurns=${pu.sessions.medianTurns}` : hbu.out.slice(0, 200));
check('二重計上を防いでもツール回数は全ブロックを数える',
  pu && pu.tools.total === 2, pu ? `tools=${pu.tools.total}` : '');

// ---- セッションをまたぐ同一 message.id を二重に数えない ----
// --resume や fork でセッションを継ぐと、前の会話のレコードが丸ごと次のファイルへ
// 複製される。複製はレコードの uuid まで同一なので(message.id では分割レコードの
// 判定にしか使えず、送信数やツール回数は直らない非対称になっていた)、uuid の Set を
// ファイルループの外に置いてレコード単位で落とす。user・tool_use を含む assistant の
// 両方を複製し、ターン・コストだけでなく送信数・ツール回数からも外れることを確かめる。
console.log('\nhabits.js (跨ファイルの uuid 重複)');
const homeV = sandbox('habits-dup-crossfile');
const crossUsage = usage({ input_tokens: 1e6, output_tokens: 0 }); // opus-5 の in 単価どおり $5 になる値
// 同一ファイル内では uuid は重複しない(実測 0 件)ので、user と assistant で別の uuid を振る。
const crossUTurn = (time) => ({ type: 'user', timestamp: at(time), uuid: 'uuid-cross-u1', message: { content: '送信' } });
const crossATurn = (time) => ({
  type: 'assistant', timestamp: at(time), isSidechain: false, uuid: 'uuid-cross-a1',
  message: {
    id: 'msg_resume_1', model: 'claude-opus-5', usage: crossUsage,
    content: [{ type: 'tool_use', id: 'cx1', name: 'Bash', input: {} }],
  },
});
writeTranscript(homeV, 'proj', 'eeeeeeee-0000-0000-0000-000000000001', [
  crossUTurn('00:00'),
  crossATurn('00:01'),
]);
// --resume / fork で継いだ先の別ファイル。user・assistant とも同じ uuid を持つ完全な複製
// (sessionId などの帰属メタは変わるが、レコードの uuid 自体は書き換わらない)。
writeTranscript(homeV, 'proj', 'eeeeeeee-0000-0000-0000-000000000002', [
  crossUTurn('01:00'),
  crossATurn('01:01'),
]);
const hbv = run('habits.js', homeV, ['--since', '2026-01-01', '--json']);
let pv = null;
try { pv = JSON.parse(hbv.out); } catch (e) { pv = null; }
check('跨ファイルの複製ターンを assistantTurns で二重に数えない(送信1に対し1ターン)',
  pv && pv.input.turnsPerMsg === 1,
  pv ? JSON.stringify(pv.input) : hbv.out.slice(0, 200));
check('跨ファイルの複製ターンをコストで二重に数えない',
  pv && Math.abs(pv.cost - 5) < 1e-9,
  pv ? `cost=${pv.cost}` : hbv.out.slice(0, 200));
check('跨ファイルの複製が送信数からも外れる(送信1回)',
  pv && pv.input.sends === 1 && pv.input.userMsgs === 1,
  pv ? JSON.stringify(pv.input) : hbv.out.slice(0, 200));
check('跨ファイルの複製がツール回数からも外れる(ツール1回)',
  pv && pv.tools.total === 1,
  pv ? JSON.stringify(pv.tools) : hbv.out.slice(0, 200));

// ---- スキル起動のサブエージェントも本数として数える ----
// Agent/Task の tool_use は親の transcript にしか現れないので、スキルやワークフローが
// 起こしたサブエージェントは 0 回と出る。一方 subTurns はそれを含むため、両方出さないと
// 「1 委譲あたり N ターン」が実態と食い違う。
const homeR = sandbox('habits-runs');
const RSID = 'cccccccc-0000-0000-0000-000000000009';
writeTranscript(homeR, 'proj', RSID, [
  uTurn('00:00', 'レビューして'),
  aTurn('00:01', [{ type: 'tool_use', id: 'r1', name: 'Skill', input: { skill: 'code-review' } }]),
]);
writeTranscript(homeR, path.join('proj', RSID, 'subagents'), 'agent-review1', [
  aTurn('00:02', [{ type: 'tool_use', id: 'r2', name: 'Read', input: {} }]),
]);
const hbr = run('habits.js', homeR, ['--since', '2026-01-01', '--json']);
let pr = null;
try { pr = JSON.parse(hbr.out); } catch (e) { pr = null; }
check('Agent 呼び出しが無くてもサブエージェントの本数を数える',
  pr && pr.delegation.total === 0 && pr.delegation.runs === 1,
  pr ? JSON.stringify(pr.delegation).slice(0, 160) : hbr.out.slice(0, 200));

// ---- usage を持たないサブエージェントの応答もターンとして数える ----
// メイン側の assistantTurns は usage の有無に依らず数えているので、サブ側だけ usage
// 必須にすると「1 委譲あたり N ターン」が比較相手より小さく出る非対称になる。
// コストは usage が無いと計算できないので subCost には加算されない。
const homeNU = sandbox('habits-sub-no-usage');
const NUSID = 'cccccccc-0000-0000-0000-000000000010';
writeTranscript(homeNU, 'proj', NUSID, [
  uTurn('00:00', '調べて'),
  aTurn('00:01', [{ type: 'tool_use', id: 'nu1', name: 'Agent', input: { subagent_type: 'sonnet-explorer' } }]),
]);
writeTranscript(homeNU, path.join('proj', NUSID, 'subagents'), 'agent-nousage', [
  {
    type: 'assistant', timestamp: at('00:02'), isSidechain: false,
    // message.usage フィールドが無い応答(interrupted/synthetic 等を想定)。
    message: { model: 'claude-opus-5', content: [{ type: 'tool_use', id: 'nu2', name: 'Read', input: {} }] },
  },
]);
const hbnu = run('habits.js', homeNU, ['--since', '2026-01-01', '--json']);
let pnu = null;
try { pnu = JSON.parse(hbnu.out); } catch (e) { pnu = null; }
check('usage の無いサブエージェントの応答もターンとして数える(コストは加算しない)',
  pnu && pnu.delegation.subTurns === 1 && pnu.delegation.subCost === 0,
  pnu ? JSON.stringify(pnu.delegation) : hbnu.out.slice(0, 200));

// ---- 期間の起点を二重に指定させない / 小数を受けない ----
const bothArgs = run('habits.js', homeH, ['--days', '2', '--since', '2026-01-01']);
check('--days と --since の併用を弾く', bothArgs.code === 2, `code=${bothArgs.code} err=${bothArgs.err.slice(0, 120)}`);
const fracDays = run('habits.js', homeH, ['--days', '2.5']);
check('小数の --days を弾く', fracDays.code === 2, `code=${fracDays.code} err=${fracDays.err.slice(0, 120)}`);
// --days は 1〜DAYS_MAX(3650)に制限されているのに --since に下限が無いと、
// --since 1970-01-01 のような指定で日別テーブルが数万行に膨らむ。DAYS_MAX より
// 明らかに古い日付(西暦2000年、26年前 > 3650日)で弾かれることを確かめる。
const tooOldSince = run('habits.js', homeH, ['--since', '2000-01-01']);
check('古すぎる --since を弾く', tooOldSince.code === 2, `code=${tooOldSince.code} err=${tooOldSince.err.slice(0, 160)}`);

// ---- 指定した --gap が振れ幅の表に現れる ----
const hbg = run('habits.js', homeH, ['--since', '2026-01-01', '--gap', '12', '--json']);
let pg = null;
try { pg = JSON.parse(hbg.out); } catch (e) { pg = null; }
check('見出しの根拠になる --gap の行がスイープ表にある',
  pg && pg.time.sweep.some(s => s.gap === 12), pg ? JSON.stringify(pg.time.sweep.map(s => s.gap)) : hbg.out.slice(0, 200));

// ---- --json の時刻表現を揃える ----
check('日別の first/last も ISO 文字列で返す',
  parsed && typeof parsed.time.days[0].first === 'string' && !Number.isNaN(Date.parse(parsed.time.days[0].first)),
  parsed ? JSON.stringify(parsed.time.days[0]) : '');

// ---- DST のある地域でも日付境界がずれない ----
// 日の加算を固定 86,400,000ms でやると、遷移日以降の境界が前日 23 時に落ちて
// 同じ日付ラベルの行が 2 度出る(2025-11-02 の米国の切り戻し)。
const homeT = sandbox('habits-dst');
writeTranscript(homeT, 'proj', 'cccccccc-0000-0000-0000-000000000007', [
  { type: 'user', timestamp: '2025-11-01T15:00:00.000Z', message: { content: '遷移前' } },
  { type: 'user', timestamp: '2025-11-02T18:00:00.000Z', message: { content: '遷移後' } },
]);
const hbt = run('habits.js', homeT, ['--since', '2025-11-01', '--json'], { TZ: 'America/New_York' });
let pt = null;
try { pt = JSON.parse(hbt.out); } catch (e) { pt = null; }
const labels = pt ? pt.time.days.map(d => d.day) : [];
check('DST を跨いでも日付ラベルが重複しない',
  pt && labels.length > 0 && new Set(labels).size === labels.length,
  pt ? labels.slice(0, 6).join(',') : hbt.err.slice(0, 200));

// ---- 年をまたぐ期間では日別ラベルに年を出す ----
// MM/DD だけだと年をまたいだ 2 つの日が同じラベルに畳まれ、--json の time.days[].day を
// 鍵に使う側が黙って取りこぼす。「今日」は実行時刻に依存するので、今日から確実に
// 年をまたぐ 400 日前(365 日超)を --since に使う(ago() は既存の DST テストの隣で
// 定義済みの相対時刻ヘルパー)。
const homeY = sandbox('habits-year-span');
const sinceDate400 = new Date(Date.now() - 400 * 86400000);
const sinceYearSpan = `${sinceDate400.getFullYear()}-${String(sinceDate400.getMonth() + 1).padStart(2, '0')}-${String(sinceDate400.getDate()).padStart(2, '0')}`;
writeTranscript(homeY, 'proj', 'cccccccc-0000-0000-0000-00000000000e', [
  { type: 'user', timestamp: ago(400), message: { content: '400日前' } },
  { type: 'user', timestamp: ago(0), message: { content: '今日' } },
]);
const hby = run('habits.js', homeY, ['--since', sinceYearSpan, '--json']);
let py = null;
try { py = JSON.parse(hby.out); } catch (e) { py = null; }
const yearLabels = py ? py.time.days.map(d => d.day) : [];
check('年をまたぐ期間では日別ラベルが一意かつ YYYY/MM/DD 形式になる',
  py && yearLabels.length > 0 && new Set(yearLabels).size === yearLabels.length
    && yearLabels.every(l => /^\d{4}\/\d{2}\/\d{2}$/.test(l)),
  py ? `${yearLabels.slice(0, 2).join(',')} ... ${yearLabels.slice(-2).join(',')}` : hby.out.slice(0, 200) + hby.err.slice(0, 200));

// 年をまたがない既定の期間では従来どおり MM/DD のまま(短い期間で毎行に年が出ると
// 日別テーブルが読みにくいので、そこは変えていない)。--days 7 の窓が実行日をまたいで
// 年始をまたぐ確率は低いが 0 ではない(元日近辺の実行でのみ理論上フレーキーになりうる)。
const homeNS = sandbox('habits-nonspan');
writeTranscript(homeNS, 'proj', 'cccccccc-0000-0000-0000-00000000000f', [
  { type: 'user', timestamp: ago(3), message: { content: '3日前' } },
]);
const hbns = run('habits.js', homeNS, ['--days', '7', '--json']);
let pns = null;
try { pns = JSON.parse(hbns.out); } catch (e) { pns = null; }
check('年をまたがない既定の期間では日別ラベルが MM/DD のまま',
  pns && pns.time.days.length > 0 && pns.time.days.every(d => /^\d{2}\/\d{2}$/.test(d.day)),
  pns ? JSON.stringify(pns.time.days.map(d => d.day)) : hbns.out.slice(0, 200));

// ---- 3 本の集計スクリプトにも同じ規則を効かせる(issue #17) ----
// habits.js だけが持っていた「非対話実行の除外」と「分割された同一応答の扱い」を
// sessions / turncost / breakdown にも効かせた。判定は lib.js に集約してあるので、
// ここでは規則そのものと、3 本が同じ結果を出すかを見る。
console.log('\nsessions.js / turncost.js / breakdown.js の除外と重複排除');

// 収集器の規則。実データではサブエージェントの transcript が「途中のレコードは
// output_tokens: 2 のプレースホルダ、最後だけが完成形」という書かれ方をするので、
// 最初のレコードを採ると output トークンが 1/10 に落ちる(実測 12.25M → 1.29M)。
const col = lib.makeUsageCollector();
const splitRec = (out, id = 'msg_a') => ({
  type: 'assistant', isSidechain: false,
  message: { id, model: 'claude-opus-5', usage: usage({ input_tokens: 10, output_tokens: out }) },
});
check('同じ message.id の応答は初回だけ true を返す(ターンを数えるのに使う)',
  col.add(splitRec(2)) === true && col.add(splitRec(2)) === false && col.add(splitRec(999)) === false);
const collected = [...col.entries()];
check('採るのは output_tokens が最大のレコード(途中のプレースホルダではない)',
  collected.length === 1 && collected[0].usage.output_tokens === 999, JSON.stringify(collected));
col.add(splitRec(5, 'msg_b'));
check('message.id が違えば別の応答として数える', [...col.entries()].length === 2);
const colNoId = lib.makeUsageCollector();
colNoId.add(assistant(usage({ output_tokens: 1 })));
colNoId.add(assistant(usage({ output_tokens: 1 })));
check('message.id が無いレコードはまとめない(分割か別応答か判別できない)',
  [...colNoId.entries()].length === 2);

const homeX = sandbox('exclude');
const xTs = t => `2026-03-01T${t}:00.000Z`;
// 1 回の応答が 3 レコードに分かれ、最後だけが完成形の usage を持つ形(実データと同じ)。
// tool_use はレコードごとに別のブロックなので、こちらは 2 回とも数えられなければならない。
const split = (t, out, content) => ({
  type: 'assistant', timestamp: xTs(t), isSidechain: false,
  message: {
    id: 'msg_split_1', model: 'claude-opus-5',
    usage: usage({ cache_read_input_tokens: 40e3, output_tokens: out }),
    content,
  },
});
writeTranscript(homeX, 'proj', 'dddddddd-0000-0000-0000-000000000001', [
  { type: 'user', timestamp: xTs('00:00'), message: { content: '調べて' } },
  split('00:01', 2, [{ type: 'thinking', thinking: '考える' }]),
  split('00:02', 2, [{ type: 'tool_use', id: 'x1', name: 'Read', input: {} }]),
  split('00:03', 1000, [{ type: 'tool_use', id: 'x2', name: 'Grep', input: {} }]),
]);
// 非対話実行(claude -p の ping)のセッションと、その下のサブエージェント。子には印が
// 付かないので親を見て落とす。子は isSidechain も落ちている形にしてあり、フラグ頼みの
// 除外では素通りする(turncost.js の 300K〜 帯に現れる)。
const SDK_SID = 'eeeeeeee-0000-0000-0000-000000000001';
writeTranscript(homeX, 'C--WINDOWS-system32', SDK_SID, [
  { type: 'user', timestamp: xTs('02:00'), entrypoint: 'sdk-cli', message: { content: 'Reply with only the word: ok' } },
  {
    type: 'assistant', timestamp: xTs('02:01'), entrypoint: 'sdk-cli', isSidechain: false,
    message: { id: 'msg_ping', model: 'claude-opus-5', usage: usage({ cache_read_input_tokens: 250e3, output_tokens: 5 }) },
  },
]);
writeTranscript(homeX, path.join('C--WINDOWS-system32', SDK_SID, 'subagents'), 'agent-x', [
  {
    type: 'assistant', timestamp: xTs('02:02'), isSidechain: false,
    message: { id: 'msg_ping_sub', model: 'claude-opus-5', usage: usage({ cache_read_input_tokens: 310e3, output_tokens: 7 }) },
  },
]);

const ssx = run('sessions.js', homeX);
check('sessions.js: 非対話実行のセッションを数えない', /^セッション数: 1 /m.test(ssx.out), ssx.out);
check('sessions.js: 何本外したかを出力に添える',
  /非対話実行 claude -p のセッション 1 本/.test(ssx.out), ssx.out);
check('sessions.js: 分割された応答は 1 ターン、ツールは 2 回',
  /^proj\s+dddddddd\s+1\s+0\s+40K\s+2\s+0\s/m.test(ssx.out), ssx.out);

const tcx = run('turncost.js', homeX);
check('turncost.js: 分割された応答は 1 ターン、単価は完成形の usage で出す',
  /^30〜60K\s+1\s+\$0\s+\$0\.0450/m.test(tcx.out), tcx.out);
check('turncost.js: 非対話実行のターンが帯に現れない(親も子も)',
  !/^200〜300K/m.test(tcx.out) && !/^300K〜/m.test(tcx.out), tcx.out);

const bdx = run('breakdown.js', homeX);
check('breakdown.js: 分割された応答の output を二重にも過小にも数えない',
  /^opus-5\s+main\s+1\s+1000\s/m.test(bdx.out), bdx.out);
check('breakdown.js: 非対話実行のファイルを本数からも外す',
  /^ファイル数: 1$/m.test(bdx.out), bdx.out);

// ---- パスで決まる帰属(fileIdentity) ----
// 層をレコードの isSidechain でなくパスで決める規則。ここが崩れると、サブエージェントの
// transcript が架空プロジェクト "subagents" のセッションとして現れる/メイン層に混ざる。
const idSub = lib.fileIdentity(path.join(lib.ROOT, 'proj', 'sid-1', 'subagents', 'agent-7.jsonl'));
check('fileIdentity: サブは実プロジェクトと親セッションIDに合流する',
  idSub.project === 'proj' && idSub.sid === 'sid-1' && idSub.isSub === true,
  JSON.stringify(idSub));
check('fileIdentity: サブの親ファイルパスを返す',
  idSub.parentFile === path.join(lib.ROOT, 'proj', 'sid-1.jsonl'), String(idSub.parentFile));
const idMain = lib.fileIdentity(path.join(lib.ROOT, 'proj', 'sid-2.jsonl'));
check('fileIdentity: メインはファイル名がセッションID、親は無い',
  idMain.project === 'proj' && idMain.sid === 'sid-2' && idMain.isSub === false && idMain.parentFile === null,
  JSON.stringify(idMain));

// ---- サブエージェントの層はフラグでなくパスで決まる(集計 3 本) ----
// 実測ではサブ側 1048 ファイルの assistant レコードすべてに isSidechain が付いているが、
// フラグはレコード単位なので欠落しうる。フラグを **付けない** サブの transcript を置いて、
// パスだけで層が決まることを確かめる。合わせて、サブのコストが親セッションに合流すること
// (合流させないと mainTurns 0 で落ち、委譲ぶんが総額から丸ごと消える)も見る。
console.log('\nサブエージェントの層はパスで決まる');
const homeLP = sandbox('layer-by-path');
const LPSID = 'ffffffff-1111-0000-0000-000000000001';
const yTs = t => `2026-03-01T${t}:00.000Z`;
writeTranscript(homeLP, 'proj', LPSID, [
  { type: 'user', timestamp: yTs('00:00'), uuid: 'y-u1', message: { content: '調べて' } },
  {
    type: 'assistant', timestamp: yTs('00:01'), uuid: 'y-a1', isSidechain: false,
    message: {
      id: 'msg_y_main', model: 'claude-opus-5',
      usage: usage({ cache_read_input_tokens: 40e3, output_tokens: 10 }),
      content: [{ type: 'tool_use', id: 'y1', name: 'Task', input: {} }],
    },
  },
]);
// isSidechain を付けない。パスで落ちなければ「メインの 300K 超のターン」として現れる。
writeTranscript(homeLP, path.join('proj', LPSID, 'subagents'), 'agent-y1', [
  {
    type: 'assistant', timestamp: yTs('00:02'), uuid: 'y-a2',
    message: {
      id: 'msg_y_sub', model: 'claude-opus-5',
      usage: usage({ input_tokens: 1e6, output_tokens: 100 }),
    },
  },
]);

const sslp = run('sessions.js', homeLP);
check('sessions.js: サブの transcript を架空プロジェクトのセッションにしない',
  /^セッション数: 1 /m.test(sslp.out) && !/subagents/.test(sslp.out), sslp.out);
check('sessions.js: サブのコストとターンが親セッションに合流する($5 を落とさない)',
  /総換算コスト: \$5$/m.test(sslp.out) && /^proj\s+ffffffff\s+1\s+1\s+40K\s+0\s+1\s/m.test(sslp.out), sslp.out);

const tclp = run('turncost.js', homeLP);
check('turncost.js: フラグの無いサブのターンが帯に現れない',
  /^30〜60K\s+1\s/m.test(tclp.out) && !/^300K〜/m.test(tclp.out), tclp.out);

const bdlp = run('breakdown.js', homeLP);
check('breakdown.js: フラグが無くてもパスで subagent 層に入る',
  /^opus-5\s+subagent\s+1\s+100\s/m.test(bdlp.out) && /^opus-5\s+main\s+1\s+10\s/m.test(bdlp.out), bdlp.out);

// ---- 跨ファイルの複製を集計 3 本でも落とす ----
// --resume / fork は前の会話をそのまま次のファイルへ複製し、uuid まで一致する。
// 落とさないとセッションもターンもトークンも二重に数える(実測 30 日で 632 レコード)。
console.log('\n跨ファイルの複製(--resume / fork)');
const homeXD = sandbox('crossfile-dup-3');
const zTs = t => `2026-04-01T${t}:00.000Z`;
const zRecs = [
  { type: 'user', timestamp: zTs('00:00'), uuid: 'z-u1', message: { content: '送信' } },
  {
    type: 'assistant', timestamp: zTs('00:01'), uuid: 'z-a1', isSidechain: false,
    message: {
      id: 'msg_z', model: 'claude-opus-5',
      usage: usage({ input_tokens: 1e6, output_tokens: 0 }),
      content: [{ type: 'tool_use', id: 'z1', name: 'Read', input: {} }],
    },
  },
];
writeTranscript(homeXD, 'proj', 'aaaa1111-0000-0000-0000-000000000001', zRecs);
// 継いだ先。レコードは完全な複製(帰属メタだけが違い、uuid は書き換わらない)。
writeTranscript(homeXD, 'proj', 'aaaa1111-0000-0000-0000-000000000002', zRecs);

const ssxd = run('sessions.js', homeXD);
check('sessions.js: 複製されたセッションを 2 本に数えない',
  /^セッション数: 1  総換算コスト: \$5$/m.test(ssxd.out), ssxd.out);
check('sessions.js: 複製されたツール呼び出しを二重に数えない',
  /重いツール呼び出し: 1 回/.test(ssxd.out), ssxd.out);

const tcxd = run('turncost.js', homeXD);
check('turncost.js: 複製されたターンを帯に二重に入れない',
  /^300K〜\s+1\s+\$5\s/m.test(tcxd.out), tcxd.out);

const bdxd = run('breakdown.js', homeXD);
check('breakdown.js: 複製されたレコードのトークンを二重に数えない',
  /^opus-5\s+main\s+1\s+0\s+1000000\s/m.test(bdxd.out), bdxd.out);

// ---- 親ファイルにインラインで書かれた sidechain ----
// 実データでは 0 件だが、層をパスだけで決めるとこの形で非対称が生まれる:
// ツールはメインの委譲率に入り、ターンとコストはサブに付く。判定は収集器と同じ
// 「パス または フラグ」で揃える。
console.log('\nインラインの sidechain');
const homeIS = sandbox('inline-sidechain');
const isTs = t => `2026-05-01T${t}:00.000Z`;
writeTranscript(homeIS, 'proj', 'bbbb2222-0000-0000-0000-000000000001', [
  {
    type: 'assistant', timestamp: isTs('00:00'), isSidechain: false,
    message: {
      id: 'msg_is_main', model: 'claude-opus-5',
      usage: usage({ cache_read_input_tokens: 40e3, output_tokens: 10 }),
      content: [{ type: 'tool_use', id: 'is1', name: 'Read', input: {} }],
    },
  },
  {
    type: 'assistant', timestamp: isTs('00:01'), isSidechain: true,
    message: {
      id: 'msg_is_sub', model: 'claude-opus-5',
      usage: usage({ cache_read_input_tokens: 10e3, output_tokens: 10 }),
      content: [{ type: 'tool_use', id: 'is2', name: 'Read', input: {} }],
    },
  },
]);
const ssis = run('sessions.js', homeIS);
check('sessions.js: インラインの sidechain のツールを委譲率の分母に入れない',
  /重いツール呼び出し: 1 回/.test(ssis.out), ssis.out);
check('sessions.js: インラインの sidechain のターンは sub 側に付く',
  /^proj\s+bbbb2222\s+1\s+1\s/m.test(ssis.out), ssis.out);

// ---- 分割応答のうちフラグを持つレコードだけ usage が無い場合 ----
// turncost.js が usage の有無で先に落としていると、収集器がフラグを見ないまま終わり、
// サブの応答が Opus メインの帯に入って $/ターン を歪める。
const homeNF = sandbox('flag-without-usage');
const nfTs = t => `2026-06-01T${t}:00.000Z`;
writeTranscript(homeNF, 'proj', 'cccc3333-0000-0000-0000-000000000001', [
  // 同じ message.id の分割。フラグを持つ側は usage を持たない(thinking ブロックなど)。
  { type: 'assistant', timestamp: nfTs('00:00'), isSidechain: true, message: { id: 'msg_nf', model: 'claude-opus-5' } },
  {
    type: 'assistant', timestamp: nfTs('00:01'),
    message: { id: 'msg_nf', model: 'claude-opus-5', usage: usage({ cache_read_input_tokens: 310e3, output_tokens: 10 }) },
  },
]);
const tcnf = run('turncost.js', homeNF);
check('turncost.js: フラグを持つレコードに usage が無くてもサブと判定する',
  !/^300K〜/m.test(tcnf.out), tcnf.out);

// ---- 走査中に消えたファイル ----
// セッションの後片付けや別の Claude Code の実行でファイルが消えることがある。
// 1 ファイルの消失で全体の走査を捨てないよう、読み出しの ENOENT だけを飲む。
// CommonJS なのでトップレベル await が使えない。records() を直接回す検証だけ非同期にして、
// 集計の出力もその中でやる(先に出すと、この検証の結果が件数に入らない)。
const asyncChecks = (async () => {
  const gone = path.join(BASE, 'no-such-transcript.jsonl');
  let goneCount = 0, goneThrew = false;
  try {
    for await (const _ of lib.records(gone)) goneCount++;
  } catch (e) { goneThrew = true; }
  check('records(): 読めないファイルは投げずに 0 件で終わる',
    !goneThrew && goneCount === 0, `threw=${goneThrew} count=${goneCount}`);
})();

// ---- transcript が無い環境 ----
console.log('\ntranscript が無い場合');
const homeC = path.join(BASE, 'empty');
fs.mkdirSync(homeC, { recursive: true });
const miss = run('turncost.js', homeC);
check('探した場所を示して非 0 で終わる',
  miss.code === 1 && miss.err.includes(path.join(homeC, '.claude', 'projects')), `code=${miss.code} err=${miss.err}`);

asyncChecks.then(() => {
  console.log(`\n  ${state.pass} PASS / ${state.fail} FAIL`);
  process.exitCode = state.fail ? 1 : 0;
});
