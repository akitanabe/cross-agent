# claude-adapter 詳細仕様

claude-adapter は agent-review から受け取る v2 request envelope から Claude subagent 用 input と蓄積 context を作り、Claude の output file を検証して v2 response envelope を確定する adapter である。

## Request Contract

claude-adapter は `contract_version: 2`、`adapter: "claude"`、非空の `agent_id` を必須にする。`agent_id` は execution identity であり、state file、context file、artifact path、response path に使う。

```json
{
  "contract_version": 2,
  "review_session_id": "session-1",
  "agent_id": "claude-reviewer",
  "adapter": "claude",
  "round": 1,
  "round_kind": "initial_review",
  "target_root": "C:/repo",
  "prompt_file": "C:/data/artifacts/session-1/round-1-claude-reviewer-prompt.md",
  "context_file": null,
  "target_files": [],
  "focus_question": null,
  "options": {
    "review_depth": "medium",
    "timeout_seconds": null
  }
}
```

v1 envelope は受け入れない。

## Files

Claude adapter state and context:

```text
sessions/<review_session_id>/agents/<agent_id>.json
sessions/<review_session_id>/agents/<agent_id>-context.md
```

Claude artifacts:

```text
artifacts/<review_session_id>/round-<round>-<agent_id>-input.md
artifacts/<review_session_id>/round-<round>-<agent_id>-output.md
artifacts/<review_session_id>/round-<round>-<agent_id>-diagnostic.md
artifacts/<review_session_id>/round-<round>-<agent_id>-response.json
```

同じ round で複数の Claude execution を起動しても、state、context、input/output/response は `agent_id` 単位で分離される。

## Agent State

```json
{
  "schema_version": 1,
  "review_session_id": "session-1",
  "agent_id": "claude-reviewer",
  "adapter": "claude",
  "status": "active",
  "target_root": "C:/repo",
  "context_file": ".../claude-reviewer-context.md",
  "last_input_file": ".../round-1-claude-reviewer-input.md",
  "last_output_file": ".../round-1-claude-reviewer-output.md",
  "last_error": null,
  "artifacts": [],
  "errors": []
}
```

## Context

`prepare` は `sessions/<review_session_id>/agents/<agent_id>-context.md` を作る。prior round 抽出は agent-review session state の `rounds[].agents[]` を走査し、`adapter === "claude"` かつ同じ `agent_id` の previous prompt/output だけを Required Reading に含める。別 `agent_id` の Claude execution は混ぜない。

`claude-agent` は input file を読み、そこから参照される context file と Required Reading の全ファイルを読んでから output file にレビュー本文を書く。runner の stdout や response path はレビュー本文に混ぜない。

## Response Contract

```json
{
  "contract_version": 2,
  "review_session_id": "session-1",
  "agent_id": "claude-reviewer",
  "adapter": "claude",
  "round": 1,
  "status": "completed",
  "output_file": "C:/data/artifacts/session-1/round-1-claude-reviewer-output.md",
  "artifacts": [
    {
      "path": "C:/data/artifacts/session-1/round-1-claude-reviewer-output.md",
      "kind": "agent_output",
      "owner": "claude-adapter",
      "round": 1,
      "agent_id": "claude-reviewer",
      "adapter": "claude"
    }
  ],
  "error": null
}
```

`complete` は output file が存在し、空でないことを検証する。成功/失敗の response envelope は必ず `round-<round>-<agent_id>-response.json` に書く。Envelope path fields are forward slash normalized.
