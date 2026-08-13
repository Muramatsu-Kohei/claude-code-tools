'use strict';
// probeFile(credentials.js)の単体テスト。他のテストのように CLI を起動する黒箱ではなく
// 関数を直接叩くのは、検査したいのが「fs.existsSync では区別できない状態を区別できているか」
// という関数の内部規約そのもので、CLI 越しでは stat が失敗した理由まで観測できないため。
//
// 規則: 「読めない」を「無い」に倒さない。exists が false になってよいのは ENOENT のときだけ。
// これを破ると、呼び出し側(writeSlot / saveCurrent / overwriteGate)が「失って困るものは
// 無い」と判断して控えを取らずに上書きする。同じ形の欠陥が繰り返し出たので、規約そのものを
// 機械的に固定する。

const fs = require('fs');
const path = require('path');
const { makeHarness } = require('./harness');
const { probeFile } = require('../credentials');

const { check, report } = makeHarness();

const TMP = path.join(__dirname, '.tmp', 'probe');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

console.log('probeFile');

{
  const f = path.join(TMP, 'missing.json');
  const p = probeFile(f);
  check('無いファイルは exists=false', p.exists === false, JSON.stringify(p));
  check('無いファイルは readable=false', p.readable === false, JSON.stringify(p));
  check('無いファイルの code は ENOENT', p.code === 'ENOENT', JSON.stringify(p));
}

{
  const f = path.join(TMP, 'ok.json');
  fs.writeFileSync(f, '{"claudeAiOauth":{"accessToken":"a"}}');
  const p = probeFile(f);
  check('読めるファイルは exists/readable ともに true', p.exists && p.readable, JSON.stringify(p));
  check('読めるファイルは json を返す',
    p.json && p.json.claudeAiOauth && p.json.claudeAiOauth.accessToken === 'a', JSON.stringify(p));
  check('読めるファイルは raw も返す(書き戻しに使う)',
    typeof p.raw === 'string' && p.raw.indexOf('accessToken') >= 0, JSON.stringify(p));
  check('読めるファイルは parseError=false', p.parseError === false, JSON.stringify(p));
}

{
  // 書き込みの途中で切れた credentials。JSON としては壊れているが、切れ目より手前に
  // refreshToken が残ることがあるので raw を捨ててはいけない(rawHasRecoverableToken が見る)。
  const f = path.join(TMP, 'broken.json');
  fs.writeFileSync(f, '{"claudeAiOauth":{"refreshToken":"r');
  const p = probeFile(f);
  check('壊れた JSON でも readable=true', p.readable === true, JSON.stringify(p));
  check('壊れた JSON は parseError=true', p.parseError === true, JSON.stringify(p));
  check('壊れた JSON でも raw は捨てない',
    typeof p.raw === 'string' && p.raw.indexOf('refreshToken') >= 0, JSON.stringify(p));
  check('壊れた JSON の json は null', p.json === null, JSON.stringify(p));
}

{
  // 同じ名前のディレクトリが置かれている。stat 自体は成功するので existsSync も true を
  // 返すが、中身は読めない。exists と readable を分けて持つ意味がここに出る。
  const f = path.join(TMP, 'asdir.json');
  fs.mkdirSync(f);
  const p = probeFile(f);
  check('ディレクトリは exists=true・readable=false',
    p.exists === true && p.readable === false, JSON.stringify(p));
  check('ディレクトリの code は EISDIR', p.code === 'EISDIR', JSON.stringify(p));
}

{
  // 規則の核心。権限が足りずファイルに手が届かない状態では、fs.existsSync は false を返す
  // (Node は stat の失敗理由を問わず false にする)。existsSync を盾にしていた呼び出し側は
  // それを「無い = 失うものは無い」と読み、控えを取らずに上書きへ進んでいた。
  //
  // Windows でこの状態を実ファイルで作るには ACL の操作が要り、テストを環境依存にする
  // (しかも「親をファイルにして ENOTDIR」の手は使えない。Windows の Node はそのとき
  //  ENOTDIR ではなく ENOENT を返すので、OS の側が「読めない」と「無い」を区別しない)。
  // 規則そのものは OS に依存しないので、errno を注入して検査する。
  const f = path.join(TMP, 'ok.json');
  const real = fs.readFileSync;
  fs.readFileSync = () => {
    const e = new Error('permission denied');
    e.code = 'EACCES';
    throw e;
  };
  let p;
  try {
    p = probeFile(f);
  } finally {
    fs.readFileSync = real;
  }
  check('EACCES を「無い」に倒さない', p.exists === true, JSON.stringify(p));
  check('EACCES は readable=false', p.readable === false, JSON.stringify(p));
  check('EACCES の code を残す', p.code === 'EACCES', JSON.stringify(p));
  check('注入した fs を元に戻せている', fs.readFileSync === real, 'restore failed');
}

report();
