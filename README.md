# claude-code-tools

Claude Code の運用を補助する自作ツール群。各ツールは独立して動作し、ツール間で共有するコードはありません。

| ツール | 概要 |
| --- | --- |
| [account-guard](account-guard/) | 複数の Claude アカウントを使い分けるとき、特定のディレクトリツリーを許可したアカウント以外から触れないようにする。PreToolUse フックでツール呼び出しを拒否。`/login` を踏まずに credentials の入れ替えでアカウントを切り替える `swap` も同梱(Node.js 標準機能のみ、依存なし) |
| [claude-statusline](claude-statusline/) | コンテキスト使用率・セッションコスト・プラン利用枠を 1 行に収めて常時表示するステータスライン(Node.js 標準機能のみ、依存なし) |
| [claude-window-keeper](claude-window-keeper/) | 5 時間ごとの利用上限ウィンドウの開始時刻を固定し、リセット時刻を予測できるようにする(PowerShell + タスクスケジューラ) |
| [claude-worklog](claude-worklog/) | セッションごとの作業記録を自動で溜め、次のセッションに引き継ぐ。`/wrap` `/finish` と SessionStart/SessionEnd フック(Node.js 標準機能のみ、依存なし) |
| [usage-tracker](usage-tracker/) | 5 時間枠と週次枠の使用率を statusline 経由で記録し、「5 時間枠を何回使い切ったら週次リミットに当たるか」を回帰で推定する。自己完結 HTML レポートを生成。別系統として会話 transcript を直接読み、コンテキスト長がターン単価をどれだけ押し上げるかを測る分析スクリプトも同梱(Node.js 標準機能のみ、依存なし) |

セットアップ手順は各ツールの README を参照してください。

## 運用メモ

ツールに紐づかない運用上の検討記録は [docs/](docs/) に置いています。

| ドキュメント | 概要 |
| --- | --- |
| [account-separation.md](docs/account-separation.md) | 組織アカウントと個人アカウントを併用する場合の事実整理・情報が混ざる経路・ディレクトリ単位でアカウントを強制するガードの設計 |

## ライセンス

MIT License. 詳細は [LICENSE](LICENSE) を参照してください。
各ツールは単体で配布できるよう、フォルダ内にも同じ内容の LICENSE を同梱しています(意図的な複製です)。

**無保証**です。Claude Code の利用上限や入力仕様は Anthropic 側の変更で変わる可能性があります。
