'use strict';
// swap.test.js の「端末へのエラー出力」テスト専用のプリロードフック。
//
// テストは子プロセスの stderr をパイプで受けるので、failText の端末向け分岐(process.stderr.isTTY)
// には普通に起動しても入らない。`NODE_OPTIONS=--require <このファイルの絶対パス>` で先読みさせ、
// stderr を端末に見せかける。
//
// どちらの経路で書かれたかを出力から判別できるよう、process.stderr.write を通った文面には
// 先頭に [tty] を付ける。fs.writeSync(2) の経路(パイプ・ファイル向け)にはこの印が付かない。
// 書き込み自体は fs.writeSync で同期的に行う。本物の stream.write はパイプ相手だと非同期に
// なり得て、直後の process.exit で文面が切れると、経路の判定ではなく切れ方を見るテストになる。

const fs = require('fs');

Object.defineProperty(process.stderr, 'isTTY', { value: true, configurable: true });
process.stderr.write = (chunk) => {
  fs.writeSync(2, '[tty]' + chunk);
  return true;
};
