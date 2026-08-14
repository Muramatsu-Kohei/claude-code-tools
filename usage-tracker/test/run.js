// テストランナー。test/*.test.js を順に子プロセスで走らせ、終了コードを集計する。
// 使い方: node test/run.js [名前の一部]
//
// (account-guard/test/run.js と同じ構造・流儀に揃えてある)
//
// 起動時に test/.tmp/ を丸ごと消す(transcript.test.js は偽 HOME を test/.tmp/transcript の
// ような自分専用のサブディレクトリに作る)。個々のテストファイルは自分専用のサブディレクトリ
// だけを消す設計なので、.tmp 全体を消すのはここが正しい置き場所。これにより前回実行の孤児
// (ハングしたまま残ったプロセスが握っていたファイル。何がハングを起こすのかは未解明)を
// 毎回一掃できる(issue #8)。
//
// ただしフィルタ(process.argv[2])指定時は全削除をスキップする。フィルタ指定は
// 「別スイートを並列実行中」を意味しうるため、他方のサンドボックスを巻き添えで消す事故を
// 避ける(account-guard.test.js:15-18 が記録した事故と同型)。この場合は全実行時の
// 孤児掃除(issue #8)が効かないままになるので、その旨をログに出す。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = path.join(__dirname, '.tmp');
const only = process.argv[2];

function main() {
  // .tmp を消せなかったかどうか。最後に「すべて PASS なのに非ゼロ終了」の理由を出すために持つ。
  let cleanupFailed = false;
  if (only) {
    console.log(`test/.tmp の全削除をスキップ(フィルタ指定 "${only}")。前回実行の孤児が残っていても今回は一掃されない(issue #8)。`);
  } else {
    // force: true だけでは足りない場面がある: 子プロセスが .tmp 配下をカレントディレクトリに
    // していたりファイルハンドルを開いたままだと、Windows は force: true でも EBUSY / EPERM を
    // 投げて rmSync ごと失敗する(account-guard で issue #8 として実際に踏んだ形)。無言で
    // クラッシュすると原因が読めないメッセージだけが残る。
    // maxRetries/retryDelay は Windows のハンドル解放が非同期に少し遅れて終わることがある
    // ことへの保険(実体は消えているのにハンドルの解放待ちで一瞬だけ触れない、という
    // レースを吸収する)。それでも失敗したら孤児プロセスの残存を明示して案内する。
    try {
      fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      console.error(`test/.tmp の削除に失敗した: ${e.message}`);
      console.error('孤児プロセスが test/.tmp 配下をカレントディレクトリにしているか、ファイルを開いたままの可能性がある。');
      console.error('Windows での確認: `Get-Process node` で残存プロセスを確認し、`Stop-Process -Id <PID> -Force` で終了させてから再実行する。');
      console.error('残骸を抱えたまま続行する。影響を受けるのは、そのサブディレクトリを使うスイートだけ。');
      // ここで止めない。各テストは自分のサブディレクトリを消してから作り直すので、残骸の影響は
      // それを使うスイートに閉じる。掴んでいるのが孤児とは限らず(Defender のスキャンや
      // エクスプローラの一時ロックでも EBUSY は出る)、そのたびに 1 本も走らないのは代償が
      // 大きい。ただし消せなかった事実は非ゼロ終了として残す(警告だけだと CI のログに埋もれ、
      // 掃除の失敗を見落とす)。process.exit を使わないのは、Windows では stdout がパイプ
      // (CI のログ収集等)のとき書き込みが非同期になり、直後に exit すると直前の console.error が
      // 切れて届かないことがあるため(3 ツール共通の作法で、同じ理由のコメントが
      // account-guard/test/harness.js にもある)。
      cleanupFailed = true;
      process.exitCode = 1;
    }
  }

  const files = fs.readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.js'))
    .filter((f) => (only ? f.includes(only) : true))
    .sort();

  if (!files.length) {
    console.error(only ? `${only} に一致するテストがない。` : 'test/*.test.js が見つからない。');
    process.exitCode = 1;
    return;
  }

  const failed = [];
  for (const f of files) {
    console.log(`\n=== ${f} ===`);
    // 直列に走らせる。偽 HOME は別々だが、出力が混ざるより読める方を取る。
    //
    // stdin は 'ignore' にする。テストファイル自身は stdin を読まないが、継承したままだと
    // このランナーの stdin(端末や CI のパイプ)がそのままぶら下がりかねない。
    // ファイル単位の timeout。テストが内部で起動する子プロセス(run() 経由)には個々に
    // 30 秒の保険が掛かっているが、それでは捕まえられない場所(テスト本体のループや fs の待ち)で
    // 固まる余地は残るので、ここでも締める。このディレクトリの *.test.js は 1 本なので、
    // timeout しても 2 分で、job 側の timeout-minutes: 15 には十分収まる(CI は 1 job = 1 ツール
    // で回すので、この計算はこのディレクトリの本数だけで閉じる)。値は他の 2 ツールと揃えてあり、
    // テストを増やしても 5 本までは同じ 2 分で 10 分に収まる。実測は 1 分未満。
    const r = spawnSync(process.execPath, [path.join(__dirname, f)], {
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
      timeout: 120000,
      killSignal: 'SIGKILL',
    });
    // signal で終了したときは status が null になる。timeout はその代表例だが、OOM killer や
    // 外部からの kill でも signal は入るので、timeout と断定はできない。単なる異常終了と
    // 区別できないと「なぜか失敗した」で終わってしまうので、理由をここで出す。
    if (r.signal) {
      console.log(`  (${f} は signal で強制終了: ${r.signal})`);
      // Windows には process group kill が無く、ここで死ぬのは直下の子(このテストファイル)だけ。
      // テストが起こした孫(sessions.js 等)は生き残り、.tmp を掴んだまま孤児になる — この網が
      // 捕まえたい場面で、自分が issue #8 と同じ状態を作ってしまう。次回実行が理由の読めない
      // EBUSY で止まる前に、ここで名指ししておく。
      console.log('   孫プロセスが残って test/.tmp を掴んでいる可能性がある(issue #8)。`Get-Process node` で確認し、残っていれば `Stop-Process -Id <PID> -Force` で終了させること。');
    }
    // spawn 自体に失敗したとき(ENOENT・EAGAIN 等)は status も signal も無く、理由が
    // r.error にしか出ない。拾わないと末尾の「失敗:」にファイル名が並ぶだけになる。
    if (r.error) console.log(`  (${f} は起動に失敗: ${r.error.message})`);
    if (r.status !== 0) failed.push(f);
  }

  console.log('');
  if (failed.length) {
    console.log(`失敗: ${failed.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${files.length} ファイル すべて PASS`);
  // 全 PASS でも .tmp を消せていなければ終了コードは非ゼロのまま。「すべて PASS なのに赤い」の
  // 理由がどこにも出ないと、掃除の失敗を見落としたまま次に進んでしまう。
  if (cleanupFailed) console.log('(ただし test/.tmp を消せていないので終了コードは非ゼロ)');
}

main();
