# codex-adapter 詳細仕様

codex-adapter は agent-review から受け取る v2 request envelope を Codex CLI 実行用 run spec に変換し、Codex CLI 実行後に v2 response envelope を確定する adapter である。

## Request Contract

codex-adapter は `contract_version: 2`、`adapter: "codex"`、非空の `agent_id` を必須にする。`agent_id` は execution identity であり、state file、run spec、artifact path、response path に使う。`adapter` は Codex adapter を駆動するための adapter 名であり、identity には使わない。

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

v1 envelope は受け入れない。

## Files

Codex adapter state:

```text
sessions/<review_session_id>/agents/<agent_id>.json
```

Codex artifacts:

```text
artifacts/<review_session_id>/round-<round>-<agent_id>-run.json
artifacts/<review_session_id>/round-<round>-<agent_id>-output.md
artifacts/<review_session_id>/round-<round>-<agent_id>-events.jsonl
artifacts/<review_session_id>/round-<round>-<agent_id>-exit.json
artifacts/<review_session_id>/round-<round>-<agent_id>-diagnostic.md
artifacts/<review_session_id>/round-<round>-<agent_id>-response.json
```

同じ round で `codex-a=codex` と `codex-b=codex` を実行しても、state と artifacts は `agent_id` 単位で分離される。

## Agent State

```json
{
  "schema_version": 1,
  "review_session_id": "session-1",
  "agent_id": "codex-a",
  "adapter": "codex",
  "status": "active",
  "thread_id": "thread-abc",
  "target_root": "C:/repo",
  "last_run_file": ".../round-1-codex-a-run.json",
  "last_output_file": ".../round-1-codex-a-output.md",
  "last_event_log": ".../round-1-codex-a-events.jsonl",
  "last_exit_file": ".../round-1-codex-a-exit.json",
  "last_error": null,
  "artifacts": [],
  "errors": []
}
```

Codex resume 判定はこの `agent_id` ごとの state file に保存された `thread_id` と `target_root` を使う。

## Run Spec

`prepare` は request と agent state から `codex_exec` run spec を作る。run spec は `agent_id` と `adapter: "codex"` を持ち、output/event/exit path は `agent_id` 入りの artifact path を指す。`review_depth` は Codex reasoning effort に変換する。

`complete` は run spec、exit file、event log、output file を検証し、成功時は agent state を更新して response envelope を `round-<round>-<agent_id>-response.json` に書く。失敗時も同じ response path に `status: "failed"` の envelope を書く。

## Response Contract

```json
{
  "contract_version": 2,
  "review_session_id": "session-1",
  "agent_id": "codex-a",
  "adapter": "codex",
  "round": 1,
  "status": "completed",
  "output_file": "C:/data/artifacts/session-1/round-1-codex-a-output.md",
  "artifacts": [
    {
      "path": "C:/data/artifacts/session-1/round-1-codex-a-output.md",
      "kind": "agent_output",
      "owner": "codex-adapter",
      "round": 1,
      "agent_id": "codex-a",
      "adapter": "codex"
    }
  ],
  "error": null
}
```

Envelope path fields are forward slash normalized.
