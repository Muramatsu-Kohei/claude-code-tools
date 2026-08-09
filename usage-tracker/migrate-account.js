'use strict';
// usage.jsonl の既存行にアカウント識別子(acct)を後から付ける、1回だけ実行する移行スクリプト。
//
// collect.js が acct を書くようになる前に貯まった行にはこのフィールドが無く、analyze.js は
// それらを "unknown" として扱う。既定の分析は現在のアカウントに絞って集計するため、
// 放置すると過去のデータが丸ごと集計から外れてしまう。
//
// 「acct が無い＝当時の唯一のアカウント」であることは、移行する本人にしか判断できない。
// したがって付与する値は必ず引数で指定させ、既定値は持たない。取り違えたまま実行すると
// 別アカウントの枠のデータとして混ざり、回帰の傾きが静かに狂う。
//
// 書き換えは一時ファイルへ書いてから置き換える。途中で落ちても元のログが半端な状態で
// 残らないようにするため。実行前のバックアップも必ず残す。

const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || '.';
const DEFAULT_LOG = path.join(HOME, '.claude', 'usage-tracker', 'usage.jsonl');

function parseArgs(argv) {
  const opts = { acct: null, log: DEFAULT_LOG, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--acct') opts.acct = argv[++i];
    else if (a === '--log') opts.log = argv[++i];
    else if (a === '--dry-run' || a === '-n') opts.dryRun = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else {
      console.error(`不明な引数: ${a}`);
      opts.help = true;
    }
  }
  return opts;
}

function usage() {
  console.log(`使い方: node migrate-account.js --acct <アカウント名> [--dry-run] [--log <パス>]

  --acct     acct を持たない行に付けるアカウント名(必須)。.credentials.json の
             subscriptionType と同じ値を使うこと(組織なら team、個人なら pro / max)。
  --dry-run  書き換えず、何行が対象になるかだけを表示する。
  --log      対象の usage.jsonl(既定: ${DEFAULT_LOG})

  既に acct を持つ行は変更しない。何度実行しても結果は変わらない。`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();
  if (!opts.acct) {
    console.error('エラー: --acct は必須です。既定値を持たせると取り違えに気づけないため。\n');
    usage();
    process.exitCode = 1;
    return;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(opts.acct)) {
    console.error(`エラー: アカウント名に使えない文字が含まれています: ${opts.acct}`);
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(opts.log)) {
    console.error(`エラー: ログが見つかりません: ${opts.log}`);
    process.exitCode = 1;
    return;
  }

  const raw = fs.readFileSync(opts.log, 'utf8');
  // collect.js は record() のたびに同じ usage.jsonl へ追記する。statusline の描画は
  // いつでも走りうるので、この読み込みから後述の rename までの間に新しい行が
  // 追記される可能性がある。その行は tmp に反映されないまま rename で消えてしまう
  // ため、後で rename 直前のサイズと比較して検出できるよう、読み込み直後のサイズを
  // ここで控えておく。
  const sizeAtRead = fs.statSync(opts.log).size;
  // 末尾の改行で空要素が出るので落とす。行番号は元ファイルの並びのまま保つ。
  const lines = raw.split('\n');
  const trailingNewline = lines[lines.length - 1] === '';
  if (trailingNewline) lines.pop();

  let filled = 0;
  let already = 0;
  let broken = 0;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      // 壊れた行は解釈できないので手を加えずそのまま残す。移行で失うもののほうが痛い。
      broken++;
      return line;
    }
    if (typeof obj.acct === 'string' && obj.acct) {
      already++;
      return line;
    }
    // ts の直後に置くと、既存行を目で追ったときに新形式と同じ並びになって読みやすい。
    const { ts, ...rest } = obj;
    filled++;
    return JSON.stringify({ ts, acct: opts.acct, ...rest });
  });

  console.log(`対象ログ : ${opts.log}`);
  console.log(`総行数   : ${lines.length}`);
  console.log(`付与対象 : ${filled} 行 → acct="${opts.acct}"`);
  console.log(`変更なし : ${already} 行(既に acct あり)`);
  if (broken) console.log(`解析不能 : ${broken} 行(そのまま保持)`);

  if (opts.dryRun) {
    console.log('\n--dry-run のため書き換えていません。');
    return;
  }
  if (!filled) {
    console.log('\n付与対象がないため書き換えていません。');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${opts.log}.bak-${stamp}`;
  fs.copyFileSync(opts.log, backup);

  // 一時ファイルに書き切ってから置き換える。書き込み中に落ちても元のログは無傷で残る。
  const tmp = `${opts.log}.tmp-${stamp}`;
  fs.writeFileSync(tmp, out.join('\n') + (trailingNewline ? '\n' : ''), 'utf8');

  // 行数が変わっていたら移行そのものが壊れている。置き換える前に気づく。
  const check = fs.readFileSync(tmp, 'utf8').split('\n');
  if (trailingNewline) check.pop();
  if (check.length !== lines.length) {
    fs.unlinkSync(tmp);
    console.error(`\nエラー: 行数が一致しません(${lines.length} → ${check.length})。中止しました。`);
    console.error(`元のログは変更していません。バックアップ: ${backup}`);
    process.exitCode = 1;
    return;
  }

  // rename 直前にもう一度サイズを確認する。行数チェック(上)は tmp とメモリ上の
  // lines を比較しているだけで、「読み込み後に collect.js が追記した行」は
  // どちらの数字にも現れないため検出できない。ここでサイズが変わっていれば
  // その追記分を rename で踏み潰してしまうということなので、中止して
  // ユーザーに再実行してもらう(実害が出る前に止まる方が、原因不明の欠損より安全)。
  const sizeBeforeRename = fs.statSync(opts.log).size;
  if (sizeBeforeRename !== sizeAtRead) {
    fs.unlinkSync(tmp);
    console.error(`\nエラー: 書き換え中に ${opts.log} が変更されました(サイズ ${sizeAtRead} → ${sizeBeforeRename} バイト)。中止しました。`);
    console.error(`元のログは変更していません。バックアップ: ${backup}`);
    console.error('もう一度実行してください。');
    process.exitCode = 1;
    return;
  }

  fs.renameSync(tmp, opts.log);
  console.log(`\n完了しました。バックアップ: ${backup}`);
}

main();
