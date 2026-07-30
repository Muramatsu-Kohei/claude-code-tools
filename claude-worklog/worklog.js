// claude-worklog - Claude Code のセッション作業ログ
//
// 「並列でセッションを動かし、日をまたいで別の作業に移ると、Claude が何をどこまでやったか
// 追えなくなる」問題への対処。セッション単位の作業記録を追記専用ログに溜め、次のセッション
// 開始時に SessionStart フックで Claude 自身のコンテキストへ戻す。人間が覚えておく必要を消す
// のが目的で、閲覧用の CLI はその副産物。
//
// 記録の3層構造(上の層があれば下は使わない):
//   1. /wrap・/finish から `add` で入る手書き要約 ... そのセッションの Claude が書くので最も正確
//   2. SessionEnd 後に haiku が生成する自動要約 ... コマンドを叩き忘れても穴が空かないための保険
//   3. Claude Code が付ける ai-title と git 差分 ... LLM を一切使わなくても必ず残る最低保証
// 3 は常に記録されるので、要約が無い日でも「いつ・どのプロジェクトで・何を変更したか」は残る。
//
// 引き継ぎ(handoff):
//   /finish は「次回の始め方」を handoff として記録する。これは次セッションの SessionStart で
//   注入テキストの先頭に置かれるため、新しいセッションを開いた時点で Claude が続きを把握して
//   いる状態になる。config の autoStartFromHandoff を true にすると initialUserMessage として
//   投入され、開いた瞬間に続きを実行し始める(既定は無効。意図しない自走を避けるため)。
//   手で別セッションへ渡したいときは `worklog handoff --raw`。
//
// なぜ NDJSON(1行1レコードの追記専用)なのか:
//   同一プロジェクトで複数セッションが並列に走るのが前提のため、既存行の書き換えが必要な形式
//   (JSON 配列や Markdown 表)は同時書き込みで壊れる。追記専用なら O_APPEND による追記が
//   衝突せず、ロックも不要。1セッションの状態は start/note/end などのイベント行を読み出し時に
//   畳み込んで組み立てる(foldSessions)。Claude Code 自身が全ログを jsonl で持つのと同じ理由。
//
// 設計上の要点:
//  - フックとして動くため、何があってもセッションを壊さない。例外は握り潰して exit 0 し、
//    原因追跡用に worklog/errors.log にだけ残す。無出力でもフック側は正常終了として扱われる。
//  - SessionEnd はターミナルを強制終了された場合など発火しないことがある。そのため次回の
//    SessionStart で「start はあるが end が無い古いセッション」を検出して後追いで確定させる
//    (finalizeDangling)。トランスクリプトはディスクに残っているので後からでも統計は取れる。
//  - 自動要約は headless の claude を呼ぶが、その claude 自身も SessionStart/SessionEnd フックを
//    発火させるため、放置すると要約が要約を呼ぶ無限再帰になる。子プロセスに WORKLOG_DISABLE=1 を
//    渡し、フック側はこれを見たら何もせず終わることで断ち切る。
//    (--bare でも自動読み込みを止められるが、認証情報の読み込みまで止まって "Not logged in" で
//     失敗する。実測で確認済みなので使わない)
//
// 使い方は README.md を参照。`node worklog.js help` でも一覧が出る。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const LOG_DIR = path.join(CLAUDE_DIR, 'worklog');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions'); // 起動中セッションの一覧(pid.json)
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects'); // トランスクリプト(<projectKey>/<sessionId>.jsonl)
const ERROR_LOG = path.join(LOG_DIR, 'errors.log');
const CONFIG_PATH = path.join(LOG_DIR, 'config.json');

// 既定設定。config.json で上書きできる(コストや注入量を後から絞れるようにするため)
const DEFAULT_CONFIG = {
  autoSummary: true,       // SessionEnd 後の haiku 自動要約を使うか
  summaryModel: 'haiku',   // 自動要約に使うモデル。精度が要るなら 'sonnet'
  contextSessions: 3,      // SessionStart で注入する過去セッション数
  contextMaxChars: 1600,   // 注入テキストの上限。毎セッション食うので絞る
  digestMaxChars: 6000,    // 要約へ渡す入力の上限。課金額を読めるようにするため
  // 引き継ぎ(次回の始め方)を最初のユーザー発言として自動投入するか。
  // true にすると新セッションを開いた瞬間に Claude が前回の続きを実行し始める。
  // 意図せず作業が走るのは事故になり得るので既定は false(コンテキストに入れるだけ)。
  autoStartFromHandoff: false,
  handoffMaxAgeHours: 72,  // 古すぎる引き継ぎは自動投入しない(状況が変わっているため)
};

// ---------------------------------------------------------------------------
//  基礎ユーティリティ
// ---------------------------------------------------------------------------

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// フック実行中の失敗は表に出せない(出すとセッションが汚れる)ので、ここだけに残す
function logError(where, err) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = `${new Date().toISOString()} [${where}] ${err && err.stack ? err.stack : String(err)}\n`;
    fs.appendFileSync(ERROR_LOG, line, 'utf8');
  } catch {
    // ここで失敗したらもう何もできない
  }
}

// cwd からログのファイル名を作る。Claude Code が projects/ 配下で使う変換と同じ規則にして
// おくと、トランスクリプトのパスをそのまま導出できる。例: C:\claude\ClaudeCode -> C--claude-ClaudeCode
function projectKey(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

function logPath(key) {
  return path.join(LOG_DIR, `${key}.ndjson`);
}

function appendRecord(key, rec) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  // 追記専用。1行が短いため O_APPEND の追記は並列セッション間でも行が混ざらない
  fs.appendFileSync(logPath(key), `${JSON.stringify(rec)}\n`, 'utf8');
}

function readRecords(key) {
  let raw;
  try {
    raw = fs.readFileSync(logPath(key), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // 壊れた行は捨てる。1行の破損で全履歴を失わないため
    }
  }
  return out;
}

function listProjectKeys() {
  try {
    return fs.readdirSync(LOG_DIR)
      .filter((f) => f.endsWith('.ndjson'))
      .map((f) => f.replace(/\.ndjson$/, ''));
  } catch {
    return [];
  }
}

function uniq(arr) {
  return [...new Set(arr.filter((v) => v != null && v !== ''))];
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// ログ表示用。年は普段不要なので省き、月日と時分だけ出す
function fmtTime(ts) {
  if (!ts) return '??/?? ??:??';
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return ''; // 1分未満を "0m" と出すと情報がないのに幅を取る
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${pad2(m % 60)}`;
}

function truncate(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

// 端末以外(パイプ・フックの stdout)に色を吐くとゴミになるので落とす
const USE_COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const dim = (s) => (USE_COLOR ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (USE_COLOR ? `\x1b[1m${s}\x1b[0m` : s);
const cyan = (s) => (USE_COLOR ? `\x1b[36m${s}\x1b[0m` : s);
const yellow = (s) => (USE_COLOR ? `\x1b[33m${s}\x1b[0m` : s);

// 繰り返し指定できるフラグを扱いたいので、値は常に配列で持つ
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let name;
      let value;
      if (eq > 0) {
        name = a.slice(2, eq);
        value = a.slice(eq + 1);
      } else {
        name = a.slice(2);
        const next = argv[i + 1];
        if (next != null && !next.startsWith('--')) {
          value = next;
          i++;
        } else {
          value = true; // 値なしフラグ
        }
      }
      (flags[name] = flags[name] || []).push(value);
    } else if (/^-[a-zA-Z]$/.test(a)) {
      const next = argv[i + 1];
      (flags[a.slice(1)] = flags[a.slice(1)] || []).push(next != null && !next.startsWith('--') ? (i++, next) : true);
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const one = (flags, name, fallback) => (flags[name] ? flags[name][flags[name].length - 1] : fallback);
const many = (flags, ...names) => names.flatMap((n) => flags[n] || []).filter((v) => typeof v === 'string');

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
//  セッションの畳み込み
// ---------------------------------------------------------------------------

// イベント行から 1 セッション = 1 オブジェクトを組み立てる。
// レコード種別: start / note / auto / end
function foldSessions(records) {
  const map = new Map();
  const get = (sid) => {
    if (!map.has(sid)) {
      map.set(sid, {
        sid,
        startTs: null, endTs: null, cwd: null, branch: null, head: null, source: null,
        summary: null, summarySource: null,
        done: [], next: [], docs: [], handoff: null,
        stats: null, reason: null, aiTitle: null, autoSummary: null,
        noteTs: null,
      });
    }
    return map.get(sid);
  };

  for (const r of records) {
    if (!r || !r.sid) continue;
    const s = get(r.sid);
    switch (r.k) {
      case 'start':
        // 同一セッションでも compact 等で再度 SessionStart が来る。開始時刻と HEAD は
        // 最初のものを保持する(差分の基点をずらさないため)
        s.startTs = s.startTs == null ? r.ts : Math.min(s.startTs, r.ts);
        if (s.head == null) s.head = r.head || null;
        if (s.source == null) s.source = r.source || null;
        s.cwd = r.cwd || s.cwd;
        s.branch = r.branch || s.branch;
        break;
      case 'note':
        // 同一セッションで複数回 /wrap を打てる。要約は最後のものを採り、
        // 済み・次・ドキュメントは積み上げる(途中の区切りも記録として残したいため)
        if (r.summary) { s.summary = r.summary; s.summarySource = r.via || 'wrap'; s.noteTs = r.ts; }
        s.done = uniq([...s.done, ...(r.done || [])]);
        s.next = uniq([...s.next, ...(r.next || [])]);
        s.docs = uniq([...s.docs, ...(r.docs || [])]);
        // 引き継ぎ文は積み上げず最後のものだけを残す。「次はここから」は
        // 常に最新の 1 つだけが正しく、古いものが混ざると誤誘導になるため
        if (r.handoff) s.handoff = r.handoff;
        break;
      case 'auto':
        s.autoSummary = r.summary || s.autoSummary;
        break;
      case 'end':
        s.endTs = s.endTs == null ? r.ts : Math.max(s.endTs, r.ts);
        s.reason = r.reason || s.reason;
        s.stats = r.stats || s.stats;
        s.aiTitle = r.aiTitle || s.aiTitle;
        s.branch = r.branch || s.branch;
        break;
      default:
        break;
    }
  }

  // 手書き要約 > 自動要約 > ai-title の優先順で表示用要約を決める
  for (const s of map.values()) {
    if (!s.summary && s.autoSummary) { s.summary = s.autoSummary; s.summarySource = 'auto'; }
    if (!s.summary && s.aiTitle) { s.summary = s.aiTitle; s.summarySource = 'title'; }
  }

  return [...map.values()].sort((a, b) => (b.startTs || 0) - (a.startTs || 0));
}

function loadSessions(key) {
  return foldSessions(readRecords(key));
}

function loadAllSessions() {
  const out = [];
  for (const key of listProjectKeys()) {
    for (const s of loadSessions(key)) out.push({ ...s, project: key });
  }
  return out.sort((a, b) => (b.startTs || 0) - (a.startTs || 0));
}

// ---------------------------------------------------------------------------
//  git / トランスクリプトからの事実収集
// ---------------------------------------------------------------------------

// git は「無い・リポジトリでない・タイムアウト」を普通に起こすので、失敗は必ず null に落とす
function git(cwd, args) {
  try {
    const out = execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return out.trim();
  } catch {
    return null;
  }
}

function gitBranch(cwd) {
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

function gitHead(cwd) {
  return git(cwd, ['rev-parse', 'HEAD']);
}

// セッション開始時の HEAD から現在までの「やったこと」を git 側から見る
function gitDelta(cwd, startHead) {
  const head = gitHead(cwd);
  const commits = [];
  if (startHead && head && startHead !== head) {
    const log = git(cwd, ['log', '--oneline', '--no-decorate', `${startHead}..HEAD`]);
    if (log) commits.push(...log.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 20));
  }

  // startHead との差分は「コミット済み + 未コミットの追跡ファイル」を一度に拾える。
  // 未追跡ファイルはこれに出ないので porcelain から補う
  const files = [];
  if (startHead) {
    const diff = git(cwd, ['diff', '--name-only', startHead]);
    if (diff) files.push(...diff.split('\n').map((l) => l.trim()).filter(Boolean));
  }
  const st = git(cwd, ['status', '--porcelain']);
  if (st) {
    for (const line of st.split('\n')) {
      const name = line.slice(3).trim();
      if (name) files.push(name.includes(' -> ') ? name.split(' -> ')[1] : name);
    }
  }

  return { head, commits, files: uniq(files).slice(0, 30), dirty: Boolean(st) };
}

function transcriptPathFor(key, sid) {
  return path.join(PROJECTS_DIR, key, `${sid}.jsonl`);
}

// ユーザーの「本当の指示」だけを取り出したい。会話ログには以下が同じ type:'user' で混ざる:
//  - isMeta のシステム的な注記
//  - スラッシュコマンドの展開結果(<command-name> など)
//  - ツール実行結果(message.content が配列になる)
function isRealPrompt(rec) {
  if (rec.type !== 'user' || rec.isMeta) return false;
  const c = rec.message && rec.message.content;
  if (typeof c !== 'string') return false;
  const t = c.trim();
  if (!t) return false;
  if (/^<(local-command|command-name|command-message|command-args|system-reminder|bash-input|bash-stdout|user-prompt-submit-hook)/.test(t)) return false;
  return true;
}

// トランスクリプトから統計と要約材料を集める。
// 巨大化した会話(数十MB)でフックが詰まるのを避けるため、上限を超えたら末尾だけ読む。
// その場合は冒頭の指示を取り逃すが、統計とセッションの成立自体は守る。
const TRANSCRIPT_READ_LIMIT = 32 * 1024 * 1024;

function parseTranscript(p) {
  const empty = {
    turns: 0, prompts: [], editedFiles: [], toolCalls: 0, tools: {},
    aiTitle: null, lastAssistant: null, firstTs: null, lastTs: null, truncated: false,
  };
  let raw;
  let truncated = false;
  try {
    const size = fs.statSync(p).size;
    if (size > TRANSCRIPT_READ_LIMIT) {
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.alloc(TRANSCRIPT_READ_LIMIT);
        fs.readSync(fd, buf, 0, TRANSCRIPT_READ_LIMIT, size - TRANSCRIPT_READ_LIMIT);
        raw = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      truncated = true;
    } else {
      raw = fs.readFileSync(p, 'utf8');
    }
  } catch {
    return empty;
  }

  const out = { ...empty, prompts: [], editedFiles: [], tools: {}, truncated };
  const edited = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue; // 末尾読みで切れた先頭行を捨てる
    let rec;
    try {
      rec = JSON.parse(t);
    } catch {
      continue;
    }
    if (rec.type === 'ai-title' && rec.aiTitle) out.aiTitle = rec.aiTitle;
    if (rec.timestamp) {
      const ts = Date.parse(rec.timestamp);
      if (!Number.isNaN(ts)) {
        if (out.firstTs == null) out.firstTs = ts;
        out.lastTs = ts;
      }
    }
    if (rec.isSidechain) continue; // サブエージェント側の発言は本流の指示ではない
    if (isRealPrompt(rec)) {
      out.turns++;
      out.prompts.push(rec.message.content.trim());
      continue;
    }
    if (rec.type !== 'assistant') continue;
    const content = rec.message && rec.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === 'text' && b.text && b.text.trim()) out.lastAssistant = b.text.trim();
      if (b.type !== 'tool_use') continue;
      out.toolCalls++;
      out.tools[b.name] = (out.tools[b.name] || 0) + 1;
      if (/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(b.name) && b.input && b.input.file_path) {
        edited.push(b.input.file_path);
      }
    }
  }
  out.editedFiles = uniq(edited).slice(0, 30);
  return out;
}

// end レコードに載せる統計をまとめる
function buildEndStats(cwd, key, sid, startHead, startTs) {
  const tr = parseTranscript(transcriptPathFor(key, sid));
  const delta = gitDelta(cwd, startHead);
  const endTs = Date.now();
  return {
    stats: {
      turns: tr.turns,
      toolCalls: tr.toolCalls,
      edits: tr.editedFiles.length,
      editedFiles: tr.editedFiles,
      files: delta.files,
      commits: delta.commits,
      dirty: delta.dirty,
      head: delta.head,
      durationMs: startTs ? Math.max(0, (tr.lastTs || endTs) - startTs) : null,
    },
    aiTitle: tr.aiTitle,
    transcript: tr,
  };
}

// ---------------------------------------------------------------------------
//  起動中セッション(並列作業の把握)
// ---------------------------------------------------------------------------

function isPidAlive(pid) {
  try {
    process.kill(pid, 0); // シグナル 0 は送らずに存在確認だけする
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // 別ユーザーの権限エラーなら生きている
  }
}

function liveSessions() {
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      // 落ちたプロセスの残骸が消えずに残ることがあるので pid で生存確認する
      if (s.pid && !isPidAlive(s.pid)) continue;
      // headless(-p)の使い捨て実行は「並列作業」ではないので数に入れない
      if (s.kind && s.kind !== 'interactive') continue;
      out.push(s);
    } catch {
      // 書き込み途中の JSON を読んだ場合など。無視して次へ
    }
  }
  return out.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}

// ---------------------------------------------------------------------------
//  SessionStart フック
// ---------------------------------------------------------------------------

// 1セッション分を注入用の 1〜2 行にする。
// next(次にやること)は直近 1 件だけ行内に出す。それ以外は後段の「未完タスク」に集約されるため、
// 全セッションで出すと同じ文字列が二重に入って注入量を無駄に食う。
function renderContextLine(s, opts = {}) {
  const when = fmtTime(s.startTs);
  const branch = s.branch ? `[${s.branch}]` : '';
  const st = s.stats || {};
  const facts = [];
  if (st.commits && st.commits.length) facts.push(`${st.commits.length} commit`);
  const fileCount = (st.files && st.files.length) || (st.editedFiles && st.editedFiles.length) || 0;
  if (fileCount) facts.push(`${fileCount} files`);
  const factStr = facts.length ? ` (${facts.join(', ')})` : '';

  const head = s.summary
    ? truncate(s.summary, 90)
    : `要約なし${st.files && st.files.length ? `: ${st.files.slice(0, 3).join(', ')}` : ''}`;
  const lines = [`- ${when} ${branch} ${head}${factStr}`.replace(/\s+/g, ' ')];
  if (opts.showNext && s.next && s.next.length) {
    lines.push(`    次にやる予定だったこと: ${s.next.map((n) => truncate(n, 60)).join(' / ')}`);
  }
  return lines.join('\n');
}

// 「次回の始め方」を持つ直近セッションを探す。/finish が書いた引き継ぎ文が対象で、
// 見つからなければ next(次にやること)から組み立てて代用する。
function latestHandoff(sessions) {
  const withHandoff = sessions.find((s) => s.handoff);
  if (withHandoff) return { text: withHandoff.handoff, ts: withHandoff.startTs, from: withHandoff, explicit: true };
  const withNext = sessions.find((s) => s.next && s.next.length);
  if (withNext) {
    return {
      text: withNext.next.map((n) => `- ${n}`).join('\n'),
      ts: withNext.startTs, from: withNext, explicit: false,
    };
  }
  return null;
}

// SessionStart で Claude に渡すテキスト。毎セッション必ずコンテキストを消費するので、
// 「次回の始め方」「過去 N 件の要約」「持ち越しの未完タスク」「並列稼働中の他セッション」に絞る。
// 戻り値は { text, handoff } で、handoff は自動投入(initialUserMessage)の判断に使う。
function buildContext(key, cwd, currentSid, cfg) {
  const sessions = loadSessions(key).filter((s) => s.sid !== currentSid);
  const parts = [];

  // 引き継ぎは最優先で先頭に置く。ここが読まれないと仕組み全体が意味を失う
  const handoff = latestHandoff(sessions);
  if (handoff) {
    parts.push(`## 次回の始め方 (${fmtTime(handoff.ts)} のセッションからの引き継ぎ)`);
    parts.push(handoff.text);
    if (!handoff.explicit) parts.push('(/finish による引き継ぎ文はないため、記録された「次にやること」から生成した)');
    parts.push('');
  }

  if (sessions.length) {
    const recent = sessions.slice(0, cfg.contextSessions);
    parts.push('## 直近の作業ログ (claude-worklog)');
    parts.push(recent.map((s, i) => renderContextLine(s, { showNext: i === 0 })).join('\n'));

    // 未完タスクは「next に挙がっていて、その後のセッションで done に入っていないもの」。
    // 完全な追跡は無理なので目安として出す。直近 1 件の next は既に行内に出ているので除く
    const laterDone = new Set(recent.flatMap((s) => s.done || []));
    const shown = new Set(recent[0].next || []);
    const pending = uniq(recent.slice(1).flatMap((s) => s.next || []))
      .filter((n) => !laterDone.has(n) && !shown.has(n));
    if (pending.length) {
      parts.push(`\nさらに前から持ち越している可能性のある未完タスク: ${pending.slice(0, 5).map((p) => truncate(p, 70)).join(' / ')}`);
    }
  }

  // 並列セッションの取り違えが今回いちばん困っている点なので、同じ作業ツリーで他に
  // 動いているセッションがあれば明示する(同じファイルを同時に触る事故の予防)。
  // 別プロジェクトのセッションは対処のしようがないため、あえて出さない(注入量を節約する)
  const sameCwd = liveSessions()
    .filter((s) => s.sessionId !== currentSid)
    .filter((s) => s.cwd && cwd && path.resolve(s.cwd) === path.resolve(cwd));
  if (sameCwd.length) {
    const names = sameCwd.map((s) => `${s.name || s.sessionId.slice(0, 8)}(pid ${s.pid})`).join(', ');
    parts.push(`\n注意: 同じディレクトリで別の Claude Code セッションが稼働中: ${names}。同じファイルの同時編集に注意すること。`);
  }

  if (!parts.length) return null;
  let text = parts.join('\n');
  if (text.length > cfg.contextMaxChars) text = `${text.slice(0, cfg.contextMaxChars)}\n(以下省略。全文は worklog list --verbose で確認できる)`;
  return { text, handoff };
}

// SessionEnd が発火しなかったセッションを後追いで確定させる。
// 判定は「end が無い」かつ「そのセッションのプロセスが生きていない」。時間ではなくプロセスの
// 生死で見るのは、長時間放置しただけの現役セッションを誤って閉じないため。
function finalizeDangling(key, currentSid, cwd) {
  const liveSids = new Set(liveSessions().map((s) => s.sessionId));
  const open = loadSessions(key).filter((s) => !s.endTs && s.sid !== currentSid && !liveSids.has(s.sid));
  for (const s of open) {
    try {
      const built = buildEndStats(s.cwd || cwd, key, s.sid, s.head, s.startTs);
      appendRecord(key, {
        k: 'end', sid: s.sid, ts: built.transcript.lastTs || Date.now(),
        reason: 'abandoned', // 正規の終了フックを踏んでいないことを残す
        branch: s.branch || null,
        stats: built.stats, aiTitle: built.aiTitle,
      });
    } catch (e) {
      logError('finalizeDangling', e);
    }
  }
}

// 記録をやめる条件。どちらも「作業セッションではないもの」を弾くためにある。
//  1. WORKLOG_DISABLE=1
//     自動要約が起動した claude から間接的に呼ばれている。これが無いと
//     要約 -> claude 起動 -> SessionStart/End -> 要約 の再帰になる。
//  2. headless 実行(claude -p)
//     -p の実行でもフックは発火する(実測)。スクリプトから claude を呼ぶたびに
//     中身のないセッション記録が増えると一覧が使い物にならなくなる。
//     entrypoint は対話起動で "cli"、-p 実行で "sdk-cli" になるため、これで判別する。
//     IDE 統合など将来の対話系の値を弾かないよう、除外は sdk/print 系に限定する。
function isDisabled() {
  if (process.env.WORKLOG_DISABLE === '1') return true;
  const ep = process.env.CLAUDE_CODE_ENTRYPOINT || '';
  return /^(sdk|print)/.test(ep);
}

function cmdSessionStart(flags) {
  if (isDisabled()) return process.stdout.write(JSON.stringify({ suppressOutput: true }));
  const cfg = loadConfig();
  const input = safeJson(readStdin()) || {};
  const cwd = input.cwd || one(flags, 'cwd', process.cwd());
  const sid = input.session_id || one(flags, 'session', process.env.CLAUDE_CODE_SESSION_ID) || 'unknown';
  const key = projectKey(cwd);
  const source = input.source || 'startup';

  appendRecord(key, {
    k: 'start', sid, ts: Date.now(), cwd,
    branch: gitBranch(cwd), head: gitHead(cwd), source,
  });

  finalizeDangling(key, sid, cwd);

  // resume / compact は同じ会話の続きで、過去ログは既にコンテキストに入っている。
  // 二重に入れても害があるだけなので、新規に始まったときだけ注入する
  const injectable = source === 'startup' || source === 'clear' || source === 'fork';
  const context = injectable ? buildContext(key, cwd, sid, cfg) : null;

  const out = { suppressOutput: true };
  if (context) {
    out.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: context.text };

    // 自走モード。引き継ぎを最初のユーザー発言として投入し、新セッションが開いた時点で
    // 前回の続きから動き出すようにする。既定では無効(勝手に走られると困る場面が多い)。
    // 古い引き継ぎは状況が変わっていて危険なので、鮮度で切る。
    const h = context.handoff;
    const fresh = h && h.ts && (Date.now() - h.ts) < cfg.handoffMaxAgeHours * 3600 * 1000;
    if (cfg.autoStartFromHandoff && h && h.explicit && fresh) {
      out.hookSpecificOutput.initialUserMessage = [
        '前回のセッションからの引き継ぎです。以下の続きから作業してください。',
        '着手前に、現在の作業ツリーの状態(git status)と対象ファイルが引き継ぎ内容と合っているかを確認すること。',
        '',
        h.text,
      ].join('\n');
    }
  }
  process.stdout.write(JSON.stringify(out));
}

// ---------------------------------------------------------------------------
//  SessionEnd フック
// ---------------------------------------------------------------------------

// 自動要約を掛けるだけの中身があったか。空セッションに課金しないための線引き
function worthSummarizing(stats) {
  if (!stats) return false;
  return stats.turns >= 2 || stats.edits > 0 || (stats.commits && stats.commits.length > 0);
}

function cmdSessionEnd(flags) {
  if (isDisabled()) return process.stdout.write(JSON.stringify({ suppressOutput: true }));
  const cfg = loadConfig();
  const input = safeJson(readStdin()) || {};
  const cwd = input.cwd || one(flags, 'cwd', process.cwd());
  const sid = input.session_id || one(flags, 'session', process.env.CLAUDE_CODE_SESSION_ID) || 'unknown';
  const key = projectKey(cwd);
  const reason = input.reason || one(flags, 'reason', 'unknown');

  const prior = loadSessions(key).find((s) => s.sid === sid);
  const built = buildEndStats(cwd, key, sid, prior && prior.head, prior && prior.startTs);

  appendRecord(key, {
    k: 'end', sid, ts: Date.now(), reason,
    branch: gitBranch(cwd),
    stats: built.stats, aiTitle: built.aiTitle,
  });

  // /wrap や /finish で手書き要約が既にあるなら、自動要約は不要(質も劣る)
  const hasNote = Boolean(prior && prior.noteTs);
  if (cfg.autoSummary && !hasNote && worthSummarizing(built.stats)) {
    spawnSummarizer(key, sid, cwd);
  }
  process.stdout.write(JSON.stringify({ suppressOutput: true }));
}

// 要約は claude の起動を待つ必要があり、フック内で待つと終了が遅れて体感を悪くする。
// 完全に切り離した子プロセスに投げ、親(フック)は即座に終わる。
function spawnSummarizer(key, sid, cwd) {
  try {
    const child = spawn(process.execPath, [
      __filename, 'summarize', '--project', key, '--session', sid, '--cwd', cwd,
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (e) {
    logError('spawnSummarizer', e);
  }
}

// ---------------------------------------------------------------------------
//  自動要約(haiku)
// ---------------------------------------------------------------------------

// Windows では拡張子なしの spawn が解決に失敗しうるので PATH を自分で引く。
// 解決できなかったことを errors.log に残せるようにするのが主目的(黙って要約が
// 出ないのが一番困る)。
function resolveClaudeBin() {
  const explicit = process.env.WORKLOG_CLAUDE_BIN;
  if (explicit) return explicit;
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  dirs.unshift(path.join(HOME, '.local', 'bin')); // 既定のインストール先を優先
  for (const d of dirs) {
    for (const ext of exts) {
      const p = path.join(d, `claude${ext}`);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        // 次の候補へ
      }
    }
  }
  return null;
}

const SUMMARY_PROMPT = [
  'あなたは開発作業ログの要約器です。以下は Claude Code の 1 セッションの記録です。',
  'このセッションで「何をしたか」を日本語 1 行(60文字以内)で要約してください。',
  '成果物・変更対象が分かる具体的な書き方にし、「作業を行った」のような内容のない表現は避けます。',
  '出力は要約 1 行のみ。前置き・引用符・箇条書き・改行を付けないこと。',
].join('\n');

// 会話全体を渡すと入力が数百KBになり課金が読めないため、要約に効く部分だけを抜いて詰める
function buildDigest(cwd, sessions, key, sid, cfg) {
  const s = sessions.find((x) => x.sid === sid) || {};
  const tr = parseTranscript(transcriptPathFor(key, sid));
  const st = s.stats || {};
  const lines = [];
  lines.push(`プロジェクト: ${cwd}${s.branch ? ` (branch ${s.branch})` : ''}`);
  if (s.startTs) lines.push(`時刻: ${fmtTime(s.startTs)} 〜 ${fmtTime(s.endTs || Date.now())}`);
  if (tr.aiTitle) lines.push(`自動タイトル: ${tr.aiTitle}`);
  if (tr.prompts.length) {
    lines.push('ユーザーの指示:');
    tr.prompts.slice(0, 12).forEach((p, i) => lines.push(`  ${i + 1}. ${truncate(p, 200)}`));
  }
  const files = uniq([...(st.editedFiles || []), ...(st.files || [])]);
  if (files.length) lines.push(`変更・編集したファイル: ${files.slice(0, 15).join(', ')}`);
  if (st.commits && st.commits.length) lines.push(`コミット: ${st.commits.join(' / ')}`);
  if (tr.lastAssistant) lines.push(`最後の応答(抜粋): ${truncate(tr.lastAssistant, 400)}`);
  let text = lines.join('\n');
  if (text.length > cfg.digestMaxChars) text = text.slice(0, cfg.digestMaxChars);
  return text;
}

function cmdSummarize(flags) {
  const cfg = loadConfig();
  const key = one(flags, 'project');
  const sid = one(flags, 'session');
  const cwd = one(flags, 'cwd', process.cwd());
  if (!key || !sid) throw new Error('summarize には --project と --session が必要');

  const sessions = loadSessions(key);
  if (sessions.find((s) => s.sid === sid && s.noteTs)) return; // 途中で /wrap されていたら不要
  const digest = buildDigest(cwd, sessions, key, sid, cfg);
  if (!digest.trim()) return;

  const bin = resolveClaudeBin();
  if (!bin) {
    logError('cmdSummarize', new Error('claude 実行ファイルが見つからない(WORKLOG_CLAUDE_BIN で指定可)'));
    return;
  }

  // --no-session-persistence: 要約用の使い捨て会話をセッション一覧やログに残さないため。
  // --max-turns 1 + ツール禁止: 1 行返すだけの仕事にツール実行の余地を与えない(コストと時間)。
  const args = [
    '-p', SUMMARY_PROMPT,
    '--no-session-persistence',
    '--model', cfg.summaryModel,
    '--max-turns', '1',
    '--output-format', 'text',
    '--disallowedTools', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task',
  ];

  let stdout = '';
  try {
    stdout = execFileSync(bin, args, {
      input: digest, encoding: 'utf8', timeout: 120000,
      // stderr も拾う。失敗理由("Not logged in" など)が分からないと原因追跡ができない
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd,
      // この claude のフックから worklog が再び呼ばれるのを止める(無限再帰の防止)
      env: { ...process.env, WORKLOG_DISABLE: '1' },
    });
  } catch (e) {
    const stderr = e && e.stderr ? String(e.stderr).trim() : '';
    logError('cmdSummarize/exec', new Error(`${e && e.message ? e.message : e}${stderr ? `\n  stderr: ${stderr}` : ''}`));
    return;
  }

  // モデルが指示に反して複数行返すことがあるので、意味のある最初の行だけ採る
  const summary = truncate((stdout.split('\n').map((l) => l.trim()).find((l) => l) || ''), 120)
    .replace(/^["'「『]|["'」』]$/g, '');
  if (!summary) return;
  appendRecord(key, { k: 'auto', sid, ts: Date.now(), summary, model: cfg.summaryModel });
}

// ---------------------------------------------------------------------------
//  記録の追加(/wrap・/finish から呼ばれる)
// ---------------------------------------------------------------------------

// セッション ID は Claude Code がツール実行時に環境変数で渡してくれるのでそれを使う。
// 取れない場合(手で叩いたとき等)は、この cwd で end が無い最新セッションに寄せる。
function resolveSid(flags, key) {
  const explicit = one(flags, 'session') || process.env.CLAUDE_CODE_SESSION_ID;
  if (explicit && typeof explicit === 'string') return explicit;
  const open = loadSessions(key).find((s) => !s.endTs);
  return open ? open.sid : null;
}

function cmdAdd(flags) {
  const cwd = one(flags, 'cwd', process.cwd());
  const key = projectKey(cwd);
  const sid = resolveSid(flags, key);
  if (!sid) {
    console.error('セッションを特定できなかった。--session <id> を指定するか、フックが動いているか確認する。');
    process.exitCode = 1;
    return;
  }
  const summary = one(flags, 'summary');
  const done = many(flags, 'done');
  const next = many(flags, 'next');
  const docs = many(flags, 'doc', 'docs');
  // 引き継ぎ文は複数行になる。--handoff を繰り返すか --handoff-stdin で渡せるようにして、
  // シェルの改行エスケープに悩まされないようにする
  const handoffParts = many(flags, 'handoff');
  const handoff = one(flags, 'handoff-stdin') ? readStdin().trim() : handoffParts.join('\n');
  if (!summary && !done.length && !next.length && !docs.length && !handoff) {
    console.error('--summary / --done / --next / --doc / --handoff のいずれかが必要。');
    process.exitCode = 1;
    return;
  }

  // start レコードが無いセッション(フック未設定・後から有効化した場合)でも記録は残したい。
  // 開始時刻が無いと一覧で並べられないので、最低限の start を補って整合させる
  if (!loadSessions(key).some((s) => s.sid === sid)) {
    appendRecord(key, { k: 'start', sid, ts: Date.now(), cwd, branch: gitBranch(cwd), head: gitHead(cwd), source: 'backfilled' });
  }

  appendRecord(key, {
    k: 'note', sid, ts: Date.now(),
    via: one(flags, 'via', 'wrap'),
    summary: summary || null,
    done, next, docs,
    handoff: handoff || null,
  });

  const bits = [];
  if (summary) bits.push(`要約「${truncate(summary, 40)}」`);
  if (done.length) bits.push(`済み ${done.length} 件`);
  if (next.length) bits.push(`次 ${next.length} 件`);
  if (docs.length) bits.push(`文書 ${docs.length} 件`);
  if (handoff) bits.push('引き継ぎ文あり');
  console.log(`worklog に記録した: ${bits.join(' / ')}  [${key} ${sid.slice(0, 8)}]`);
}

// ---------------------------------------------------------------------------
//  閲覧系
// ---------------------------------------------------------------------------

function renderSession(s, opts = {}) {
  const st = s.stats || {};
  const head = `${fmtTime(s.startTs)}${s.endTs ? `-${fmtTime(s.endTs).slice(6)}` : ''}`;
  // 手書き(wrap/finish)は無印、自動要約は "~"、Claude Code の自動タイトル流用は "?" を付けて
  // 情報の確度を見分けられるようにする。`??` なのは無印が空文字で falsy になるため
  const src = { wrap: '', finish: '', auto: '~', title: '?' }[s.summarySource] ?? '';
  const proj = opts.showProject && s.project ? ` ${cyan(shortProject(s.project))}` : '';
  const branch = s.branch ? dim(` [${s.branch}]`) : '';
  const summary = s.summary ? `${src}${s.summary}` : dim('(要約なし)');

  const facts = [];
  if (st.commits && st.commits.length) facts.push(`${st.commits.length}c`);
  if (st.files && st.files.length) facts.push(`${st.files.length}f`);
  if (st.turns) facts.push(`${st.turns}turn`);
  if (st.durationMs) facts.push(fmtDuration(st.durationMs));
  if (!s.endTs) facts.push(yellow('進行中'));
  else if (s.reason === 'abandoned') facts.push(dim('終了不明'));
  const shown = facts.filter(Boolean); // fmtDuration は 1 分未満で空を返すため
  const factStr = shown.length ? dim(` (${shown.join(' ')})`) : '';

  const lines = [`${dim(head)}${proj}${branch} ${summary}${factStr}`];
  if (opts.verbose) {
    for (const d of s.done || []) lines.push(`    done: ${d}`);
    for (const n of s.next || []) lines.push(`    ${bold('next')}: ${n}`);
    for (const d of s.docs || []) lines.push(`    docs: ${d}`);
    if (s.handoff) lines.push(s.handoff.split('\n').map((l) => `    ${bold('handoff')}| ${l}`).join('\n'));
    for (const c of st.commits || []) lines.push(`    ${dim(`commit ${c}`)}`);
    if (st.files && st.files.length) lines.push(`    ${dim(`files: ${st.files.slice(0, 10).join(', ')}`)}`);
    lines.push(`    ${dim(`session ${s.sid}`)}`);
  } else {
    if (s.next && s.next.length) lines.push(`    ${bold('next')}: ${s.next.map((n) => truncate(n, 70)).join(' / ')}`);
  }
  return lines.join('\n');
}

// C--claude-ClaudeCode のようなキーは長いので、末尾の意味のある部分だけ出す
function shortProject(key) {
  const parts = String(key).split('-').filter(Boolean);
  return parts.slice(-1)[0] || key;
}

function resolveTargetKeys(flags) {
  if (flags.all) return listProjectKeys();
  const explicit = one(flags, 'project');
  if (typeof explicit === 'string') {
    // 完全なキーでも部分一致でも受ける(手で打つときに楽なため)
    const all = listProjectKeys();
    const hit = all.filter((k) => k === explicit || k.toLowerCase().includes(explicit.toLowerCase()));
    return hit.length ? hit : [projectKey(explicit)];
  }
  return [projectKey(one(flags, 'cwd', process.cwd()))];
}

function cmdList(flags) {
  const keys = resolveTargetKeys(flags);
  const n = Number(one(flags, 'n', 10)) || 10;
  const verbose = Boolean(one(flags, 'verbose', flags.v ? true : false));
  const showProject = keys.length > 1;

  const sessions = keys.flatMap((k) => loadSessions(k).map((s) => ({ ...s, project: k })))
    .sort((a, b) => (b.startTs || 0) - (a.startTs || 0))
    .slice(0, n);

  if (!sessions.length) {
    console.log('記録がまだない。フックを設定したか、対象プロジェクトが合っているか確認する。');
    return;
  }
  console.log(bold(showProject ? '直近の作業ログ (全プロジェクト)' : `直近の作業ログ (${keys.map(shortProject).join(', ')})`));
  for (const s of sessions) console.log(renderSession(s, { verbose, showProject }));
}

function cmdToday(flags) {
  const keys = flags.project ? resolveTargetKeys(flags) : listProjectKeys();
  const days = Number(one(flags, 'days', 1)) || 1;
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));
  const from = since.getTime();

  const sessions = keys.flatMap((k) => loadSessions(k).map((s) => ({ ...s, project: k })))
    .filter((s) => (s.startTs || 0) >= from)
    .sort((a, b) => (a.startTs || 0) - (b.startTs || 0));

  if (!sessions.length) {
    console.log(days > 1 ? `直近 ${days} 日の記録はない。` : '今日の記録はまだない。');
    return;
  }
  let currentDay = null;
  for (const s of sessions) {
    const day = fmtDay(s.startTs);
    if (day !== currentDay) {
      console.log(`\n${bold(day)}`);
      currentDay = day;
    }
    console.log(renderSession(s, { showProject: true, verbose: Boolean(one(flags, 'verbose', false)) }));
  }
  const projects = uniq(sessions.map((s) => shortProject(s.project)));
  console.log(`\n${dim(`${sessions.length} セッション / ${projects.length} プロジェクト: ${projects.join(', ')}`)}`);
}

function cmdLive() {
  const live = liveSessions();
  if (!live.length) {
    console.log('起動中の Claude Code セッションはない。');
    return;
  }
  console.log(bold(`起動中のセッション (${live.length})`));
  for (const s of live) {
    const key = projectKey(s.cwd || '');
    const rec = loadSessions(key).find((x) => x.sid === s.sessionId);
    const elapsed = s.startedAt ? fmtDuration(Date.now() - s.startedAt) : '';
    const status = s.status === 'busy' ? yellow('busy') : dim(s.status || '?');
    const summary = rec && rec.summary ? ` ${dim(`直近の記録: ${truncate(rec.summary, 50)}`)}` : '';
    console.log(`  ${status} ${cyan(s.name || s.sessionId.slice(0, 8))} ${s.cwd || '?'} ${dim(`pid ${s.pid} / ${elapsed}`)}${summary}`);
  }
  // 同一ディレクトリでの並列は編集衝突の原因になるので目立たせる
  const byCwd = new Map();
  for (const s of live) {
    const c = path.resolve(s.cwd || '?');
    byCwd.set(c, (byCwd.get(c) || 0) + 1);
  }
  for (const [c, n] of byCwd) {
    if (n > 1) console.log(yellow(`  ! ${c} で ${n} セッションが並列稼働中`));
  }
}

function cmdContext(flags) {
  const cfg = loadConfig();
  const cwd = one(flags, 'cwd', process.cwd());
  const key = projectKey(cwd);
  const sid = one(flags, 'session', process.env.CLAUDE_CODE_SESSION_ID);
  const ctx = buildContext(key, cwd, sid, cfg);
  console.log(ctx ? ctx.text : '(注入できる履歴がない)');
}

// 引き継ぎ文だけを取り出す。別セッションや別マシンへ手で渡したいとき用。
// Windows なら `worklog handoff | clip` でそのままクリップボードに入る。
function cmdHandoff(flags) {
  const keys = resolveTargetKeys(flags);
  const sessions = keys.flatMap((k) => loadSessions(k).map((s) => ({ ...s, project: k })))
    .sort((a, b) => (b.startTs || 0) - (a.startTs || 0));
  const currentSid = one(flags, 'session', process.env.CLAUDE_CODE_SESSION_ID);
  const h = latestHandoff(sessions.filter((s) => s.sid !== currentSid));
  if (!h) {
    console.log('引き継ぎ文が記録されていない。セッション終了時に /finish を実行すると記録される。');
    return;
  }
  // --raw は貼り付け用。見出しや注記を付けずに本文だけ出す
  if (one(flags, 'raw')) {
    console.log(h.text);
    return;
  }
  console.log(`${bold(`次回の始め方 (${fmtTime(h.ts)} / ${shortProject(h.from.project || keys[0])})`)}`);
  if (h.from.summary) console.log(dim(`前回: ${h.from.summary}`));
  console.log('');
  console.log(h.text);
  if (!h.explicit) console.log(dim('\n(/finish の引き継ぎ文ではなく「次にやること」から生成)'));
}

function cmdExport(flags) {
  const keys = flags.all ? listProjectKeys() : resolveTargetKeys(flags);
  const sinceStr = one(flags, 'since');
  const from = sinceStr ? Date.parse(sinceStr) : null;

  const sessions = keys.flatMap((k) => loadSessions(k).map((s) => ({ ...s, project: k })))
    .filter((s) => (from ? (s.startTs || 0) >= from : true))
    .sort((a, b) => (b.startTs || 0) - (a.startTs || 0));

  const out = [];
  out.push('# 作業ログ');
  out.push('');
  out.push(`生成: ${new Date().toISOString()} / ${sessions.length} セッション`);
  out.push('');
  let day = null;
  for (const s of sessions) {
    const d = fmtDay(s.startTs);
    if (d !== day) {
      out.push(`## ${d}`);
      out.push('');
      day = d;
    }
    const st = s.stats || {};
    out.push(`### ${fmtTime(s.startTs)} ${shortProject(s.project)}${s.branch ? ` [${s.branch}]` : ''}`);
    out.push('');
    out.push(`- 要約: ${s.summary || '(なし)'}${s.summarySource === 'auto' ? ' (自動生成)' : s.summarySource === 'title' ? ' (自動タイトル)' : ''}`);
    if (s.done && s.done.length) out.push(`- やったこと:\n${s.done.map((x) => `  - ${x}`).join('\n')}`);
    if (s.next && s.next.length) out.push(`- 次にやること:\n${s.next.map((x) => `  - ${x}`).join('\n')}`);
    if (s.docs && s.docs.length) out.push(`- 更新した文書:\n${s.docs.map((x) => `  - ${x}`).join('\n')}`);
    if (s.handoff) out.push(`- 次回の始め方:\n${s.handoff.split('\n').map((x) => `  > ${x}`).join('\n')}`);
    if (st.commits && st.commits.length) out.push(`- コミット:\n${st.commits.map((x) => `  - \`${x}\``).join('\n')}`);
    if (st.files && st.files.length) out.push(`- 変更ファイル: ${st.files.map((f) => `\`${f}\``).join(', ')}`);
    out.push(`- セッション: \`${s.sid}\``);
    out.push('');
  }
  process.stdout.write(out.join('\n'));
}

function cmdHelp() {
  console.log(`claude-worklog - Claude Code のセッション作業ログ

閲覧:
  worklog list [--project <名前>|--all] [-n 10] [--verbose]
                          直近のセッションを一覧(既定は現在のディレクトリのプロジェクト)
  worklog today [--days N] [--verbose]
                          今日(または直近 N 日)の作業を全プロジェクト横断で表示
  worklog live            起動中のセッションと並列状況を表示
  worklog handoff [--raw] 前セッションが残した「次回の始め方」を表示
                          (Windows なら worklog handoff --raw | clip で貼り付け用にコピー)
  worklog context         次セッションに注入されるテキストを確認
  worklog export [--all] [--since YYYY-MM-DD] > WORKLOG.md
                          Markdown に書き出す

記録(通常は /wrap・/finish 経由で呼ばれる):
  worklog add --summary "一行要約" [--done "..."] [--next "..."] [--doc "..."]
              [--handoff "次回の始め方(繰り返し指定で複数行)"] [--handoff-stdin]
              [--session <id>] [--via wrap|finish]

フック(settings.json から呼ばれる。手で叩く必要はない):
  worklog session-start   stdin にフック JSON。start を記録し過去ログを注入
  worklog session-end     stdin にフック JSON。統計を確定し自動要約を起動
  worklog summarize --project <key> --session <id> [--cwd <path>]

保存先: ${LOG_DIR}
設定:   ${CONFIG_PATH}
        autoSummary / summaryModel / contextSessions / contextMaxChars
        autoStartFromHandoff: true にすると、新セッション開始時に引き継ぎを
        最初の発言として自動投入し、前回の続きから動き出す(既定 false)
`);
}

// ---------------------------------------------------------------------------
//  エントリポイント
// ---------------------------------------------------------------------------

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'help';
  const { flags } = parseArgs(argv.slice(1));

  switch (cmd) {
    case 'session-start': return cmdSessionStart(flags);
    case 'session-end': return cmdSessionEnd(flags);
    case 'summarize': return cmdSummarize(flags);
    case 'add': return cmdAdd(flags);
    case 'list': case 'ls': return cmdList(flags);
    case 'today': return cmdToday(flags);
    case 'live': return cmdLive(flags);
    case 'handoff': return cmdHandoff(flags);
    case 'context': return cmdContext(flags);
    case 'export': return cmdExport(flags);
    case 'help': case '--help': case '-h': return cmdHelp();
    default:
      console.error(`不明なコマンド: ${cmd}`);
      cmdHelp();
      process.exitCode = 1;
      return undefined;
  }
}

// フックとして呼ばれた場合、例外で終了コードが立つとセッション側に警告が出る。
// 記録の失敗はセッションを妨げるべきではないので、フック経路は必ず exit 0 にする。
const IS_HOOK = /^(session-start|session-end|summarize)$/.test(process.argv[2] || '');
try {
  main();
} catch (e) {
  logError(process.argv[2] || 'main', e);
  if (IS_HOOK) {
    process.stdout.write(JSON.stringify({ suppressOutput: true }));
    process.exitCode = 0;
  } else {
    console.error(`エラー: ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  }
}
