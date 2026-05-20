# cross-agent スキル 設計骨子

## 概要

複数の外部エージェント（Codex、Claude Subagentなど）に横断的に質問・レビューを依頼するスキル。
セカンドオピニオン・批判的レビュー・設計判断の妥当性確認などに使用する。

## 設計方針

- **拡張性重視**: 新しいエージェントを追加する際は、そのエージェント用Skillを追加するだけでよい
- **責務分離**: cross-agent自体はセッションの中身を知らない。各エージェントSkillが自律的にセッション管理を持つ
- **プログラム的処理**: セッション管理（ID生成・マッピング・永続化）はコードで行い、Claudeの記憶に頼らない
- **State境界の明確化**: 初期実装はJSONファイルで状態を保存するが、将来MCP state serverへ移管できる操作モデルにする

## 命名規約

- レビューセッションのIDは `review_session_id` と呼ぶ
- JSON / state / 将来のMCP tool名は `snake_case` に統一する
- ファイル名は読みやすさを優先し、生成物は `round-1-codex-output.md` のような kebab-case を許容する

## ファイル構成（予定）

```
cross-agent/
├── SKILL.md               # メインスキル（エージェント選択・セッションID生成・深掘りループ・結果統合）
├── codex-subagent/
│   └── SKILL.md           # Codex固有の実装（thread_id管理・codex execコマンド）
└── claude-subagent/
    └── SKILL.md           # Claude Subagent固有の実装（コンテキストファイルベースのセッション管理）
```

## セッション管理の仕組み

### review_session_id

- cross-agent側が生成（UUID等）
- 各エージェントに渡すだけで、中身は管理しない
- Codexの `thread_id` や Claude Subagent の蓄積コンテキストは、各subagentが `review_session_id` に紐づけて管理する

### 永続化場所

初期実装では以下にJSONファイルとして保存する。

```text
${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json
```

`${CLAUDE_PLUGIN_ROOT}` はプラグイン更新時に変わる ephemeral な場所であり、
marketplace経由ではread-onlyになりうるため、状態保存には使わない。

### State ownership

| State | 所有者 | 備考 |
|---|---|---|
| `review_session_id` | `cross-agent` | セッション開始単位を決める |
| `schema_version` | state layer | migration対象 |
| `created_at` / `updated_at` | state layer | 保存時に機械的に管理する |
| `status` | `cross-agent` | 全体の進行状態 |
| `target_root` | `cross-agent` | レビュー対象全体のroot。必要に応じてagent側にもコピーする |
| `requested_agents` | `cross-agent` | ユーザー指定または既定選択の結果 |
| `current_round` | `cross-agent` | Round制御はorchestratorの責務 |
| `options` | `cross-agent` | `max_rounds` / `quick_mode` / `reasoning_effort` など |
| `context` | `cross-agent` | 各agentに渡す共通入力 |
| `rounds` | `cross-agent` | 複数agentの結果を束ねる履歴 |
| `agents.codex` | `codex-subagent` | `thread_id` / resume / Codex固有ログ |
| `agents.claude` | `claude-subagent` | 蓄積context / Claude呼び出し履歴 |
| `artifacts` | 共有 | 作成者がappendする。他者の項目は書き換えない |
| `errors` | 共有 | 発生元がappendする。他者の項目は書き換えない |

`cross-agent` は `agents.codex.thread_id` などのagent固有stateを直接変更しない。
agent固有stateの作成・更新・復旧判断は各subagentに閉じる。

### State schema v1

```json
{
  "schema_version": 1,
  "review_session_id": "uuid-xxxx",
  "created_at": "...",
  "updated_at": "...",
  "status": "active",
  "target_root": "...",
  "requested_agents": ["codex"],
  "current_round": 1,
  "options": {
    "max_rounds": 2,
    "auto_deep_dive": true,
    "reasoning_effort": "high",
    "quick_mode": false,
    "keep_artifacts": false
  },
  "context": {
    "context_file": "...",
    "initial_prompt_file": "...",
    "focus_question": null,
    "target_files": [],
    "source": "conversation"
  },
  "agents": {
    "codex": {
      "status": "active",
      "thread_id": "...",
      "target_root": "...",
      "last_output_file": "...",
      "last_event_log": "...",
      "last_error": null
    }
  },
  "rounds": [
    {
      "round": 1,
      "kind": "initial_review",
      "prompt_file": "...",
      "started_at": "...",
      "completed_at": "...",
      "agent_results": {
        "codex": {
          "status": "completed",
          "output_file": "...",
          "summary": null
        }
      }
    }
  ],
  "artifacts": {
    "files": []
  },
  "errors": []
}
```

### Enum v1

`session.status`:

- `active`
- `completed`
- `failed`
- `abandoned`

`needs_user_input` は v1 では入れない。ユーザー入力待ちは中断・再開ワークフロー全体の
設計に関わるため、MCP / UI / resume設計を行う段階で `pending_user_input` や
`resume_action` と一緒に再検討する。v1では通常会話でユーザーに確認し、
session.statusは `active` のまま維持する。

`round.kind`:

- `initial_review`
- `deep_dive`
- `follow_up`
- `recovery`

`agent.status` / `agent_results.<agent>.status`:

- `pending`
- `running`
- `completed`
- `failed`
- `skipped`

### 各エージェントの責務

| エージェント | セッション継続の仕組み |
|---|---|
| codex-subagent | review_session_id → thread_id のマッピングを自前管理 |
| claude-subagent | review_session_id → コンテキストファイルのマッピングを自前管理 |

### Subagentの戻り値

各subagentはagent固有stateを自分で更新したうえで、cross-agentへ以下の形で実行結果を返す。
cross-agentはこの戻り値を `rounds[].agent_results` に記録する。

```json
{
  "agent": "codex",
  "round": 1,
  "status": "completed",
  "output_file": "...",
  "summary": null,
  "error": null
}
```

## 将来のMCP state server

MCPは状態の実体ではなく、状態操作の境界として扱う。初期実装はJSONファイル直書きでも、
操作モデルは以下に移管できるように保つ。

- `create_session`
- `get_session`
- `set_context`
- `start_round`
- `update_agent_state`
- `append_agent_result`
- `append_artifact`
- `append_error`
- `complete_round`
- `complete_session`
- `cleanup_session`

## cross-agent SKILL.md の責務

1. エージェントの選択（ユーザー指定 or 既定）
2. review_session_idの生成・管理
3. コンテキスト・プロンプトの組み立て（既存adviceスキルから転用）
4. 各エージェントSkillへの委譲
5. 自動深掘りループ（既定2往復）
6. 結果の統合・提示

## 既存 advice スキルからの移行

### 捨てる部分
- session id管理（thread_id抽出、resume）※ codex-subagent側に移動
- `-C <target-root>` の複雑な解決ロジック ※ codex-subagent側に移動
- `--json` フラグ、JSONLパース ※ codex-subagent側に移動
- セッション切れ時のフォールバック ※ codex-subagent側に移動
- バージョン依存注記 ※ codex-subagent側に移動

### 転用する部分
- コンテキストのファイル書き出し（Step 2）
- プロンプトの組み立て方（Step 3）
- 自動深掘りループの考え方（Step 5）
- 結果の統合・提示フォーマット（Step 6）

## 今後の検討事項

- claude-subagentのセッション継続の具体的な実装方法
- 複数エージェントへの並列投げ（現時点は直列フロー、将来的に対応予定）
- MCP state serverの設計
- `needs_user_input` を含む中断・再開ワークフロー設計
