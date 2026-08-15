'use strict';

// main() が横取りするサブコマンドの表。swap.js と test/fault.test.js が共有する。
//
// swap.js から切り出したのは、同じ知識を 2 箇所が必要とするのに、片方が require で
// 読めないからだった。
//   ・swap.js: 同名のスロットを作らせない予約(validateName)と、案内文にスロット名を
//     出してよいかの判定(restorableByName)
//   ・test/fault.test.js: 故障注入 property test が回す操作列(pickOperation)
// テストは swap.js を子プロセスとして起動して出力を検査する方式なので、swap.js の
// 定数を require では読めず、操作列を手で書き写すしかなかった。書き写すと「新しい
// サブコマンドを足したらテストの操作列にも足す」という規約が要るが、規約は守られない
// ことがある(予約語チェックが cmdSave 側に無かったために accounts/save.json を作れて
// しまい、復元する引数の形が存在しないスロットが残せた、という実例がこのツールにある)。
// 表から生成すれば、ここへ 1 行足すだけで property test の守備範囲に自動で入る。
//
// このモジュールは依存を持たない純粋なデータにしておく。swap.js は読み込まれた時点で
// credentials.js の検証と main() の実行まで走るので、テストから require すると
// サンドボックスではなく本物のホームディレクトリを触りに行ってしまう。

// faultArgvs の中でスロット名に置き換わる語。NAME_RE(英数字・ハイフン・アンダースコア)
// が通さない文字を含めてあるので、実際のスロット名と取り違えることはない。
const NAME_PLACEHOLDER = '<name>';

// name:       main() が第一引数として横取りする語。この名前のスロットは復元できない。
// faultArgvs: 故障注入 property test が回す代表的な引数列。空配列は「credentials も
//             accounts も触らないので、回しても検査するものが無い」の意。
const SUBCOMMANDS = [
  {
    name: 'save',
    faultArgvs: [
      ['save'],
      ['save', NAME_PLACEHOLDER],
      ['save', NAME_PLACEHOLDER, '--force'],
    ],
  },
  {
    name: 'warmup',
    // --yes を必ず含める。warmup は標準入力が TTY でなく --yes も無いときはその場で
    // 中止する仕様(docs/account-separation.md §5.3 の「自動実行の歯止め」)なので、
    // 素朴に ['warmup'] を回すと子プロセスは何も触らずに終わり、全ケースが何も
    // 検査しないまま緑になる。
    faultArgvs: [['warmup', '--yes']],
  },
  // help 系は表示だけで状態を触らない。予約(同名スロットを作らせない)にだけ効かせ、
  // 操作列には入れない。
  { name: 'help', faultArgvs: [] },
  { name: '-h', faultArgvs: [] },
  { name: '--help', faultArgvs: [] },
];

// サブコマンドではない素の呼び出し。状態表示・復元・強制復元の 3 形。表の外に置くのは、
// これらが「予約すべき名前」を持たないため(DISPATCHED_NAMES に混ぜると、スロット名を
// 1 つも作れなくなる)。
const BARE_FAULT_ARGVS = [
  [],
  [NAME_PLACEHOLDER],
  [NAME_PLACEHOLDER, '--force'],
];

// 仕様は確定しているが、まだ main() が横取りしていないサブコマンド名。
// 実装前にスロット名として取られると、実装した瞬間に `swap <name>` がそのスロットの
// 復元ではなくサブコマンドとして解釈され、復元する引数の形が失われる。予約は 1 語ぶんの
// 自由と引き換えにそれを塞ぐので、実装を待たずにここへ入れる。実装したら SUBCOMMANDS
// へ移す(warmup が実際にそうした)。
//
// いまは空。次に「仕様確定・未実装」のサブコマンドを予約するときは、ここへ名前を足すのと
// 一緒に swap.test.js の予約テストを復活させること(warmup を実装した際に検証対象が
// 無くなって消したもので、`git log -S RESERVED_ONLY_NAMES` からたどれる)。
const RESERVED_ONLY_NAMES = [];

module.exports = {
  NAME_PLACEHOLDER,
  SUBCOMMANDS,
  BARE_FAULT_ARGVS,
  RESERVED_ONLY_NAMES,
};
