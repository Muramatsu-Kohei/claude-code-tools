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
// (ハングしたまま残ったプロセスが握っていたファイル。何がハングを起こすのかは未解明)を
// 毎回一掃できる(issue #8)。
//
// ただしフィルタ(process.argv[2])指定時と SWAP_SCRIPT 指定時は全削除をスキップする。
// フィルタ指定は「別スイートを並列実行中」を意味しうる(例: swap と fault を並列に流すと、
// 片方の起動時削除がもう片方のサンドボックスを巻き添えにする — account-guard.test.js:15-18 が
// 記録した事故そのもの)。SWAP_SCRIPT は変異テスト手順が .tmp に変異版 swap.js を置いて指す
// 仕組みで、ここで消すとその変異版ごと消えてしまう。この env は reachable.test.js と
// fault.test.js の 2 本が読むので、片方の感度だけを見たいときは名前で絞ること(絞らないと
// もう片方も変異版に対して走り、手順が意図していない結果が混ざる)。
// この場合は全実行時の孤児掃除(issue #8)が効かないままになるので、その旨をログに出す。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = path.join(__dirname, '.tmp');
const only = process.argv[2];

function main() {
  // .tmp を消せなかったかどうか。最後に「すべて PASS なのに非ゼロ終了」の理由を出すために持つ。
  let cleanupFailed = false;
  if (only || process.env.SWAP_SCRIPT) {
    const reasons = [];
    if (only) reasons.push(`フィルタ指定 "${only}"`);
    if (process.env.SWAP_SCRIPT) reasons.push('SWAP_SCRIPT 指定');
    console.log(`test/.tmp の全削除をスキップ(${reasons.join(' / ')})。前回実行の孤児が残っていても今回は一掃されない(issue #8)。`);
  } else {
    // force: true だけでは足りない場面がある: 孤児プロセス(issue #8 参照)が .tmp 配下を
    // カレントディレクトリにしていたりファイルハンドルを開いたままだと、Windows は
    // force: true でも EBUSY / EPERM を投げて rmSync ごと失敗する。しかもこれは「まさに
    // この掃除が必要な場面」(=孤児が残っている場面)そのものなので、無言でクラッシュすると
    // 原因が読めないメッセージだけが残る。
    // maxRetries/retryDelay は Windows のハンドル解放が非同期に少し遅れて終わることがある
    // ことへの保険(実体は消えているのにハンドルの解放待ちで一瞬だけ触れない、という
    // レースを吸収する)。それでも失敗したら孤児プロセスの残存を明示して案内する。
    try {
      fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      console.error(`test/.tmp の削除に失敗した: ${e.message}`);
      console.error('孤児プロセスが test/.tmp 配下をカレントディレクトリにしているか、ファイルを開いたままの可能性がある(issue #8)。');
      console.error('Windows での確認: `Get-Process node` で残存プロセスを確認し、`Stop-Process -Id <PID> -Force` で終了させてから再実行する。');
      console.error('残骸を抱えたまま続行する。影響を受けるのは、そのサブディレクトリを使うスイートだけ。');
      // ここで止めない。各テストは自分のサブディレクトリを消してから作り直すので、残骸の影響は
      // それを使うスイートに閉じる。掴んでいるのが孤児とは限らず(Defender のスキャンや
      // エクスプローラの一時ロックでも EBUSY は出る)、そのたびに 1 本も走らないのは代償が
      // 大きい。ただし消せなかった事実は非ゼロ終了として残す(警告だけだと CI のログに埋もれ、
      // issue #8 の再現を見落とす)。process.exit を使わないのは harness.js:23-26 と同じ理由で、
      // Windows では stdout がパイプ(CI のログ収集等)のとき書き込みが非同期になり、直後に
      // exit すると直前の console.error が切れて届かないことがある。
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
    // 直列に走らせる。偽 HOME は別々だが、git init や外部プロセスを使うので
    // 並列にして出力が混ざるより読める方を取る。
    //
    // stdin は 'ignore' にする。テストファイル自身は stdin を読まないが、継承したままだと
    // このランナーの stdin(端末や CI のパイプ)がそのままぶら下がる。spawnSync の stdio 指定は
    // input と違って実際に効くので、ここで閉じておく(各ラッパーが使う execFileSync は元から
    // stdio を 3 つとも pipe で開くため、子が親の TTY を握ることはない)。
    // ファイル単位の timeout。各ラッパー(execGuardScript 等)が個々の子プロセスに 30 秒の
    // 保険を掛けているが、それでは捕まえられない場所(テスト本体のループや fs の待ち)で
    // 固まる余地は残る。CI でハングしたまま job のタイムアウトまで枠を焼くのを避けるため、
    // ここでも締める。このディレクトリの *.test.js は 5 本なので、全ファイルが timeout しても
    // 5 × 120000ms = 10 分に収まるよう 2 分に取ってある(3 分だと 15 分になり job 側の
    // timeout-minutes: 15 と等しくなってしまい、checkout や setup-node の分だけ確実に超えて、
    // ランナー自身の集計(「失敗: …」)が出る前に GitHub に殺される)。CI は 1 job = 1 ツールで
    // 回すので、この計算はこのディレクトリの本数だけで閉じる。実測は最長ファイルでも 1 分未満で、
    // 2 分にはその実測に対しても 2 倍の余裕がある。
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
      // テストが execFileSync で起こした孫(swap.js 等)は生き残り、.tmp を掴んだまま孤児になる
      // — この網が捕まえたい場面で、自分が issue #8 の状態を作ってしまう。次回実行が理由の
      // 読めない EBUSY で止まる前に、ここで名指ししておく。
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
