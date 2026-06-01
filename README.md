# cross-agent

外部エージェント（Codex、Claude など）を選んでセカンドオピニオン・
批判的レビューを依頼する Claude Code プラグイン。

> **ステータス**: v1.0.1 としてリリース済み。v1 runner と adapter 契約、実機 Codex / Claude フローは検証済みです。

## 構成

```
cross-agent/
├── .claude-plugin/
│   └── marketplace.json             # Claude Code marketplace catalog
├── plugin/                          # Claude Code plugin package
│   ├── .claude-plugin/
│   │   └── plugin.json              # プラグインマニフェスト
│   ├── agents/
│   │   ├── codex-agent.md           # Codex adapter を実行する subagent
│   │   └── claude-agent.md          # Claude adapter を実行する subagent
│   ├── skills/
│   │   ├── agent-review/SKILL.md    # オーケストレーター（agent-review）
│   │   ├── codex-adapter/SKILL.md   # Codex CLI 固有の実装
│   │   └── claude-adapter/SKILL.md  # Claude 固有の実装
│   └── scripts/
│       ├── agent-review-runner.mjs   # agent-review runner
│       ├── codex-adapter-runner.mjs # Codex adapter runner
│       └── claude-adapter-runner.mjs # Claude adapter runner
├── docs/
│   ├── agent-review-spec.md          # agent-review 詳細仕様
│   ├── codex-adapter-spec.md        # codex-adapter 詳細仕様
│   └── claude-adapter-spec.md       # claude-adapter 詳細仕様
├── src/
│   ├── runners/                     # runner の TypeScript 正本
│   └── core/                        # 責務別の共有実装
├── test/                            # Vitest テスト
├── tools/
│   └── build.mjs                    # esbuild bundle
└── README.md
```

## 設計の要点

- **オーケストレーター + アダプター**: `agent-review` は中身を生成せず、コンテキストを
  組み立てて各エージェント adapter に委譲し、結果を統合する
- **Subagent の返却値**: `codex-agent` / `claude-agent` は request envelope file path を受け取り、
  対応 adapter skill の手順で runner と agent 実行境界を処理し、親 agent には完了シグナルだけを返す。
  親 `agent-review` は `complete-current-round` で session state から response envelope file path を導出する
- **責務分離**: top-level session は `agent-review` が管理し、agent 固有 state
  （Codex の `thread_id`、Claude の蓄積 context）は各 adapter が自律的に持つ
- **Claude subagent のセッション継続**: Codex は `thread_id` で resume するが、Claude は毎回
  コールドスタートのため、`claude-context.md` の Required Reading に過去 round の参照を列挙して
  継続性を表現する
- **状態の永続化先**: `${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json`
  （`${CLAUDE_PLUGIN_ROOT}` は更新時に変わる ephemeral なため使わない）

## ローカルでの動作確認

前提:

- Node.js 24+

```bash
npm install
npm run check
npm test
claude --plugin-dir /path/to/cross-agent/plugin
claude plugin validate /path/to/cross-agent/plugin
```

runner は `src/runners/*.ts` を正本とし、`npm run build` で `plugin/scripts/*.mjs` に bundle する。

```bash
node plugin/scripts/agent-review-runner.mjs start-session --data-dir /path/to/data --target-root /path/to/repo
node plugin/scripts/agent-review-runner.mjs prepare-initial --data-dir /path/to/data --review-session-id <id> --agent codex --focus-question "..." --target-files /path/to/file
node plugin/scripts/codex-adapter-runner.mjs prepare --data-dir /path/to/data --request /path/to/data/artifacts/<id>/round-1-adapter-request.json
node plugin/scripts/codex-adapter-runner.mjs complete --data-dir /path/to/data --run /path/to/round-1-codex-run.json
node plugin/scripts/agent-review-runner.mjs complete-current-round --data-dir /path/to/data --review-session-id <id>
```

Windows では adapter 境界の安定表現として forward slash を使う。例では `/path/to/...` と書いているが、
Windows の実パスは `C:/path/to/data` のように渡す。

## 配布

marketplace catalog は `.claude-plugin/marketplace.json` に置き、plugin 本体は `plugin/` にまとめている。
GitHub から追加する場合は次を使う。

```text
/plugin marketplace add akitanabe/cross-agent
/plugin install cross-agent@cross-agent-marketplace
```
