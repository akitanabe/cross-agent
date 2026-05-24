# codex-adapter 詳細仕様

## 概要

codex-adapter は Codex CLI 実行境界を担当する。cross-agent から request envelope file path を受け取り、
`scripts/codex-adapter-runner.mjs` で `codex exec` / `codex exec resume` を実行し、Codex 固有 state を
更新して response envelope file path を返す。

cross-agent は Codex の agent state file の中身を直接変更しない。`review_session_id` から
Codex の `thread_id` へのマッピング、resume の成否判定、Codex CLI の event log 保存、
Codex 由来の artifacts/errors はこの adapter に閉じる。

## 入力

cross-agent から request envelope file path を受け取る。runner は `--request` で指定された JSON file を読む。

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

- `contract_version` は `1`
- `agent` は `"codex"`
- `review_session_id`, `round`, `round_kind`, `target_root`, `prompt_file`, `options` が存在する
- `prompt_file` は読み取り可能
- `target_root` は存在するディレクトリ
- session state file は `${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json` から導出し、`review_session_id` が envelope の値と一致する
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

artifact directory は `${CLAUDE_PLUGIN_DATA}` と `review_session_id` から決める。

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

## Agent state 更新範囲

codex-adapter が変更してよい state は自分で導出する Codex agent state file に限定する。
パスは `${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>/agents/codex.json` とする。

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
  "last_output_file": "...",
  "last_event_log": "...",
  "last_error": null,
  "artifacts": [],
  "errors": []
}
```

## 実行仕様

1. request envelope file を読み取り、入力検証する
2. session state file を導出して読み、session と request の `review_session_id` 一致を確認する
3. Codex agent state file を導出して読み、存在しなければ Codex agent state を新規作成する
4. artifact directory を作成する
5. `prompt_file` の本文を読み込む
6. `review_depth` を `model_reasoning_effort` に翻訳する
7. agent state の `thread_id` と `target_root` を見る
8. `thread_id` が無い、または保存済み `target_root` と envelope の `target_root` が異なる場合は初回起動として新規 Codex session を作る
9. `thread_id` があり、かつ `target_root` が一致する場合は resume 実行に分岐する
10. Codex CLI の終了コード、出力ファイル、event log を確認する
11. agent state file の Codex state と artifacts/errors を更新する
12. response envelope を `round-<N>-codex-response.json` に保存し、その file path を stdout に返す

### launcher

runner には platform 分岐コードを置かない。Codex CLI を直接 `spawn` できない環境
(Windows の `.cmd` shim 等) では、呼び出し側が `--launcher <shell>` を runner に渡す。

`--launcher` が指定された場合、runner は spawn を次の形に書き換える。

```bash
<launcher> -c 'exec "$@"' <launcher> codex <args...> <prompt_text>
```

`exec "$@"` は POSIX shell の規約で、`-c '...' name args...` の `name` と `args` を
positional parameter として受け取り、`exec` で当該プロセスに置き換える。これにより shell の
word splitting / 変数展開を一切経由せず、`<prompt_text>` を含む各 argv が文字列のまま codex に
届く。launcher は bash / sh / zsh など POSIX shell を想定する。

agent (codex-agent) は起動前に `uname -s` で platform を判定し、Git Bash on Windows
(`MINGW*` / `MSYS*` / `CYGWIN*`) なら `--launcher bash` を、それ以外は省略する。

### 初回起動

agent state の `thread_id` が無い場合、または保存済み `target_root` と envelope の
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

agent state の `thread_id` があり、かつ保存済み `target_root` と envelope の
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
| `invalid_request_envelope` | true | 必須フィールド欠落、agent 不一致、contract_version 不一致 |
| `state_file_missing` | true | 導出した session state file が存在しない |
| `state_file_invalid` | true | session / agent state JSON が壊れている、または review_session_id 不一致 |
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
