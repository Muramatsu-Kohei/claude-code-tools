// テストランナー。test/*.test.js を順に子プロセスで走らせ、終了コードを集計する。
// 使い方: node test/run.js [名前の一部]
//
// (account-guard/test/run.js と同じ構造・流儀に揃えてある)
//
// 起動時に test/.tmp/ を丸ごと消す(transcript.test.js が偽 HOME をこの配下に作るため)。
// ただしフィルタ(process.argv[2])指定時は全削除をスキップする。フィルタ指定は
// 「別スイートを並列実行中」を意味しうるため、他方のサンドボックスを巻き添えで消す事故を
// 避ける(account-guard.test.js:15-18 が記録した事故と同型)。この場合は全実行時の
// 孤児掃除(issue #8)が効かないままになるので、その旨をログに出す。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = path.join(__dirname, '.tmp');
const only = process.argv[2];

if (only) {
  console.log(`test/.tmp の全削除をスキップ(フィルタ指定 "${only}")。前回実行の孤児が残っていても今回は一掃されない(issue #8)。`);
} else {
  // force: true だけでは足りない場面がある: 子プロセスが .tmp 配下をカレントディレクトリに
  // していたりファイルハンドルを開いたままだと、Windows は force: true でも EBUSY / EPERM を
  // 投げて rmSync ごと失敗する(account-guard で issue #8 として実際に踏んだ形)。無言で
  // クラッシュするとランナーが 1 本もテストを走らせずに落ち、原因が読めないメッセージだけが残る。
  // maxRetries/retryDelay は Windows のハンドル解放が非同期に少し遅れて終わることがある
  // ことへの保険(実体は消えているのにハンドルの解放待ちで一瞬だけ触れない、という
  // レースを吸収する)。それでも失敗したら孤児プロセスの残存を明示して案内する。
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    console.error(`test/.tmp の削除に失敗した: ${e.message}`);
    console.error('孤児プロセスが test/.tmp 配下をカレントディレクトリにしているか、ファイルを開いたままの可能性がある。');
    console.error('Windows での確認: `Get-Process node` で残存プロセスを確認し、`Stop-Process -Id <PID> -Force` で終了させてから再実行する。');
    process.exit(1);
  }
}

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
  // 直列に走らせる。偽 HOME は別々だが、出力が混ざるより読める方を取る。
  //
  // stdin は 'ignore' にする。テストファイル自身は stdin を読まないが、継承したままだと
  // このランナーの stdin(端末や CI のパイプ)がそのままぶら下がりかねない。
  // ファイル単位の timeout。テストが内部で起動する子プロセス(run() 経由)には個々に
  // タイムアウトを掛けていないため、CI でハングしたまま job のタイムアウトまで枠を焼くのを
  // 避けるため、ここで締める。実測は数秒程度なので、遅いランナーを見込んでも
  // 10 分あれば通常実行が引っかかることはない。
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], {
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
    timeout: 600000,
    killSignal: 'SIGKILL',
  });
  // signal で終了したときは status が null になる。timeout はその代表例だが、OOM killer や
  // 外部からの kill でも signal は入るので、timeout と断定はできない。単なる異常終了と
  // 区別できないと「なぜか失敗した」で終わってしまうので、理由をここで出す。
  if (r.signal) console.log(`  (${f} は signal で強制終了: ${r.signal})`);
  if (r.status !== 0) failed.push(f);
}

console.log('');
if (failed.length) {
  console.log(`失敗: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`${files.length} ファイル すべて PASS`);
