// 変更3(スコープの導出)と変更4(スコープ対応の注入)の回帰テスト。
// 偽リポジトリを 2 つ(複数ツール構成 / 単一ツール構成)作り、list・context の出力を照合する。
// スコープは読み取り時にディスク上の構成から導出されるので、レコードは直接書けば足りる。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpDir, projectKey, sandboxHome, checks, runner } = require('./lib');

const BASE = tmpDir('scope');
const { home, logDir } = sandboxHome(path.join(BASE, 'home'));
const MULTI = path.join(BASE, 'multi');   // 複数ツール構成のリポジトリ
const SINGLE = path.join(BASE, 'single'); // 単一ツールのリポジトリ

const mk = (...p) => fs.mkdirSync(path.join(...p), { recursive: true });
const touch = (...p) => fs.writeFileSync(path.join(...p), 'x');

// multi: toolA / toolB が目印を持つ。docs と shared は候補外。tools/ は入れ物
for (const d of ['toolA', 'toolB', 'docs', 'shared', path.join('tools', 'image-resizer')]) mk(MULTI, d);
touch(MULTI, 'toolA', 'README.md');
touch(MULTI, 'toolB', 'package.json');
touch(MULTI, 'tools', 'image-resizer', 'README.md');
// single: 目印を持つ最上位ディレクトリは 1 つだけ
mk(SINGLE, 'UI'); mk(SINGLE, 'docs');
touch(SINGLE, 'README.md');
touch(SINGLE, 'UI', 'README.md');
// git は stdin を読まないのでハングの実害は薄いが、孤児プロセスが残る事故(issue #8)の
// 検出網として timeout だけは掛けておく
for (const r of [MULTI, SINGLE]) {
  execFileSync('git', ['init', '-q'], { cwd: r, windowsHide: true, timeout: 30000, killSignal: 'SIGKILL' });
}

function write(repo, sessions) {
  const lines = [];
  for (const s of sessions) {
    lines.push(JSON.stringify({ k: 'start', sid: s.sid, ts: s.ts, cwd: s.cwd || repo, branch: 'main' }));
    lines.push(JSON.stringify({
      k: 'note', sid: s.sid, ts: s.ts, via: 'wrap', summary: s.summary,
      ...(s.scope ? { scope: s.scope } : {}), ...(s.handoff ? { handoff: s.handoff } : {}), ...(s.next ? { next: s.next } : {}),
    }));
    lines.push(JSON.stringify({ k: 'end', sid: s.sid, ts: s.ts + 1000, reason: 'clear', stats: s.stats }));
  }
  fs.writeFileSync(path.join(logDir, `${projectKey(repo)}.ndjson`), `${lines.join('\n')}\n`);
}

const T = Date.now() - 3600 * 1000; // 索引の日数上限に掛からない「最近」
mk(MULTI, 'toolD'); touch(MULTI, 'toolD', 'README.md');
write(MULTI, [
  // 古い未完は索引に出さない(放置されたツールが毎回並ぶのを防ぐ)
  { sid: 's0', ts: T - 60 * 86400 * 1000, summary: 'toolD を直した', handoff: 'toolD の続き', stats: { files: ['toolD/a.js'], editedFiles: [] } },
  // 最多のディレクトリが勝つ。docs / shared / ルート直下は候補にならない
  { sid: 's1', ts: T, summary: 'toolA を直した', handoff: 'toolA の続き', stats: { files: ['README.md', 'docs/x.md', 'shared/y.js', 'toolA/a.js', 'toolA/b.js'], editedFiles: [] } },
  // files が空でも editedFiles から導出できる。リポジトリ外(スクラッチパッド)は無視
  { sid: 's2', ts: T + 1, summary: 'toolB を直した', handoff: 'toolB の続き', stats: { files: [], editedFiles: [path.join(MULTI, 'toolB', 'c.js'), 'C:\\Temp\\claude\\gen.py'] } },
  // 入れ物ディレクトリは 2 階層目までがスコープ名
  { sid: 's3', ts: T + 2, summary: 'image-resizer を直した', next: ['リサイズ処理の続き'], stats: { files: ['tools/image-resizer/x.js'], editedFiles: [] } },
  // --scope の明示指定は自動導出より優先
  { sid: 's4', ts: T + 3, summary: '明示指定', scope: 'toolB', stats: { files: ['toolA/z.js', 'toolA/w.js'], editedFiles: [] } },
  // 判定材料が無ければスコープなし(リポジトリ全体の作業)
  { sid: 's5', ts: T + 4, summary: 'ルートだけ', stats: { files: ['README.md'], editedFiles: [] } },
]);
write(SINGLE, [{ sid: 'x1', ts: T, summary: '単一ツール', stats: { files: ['UI/a.js', 'UI/b.js'], editedFiles: [] } }]);

const { check, finish } = checks();
const worklog = runner(home, MULTI);
const run = (cwd, args) => worklog(args, { cwd }).out;
const lineOf = (out, needle) => out.split('\n').find((l) => l.includes(needle)) || '';

const multiOut = run(MULTI, ['list', '-n', '10']);
check('T4: 最多のディレクトリが勝つ(docs/shared/ルートは候補外)', / toolA .*toolA を直した/.test(lineOf(multiOut, 'toolA を直した')), lineOf(multiOut, 'toolA を直した'));
check('T5: files が空でも editedFiles から導出、スクラッチパッドは無視', / toolB .*toolB を直した/.test(lineOf(multiOut, 'toolB を直した')), lineOf(multiOut, 'toolB を直した'));
check('入れ物は 2 階層目まで', /tools\/image-resizer /.test(lineOf(multiOut, 'image-resizer を直した')), lineOf(multiOut, 'image-resizer を直した'));
check('--scope の明示指定が自動導出より優先', / toolB .*明示指定/.test(lineOf(multiOut, '明示指定')), lineOf(multiOut, '明示指定'));
check('材料が無ければスコープなし', /\d\d:\d\d \[main\] ルートだけ/.test(lineOf(multiOut, 'ルートだけ')), lineOf(multiOut, 'ルートだけ'));

const filtered = run(MULTI, ['list', '--scope', 'toolb', '-n', '10']);
check('T9: --scope は部分一致・大文字小文字を無視', filtered.includes('toolB を直した') && filtered.includes('明示指定') && !filtered.includes('toolA を直した'), filtered.trim());

const singleOut = run(SINGLE, ['list', '-n', '10']);
check('T3: 単一ツールのリポジトリではスコープを出さない', !/ UI /.test(singleOut), singleOut.trim());

// T6: 2 つ目のツールに目印ができた時点で過去セッションにも遡ってラベルが付く
touch(SINGLE, 'docs', 'README.md'); // docs は DENY_DIRS なので増えない
check('T6: DENY_DIRS のディレクトリは目印があってもツールに数えない', !/ UI /.test(run(SINGLE, ['list', '-n', '10'])));
mk(SINGLE, 'Widgets'); touch(SINGLE, 'Widgets', 'README.md');
check('T6: 2 つ目のツールができると過去セッションにもラベルが付く', / UI /.test(run(SINGLE, ['list', '-n', '10'])), lineOf(run(SINGLE, ['list', '-n', '10']), '単一ツール'));

// 全プロジェクト表示は リポジトリ/ツール の形
const todayOut = run(MULTI, ['today', '--days', '3650']);
check('today は リポジトリ/ツール の形で出す', /multi\/toolA/.test(todayOut), lineOf(todayOut, 'toolA を直した'));

// --- 変更4: 注入(スコープ対応) ---
const ctxInTool = run(path.join(MULTI, 'toolA'), ['context']);
check('cwd がツールの中なら、そのツールの引き継ぎを全文', /## 次回の始め方 \(toolA \/ /.test(ctxInTool) && ctxInTool.includes('toolA の続き'), ctxInTool.split('\n').slice(0, 2).join(' | '));
check('他ツールは 1 行の索引になる', /他に未完の作業があるツール:/.test(ctxInTool) && / {2}toolB \(\d\d\/\d\d\) {2}toolB の続き/.test(ctxInTool), ctxInTool.split('\n').filter((l) => /^ {2}\w|未完の作業/.test(l)).join('\n'));
check('索引は日数上限より古いものを出さない', !ctxInTool.includes('toolD'), ctxInTool);
check('索引に主スコープ自身は出さない', !/ {2}toolA \(/.test(ctxInTool));
check('切り替え方を添える', ctxInTool.includes('/handoff <ツール名>'));
check('T8: 注入は contextMaxChars(1600)未満', ctxInTool.length < 1600, `${ctxInTool.length} 文字`);
check('注入の順序は 引き継ぎ → 索引 → 直近ログ',
  ctxInTool.indexOf('## 次回の始め方') < ctxInTool.indexOf('他に未完の作業があるツール:')
  && ctxInTool.indexOf('他に未完の作業があるツール:') < ctxInTool.indexOf('## 直近の作業ログ'));

const ctxOther = run(path.join(MULTI, 'toolB'), ['context']);
check('ツールを移ると引き継ぎも入れ替わる', /## 次回の始め方 \(toolB \/ /.test(ctxOther) && ctxOther.includes('toolB の続き'), ctxOther.split('\n')[0]);

const ctxSingle = run(SINGLE, ['context']);
check('T3: 単一ツールのリポジトリでは索引を出さない', !ctxSingle.includes('他に未完の作業があるツール:'), ctxSingle.trim() || '(空)');

// handoff の位置引数でツールを切り替える
const ho = run(MULTI, ['handoff', 'toolb']);
check('handoff <ツール名> で切り替わる', ho.includes('toolB の続き'), ho.split('\n')[0]);
const hoMiss = run(MULTI, ['handoff', 'nosuch']);
check('無いツール名は分かるように断る', hoMiss.includes('記録がない'), hoMiss.trim());

finish();
