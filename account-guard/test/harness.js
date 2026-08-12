'use strict';
// swap.test.js と account-guard.test.js の冒頭で、state カウンタ・check() 関数・最後の
// 集計と process.exit がコメントごとほぼ同一の形のまま重複していた。テストの実体
// (sandbox・creds・runSwap・run・decision のようなファイル固有のヘルパー)は対象ごとに
// 違うのでここには置かず、進捗を数えて終了コードを決めるだけの共通部分だけを切り出す。
//
// 集計の表示は以前 "N PASS / N FAIL"(swap 側)と "N passed, N failed"(guard 側)で
// 言い回しが割れていた。同じ処理を別の文言で書いていただけなので、共通化にあわせて
// 前者に揃える。

function makeHarness() {
  const state = { pass: 0, fail: 0 };

  // extra は失敗時の手掛かり。落ちた行だけでは原因が分からないことが多いので実出力を添える
  function check(label, cond, extra) {
    if (cond) state.pass++; else state.fail++;
    const tail = extra && !cond ? `\n      ${String(extra).replace(/\n/g, '\n      ')}` : '';
    console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}${tail}`);
  }

  // 全テストの最後に呼ぶ。件数を表示し、1 件でも FAIL があれば終了コードを非 0 にする
  // (CI やラッパースクリプトが exit code だけで失敗を検知できるようにするため)。
  // 終了は process.exit ではなく exitCode で行う。Windows では出力先がパイプ(CI のログ収集や
  // `node test/swap.test.js | tee log`)だと書き込みが非同期になり、exit を即座に呼ぶと最後の
  // 集計行や直前の FAIL 明細が切れて届かない。report はテストファイルの最終行なので、
  // 立てるだけで自然に同じ終了コードで終わる。
  // 成功時に 0 を代入しないのは、既に別の理由で立っている非 0 を消さないため
  // (unhandledRejection のハンドラを足したときに、落ちた実行が緑で終わるようになる)。
  function report() {
    console.log(`\n  ${state.pass} PASS / ${state.fail} FAIL`);
    if (state.fail) process.exitCode = 1;
  }

  return { state, check, report };
}

module.exports = { makeHarness };
