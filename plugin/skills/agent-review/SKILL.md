---
name: agent-review
description: 外部エージェント（Codex、Claude など）を選んでセカンドオピニオン・批判的レビューを依頼するスキル。プランや設計案のレビュー、コードの問題点洗い出し、判断の妥当性確認など、独立した視点が欲しいときに使用する。
allowed-tools: Bash(node "**/agent-review-runner.mjs"**) Glob Write
---

# agent-review

agent-review は外部 adapter へレビュー round を委譲する orchestration layer である。1 round には複数 execution を含められる。`agent_id` は round 内の実行識別子、`adapter` は駆動 adapter 名である。

## 基本手順

1. session を作る。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" start-session \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --target-root "<target-root>" \
  --review-session-id "<id>"
```

2. 初回 round を prepare する。

単一 agent:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" prepare-initial \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --review-session-id "<id>" \
  --agent-id "codex" \
  --adapter "codex"
```

複数 agent:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" prepare-initial \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --review-session-id "<id>" \
  --agents codex-a=codex codex-b=codex claude-reviewer=claude
```

どちらも省略した場合は `codex=codex` 相当になる。prepare output は常に JSON で、`requests[]` に adapter request file が入る。

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

3. `requests[]` の各 request を対応 adapter の subagent に渡す。

| adapter | subagent |
| --- | --- |
| `codex` | `codex-agent` subagent（内部で `codex-adapter` skill を使用） |
| `claude` | `claude-agent` subagent（内部で `claude-adapter` skill を使用） |

4. adapter が response envelope を書いた後、完了反映する。

pending agent が 1 件だけの round:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" complete-current-round \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --review-session-id "<id>"
```

複数 pending agent がある場合は、adapter が書いた response file を指定して逐次 complete する。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" complete-round \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --response-file "<response-envelope.json>"
```

5. output を取得する。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" get-round-output \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --review-session-id "<id>" \
  --round 1 \
  --agent-id "codex-a"
```

`--agent-id` を省略できるのは、対象 round の output file を持つ agent が一意な場合だけである。

## 追加 round

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" prepare-next-round \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --review-session-id "<id>" \
  --prompt-file "<prompt-file>" \
  --round-kind follow_up \
  --agent-id "codex-a" \
  --adapter "codex"
```

直前 round の agent state が 1 件だけなら `--agent-id/--adapter` は省略できる。直前 round に複数 agent がある場合は、`--agent-id/--adapter` または `--agents` を明示する。

`deep_dive` は対象 `agent_id` の直前 result が `completed` の場合だけ使う。`recovery` は対象 `agent_id` の直前 result が `failed` の場合だけ使う。`follow_up` で previous output が複数あり、参照元を一意に決められない場合は `--previous-agent-id` を指定する。

## 不変条件

- adapter request / response は `contract_version: 2` のみを使う。
- session state は `schema_version: 2` のみを使う。
- 旧 `agent` フィールドは使わず、`agent_id` と `adapter` を分離する。
- adapter response file 名は `round-<round>-<agent_id>-response.json`。
- 同じ adapter を同じ round で複数回使う場合も、異なる `agent_id` を指定する。

## 参考

- 仕様: https://github.com/akitanabe/cross-agent/blob/main/docs/agent-review-spec.md
- Codex adapter: https://github.com/akitanabe/cross-agent/blob/main/docs/codex-adapter-spec.md
- Claude adapter: https://github.com/akitanabe/cross-agent/blob/main/docs/claude-adapter-spec.md
