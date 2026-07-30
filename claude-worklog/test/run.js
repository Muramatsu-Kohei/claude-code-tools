// テストランナー。test/*.test.js を順に子プロセスで走らせ、終了コードを集計する。
// 使い方: node test/run.js [名前の一部]
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

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
  // 並列にして出力が混ざるより読める方を取る
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) failed.push(f);
}

console.log('');
if (failed.length) {
  console.log(`失敗: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`${files.length} ファイル すべて PASS`);
