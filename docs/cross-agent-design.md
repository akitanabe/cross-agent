# cross-agent スキル 設計骨子

## 概要

外部エージェント（Codex、Claudeなど）を選んで質問・レビューを依頼するスキル。
セカンドオピニオン・批判的レビュー・設計判断の妥当性確認などに使用する。

## 設計方針

- **拡張性重視**: 新しいエージェントを追加する際は、そのエージェント用adapter Skillを追加するだけでよい
- **責務分離**: cross-agent自体はセッションの中身を知らない。各adapterが自律的にセッション管理を持つ
- **プログラム的処理**: セッション管理（ID生成・マッピング・永続化）はコードで行い、Claudeの記憶に頼らない
- **State境界の明確化**: 初期実装はJSONファイルで状態を保存するが、将来MCP state serverへ移管できる操作モデルにする

## 命名規約

- レビューセッションのIDは `review_session_id` と呼ぶ
- JSON / state / 将来のMCP tool名は `snake_case` に統一する
- ファイル名は読みやすさを優先し、生成物は `round-1-codex-output.md` のような kebab-case を許容する

## ファイル構成（予定）

```
cross-agent/
├── SKILL.md               # メインスキル（エージェント選択・セッションID生成・深掘りループ・結果統合）
├── codex-adapter/
│   └── SKILL.md           # Codex固有の実装（thread_id管理・codex execコマンド）
└── claude-adapter/
    └── SKILL.md           # Claude固有の実装（コンテキストファイルベースのセッション管理）
```

## セッション管理の仕組み

### review_session_id

- cross-agent側が生成（UUID等）
- 各エージェントに渡すだけで、中身は管理しない
- Codexの `thread_id` や Claude の蓄積コンテキストは、各adapterが `review_session_id` に紐づけて管理する

### 永続化場所

初期実装では以下にJSONファイルとして保存する。

```text
${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json
```

`${CLAUDE_PLUGIN_ROOT}` はプラグイン更新時に変わる ephemeral な場所であり、
marketplace経由ではread-onlyになりうるため、状態保存には使わない。

### State ownership

| State | 所有者 | 備考 |
|---|---|---|
| `review_session_id` | `cross-agent` | セッション開始単位を決める |
| `schema_version` | state layer | migration対象 |
| `created_at` / `updated_at` | state layer | 保存時に機械的に管理する |
| `status` | `cross-agent` | 全体の進行状態 |
| `target_root` | `cross-agent` | レビュー対象全体のroot。必要に応じてagent側にもコピーする |
| `current_round` | `cross-agent` | Round制御はorchestratorの責務 |
| `options` | `cross-agent` | `max_rounds` / `review_depth` など |
| `context` | `cross-agent` | 各agentに渡す共通入力 |
| `rounds` | `cross-agent` | Roundごとの実行履歴 |
| Codex agent state file | `codex-adapter` | `thread_id` / resume / Codex固有ログ / artifacts / errors |
| Claude agent state file | `claude-adapter` | 蓄積context / Claude呼び出し履歴 / artifacts / errors |
| `artifacts` | `cross-agent` | cross-agent 自身が作成した context / prompt / request |
| `errors` | `cross-agent` | cross-agent 自身が検出したエラー |

`cross-agent` は Codex の `thread_id` などのagent固有stateを直接変更しない。
agent固有stateの作成・更新・復旧判断、個別state file のパス導出は各adapterに閉じる。

### State schema v1

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
      "completed_at": "...",
      "agent_result": {
        "agent": "codex",
        "status": "completed",
        "output_file": "..."
      }
    }
  ],
  "artifacts": {
    "files": []
  },
  "errors": []
}
```

Codex agent state file:

```json
{
  "schema_version": 1,
  "review_session_id": "uuid-xxxx",
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

### Enum v1

`session.status`:

- `active`
- `completed`
- `failed`
- `abandoned`

`needs_user_input` は v1 では入れない。ユーザー入力待ちは中断・再開ワークフロー全体の
設計に関わるため、MCP / UI / resume設計を行う段階で `pending_user_input` や
`resume_action` と一緒に再検討する。v1では通常会話でユーザーに確認し、
session.statusは `active` のまま維持する。

`round.kind`:

- `initial_review`
- `deep_dive`
- `follow_up`
- `recovery`

`agent.status` / `agent_result.status`:

- `pending`
- `running`
- `completed`
- `failed`
- `skipped`

`options.review_depth`:

- `low`: 軽い確認。速度優先
- `medium`: 既定。通常の設計レビュー・コードレビュー・判断の妥当性確認
- `high`: 深い検討

`review_depth` は cross-agent の抽象設定であり、adapter が各agent固有の実行設定へ翻訳する。
例: Codex adapter は `low -> medium`, `medium -> high`, `high -> xhigh` として
Codex CLI の `model_reasoning_effort` へ変換する。
Claude adapter は `low -> medium`, `medium -> high`, `high -> xhigh` として
Claude subagent の `effort` へ変換する。

### 各エージェントの責務

| エージェント | セッション継続の仕組み |
|---|---|
| codex-adapter | review_session_id → thread_id のマッピングを自前管理 |
| claude-adapter | review_session_id → コンテキストファイルのマッピングを自前管理 |

### Adapterの戻り値

各adapterはagent固有stateを自分で更新したうえで、cross-agentへ以下の形で実行結果を返す。
cross-agentはこの戻り値を `rounds[].agent_result` に記録する。

```json
{
  "agent": "codex",
  "round": 1,
  "status": "completed",
  "output_file": "...",
  "error": null
}
```

## Adapter入出力契約

Claude Code の Skill は関数APIではなく実行手順なので、cross-agent から各adapterへ
委譲するときは、依頼本文に以下のJSON envelopeを含める。将来MCPやスクリプト実装へ
移す場合も、このenvelopeをそのまま境界契約として使う。

### Adapter request envelope v1

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

フィールドの責務:

| Field | 必須 | 所有者 | 説明 |
|---|---|---|---|
| `contract_version` | yes | `cross-agent` | 入出力契約のバージョン |
| `review_session_id` | yes | `cross-agent` | レビューセッションID |
| `agent` | yes | `cross-agent` | 委譲先agent名 |
| `round` | yes | `cross-agent` | 1始まりのround番号 |
| `round_kind` | yes | `cross-agent` | `initial_review` / `deep_dive` / `follow_up` / `recovery` |
| `target_root` | yes | `cross-agent` | レビュー対象の作業root |
| `prompt_file` | yes | `cross-agent` | adapterへ投げるプロンプト本文のファイル |
| `context_file` | no | `cross-agent` | 会話・設計案などの共通コンテキスト |
| `target_files` | no | `cross-agent` | ユーザー指定のレビュー対象ファイル |
| `focus_question` | no | `cross-agent` | ユーザーが指定した焦点質問 |
| `options` | yes | `cross-agent` | 実行設定。adapterは必要に応じてagent固有値へ翻訳する |

adapter は `prompt_file` を主入力として扱う。`context_file` や `target_files` は
補助入力であり、agentの性質に応じてプロンプトへ明示的に含めるか、CLI引数・作業rootで
参照可能にする。

### Adapter response envelope v1

```json
{
  "contract_version": 1,
  "review_session_id": "uuid-xxxx",
  "agent": "codex",
  "round": 1,
  "status": "completed",
  "output_file": "...",
  "artifacts": [
    {
      "path": "...",
      "kind": "agent_output",
      "temporary": false
    }
  ],
  "error": null
}
```

失敗時は `status: "failed"` とし、`error` を必ず含める。

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
    "details_file": "..."
  }
}
```

adapter response envelope は要約フィールドを持たない。
最終的な統合要約は cross-agent が `output_file` を読んで作る。

### 呼び出し順序

1. `cross-agent` が `review_session_id` とstate fileを作成する
2. `cross-agent` が `context_file` と `prompt_file` を作成し、artifactとして登録する
3. `cross-agent` が `rounds[]` にround開始を記録する
4. `cross-agent` がrequest envelopeを添えて対象adapterへ委譲する
5. adapterが自分で導出した agent state file を更新する
6. adapterがresponse envelopeを返す
7. `cross-agent` がresponseを `rounds[].agent_result` に記録する
8. `cross-agent` がroundを完了させる

### Artifacts

cross-agent が生成した context / prompt / adapter request は top-level session state の
`artifacts.files[]` にappendする。adapter が生成した agent output / event log / diagnostic は
各 agent state file の `artifacts[]` にappendする。作成者以外が既存artifactを書き換えない。

```json
{
  "path": "...",
  "kind": "context | prompt | adapter_request | agent_output | event_log | accumulated_context | diagnostic",
  "owner": "cross-agent | codex-adapter | claude-adapter",
  "round": 1,
  "agent": "codex",
  "created_at": "...",
  "temporary": false
}
```

`temporary: true` は通常の終了時に削除してよいファイル、`temporary: false` は
デバッグやフォローアップのため残すファイルを表す。v1では安全側に倒し、agent outputと
蓄積contextは原則 `temporary: false` とする。

### Errors

cross-agent 自身が検出したエラーは top-level session state の `errors[]` にappendする。
adapter が検出したエラーは各 agent state file の `errors[]` にappendする。エラーをappendしても、
必ずしも session 全体が `failed` になるわけではない。復旧可能なagent失敗や確認待ちの診断は、
`recoverable: true` として記録し、全体statusは `active` のまま維持できる。

```json
{
  "code": "ambiguous_target_root",
  "message": "Multiple target roots were found.",
  "agent": null,
  "round": null,
  "recoverable": true,
  "details_file": null,
  "created_at": "..."
}
```

## cross-agent 実行フロー v1

v1は単純で確実な単一round単一agentフローにする。複数エージェントによる同一roundの
比較レビューは、MCP state serverや統合ポリシーを設計する段階で改めて扱う。
ただし、フォローアップで別のagentへ追加相談することは、roundごとの `agent` で表現できる。

### Phase 0: ユーザー入力の解釈

`cross-agent` はユーザーの依頼から以下を抽出する。

- `initial_agent`: `--agent codex` 等。未指定なら `"codex"`
- `focus_question`: 引用文字列や明示された質問
- `target_files`: パスとして解釈できる引数
- `review_depth`: 既定 `medium`。「軽く」「ざっくり」なら `low`、「深く」「じっくり」なら `high`
- `max_rounds`: 既定 `2`。「1回だけ」「クイックに」なら `1`

対象や質問がまったく特定できない場合、通常会話でユーザーに確認する。このとき
`session.status` はまだ作らないか、作成済みなら `active` のまま維持する。
v1では `needs_user_input` を使わない。

### Phase 1: target_root の決定

`target_root` はレビューセッション全体の作業rootとして `cross-agent` が決める。
エージェント固有の実行方法や制約はここでは扱わない。

優先順:

1. `target_files` がある場合、そのファイル群に共通するgit root
2. git rootが取れない場合、`package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` などのproject markerを親方向に探索
3. markerもない場合、指定ファイルの親ディレクトリ
4. `target_files` がない場合、Claude Codeの現在のcwd

複数の候補rootが出て自動決定できない場合はユーザーへ確認する。確認待ちは
state machineに載せず、通常会話として処理する。

### Phase 2: セッション初期化

`cross-agent` は以下を作成する。

- `review_session_id`
- `${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json`
- `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/`

個別agentの state directory は各adapterが必要になった時点で導出・作成する。
cross-agent はその具体パスを request envelope や top-level state に含めない。

初期state:

```json
{
  "schema_version": 1,
  "review_session_id": "uuid-xxxx",
  "created_at": "...",
  "updated_at": "...",
  "status": "active",
  "target_root": "...",
  "current_round": 0,
  "options": {
    "max_rounds": 2,
    "auto_deep_dive": true,
    "review_depth": "medium",
    "keep_artifacts": false
  },
  "context": {},
  "rounds": [],
  "artifacts": {
    "files": []
  },
  "errors": []
}
```

### Phase 3: 共通コンテキストと初回プロンプト作成

`cross-agent` は会話・プラン・設計案・ユーザー指定ファイルを整理し、artifact directoryに
以下を作る。

- `context.md`: 会話や設計案の要約。ファイル指定だけで十分な場合は省略可
- `round-1-prompt.md`: Round 1で選んだagentに渡す初回レビュー依頼

`context` stateには以下を保存する。

```json
{
  "context_file": ".../context.md",
  "initial_prompt_file": ".../round-1-prompt.md",
  "focus_question": "...",
  "target_files": ["..."],
  "source": "conversation | files | mixed"
}
```

初回プロンプトには最低限以下を含める。

- 独立したシニアエンジニアとして批判的・建設的にレビューすること
- `focus_question`
- `context_file`
- `target_files`
- レビュー観点: リスク、代替案、妥当性、実装注意点、テスト観点

### Phase 4: Round 1 実行

`cross-agent` は `rounds[]` に `kind: "initial_review"` と `agent` を持つroundを
開始状態で追加し、そのagentに対応するadapterを実行する。

実行手順:

1. request envelopeを組み立てる
2. 対象adapterへ委譲する
3. response envelopeを受け取る
4. `rounds[].agent_result` に結果を記録する

adapter は自分が生成した `artifacts` と `errors` を自分で導出した agent state file に append する。
cross-agent は response envelope の内容を `rounds[].agent_result` に記録するだけで、
adapter 由来の `artifacts` / `errors` を重複 append しない。

### Phase 5: Round 2 deep_dive 判断

以下のいずれかに該当する場合、Round 2は実行しない。

- `max_rounds <= 1`
- Round 1の成功結果が短く、かつ明確に「問題なし」と結論している
- ユーザー質問が単純なYes/Noで、Round 1で十分に回答された

それ以外は `kind: "deep_dive"` のRound 2を実行する。

### Phase 6: Round 2 プロンプト作成

`cross-agent` はRound 1の成功した `output_file` を読み、1つの追加プロンプトを作る。

- 深掘り: 重要だが具体性に欠ける指摘を詰める
- 反論・批判的検証: 根拠が弱い指摘や言い過ぎに見える指摘を問い直す
- 見落とし確認: Round 1で触れられていない重要観点を1から2個確認する

### Phase 7: Round 2 実行

Round 1と同じagentに対応するadapterを実行する。
`round_kind` は `deep_dive` とする。adapter側は `review_session_id` に紐づく自分の
セッション状態を使い、Codexならresume、Claudeなら蓄積contextを再投入する。

### Phase 8: 統合表示

`cross-agent` はagent出力を読み、ユーザーには統合結果だけを出す。
生のagent出力は必要に応じて参照できるよう `output_file` として残す。

表示形式:

1. 結論サマリ
2. 重要な指摘
3. 採用・保留・追加調査が必要な判断

Round 2を実行した場合は、冒頭で「2往復のやり取りを統合した結果」と明示する。

統合表示後、sessionはフォローアップ可能なため `status: "active"` のまま維持する。
ユーザーが終了を示した時点で `completed` にする。

### Phase 9: フォローアップ

ユーザーが追加質問をした場合、既存の `review_session_id` を継続して
`kind: "follow_up"` のroundを追加する。

フォローアップでは、追加質問を `round-N-prompt.md` に保存し、同じrequest envelope形式で
adapterへ渡す。agent指定があればそのagentをroundに記録し、未指定なら直前roundと同じ
agentを使う。

### Phase 10: 終了とcleanup

ユーザーが「OK」「ありがとう」「終了」など終了を示したら、`session.status` を
`completed` にする。

cleanup方針:

- `temporary: true` のartifactは削除してよい
- `temporary: false` のartifactは残す
- `keep_artifacts: true` の場合はtemporary artifactも残す

ユーザーが明示的に中断した場合は `abandoned` とする。復旧不能なエラーで処理を終える場合は
`failed` とする。

## 将来のMCP state server

MCPは状態の実体ではなく、状態操作の境界として扱う。初期実装はJSONファイル直書きでも、
操作モデルは以下に移管できるように保つ。

- `create_session`
- `get_session`
- `set_context`
- `start_round`
- `update_agent_state`
- `append_agent_result`
- `append_artifact`
- `append_error`
- `complete_round`
- `complete_session`
- `cleanup_session`

## cross-agent SKILL.md の責務

1. エージェントの選択（ユーザー指定 or 既定）
2. review_session_idの生成・管理
3. コンテキスト・プロンプトの組み立て（既存adviceスキルから転用）
4. 各エージェントadapterへの委譲
5. 自動深掘りループ（既定2往復）
6. 結果の統合・提示

## 既存 advice スキルからの移行

### 捨てる部分
- session id管理（thread_id抽出、resume）※ codex-adapter側に移動
- Codex CLIの `-C <target-root>` 制約への対応 ※ codex-adapter側に移動
- `--json` フラグ、JSONLパース ※ codex-adapter側に移動
- セッション切れ時のフォールバック ※ codex-adapter側に移動
- バージョン依存注記 ※ codex-adapter側に移動

### 転用する部分
- コンテキストのファイル書き出し（Step 2）
- プロンプトの組み立て方（Step 3）
- 自動深掘りループの考え方（Step 5）
- 結果の統合・提示フォーマット（Step 6）

## 今後の検討事項

- claude-adapterのセッション継続の具体的な実装方法
- 複数エージェントによる比較レビュー
- MCP state serverの設計
- `needs_user_input` を含む中断・再開ワークフロー設計
