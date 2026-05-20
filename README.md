# cross-agent

複数の外部エージェント（Codex、Claude Subagent など）に横断的にセカンドオピニオン・
批判的レビューを依頼する Claude Code プラグイン。

> **ステータス**: テンプレート / 骨子段階。各 `SKILL.md` の `TODO` を埋めて実装を進めます。

## 構成

```
cross-agent/
├── .claude-plugin/
│   └── plugin.json                  # プラグインマニフェスト
├── skills/
│   ├── cross-agent/SKILL.md         # オーケストレーター（/cross-agent）
│   ├── codex-subagent/SKILL.md      # Codex CLI 固有の実装
│   └── claude-subagent/SKILL.md     # Claude Subagent 固有の実装
├── docs/
│   ├── SKILL.md                     # 既存 advice スキル（移植元の参照）
│   └── cross-agent-design.md        # 設計骨子
└── README.md
```

## 設計の要点

- **オーケストレーター + サブスキル**: `cross-agent` は中身を生成せず、コンテキストを
  組み立てて各エージェント Skill に委譲し、結果を統合する
- **責務分離**: セッション管理（ID・マッピング・永続化）は各サブスキルが自律的に持つ
- **状態の永続化先**: `${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json`
  （`${CLAUDE_PLUGIN_ROOT}` は更新時に変わる ephemeral なため使わない）

## ローカルでの動作確認

```bash
claude --plugin-dir /path/to/cross-agent
claude plugin validate /path/to/cross-agent
```

## 配布

marketplace 経由で配布する場合は `.claude-plugin/marketplace.json` を持つ
リポジトリにこのプラグインを登録する（別途用意）。
