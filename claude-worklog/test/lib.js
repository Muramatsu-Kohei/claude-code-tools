// テスト共通の小道具。worklog.js が「単一ファイル・依存なし」なので、テストも素の
// node だけで走るようにしてある(npm install も設定ファイルも要らない)。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const WORKLOG = path.join(__dirname, '..', 'worklog.js');
const TOOL_DIR = path.join(__dirname, '..'); // claude-worklog(= リポジトリの子ディレクトリ)

// 作業場所はテストごとに掘り、開始時に消す。test/.gitignore で除外している
function tmpDir(name) {
  const dir = path.join(__dirname, '.tmp', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// worklog.js 側の normPath / projectKey と同じ規則。ここが食い違うとキーが合わず
// テストが「動いているのに落ちる」状態になるので、実装と一緒に直す
function normPath(p) {
  const r = path.resolve(String(p));
  return /^[a-z]:/.test(r) ? r[0].toUpperCase() + r.slice(1) : r;
}

function projectKey(p) {
  return normPath(p).replace(/[^a-zA-Z0-9]/g, '-');
}

// テスト対象は git ルートをプロジェクトの単位にするので、リポジトリの場所は
// 決め打ちにせず git に聞く(このリポジトリ自体が移動しても通るようにするため)
function repoRoot() {
  return normPath(execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: TOOL_DIR, encoding: 'utf8', windowsHide: true,
  }).trim());
}

// 偽 HOME を作る。~/.claude/worklog を汚さずにフックまで含めて回せる
function sandboxHome(dir, config) {
  const logDir = path.join(dir, '.claude', 'worklog');
  fs.mkdirSync(logDir, { recursive: true });
  if (config) fs.writeFileSync(path.join(logDir, 'config.json'), JSON.stringify(config), 'utf8');
  return { home: dir, logDir };
}

function checks() {
  const state = { pass: 0, fail: 0 };
  // extra は失敗時の手掛かり。落ちた行だけ出しても原因が分からないことが多いので、
  // 実際の出力を添えられるようにしてある
  const check = (label, cond, extra) => {
    if (cond) state.pass++;
    else state.fail++;
    const tail = extra && !cond ? `\n      ${String(extra).replace(/\n/g, '\n      ')}` : '';
    console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}${tail}`);
  };
  const finish = () => {
    console.log(`  ${state.pass} PASS / ${state.fail} FAIL`);
    process.exitCode = state.fail ? 1 : 0;
  };
  return { check, finish, state };
}

// 偽 HOME を向けて worklog.js を叩く。NO_COLOR は出力を照合しやすくするため
function runner(home, defaultCwd) {
  return function run(args, opts = {}) {
    const env = {
      ...process.env, USERPROFILE: home, HOME: home, NO_COLOR: '1', ...(opts.env || {}),
    };
    try {
      const out = execFileSync(process.execPath, [WORKLOG, ...args], {
        input: opts.input, encoding: 'utf8', cwd: opts.cwd || defaultCwd, env,
        stdio: [opts.input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      return { code: 0, out, err: '' };
    } catch (e) {
      // 非 0 終了もテスト対象(引数エラーの確認)なので投げずに返す
      return { code: e.status == null ? -1 : e.status, out: e.stdout || '', err: e.stderr || '' };
    }
  };
}

module.exports = { WORKLOG, TOOL_DIR, tmpDir, normPath, projectKey, repoRoot, sandboxHome, checks, runner };
