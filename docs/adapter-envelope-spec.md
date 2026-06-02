# Adapter envelope 仕様 (V2)

agent-review オーケストレーターと各 adapter (codex / claude) の間でやり取りする
**request / response envelope の契約仕様**を、現実装をもって V2 として確定したもの。
本書を envelope 契約の単一情報源とし、`docs/agent-review-spec.md` /
`docs/codex-adapter-spec.md` / `docs/claude-adapter-spec.md` は本書を参照する。

実装上の正準は `src/core/shared/adapter-envelope.ts`。
本書と実装が食い違う場合は実装を正とし、本書を修正する。

## バージョニング方針

- envelope は `contract_version: 2` のみを受け入れる。`2` 以外は拒否する。
- v1 envelope、旧 `agent` フィールド、未指定 `contract_version` の migration は行わない。
- サポート対象は定数で固定する。

```ts
// src/core/shared/adapter-envelope.ts
export const SUPPORTED_ADAPTER_CONTRACT_VERSION = 2;
```

`agent-review` runner は受信 response の `contract_version` がこの値と一致しない場合に
`unsupported contract_version` で拒否する。各 adapter runner も request の
`contract_version !== 2` を `invalid_request_envelope` で拒否する。

## 識別子と path 安全性

`review_session_id` と `agent_id` は state file / artifact directory / artifact file 名の
**パス要素**になる。data dir 外への path traversal を防ぐため、両側
（agent-review と各 adapter）で次の安全条件を再検証する。

```ts
// 非空、ASCII 英数字 + `.` `_` `-` のみ、`..` を含まない
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
export function isSafePathSegment(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && SAFE_PATH_SEGMENT_RE.test(value) && !value.includes("..");
}
```

UUID はこの集合に含まれる。adapter 単体起動でも path traversal を防げるよう、
adapter 境界でも再検証する。

## パス表記

envelope に乗る path フィールド（request の `target_root` / `prompt_file` /
`context_file` / `target_files[]`、response の `output_file` / `artifacts[].path` /
`error.details_file`）は **forward slash 表記**に正規化する。Windows でも
`C:/Users/...` の形を契約上の安定表現とする。

理由: 受信側 (agent-review runner) は envelope file を `JSON.parse` するため、
Windows の `\` をエスケープせず素で埋めると `\U` 等で parse 失敗する。
内部 state file（各 adapter の agent state 等）は OS ネイティブ区切りで保持してよい。

request 側は `buildAdapterRequest` が `normalizePath` / `normalizePathList` で正規化する。
response 側は各 adapter の `makeResponse` が `output_file` / `artifacts[].path` /
`error.details_file` を正規化する。

## Request envelope V2

agent-review が adapter に渡す。`prepare` 時に runner が JSON file として保存し、
adapter は `--request <file>` でその path を受け取る。

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

型定義:

```ts
export type AdapterRequestEnvelopeV2 = {
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

| フィールド | 型 | 説明 |
|---|---|---|
| `contract_version` | `2` | 固定。`2` 以外は拒否 |
| `review_session_id` | string | レビューセッション識別子。safe path segment |
| `agent_id` | string | round 内の execution identity。state/artifact/response の path 要素。safe path segment |
| `adapter` | string | 駆動 adapter 名 (`codex` / `claude`)。identity ではない |
| `round` | number | round 番号。positive safe integer (`>= 1`) |
| `round_kind` | RoundKind | `initial_review` / `deep_dive` / `follow_up` / `recovery` |
| `target_root` | string | レビュー対象の作業 root。存在する directory であること |
| `prompt_file` | string | runner が生成した prompt 本文 file。存在すること（adapter 境界は存在確認のみで file/directory は区別しない） |
| `context_file` | string \| null | 共通 context file。無ければ `null` |
| `target_files` | string[] | レビュー対象 file 群。無ければ `[]` |
| `focus_question` | string \| null | ユーザーが確認したい主眼。無ければ `null` |
| `options.review_depth` | ReviewDepth | `low` / `medium` / `high`（adapter が固有設定へ変換） |
| `options.timeout_seconds` | number \| null | timeout 秒。無ければ `null` |

### state file / agent state file は含めない

`state_file` や `agent_state_file` は request に含めない。adapter は `--data-dir` で
渡される data dir と `review_session_id` から必要な state path を自前で導出する。

### adapter 側 request 検証 (`prepare`)

各 adapter runner は実行前に request 境界を検証する。失敗時は `invalid_request_envelope`
等の recoverable error を返す（[エラー契約](#エラー契約)参照）。

1. 必須フィールド（`contract_version`, `review_session_id`, `agent_id`, `adapter`,
   `round`, `round_kind`, `target_root`, `prompt_file`, `options`）が
   `undefined` / `null` / `""` でない
2. `contract_version === 2`
3. `adapter` が当該 adapter 名（codex なら `"codex"`、claude なら `"claude"`）と一致
4. `review_session_id` / `agent_id` が `isSafePathSegment` を満たす
5. `target_root` が存在する directory
6. `prompt_file` が存在する（存在確認のみ。不在時は両 adapter とも `prompt_file_missing`
   を返す）

`round` の値契約（positive safe integer）は agent-review producer が保証する。adapter 境界は
`round` の presence だけを検証し、safe-integer 性は再検証しない（artifact path 導出に
そのまま使う）。adapter 単体起動で異常な `round` を渡す経路を塞ぐなら、adapter 側で
safe-integer 検証を追加する余地がある。

state file 突き合わせ（adapter 側）:

- session state file を `<data-dir>/sessions/<review_session_id>.json` から導出し、
  `schema_version` が `2`、`review_session_id` が envelope と一致する。
- 個別 agent state file は存在しなくてよい。存在する場合は `review_session_id` と
  `agent_id` が envelope と一致する。

## Response envelope V2

adapter が agent-review へ返す。adapter は確定した envelope を
`round-<round>-<agent_id>-response.json` に保存し、その file path を `complete` の
stdout に返す（subagent の最終回答には含めない）。

成功例（codex）:

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
    }
  ],
  "error": null
}
```

失敗例:

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
    "code": "codex_exec_failed",
    "message": "...",
    "recoverable": true,
    "details_file": "C:/data/artifacts/session-1/round-2-codex-a-diagnostic.md"
  }
}
```

確定側（adapter）の型:

```ts
export type AdapterResponseEnvelopeV2 = {
  contract_version: 2;
  review_session_id: string;
  agent_id: string;
  adapter: string;
  round: number;
  status: AdapterResponseStatus; // "completed" | "failed" | "skipped"
  output_file: string | null;
  artifacts: AdapterResponseArtifact[];
  error: AdapterResponseError;
};
```

| フィールド | 型 | 説明 |
|---|---|---|
| `contract_version` | `2` | 固定 |
| `review_session_id` | string | request と同一 |
| `agent_id` | string | request と同一 |
| `adapter` | string | 当該 adapter 名 |
| `round` | number | request と同一 |
| `status` | `completed` / `failed` / `skipped` | 実行結果 |
| `output_file` | string \| null | レビュー本文 file。`completed` のみ必須、それ以外は `null` |
| `artifacts` | AdapterResponseArtifact[] | 生成 artifact metadata。無ければ `[]` |
| `error` | AdapterResponseError | 失敗時の recoverable error。成功時は `null` |

response envelope は**要約フィールドを持たない**。最終的な統合要約は agent-review が
`get-round-output` で `output_file` 本文を読んで作る。

### artifact / error サブ構造

```ts
export type AdapterResponseArtifact = {
  path: string;          // forward slash 正規化済み
  kind: string;          // "run_spec" / "agent_output" / "event_log" / "exit_status" / "diagnostic" など
  owner?: string;        // 例 "codex-adapter" / "claude-adapter"
  round?: number | null;
  agent_id?: string | null;
  adapter?: string | null;
  created_at?: string;   // ISO 8601
  temporary?: boolean;
  [key: string]: unknown;
};

export type AdapterResponseError = {
  code?: string;         // 例 "invalid_request_envelope"
  message?: string;
  recoverable?: boolean; // adapter が作る error は true
  details_file?: string | null; // diagnostic file への path（forward slash）
  [key: string]: unknown;
} | null;
```

adapter が `makeError` で作る recoverable error は `recoverable: true`、`details_file` に
diagnostic file path を持つ。adapter は同じ error を個別 agent state file の `errors[]`
にも `agent_id` / `adapter` / `round` / `created_at` を付けて記録するが、
**response envelope に乗るのは上記サブ構造のみ**。

### 受信側（agent-review）の緩い型

agent-review runner は外部プロセスが書いた envelope file を `JSON.parse` するため、
検証前は version / status / optional フィールドを緩く受ける。

```ts
export type AdapterResponseEnvelope = {
  contract_version: number;
  review_session_id: string | null;
  agent_id?: string | null;
  adapter?: string | null;
  round: number | null;
  status: AdapterResponseStatus | string;
  output_file?: string | null;
  artifacts?: AdapterResponseArtifact[];
  error?: AdapterResponseError;
};
```

### 受信側 response 検証 (`complete-round`)

agent-review runner は `validateAdapterResponse` で次を検証してから top-level
session state に反映する。

1. `contract_version === SUPPORTED_ADAPTER_CONTRACT_VERSION` (= `2`)
2. `status` が `completed` / `failed` / `skipped` のいずれか
3. `round` が positive safe integer (`>= 1`)
4. `agent_id` が非空 string
5. `adapter` が存在する
6. response file を指定した場合、その file が `artifactDir` 内にあり、実在する file
7. `status === "completed"` の場合:
   - `output_file` が非空 string
   - `output_file` が `artifactDir` 内にある
   - `output_file` が実在する file
8. `status !== "completed"` の場合、`output_file` は `null`（値があれば拒否）

`agent_id` の検証は非空 string チェックのみ（`validateAgentId`）で、ここでは
`isSafePathSegment` までは要求しない。受信した `error` は producer（各 adapter の
`makeError` / failure path）が作る不変条件であり、consumer 側の `validateAdapterResponse`
は `failed` / `skipped` 時の `error` の存在や shape を検証・解釈しない。error は各 adapter の
agent state file に閉じる。

state 突き合わせ（agent-review 側）:

- response の `review_session_id` で session state file を導出し、`schema_version`
  と `review_session_id` を検証する。
- response の `round` と `agent_id` に一致する `rounds[].agents[]` entry だけを更新する。
- state 側 `adapter` と response の `adapter` が異なる場合は拒否する。
- 対象 agent の `status` / `completed_at` / `agent_result` を更新し、同じ round の全
  agent が non-`pending` になった時点で round の `completed_at` を設定する。
- adapter 由来の artifacts/errors は各 adapter の agent state file に閉じ、top-level
  session state へは重複 append しない。

## Status / kind の列挙

`round_kind`（request `round_kind`）:

- `initial_review`
- `deep_dive`
- `follow_up`
- `recovery`

`status`（response `status` = `agent_result.status`）:

- `pending`（state 上の初期値。response 反映前。response envelope には現れない）
- `completed`
- `failed`
- `skipped`

`review_depth`（request `options.review_depth`）:

- `low` / `medium` / `high`（adapter が固有設定へ変換。未知値は adapter 側で fallback）

型としては `RoundKind` / `ReviewDepth` は将来拡張に備えて `string` union を許すが、
契約上の正準値は上記。

## エラー契約

request 境界検証の recoverable error は両 adapter (codex / claude) で共通の `code` を返す。

| code | recoverable | 契機 |
|---|---|---|
| `invalid_request_envelope` | true | 必須フィールド欠落、adapter 不一致、`contract_version` 不一致、unsafe な `review_session_id` / `agent_id`、`--data-dir` 未指定、request として不正 |
| `target_root_missing` | true | `target_root` が存在しない、または directory でない |
| `prompt_file_missing` | true | `prompt_file` が存在しない |

consumer (`validateAdapterResponse`) はこれら error code を解釈しないが、request 境界の
共通契約として両 adapter で揃える。

adapter 固有の追加 code（Codex 実行失敗、Claude output 欠落 など）は各 adapter spec に
記載する。`prepare` が request / state 検証で失敗し run spec / input を作れない場合も、
adapter は可能な範囲で diagnostic artifact と failed response envelope を保存するが、
`prepare` の stdout に response file path は返さず command 自体はエラー終了する。

## 生成 artifact のファイル名規約

agent-review と各 adapter が `<data-dir>/artifacts/<review_session_id>/` に作る
共通命名:

```text
round-<round>-<agent_id>-prompt.md            # agent-review が生成する prompt
round-<round>-<agent_id>-adapter-request.json # request envelope
round-<round>-<agent_id>-output.md            # adapter のレビュー本文 (response.output_file)
round-<round>-<agent_id>-response.json        # response envelope の保存コピー
```

adapter 固有の artifact（Codex の `run.json` / `events.jsonl` / `exit.json`、
diagnostic 等）の命名は各 adapter spec に記載する。同じ adapter を `codex-a` /
`codex-b` のように複数 `agent_id` で実行しても、state と artifacts は `agent_id`
単位で分離される。
