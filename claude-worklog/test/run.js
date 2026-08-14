// テストランナー。test/*.test.js を順に子プロセスで走らせ、終了コードを集計する。
// 使い方: node test/run.js [名前の一部]
//
// (account-guard/test/run.js と同じ構造・流儀に揃えてある)
//
// 起動時に test/.tmp/ を丸ごと消す(lib.js の tmpDir() が各テストファイルの専用サブ
// ディレクトリをこの配下に掘るため)。個々のテストファイルは自分専用のサブディレクトリ
// (.tmp/add・.tmp/scope 等)だけを消す設計なので、.tmp 全体を消すのはここが正しい置き場所。
// これにより前回実行の孤児(stdin 待ちでハングしたまま残ったプロセスが握っていたファイル)を
// 毎回一掃できる(issue #8)。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = path.join(__dirname, '.tmp');
// force: true だけでは足りない場面がある: 孤児プロセス(issue #8 参照)が .tmp 配下を
// カレントディレクトリにしていたりファイルハンドルを開いたままだと、Windows は
// force: true でも EBUSY / EPERM を投げて rmSync ごと失敗する。しかもこれは「まさに
// この掃除が必要な場面」(=孤児が残っている場面)そのものなので、ここで無言で
// クラッシュするとランナーが 1 本もテストを走らせずに落ち、原因が読めないメッセージだけが残る。
// maxRetries/retryDelay は Windows のハンドル解放が非同期に少し遅れて終わることがある
// ことへの保険(実体は消えているのにハンドルの解放待ちで一瞬だけ触れない、という
// レースを吸収する)。それでも失敗したら孤児プロセスの残存を明示して案内する。
try {
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch (e) {
  console.error(`test/.tmp の削除に失敗した: ${e.message}`);
  console.error('孤児プロセスが test/.tmp 配下をカレントディレクトリにしているか、ファイルを開いたままの可能性がある(issue #8)。');
  console.error('Windows での確認: `Get-Process node` で残存プロセスを確認し、`Stop-Process -Id <PID> -Force` で終了させてから再実行する。');
  process.exit(1);
}

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
  // 子プロセス(worklog.js)の stdin 継承と同じ形の待ちを生みかねない。lib.js の runner() でも
  // input を明示しているが、ここでも締めておく。
  // ファイル単位の timeout。runner() が個々の子プロセスに 30 秒の保険を掛けているが、
  // それでは捕まえられない場所(テスト本体のループや fs の待ち)で固まる余地は残る。CI で
  // ハングしたまま job のタイムアウトまで枠を焼くのを避けるため、ここでも締める。
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
