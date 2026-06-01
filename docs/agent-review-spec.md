# agent-review 詳細仕様

## 概要

agent-review は外部エージェントへレビューを委譲するオーケストレーターである。
ユーザー依頼を解釈し、共通コンテキスト、prompt、adapter request envelope を作成し、
選択した adapter に処理を委譲する。adapter response を受け取った後は top-level session
state の round 結果を更新し、最終的な統合表示を行う。

Issue #1 以降、1 round は複数の execution state を持てる。round は実行グループ、
`agent_id` は round 内の execution identity、`adapter` は駆動 adapter 名である。
旧 v1 state / envelope の migration は行わない。session state は `schema_version: 2` のみ、
adapter envelope は `contract_version: 2` のみを受け入れる。

機械的な session 初期化、artifact 作成、初回 prompt 作成、追加 round の prompt 作成、
adapter request 作成、round 完了反映は `scripts/agent-review-runner.mjs` で行う。

## 入力

Skill はユーザー依頼から以下を構造化する。

- `agent_id` / `adapter`: 委譲先 execution の識別子と駆動 adapter。単一なら `--agent-id` と `--adapter` を同時指定、複数なら `--agents <agent_id>=<adapter> ...`。どちらも省略時は `agent_id: "codex"`, `adapter: "codex"`
- `focus_question`: ユーザーが確認したい主眼
- `target_files`: レビュー対象ファイル
- `target_root`: レビュー対象の作業 root
- `context_text`: 会話、プラン、設計案などの要約。ファイル指定だけで十分な場合は省略可
- `options.review_depth`: `low` / `medium` / `high`
- `options.auto_deep_dive`: Round 1 後に自動深掘りを行うか。既定 `true`

対象や質問が特定できない場合、adapter を呼ぶ前に通常会話で確認する。

`agent_id` は ASCII 英数字、`.`、`_`、`-` のみ許可し、`..` と `=` は拒否する。
同一 round 内の `agent_id` 重複は拒否し、`adapter` 重複は許可する（同じ adapter を別 `agent_id` で複数並べてよい）。

## target_root 決定

`target_root` の決定は Skill 側の責務とする。
Skill はレビューセッション全体の作業 root を adapter 呼び出し前に決め、
確定した `target_root` を runner input に含める。

runner は受け取った `target_root` が存在する directory であることだけを検証する。
エージェント固有の実行方法や制約は adapter 側で扱う。

## パス正規化

Skill は `target_root` と `target_files` の各要素を CLI option として runner に渡す。
パスは値ごとに quote する。Windows の `\` は argv として受け取り、runner 側で
forward slash 表記へ正規化する。

runner が生成する `prompt_file`, `context_file`, `target_root`, `target_files` と
artifact metadata の path も、adapter request envelope や session state に記録する境界では
forward slash 表記に正規化する。ファイル操作には同じパス文字列を使えるため、Windows でも
`C:/...` の形を契約上の安定表現とする。

正規化は win32 のときだけ行い、次を吸収する。

- 区切り文字 `\` → `/`（UNC パスは先頭 sigil を含めて `//server/share` 形式へ統一）
- git-bash / MSYS の drive 表記 `/c/Users/...` → `C:/Users/...`

`review_session_id` と `agent_id` は state/artifact のパス要素になるため、ASCII 英数字 + `.` `_` `-` のみ許可し、`..` を拒否する。

## Runner: start-session

review session の空 state 作成と `review_session_id` 生成は runner に任せる。

```bash
node scripts/agent-review-runner.mjs start-session \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --target-root "<target_root>" \
  --review-depth "medium" \
  --auto-deep-dive "true"
```

CLI input:

- `--data-dir`: 必須
- `--target-root`: 必須
- `--review-session-id`: 任意。省略時は runner が UUID を生成する。明示する場合は ASCII 英数字 + `.` `_` `-` のみ、`..` 不可
- `--review-depth`: 任意。省略時は `medium`
- `--auto-deep-dive`: 任意。`true` / `false`。省略時は `true`

`--data-dir` は必須。plugin 文脈では SKILL から `${CLAUDE_PLUGIN_DATA}` をそのまま渡す
(Claude Code が skill content を読み込む時点で絶対パスに展開する)。env var は Bash 経由では
export されないため、runner にフォールバックは無い。

stdout には確定した `review_session_id` だけを text で返す。以降の runner 呼び出しにはこの
`review_session_id` を渡す。

runner は `${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json` に空の session state を作る
（`schema_version: 2`、`rounds: []`、`current_round: 0`）。

## Runner: prepare-initial

初回 round の artifact、prompt、adapter request 作成は runner に任せる。
対象 session は `review_session_id` から導出した既存 state file で特定する。

単一 agent:

```bash
node scripts/agent-review-runner.mjs prepare-initial \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --review-session-id "<review_session_id>" \
  --agent-id "codex" \
  --adapter "codex" \
  --focus-question "<focus_question>" \
  --target-files "<target_file_1>" "<target_file_2>"
```

複数 agent:

```bash
node scripts/agent-review-runner.mjs prepare-initial \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --review-session-id "<review_session_id>" \
  --agents codex-a=codex codex-b=codex claude-reviewer=claude
```

CLI input:

- `--data-dir`: 必須
- `--review-session-id`: 必須
- `--agent-id` / `--adapter`: 同時指定が必須。`--agents` とは併用不可
- `--agents <agent_id>=<adapter> ...`: 複数 agent 指定。`--agent-id`/`--adapter` とは併用不可
- `--focus-question`: 任意
- `--context-file`: 任意。明示 override
- `--target-files`: 任意

`--agent-id`/`--adapter` も `--agents` も省略した場合は `agent_id: "codex"`, `adapter: "codex"` を使う。
`${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/context.md` が存在する場合、`--context-file`
未指定でも runner が自動で本文を読み込み、session artifact の `context.md` として扱う。
`--context-file` は明示 override 用の任意 option として残す。
改行を含む本文を CLI 引数に直接渡してはならない。

prepare output は単一 agent でも JSON の `requests[]` 形式で stdout に返す。

```json
{
  "review_session_id": "session-1",
  "round": 1,
  "requests": [
    {
      "agent_id": "codex-a",
      "adapter": "codex",
      "request_file": ".../round-1-codex-a-adapter-request.json"
    }
  ]
}
```

runner は各 agent について以下を作成する。

- `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-1-<agent_id>-prompt.md`
- `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-1-<agent_id>-adapter-request.json`

`context.md` は `context_text`（または既存の context.md）がある場合だけ作成する。
runner は既存の `${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json` に
context、round、artifact metadata を反映する。

## Runner: prepare-next-round

Round 2 以降の artifact、prompt、adapter request 作成は runner に任せる。
対象 session は `review_session_id` から導出した既存 state file で特定する。

```bash
node scripts/agent-review-runner.mjs prepare-next-round \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --review-session-id "<review_session_id>" \
  --prompt-file "<prompt_file>" \
  --round-kind "deep_dive" \
  --agent-id "codex" \
  --adapter "codex"
```

CLI input:

- `--data-dir`: 必須
- `--review-session-id`: 必須
- `--prompt-file`: 必須。runner が本文を読み込む
- `--agent-id` / `--adapter` または `--agents`: 任意。下記の引き継ぎ規則を参照
- `--round-kind`: 任意。省略時は `follow_up`
- `--previous-round`: 任意。省略時は最後の round
- `--previous-agent-id`: 任意。`follow_up` で previous output を prompt に含める対象を一意化する
- `--focus-question`: 任意。省略時は session context の値
- `--target-files`: 任意。省略時は session context の値

agent 指定の引き継ぎ規則:

- 直前 round の agent state が 1 件だけなら、agent 指定省略時にその `agent_id` と `adapter` を
  完了/失敗に関係なく引き継ぐ。
- 直前 round に複数 agent state がある場合は曖昧なため、`--agent-id`/`--adapter` または `--agents`
  を必須にする。

`round_kind` ごとの前提条件（対象 `agent_id` ごとに直前 round の同じ `agent_id` の result を確認する）:

- `deep_dive`: 対象 `agent_id` の直前 result が `completed` であることを必須とする。失敗 round の
  結果を掘っても意味がないため、`recovery` を経て成功させてから深掘りする。
- `recovery`: 対象 `agent_id` の直前 result が `failed` であることを必須とする。成功 round に対する
  recovery は拒否する。
- `follow_up`: previous output を prompt に含める場合、`--previous-agent-id` で参照元を指定できる。
  未指定時に previous output が複数あると曖昧性エラーにする。

出力 / 生成物は prepare-initial と同じく JSON の `requests[]`、および各 agent について:

- `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-N-<agent_id>-prompt.md`
- `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-N-<agent_id>-adapter-request.json`

runner は既存の session state に round、artifact metadata を append する。runner は round 数による
上限を持たない。自動継続の抑制は Skill 側が `options.auto_deep_dive` とユーザー明示の有無で判断する。

## Runner: complete-round

adapter response を top-level session state の `rounds[].agents[].agent_result` に反映する処理は
runner に任せる。runner は必須の `--data-dir` と response envelope 内の `review_session_id` から
session state file を導出する。

```bash
node scripts/agent-review-runner.mjs complete-round \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --response-file "<response-envelope.json>"
```

CLI input:

- `--data-dir`: 必須
- `--response-file`: 必須。adapter が保存した response envelope JSON file

runner は response envelope file を読み、`contract_version: 2`、status、round、`agent_id`、path
containment を検証してから top-level session state に反映する。response の `round` と `agent_id` に
一致する `rounds[].agents[]` entry だけを更新する。state 側の `adapter` と response の `adapter` が
異なる場合は拒否する。

対象 agent の `status`、`completed_at`、`agent_result` を更新し、同じ round の全 agent が
non-`pending` になった時点で round の `completed_at` を設定する。adapter 由来の artifacts/errors は
各 adapter の agent state file に閉じるため、top-level session state へ重複 append しない。

## Runner: complete-current-round

通常の Skill フローでは、subagent 返却値に含まれる path を再利用せず、
session state の `current_round` から adapter response envelope file を導出して round を閉じる。

```bash
node scripts/agent-review-runner.mjs complete-current-round \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --review-session-id "<review_session_id>"
```

CLI input:

- `--data-dir`: 必須
- `--review-session-id`: 必須

runner は `${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json` を読み、`current_round`
に一致する `rounds[]` entry を特定する。その round の pending agent が 1 件だけなら、その agent state の
`response_file` を使って complete する。

```text
${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-<current_round>-<agent_id>-response.json
```

pending agent が 0 件または複数件の場合は曖昧性エラーにする（複数 pending がある round は
`complete-round --response-file` で response file を指定して逐次閉じる）。
その後の schema、path containment、`review_session_id` / `round` / `agent_id` / `adapter` の一致検証、
top-level session state 更新は `complete-round` と同じ契約で行う。

この command は Agent/subagent ハーネスが返却値末尾に metadata を付加する環境で、
LLM が response file path を再タイプ・抽出する必要をなくすための高水準入口である。
`complete-round --response-file` は、明示的な response file を指定したい低水準入口として残す。

## Runner: get-round-output

完了済み round の agent output を読み、統合表示に必要な本文を返す処理は runner に任せる。

```bash
node scripts/agent-review-runner.mjs get-round-output \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --review-session-id "<review_session_id>" \
  --round "1" \
  --agent-id "codex-a"
```

CLI input:

- `--data-dir`: 必須
- `--review-session-id`: 必須
- `--round`: 任意。省略時は `output_file` を持つ最後の round
- `--agent-id`: 任意

`--agent-id` 指定時は指定 round の指定 agent result を返す。未指定時は output file を持つ agent が
一意な場合だけ返し、複数ある場合は曖昧性エラーにする。

stdout には output 本文だけを出力する。

## State ownership

| State | 所有者 | 備考 |
|---|---|---|
| `review_session_id` | `agent-review` | セッション開始単位 |
| `status` | `agent-review` | 全体の進行状態 |
| `target_root` | `agent-review` | レビュー対象 root |
| `current_round` | `agent-review` | Round 制御 |
| `options` | `agent-review` | `auto_deep_dive` / `review_depth` など |
| `context` | `agent-review` | 各 adapter へ渡す共通入力 |
| `rounds` | `agent-review` | Round ごとの実行履歴。`rounds[].agents[]` に execution ごとの state |
| Codex agent state file | `codex-adapter` | `thread_id` / resume / Codex artifacts/errors |
| Claude agent state file | `claude-adapter` | 蓄積 context / Claude artifacts/errors |
| top-level `artifacts` | `agent-review` | context / prompt / adapter request |
| top-level `errors` | `agent-review` | agent-review 自身が検出したエラー |

agent-review は agent 固有 state を直接変更しない。
個別 agent state file の path 導出、作成、更新、復旧判断は各 adapter に閉じる。
`ArtifactRecord`、`AgentResult`、`AdapterResponseArtifact` は所有情報として `agent_id` と `adapter` を持つ。
旧 `agent` フィールドは session state では使わない。

## 永続化場所

状態は `${CLAUDE_PLUGIN_DATA}` 配下にだけ書く。`${CLAUDE_PLUGIN_ROOT}` には書かない。

```text
${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json
${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/
```

個別 agent state directory は各 adapter が必要になった時点で導出・作成する。
agent-review はその具体パスを request envelope や top-level state に含めない。

## Top-level state schema v2

```json
{
  "schema_version": 2,
  "review_session_id": "session-1",
  "created_at": "...",
  "updated_at": "...",
  "status": "active",
  "target_root": "...",
  "current_round": 1,
  "options": {
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
      "started_at": "...",
      "completed_at": null,
      "agents": [
        {
          "agent_id": "codex-a",
          "adapter": "codex",
          "status": "pending",
          "prompt_file": "...",
          "adapter_request_file": "...",
          "response_file": "...",
          "started_at": "...",
          "completed_at": null,
          "agent_result": null
        }
      ]
    }
  ],
  "artifacts": {
    "files": []
  },
  "errors": []
}
```

型での表現:

```ts
type RoundEntry = {
  round: number;
  kind: RoundKind;
  started_at: string;
  completed_at: string | null;
  agents: RoundAgentState[];
};

type RoundAgentState = {
  agent_id: string;
  adapter: string;
  status: "pending" | AdapterResponseStatus | string;
  prompt_file: string;
  adapter_request_file: string;
  response_file: string;
  started_at: string;
  completed_at: string | null;
  agent_result: AgentResult | null;
};
```

## Adapter request envelope v2

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

`state_file` や `agent_state_file` は adapter request に含めない。
adapter は `${CLAUDE_PLUGIN_DATA}` と `review_session_id` から必要な state path を導出する。

## Adapter response envelope v2

```json
{
  "contract_version": 2,
  "review_session_id": "session-1",
  "agent_id": "codex-a",
  "adapter": "codex",
  "round": 1,
  "status": "completed",
  "output_file": "C:/data/artifacts/session-1/round-1-codex-a-output.md",
  "artifacts": [],
  "error": null
}
```

response envelope は要約フィールドを持たない。
最終的な統合要約は agent-review が `get-round-output` で取得した本文から作る。

`output_file`, `artifacts[].path`, `error.details_file` などの path フィールドは
forward slash で返す。agent-review runner はこの envelope を `JSON.parse` するため、
Windows の `\` をエスケープせず素で入れると parse 失敗する。adapter 側で `normalizePath`
相当の正規化を行うこと。

生成される agent-review artifact のファイル名:

```text
round-<round>-<agent_id>-prompt.md
round-<round>-<agent_id>-adapter-request.json
round-<round>-<agent_id>-response.json
```

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

`agent_result.status`（adapter response の `status`）:

- `pending`（初期値。response 反映前）
- `completed`
- `failed`
- `skipped`

## Deep dive

`auto_deep_dive` が `false` の場合、Skill は自動で Round 2 を実行しない。

Round 1 の成功した出力本文を `get-round-output` で取得し、追加確認が必要な場合は `kind: "deep_dive"` の
Round 2 を実行する。Round 2 は原則として Round 1 と同じ `agent_id` に送る。

Round 2 を実行しない条件:

- `auto_deep_dive` が `false`
- Round 1 の対象 `agent_id` の `agent_result.status` が `completed` ではない
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
agent-review は `prepare-next-round` で追加 round を作成し、adapter response を
通常は `complete-current-round` で閉じ、必要な出力本文を `get-round-output` で読む。
複数 agent の round で pending が複数あるときは `complete-round --response-file` で逐次閉じる。

`round_kind` は以下の意味で使い分ける。

| kind | 意味 |
|---|---|
| `deep_dive` | Round 1 の指摘を深掘り・反証・見落とし確認する自動深掘り、またはユーザーが明示した追加深掘り |
| `follow_up` | 統合表示後のユーザー追加質問 |
| `recovery` | adapter 失敗後の復旧・再試行 |

`prepare-next-round` は `round_kind` ごとに、対象 `agent_id` ごとの直前 result を確認する。

- `deep_dive`: 対象 `agent_id` の直前 `agent_result.status === "completed"` を必須とする。失敗 round
  の結果を掘っても意味がないため、`recovery` を経て成功させてから深掘りする。
- `recovery`: 対象 `agent_id` の直前 `agent_result.status === "failed"` を必須とする。成功 round に
  対する recovery は拒否する。
- `follow_up`: 直前 result の status は `completed` を推奨するが、失敗後のユーザー質問もあり得るため
  緩める。本文参照ができない場合があることに注意する。previous output が複数あり参照元を一意に決め
  られない場合は `--previous-agent-id` を指定する。

Round 3 以降は自動継続しない。ユーザーが追加質問をした場合は `follow_up` として扱う。
ユーザーが明示的に深掘り継続を求めた場合だけ、追加の `deep_dive` round を作成してよい。

`follow_up` で agent が未指定かつ直前 round の agent state が 1 件だけの場合は、その `agent_id` /
`adapter` を引き継ぐ。直前 round に複数 agent がある場合や別 agent を使う場合は、`--agent-id`/
`--adapter` または `--agents` を明示する。

## 終了と cleanup

ユーザーが「OK」「ありがとう」「終了」など終了を示したら、`session.status` を
`completed` にする。

- `temporary: true` の artifact は削除してよい
- `temporary: false` の artifact は残す
- `keep_artifacts: true` の場合は temporary artifact も残す

ユーザーが明示的に中断した場合は `abandoned`、復旧不能なエラーで処理を終える場合は
`failed` とする。
