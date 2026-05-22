# cross-agent

外部エージェント（Codex、Claude など）を選んでセカンドオピニオン・
批判的レビューを依頼する Claude Code プラグイン。

> **ステータス**: テンプレート / 骨子段階。各 `SKILL.md` の `TODO` を埋めて実装を進めます。

## 構成

```
cross-agent/
├── .claude-plugin/
│   └── plugin.json                  # プラグインマニフェスト
├── skills/
│   ├── cross-agent/SKILL.md         # オーケストレーター（/cross-agent）
│   ├── codex-adapter/SKILL.md       # Codex CLI 固有の実装
│   └── claude-adapter/SKILL.md      # Claude 固有の実装
├── docs/
│   ├── SKILL.md                     # 既存 advice スキル（移植元の参照）
│   ├── cross-agent-spec.md          # cross-agent 詳細仕様
│   └── codex-adapter-spec.md        # codex-adapter 詳細仕様
├── scripts/
│   ├── cross-agent-runner.mjs       # cross-agent runner
│   └── codex-adapter-runner.mjs     # Codex adapter runner
├── test/
│   ├── cross-agent.test.mjs         # cross-agent runner のテスト
│   └── codex-adapter.test.mjs       # Codex adapter runner のテスト
└── README.md
```

## 設計の要点

- **オーケストレーター + アダプター**: `cross-agent` は中身を生成せず、コンテキストを
  組み立てて各エージェント adapter に委譲し、結果を統合する
- **責務分離**: セッション管理（ID・マッピング・永続化）は各 adapter が自律的に持つ
- **状態の永続化先**: `${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json`
  （`${CLAUDE_PLUGIN_ROOT}` は更新時に変わる ephemeral なため使わない）

## ローカルでの動作確認

前提:

- Node.js 24+

```bash
claude --plugin-dir /path/to/cross-agent
claude plugin validate /path/to/cross-agent
node --test
```

Codex adapter の実行ロジックは Node.js スクリプトとして実装する。

```bash
node scripts/cross-agent-runner.mjs prepare-initial --input /path/to/input.json
node scripts/codex-adapter-runner.mjs --request /path/to/request-envelope.json
node scripts/cross-agent-runner.mjs complete-round --input /path/to/complete-round.json
```

## 配布

marketplace 経由で配布する場合は `.claude-plugin/marketplace.json` を持つ
リポジトリにこのプラグインを登録する（別途用意）。
