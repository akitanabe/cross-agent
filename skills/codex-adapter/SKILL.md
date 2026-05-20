---
name: codex-adapter
description: cross-agent から委譲される Codex CLI（codex exec）固有のアダプター。review_session_id を Codex の thread_id にマッピングしてセッションを継続し、レビューを実行する。通常はユーザーが直接呼ばず、cross-agent オーケストレーターから呼び出される。
user-invocable: false
---

## 概要

codex-adapter は **Codex CLI 実行境界** を担当する。cross-agent から request envelope を受け取り、
`codex exec` / `codex exec resume` を実行し、Codex 固有 state を更新して response envelope を返す。

cross-agent は `agents.codex.thread_id` の中身を直接変更しない。`review_session_id` から
Codex の `thread_id` へのマッピング、resume の成否判定、Codex CLI の event log 保存は
この adapter に閉じる。

## 責務

- `review_session_id` -> `thread_id` のマッピングを `${CLAUDE_PLUGIN_DATA}` 配下の state JSON に保存する
- `review_session_id` で state を読み、`agents.codex.thread_id` が無い、または
  `agents.codex.target_root` と envelope の `target_root` が異なる場合は初回起動として
  `codex exec -C <target_root> --json` で新規 Codex session を作成する
- 初回起動時の JSONL event stream から `thread.started.thread_id` を構造化抽出する
- `agents.codex.thread_id` があり、かつ `target_root` が一致する場合は round 番号に関係なく
  `codex exec resume <thread_id>` を使う
- `options.review_depth` を Codex CLI の `model_reasoning_effort` へ翻訳する
- Codex の最終回答、event log、診断ログを artifact として保存する
- 成功・失敗のどちらでも response envelope を返す

## 入力

cross-agent から request envelope を受け取る。依頼本文に JSON として含まれることを想定する。

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

実行前に以下を確認する。

- `contract_version` は `1`
- `agent` は `"codex"`
- `review_session_id`, `round`, `round_kind`, `target_root`, `state_file`, `prompt_file`, `options` が存在する
- `prompt_file` は読み取り可能
- `target_root` は存在するディレクトリ
- `state_file` は存在する JSON ファイル。なければ recoverable error として失敗を返す
- `state_file` の `review_session_id` が envelope の値と一致する

`context_file` と `target_files` は補助情報であり、Codex に渡す本文は `prompt_file` を正とする。
それらのパス参照は cross-agent が `prompt_file` 内に含める。

## review_depth の翻訳

`review_depth` は cross-agent の抽象設定なので、adapter が Codex CLI 用に変換する。

| `options.review_depth` | Codex `model_reasoning_effort` |
|---|---|
| `low` | `medium` |
| `medium` | `high` |
| `high` | `xhigh` |

未指定または未知の値は安全側で `high` として扱い、`agents.codex.last_error` ではなく
diagnostic artifact に警告を書く。

## Artifact パス

artifact directory は `state_file` と同じ `review_session_id` から決める。

```text
${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/
```

codex-adapter は round ごとに以下を作る。

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
codex-adapter は変更しない。round 結果は response envelope として返し、cross-agent が
`rounds[].agent_result` に記録する。

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

### 共通手順

1. request envelope を読み取り、入力検証する
2. `state_file` を読み、`agents.codex` を取得する
3. artifact directory を作成する
4. `prompt_file` の本文を読み込む
5. `review_depth` を `model_reasoning_effort` に翻訳する
6. `review_session_id` に対応する `agents.codex.thread_id` と `agents.codex.target_root` を見る
7. `thread_id` が無い、または保存済み `target_root` と envelope の `target_root` が異なる場合は
   初回起動として新規 Codex session を作る
8. `thread_id` があり、かつ `target_root` が一致する場合は resume 実行に分岐する
9. Codex CLI の終了コード、出力ファイル、event log を確認する
10. state の `agents.codex` と artifacts/errors を更新する
11. response envelope を `round-<N>-codex-response.json` に保存し、同じ JSON を cross-agent に返す

### 初回起動: 新規 Codex session

`review_session_id` に対応する `agents.codex.thread_id` が無い場合、または保存済み
`agents.codex.target_root` と envelope の `target_root` が異なる場合は初回起動として扱い、
`target_root` を Codex session の作業 root として固定する。これは通常 Round 1 で発生するが、
recovery、state 再作成、レビュー対象 root の変更では round 番号と一致しない可能性がある。

Codex CLI は session 作成後の `resume` で `-C` / `--cd` / `--add-dir` を受け取れないため、
`target_root` の決定は cross-agent 側で完了済みでなければならない。

保存済み `target_root` と envelope の `target_root` が異なる場合、既存の `thread_id` で resume
してはいけない。Codex session の cwd が古い root に固定されているため、関連ファイル探索、
git 操作、テスト実行、書き込み可能範囲の前提がずれる。adapter は新規 session を作成し、
新しく抽出した `thread_id` と envelope の `target_root` で `agents.codex` を更新する。
古い `thread_id` と古い `target_root` は diagnostic artifact に記録する。

実行コマンドの論理形:

```bash
codex exec \
  -C "<target_root>" \
  --json \
  --skip-git-repo-check \
  -c model_reasoning_effort="<effort>" \
  -o "<artifact_dir>/round-<N>-codex-output.md" \
  "<prompt_text>"
```

実装時の注意:

- stdin は必ず閉じる。Codex は prompt を引数で受け取っても stdin が開いていると追加入力待ちになることがある
- stdout は JSONL event stream として `round-<N>-codex-events.jsonl` に保存する
- stderr も診断に残す。stdout と混ぜる場合は JSONL 解析できるよう、少なくとも raw log を保存する
- shell 文字列連結で prompt を直接展開しない。可能なら argv 配列で渡す
- heredoc を使う環境では delimiter を行頭に置き、prompt 内の `$` や backtick が展開されない形式にする

実装言語・shell は固定しない。重要なのは、prompt を安全な argv として渡し、stdout の
JSONL event stream を `round-<N>-codex-events.jsonl` に保存し、stderr 相当の情報を
diagnostic に残すこと。stdout と stderr を同じファイルに混ぜる実装では、JSONL 解析時に
JSON parse に成功した行だけを event として扱い、失敗行は diagnostic に転記する。

### thread_id 抽出

初回起動成功時は `round-<N>-codex-events.jsonl` から `thread.started` event を探す。

期待する event:

```json
{"type":"thread.started","thread_id":"<uuid>"}
```

抽出ルール:

1. event log を 1 行ずつ読む
2. JSON parse に成功した行だけを見る
3. `type == "thread.started"` かつ `thread_id` が非空の最初の event を採用する
4. 見つからない場合は `codex_thread_id_missing` として失敗扱いにする

人間向けのヘッダー、ログ文、正規表現だけに依存してはいけない。必ず JSON event の構造を優先する。

抽出した `thread_id` は `agents.codex.thread_id` に保存する。

### 既存 session: resume

`agents.codex.thread_id` があり、かつ保存済み `agents.codex.target_root` と envelope の
`target_root` が一致する場合は、同じ Codex session に追加入力する。

実行コマンドの論理形:

```bash
codex exec resume \
  --skip-git-repo-check \
  -c model_reasoning_effort="<effort>" \
  -o "<artifact_dir>/round-<N>-codex-output.md" \
  "<thread_id>" \
  "<prompt_text>"
```

resume の重要な制約:

- `resume` では `-C <target_root>` を指定しない
- `resume` では `--add-dir` を後付けしない
- 作業 root は初回起動時の `target_root` で固定されている前提で扱う
- envelope の `target_root` が保存済み `target_root` と異なる場合は resume せず新規 session を作る
- 追加 repo の git 操作、テスト、編集が必要になった場合も新規 session が必要

resume 実行そのものに失敗した場合は `codex_resume_failed` として recoverable error を返す。
このケースでは adapter は勝手に新規 session を作り直さない。新規 session 作成は cross-agent が
`round_kind: "recovery"` などで明示的に再依頼する。

target_root 変更による新規 session は resume 失敗からの自動復旧ではなく、実行前の分岐である。
この場合は `target_root_changed` の警告を diagnostic artifact に残し、通常の初回起動として扱う。

## 成功時 response envelope

```json
{
  "contract_version": 1,
  "review_session_id": "uuid-xxxx",
  "agent": "codex",
  "round": 1,
  "status": "completed",
  "output_file": ".../round-1-codex-output.md",
  "artifacts": [
    {
      "path": ".../round-1-codex-output.md",
      "kind": "agent_output",
      "owner": "codex-adapter",
      "round": 1,
      "agent": "codex",
      "temporary": false
    },
    {
      "path": ".../round-1-codex-events.jsonl",
      "kind": "event_log",
      "owner": "codex-adapter",
      "round": 1,
      "agent": "codex",
      "temporary": false
    }
  ],
  "error": null
}
```

Codex 出力の統合・要約は cross-agent が `output_file` を読んで行う。

## 失敗時 response envelope

失敗時は必ず `status: "failed"` と `error` を返す。可能なら diagnostic artifact を作る。

```json
{
  "contract_version": 1,
  "review_session_id": "uuid-xxxx",
  "agent": "codex",
  "round": 2,
  "status": "failed",
  "output_file": null,
  "artifacts": [
    {
      "path": ".../round-2-codex-diagnostic.md",
      "kind": "diagnostic",
      "owner": "codex-adapter",
      "round": 2,
      "agent": "codex",
      "temporary": false
    }
  ],
  "error": {
    "code": "codex_resume_failed",
    "message": "codex exec resume failed.",
    "recoverable": true,
    "details_file": ".../round-2-codex-diagnostic.md"
  }
}
```

### エラーコード

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

## State 更新仕様

成功時:

```json
{
  "agents": {
    "codex": {
      "status": "active",
      "thread_id": "...",
      "target_root": "...",
      "last_output_file": ".../round-N-codex-output.md",
      "last_event_log": ".../round-N-codex-events.jsonl",
      "last_error": null
    }
  }
}
```

失敗時:

```json
{
  "agents": {
    "codex": {
      "status": "failed",
      "thread_id": "<既存値があれば保持>",
      "target_root": "<既存値または envelope.target_root>",
      "last_output_file": "<既存値があれば保持>",
      "last_event_log": ".../round-N-codex-events.jsonl",
      "last_error": {
        "code": "...",
        "message": "...",
        "recoverable": true,
        "details_file": ".../round-N-codex-diagnostic.md"
      }
    }
  }
}
```

state 書き込みは可能なら atomic に行う。一時ファイルへ JSON を書き、同じディレクトリ内で rename する。

## バージョン依存注記

この仕様は移植元 advice skill が確認していた `@openai/codex 0.130.0` の挙動に基づく。

- `codex exec resume` には `-C/--cd` と `--add-dir` が無い前提
- `--json` の先頭付近に `{"type":"thread.started","thread_id":"<uuid>"}` が出る前提

Codex CLI 更新後に `codex exec --help` または `codex exec resume --help` の仕様が変わった場合は、
この adapter の実行仕様を更新する。特に resume 側で root 変更や `--add-dir` が可能になった場合、
初回起動で root を完全固定する制約を緩和できる。
