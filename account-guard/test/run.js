// テストランナー。test/*.test.js を順に子プロセスで走らせ、終了コードを集計する。
// 使い方: node test/run.js [名前の一部]
//
// (claude-worklog/test/run.js と同じ構造・流儀に揃えてある)
//
// 起動時に test/.tmp/ を丸ごと消す(作り直しは各テストが自分のサブディレクトリを
// recursive で掘るときに一緒に行われるので、ここでは消すだけでよい)。個々のテストファイルは自分専用の
// サブディレクトリ(.tmp/guard・.tmp/swap 等)だけを消す設計になっていて、.tmp 全体は
// 消さない(account-guard.test.js:15-18 参照。以前は各ファイルが .tmp 全体を消していたため、
// 同時に走らせた別スイートのサンドボックスを巻き添えで消す事故があった)。ここでランナーが
// 全テストの前に 1 度だけ丸ごと消すのが正しい置き場所で、これにより前回実行の孤児
// (stdin 待ちでハングしたまま残ったプロセスが握っていたファイル)を毎回一掃できる(issue #8)。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = path.join(__dirname, '.tmp');
fs.rmSync(TMP, { recursive: true, force: true });

const only = process.argv[2];
const files = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.js'))
  .filter((f) => (only ? f.includes(only) : true))
  .sort();

if (!files.length) {
  console.error(only ? `${only} に一致するテストがない。` : 'test/*.test.js が見つからない。');
  process.exit(1);
}

const failed = [];
for (const f of files) {
  console.log(`\n=== ${f} ===`);
  // 直列に走らせる。偽 HOME は別々だが、git init や外部プロセスを使うので
  // 並列にして出力が混ざるより読める方を取る。
  //
  // stdin は 'ignore' にする。テストファイル自身は stdin を読まないが、継承したままだと
  // このランナーの stdin(端末や CI のパイプ)がそのままぶら下がり、テストが内部で起動する
  // 子プロセス(account-guard.js / swap.js)の stdin 継承と同じ形の待ちを生みかねない。
  // 各ラッパー側(execGuardScript 等)でも input を明示しているが、ここでも締めておく。
  // ファイル単位の timeout。各ラッパー(execGuardScript 等)が個々の子プロセスに 30 秒の
  // 保険を掛けているが、それでは捕まえられない場所(テスト本体のループや fs の待ち)で
  // 固まる余地は残る。CI でハングしたまま job のタイムアウトまで枠を焼くのを避けるため、
  // ここでも締める。最長の reachable.test.js が実測 40 秒程度なので、遅いランナーを見込んでも
  // 10 分あれば通常実行が引っかかることはない。
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
    timeout: 600000,
    killSignal: 'SIGKILL',
  });
  // timeout で殺されたときは status が null になる。単なる異常終了と区別できないと
  // 「なぜか失敗した」で終わってしまうので、理由をここで出す。
  if (r.signal) console.log(`  (${f} は timeout で強制終了: ${r.signal})`);
  if (r.status !== 0) failed.push(f);
}

console.log('');
if (failed.length) {
  console.log(`失敗: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`${files.length} ファイル すべて PASS`);
