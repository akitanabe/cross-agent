---
name: cross-agent
description: 外部エージェント（Codex、Claude など）を選んでセカンドオピニオン・批判的レビューを依頼するスキル。プランや設計案のレビュー、コードの問題点洗い出し、判断の妥当性確認など、独立した視点が欲しいときに使用する。「セカンドオピニオンが欲しい」「別のAIに聞いてみて」「第三者の目で見て」「クロスでレビューして」「cross-agent して」などの言葉が出たら使用する。
user-invocable: true
allowed-tools: Bash(node*cross-agent-runner.mjs*) Write
---

## 役割

cross-agent は外部エージェントへレビューを委譲するオーケストレーター。
自分ではレビュー本文を生成せず、ユーザー依頼を整理し、共通コンテキストとプロンプトを作り、
選択した adapter に渡し、戻ってきた出力を統合してユーザーへ提示する。

## 実行

ユーザー依頼から以下を判断する。

- `agent`: 未指定なら `codex`
- `focus_question`: 依頼の主眼
- `target_files`: レビュー対象として指定されたファイル
- `target_root`: レビュー対象の作業 root
- `review_depth`: 既定 `medium`
- `max_rounds`: 既定 `2`

対象や質問が特定できない場合は、adapter を呼ぶ前に通常会話で確認する。

`target_root` はレビューセッション全体の作業 root として、adapter を呼ぶ前に決める。
エージェント固有の実行方法や制約は adapter 側で扱う。

優先順:

1. `target_files` がある場合、そのファイル群に共通する git root
2. git root が取れない場合、project marker を親方向に探索
3. marker もない場合、指定ファイルの親ディレクトリ
4. `target_files` がない場合、現在の cwd

複数候補があり自動決定できない場合はユーザーへ確認する。

機械的にできる session state の作成は `cross-agent-runner.mjs` に任せる。

`--data-dir` は全 runner 呼び出しで必須。plugin 文脈では `${CLAUDE_PLUGIN_DATA}` をそのまま渡す。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cross-agent-runner.mjs" start-session \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --target-root "<target_root>" \
  --review-depth "medium" \
  --max-rounds "2"
```

runner は `review_session_id` だけを stdout に返す。以降の runner / adapter 呼び出しにはこの
`review_session_id` を渡す。

会話要約や設計案が必要な場合は本文を整理し、初回 round の前に context file として保存する。
runner が `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/context.md` を自動で取り込むため、Write で書き出すだけでよい。

**Write** `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/context.md`:
```md
<context_text>
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cross-agent-runner.mjs" prepare-initial \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --review-session-id "<review_session_id>" \
  --agent "codex" \
  --focus-question "<focus_question>" \
  --target-files "<target_file_1>" "<target_file_2>"
```

runner が返した adapter request envelope file path を使う。

返ってきた request envelope file path を依頼本文に含め、対応する subagent に委譲する。

| Agent   | 委譲先                                                        |
| ------- | ------------------------------------------------------------- |
| `codex` | `codex-agent` subagent（内部で `codex-adapter` skill を使用） |

`claude-adapter` は未完成のため、v1 では `codex` のみを実行対象とする。

subagent は adapter response envelope file path だけを返す。
返ってきた response envelope file path を `--response-file` で渡し、round 完了処理を runner に任せる。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cross-agent-runner.mjs" complete-round \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --response-file "<adapter_response_envelope.json>"
```

その後、`get-round-output` で adapter の出力本文を取得し、ユーザーへ統合結果を提示する。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cross-agent-runner.mjs" get-round-output \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --review-session-id "<review_session_id>" \
  --round "1"
```

## 守ること

- state や artifact の直接編集はせず、runner に任せる
- adapter response は要約せず、`get-round-output` で取得した本文を使って最終表示だけを統合する

## 深掘りと統合

`max_rounds <= 1` の場合は深掘りしない。

Round 1 の結果（`get-round-output` で取得した出力）を確認して追加確認が必要な場合は、Round 2 の prompt を作り、同じ
adapter request 形式で原則同じ agent に送る。

Round 2 を実行しない条件:

- `max_rounds <= 1`
- Round 1 が失敗しており、深掘りより復旧やユーザー確認が必要
- Round 1 が短く、明確に問題なしと結論している
- ユーザー質問が単純で、Round 1 だけで十分に回答されている

Round 2 を実行する条件:

- 重要指摘があるが具体性に欠ける
- 指摘の根拠が弱い、または言い過ぎの可能性がある
- 代替案、テスト観点、リスク評価のいずれかが薄い
- Round 1 の結論をそのまま採用するには不安が残る

## 2回目以降

追加 round の prompt 保存、state への round 登録、adapter request 作成は runner に任せる。

**Write** `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-2-prompt.md`:
```md
<round 2 prompt>
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cross-agent-runner.mjs" prepare-next-round \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --review-session-id "<review_session_id>" \
  --agent "codex" \
  --round-kind "deep_dive" \
  --prompt-file "${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-2-prompt.md"
```

runner が返した adapter request envelope file path を使う。

`round_kind` は用途で使い分ける。

| kind        | 用途                                                          |
| ----------- | ------------------------------------------------------------- |
| `deep_dive` | Round 1 の重要指摘を深掘り・反証・見落とし確認する自動深掘り  |
| `follow_up` | 統合表示後のユーザー追加質問。`max_rounds` の対象外           |
| `recovery`  | adapter 失敗後に、同じ session を使って復旧・再試行する round |

Round 2 の自動深掘り prompt には、Round 1 の繰り返しではなく以下を含める。

- 具体性に欠ける重要指摘の掘り下げ
- 根拠が弱い指摘や言い過ぎに見える指摘の批判的検証
- Round 1 で触れられていない重要観点の確認

Round 3 以降は原則として自動継続しない。ユーザーの追加質問がある場合は
`round_kind: "follow_up"` として扱い、明示的に深掘り継続を求められた場合だけ
`max_rounds` の範囲内で `deep_dive` を追加する。

Round 2 を実行した後は、Round 1 と同様に adapter response envelope file path を
`complete-round` に渡し、`get-round-output` で出力本文を取得する。

統合表示では以下を簡潔に示す。

1. 結論サマリ
2. 重要な指摘
3. 採用・保留・追加調査が必要な判断

## 実装メモ

- 実装本体: `scripts/cross-agent-runner.mjs`
- 仕様: `docs/cross-agent-spec.md`
- テスト: `test/cross-agent.test.mjs`
- Node.js: 24+

runner や仕様を変更したら、少なくとも以下を実行する。

```bash
node --test
claude plugin validate .
```
