# claude-code-tools

Claude Code の運用を補助する自作ツール群。各ツールは独立して動作し、ツール間で共有するコードはありません。

| ツール | 概要 |
| --- | --- |
| [claude-statusline](claude-statusline/) | コンテキスト使用率・セッションコスト・プラン利用枠を 1 行に収めて常時表示するステータスライン(Node.js 標準機能のみ、依存なし) |
| [claude-window-keeper](claude-window-keeper/) | 5 時間ごとの利用上限ウィンドウの開始時刻を固定し、リセット時刻を予測できるようにする(PowerShell + タスクスケジューラ) |

セットアップ手順は各ツールの README を参照してください。

## リポジトリ構成の方針

対象環境(Claude Code)ごとに 1 リポジトリとし、その中をツール単位のフォルダに分けています。
どちらも数ファイル規模のため、リポジトリを分けずに一箇所へまとめています。

各ツールのフォルダは単体で完結しており(claude-window-keeper は LICENSE 込みでフォルダごと配布可能)、
独立したリポジトリとして切り出したくなった場合は履歴付きのまま分離できます。

```
git subtree split --prefix=claude-statusline -b split-statusline
```
