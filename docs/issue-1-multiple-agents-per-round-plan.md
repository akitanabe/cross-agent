# Issue #1: 1 Round 複数 Agent State 対応計画

## 概要

`agent-review` の session state を、1 round に複数 agent の実行状態を持てる構造へ変更する。

現在の実装は `rounds[]` の 1 entry が単一 agent を直接表す前提で、`agent`、`prompt_file`、`agent_result` を
`RoundEntry` が直持ちしている。Issue #1 ではこの前提を外し、round は実行単位のグループ、agent はその中の
個別 execution state として扱う。

あわせて adapter request / response envelope を v2 に上げる。v1 の `agent` は「駆動 adapter 名」と
「round 内の実行識別子」を兼ねていたため、同じ adapter を同一 round で複数起動できなかった。v2 では
`agent_id` と `adapter` を分離し、`agent_id` を execution identity、`adapter` を駆動 adapter 名として扱う。

過去の旧 state JSON との後方互換は持たない。単一 agent の実行手順は維持するが、prepare output、artifact file name、
adapter envelope は破壊的に変わるため、CLI / skill の入出力契約は更新する。

state schema は `schema_version` を bump する。旧 schema の state JSON を読んだ場合は migration せず、
未対応 schema であることが分かる明確なエラーを返す。

## 実装方針

### Envelope v2

adapter request / response envelope は `contract_version: 2` とし、`agent` フィールドを廃止する。

request envelope:

```ts
type AdapterRequestEnvelopeV2 = {
  contract_version: 2;
  review_session_id: string;
  agent_id: string;
  adapter: string;
  round: number;
  round_kind: RoundKind;
  target_root: string;
  prompt_file: string;
  context_file: string | null;
  target_files: string[];
  focus_question: string | null;
  options: {
    review_depth: ReviewDepth;
    timeout_seconds: number | null;
  };
};
```

response envelope:

```ts
type AdapterResponseEnvelopeV2 = {
  contract_version: 2;
  review_session_id: string;
  agent_id: string;
  adapter: string;
  round: number;
  status: AdapterResponseStatus;
  output_file: string | null;
  artifacts: AdapterResponseArtifact[];
  error: AdapterResponseError;
};
```

`agent_id` は round 内の execution identity で、artifact file name、state lookup、complete 対象特定に使う。
`adapter` は実行に使う adapter 名で、adapter dispatch と adapter 側 validation に使う。

`codex-adapter` は `request.adapter === "codex"` を検証し、response には同じ `agent_id` と `adapter: "codex"` を返す。
`claude-adapter` も同様に `request.adapter === "claude"` を検証する。

contract version と state schema version は別の概念として定数を分ける。adapter envelope は
`SUPPORTED_ADAPTER_CONTRACT_VERSION = 2`、agent-review session state は別の `SUPPORTED_SESSION_SCHEMA_VERSION`
で検証する。

`timeout_seconds` は v2 envelope に残すが、Issue #1 では新規に実行 timeout を実装しない。既存 adapter の扱いを維持し、
timeout 配線が必要なら別 issue で扱う。

### Adapter execution state and artifacts

同一 adapter を同一 round で複数起動できるように、adapter 側の state と artifact path にも `agent_id` を貫通させる。
adapter 名単位の単一 state file では `thread_id`、context、last output が衝突するため、adapter execution state は
`agent_id` 単位で保持する。

- codex state file: `sessions/<review_session_id>/agents/<agent_id>.json`
- claude state file: `sessions/<review_session_id>/agents/<agent_id>.json`
- claude context file: `sessions/<review_session_id>/agents/<agent_id>-context.md`
- adapter artifacts: `round-<round>-<agent_id>-...`

`round-<round>-<agent_id>-response.json` は agent-review と各 adapter の共有契約とする。agent-review は
prepare 時に `RoundAgentState.response_file` としてこの path を予測記録し、adapter は必ず同じ path に response envelope を書く。
この命名規則は `docs/agent-review-spec.md` と各 adapter spec に明記する。

`artifactPaths`、`agentStateFileFor`、run spec、completion artifact、diagnostic、response 生成の全経路は
`agent_id` を受け取る形に変更する。`agent: "codex"` / `agent: "claude"` のハードコードは state identity には使わず、
adapter 種別として `adapter` に集約する。

Codex の resume 判定は `agent_id` ごとの state file 内の `thread_id` を使う。同じ adapter を複数 `agent_id` で起動した場合、
それぞれ独立した thread を持つ。

### Current adapter state

codex-adapter の現状:

- `agentStateFileFor(dataDir, reviewSessionId)` は `sessions/<review_session_id>/agents/codex.json` 固定。
- `artifactPaths(artifactDir, round)` は `round-<round>-codex-run.json`、`round-<round>-codex-output.md`、
  `round-<round>-codex-response.json` など adapter 名固定の path を返す。
- `makeResponse` は `contract_version: 1` と `agent: "codex"` を返す。
- `validateRequest` は `contract_version === 1` と `request.agent === "codex"` を検証する。
- `readOrCreateAgentState`、`markAgentPrepared`、`markAgentCompleted` は state 内の `agent` を `"codex"` に固定する。
- run spec と fallback request も `agent: "codex"` を生成する。

このままでは `codex-a=codex` と `codex-b=codex` が同じ state file と artifact file を共有し、thread id、
run spec、output、response が上書きされる。

claude-adapter の現状:

- `agentStateFileFor(dataDir, reviewSessionId)` は `sessions/<review_session_id>/agents/claude.json` 固定。
- `agentContextFileFor(dataDir, reviewSessionId)` は `sessions/<review_session_id>/agents/claude-context.md` 固定。
- `artifactPaths(artifactDir, round)` は `round-<round>-claude-input.md`、`round-<round>-claude-output.md`、
  `round-<round>-claude-response.json` など adapter 名固定の path を返す。
- `makeResponse` は `contract_version: 1` と `agent: "claude"` を返す。
- `validateRequest` は `contract_version === 1` と `request.agent === "claude"` を検証する。
- `readOrCreateAgentState`、`markAgentPrepared`、`markAgentCompleted` は state 内の `agent` を `"claude"` に固定する。
- Claude context の prior round 抽出も旧 `round.agent === "claude"` / `round.agent_result` 前提。

このままでは `claude-a=claude` と `claude-b=claude` が state file、context file、input/output/response file を共有し、
片方の context と result がもう片方を上書きする。

### Adapter revision plan

codex-adapter の修正:

- `ArtifactPathSet` と `CodexRunSpec` に `agent_id` と `adapter` を持たせる。
- `agentStateFileFor(dataDir, reviewSessionId, agentId)` を追加し、`<agent_id>.json` に保存する。
- `artifactPaths(artifactDir, round, agentId)` に変更し、すべての generated file name を `round-<round>-<agent_id>-...` にする。
- `makeResponse` は v2 envelope を返し、`agent_id: request.agent_id` と `adapter: "codex"` を含める。
- `validateRequest` は `contract_version === 2`、`request.adapter === "codex"`、`agent_id` の存在を検証する。
- `readOrCreateAgentState` / `markAgentPrepared` / `markAgentCompleted` は `agent_id` と `adapter` を state に保存する。
- `makeRequestFromRunSpec` / fallback request は v2 request 形状を返す。
- completion artifacts と failure response も `agent_id` を引き回し、artifact metadata に `agent_id` / `adapter` を入れる。

claude-adapter の修正:

- `ArtifactPathSet` と `ClaudeAgentState` に `agent_id` と `adapter` を持たせる。
- `agentStateFileFor(dataDir, reviewSessionId, agentId)` を追加し、`<agent_id>.json` に保存する。
- `agentContextFileFor(dataDir, reviewSessionId, agentId)` を追加し、`<agent_id>-context.md` に保存する。
- `artifactPaths(artifactDir, round, agentId)` に変更し、input/output/diagnostic/response file name を `agent_id` 入りにする。
- `makeResponse` は v2 envelope を返し、`agent_id: request.agent_id` と `adapter: "claude"` を含める。
- `validateRequest` は `contract_version === 2`、`request.adapter === "claude"`、`agent_id` の存在を検証する。
- `readOrCreateAgentState` / `markAgentPrepared` / `markAgentCompleted` は `agent_id` と `adapter` を state に保存する。
- Claude context の prior round 抽出は `rounds[].agents[]` を走査し、`adapter === "claude"` かつ同じ `agent_id`
  の prior result を参照する。
- failure response と diagnostic artifact も `agent_id` を引き回す。

### State schema

`RoundEntry` は round 単位の器にし、agent ごとの状態は `agents[]` に集約する。

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

旧 `agent` フィールドは型から廃止する。`AgentResult` は `agent_id` と `adapter` を持つ形へ更新し、
`ArtifactRecord` と `AdapterResponseArtifact` の agent 所有情報も `agent_id` / `adapter` を明示する。

`prepare` 時点では agent state を `pending` として作成する。`complete` 時点では adapter response の
`status` を agent state に反映し、`completed_at` と `agent_result` を更新する。

round 全体の `completed_at` は、対象 round の全 agent が `pending` ではなくなった時点で設定する。
一部 agent だけ完了した状態では、round は未完了として扱う。

### Prepare flow

`prepareInitialRound` と `prepareNextRound` は複数 agent を受けられるようにする。

- `agents?: AgentLaunchSpec[]` を追加する。
- `AgentLaunchSpec` は `{ agent_id: string; adapter: string }` とする。
- 既存の単一指定は `agent_id?: string | null` と `adapter?: string | null` に置き換える。
- `agents` と単一指定が同時に渡された場合は入力エラーにする。
- どちらも未指定なら `[{ agent_id: "codex", adapter: "codex" }]` を既定値にする。
- `agent_id` は空文字、path separator、`..`、`=` を禁止し、artifact file name に使える安全な識別子だけ許可する。
- 同一 round 内の `agent_id` 重複はエラーにする。`adapter` の重複は許可する。

RoundEntry は「1 round = 1 entry」として作る。prepare helper は対象 round の entry が既にあれば
その `agents[]` に agent state を追加し、無ければ RoundEntry を新規作成する。`prepareInitialRound` は
既存 rounds を reset したうえで round 1 の entry を 1 件だけ作り、指定された全 agent をその `agents[]` に入れる。
`prepareNextRound` は次の round 番号の entry を 1 件だけ作り、指定された全 agent をその `agents[]` に入れる。

複数 agent の artifact path は衝突しないように `agent_id` を含める。

```text
round-<round>-<agent_id>-prompt.md
round-<round>-<agent_id>-adapter-request.json
round-<round>-<agent_id>-response.json
```

これは単一 agent フローでも適用する。現行の `round-<round>-prompt.md` /
`round-<round>-adapter-request.json` から prompt / adapter request のファイル名は変わるため、単一 agent の実行手順は保つが
artifact file name は据え置きではない。

複数 agent は、同じ round 番号を持つ複数の v2 request として表現し、それらを top-level state の
`rounds[].agents[]` で束ねる。同じ adapter を複数回起動する場合は、異なる `agent_id` と同じ `adapter` を指定する。

複数 agent の prepare は、request file / prompt file を agent ごとに書いた後、session state を最後に 1 回だけ
atomic に更新する。途中で file write が失敗した場合は state へ partial agent state を反映しない。作成済みの orphan
artifact が残る可能性は許容し、cleanup は別途扱う。

`prepareNextRound` の既定 agent は、直前 round の `agents[]` に含まれる `agent_id` 集合から導出する。直前 round の
agent state が 1 件なら、その `agent_id` と `adapter` を完了 / 失敗に関係なく引き継ぐ。直前 round に複数 agent state が
ある場合は曖昧なため、`agent_id` / `adapter` または `agents` の明示指定を要求する。
`deep_dive` と `recovery` の前提条件も、次 round で対象にする `agent_id` ごとに直前 round の同 `agent_id` state を見て判定する。
対象 `agent_id` が直前 round に存在しない場合、`deep_dive` / `recovery` はエラーにする。`follow_up` は新しい agent への
質問も許可する。

`follow_up` で新しい `agent_id` を指定する場合は、previous output 参照元を `previous_agent_id` で明示できるようにする。
未指定の場合は、直前 round の output file を持つ agent state が一意なときだけその output を prompt に含める。
複数 output がある場合は曖昧なため `previous_agent_id` を要求する。参照元 output が無い場合は previous output なしで
follow-up prompt を作る。

### Complete flow

`completeRound` は response envelope の `round` と `agent_id` に一致する `rounds[].agents[]` entry を探して更新する。
一致した state の `adapter` と response の `adapter` が異なる場合はエラーにする。

更新対象が見つからない場合は `round not found` ではなく、`agent_id` 単位で一致しなかったことが分かるエラーにする。
これにより、同一 round に `codex` と `claude` が存在する場合でも、片方だけを安全に完了できる。

`completeCurrentRound` は current round から response file path を導出する高水準入口として残す。ただし複数 agent が
pending の場合、どの response file を閉じるべきか一意に決まらないためエラーにする。pending agent が 1 件だけなら、
その agent state の response file を導出して完了処理へ進む。

session state の complete 更新は read-modify-write なので、Issue #1 では agent-review runner が complete を逐次実行する
前提にする。並行 subagent が同時に `complete-round` を呼ぶ運用はサポートしない。将来並列 complete を許可する場合は、
state file lock または optimistic concurrency を別途導入する。

### Get output flow

`getRound` / `getRoundOutput` は `agent_id?: string | null` を受けられるようにする。

- `agent_id` 指定あり: 指定 round の指定 agent state の結果を返す。
- `agent_id` 指定なし: output file を持つ agent state が一意な場合だけ返す。
- 複数 agent が output file を持つ場合は曖昧なためエラーにする。

これにより、単一 agent フローでは `--round` だけで取得でき、複数 agent フローでは `--agent-id` を指定して
明示的に取得できる。

## CLI 変更

`agent-review-runner` に `agent_id` と `adapter` を指定する CLI を追加する。

```bash
node scripts/agent-review-runner.mjs prepare-initial \
  --data-dir "<data_dir>" \
  --review-session-id "<id>" \
  --agents codex-a=codex codex-b=codex claude-reviewer=claude
```

```bash
node scripts/agent-review-runner.mjs prepare-next-round \
  --data-dir "<data_dir>" \
  --review-session-id "<id>" \
  --prompt-file "<prompt_file>" \
  --agents codex-a=codex claude-reviewer=claude
```

単一 agent フロー用には `--agent-id <id>` と `--adapter <adapter>` を使う。両方未指定なら
`agent_id: "codex"`, `adapter: "codex"` を既定値にする。片方だけ指定された場合はエラーにする。
`--agent-id` / `--adapter` と `--agents` を同時に指定した場合はエラーにする。
既存の引数 parser は `multiple: true` option を扱えるため、`--agents` は `--target-files` と同じ仕組みで実装する。
`--agents` の値は `<agent_id>=<adapter>` 形式とする。

`get-round-output` には `--agent-id` を追加する。

```bash
node scripts/agent-review-runner.mjs get-round-output \
  --data-dir "<data_dir>" \
  --review-session-id "<id>" \
  --round 1 \
  --agent-id claude-reviewer
```

prepare 系 command の戻り値は、複数 request file を表現できる JSON output に変更する。単一 agent の場合も同じ
構造で返す。

```json
{
  "review_session_id": "session-1",
  "round": 1,
  "requests": [
    {
      "agent_id": "codex-a",
      "adapter": "codex",
      "request_file": ".../round-1-codex-a-adapter-request.json"
    },
    {
      "agent_id": "claude-reviewer",
      "adapter": "claude",
      "request_file": ".../round-1-claude-reviewer-adapter-request.json"
    }
  ]
}
```

## 実装フロー

変更規模が大きいため、実装は以下の順で進める。各段階は型チェックまたは対象テストを通してから次へ進む。

### 1. 契約と型の土台を先に作る

- `shared/adapter-envelope.ts` に v2 request / response 型を定義し、`agent` を廃止して `agent_id` / `adapter` へ置き換える。
- adapter contract version と session state schema version の定数を分離する。
- `agent-review/types.ts` の state、artifact、result、prepare input/output、get input を v2 前提へ更新する。
- `agent_id` の validation helper と `AgentLaunchSpec` parser helper を追加する。
- この段階では実装が一時的に壊れてよいが、型上の最終形を先に固定する。

### 2. agent-review の state 読み書きを v2 化する

- session state 作成時の `schema_version` を新 version に上げる。
- state 読み込みを schema 検証付き helper に集約し、`readSession`、`completeRound`、`getRound` などの直読みを置き換える。
- `prepareInitialRound` / `prepareNextRound` を `RoundEntry + agents[]` 生成へ変更する。
- prepare は agent ごとの prompt / request / response path を `agent_id` 入りで作り、state は最後に 1 回だけ atomic に更新する。
- `prepareNextRound` の既定 agent、`previous_agent_id`、`deep_dive` / `recovery` の前提判定を新 schema へ移す。
- この段階で agent-review の state 遷移テストを先に更新し、adapter 実行に依存しない単体テストを通す。

### 3. agent-review の complete / get / CLI を v2 化する

- `completeRound` は response の `agent_id` と state の `agent_id` を照合し、`adapter` 不一致を拒否する。
- `completeCurrentRound` は current round の pending agent state 数で曖昧性を判定する。
- `getRound` / `getRoundOutput` は `agent_id` 指定と未指定時の曖昧性エラーを実装する。
- CLI は `--agent-id` / `--adapter` / `--agents <agent_id>=<adapter>...` / `--previous-agent-id` を追加する。
- prepare output は単一 agent でも JSON の `requests[]` 形式に統一する。
- この段階で agent-review runner テストを更新し、v2 request file の生成と complete/get の動作を確認する。

### 4. codex-adapter を `agent_id` 単位へ移行する

- request validation を v2 に更新し、`adapter === "codex"` と `agent_id` を検証する。
- `agentStateFileFor`、`artifactPaths`、run spec、fallback request、failure response、completion artifact に `agent_id` を貫通させる。
- Codex state file を `sessions/<review_session_id>/agents/<agent_id>.json` に変更し、thread resume は `agent_id` 単位にする。
- response は `contract_version: 2`、`agent_id`、`adapter: "codex"` を返し、`round-<round>-<agent_id>-response.json` へ書く。
- codex-adapter の既存テストを v2 に更新し、同一 round の `codex-a=codex` / `codex-b=codex` で artifact と state が衝突しないテストを追加する。

### 5. claude-adapter を `agent_id` 単位へ移行する

- request validation を v2 に更新し、`adapter === "claude"` と `agent_id` を検証する。
- `agentStateFileFor`、`agentContextFileFor`、`artifactPaths`、failure response、diagnostic artifact に `agent_id` を貫通させる。
- Claude state/context file を `agent_id` 単位に分ける。
- Claude context の prior round 抽出を `rounds[].agents[]` ベースへ変更し、同じ `agent_id` の prior output を参照する。
- response は `contract_version: 2`、`agent_id`、`adapter: "claude"` を返し、`round-<round>-<agent_id>-response.json` へ書く。
- claude-adapter の既存テストを v2 に更新し、同じ `agent_id` を round 1 から round 2 へ引き継ぐ context 継続テストを追加する。

### 6. 仕様書・skill・生成 runner を更新する

- `docs/agent-review-spec.md`、`docs/codex-adapter-spec.md`、`docs/claude-adapter-spec.md` を v2 envelope と `agent_id` / `adapter` 前提に更新する。
- `plugin/skills/agent-review/SKILL.md` を prepare output の `requests[]` と `--agent-id` / `--adapter` に合わせる。
- 必要に応じて adapter skill docs の v1 envelope 例も v2 へ更新する。
- `npm run build` で `plugin/scripts/*-runner.mjs` を更新する。

### 7. 全体検証と PR

- `npm run check` を実行し、型の取りこぼしを修正する。
- `npm test` を実行し、agent-review / codex-adapter / claude-adapter / runner の全テストを通す。
- `git diff` で generated runner と docs を含む差分を確認する。
- commit は Issue #1 の単位でまとめ、PR 本文に `Closes #1` を入れる。

## ドキュメントと生成物

実装時には以下を更新する。

- core implementation
  - `shared/adapter-envelope.ts`: request / response envelope v2 型、v1 前提型の置き換え
  - `workflow-common.ts` など state 読み込み境界: session state 読み込みを schema 検証付き helper に集約
  - `workflow-prepare.ts`: RoundEntry 作成、agent state 追加、複数 request file 返却
  - `workflow-complete.ts`: `rounds[].agents[]` の agent 単位更新、round 完了判定
  - `workflow-round.ts`: `--agent-id` 指定と曖昧性エラー
  - `types.ts`: 旧 `agent` フィールドを廃止し、`agent_id` / `adapter` を持つ state・artifact・result 型へ更新
  - `codex-adapter` / `claude-adapter`: v2 request validation、`agent_id` 単位の state file、`agent_id` 入り artifact path、v2 response 出力

state JSON を読む経路は、agent-review 側では schema 検証付き helper へ集約する。`readSession`、`completeRound`、
`getRound` などの直読みはこの helper を通す。adapter 側で agent-review session state を読む場合も同じ schema version を
明示検証し、旧 schema を分かりやすいエラーで拒否する。

- `docs/agent-review-spec.md`
  - adapter request / response envelope v2
  - state schema
  - prepare / complete / get-round-output の CLI 説明
  - 複数 agent 時の曖昧性と `--agent-id` 指定の扱い
- `docs/codex-adapter-spec.md` / `docs/claude-adapter-spec.md`
  - `agent` ではなく `adapter` を検証する v2 envelope へ更新
  - `agent_id` を round 内 execution identity として扱う説明を追加
- `plugin/skills/agent-review/SKILL.md`
  - 単一 agent の基本手順を新しい prepare output に合わせる
  - 複数 agent を使う場合の request file の扱いを追記する
- `plugin/scripts/agent-review-runner.mjs`
  - `npm run build` で生成更新する

## テスト計画

### State 遷移

- 1 round に `codex-a=codex`、`codex-b=codex`、`claude-reviewer=claude` の 3 agent state を保持できる。
- prepare 後、各 agent の `status` が `pending` になる。
- `codex-a` だけ complete すると、`codex-a` は `completed`、他 agent は `pending` のまま残る。
- 全 agent が complete されると、round の `completed_at` が設定される。
- `failed` / `skipped` も agent 単位で保持できる。

### 単一 agent regression

- `prepare-initial` の既定値から `complete-current-round`、`get-round-output` まで通る。
- `prepare-initial --agent-id reviewer --adapter codex` から `complete-current-round`、`get-round-output --agent-id reviewer` まで通る。
- `prepare-next-round` が直前 round の `agent_id` と `adapter` を既定値として引き継ぐ。
- `deep_dive` と `recovery` の前提条件が、新 schema の agent result を見て判定される。

### 複数 agent behavior

- `prepare-initial --agents codex-a=codex codex-b=codex` が 2 request file を作る。
- `--agents codex-a=codex codex-b=codex` が CLI parser で多値 option として解釈される。
- `--agent-id` / `--adapter` と `--agents` の同時指定はエラーになる。
- `--agents` の空指定、`agent_id` 重複、不正形式、`agent_id` 内の `=` はエラーになる。
- `adapter` が重複しても `agent_id` が異なれば許可される。
- `agent_id` ごとの prompt / adapter request artifact が衝突しない。
- codex/claude adapter の state file と artifact file が `agent_id` ごとに分かれ、同一 adapter の複数起動で上書きされない。
- `complete-round` が response の `agent_id` に一致する agent state だけを更新する。
- response の `adapter` が state の `adapter` と違う場合はエラーになる。
- `complete-current-round` は pending agent が複数ある場合にエラーになる。
- `get-round-output --agent-id claude-reviewer` が指定 agent state の output を返す。
- `get-round-output` の agent 未指定時、複数 output がある場合は曖昧性エラーになる。
- 直前 round の agent state が 1 件なら、完了 / 失敗に関係なく `prepare-next-round` がその `agent_id` と `adapter` を引き継ぐ。
- 直前 round に複数 agent state がある状態で `prepare-next-round` の agent 指定を省略するとエラーになる。
- `deep_dive` / `recovery` は対象 `agent_id` ごとの直前 state を見て可否判定する。
- `follow_up` で新しい `agent_id` を使う場合、previous output が複数あれば `previous_agent_id` 未指定をエラーにする。
- Claude adapter は同じ `agent_id` を round 1 から round 2 へ引き継いだ場合に、`rounds[].agents[]` から prior output を取得して context に含める。
- 旧 schema の state JSON は明確な schema version エラーになる。
- codex / claude adapter は `contract_version: 2`、`adapter`、`agent_id` を検証し、v2 response を返す。

### 実行確認

```bash
npm run check
npm test
```

## 前提

- 旧 state JSON の migration は実装しない。
- 旧 state JSON は暗黙に読み替えず、schema version 検証で拒否する。
- 進行中の v1 session は v2 実装後に継続できない。必要なら破棄して新 session を開始する。
- adapter request / response envelope は v2 に更新し、v1 envelope の受け入れはしない。
- 複数 agent 実行は、同一 round 番号を持つ複数の v2 adapter request として扱う。
- `agent_id` は実行識別子、`adapter` は駆動 adapter 名として明確に分離する。
- complete は agent-review runner が逐次呼び出す前提で、同一 session state への並行 write は Issue #1 ではサポートしない。
- Issue #1 の完了は、実装、テスト、ドキュメント更新、build 生成物更新、PR 作成までとする。
- PR 本文には `Closes #1` を入れる。
