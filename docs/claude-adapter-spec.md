# claude-adapter 詳細仕様

## 概要

claude-adapter は Claude subagent 実行境界を担当する。agent-review から v2 request envelope file path を受け取り、Claude Code の専用 subagent (`claude-agent`) でレビュー本文を生成し、Claude 固有 state を更新して v2 response envelope を保存する。

Codex と異なり、Claude subagent は adapter 側で永続的な CLI session や thread を直接 resume しない。そのため、`review_session_id` と `agent_id` から Claude 用の蓄積 context file を導出し、現在 round の input から context file を参照させることで、過去 round の prompt/output を明示的に読ませてセッション継続を表現する。

agent-review は Claude の agent state file の中身を直接変更しない。蓄積 context、Claude 由来の artifacts/errors、出力保存、response envelope 作成はこの adapter に閉じる。

`agent_id` は execution identity であり、state file、context file、artifact path、response path に使う。`adapter: "claude"` は Claude adapter を駆動するための adapter 名であり、同じ round で複数の Claude execution を動かす場合も identity には使わない。

## 入力

agent-review から request envelope file path を受け取る。Claude agent は `claude-adapter` skill の手順に従い、runner に `--request` で指定された JSON file を渡す。

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

### 入力検証

- `contract_version` は `2`
- `adapter` は `"claude"`
- `review_session_id`, `agent_id`, `round`, `round_kind`, `target_root`, `prompt_file`, `options` が存在する
- `review_session_id` と `agent_id` は path segment として安全である
- `target_root` は存在するディレクトリ
- `prompt_file` は読み取り可能
- session state file は `${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json` から導出し、`schema_version` が `2`、`review_session_id` が envelope の値と一致する
- Claude agent state file は存在しなくてもよい。存在する場合は `review_session_id` と `agent_id` が envelope と一致する

v1 envelope、旧 `agent` field、`contract_version` が `2` ではない request は受け入れない。

`prompt_file` はその round で Claude に渡す主要入力である。`context_file` と `target_files` は補助情報であり、agent-review が作成する `prompt_file` 内に必要な参照情報として含まれている前提で扱う。

`options.timeout_seconds` は request contract 上は存在するが、現行 claude-adapter は Claude subagent 実行の timeout 制御を実装していない。spec では実装済みの timeout として扱わない。

## 実行境界

Claude subagent は Claude Code ランタイム内の機能であり、Node runner から外部 CLI として spawn しない。そのため claude-adapter は次の三段階で動く。

1. runner が request を検証し、artifact path、蓄積 context、Claude agent に読ませる実行 input を準備する
2. `claude-agent` が実行 input を読み、レビュー本文を生成して output file に保存する
3. runner が output file を検証し、agent state と response envelope を確定する

runner の `complete` は response envelope file path を stdout に返すが、これは `claude-agent` 内部の低水準出力である。`claude-agent` の最終回答は完了シグナルだけにする。レビュー本文の要約、Markdown の前置き、追加説明、response envelope file path は返さない。

## Artifact パス

artifact directory は `${CLAUDE_PLUGIN_DATA}` と `review_session_id` から決める。

```text
${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/
```

round と `agent_id` ごとに以下を作る。

```text
round-<N>-<agent_id>-input.md
round-<N>-<agent_id>-output.md
round-<N>-<agent_id>-diagnostic.md
round-<N>-<agent_id>-response.json
```

- `round-<N>-<agent_id>-input.md`: `claude-agent` が読む現在 round 用 prompt。現在 round の情報、蓄積 context file への参照、保存先 output path を含む
- `round-<N>-<agent_id>-output.md`: Claude subagent の最終メッセージ。response envelope の `output_file`
- `round-<N>-<agent_id>-diagnostic.md`: 入力検証、state 検証、出力欠落などの診断
- `round-<N>-<agent_id>-response.json`: adapter が返した response envelope の保存コピー

round をまたいで継続する蓄積 context は、agent state directory に保存する。このファイルは本文の複製ではなく、Claude subagent が読むべき実ファイルへの索引として扱う。

```text
${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>/agents/<agent_id>-context.md
```

`claude-reviewer=claude` と `claude-second=claude` のように同じ adapter を複数 agent として実行しても、state、context、artifacts は `agent_id` 単位で分離される。

## Agent state 更新範囲

claude-adapter が変更してよい state は自分で導出する Claude agent state file に限定する。パスは `${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>/agents/<agent_id>.json` とする。

- `context_file` / `target_root` / `status` / `last_*`
- `artifacts[]` への append
- `errors[]` への append
- 機械的な `updated_at`

top-level session state の `rounds[]`, `current_round`, `status`, `context`, `options` は agent-review の所有物なので、claude-adapter は変更しない。

Claude agent state file の形:

```json
{
  "schema_version": 1,
  "review_session_id": "session-1",
  "agent_id": "claude-reviewer",
  "adapter": "claude",
  "status": "active",
  "target_root": "C:/repo",
  "context_file": "C:/data/sessions/session-1/agents/claude-reviewer-context.md",
  "last_input_file": "C:/data/artifacts/session-1/round-1-claude-reviewer-input.md",
  "last_output_file": "C:/data/artifacts/session-1/round-1-claude-reviewer-output.md",
  "last_error": null,
  "artifacts": [],
  "errors": [],
  "updated_at": "2026-06-02T00:00:00.000Z"
}
```

`prepare` 成功時は state を `prepared` に更新し、input path と context path を記録する。`complete` 成功時は state を `active` にし、output path と artifacts を更新する。失敗時は可能な場合だけ state を `failed` にし、diagnostic artifact と recoverable error を追記する。

## 蓄積 context フォーマット

蓄積 context は Markdown とし、`prepare` と `complete` で session state から再生成する。Claude subagent は毎回コールドスタートであるため、`claude-agent` は現在 round の input からこの context file を読み、Required Reading に列挙された過去の prompt/output を読む。

蓄積 context には prompt/output の本文を貼り付けない。一次情報は artifact file を正とし、`<agent_id>-context.md` はそれらへの reference index として扱う。

prior round 抽出は agent-review session state の `rounds[].agents[]` を走査し、`adapter === "claude"` かつ `agent_id` が request と同じ agent だけを対象にする。別 `agent_id` の Claude execution は Required Reading に混ぜない。

```markdown
# Claude adapter context

## Session

- review_session_id: session-1
- target_root: C:/repo

## References

### Target files

- C:/repo/src/a.ts
- C:/repo/src/b.ts

## Required Reading

`claude-agent` must read all files listed here before answering. If any file cannot be read, it must not infer
the contents.

### Prior rounds

- prompt_file: C:/data/artifacts/session-1/round-1-claude-reviewer-prompt.md
- output_file: C:/data/artifacts/session-1/round-1-claude-reviewer-output.md

## Rounds

### Round 1: initial_review

- prompt_file: C:/data/artifacts/session-1/round-1-claude-reviewer-prompt.md
- output_file: C:/data/artifacts/session-1/round-1-claude-reviewer-output.md

### Round 2: deep_dive

- prompt_file: C:/data/artifacts/session-1/round-2-claude-reviewer-prompt.md
- output_file: C:/data/artifacts/session-1/round-2-claude-reviewer-output.md
- response_file: C:/data/artifacts/session-1/round-2-claude-reviewer-response.json
- diagnostic_file: C:/data/artifacts/session-1/round-2-claude-reviewer-diagnostic.md
```

現行実装では、過去 round の `prompt_file` / `output_file` だけを Required Reading に含める。現在 round は `Rounds` に `prompt_file`, `output_file`, `response_file`, `diagnostic_file` として記録するが、現在 round の `response_file` と `diagnostic_file` は回答前の Required Reading ではない。

蓄積 context は Claude 版のセッション継続手段であり、agent-review の top-level context とは別物である。agent-review が作る `context_file` は共通入力、Claude agent state の `context_file` は Claude 固有の継続履歴 index として扱う。

## 実行 input フォーマット

`round-<N>-<agent_id>-input.md` は `claude-agent` が直接読む現在 round 用のファイルである。runner はこの中に過去 round の全参照を展開しない。代わりに、Claude 固有の蓄積 context file への参照を置く。

`claude-agent` は `round-<N>-<agent_id>-input.md` を読んだ後、参照された `<agent_id>-context.md` を読み、そこに列挙された Required Reading の全ファイルを回答前に読む。

```markdown
# Claude adapter input

## Current Round

- prompt_file: C:/data/artifacts/session-1/round-2-claude-reviewer-prompt.md

## Session Context

- claude_context_file: C:/data/sessions/session-1/agents/claude-reviewer-context.md

Read this context file before answering. Then read all files listed in its Required Reading section.
If any required file cannot be read, do not infer its contents. Report failure through the adapter flow instead.

## Request

- review_session_id: session-1
- round: 2
- round_kind: deep_dive
- target_root: C:/repo
- focus_question:

## Output

Write the final review body to:

C:/data/artifacts/session-1/round-2-claude-reviewer-output.md
```

現在 round の `prompt_file` への参照は `round-<N>-<agent_id>-input.md` に直接列挙する。過去の同一 `agent_id` / Claude round の `prompt_file` / `output_file` は `<agent_id>-context.md` の Required Reading に含める。共通 `context_file` や `target_files` は agent-review が作る `prompt_file` に含まれている前提とする。

過去 output は真実ではなく検証対象の履歴として扱う。Required Reading に列挙する path は adapter 境界と同じく forward slash 表記に正規化する。

## 独立視点の扱い

Claude subagent には、親会話の結論や agent-review の統合方針を前提にしないよう明示する。実行 input では、次の優先順位を固定する。

1. 現在 round の `prompt_file`
2. `<agent_id>-context.md`
3. 過去 round の `prompt_file` / `output_file`
4. request envelope の構造化情報

親 agent の会話上の推測、未保存の判断、統合前の結論は Claude subagent へ渡さない。追加 context が必要な場合は、agent-review が `context_file` または `prompt_file` に明示的に保存してから渡す。

## 実行仕様

1. `[runner: prepare]` request envelope file を読み取り、入力検証する
2. `[runner: prepare]` session state file を導出して読み、`schema_version: 2` と `review_session_id` 一致を確認する
3. `[runner: prepare]` Claude agent state file を `<agent_id>.json` から導出して読み、存在しなければ Claude agent state を新規作成する
4. `[runner: prepare]` artifact directory と Claude agent state directory を作成する
5. `[runner: prepare]` session state の過去 round から `<agent_id>-context.md` を再生成する
6. `[runner: prepare]` 現在 round の情報と `<agent_id>-context.md` への参照から `round-<N>-<agent_id>-input.md` を作成する
7. `[runner: prepare]` `round-<N>-<agent_id>-diagnostic.md` に prepared diagnostic を書き、agent state を `prepared` に更新する
8. `[claude-agent]` `round-<N>-<agent_id>-input.md` を読み、`<agent_id>-context.md` とその Required Reading の全ファイルを読む
9. `[claude-agent]` `<agent_id>-context.md` または Required Reading に列挙されたファイルが読めなかった場合、推測で続行せず失敗扱いにする
10. `[claude-agent]` レビュー本文を生成し、`round-<N>-<agent_id>-output.md` に保存する
11. `[runner: complete]` output file path が導出済み path と一致し、存在し、空でないことを確認する
12. `[runner: complete]` session state の過去 round と今回 round から `<agent_id>-context.md` を再生成する
13. `[runner: complete]` Claude agent state file の state と artifacts/errors を更新する
14. `[runner: complete]` response envelope を `round-<N>-<agent_id>-response.json` に保存し、その file path を stdout に返す
15. `[claude-agent]` `complete` が成功したら、完了シグナルだけを agent-review に返す

`prepare` が request / state 検証で失敗し、`round-<N>-<agent_id>-input.md` を作れない場合は、Claude subagent の本文生成を続行しない。この場合も runner は可能な範囲で diagnostic artifact と failed response envelope を作成する。ただし `prepare` の stdout に response envelope file path は返さず、runner command はエラーとして終了する。`claude-agent` はこのエラーを受けたら本文生成や `complete` へ進まない。

### claude-agent の責務

`claude-agent` は request envelope file path を受け取り、`claude-adapter` skill の手順だけを実行する。`claude-agent` は次を守る。

- `round-<N>-<agent_id>-input.md` を正としてレビュー本文を生成する
- `round-<N>-<agent_id>-input.md` に記載された `<agent_id>-context.md` を回答前に読む
- `<agent_id>-context.md` の Required Reading に列挙された全ファイルを回答前に読む
- `<agent_id>-context.md` または Required Reading のいずれかを読めない場合は、内容を推測せず adapter failure として扱う
- `round-<N>-<agent_id>-output.md` に本文を保存する
- `complete` を呼び、response envelope を確定させる
- 完了シグナルだけを最終回答にする
- output 本文の要約、補足説明、response envelope file path、独自の artifact 整理を最終回答に混ぜない

### runner command 分割

Claude subagent が本文生成を担当するため、runner は少なくとも次の command を持つ。

```bash
node scripts/claude-adapter-runner.mjs prepare \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --request "<request-envelope.json>"
```

`prepare` は `round-<N>-<agent_id>-input.md` の file path と、保存すべき output file path を含む実行情報を返す。`prepare` が request / state 検証で失敗した場合は、diagnostic artifact と failed response envelope を保存してからエラー終了する。stdout には `round-<N>-<agent_id>-response.json` の path を返さない。

```bash
node scripts/claude-adapter-runner.mjs complete \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --request "<request-envelope.json>" \
  --output-file "<round-N-agent-id-output.md>"
```

`complete` は output file を検証し、state と response envelope を更新し、stdout に `round-<N>-<agent_id>-response.json` の file path だけを返す。`claude-agent` はこの stdout を内部処理の結果確認にだけ使い、agent-review への最終回答には含めない。

## Response envelope

`output_file`, `artifacts[].path`, `error.details_file` などの path フィールドは forward slash 表記 (`C:/Users/...`) で保存する。受信側 (agent-review runner) は envelope file を `JSON.parse` するため、Windows の `\` をそのまま埋めると `\U` 等で parse 失敗になる。内部 state (Claude agent state file 等) は OS ネイティブの区切りで保持してよい。

成功時:

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
      "path": "C:/data/artifacts/session-1/round-1-claude-reviewer-input.md",
      "kind": "claude_input",
      "owner": "claude-adapter",
      "round": 1,
      "agent_id": "claude-reviewer",
      "adapter": "claude",
      "created_at": "2026-06-02T00:00:00.000Z",
      "temporary": false
    },
    {
      "path": "C:/data/artifacts/session-1/round-1-claude-reviewer-output.md",
      "kind": "agent_output",
      "owner": "claude-adapter",
      "round": 1,
      "agent_id": "claude-reviewer",
      "adapter": "claude",
      "created_at": "2026-06-02T00:00:00.000Z",
      "temporary": false
    },
    {
      "path": "C:/data/artifacts/session-1/round-1-claude-reviewer-diagnostic.md",
      "kind": "diagnostic",
      "owner": "claude-adapter",
      "round": 1,
      "agent_id": "claude-reviewer",
      "adapter": "claude",
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
  "agent_id": "claude-reviewer",
  "adapter": "claude",
  "round": 2,
  "status": "failed",
  "output_file": null,
  "artifacts": [
    {
      "path": "C:/data/artifacts/session-1/round-2-claude-reviewer-diagnostic.md",
      "kind": "diagnostic",
      "owner": "claude-adapter",
      "round": 2,
      "agent_id": "claude-reviewer",
      "adapter": "claude",
      "created_at": "2026-06-02T00:00:00.000Z",
      "temporary": false
    }
  ],
  "error": {
    "code": "claude_output_missing",
    "message": "Claude output file was not created or was empty.",
    "recoverable": true,
    "details_file": "C:/data/artifacts/session-1/round-2-claude-reviewer-diagnostic.md"
  }
}
```

## エラーコード

| code | recoverable | 意味 |
|---|---:|---|
| `invalid_request_envelope` | true | 必須フィールド欠落、adapter 不一致、contract_version 不一致、unsafe な `review_session_id` / `agent_id`、prompt file 不在、または request として不正 |
| `state_file_missing` | true | 導出した session state file が存在しない |
| `state_file_invalid` | true | session / agent state JSON が壊れている、`schema_version` が `2` ではない、または `review_session_id` / `agent_id` 不一致 |
| `target_root_missing` | true | target_root が存在しない、または directory ではない |
| `claude_output_missing` | true | Claude agent が output file を作らなかった、空だった、または `--output-file` が導出済み path と一致しない |

旧 spec にあった `claude_prepare_failed`、`claude_required_reading_missing`、`claude_complete_failed` は現行 runner の explicit error code としては実装されていない。prepare / complete の失敗は、可能な限り上表の request/state/output 系 error に正規化される。

## バージョン依存注記

この仕様は Claude Code plugin の subagent 実行を前提にする。Claude subagent は Node runner から直接 spawn できる外部 CLI ではないため、本文生成は `claude-agent` の責務、state と envelope の確定は runner の責務として分離する。

Claude Code の Agent/subagent 実行モデルが変わり、runner から安定して subagent を機械起動できる API が提供された場合は、この仕様の実行境界を更新する。
