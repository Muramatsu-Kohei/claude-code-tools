# claude-code-tools

Claude Code の運用を補助する自作ツール群。各ツールは独立して動作し、ツール間で共有するコードはありません。

| ツール | 概要 |
| --- | --- |
| [claude-statusline](claude-statusline/) | コンテキスト使用率・セッションコスト・プラン利用枠を 1 行に収めて常時表示するステータスライン(Node.js 標準機能のみ、依存なし) |
| [claude-window-keeper](claude-window-keeper/) | 5 時間ごとの利用上限ウィンドウの開始時刻を固定し、リセット時刻を予測できるようにする(PowerShell + タスクスケジューラ) |

セットアップ手順は各ツールの README を参照してください。

## リポジトリ構成の方針

対象環境(Claude Code)ごとに 1 リポジトリとし、その中をツール単位のフォルダに分けています。
どちらも数ファイル規模で単独配布の予定もないため、リポジトリを分けずに一箇所へまとめています。

将来いずれかのツールを独立配布したくなった場合は、履歴付きのまま切り出せます。

```
git subtree split --prefix=claude-statusline -b split-statusline
```
