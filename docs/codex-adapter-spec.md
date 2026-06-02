# codex-adapter 詳細仕様

## 概要

codex-adapter は Codex CLI 実行境界を担当する。agent-review から v2 request envelope file path を受け取り、Codex 専用の実行 spec を作成し、codex-agent が `codex exec` / `codex exec resume` を Bash から直接実行する。実行後、codex-adapter は Codex 固有 state を更新して v2 response envelope を保存する。

runner は Codex CLI を `spawn` しない。runner の責務は request / state / artifact の検証、initial / resume 判定、Codex exec 専用 run spec の作成、実行結果の検証、state 更新、response envelope 作成に限定する。Codex CLI の実行は codex-agent の Bash 実行に限定し、任意 command / 任意 argv の実行権は渡さない。

agent-review は Codex の agent state file の中身を直接変更しない。`review_session_id` と `agent_id` から Codex の `thread_id` へのマッピング、resume の成否判定、Codex CLI の event log 保存、Codex 由来の artifacts/errors はこの adapter に閉じる。

`agent_id` は execution identity であり、state file、run spec、artifact path、response path に使う。`adapter: "codex"` は Codex adapter を駆動するための adapter 名であり、同じ round で複数の Codex execution を動かす場合も identity には使わない。

## 入力

agent-review から request envelope file path を受け取る。runner の `prepare` command は `--data-dir` と `--request` で指定された JSON file を読む。

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

### 入力検証

- `--data-dir` が指定されている
- `contract_version` は `2`
- `adapter` は `"codex"`
- `review_session_id`, `agent_id`, `round`, `round_kind`, `target_root`, `prompt_file`, `options` が存在する
- `review_session_id` と `agent_id` は path segment として安全である
- `prompt_file` は読み取り可能
- `target_root` は存在するディレクトリ
- session state file は `<data-dir>/sessions/<review_session_id>.json` から導出し、`schema_version` が `2`、`review_session_id` が envelope の値と一致する
- Codex agent state file は存在しなくてもよい。存在する場合は `review_session_id` と `agent_id` が envelope と一致する

v1 envelope、旧 `agent` field、`contract_version` が `2` ではない request は受け入れない。

`context_file` と `target_files` は補助情報であり、Codex に渡す本文は `prompt_file` を正とする。それらのパス参照は agent-review が `prompt_file` 内に含める。

`options.timeout_seconds` は request contract 上は存在するが、現行 codex-adapter は Codex CLI 実行の timeout 制御を実装していない。spec では実装済みの timeout として扱わない。

## review_depth の翻訳

| `options.review_depth` | Codex `model_reasoning_effort` |
|---|---|
| `low` | `medium` |
| `medium` | `high` |
| `high` | `xhigh` |

未指定または未知の値は安全側で `high` として扱い、run spec の `warning` と diagnostic artifact に警告を残す。

## Artifact パス

artifact directory は `--data-dir` と `review_session_id` から決める。

```text
<data-dir>/artifacts/<review_session_id>/
```

round と `agent_id` ごとに以下を作る。

```text
round-<N>-<agent_id>-run.json
round-<N>-<agent_id>-output.md
round-<N>-<agent_id>-events.jsonl
round-<N>-<agent_id>-exit.json
round-<N>-<agent_id>-diagnostic.md
round-<N>-<agent_id>-response.json
```

- `round-<N>-<agent_id>-run.json`: runner の `prepare` が作成する Codex exec 専用の実行 spec
- `round-<N>-<agent_id>-output.md`: Codex の最終メッセージ。response envelope の `output_file`
- `round-<N>-<agent_id>-events.jsonl`: `--json` 実行時の event stream。initial / resume のどちらでも保存する
- `round-<N>-<agent_id>-exit.json`: codex-agent が保存する Codex CLI の終了結果
- `round-<N>-<agent_id>-diagnostic.md`: CLI 終了コード、実行モード、抽出した thread_id、警告、stderr 相当の要約
- `round-<N>-<agent_id>-response.json`: adapter が返した response envelope の保存コピー

`codex-a=codex` と `codex-b=codex` のように同じ adapter を複数 agent として実行しても、state と artifacts は `agent_id` 単位で分離される。

`round-<N>-<agent_id>-run.json` は任意 command / 任意 argv ではなく、Codex exec 専用の構造化 spec とする。

初回起動:

```json
{
  "schema_version": 1,
  "kind": "codex_exec",
  "review_session_id": "session-1",
  "agent_id": "codex-a",
  "adapter": "codex",
  "round": 1,
  "mode": "initial",
  "target_root": "C:/repo",
  "thread_id": null,
  "prompt_file": "C:/data/artifacts/session-1/round-1-codex-a-prompt.md",
  "output_file": "C:/data/artifacts/session-1/round-1-codex-a-output.md",
  "event_log": "C:/data/artifacts/session-1/round-1-codex-a-events.jsonl",
  "exit_file": "C:/data/artifacts/session-1/round-1-codex-a-exit.json",
  "model_reasoning_effort": "high",
  "skip_git_repo_check": true,
  "ask_for_approval": "never",
  "decision_reason": "missing_thread_id",
  "previous_thread_id": null,
  "previous_target_root": null,
  "warning": null
}
```

resume:

```json
{
  "schema_version": 1,
  "kind": "codex_exec",
  "review_session_id": "session-1",
  "agent_id": "codex-a",
  "adapter": "codex",
  "round": 2,
  "mode": "resume",
  "target_root": "C:/repo",
  "thread_id": "thread-abc",
  "prompt_file": "C:/data/artifacts/session-1/round-2-codex-a-prompt.md",
  "output_file": "C:/data/artifacts/session-1/round-2-codex-a-output.md",
  "event_log": "C:/data/artifacts/session-1/round-2-codex-a-events.jsonl",
  "exit_file": "C:/data/artifacts/session-1/round-2-codex-a-exit.json",
  "model_reasoning_effort": "high",
  "skip_git_repo_check": true,
  "ask_for_approval": "never",
  "decision_reason": "resume",
  "previous_thread_id": "thread-abc",
  "previous_target_root": "C:/repo",
  "warning": null
}
```

`round-<N>-<agent_id>-exit.json`:

```json
{
  "code": 0
}
```

signal を厳密に表現する必要が出た場合は、Bash の終了コード規約 (`128 + signal`) を diagnostic に記録する。

## Agent state 更新範囲

codex-adapter が変更してよい state は自分で導出する Codex agent state file に限定する。パスは `<data-dir>/sessions/<review_session_id>/agents/<agent_id>.json` とする。

- `thread_id` / `target_root` / `status` / `last_*`
- `artifacts[]` への append
- `errors[]` への append
- 機械的な `updated_at`

top-level session state の `rounds[]`, `current_round`, `status`, `context`, `options` は agent-review の所有物なので、codex-adapter は変更しない。

Codex agent state file の形:

```json
{
  "schema_version": 1,
  "review_session_id": "session-1",
  "agent_id": "codex-a",
  "adapter": "codex",
  "status": "active",
  "thread_id": "thread-abc",
  "target_root": "C:/repo",
  "last_run_file": "C:/data/artifacts/session-1/round-1-codex-a-run.json",
  "last_output_file": "C:/data/artifacts/session-1/round-1-codex-a-output.md",
  "last_event_log": "C:/data/artifacts/session-1/round-1-codex-a-events.jsonl",
  "last_exit_file": "C:/data/artifacts/session-1/round-1-codex-a-exit.json",
  "last_error": null,
  "artifacts": [],
  "errors": [],
  "updated_at": "2026-06-02T00:00:00.000Z"
}
```

`prepare` 成功時は state を `prepared` に更新し、run/event/exit path を記録する。`complete` 成功時は state を `active` にし、`thread_id`、output path、artifacts を更新する。失敗時は可能な場合だけ state を `failed` にし、diagnostic artifact と recoverable error を追記する。

## 実行仕様

codex-adapter の実行は `prepare`、codex-agent による Codex CLI 実行、`complete` の 3 段階に分かれる。

1. `[runner: prepare]` request envelope file を読み取り、入力検証する
2. `[runner: prepare]` session state file を導出して読み、`schema_version: 2` と `review_session_id` 一致を確認する
3. `[runner: prepare]` Codex agent state file を `<agent_id>.json` から導出して読み、存在しなければ Codex agent state を新規作成する
4. `[runner: prepare]` artifact directory を作成する
5. `[runner: prepare]` `review_depth` を `model_reasoning_effort` に翻訳する
6. `[runner: prepare]` agent state の `thread_id` と `target_root` から initial / resume を判定する
7. `[runner: prepare]` `round-<N>-<agent_id>-run.json` を作成し、agent state を `prepared` に更新して、その file path を stdout に返す
8. `[codex-agent]` `round-<N>-<agent_id>-run.json` を読み、Codex exec 専用 spec として妥当か確認する
9. `[codex-agent]` initial の場合は `codex exec`、resume の場合は `codex exec resume` を Bash から直接実行する
10. `[codex-agent]` prompt 本文を stdin で渡し、Codex CLI の stdout/stderr を `round-<N>-<agent_id>-events.jsonl` に保存する
11. `[codex-agent]` Codex CLI の終了コードを `round-<N>-<agent_id>-exit.json` に保存する
12. `[runner: complete]` `round-<N>-<agent_id>-run.json` と `round-<N>-<agent_id>-exit.json` を読み、実行結果を検証する
13. `[runner: complete]` `round-<N>-<agent_id>-events.jsonl` と `round-<N>-<agent_id>-output.md` を確認する
14. `[runner: complete]` initial 成功時は event log から `thread_id` を抽出し、resume 成功時は run spec の `thread_id` を維持する
15. `[runner: complete]` 必要なら diagnostic artifact を作成する
16. `[runner: complete]` Codex agent state file の state と artifacts/errors を更新する
17. `[runner: complete]` response envelope を `round-<N>-<agent_id>-response.json` に保存し、その file path を stdout に返す
18. `[codex-agent]` `complete` が成功したら、完了シグナルだけを agent-review に返す

`prepare` が request / state 検証で失敗し、run spec を作れない場合は、Codex CLI を実行しない。この場合も runner は可能な範囲で diagnostic artifact と failed response envelope を作成する。ただし `prepare` の stdout に response envelope file path は返さず、runner command はエラーとして終了する。codex-agent はこのエラーを受けたら Codex CLI 実行や `complete` へ進まない。

### runner commands

prepare:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-adapter-runner.mjs" prepare \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --request "<request-envelope.json>"
```

complete:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-adapter-runner.mjs" complete \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --run "<round-N-agent-id-run.json>"
```

`prepare` は Codex CLI を起動しない。`complete` も Codex CLI を起動せず、保存済み artifact と終了結果だけを検証して response envelope を確定する。

`prepare` が request / state 検証で失敗した場合は、diagnostic artifact と failed response envelope を保存してからエラー終了する。stdout には `round-<N>-<agent_id>-response.json` の path を返さない。

`round-<N>-<agent_id>-exit.json` が存在しない、JSON として壊れている、または `code` が number でない場合は `codex_exit_missing` として失敗扱いにする。`code` が 0 以外の場合は、initial では `codex_exec_failed`、resume では `codex_resume_failed` を返す。

### codex-agent の実行

codex-agent は `round-<N>-<agent_id>-run.json` を読み、次を検証する。

- `schema_version` は `1`
- `kind` は `"codex_exec"`
- `mode` は `"initial"` または `"resume"`
- `review_session_id`, `agent_id`, `adapter`, `round`, `target_root`, `prompt_file`, `output_file`, `event_log`, `exit_file` が存在する
- `adapter` は `"codex"`
- `mode == "resume"` の場合は `thread_id` が非空
- `mode == "initial"` の場合は `thread_id` が `null`
- `model_reasoning_effort` は `medium`, `high`, `xhigh` のいずれか
- `skip_git_repo_check` は `true`
- `ask_for_approval` は `"never"`

agent は任意 command を実行せず、次の形の `codex exec` だけを Bash から直接実行する。prompt 本文は argv ではなく stdin で渡す。Codex CLI の `PROMPT` に `-` を指定し、`prompt_file` を stdin redirect する。

`--ask-for-approval` は Codex CLI の top-level option として `codex` の直後に置く。現在の `codex exec --help` / `codex exec resume --help` では `--ask-for-approval` は subcommand option として受け付けられないため、`codex exec --ask-for-approval never ...` の形にはしない。sandbox mode は環境側の既定に任せ、レビュー中に必要なローカルテスト実行などを adapter 側で不必要に制限しない。レビュー用途では Codex に承認要求を出させず、承認が必要な操作は fail-fast させる。

初回起動:

```bash
codex --ask-for-approval never exec \
  -C "<target_root>" \
  --json \
  --skip-git-repo-check \
  -c "model_reasoning_effort=<effort>" \
  -o "<output_file>" \
  - \
  < "<prompt_file>" \
  > "<event_log>" \
  2>&1
```

resume:

```bash
codex --ask-for-approval never exec resume \
  --json \
  --skip-git-repo-check \
  -c "model_reasoning_effort=<effort>" \
  -o "<output_file>" \
  "<thread_id>" \
  - \
  < "<prompt_file>" \
  > "<event_log>" \
  2>&1
```

実行後、agent は終了コードを `exit_file` に保存し、`complete` を呼ぶ。agent の最終回答は完了シグナルだけにする。Codex output の要約や説明、response envelope file path は返さない。

## initial / resume 判定

agent state の `thread_id` が無い場合、または保存済み `target_root` と envelope の `target_root` が異なる場合は initial として扱い、`target_root` を Codex session の作業 root として固定する。

Codex CLI は session 作成後の `resume` で `-C` / `--cd` / `--add-dir` を受け取れない前提のため、target_root が変わった場合は既存 `thread_id` で resume してはいけない。古い `thread_id` と古い `target_root` は run spec と diagnostic artifact に記録する。

agent state の `thread_id` があり、かつ保存済み `target_root` と envelope の `target_root` が一致する場合は、同じ Codex session に追加入力する。

resume 実行そのものに失敗した場合は `codex_resume_failed` として recoverable error を返す。このケースでは adapter は勝手に新規 session を作り直さない。

## thread_id 抽出

initial 成功時は `round-<N>-<agent_id>-events.jsonl` から `thread.started` event を探す。

```json
{"type":"thread.started","thread_id":"thread-abc"}
```

JSON parse に成功した行だけを見て、`type == "thread.started"` かつ `thread_id` が非空の最初の event を採用する。見つからない場合は `codex_thread_id_missing` として失敗扱いにする。

resume 成功時は run spec の `thread_id` を維持する。resume の event log に `thread.started` が含まれていても、adapter が勝手に mapping を差し替えない。

## Response envelope

`output_file`, `artifacts[].path`, `error.details_file` などの path フィールドは forward slash 表記 (`C:/Users/...`) で保存する。受信側 (agent-review runner) は envelope file を `JSON.parse` するため、Windows の `\` をそのまま埋めると `\U` 等で parse 失敗になる。内部 state (Codex agent state file 等) は OS ネイティブの区切りで保持してよい。

成功時:

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
      "path": "C:/data/artifacts/session-1/round-1-codex-a-run.json",
      "kind": "run_spec",
      "owner": "codex-adapter",
      "round": 1,
      "agent_id": "codex-a",
      "adapter": "codex",
      "created_at": "2026-06-02T00:00:00.000Z",
      "temporary": false
    },
    {
      "path": "C:/data/artifacts/session-1/round-1-codex-a-output.md",
      "kind": "agent_output",
      "owner": "codex-adapter",
      "round": 1,
      "agent_id": "codex-a",
      "adapter": "codex",
      "created_at": "2026-06-02T00:00:00.000Z",
      "temporary": false
    },
    {
      "path": "C:/data/artifacts/session-1/round-1-codex-a-events.jsonl",
      "kind": "event_log",
      "owner": "codex-adapter",
      "round": 1,
      "agent_id": "codex-a",
      "adapter": "codex",
      "created_at": "2026-06-02T00:00:00.000Z",
      "temporary": false
    },
    {
      "path": "C:/data/artifacts/session-1/round-1-codex-a-exit.json",
      "kind": "exit_status",
      "owner": "codex-adapter",
      "round": 1,
      "agent_id": "codex-a",
      "adapter": "codex",
      "created_at": "2026-06-02T00:00:00.000Z",
      "temporary": false
    }
  ],
  "error": null
}
```

失敗時:

```json
{
  "contract_version": 2,
  "review_session_id": "session-1",
  "agent_id": "codex-a",
  "adapter": "codex",
  "round": 2,
  "status": "failed",
  "output_file": null,
  "artifacts": [
    {
      "path": "C:/data/artifacts/session-1/round-2-codex-a-diagnostic.md",
      "kind": "diagnostic",
      "owner": "codex-adapter",
      "round": 2,
      "agent_id": "codex-a",
      "adapter": "codex",
      "created_at": "2026-06-02T00:00:00.000Z",
      "temporary": false
    }
  ],
  "error": {
    "code": "codex_resume_failed",
    "message": "codex exec resume failed.",
    "recoverable": true,
    "details_file": "C:/data/artifacts/session-1/round-2-codex-a-diagnostic.md"
  }
}
```

## エラーコード

| code | recoverable | 意味 |
|---|---:|---|
| `invalid_request_envelope` | true | 必須フィールド欠落、adapter 不一致、contract_version 不一致、unsafe な `review_session_id` / `agent_id`、`--data-dir` 未指定、または request として不正 |
| `state_file_missing` | true | 導出した session state file が存在しない |
| `state_file_invalid` | true | session / agent state JSON が壊れている、`schema_version` が `2` ではない、または `review_session_id` / `agent_id` 不一致 |
| `prompt_file_missing` | true | prompt file が読めない |
| `target_root_missing` | true | target_root が存在しない、または directory ではない |
| `codex_run_spec_invalid` | true | `round-<N>-<agent_id>-run.json` が存在しない、壊れている、または Codex exec 専用 spec として不正 |
| `codex_exit_missing` | true | `round-<N>-<agent_id>-exit.json` が存在しない、壊れている、または終了コードを読めない |
| `codex_exec_failed` | true | 新規 `codex exec` が非 0 終了 |
| `codex_thread_id_missing` | true | 初回起動 event log から thread_id を抽出できない |
| `codex_resume_failed` | true | `codex exec resume` が非 0 終了 |
| `codex_output_missing` | true | CLI は成功したが output file が作られていない |

## Permission 方針

plugin permission / skill allowed-tools は次のように絞る。

```json
{
  "allow": [
    "Bash(node \"**/codex-adapter-runner.mjs\" prepare **)",
    "Bash(node \"**/codex-adapter-runner.mjs\" complete **)",
    "Bash(codex --ask-for-approval never exec **)"
  ]
}
```

`codex --ask-for-approval never exec resume ...` が `Bash(codex --ask-for-approval never exec **)` に含まれること、stdin/stdout/stderr redirect を含む実行行が許可 matcher で許可されることは、`claude plugin validate` と実機実行で確認する。

## バージョン依存注記

この仕様は Codex CLI の現在の `codex exec` / `codex exec resume` 境界に基づく。

- `codex exec resume` には `-C/--cd` と `--add-dir` が無い前提
- `codex exec` / `codex exec resume` の `PROMPT` は `string | - (read stdin)` を受け取れる前提
- `--ask-for-approval` は top-level Codex option として `codex` の直後に指定する前提
- `--json` の先頭付近に `{"type":"thread.started","thread_id":"<id>"}` が出る前提

Codex CLI 更新後に `codex exec --help` または `codex exec resume --help` の仕様が変わった場合は、この仕様を更新する。
