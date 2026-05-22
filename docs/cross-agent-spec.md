# cross-agent 詳細仕様

## 概要

cross-agent は外部エージェントへレビューを委譲するオーケストレーターである。
ユーザー依頼を解釈し、共通コンテキスト、prompt、adapter request envelope を作成し、
選択した adapter に処理を委譲する。adapter response を受け取った後は top-level session
state の round 結果を更新し、最終的な統合表示を行う。

機械的な session 初期化、artifact 作成、初回 prompt 作成、追加 round の prompt 作成、
adapter request 作成、round 完了反映は `scripts/cross-agent-runner.mjs` で行う。

## 入力

Skill はユーザー依頼から以下を構造化する。

- `agent`: 委譲先 agent。未指定なら `codex`
- `focus_question`: ユーザーが確認したい主眼
- `target_files`: レビュー対象ファイル
- `target_root`: レビュー対象の作業 root
- `context_text`: 会話、プラン、設計案などの要約。ファイル指定だけで十分な場合は省略可
- `options.review_depth`: `low` / `medium` / `high`
- `options.max_rounds`: 既定 `2`

対象や質問が特定できない場合、adapter を呼ぶ前に通常会話で確認する。
v1 では `needs_user_input` state は使わない。

## target_root 決定

v1 では `target_root` の決定は Skill 側の責務とする。
Skill はレビューセッション全体の作業 root を adapter 呼び出し前に決め、
確定した `target_root` を runner input に含める。

runner は受け取った `target_root` が存在する directory であることだけを検証する。
エージェント固有の実行方法や制約は adapter 側で扱う。

## Runner: start-session

review session の空 state 作成と `review_session_id` 生成は runner に任せる。

```bash
node scripts/cross-agent-runner.mjs start-session <<'SESSION_START_JSON'
{
  "target_root": "...",
  "options": {
    "review_depth": "medium",
    "max_rounds": 2
  }
}
SESSION_START_JSON
```

input:

```json
{
  "data_dir": "...",
  "review_session_id": null,
  "target_root": "...",
  "options": {
    "review_depth": "medium",
    "max_rounds": 2
  }
}
```

`data_dir` を省略した場合は `CLAUDE_PLUGIN_DATA` を使う。
`review_session_id` を省略した場合は runner が UUID を生成する。

stdout には `review_session_id` だけを text で返す。

runner は `${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json` に空の session state を作る。

## Runner: prepare-initial

初回 round の artifact、prompt、adapter request 作成は runner に任せる。
対象 session は `review_session_id` から導出した既存 state file で特定する。

```bash
node scripts/cross-agent-runner.mjs prepare-initial <<'INITIAL_ROUND_JSON'
{
  "review_session_id": "...",
  "agent": "codex",
  "focus_question": "...",
  "context_text": "...",
  "target_files": []
}
INITIAL_ROUND_JSON
```

`data_dir` を省略した場合は `CLAUDE_PLUGIN_DATA` を使う。
同じ JSON は `--input <input.json>` でファイルから読ませることもできる。

output:

```json
{
  "contract_version": 1,
  "review_session_id": "...",
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

stdout には次に adapter へ渡す request envelope だけを返す。
runner は以下を作成する。

- `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/context.md`
- `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-1-prompt.md`
- `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-1-adapter-request.json`

runner は既存の `${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json` に
context、round、artifact metadata を反映する。
`context.md` は `context_text` がある場合だけ作成する。

## Runner: prepare-next-round

Round 2 以降の artifact、prompt、adapter request 作成は runner に任せる。
対象 session は `review_session_id` から導出した既存 state file で特定する。

```bash
node scripts/cross-agent-runner.mjs prepare-next-round <<'NEXT_ROUND_JSON'
{
  "review_session_id": "...",
  "agent": "codex",
  "round_kind": "deep_dive",
  "prompt_text": "Round 1 の重要指摘を批判的に検証してください。"
}
NEXT_ROUND_JSON
```

input:

```json
{
  "data_dir": "...",
  "review_session_id": "...",
  "agent": "codex",
  "previous_round": 1,
  "round_kind": "deep_dive",
  "focus_question": null,
  "target_files": null,
  "prompt_text": "..."
}
```

`data_dir` を省略した場合は `CLAUDE_PLUGIN_DATA` を使う。
`agent` を省略した場合は直前 round と同じ agent を使う。
`previous_round` を省略した場合は最後の round を前回 round として扱う。
`round_kind` を省略した場合は `follow_up` とする。
`focus_question` と `target_files` を省略した場合は session context の値を引き継ぐ。
同じ JSON は `--input <input.json>` でファイルから読ませることもできる。

output:

```json
{
  "contract_version": 1,
  "review_session_id": "...",
  "agent": "codex",
  "round": 2,
  "round_kind": "deep_dive",
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

stdout には次に adapter へ渡す request envelope だけを返す。
runner は以下を作成する。

- `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-N-prompt.md`
- `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-N-adapter-request.json`

runner は既存の `${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json` に
round、artifact metadata を append する。`deep_dive` や `recovery` など自動処理に
属する round は `options.max_rounds` を超えて作成できない。ユーザーの追加質問である
`follow_up` は `max_rounds` の対象外とする。

## Runner: complete-round

adapter response を top-level session state の `rounds[].agent_result` に反映する処理は
runner に任せる。runner は `data_dir` または `CLAUDE_PLUGIN_DATA` と `review_session_id`
から session state file を導出する。

```bash
node scripts/cross-agent-runner.mjs complete-round <<'ADAPTER_RESPONSE_JSON'
{
  "contract_version": 1,
  "review_session_id": "...",
  "agent": "codex",
  "round": 1,
  "status": "completed",
  "output_file": "...",
  "artifacts": [],
  "error": null
}
ADAPTER_RESPONSE_JSON
```

input:

```json
{
  "contract_version": 1,
  "review_session_id": "...",
  "agent": "codex",
  "round": 1,
  "status": "completed",
  "output_file": "...",
  "artifacts": [],
  "error": null
}
```

adapter response envelope をそのまま指定する。
`data_dir` を省略した場合は `CLAUDE_PLUGIN_DATA` を使う。
同じ JSON は `--input <input.json>` でファイルから読ませることもできる。

runner は対象 round の `completed_at` と `agent_result` だけを更新する。
adapter 由来の artifacts/errors は各 adapter の agent state file に閉じるため、
top-level session state へ重複 append しない。

## Runner: get-round-output

完了済み round の agent output を読み、統合表示に必要な本文を返す処理は runner に任せる。

```bash
node scripts/cross-agent-runner.mjs get-round-output <<'ROUND_OUTPUT_REQUEST_JSON'
{
  "review_session_id": "...",
  "round": 1
}
ROUND_OUTPUT_REQUEST_JSON
```

input:

```json
{
  "review_session_id": "...",
  "round": 1
}
```

`data_dir` を省略した場合は `CLAUDE_PLUGIN_DATA` を使う。
`round` を省略した場合は、`output_file` を持つ最後の round を読む。

stdout には output 本文だけを出力する。

## State ownership

| State | 所有者 | 備考 |
|---|---|---|
| `review_session_id` | `cross-agent` | セッション開始単位 |
| `status` | `cross-agent` | 全体の進行状態 |
| `target_root` | `cross-agent` | レビュー対象 root |
| `current_round` | `cross-agent` | Round 制御 |
| `options` | `cross-agent` | `max_rounds` / `review_depth` など |
| `context` | `cross-agent` | 各 adapter へ渡す共通入力 |
| `rounds` | `cross-agent` | Round ごとの実行履歴 |
| Codex agent state file | `codex-adapter` | `thread_id` / resume / Codex artifacts/errors |
| Claude agent state file | `claude-adapter` | 蓄積 context / Claude artifacts/errors |
| top-level `artifacts` | `cross-agent` | context / prompt / adapter request |
| top-level `errors` | `cross-agent` | cross-agent 自身が検出したエラー |

cross-agent は agent 固有 state を直接変更しない。
個別 agent state file の path 導出、作成、更新、復旧判断は各 adapter に閉じる。

## 永続化場所

状態は `${CLAUDE_PLUGIN_DATA}` 配下にだけ書く。`${CLAUDE_PLUGIN_ROOT}` には書かない。

```text
${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json
${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/
```

個別 agent state directory は各 adapter が必要になった時点で導出・作成する。
cross-agent はその具体パスを request envelope や top-level state に含めない。

## Top-level state schema v1

```json
{
  "schema_version": 1,
  "review_session_id": "uuid-xxxx",
  "created_at": "...",
  "updated_at": "...",
  "status": "active",
  "target_root": "...",
  "current_round": 1,
  "options": {
    "max_rounds": 2,
    "auto_deep_dive": true,
    "review_depth": "medium",
    "keep_artifacts": false
  },
  "context": {
    "context_file": "...",
    "initial_prompt_file": "...",
    "focus_question": null,
    "target_files": [],
    "source": "conversation"
  },
  "rounds": [
    {
      "round": 1,
      "kind": "initial_review",
      "agent": "codex",
      "prompt_file": "...",
      "started_at": "...",
      "completed_at": null,
      "agent_result": null
    }
  ],
  "artifacts": {
    "files": []
  },
  "errors": []
}
```

## Adapter request envelope v1

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

`state_file` や `agent_state_file` は adapter request に含めない。
adapter は `${CLAUDE_PLUGIN_DATA}` と `review_session_id` から必要な state path を導出する。

## Adapter response envelope v1

```json
{
  "contract_version": 1,
  "review_session_id": "uuid-xxxx",
  "agent": "codex",
  "round": 1,
  "status": "completed",
  "output_file": "...",
  "artifacts": [],
  "error": null
}
```

response envelope は要約フィールドを持たない。
最終的な統合要約は cross-agent が `get-round-output` で取得した本文から作る。

## Status / kind

`session.status`:

- `active`
- `completed`
- `failed`
- `abandoned`

`round.kind`:

- `initial_review`
- `deep_dive`
- `follow_up`
- `recovery`

`agent_result.status`:

- `pending`
- `running`
- `completed`
- `failed`
- `skipped`

## Deep dive

`max_rounds <= 1` の場合は Round 2 を実行しない。

Round 1 の成功した出力本文を `get-round-output` で取得し、追加確認が必要な場合は `kind: "deep_dive"` の
Round 2 を実行する。Round 2 は原則として Round 1 と同じ agent に送る。

Round 2 を実行しない条件:

- `max_rounds <= 1`
- Round 1 の `agent_result.status` が `completed` ではない
- Round 1 の成功結果が短く、かつ明確に「問題なし」と結論している
- ユーザー質問が単純な Yes/No で、Round 1 で十分に回答された

Round 2 を実行する条件:

- 重要指摘があるが具体性に欠ける
- 指摘の根拠が弱い、または言い過ぎの可能性がある
- 代替案、テスト観点、リスク評価のいずれかが薄い
- Round 1 の結論をそのまま採用するには不安が残る

Round 2 prompt には以下を含める。

- 具体性に欠ける重要指摘の掘り下げ
- 根拠が弱い指摘や言い過ぎに見える指摘の批判的検証
- Round 1 で触れられていない重要観点の確認

Round 2 prompt の意味的な組み立ては Skill 側で行い、prompt 保存、追加 round 登録、
adapter request 作成は `prepare-next-round` で runner に任せる。

## Round 2 以降の扱い

Round 2 以降も adapter request / response envelope は Round 1 と同じ契約を使う。
cross-agent は `prepare-next-round` で追加 round を作成し、adapter response を
`complete-round` で閉じ、必要な出力本文を `get-round-output` で読む。

`round_kind` は以下の意味で使い分ける。

| kind | 意味 | `max_rounds` |
|---|---|---|
| `deep_dive` | Round 1 の指摘を深掘り・反証・見落とし確認する自動深掘り | 対象 |
| `follow_up` | 統合表示後のユーザー追加質問 | 対象外 |
| `recovery` | adapter 失敗後の復旧・再試行 | 対象 |

Round 3 以降は v1 では自動継続しない。ユーザーが追加質問をした場合は
`follow_up` として扱う。ユーザーが明示的に深掘り継続を求め、かつ `max_rounds` に
余裕がある場合だけ、追加の `deep_dive` round を作成してよい。

`follow_up` で agent が未指定の場合は直前 round と同じ agent を使う。ユーザーが
別 agent を指定した場合は、その agent を round に記録し、同じ envelope 形式で
対応 adapter に渡す。

## 終了と cleanup

ユーザーが「OK」「ありがとう」「終了」など終了を示したら、`session.status` を
`completed` にする。

- `temporary: true` の artifact は削除してよい
- `temporary: false` の artifact は残す
- `keep_artifacts: true` の場合は temporary artifact も残す

ユーザーが明示的に中断した場合は `abandoned`、復旧不能なエラーで処理を終える場合は
`failed` とする。
