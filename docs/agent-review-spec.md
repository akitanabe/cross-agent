# agent-review 詳細仕様

agent-review は外部 adapter へ review round を委譲する orchestration layer である。Issue #1 以降、1 round は複数 execution state を持てる。round は実行グループ、`agent_id` は round 内の execution identity、`adapter` は駆動 adapter 名である。

旧 v1 state / envelope の migration は行わない。session state は `schema_version: 2` のみを受け入れ、adapter envelope は `contract_version: 2` のみを受け入れる。

## CLI

### start-session

```bash
node scripts/agent-review-runner.mjs start-session \
  --data-dir "<CLAUDE_PLUGIN_DATA>" \
  --target-root "<repo>" \
  --review-session-id "<id>"
```

作成される state は `sessions/<review_session_id>.json` で、`schema_version: 2`、`rounds: []`、`current_round: 0` を持つ。

### prepare-initial

単一 agent:

```bash
node scripts/agent-review-runner.mjs prepare-initial \
  --data-dir "<CLAUDE_PLUGIN_DATA>" \
  --review-session-id "<id>" \
  --agent-id reviewer \
  --adapter codex
```

複数 agent:

```bash
node scripts/agent-review-runner.mjs prepare-initial \
  --data-dir "<CLAUDE_PLUGIN_DATA>" \
  --review-session-id "<id>" \
  --agents codex-a=codex codex-b=codex claude-reviewer=claude
```

`--agent-id` と `--adapter` は同時指定が必須で、`--agents` とは併用できない。どちらも省略した場合は `agent_id: "codex"`, `adapter: "codex"` を使う。`agent_id` は ASCII 英数字、`.`、`_`、`-` のみ許可し、`..` と `=` は拒否する。同一 round 内の `agent_id` 重複は拒否し、`adapter` 重複は許可する。

prepare output は単一 agent でも JSON の `requests[]` 形式である。

```json
{
  "review_session_id": "session-1",
  "round": 1,
  "requests": [
    {
      "agent_id": "codex-a",
      "adapter": "codex",
      "request_file": ".../round-1-codex-a-adapter-request.json"
    }
  ]
}
```

### prepare-next-round

```bash
node scripts/agent-review-runner.mjs prepare-next-round \
  --data-dir "<CLAUDE_PLUGIN_DATA>" \
  --review-session-id "<id>" \
  --prompt-file "<prompt_file>" \
  --round-kind follow_up \
  --agent-id reviewer \
  --adapter codex
```

直前 round の agent state が 1 件だけなら、agent 指定省略時にその `agent_id` と `adapter` を完了/失敗に関係なく引き継ぐ。直前 round に複数 agent state がある場合は曖昧なため、`--agent-id/--adapter` または `--agents` を必須にする。

`deep_dive` と `recovery` は対象 `agent_id` ごとに直前 round の同じ `agent_id` の result を確認する。対象が存在しない場合、または `deep_dive` で previous status が `completed` ではない場合、または `recovery` で previous status が `failed` ではない場合はエラーにする。

`follow_up` で previous output を prompt に含める場合、`--previous-agent-id` を指定できる。未指定時に previous output が複数ある場合は曖昧性エラーにする。

### complete-round

```bash
node scripts/agent-review-runner.mjs complete-round \
  --data-dir "<CLAUDE_PLUGIN_DATA>" \
  --response-file "<response-envelope.json>"
```

response の `round` と `agent_id` に一致する `rounds[].agents[]` entry だけを更新する。state の `adapter` と response の `adapter` が異なる場合は拒否する。対象 agent の `status`、`completed_at`、`agent_result` を更新し、同じ round の全 agent が non-`pending` になった時点で round の `completed_at` を設定する。

### complete-current-round

```bash
node scripts/agent-review-runner.mjs complete-current-round \
  --data-dir "<CLAUDE_PLUGIN_DATA>" \
  --review-session-id "<id>"
```

current round の pending agent が 1 件だけなら、その agent state の `response_file` を使って complete する。pending agent が 0 件または複数件なら曖昧性エラーにする。

### get-round-output

```bash
node scripts/agent-review-runner.mjs get-round-output \
  --data-dir "<CLAUDE_PLUGIN_DATA>" \
  --review-session-id "<id>" \
  --round 1 \
  --agent-id claude-reviewer
```

`--agent-id` 指定時は指定 round の指定 agent result を返す。未指定時は output file を持つ agent が一意な場合だけ返し、複数ある場合は曖昧性エラーにする。

## State Schema v2

```ts
type RoundEntry = {
  round: number;
  kind: RoundKind;
  started_at: string;
  completed_at: string | null;
  agents: RoundAgentState[];
};

type RoundAgentState = {
  agent_id: string;
  adapter: string;
  status: "pending" | AdapterResponseStatus | string;
  prompt_file: string;
  adapter_request_file: string;
  response_file: string;
  started_at: string;
  completed_at: string | null;
  agent_result: AgentResult | null;
};
```

`ArtifactRecord`、`AgentResult`、`AdapterResponseArtifact` は所有情報として `agent_id` と `adapter` を持つ。旧 `agent` フィールドは session state では使わない。

## Adapter Envelope v2

request:

```json
{
  "contract_version": 2,
  "review_session_id": "session-1",
  "agent_id": "codex-a",
  "adapter": "codex",
  "round": 1,
  "round_kind": "initial_review",
  "target_root": "C:/repo",
  "prompt_file": "C:/data/artifacts/session-1/round-1-codex-a-prompt.md",
  "context_file": null,
  "target_files": [],
  "focus_question": null,
  "options": {
    "review_depth": "medium",
    "timeout_seconds": null
  }
}
```

response:

```json
{
  "contract_version": 2,
  "review_session_id": "session-1",
  "agent_id": "codex-a",
  "adapter": "codex",
  "round": 1,
  "status": "completed",
  "output_file": "C:/data/artifacts/session-1/round-1-codex-a-output.md",
  "artifacts": [],
  "error": null
}
```

Generated agent-review artifacts:

```text
round-<round>-<agent_id>-prompt.md
round-<round>-<agent_id>-adapter-request.json
round-<round>-<agent_id>-response.json
```

All envelope paths are normalized to forward slash form.
