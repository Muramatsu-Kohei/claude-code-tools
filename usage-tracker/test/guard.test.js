'use strict';
// guard.js(枠切れ前の引き継ぎ促し)の回帰テスト。
//
// 守りたいのは2点。
//  1. 閾値がアカウントごとに正しく解決されること。枠の容量比はプランで違うので、
//     同じ % でも意味が変わる。ここが崩れると「余裕なのに促す」「促さないまま枠切れ」の
//     どちらかに倒れるが、どちらも実際に枠を使い切るまで気づけない。
//  2. 段によって促す強さが変わること。1段目は残量を意識させるだけ、2段目だけが畳ませる。
//     文面の分岐なので型でも実行時エラーでも守れず、テストでしか固定できない。
//
// 偽 HOME を作って USERPROFILE を差し替えるので、実際の ~/.claude は読み書きしない。
// guard.js は collect-state・発火フラグ・credentials のすべてを HOME 基準で引くため、
// これだけで完全に隔離できる。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// .tmp 直下ではなく自分専用のサブディレクトリを使う(他スイートのサンドボックスを
// 実行中に消す事故を避けるための、3ツール共通の規約)。
const BASE = path.join(__dirname, '.tmp', 'guard');
const GUARD = path.join(__dirname, '..', 'guard.js');
fs.rmSync(BASE, { recursive: true, force: true });

const state = { pass: 0, fail: 0 };
// extra は失敗時の手掛かり。落ちた行だけでは原因が分からないことが多いので実出力を添える
function check(label, cond, extra) {
  if (cond) state.pass++; else state.fail++;
  const tail = extra && !cond ? `\n      ${String(extra).replace(/\n/g, '\n      ')}` : '';
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}${tail}`);
}

// 偽 HOME を作り、ログイン中アカウント(subscriptionType)を書く。
// acct に null を渡すと credentials を置かない = アカウント判別不能の経路を再現する。
function sandbox(name, acct) {
  const home = path.join(BASE, name);
  fs.mkdirSync(path.join(home, '.claude', 'usage-tracker'), { recursive: true });
  if (acct !== null) {
    fs.writeFileSync(
      path.join(home, '.claude', '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { subscriptionType: acct } }),
      'utf8'
    );
  }
  return home;
}

// collect.js が書くはずの状態ファイルを偽装する。
// ageMin は「この状態が何分前に書かれたか」。guard.js は 15 分より古い状態を捨てるので、
// stale 判定のテストではここを動かす。
function writeState(home, acct, { five = 0, seven = 0, ageMin = 0, fiveResetMin = 120, sevenResetMin = 3000 } = {}) {
  const now = Date.now();
  fs.writeFileSync(
    path.join(home, '.claude', 'usage-tracker', `collect-state-${acct}.json`),
    JSON.stringify({
      ts: new Date(now - ageMin * 60000).toISOString(),
      acct,
      five_pct: five,
      seven_pct: seven,
      // リセット時刻は Unix epoch 秒(実測で来る形)。負の分数を渡せば「リセット済みの枠」になる。
      five_reset: Math.floor((now + fiveResetMin * 60000) / 1000),
      seven_reset: Math.floor((now + sevenResetMin * 60000) / 1000),
    }),
    'utf8'
  );
}

// 偽 HOME を向けて guard.js をフックとして実行する。
// 発火時は Stop なら exit 2 になるので、非 0 終了も戻り値として扱う。
function run(home, { input = {}, env = {}, event = 'PostToolUse', sid = 'sid-1' } = {}) {
  const e = { ...process.env, USERPROFILE: home, HOME: home, NO_COLOR: '1' };
  // 実行環境に CLAUDE_USAGE_GUARD_* が設定されていると閾値が乗っ取られ、テストが
  // 「開発者の手元でだけ通る」ものになる。テストが明示的に渡す分だけを残す。
  for (const k of Object.keys(e)) if (/^CLAUDE_USAGE_GUARD_/.test(k)) delete e[k];
  Object.assign(e, env);

  const payload = JSON.stringify({ hook_event_name: event, session_id: sid, ...input });
  const timeout = 30000;
  try {
    const out = execFileSync(process.execPath, [GUARD], {
      encoding: 'utf8', env: e, input: payload, stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, timeout, killSignal: 'SIGKILL',
    });
    return { code: 0, out, err: '' };
  } catch (err) {
    // 終了ステータスを残さずに死んだ場合(timeout / OOM / 外部からの kill)は、
    // 「exit 2 で促した」という判定に混ぜてはいけない。基盤の異常が PASS として
    // 集計されるのを防ぐため、ここで明示的に落とす(transcript.test.js と同じ作法)。
    if (err.status == null) {
      const why = err.code === 'ETIMEDOUT' ? `timeout(${timeout}ms)で強制終了された`
        : `終了コードを残さずに落ちた(code=${err.code || '不明'} signal=${err.signal || 'なし'})`;
      throw new Error(`子プロセスが${why}: guard.js`, { cause: err });
    }
    return { code: err.status, out: err.stdout || '', err: err.stderr || '' };
  }
}

// 促し文を取り出す。PostToolUse は stdout の additionalContext、Stop は stderr に出る。
// 促さなかったときは空文字。
function message(r) {
  if (r.err) return r.err;
  try {
    return JSON.parse(r.out).hookSpecificOutput.additionalContext || '';
  } catch {
    return '';
  }
}

// 「畳ませたか」の判定。1段目と2段目の差はこの一文の有無に集約される。
const wrapsNow = (m) => m.includes('ただちに以下を実行してください');

// ---- アカウント別の既定閾値 ----
// 週次枠が持つ 5h枠の本数が team 8.0 / max 10.3 と違うため、「残りが 5h枠1本」の点は
// team 90% / max 92% にずれる。ここが同じ値に戻ると、max では 5h枠 1.5 本分を残した
// 段階で促してしまう(旧既定 85% で実際に起きていた)。
console.log('\nアカウント別の既定閾値(週次枠)');
{
  const home = sandbox('week-team', 'team');
  writeState(home, 'team', { seven: 89 });
  check('team: 89% では促さない', message(run(home, { sid: 'a' })) === '', run(home, { sid: 'a' }).out);
  writeState(home, 'team', { seven: 90 });
  check('team: 90% で促す', message(run(home, { sid: 'b' })).includes('週次枠: 90%'), message(run(home, { sid: 'c' })));
}
{
  const home = sandbox('week-max', 'max');
  writeState(home, 'max', { seven: 91 });
  check('max: 91% では促さない(team の閾値を当てていない)', message(run(home, { sid: 'a' })) === '');
  writeState(home, 'max', { seven: 92 });
  check('max: 92% で促す', message(run(home, { sid: 'b' })).includes('週次枠: 92%'));
}
{
  // 実測の無いアカウントは、最も容量の小さい team の値に倒れるのが期待。
  const home = sandbox('week-unknown', null);
  writeState(home, 'unknown', { seven: 90 });
  check('アカウント判別不能: team の閾値(90%)に倒れる', message(run(home, { sid: 'a' })).includes('週次枠: 90%'));
}

console.log('\n既定閾値(5時間枠)');
{
  const home = sandbox('five', 'max');
  writeState(home, 'max', { five: 91 });
  check('5h: 91% では促さない', message(run(home, { sid: 'a' })) === '');
  writeState(home, 'max', { five: 92 });
  check('5h: 92% で促す', message(run(home, { sid: 'b' })).includes('5時間枠: 92%'));
  writeState(home, 'max', { five: 97 });
  check('5h: 97% は最終段', message(run(home, { sid: 'c' })).includes('【最終】'));
}

// ---- 環境変数による上書き ----
console.log('\n環境変数による上書き');
{
  const home = sandbox('env', 'max');
  writeState(home, 'max', { seven: 85 });
  check('共通変数が既定より優先される',
    message(run(home, { sid: 'a', env: { CLAUDE_USAGE_GUARD_WEEK_THRESHOLD: '80' } })).includes('週次枠: 85%'));
  check('アカウント名付きの変数が共通変数より優先される',
    message(run(home, {
      sid: 'b',
      env: { CLAUDE_USAGE_GUARD_WEEK_THRESHOLD: '80', CLAUDE_USAGE_GUARD_WEEK_THRESHOLD_MAX: '95' },
    })) === '');
  check('他アカウント宛ての変数は効かない',
    message(run(home, {
      sid: 'c',
      env: { CLAUDE_USAGE_GUARD_WEEK_THRESHOLD_TEAM: '80' },
    })) === '');
}

// ---- 段による促し方の違い ----
// 1段目で畳ませていた頃は、リセットまで最大5時間しかない5h枠のために作業を止めていた。
// 畳ませるのは「次に止まるときは枠切れ」の最終段だけ、という設計をここで固定する。
console.log('\n段による促し方の違い');
{
  const home = sandbox('stage', 'max');

  writeState(home, 'max', { five: 92 });
  const fiveWarn = message(run(home, { sid: 'a' }));
  check('5h 警告: 畳ませない', !wrapsNow(fiveWarn), fiveWarn);
  check('5h 警告: 5時間枠の理由を出す', fiveWarn.includes('5時間枠を使い切ると'), fiveWarn);
  check('5h 警告: 週次枠の理由は出さない', !fiveWarn.includes('数日間'), fiveWarn);

  writeState(home, 'max', { five: 97 });
  const fiveFinal = message(run(home, { sid: 'b' }));
  check('5h 最終: 畳ませる', wrapsNow(fiveFinal), fiveFinal);
  check('5h 最終: そこで終了させる', fiveFinal.includes('セッションを終了'), fiveFinal);

  writeState(home, 'max', { seven: 92 });
  const weekWarn = message(run(home, { sid: 'c' }));
  check('週次 警告: 畳ませない', !wrapsNow(weekWarn), weekWarn);
  check('週次 警告: 数日戻らないことを伝える', weekWarn.includes('数日間'), weekWarn);

  writeState(home, 'max', { seven: 97 });
  const weekFinal = message(run(home, { sid: 'd' }));
  check('週次 最終: 畳ませる', wrapsNow(weekFinal), weekFinal);

  // 片方が最終段なら、もう片方が警告段でも全体としては畳ませる。
  writeState(home, 'max', { five: 92, seven: 97 });
  const both = message(run(home, { sid: 'e' }));
  check('5h 警告 + 週次 最終: 1通にまとめる',
    both.includes('5時間枠:') && both.includes('週次枠:') && both.split('[usage-tracker]').length === 2, both);
  check('5h 警告 + 週次 最終: 強い方(畳ませる)に倒れる', wrapsNow(both), both);
}

// ---- 促さない条件 ----
console.log('\n促さない条件');
{
  const home = sandbox('skip', 'max');
  writeState(home, 'max', { seven: 99, ageMin: 16 });
  check('collect-state が 15 分より古ければ促さない', message(run(home, { sid: 'a' })) === '');

  // リセット済みの枠の使用率は「前の枠」のもの。これで促すと枠が切り替わった直後に誤発火する。
  writeState(home, 'max', { seven: 99, sevenResetMin: -1 });
  check('リセット済みの枠では促さない', message(run(home, { sid: 'b' })) === '');

  fs.rmSync(path.join(home, '.claude', 'usage-tracker', 'collect-state-max.json'));
  check('collect-state が無ければ黙って何もしない', message(run(home, { sid: 'c' })) === '');
}

// ---- 発火は枠ごと・段ごとに1回 ----
console.log('\n発火の重複抑止');
{
  const home = sandbox('once', 'max');
  writeState(home, 'max', { seven: 92 });
  check('1回目は促す', message(run(home, { sid: 'x' })) !== '');
  check('同じ枠・同じ段では2回目を促さない', message(run(home, { sid: 'x' })) === '');
  check('別セッションには促す(フラグはセッションごと)', message(run(home, { sid: 'y' })) !== '');

  writeState(home, 'max', { seven: 97 });
  const up = message(run(home, { sid: 'x' }));
  check('段が上がれば同じセッションでも促す', up.includes('【最終】'), up);
  check('最終段のあとに警告段は出さない', message(run(home, { sid: 'x' })) === '');

  // /login でアカウントが変われば消費する枠も変わる。前のアカウントのフラグを引き継ぐと
  // 新しい枠の枠切れを予告しそこねる。
  fs.writeFileSync(
    path.join(home, '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { subscriptionType: 'team' } }), 'utf8'
  );
  writeState(home, 'team', { seven: 92 });
  check('アカウントが変われば発火フラグを引き継がない', message(run(home, { sid: 'x' })) !== '');
}

// ---- Stop フック ----
// ツールを使わないターンでは PostToolUse が発火しないため、Stop で取りこぼしを拾う。
console.log('\nStop フック');
{
  const home = sandbox('stop', 'max');
  writeState(home, 'max', { seven: 92 });
  const r = run(home, { sid: 'a', event: 'Stop' });
  check('Stop では exit 2 で stderr に出す', r.code === 2 && r.err.includes('週次枠:'), `code=${r.code} err=${r.err}`);

  const again = run(home, { sid: 'b', event: 'Stop', input: { stop_hook_active: true } });
  check('自分が止めたターンでは再度止めない', again.code === 0 && again.err === '', `code=${again.code} err=${again.err}`);
}

console.log(`\n  ${state.pass} PASS / ${state.fail} FAIL`);
process.exitCode = state.fail ? 1 : 0;
