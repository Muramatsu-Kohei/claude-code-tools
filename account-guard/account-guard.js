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

// credentials の場所と読み方は swap.js と共有する(credentials.js のコメント参照)。
//
// require を素通しで書かないのは、これがトップレベルで投げると末尾の catch
// (異常終了を受け止めて保護側へ倒す仕組み)より先にプロセスが死ぬため。フックは
// 標準出力に何も出さないまま exit 1 で終わり、Claude Code はブロックせず処理を続ける。
// つまり credentials.js を隣に置き忘れた構成では、保護が丸ごと外れたことに誰も
// 気づけないまま素通しになる。読めなくても「判別不能」として動き続けるほうが安全。
let credentials = null;
// 読めなかった理由は捨てない。ここで落ちると「正しいアカウントでログインしているのに
// 全部 deny される」状態になり、原因は隣のファイルなのに拒否メッセージが /login を促すと、
// 何度ログインし直しても直らない袋小路に入る(拒否の文面で真因を出すために使う)。
let credentialsLoadError = null;
try {
  credentials = require('./credentials');
} catch (e) {
  // 単体配置・コピー漏れ・権限。下のフォールバックで拒否側に倒す
  credentialsLoadError = e;
}

// HOME の導出だけは自前でも持つ(テストが USERPROFILE / HOME を差し替えるため、
// os.homedir() ではなく環境変数を見る。credentials.js と同じ規約)。
const HOME = credentials ? credentials.HOME : (process.env.USERPROFILE || process.env.HOME || '.');
const ACCOUNT_UNKNOWN = credentials ? credentials.ACCOUNT_UNKNOWN : 'unknown';
// credentials.js が無ければ誰のログインかを知る手段が無い。ACCOUNT_UNKNOWN は判定側が
// 拒否に倒す値なので、保護ツリーへの操作は deny され、設定漏れに気づける。
const currentAccount = credentials ? credentials.currentAccount : () => ACCOUNT_UNKNOWN;

const CONFIG = path.join(HOME, '.claude', 'account-guard', 'config.json');

// 既定では何も保護しない。守るべきツリーは環境ごとに違ううえ、実在するパスを
// 公開リポジトリに焼き込みたくないため、設定ファイルで明示させる。
// 設定していない状態に気づけるよう `status` サブコマンドで確認できるようにしてある。
const DEFAULT_RULES = [];

// 現在ログイン中のアカウントの取得(currentAccount)は credentials.js にある。
// トークン本体には触れないし記録もしない。

// パスを比較可能な形に揃える。区切りをスラッシュに統一し、ドライブ文字の大小と
// 末尾スラッシュの差を吸収する。JSON.stringify を通した文字列ではバックスラッシュが
// `\\` に増えるため、連続分もまとめて1つに潰す。
function normalize(p) {
  return String(p)
    .replace(/\\+/g, '/')
    // 連続する区切りは1つに畳む。`/c//org-tree` や `C://org-tree` のように区切りを
    // 重ねるだけで、下の書き換えとツリー名の突き合わせをすり抜けられるため。
    .replace(/\/{2,}/g, '/')
    // Git Bash / MSYS のドライブ表記を Windows 形式に寄せる。この環境の Bash ツールは
    // Git Bash なので、`/c/<tree>` や `/cygdrive/c/<tree>` でも同じ場所に到達できる。
    // 変換しないと表記を替えるだけで保護をすり抜けられる(実際に素通りしていた)。
    //
    // 直前の文字には「識別子の一部でないこと」だけを求める。区切り記号を列挙する形にすると
    // リダイレクト(`</c/...`、`>/c/...`)やブレース展開(`{/c/...`)が漏れる。実際、
    // 列挙していた頃は `echo x >/c/<tree>/f` で保護ツリーへの書き込みが通っていた。
    // パスの途中にある `/c/`(例 `C:/x/c/tree`)は直前が英数字なので巻き込まない。
    // ドライブのコロン直後(`D:/c/tree`)は Windows パスの一部なので変換しない。
    // ここを含めると `d:c:/tree` という壊れた文字列になり、ツリー名に当たって誤検知する。
    .replace(/(^|[^a-z0-9_.:-])\/cygdrive\/([a-z])\//gi, '$1$2:/')
    .replace(/(^|[^a-z0-9_.:-])\/([a-z])\//gi, '$1$2:/')
    .replace(/\/+$/, '')
    .toLowerCase();
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
//
// Glob / Grep はパスが入るフィールドが複数ある。`path` だけを見ていた頃は
// `Glob{pattern:"C:/tree/**"}` や `Grep{glob:"C:/tree/**"}` が素通りし、保護ツリーの
// 列挙と内容の読み取りができてしまっていた。
// ただし Grep の `pattern` は検索語(正規表現)であってパスではないので見ない。
// ここを含めると、ツリー名を検索語にしただけで拒否される上記の誤検知が復活する。
const PATH_FIELDS = {
  Read: ['file_path'],
  Edit: ['file_path'],
  Write: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path', 'pattern'],
  Grep: ['path', 'glob'],
};

// シェルと委譲は文字列全体を見る。パスがどの位置に現れるか決まっていないうえ、
// 「保護ツリーを読め」という指示そのものを止めたいため。
const COMMAND_FIELDS = {
  Bash: ['command'],
  PowerShell: ['command'],
  Agent: ['prompt', 'description'],
  Task: ['prompt', 'description'],
};

// 文字列に埋もれた絶対パス。ドライブ文字から始まる形。
const ABSOLUTE_PATH_TOKEN = /[a-z]:[\\/][^"'\s,]*/gi;

// Git Bash / MSYS 形式の絶対パス。直前がドライブのコロンや識別子の文字なら、それは
// Windows パスの途中(`D:/c/...`)なので拾わない。
const MSYS_PATH_TOKEN = /(?<![a-z0-9_.:\-])(?:\/cygdrive)?\/[a-z]\/[^"'\s,]*/gi;

// MSYS 形式を Windows 形式へ直す。そのまま path.resolve に渡すと `C:\c\...` と
// 誤変換されるが、ドライブ表記に直してからなら渡せる。これをしないと `/c/x/../<tree>` の
// ように `.` / `..` を含む形が畳まれず、文字列の突き合わせをすり抜ける。
function fromMsys(token) {
  const m = /^(?:\/cygdrive)?\/([a-z])\/(.*)$/i.exec(token);
  return m ? `${m[1]}:/${m[2]}` : null;
}

// 文字列に埋もれた相対パス。上に登る `../` 形と、cwd の配下へ降りていく形の両方を拾う。
//
// 当初は `../` を含む形だけを見ていた。降りていく形は cwd の配下にしか届かず、cwd が
// 保護ツリーの内側なら isInsideTree が先に拒否する、という理屈だったが、cwd が保護ツリーの
// 「親」にいる場合を見落としていた。`C:/` で作業していると `Bash{cat <tree>/secret}` は
// 文字列全体にも絶対パスの形にも当たらず素通りする一方、同じ指定でも Read はフィールドの
// 値として解決されて拒否される、という食い違いが起きていた。
//
// パス区切りを含むトークンだけを拾うのは、区切りのない語まで cwd 基準で解決すると、
// 散文中でツリー名に言及しただけで拒否される誤検知(PATH_FIELDS のコメント)が復活するため。
// 直前が識別子の文字・コロン・区切りなら拾わない。これがないと `D:/<tree>` や
// `https://host/<tree>` の途中を切り出し、別ドライブや URL を cwd 配下へ解決してしまう。
const RELATIVE_PATH_TOKEN = /(?<![a-z0-9_.:\-\\/])[a-z0-9_.\-]*(?:[\\/][^"'`\s,;|&()]*)+/gi;

// 相対パスを cwd 基準の絶対パスへ直す。解決できない値(null 文字を含む等)は捨てる。
function resolveFrom(cwd, value) {
  try {
    return path.resolve(cwd || process.cwd(), value);
  } catch {
    return null;
  }
}

// 判定対象にする文字列を取り出す。
//
// 相対パス指定は必ず cwd 基準で解決してから突き合わせる。これをしていなかった頃は
// 保護ツリーの外の cwd から `Read{file_path:"../../<tree>/secret"}` と上に登る指定が
// 素通りしていた(絶対パス版だけが拒否され、テストも絶対パスしか見ていなかった)。
// trees は設定中の保護ツリー一覧。区切りを含まない「裸のツリー名」を拾うためだけに使う
// (下のコメント参照)。判定そのものは呼び出し側がルールごとに行う。
function targetStrings(toolName, toolInput, cwd, trees = []) {
  const ti = toolInput ?? {};
  const pathFields = PATH_FIELDS[toolName];
  const commandFields = COMMAND_FIELDS[toolName];

  // フィールドの値そのものが操作対象のパス。書かれたままと解決後の両方を見る。
  if (pathFields) {
    const out = [];
    for (const f of pathFields) {
      const v = ti[f];
      if (typeof v !== 'string' || !v) continue;
      out.push(v, resolveFrom(cwd, v));
    }
    return out.filter(Boolean);
  }

  // ここから先はパスがどの位置に現れるか決まっていない文字列。
  // 知らないツール(MCP のファイルシステム系など)はどの引数が操作対象か判断できない。
  // 素通しにすると保護が丸ごと外れるので引数全体から拾うが、文字列全体を突き合わせると
  // 散文中のツリー名にも反応する(上の PATH_FIELDS のコメントにある誤検知)。
  // 絶対パスの形をした部分文字列だけを取り出せば、実際の操作対象を捉えつつ言及は見逃せる。
  const texts = commandFields
    ? commandFields.map((f) => ti[f]).filter((v) => typeof v === 'string')
    : [JSON.stringify(ti)];

  const out = [];
  for (const text of texts) {
    const absolute = text.match(ABSOLUTE_PATH_TOKEN) ?? [];
    const relative = text.match(RELATIVE_PATH_TOKEN) ?? [];
    const msys = text.match(MSYS_PATH_TOKEN) ?? [];

    // シェルや委譲は「保護ツリーを読め」という指示そのものを止めたいので文字列全体も見る。
    if (commandFields) out.push(text);
    else out.push(...absolute, ...msys);

    // 埋もれたパスは切り出して個別に解決する。文字列全体のままでは `.` / `..` を畳めず、
    // `C:/x/../<tree>/secret` や `/c/./<tree>` のような形が素通りしていた
    // (mentionsTree は文字列を突き合わせるだけで、パスとしての正規化はしない)。
    for (const token of [...absolute, ...relative]) out.push(resolveFrom(cwd, token));
    for (const token of msys) {
      const win = fromMsys(token);
      if (win) out.push(win, resolveFrom(cwd, win));
    }
  }

  // 区切りを含まない裸のトークンは cwd 基準で解決しない(RELATIVE_PATH_TOKEN のコメント。
  // 散文中でツリー名に言及しただけで拒否される誤検知を避けるため)。ただし保護ツリー
  // 自身の名前だけは例外にする。cwd がツリーの「親」にいるとき、`cd <ツリー名> && type
  // secret` は絶対パスの形にも区切り付き相対パスの形にもならず、文字列全体の突き合わせ
  // にも当たらないため、実際の読み出しがそのまま通っていた(`cd <ツリー名>/ && …` と
  // 末尾に区切りを付けただけで拒否されるのに、付けないと通るという食い違い)。
  //
  // この例外はシェルのコマンド文字列に限る。裸の名前が「操作対象」を意味するのは cd で
  // 潜れるシェルだけで、Agent / Task の prompt・description は自然文だからである。
  // 同じ扱いにすると、基底名が `private` のようなありふれた語のとき、その語を含むだけの
  // 無関係な委譲まで「配下を操作している」として拒否される。cwd がツリーの親であるのは
  // (親が作業リポジトリなら)ごく普通の状態なので、cwd 条件は歯止めにならない。
  const isShell = toolName === 'Bash' || toolName === 'PowerShell';
  for (const tree of isShell ? trees : []) {
    const base = path.basename(String(tree || '').replace(/[\\/]+$/, ''));
    if (!base) continue;
    // 前後の境界を見るのは、別ドライブの `D:/<ツリー名>` を切り出して cwd 配下へ
    // 解決してしまうことと、`<ツリー名>-backup` のような別ディレクトリに当てることを防ぐため
    const re = new RegExp(`(?<![\\w.\\-\\\\/:])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.\\-])`, 'i');
    if (texts.some((t) => re.test(t))) out.push(resolveFrom(cwd, base));
  }
  return out.filter(Boolean);
}

// 設定を読む。`broken` は「保護すべきなのに読めない」状態を表す。
//
// 「ファイルが無い」と「あるが壊れている」を区別するのが要点。以前はどちらも
// DEFAULT_RULES(= 保護なし)にしていたため、config.json に末尾カンマを1つ入れただけで
// 全ての保護が無言で消えていた。設定していないのは意図した状態だが、壊れているのは
// 事故であって、素通しにしてよい理由がない。冒頭の方針どおり後者は拒否側に倒す。
function loadConfig() {
  let text;
  try {
    text = fs.readFileSync(CONFIG, 'utf8');
  } catch (e) {
    // 未作成なら保護なし(意図した状態)。読めない場合は権限などの異常なので壊れた扱い。
    return { rules: DEFAULT_RULES, broken: e && e.code !== 'ENOENT' };
  }

  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch {
    return { rules: DEFAULT_RULES, broken: true };
  }

  // rules が配列でないのも書き損じ。空配列を明示した場合だけ「保護なし」として通す。
  if (!Array.isArray(cfg?.rules)) return { rules: DEFAULT_RULES, broken: true };

  // tree を書き損じた(キー名の誤記・空文字・非文字列など)ルールは黙って捨てない。
  // 以前は filter で無言で除外していたため、有効なルールが他になければ rules が [] になり、
  // 保護が丸ごと外れているのに configBroken は false のまま = 警告も出ないという事故があった。
  // allow の書き損じは「許可なし」に倒せば安全だが、tree が読めないとどのツリーを
  // 守るべきかそもそも分からないので、rules 非配列などと同じ扱い(config ごと壊れた=拒否側)に揃える。
  //
  // 相対パスも書き損じ扱いにする(姉妹ツールの worklog loadConfig と同じ判断)。判定に使う
  // resolveFrom / normalize は path.resolve なので、相対の tree はフックを呼んだ cwd を基準に
  // 解決され、同じ設定でも作業場所によって守る対象が変わる。加えて裸のツリー名の突き合わせは
  // 前後の境界しか見ないため、`tree: "org-tree"` は無関係な `D:/other/org-tree/x` にも当たる。
  const badRule = cfg.rules.find((r) => !r || typeof r.tree !== 'string' || !r.tree || !path.isAbsolute(r.tree));
  if (badRule) return { rules: DEFAULT_RULES, broken: true };

  const rules = cfg.rules.map((r) => ({ tree: r.tree, allow: Array.isArray(r.allow) ? r.allow : [] }));
  return { rules, broken: false };
}

// 壊れた設定を直す操作だけは通す。これがないと Claude Code の中から復旧できず、
// エディタや git を外部から使うしか手がなくなる(全停止させたときに実際に困った)。
function isConfigRepair(input) {
  const tool = input.tool_name;
  if (tool !== 'Read' && tool !== 'Edit' && tool !== 'Write') return false;
  const target = input.tool_input?.file_path;
  if (typeof target !== 'string' || !target) return false;
  const abs = resolveFrom(input.cwd, target);
  return Boolean(abs) && normalize(abs) === normalize(CONFIG);
}

// このツール呼び出しが保護ツリーに触れるか判定し、触れるなら拒否理由を返す。
// 触れない、または現在のアカウントが許可されているなら null。
function violation(input, account, config) {
  const cwd = input.cwd || process.cwd();

  // 設定が壊れているときは、どのツリーを守るべきかが分からない。素通しにすると
  // 保護が丸ごと外れるので、修復操作を除いて拒否する。
  if (config.broken && !isConfigRepair(input)) {
    return { broken: true, tree: CONFIG, reason: '設定ファイルを読めません', allow: [] };
  }

  const targets = targetStrings(input.tool_name, input.tool_input, cwd, config.rules.map((r) => r.tree));

  for (const rule of config.rules) {
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
  if (hit.broken) return brokenConfigMessage();

  const allowed = hit.allow.length ? hit.allow.join(' / ') : '(許可アカウントの設定なし)';
  const head = [
    `[account-guard] ${hit.tree} は別アカウント専用のツリーです。`,
    `${hit.reason}が、現在ログイン中のアカウントは "${account}" です(許可: ${allowed})。`,
    '',
  ];

  // 判別不能の原因が「credentials.js を隣に置き忘れた」ときは、ログインし直しても直らない。
  // ここで /login を促すと、正しいアカウントで入っている人に効かない操作を繰り返させる。
  if (account === ACCOUNT_UNKNOWN && credentialsLoadError) {
    return head.concat([
      `アカウントを判別できません。account-guard.js の隣にある credentials.js を読み込めませんでした`,
      `(${path.join(__dirname, 'credentials.js')}: ${credentialsLoadError.code || credentialsLoadError.message})。`,
      '',
      'ログインの問題ではないため `/login` では直りません。account-guard.js だけを別の場所へ',
      'コピーした場合は、credentials.js も同じディレクトリへ置いてください。',
      '判別できない間は保護ツリーへの操作をすべて拒否します(素通しにすると保護が無言で外れるため)。',
      // 他の deny 経路と同じ一文をここにも置く。設置ミスだと読んだ Claude が「ガードの都合だから」と
      // 別経路(ツリー名を書かない Bash など)で読み直すと、保護の目的そのものが崩れる。
      '回避しようとせず、ユーザーに状況を伝えてください。',
    ]).join('\n');
  }

  return head.concat([
    account === ACCOUNT_UNKNOWN
      ? 'アカウントを判別できませんでした。未ログインか、認証情報の形式が変わった可能性があります。'
      : 'このツリーのコードを現在のアカウントに読み込ませないため、操作を拒否しました。',
    // 先に `/login` させない。/login は credentials を上書きするので、まだ swap で退避して
    // いないアカウントはその場で失われ、復旧はブラウザ OAuth のやり直しになる
    // (account-guard/README.md の「拒否されたときの挙動」と同じ順序をここでも案内する)。
    'アカウントを切り替えてから操作してください。手順は次のとおりです。',
    '  swap save <name>   … 現在のアカウントを先に退避する(まだ退避していない場合)',
    '  swap <name>        … 退避済みの別アカウントへ切り替える',
    '先に `/login` すると、まだ退避していないアカウントの認証情報はその時点で消えます。',
    '回避しようとせず、ユーザーにアカウントの切り替えが必要であることを伝えてください。',
  ]).join('\n');
}

function brokenConfigMessage() {
  return [
    '[account-guard] 設定ファイルを読めないため、操作を拒否しました。',
    `${CONFIG} が壊れています(JSON として解析できないか、rules が配列ではありません)。`,
    '',
    'どのツリーを保護すべきか判断できない状態です。素通しにすると保護が無言で外れるため、',
    '安全側に倒しています。設定ファイル自体の読み書きだけは許可しているので、',
    'JSON の構文(末尾カンマなど)を直せば元に戻ります。',
    '設定を削除して保護ごと無効化するような回避はせず、ユーザーに状況を伝えてください。',
  ].join('\n');
}

// stdin(fd 0)は一度読むと消費されるため、読んだ結果を保持して以降は使い回す。
// これで main() の外 — 異常終了を受け止める catch — からも同じ入力を参照できる。
// main() に引数で渡す形にしないのは、シグネチャと呼び出し元を別々に書き換える途中で
// ガードが壊れると、それを直す手段ごと失われるため(実際に起きた)。
let hookInputCache = null;
function readHookInput() {
  if (hookInputCache) return hookInputCache;
  if (process.stdin.isTTY) return (hookInputCache = {});
  try {
    hookInputCache = JSON.parse(fs.readFileSync(0, 'utf8')) || {};
  } catch {
    hookInputCache = {};
  }
  return hookInputCache;
}

function main() {
  const mode = process.argv[2] || '';
  const account = currentAccount();
  const config = loadConfig();

  // 手元での確認用。フックからは呼ばれない。
  if (mode === 'status') {
    console.log(`アカウント: ${account}`);
    // 判別不能の原因が credentials.js の置き忘れなら、ここで言わないと未ログインと区別が
    // 付かない。deny メッセージ側でわざわざ塞いだ袋小路(/login を繰り返しても直らない)を、
    // 確認用の入り口で踏ませないため。
    if (credentialsLoadError) {
      console.log(`  credentials.js を読み込めません (${path.join(__dirname, 'credentials.js')}: `
        + `${credentialsLoadError.code || credentialsLoadError.message})`);
      console.log('  未ログインではなく、判別する手段が無い状態です。`/login` では直りません。');
      console.log('  account-guard.js の隣に credentials.js を置いてください。');
    }
    console.log(`設定: ${CONFIG}${fs.existsSync(CONFIG) ? '' : ' (未作成 — 保護は無効)'}`);
    if (config.broken) {
      console.log('設定を読めません — 修復するまで、設定ファイル自身の編集以外は拒否します。');
      return;
    }
    if (!config.rules.length) {
      console.log('保護ルール: なし。config.json に rules を書くまで何も拒否しません。');
      return;
    }
    for (const r of config.rules) {
      const state = r.allow.includes(account) ? '許可' : '拒否';
      console.log(`  ${r.tree}  allow=[${r.allow.join(', ')}]  → 現在は ${state}`);
    }
    const probe = process.argv[3];
    if (probe) {
      const hit = violation({ cwd: probe, tool_input: {} }, account, config);
      console.log(`判定(cwd=${probe}): ${hit ? '拒否 — ' + hit.reason : '通過'}`);
    }
    return;
  }

  const input = readHookInput();
  const event = input.hook_event_name || mode || 'PreToolUse';
  const isPreTool = event === 'PreToolUse';

  // PreToolUse 以外のイベントには「操作の対象」が無いので cwd だけで判定する。
  // SessionStart / CwdChanged の入力にツール引数は含まれず、含まれない値を見に行くと
  // 判定の根拠が曖昧になるため、明示的に絞る。
  const hit = violation(isPreTool ? input : { cwd: input.cwd, tool_input: {} }, account, config);
  if (!hit) return; // 何も出力しなければ通常の権限フローに委ねられる。

  // 拒否できるのは PreToolUse だけ。SessionStart / CwdChanged は公式に
  // "No blocking or decision control" とされており、将来このフックを別のイベントに
  // 登録した場合も同じ。deny 形式を返しても破棄されるので、警告として文脈に載せる
  // (reportCrash と同じ方針)。ここで気づければ無駄な往復を減らせる。
  if (!isPreTool) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: denyMessage(hit, account) },
      })
    );
    return;
  }

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

// ガード自身が異常終了したときの後始末。
//
// 以前はここで無条件に deny を返していたが、それではガードが壊れた瞬間に
// 「このマシンの全ツール呼び出し」が止まる。実際に起きたとき、ガード自身を直す Edit も
// 止まったファイルを読む Read も通らず、Claude Code の外から git で戻すしか手が
// なくなった。保護ツリーと無関係な作業まで巻き添えにするのは、冒頭に書いた
// 「判定できたものだけを拒否する」方針にも反する。
//
// そこで、例外が起きても判定できる範囲 — cwd が保護ツリーの内側かどうか — だけを見る。
// 内側なら止め、外側なら通す。内側での取りこぼしは残るが、それは「ガードが壊れている」
// という異常時に限られ、全停止の代償のほうが大きい。
function reportCrash(e) {
  const config = loadConfig();
  const input = readHookInput();
  const account = currentAccount();
  const cwd = input.cwd || process.cwd();

  // 設定が壊れているなら、この経路でも main と同じく拒否側に倒す(修復操作だけは通す)。
  // 保護ルール未設定なら find が何も返さず、何も拒否しない。
  const hit = config.broken
    ? isConfigRepair(input)
      ? null
      : { tree: CONFIG, broken: true }
    : config.rules.find((r) => !r.allow.includes(account) && isInsideTree(cwd, r.tree));
  if (!hit) return;

  const detail = [
    `[account-guard] ガードが異常終了しました(原因: ${e && e.message})。`,
    hit.broken
      ? `設定ファイル ${CONFIG} も読めないため、安全側に倒します。`
      : `作業ディレクトリが ${hit.tree} 配下にあるため、安全側に倒します。`,
    '',
    'ガード自体の不具合の可能性があります。保護ツリーの外での作業は影響を受けません。',
    'ガードを戻すには Claude Code の外から:',
    '  git checkout -- account-guard/account-guard.js',
  ].join('\n');

  // 拒否できるのは PreToolUse だけ。それ以外のイベントで deny 形式を返しても破棄されるので、
  // 警告として文脈に載せる(hookEventName は受け取ったイベントをそのまま返す必要がある)。
  const event = input.hook_event_name || process.argv[2] || 'PreToolUse';
  if (event !== 'PreToolUse') {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: detail } })
    );
    return;
  }

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: detail,
      },
    })
  );
}

try {
  main();
} catch (e) {
  try {
    reportCrash(e);
  } catch {
    // 出力すらできない状況では何もできない。
  }
}
