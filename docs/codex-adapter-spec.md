# codex-adapter 詳細仕様

## 概要

codex-adapter は Codex CLI 実行境界を担当する。cross-agent から request envelope を受け取り、
`scripts/codex-adapter.mjs` で `codex exec` / `codex exec resume` を実行し、Codex 固有 state を
更新して response envelope を返す。

cross-agent は `agents.codex.thread_id` の中身を直接変更しない。`review_session_id` から
Codex の `thread_id` へのマッピング、resume の成否判定、Codex CLI の event log 保存は
この adapter に閉じる。

## 入力

cross-agent から request envelope を受け取る。

```json
{
  "contract_version": 1,
  "review_session_id": "uuid-xxxx",
  "agent": "codex",
  "round": 1,
  "round_kind": "initial_review",
  "target_root": "...",
  "state_file": "${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json",
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

- `contract_version` は `1`
- `agent` は `"codex"`
- `review_session_id`, `round`, `round_kind`, `target_root`, `state_file`, `prompt_file`, `options` が存在する
- `prompt_file` は読み取り可能
- `target_root` は存在するディレクトリ
- `state_file` は存在する JSON ファイル
- `state_file` の `review_session_id` が envelope の値と一致する

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

artifact directory は `state_file` と同じ `review_session_id` から決める。

```text
${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/
```

round ごとに以下を作る。

```text
round-<N>-codex-output.md
round-<N>-codex-events.jsonl
round-<N>-codex-diagnostic.md
round-<N>-codex-response.json
```

- `codex-output.md`: Codex の最終メッセージ。response envelope の `output_file`
- `codex-events.jsonl`: `--json` 実行時の event stream。初回起動時は必須、resume でも可能なら保存する
- `codex-diagnostic.md`: CLI 終了コード、実行コマンド要約、抽出した thread_id、警告、stderr 相当の要約
- `codex-response.json`: adapter が返した response envelope の保存コピー

## State 更新範囲

codex-adapter が変更してよい state は以下に限定する。

- `agents.codex`
- `artifacts.files[]` への append
- `errors[]` への append
- 機械的な `updated_at`

`rounds[]`, `current_round`, session root の `status`, `context`, `options` は cross-agent の所有物なので、
codex-adapter は変更しない。

`agents.codex` の形:

```json
{
  "status": "active",
  "thread_id": "...",
  "target_root": "...",
  "last_output_file": "...",
  "last_event_log": "...",
  "last_error": null
}
```

## 実行仕様

1. request envelope を読み取り、入力検証する
2. `state_file` を読み、`agents.codex` を取得する
3. artifact directory を作成する
4. `prompt_file` の本文を読み込む
5. `review_depth` を `model_reasoning_effort` に翻訳する
6. `review_session_id` に対応する `agents.codex.thread_id` と `agents.codex.target_root` を見る
7. `thread_id` が無い、または保存済み `target_root` と envelope の `target_root` が異なる場合は初回起動として新規 Codex session を作る
8. `thread_id` があり、かつ `target_root` が一致する場合は resume 実行に分岐する
9. Codex CLI の終了コード、出力ファイル、event log を確認する
10. state の `agents.codex` と artifacts/errors を更新する
11. response envelope を `round-<N>-codex-response.json` に保存し、同じ JSON を stdout に返す

### 初回起動

`agents.codex.thread_id` が無い場合、または保存済み `agents.codex.target_root` と envelope の
`target_root` が異なる場合は初回起動として扱い、`target_root` を Codex session の作業 root として固定する。

```bash
codex exec \
  -C "<target_root>" \
  --json \
  --skip-git-repo-check \
  -c model_reasoning_effort="<effort>" \
  -o "<artifact_dir>/round-<N>-codex-output.md" \
  "<prompt_text>"
```

Codex CLI は session 作成後の `resume` で `-C` / `--cd` / `--add-dir` を受け取れないため、
target_root が変わった場合は既存 `thread_id` で resume してはいけない。古い `thread_id` と
古い `target_root` は diagnostic artifact に記録する。

### thread_id 抽出

初回起動成功時は `round-<N>-codex-events.jsonl` から `thread.started` event を探す。

```json
{"type":"thread.started","thread_id":"<uuid>"}
```

JSON parse に成功した行だけを見て、`type == "thread.started"` かつ `thread_id` が非空の最初の
event を採用する。見つからない場合は `codex_thread_id_missing` として失敗扱いにする。

### 既存 session: resume

`agents.codex.thread_id` があり、かつ保存済み `agents.codex.target_root` と envelope の
`target_root` が一致する場合は、同じ Codex session に追加入力する。

```bash
codex exec resume \
  --skip-git-repo-check \
  -c model_reasoning_effort="<effort>" \
  -o "<artifact_dir>/round-<N>-codex-output.md" \
  "<thread_id>" \
  "<prompt_text>"
```

resume 実行そのものに失敗した場合は `codex_resume_failed` として recoverable error を返す。
このケースでは adapter は勝手に新規 session を作り直さない。

## Response envelope

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
| `invalid_request_envelope` | true | 必須フィールド欠落、agent 不一致、contract_version 不一致 |
| `state_file_missing` | true | 指定された state file が存在しない |
| `state_file_invalid` | true | state JSON が壊れている、または review_session_id 不一致 |
| `prompt_file_missing` | true | prompt file が読めない |
| `target_root_missing` | true | target_root が存在しない |
| `codex_exec_failed` | true | 新規 `codex exec` が非 0 終了 |
| `codex_thread_id_missing` | true | 初回起動 event log から thread_id を抽出できない |
| `codex_resume_failed` | true | `codex exec resume` が非 0 終了 |
| `codex_output_missing` | true | CLI は成功したが output file が作られていない |

## バージョン依存注記

この仕様は移植元 advice skill が確認していた `@openai/codex 0.130.0` の挙動に基づく。

- `codex exec resume` には `-C/--cd` と `--add-dir` が無い前提
- `--json` の先頭付近に `{"type":"thread.started","thread_id":"<uuid>"}` が出る前提

Codex CLI 更新後に `codex exec --help` または `codex exec resume --help` の仕様が変わった場合は、
この仕様を更新する。
