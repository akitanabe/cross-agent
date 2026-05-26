# cross-agent

外部エージェント（Codex、Claude など）を選んでセカンドオピニオン・
批判的レビューを依頼する Claude Code プラグイン。

> **ステータス**: テンプレート / 骨子段階。各 `SKILL.md` の `TODO` を埋めて実装を進めます。

## 構成

```
cross-agent/
├── .claude-plugin/
│   └── plugin.json                  # プラグインマニフェスト
├── agents/
│   └── codex-agent.md               # Codex adapter を実行する subagent
├── skills/
│   ├── review/SKILL.md              # オーケストレーター（cross-agent:review）
│   ├── codex-adapter/SKILL.md       # Codex CLI 固有の実装
│   └── claude-adapter/SKILL.md      # Claude 固有の実装
├── docs/
│   ├── cross-agent-spec.md          # cross-agent 詳細仕様
│   └── codex-adapter-spec.md        # codex-adapter 詳細仕様
├── scripts/
│   ├── cross-agent-runner.mjs       # cross-agent runner
│   └── codex-adapter-runner.mjs     # Codex adapter runner
├── src/
│   ├── runners/                     # runner の TypeScript 正本
│   └── core/                        # 責務別の共有実装
├── test/                            # Vitest テスト
├── tools/
│   └── build.mjs                    # esbuild bundle
└── README.md
```

## 設計の要点

- **オーケストレーター + アダプター**: `cross-agent` は中身を生成せず、コンテキストを
  組み立てて各エージェント adapter に委譲し、結果を統合する
- **Codex subagent**: `codex-agent` は request envelope file path を受け取り、`codex-adapter`
  skill の手順で Codex adapter runner を実行して response envelope file path だけを返す
- **責務分離**: セッション管理（ID・マッピング・永続化）は各 adapter が自律的に持つ
- **状態の永続化先**: `${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json`
  （`${CLAUDE_PLUGIN_ROOT}` は更新時に変わる ephemeral なため使わない）

## ローカルでの動作確認

前提:

- Node.js 24+

```bash
npm install
npm run check
npm test
claude --plugin-dir /path/to/cross-agent
claude plugin validate /path/to/cross-agent
```

runner は `src/runners/*.ts` を正本とし、`npm run build` で `scripts/*.mjs` に bundle する。

```bash
node scripts/cross-agent-runner.mjs prepare-initial --data-dir /path/to/data --review-session-id session-1
node scripts/codex-adapter-runner.mjs prepare --data-dir /path/to/data --request /path/to/request-envelope.json
node scripts/codex-adapter-runner.mjs complete --data-dir /path/to/data --run /path/to/round-1-codex-run.json
node scripts/cross-agent-runner.mjs complete-round --data-dir /path/to/data --response-file /path/to/response-envelope.json
```

## 配布

marketplace 経由で配布する場合は `.claude-plugin/marketplace.json` を持つ
リポジトリにこのプラグインを登録する（別途用意）。
