# CLAUDE.md

このリポジトリは **Claude Code プラグイン `cross-agent`** のソース。外部エージェント
（Codex、Claude など）を選んでセカンドオピニオン・批判的レビューを依頼する。

> 注: この CLAUDE.md はプラグインがインストールされた先では読み込まれない（プラグインの
> CLAUDE.md は project context にならない仕様）。**このプラグイン自体を開発するときの**
> コンテキストとしてのみ使う。エンドユーザーへの指示は各 `SKILL.md` に書く。

## ステータス

テンプレート / 骨子段階。各 `SKILL.md` の `TODO` を埋めて実装を進める。

## 構成

```
.claude-plugin/plugin.json     # マニフェスト（name 必須。strict 検証を通すこと）
skills/
  cross-agent/SKILL.md         # オーケストレーター（/cross-agent, user-invocable）
  codex-adapter/SKILL.md       # Codex CLI 固有の実装（user-invocable: false）
  claude-adapter/SKILL.md      # Claude 固有の実装（user-invocable: false）
docs/
  cross-agent-design.md        # 設計骨子（責務分離・セッション管理方針）
  codex-adapter-spec.md        # codex-adapter 詳細仕様
  SKILL.md                     # 移植元の既存 advice スキル（Codex 実装の参照）
scripts/
  codex-adapter.mjs            # Codex adapter runner
test/
  codex-adapter.test.mjs       # Codex adapter runner のテスト
```

## 設計の要点

- **オーケストレーター + アダプター**: `cross-agent` は中身を生成せず、コンテキストを
  組み立てて各エージェント adapter に委譲し、結果を統合する
- **責務分離**: セッション管理（ID 生成・マッピング・永続化）は各 adapter が自律的に持つ。
  cross-agent はセッションの中身を知らない
- **拡張性**: 新エージェント追加は `skills/<name>-adapter/SKILL.md` を増やすだけ

## 厳守ルール

- **状態の永続化は `${CLAUDE_PLUGIN_DATA}` に書く。`${CLAUDE_PLUGIN_ROOT}` は不可。**
  ROOT は更新のたびに変わる ephemeral なディレクトリで、marketplace 経由では read-only。
  セッション JSON 等は `${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json`
- マニフェスト・コンポーネントを変更したら `claude plugin validate . --strict` を通す
- skills/agents/hooks はプラグインルート直下に置く（`.claude-plugin/` の中ではない）

## よく使うコマンド

```bash
claude plugin validate . --strict      # マニフェスト + frontmatter 検証
claude --plugin-dir .                   # ローカルでこのプラグインを読み込んで起動
```

## git

- ブランチ: `main`
- author: akitanabe <tanabe@determaind.biz>（global 設定）
