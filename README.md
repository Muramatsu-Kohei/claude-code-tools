# claude-code-tools

Claude Code の運用を補助する自作ツール群。各ツールは独立して動作し、ツール間で共有するコードはありません。

| ツール | 概要 |
| --- | --- |
| [claude-statusline](claude-statusline/) | コンテキスト使用率・セッションコスト・プラン利用枠を 1 行に収めて常時表示するステータスライン(Node.js 標準機能のみ、依存なし) |
| [claude-window-keeper](claude-window-keeper/) | 5 時間ごとの利用上限ウィンドウの開始時刻を固定し、リセット時刻を予測できるようにする(PowerShell + タスクスケジューラ) |
| [claude-worklog](claude-worklog/) | セッションごとの作業記録を自動で溜め、次のセッションに引き継ぐ。`/wrap` `/finish` と SessionStart/SessionEnd フック(Node.js 標準機能のみ、依存なし) |

セットアップ手順は各ツールの README を参照してください。

## ライセンス

MIT License. 詳細は [LICENSE](LICENSE) を参照してください。
各ツールは単体で配布できるよう、フォルダ内にも同じ内容の LICENSE を同梱しています(意図的な複製です)。

**無保証**です。Claude Code の利用上限や入力仕様は Anthropic 側の変更で変わる可能性があります。
