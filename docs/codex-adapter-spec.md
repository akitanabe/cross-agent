# codex-adapter 詳細仕様

## 概要

codex-adapter は Codex CLI 実行境界を担当する。cross-agent から request envelope file path を受け取り、
Codex 専用の実行 spec を作成し、codex-agent が `codex exec` / `codex exec resume` を Bash から直接実行する。
実行後、codex-adapter は Codex 固有 state を更新して response envelope を保存する。

runner は Codex CLI を `spawn` しない。runner の責務は request / state / artifact の検証、initial / resume
判定、Codex exec 専用 run spec の作成、実行結果の検証、state 更新、response envelope 作成に限定する。
Codex CLI の実行は codex-agent の Bash 実行に限定し、任意 command / 任意 argv の実行権は渡さない。

cross-agent は Codex の agent state file の中身を直接変更しない。`review_session_id` から
Codex の `thread_id` へのマッピング、resume の成否判定、Codex CLI の event log 保存、
Codex 由来の artifacts/errors はこの adapter に閉じる。

## 入力

cross-agent から request envelope file path を受け取る。runner の `prepare` command は `--data-dir` と
`--request` で指定された JSON file を読む。

```json
{
  "contract_version": 1,
  "review_session_id": "uuid-xxxx",
  "agent": "codex",
  "round": 1,
  "round_kind": "initial_review",
  "target_root": "...",
  "prompt_file": "...",
  "context_file": "...",
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
- `contract_version` は `1`
- `agent` は `"codex"`
- `review_session_id`, `round`, `round_kind`, `target_root`, `prompt_file`, `options` が存在する
- `prompt_file` は読み取り可能
- `target_root` は存在するディレクトリ
- session state file は `<data-dir>/sessions/<review_session_id>.json` から導出し、`review_session_id` が envelope の値と一致する
- Codex agent state file は存在しなくてもよい。存在する場合は `review_session_id` と `agent` が envelope と一致する

`context_file` と `target_files` は補助情報であり、Codex に渡す本文は `prompt_file` を正とする。
それらのパス参照は cross-agent が `prompt_file` 内に含める。

## review_depth の翻訳

| `options.review_depth` | Codex `model_reasoning_effort` |
|---|---|
| `low` | `medium` |
| `medium` | `high` |
| `high` | `xhigh` |

未指定または未知の値は安全側で `high` として扱い、diagnostic artifact に警告を書く。

## Artifact パス

artifact directory は `--data-dir` と `review_session_id` から決める。

```text
<data-dir>/artifacts/<review_session_id>/
```

round ごとに以下を作る。

```text
round-<N>-codex-run.json
round-<N>-codex-output.md
round-<N>-codex-events.jsonl
round-<N>-codex-exit.json
round-<N>-codex-diagnostic.md
round-<N>-codex-response.json
```

- `codex-run.json`: runner の `prepare` が作成する Codex exec 専用の実行 spec
- `codex-output.md`: Codex の最終メッセージ。response envelope の `output_file`
- `codex-events.jsonl`: `--json` 実行時の event stream。initial / resume のどちらでも保存する
- `codex-exit.json`: codex-agent が保存する Codex CLI の終了結果
- `codex-diagnostic.md`: CLI 終了コード、実行モード、抽出した thread_id、警告、stderr 相当の要約
- `codex-response.json`: adapter が返した response envelope の保存コピー

`codex-run.json` は任意 command / 任意 argv ではなく、Codex exec 専用の構造化 spec とする。

初回起動:

```json
{
  "schema_version": 1,
  "kind": "codex_exec",
  "review_session_id": "uuid-xxxx",
  "round": 1,
  "mode": "initial",
  "target_root": "C:/repo",
  "thread_id": null,
  "prompt_file": "C:/.../round-1-prompt.md",
  "output_file": "C:/.../round-1-codex-output.md",
  "event_log": "C:/.../round-1-codex-events.jsonl",
  "exit_file": "C:/.../round-1-codex-exit.json",
  "model_reasoning_effort": "high",
  "skip_git_repo_check": true
}
```

resume:

```json
{
  "schema_version": 1,
  "kind": "codex_exec",
  "review_session_id": "uuid-xxxx",
  "round": 2,
  "mode": "resume",
  "target_root": "C:/repo",
  "thread_id": "thread-abc",
  "prompt_file": "C:/.../round-2-prompt.md",
  "output_file": "C:/.../round-2-codex-output.md",
  "event_log": "C:/.../round-2-codex-events.jsonl",
  "exit_file": "C:/.../round-2-codex-exit.json",
  "model_reasoning_effort": "high",
  "skip_git_repo_check": true
}
```

`codex-exit.json`:

```json
{
  "code": 0
}
```

signal を厳密に表現する必要が出た場合は、Bash の終了コード規約 (`128 + signal`) を
diagnostic に記録する。

## Agent state 更新範囲

codex-adapter が変更してよい state は自分で導出する Codex agent state file に限定する。
パスは `<data-dir>/sessions/<review_session_id>/agents/codex.json` とする。

- `thread_id` / `target_root` / `status` / `last_*`
- `artifacts[]` への append
- `errors[]` への append
- 機械的な `updated_at`

top-level session state の `rounds[]`, `current_round`, `status`, `context`, `options` は
cross-agent の所有物なので、codex-adapter は変更しない。

Codex agent state file の形:

```json
{
  "schema_version": 1,
  "review_session_id": "...",
  "agent": "codex",
  "status": "active",
  "thread_id": "...",
  "target_root": "...",
  "last_run_file": "...",
  "last_output_file": "...",
  "last_event_log": "...",
  "last_exit_file": "...",
  "last_error": null,
  "artifacts": [],
  "errors": []
}
```

## 実行仕様

codex-adapter の実行は `prepare`、codex-agent による Codex CLI 実行、`complete` の 3 段階に分かれる。

1. `[runner: prepare]` request envelope file を読み取り、入力検証する
2. `[runner: prepare]` session state file を導出して読み、session と request の `review_session_id` 一致を確認する
3. `[runner: prepare]` Codex agent state file を導出して読み、存在しなければ Codex agent state を新規作成する
4. `[runner: prepare]` artifact directory を作成する
5. `[runner: prepare]` `review_depth` を `model_reasoning_effort` に翻訳する
6. `[runner: prepare]` agent state の `thread_id` と `target_root` から initial / resume を判定する
7. `[runner: prepare]` `round-<N>-codex-run.json` を作成し、その file path を stdout に返す
8. `[codex-agent]` `round-<N>-codex-run.json` を読み、Codex exec 専用 spec として妥当か確認する
9. `[codex-agent]` initial の場合は `codex exec`、resume の場合は `codex exec resume` を Bash から直接実行する
10. `[codex-agent]` prompt 本文を stdin で渡し、Codex CLI の stdout/stderr を `round-<N>-codex-events.jsonl` に保存する
11. `[codex-agent]` Codex CLI の終了コードを `round-<N>-codex-exit.json` に保存する
12. `[runner: complete]` `round-<N>-codex-run.json` と `round-<N>-codex-exit.json` を読み、実行結果を検証する
13. `[runner: complete]` `round-<N>-codex-events.jsonl` と `round-<N>-codex-output.md` を確認する
14. `[runner: complete]` initial 成功時は event log から `thread_id` を抽出し、resume 成功時は既存 `thread_id` を維持する
15. `[runner: complete]` 必要なら diagnostic artifact を作成する
16. `[runner: complete]` Codex agent state file の state と artifacts/errors を更新する
17. `[runner: complete]` response envelope を `round-<N>-codex-response.json` に保存し、その file path を stdout に返す
18. `[codex-agent]` `complete` が成功したら、完了シグナルだけを cross-agent に返す

`prepare` が request / state 検証で失敗し、`codex-run.json` を作れない場合は、Codex CLI を実行しない。
この場合も runner は可能な範囲で diagnostic artifact と failed response envelope を作成し、
codex-agent は完了シグナルだけを cross-agent に返す。

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
  --run "<round-N-codex-run.json>"
```

`prepare` は Codex CLI を起動しない。state file も最終結果としては更新しない。必要な場合でも、
作成途中の run spec と diagnostic artifact だけに留める。`complete` は Codex CLI を起動せず、
保存済み artifact と終了結果だけを検証して response envelope を確定する。

`codex-exit.json` が存在しない、JSON として壊れている、または `code` が number でない場合は
`codex_exit_missing` として失敗扱いにする。`code` が 0 以外の場合は、initial では
`codex_exec_failed`、resume では `codex_resume_failed` を返す。

### codex-agent の実行

codex-agent は `codex-run.json` を読み、次を検証する。

- `schema_version` は `1`
- `kind` は `"codex_exec"`
- `mode` は `"initial"` または `"resume"`
- `review_session_id`, `round`, `target_root`, `prompt_file`, `output_file`, `event_log`, `exit_file` が存在する
- `mode == "resume"` の場合は `thread_id` が非空
- `model_reasoning_effort` は `medium`, `high`, `xhigh` のいずれか
- `skip_git_repo_check` は `true`

agent は任意 command を実行せず、次の形の `codex exec` だけを Bash から直接実行する。
prompt 本文は argv ではなく stdin で渡す。Codex CLI の `PROMPT` に `-` を指定し、
`prompt_file` を stdin redirect する。

初回起動:

```bash
codex exec \
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
codex exec resume \
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

実行後、agent は終了コードを `exit_file` に保存し、`complete` を呼ぶ。agent の最終回答は
完了シグナルだけにする。Codex output の要約や説明、response envelope file path は返さない。

## initial / resume 判定

agent state の `thread_id` が無い場合、または保存済み `target_root` と envelope の
`target_root` が異なる場合は initial として扱い、`target_root` を Codex session の作業 root として固定する。

Codex CLI は session 作成後の `resume` で `-C` / `--cd` / `--add-dir` を受け取れない前提のため、
target_root が変わった場合は既存 `thread_id` で resume してはいけない。古い `thread_id` と
古い `target_root` は diagnostic artifact に記録する。

agent state の `thread_id` があり、かつ保存済み `target_root` と envelope の
`target_root` が一致する場合は、同じ Codex session に追加入力する。

resume 実行そのものに失敗した場合は `codex_resume_failed` として recoverable error を返す。
このケースでは adapter は勝手に新規 session を作り直さない。

## thread_id 抽出

initial 成功時は `round-<N>-codex-events.jsonl` から `thread.started` event を探す。

```json
{"type":"thread.started","thread_id":"<uuid>"}
```

JSON parse に成功した行だけを見て、`type == "thread.started"` かつ `thread_id` が非空の最初の
event を採用する。見つからない場合は `codex_thread_id_missing` として失敗扱いにする。

resume 成功時は既存 `thread_id` を維持する。resume の event log に `thread.started` が含まれていても、
run spec の `thread_id` と矛盾する場合は diagnostic に記録し、adapter が勝手に mapping を差し替えない。

## Response envelope

`output_file`, `artifacts[].path`, `error.details_file` などの path フィールドは
forward slash 表記 (`C:/Users/...`) で保存する。受信側 (cross-agent runner) は envelope file を
`JSON.parse` するため、Windows の `\` をそのまま埋めると `\U` 等で parse 失敗になる。
内部 state (Codex agent state file 等) は OS ネイティブの区切りで保持してよい。

成功時:

```json
{
  "contract_version": 1,
  "review_session_id": "uuid-xxxx",
  "agent": "codex",
  "round": 1,
  "status": "completed",
  "output_file": ".../round-1-codex-output.md",
  "artifacts": [],
  "error": null
}
```

失敗時:

```json
{
  "contract_version": 1,
  "review_session_id": "uuid-xxxx",
  "agent": "codex",
  "round": 2,
  "status": "failed",
  "output_file": null,
  "artifacts": [],
  "error": {
    "code": "codex_resume_failed",
    "message": "codex exec resume failed.",
    "recoverable": true,
    "details_file": ".../round-2-codex-diagnostic.md"
  }
}
```

## エラーコード

| code | recoverable | 意味 |
|---|---:|---|
| `invalid_request_envelope` | true | 必須フィールド欠落、agent 不一致、contract_version 不一致、または `--data-dir` 未指定 |
| `state_file_missing` | true | 導出した session state file が存在しない |
| `state_file_invalid` | true | session / agent state JSON が壊れている、または review_session_id 不一致 |
| `prompt_file_missing` | true | prompt file が読めない |
| `target_root_missing` | true | target_root が存在しない |
| `codex_run_spec_invalid` | true | `codex-run.json` が存在しない、壊れている、または Codex exec 専用 spec として不正 |
| `codex_exit_missing` | true | `codex-exit.json` が存在しない、壊れている、または終了コードを読めない |
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
    "Bash(codex exec **)"
  ]
}
```

`codex exec resume ...` が `Bash(codex exec **)` に含まれること、stdin/stdout/stderr redirect を含む
実行行が許可 matcher で許可されることは、実装時に `claude plugin validate` と実機実行で確認する。

## バージョン依存注記

この仕様は移植元 advice skill が確認していた `@openai/codex 0.130.0` の挙動に基づく。

- `codex exec resume` には `-C/--cd` と `--add-dir` が無い前提
- `codex exec` / `codex exec resume` の `PROMPT` は `string | - (read stdin)` を受け取れる前提
- `--json` の先頭付近に `{"type":"thread.started","thread_id":"<uuid>"}` が出る前提

Codex CLI 更新後に `codex exec --help` または `codex exec resume --help` の仕様が変わった場合は、
この仕様を更新する。
