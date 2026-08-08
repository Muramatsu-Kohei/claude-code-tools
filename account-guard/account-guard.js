'use strict';
// 特定のディレクトリツリーを、許可したアカウント以外から触れないようにする。
//
// 想定している事故は「組織アカウントで書いたコードを、個人アカウントでログインしたまま
// 読ませてしまう」こと。Claude Code の認証情報(~/.claude/.credentials.json)はマシンに
// 1つしかなく、/login はマシン全体に即座に効く。一方で作業ツリーはアカウントと無関係に
// 到達できてしまうため、規約だけでは事故を防げない。
//
// == なぜ PreToolUse なのか ==
// 当初は SessionStart で `continue: false` を返して起動ごと止める設計を検討したが、
// 公式ドキュメントで SessionStart は "Context only / No blocking or decision control" と
// 明記されており、continue:false も exit 2 もセッションを止められない。ブロックできるのは
// PreToolUse の permissionDecision:"deny" だけなので、実際の防御はここに置く。
// SessionStart は警告を出すだけの補助に留める(session-start モード)。
//
// == 判定の考え方 ==
// フックの入力にアカウント情報は含まれないので、credentials の subscriptionType を読む。
// これはプラン種別であってアカウント identity ではないが、「組織は Team・個人は Pro」と
// いう構成なら判別条件として成立する。判別できないときは安全側(拒否)に倒す。
// 素通しになって気づかないより、止まって気づけるほうがよい。
//
// 最優先事項は「守れないなら止める」。ただし保護ツリーに関係ないツール呼び出しまで
// 巻き添えにはしない。判定できたものだけを拒否し、それ以外は通常の権限フローに委ねる。

const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || '.';
const CREDENTIALS = path.join(HOME, '.claude', '.credentials.json');
const CONFIG = path.join(HOME, '.claude', 'account-guard', 'config.json');

// アカウントを判別できなかったときの値。collect.js と同じ規約。
const ACCOUNT_UNKNOWN = 'unknown';

// 既定では何も保護しない。守るべきツリーは環境ごとに違ううえ、実在するパスを
// 公開リポジトリに焼き込みたくないため、設定ファイルで明示させる。
// 設定していない状態に気づけるよう `status` サブコマンドで確認できるようにしてある。
const DEFAULT_RULES = [];

// 現在ログイン中のアカウント。トークン本体には触れないし記録もしない。
// credentials に uuid やメールアドレスのような identity フィールドは存在しないため、
// プラン種別で代用している(2026-08 時点で実測済み)。
function currentAccount() {
  try {
    const t = JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8'))?.claudeAiOauth?.subscriptionType;
    return typeof t === 'string' && t ? t : ACCOUNT_UNKNOWN;
  } catch {
    // 未ログイン・権限不足・将来の構造変更のいずれか。判別不能として扱う。
    return ACCOUNT_UNKNOWN;
  }
}

// パスを比較可能な形に揃える。区切りをスラッシュに統一し、ドライブ文字の大小と
// 末尾スラッシュの差を吸収する。JSON.stringify を通した文字列ではバックスラッシュが
// `\\` に増えるため、連続分もまとめて1つに潰す。
function normalize(p) {
  return String(p).replace(/\\+/g, '/').replace(/\/+$/, '').toLowerCase();
}

// 保護ツリーを指す絶対パスが文字列中に現れるか。
//
// 単純な部分一致にすると `c:/org-tree` が `c:/org-treeo` にも当たってしまうので、
// ツリー名の直後がパス区切りか非識別子文字であることまで見る。
// 逆にツリー名だけ(`org-tree`)での一致は採らない。ドキュメントや会話でツリー名に
// 言及しただけで拒否され、誤検知のほうが実害になるため。
function mentionsTree(haystack, tree) {
  const t = normalize(tree).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(t + '(?![a-z0-9_.-])').test(normalize(haystack));
}

// cwd がツリーの内側か。ツリー自身もツリー配下として扱う。
function isInsideTree(cwd, tree) {
  const c = normalize(cwd);
  const t = normalize(tree);
  return c === t || c.startsWith(t + '/');
}

// ツールごとに「操作対象のパス」が入るフィールド。判定はここだけを見る。
//
// 当初は tool_input を丸ごと文字列化して走査していたが、それでは書き込む内容や指示文に
// ツリー名が出てくるだけで拒否されてしまう。実際、このツリーについて書いたドキュメントを
// 編集しようとして止まった。保護ツリーのファイルには一切触れていないのに拒否されるのは
// 明確な誤りで、日常の邪魔になる分だけガードを外したくなる圧力になる。
const PATH_FIELDS = {
  Read: ['file_path'],
  Edit: ['file_path'],
  Write: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path'],
  Grep: ['path'],
};

// シェルと委譲は文字列全体を見る。パスがどの位置に現れるか決まっていないうえ、
// 「保護ツリーを読め」という指示そのものを止めたいため。
const COMMAND_FIELDS = {
  Bash: ['command'],
  PowerShell: ['command'],
  Agent: ['prompt', 'description'],
  Task: ['prompt', 'description'],
};

// 判定対象にする文字列を取り出す。
function targetStrings(toolName, toolInput) {
  const ti = toolInput ?? {};
  const fields = PATH_FIELDS[toolName] || COMMAND_FIELDS[toolName];
  // 知らないツールはどの引数が操作対象か判断できない。素通しにするより引数全体を見て
  // 安全側に倒す。誤検知はフック登録時の matcher でツールを絞ることで避ける。
  if (!fields) return [JSON.stringify(ti)];
  return fields.map((f) => ti[f]).filter((v) => typeof v === 'string');
}

function loadRules() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    if (!Array.isArray(cfg?.rules)) return DEFAULT_RULES;
    // 形の壊れたルールは黙って捨てず、tree だけでも読めれば「許可なし」として扱う。
    // allow の書き損じで保護が外れるより、拒否側に倒れるほうが安全。
    return cfg.rules
      .filter((r) => r && typeof r.tree === 'string' && r.tree)
      .map((r) => ({ tree: r.tree, allow: Array.isArray(r.allow) ? r.allow : [] }));
  } catch {
    return DEFAULT_RULES;
  }
}

// このツール呼び出しが保護ツリーに触れるか判定し、触れるなら拒否理由を返す。
// 触れない、または現在のアカウントが許可されているなら null。
function violation(input, account, rules) {
  const cwd = input.cwd || process.cwd();
  const targets = targetStrings(input.tool_name, input.tool_input);

  for (const rule of rules) {
    if (rule.allow.includes(account)) continue;

    if (isInsideTree(cwd, rule.tree)) {
      return {
        tree: rule.tree,
        reason: `作業ディレクトリが ${rule.tree} 配下にあります`,
        allow: rule.allow,
      };
    }
    if (targets.some((s) => mentionsTree(s, rule.tree))) {
      return {
        tree: rule.tree,
        reason: `操作の対象が ${rule.tree} 配下です`,
        allow: rule.allow,
      };
    }
  }
  return null;
}

function denyMessage(hit, account) {
  const allowed = hit.allow.length ? hit.allow.join(' / ') : '(許可アカウントの設定なし)';
  return [
    `[account-guard] ${hit.tree} は別アカウント専用のツリーです。`,
    `${hit.reason}が、現在ログイン中のアカウントは "${account}" です(許可: ${allowed})。`,
    '',
    account === ACCOUNT_UNKNOWN
      ? 'アカウントを判別できませんでした。未ログインか、認証情報の形式が変わった可能性があります。'
      : 'このツリーのコードを現在のアカウントに読み込ませないため、操作を拒否しました。',
    '`/login` で正しいアカウントに切り替えてから操作してください。回避しようとせず、',
    'ユーザーにアカウントの切り替えが必要であることを伝えてください。',
  ].join('\n');
}

function readHookInput() {
  if (process.stdin.isTTY) return {};
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8')) || {};
  } catch {
    return {};
  }
}

function main() {
  const mode = process.argv[2] || '';
  const account = currentAccount();
  const rules = loadRules();

  // 手元での確認用。フックからは呼ばれない。
  if (mode === 'status') {
    console.log(`アカウント: ${account}`);
    console.log(`設定: ${CONFIG}${fs.existsSync(CONFIG) ? '' : ' (未作成 — 保護は無効)'}`);
    if (!rules.length) {
      console.log('保護ルール: なし。config.json に rules を書くまで何も拒否しません。');
      return;
    }
    for (const r of rules) {
      const state = r.allow.includes(account) ? '許可' : '拒否';
      console.log(`  ${r.tree}  allow=[${r.allow.join(', ')}]  → 現在は ${state}`);
    }
    const probe = process.argv[3];
    if (probe) {
      const hit = violation({ cwd: probe, tool_input: {} }, account, rules);
      console.log(`判定(cwd=${probe}): ${hit ? '拒否 — ' + hit.reason : '通過'}`);
    }
    return;
  }

  const input = readHookInput();
  const event = input.hook_event_name || mode;

  // SessionStart / CwdChanged は拒否できないイベントなので、警告だけを文脈に載せる。
  // 実際の防御は PreToolUse が担う。ここで気づければ無駄な往復を減らせる。
  if (event === 'SessionStart' || event === 'CwdChanged') {
    const hit = violation({ cwd: input.cwd, tool_input: {} }, account, rules);
    if (!hit) return;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: denyMessage(hit, account) },
      })
    );
    return;
  }

  const hit = violation(input, account, rules);
  if (!hit) return; // 何も出力しなければ通常の権限フローに委ねられる。

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: denyMessage(hit, account),
      },
    })
  );
}

try {
  main();
} catch (e) {
  // ここに来るのは想定外の不具合。黙って素通しにすると「守られているつもり」で
  // 保護が外れるため、拒否側に倒す。保護ルールが未設定なら何も拒否しない。
  try {
    if (loadRules().length) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              '[account-guard] ガードが異常終了したため、安全側に倒して操作を拒否しました。\n' +
              `原因: ${e && e.message}`,
          },
        })
      );
    }
  } catch {
    // 出力すらできない状況では何もできない。
  }
}
