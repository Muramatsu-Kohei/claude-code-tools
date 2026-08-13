'use strict';
// 故障注入 property test(fault.test.js)専用のプリロードフック。
//
// swap.js は fault.test.js から見て子プロセスなので、テスト側が直接 fs を差し替える手段が無い。
// `NODE_OPTIONS=--require <このファイルの絶対パス>` で子プロセスの起動時に先読みさせ、
// require('fs') が返すモジュール本体のメソッドを故障注入版に置き換える。swap.js・credentials.js
// はどちらも `const fs = require('fs')` でこのオブジェクトをそのまま束縛するので、モジュール
// キャッシュの共有により、ここでの差し替えが両方に効く。
//
// 環境変数 SWAP_FAULT が無いとき(通常の子プロセス起動、および fault.test.js 自身が
// WRAPPED_CALLS を読むためだけに require したとき)は、下の分岐に入らず何も差し替えない。
// fault.test.js の親プロセス側で SWAP_FAULT を設定しないのはこのため
// (親プロセスの fs まで壊すと、テストランナー自身のファイル操作が壊れる)。

const fs = require('fs');

// 実際に swap.js / credentials.js が呼んでいる同期 API のうち、この 7 つだけを包む
// (openSync/readSync/closeSync/statSync/rmSync は両ファイルとも呼んでいない。grep で確認済み)。
// fault.test.js もこの一覧を故障の対象候補として使うので、ここを更新したら fault.test.js 側も
// 追随させること(重複を持つ以上、片方だけ直すとテストが存在しない call 名を指定してしまう)。
const WRAPPED_CALLS = [
  'writeFileSync', 'renameSync', 'copyFileSync', 'unlinkSync',
  'readFileSync', 'mkdirSync', 'readdirSync',
];

// 書き込む内容を先頭半分に切り詰める。中断状態(電源断・kill -9)は「まったく書けなかった」
// よりも「途中まで書けた」ほうが再現として重要で、切り詰めた位置より手前のトークンが
// rawHasRecoverableToken で救える設計になっているかを確かめたい。
function halveData(data) {
  if (Buffer.isBuffer(data)) return data.subarray(0, Math.floor(data.length / 2));
  if (typeof data === 'string') return data.slice(0, Math.floor(data.length / 2));
  // 想定外の型(TypedArray 等)。swap.js は文字列か Buffer しか渡さないのでここには来ない想定だが、
  // 来ても素通しにして落とさない。
  return data;
}

// プロセスを即座に落とす。process.exit を使うのは、SIGKILL は Windows では TerminateProcess への
// 疑似変換になり環境によって挙動が揺れるため(このリポジトリの CI/開発機は Windows)。exit code
// 137 は kill -9 の慣例(128+9)に合わせてあるだけで、値そのものに意味を持たせて分岐はしない。
function killNow() {
  process.exit(137);
}

if (process.env.SWAP_FAULT) {
  let spec;
  try {
    spec = JSON.parse(process.env.SWAP_FAULT);
  } catch (e) {
    // 壊れた指定を黙って素通しすると、注入したつもりの故障が起きないまま子プロセスが
    // 普通に成功し、property test が「異常系を確かめられていないのに PASS」してしまう。
    // 気づけるように、ここで確実に落とす。
    throw new Error('SWAP_FAULT の JSON をパースできません: ' + e.message);
  }

  // 呼び出し回数は call ごとに数える(仕様どおり)。この counts は子プロセスの起動ごとに
  // 新しく作られる = 1 回の swap 実行ごとに 1 からリセットされる。
  const counts = Object.create(null);

  // match は「呼び出しに渡された引数のどれかに、この部分文字列を含むものがあるか」で絞り込む。
  // 未指定なら絞り込まない(必須ではない、と仕様にある)。
  function matches(args) {
    if (spec.match === undefined) return true;
    return args.some((a) => typeof a === 'string' && a.includes(spec.match));
  }

  // nth 番目に当たるかどうかの判定。絞り込みを通った呼び出しだけを数える
  // (match で絞ったのに絞り込み前の回数で nth を数えると、「絞り込んだ対象の n 回目」という
  // 直感と食い違う)。
  function shouldFire(call, args) {
    if (spec.call !== call) return false;
    if (!matches(args)) return false;
    counts[call] = (counts[call] || 0) + 1;
    if (spec.nth === undefined) return true;
    return counts[call] === spec.nth;
  }

  function wrap(name) {
    const orig = fs[name];
    fs[name] = function (...args) {
      if (!shouldFire(name, args)) return orig.apply(fs, args);

      if (spec.kind === 'throw') {
        // 呼び出しそのものを実行せずに投げる = 「OS がその場で失敗を返した」の再現。
        // e.code を必ず設定するのは、swap.js がほぼすべての分岐を e.code で振り分けるため
        // (e.message だけを見ている箇所は無い)。
        const e = new Error('SWAP_FAULT: ' + name + ' に ' + (spec.code || 'EFAULT') + ' を注入');
        e.code = spec.code || 'EFAULT';
        throw e;
      }

      if (spec.kind === 'kill') {
        // 「実行してから」落ちる中断状態を作る。実行結果は誰にも返せない(このあと即座に
        // プロセスが終わるため)が、実際に書けた/書けなかったの分岐は本物どおりに再現する。
        const result = orig.apply(fs, args);
        killNow();
        return result;
      }

      if (spec.kind === 'truncate') {
        // 仕様上フルに定義されているのは writeFileSync(第 2 引数が書き込む中身)のケースだけ。
        // それ以外の call に対する truncate 指定は「中身を切り詰める」余地が無い
        // (readdirSync や unlinkSync に「書く内容」は無い)ので、kill と同じ
        // 「実行してから落ちる」にフォールバックする(未定義のまま無視するより、
        // 中断状態を作るという意図には近い)。
        const args2 = name === 'writeFileSync'
          ? [args[0], halveData(args[1]), ...args.slice(2)]
          : args;
        const result = orig.apply(fs, args2);
        killNow();
        return result;
      }

      // 未知の kind。何もせず素通しする(呼び出し自体は起こす)。
      return orig.apply(fs, args);
    };
  }

  for (const name of WRAPPED_CALLS) wrap(name);
}

module.exports = { WRAPPED_CALLS };
