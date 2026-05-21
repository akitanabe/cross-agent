# cross-agent 詳細仕様

## 概要

cross-agent は外部エージェントへレビューを委譲するオーケストレーターである。
ユーザー依頼を解釈し、共通コンテキスト、prompt、adapter request envelope を作成し、
選択した adapter に処理を委譲する。adapter response を受け取った後は top-level session
state の round 結果を更新し、最終的な統合表示を行う。

機械的な session 初期化、artifact 作成、初回 prompt 作成、adapter request 作成、
round 完了反映は `scripts/cross-agent-runner.mjs` で行う。

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

`target_root` はレビューセッション全体の作業 root として cross-agent が決める。
エージェント固有の実行方法や制約は adapter 側で扱う。

優先順:

1. `target_files` がある場合、そのファイル群に共通する git root
2. git root が取れない場合、project marker を親方向に探索
3. marker もない場合、指定ファイルの親ディレクトリ
4. `target_files` がない場合、現在の cwd

複数候補があり自動決定できない場合はユーザーへ確認する。

## Runner: prepare-initial

初回 session の機械的な作成は runner に任せる。

```bash
node scripts/cross-agent-runner.mjs prepare-initial <<'JSON'
{
  "agent": "codex",
  "target_root": "...",
  "focus_question": "...",
  "context_text": "...",
  "target_files": [],
  "options": {
    "review_depth": "medium",
    "max_rounds": 2
  }
}
JSON
```

input:

```json
{
  "data_dir": "...",
  "review_session_id": null,
  "agent": "codex",
  "target_root": "...",
  "focus_question": "...",
  "context_text": "...",
  "target_files": [],
  "options": {
    "review_depth": "medium",
    "max_rounds": 2
  }
}
```

`data_dir` を省略した場合は `CLAUDE_PLUGIN_DATA` を使う。
`review_session_id` を省略した場合は runner が UUID を生成する。
同じ JSON は `--input <input.json>` でファイルから読ませることもできる。

output:

```json
{
  "review_session_id": "...",
  "state_file": "...",
  "artifact_dir": "...",
  "context_file": "...",
  "prompt_file": "...",
  "adapter_request_file": "...",
  "adapter_request": {}
}
```

runner は以下を作成する。

- `${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json`
- `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/context.md`
- `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-1-prompt.md`
- `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-1-adapter-request.json`

`context.md` は `context_text` がある場合だけ作成する。

## Runner: complete-round

adapter response を top-level session state の `rounds[].agent_result` に反映する処理は
runner に任せる。

```bash
node scripts/cross-agent-runner.mjs complete-round <<'JSON'
{
  "state_file": "...",
  "response": {
    "contract_version": 1,
    "review_session_id": "...",
    "agent": "codex",
    "round": 1,
    "status": "completed",
    "output_file": "...",
    "artifacts": [],
    "error": null
  }
}
JSON
```

input:

```json
{
  "state_file": "...",
  "response_file": null,
  "response": {
    "contract_version": 1,
    "review_session_id": "...",
    "agent": "codex",
    "round": 1,
    "status": "completed",
    "output_file": "...",
    "artifacts": [],
    "error": null
  }
}
```

`response` または `response_file` のどちらかを指定する。
同じ JSON は `--input <input.json>` でファイルから読ませることもできる。

runner は対象 round の `completed_at` と `agent_result` だけを更新する。
adapter 由来の artifacts/errors は各 adapter の agent state file に閉じるため、
top-level session state へ重複 append しない。

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
最終的な統合要約は cross-agent が `output_file` を読んで作る。

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

Round 1 の成功した `output_file` を読み、追加確認が必要な場合は `kind: "deep_dive"` の
Round 2 を実行する。Round 2 は原則として Round 1 と同じ agent に送る。

Round 2 prompt には以下を含める。

- 具体性に欠ける重要指摘の掘り下げ
- 根拠が弱い指摘や言い過ぎに見える指摘の批判的検証
- Round 1 で触れられていない重要観点の確認

現時点では Round 2 の prompt 作成と追加 round 登録は完全には runner 化されていない。
実装が追加されるまでは Skill 側でこの仕様に従って補助する。

## 終了と cleanup

ユーザーが「OK」「ありがとう」「終了」など終了を示したら、`session.status` を
`completed` にする。

- `temporary: true` の artifact は削除してよい
- `temporary: false` の artifact は残す
- `keep_artifacts: true` の場合は temporary artifact も残す

ユーザーが明示的に中断した場合は `abandoned`、復旧不能なエラーで処理を終える場合は
`failed` とする。
