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
│   └── cross-agent-design.md        # 設計骨子
└── README.md
```

## 設計の要点

- **オーケストレーター + アダプター**: `cross-agent` は中身を生成せず、コンテキストを
  組み立てて各エージェント adapter に委譲し、結果を統合する
- **責務分離**: セッション管理（ID・マッピング・永続化）は各 adapter が自律的に持つ
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
