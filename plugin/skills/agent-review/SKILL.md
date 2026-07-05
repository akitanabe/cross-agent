---
name: agent-review
description: 外部エージェント（Codex、Claude など）を選んでセカンドオピニオン・批判的レビューを依頼するスキル。プランや設計案のレビュー、コードの問題点洗い出し、判断の妥当性確認など、独立した視点が欲しいときに使用する。「セカンドオピニオンが欲しい」「別のAIに聞いてみて」「第三者の目で見て」「クロスでレビューして」「agent-review して」などの言葉が出たら使用する。
user-invocable: true
allowed-tools: Bash(node "**/agent-review-runner.mjs"**) Glob Write
---

## 役割

agent-review は外部エージェントへレビューを委譲するオーケストレーター。
自分ではレビュー本文を生成せず、ユーザー依頼を整理し、共通コンテキストとプロンプトを作り、
選択した adapter に渡し、戻ってきた出力を統合してユーザーへ提示する。

1 round には複数 execution を含められる。`agent_id` は round 内の実行識別子、`adapter` は駆動 adapter 名である。

## 実行

ユーザー依頼から以下を判断する。

- `agent_id` / `adapter`: 委譲先。単一なら `--agent-id`/`--adapter`、複数なら `--agents <agent_id>=<adapter> ...`。省略時は `codex`=`codex`
- `focus_question`: 依頼の主眼
- `target_files`: レビュー対象として指定されたファイル
- `target_root`: レビュー対象の作業 root
- `review_depth`: 既定 `medium`
- `auto_deep_dive`: 既定 `true`

対象や質問が特定できない場合は、adapter を呼ぶ前に通常会話で確認する。

`target_root` はレビューセッション全体の作業 root として、adapter を呼ぶ前に決める。
エージェント固有の実行方法や制約は adapter 側で扱う。

優先順:

1. `target_files` がある場合、そのファイル群に共通する git root
2. git root が取れない場合、project marker を親方向に探索
3. marker もない場合、指定ファイルの親ディレクトリ
4. `target_files` がない場合、現在の cwd

複数候補があり自動決定できない場合はユーザーへ確認する。

機械的にできる session state の作成は `agent-review-runner.mjs` に任せる。
ユーザーが自動深掘りを不要と明示した場合は `--auto-deep-dive "false"` を渡す。

`--data-dir` は全 runner 呼び出しで必須。plugin 文脈では `${CLAUDE_PLUGIN_DATA}` をそのまま渡す。

Bash で runner に渡すパス引数は forward slash 形式に正規化し、double quote で囲む。
Windows drive path は `"C:/path/to/repo"`、UNC は `"//Server/Share/path"` の形で渡す。
backslash 形式の Windows パスは Bash の escape 処理で壊れやすいため使わない。
共有名やパス要素に `$` など shell 展開される文字が含まれる場合だけ single quote を使う。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" start-session \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --target-root "<target_root>" \
  --review-depth "medium" \
  --auto-deep-dive "true"
```

Git Bash から Windows UNC を渡す場合は `"//Server/Share/path"` の形式にする。
`"\\Server\Share"` のような backslash 形式は、bash の escape 処理で先頭の `\\` が `\` に潰れることがある。

`--review-session-id` は省略でき、省略時は runner が UUID を生成する。start-session は確定した
`review_session_id` を stdout に text で返すので、これを控えて以降の全 runner / adapter 呼び出しに渡す。

会話要約や設計案が必要な場合は本文を整理し、初回 round の前に context file として保存する。
runner が `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/context.md` を自動で取り込むため、Write で書き出すだけでよい。

**Write** `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/context.md`:

```md
<context_text>
```

初回 round を prepare する。

単一 agent:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" prepare-initial \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --review-session-id "<review_session_id>" \
  --agent-id "codex" \
  --adapter "codex" \
  --focus-question "<focus_question>" \
  --target-files "<target_file_1>" "<target_file_2>"
```

複数 agent:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" prepare-initial \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --review-session-id "<review_session_id>" \
  --agents codex-a=codex codex-b=codex claude-reviewer=claude
```

prepare output は常に JSON で、`requests[]` に各 adapter の request file が入る。

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

`requests[]` の各 request envelope file path を依頼本文に含め、`adapter` に対応する subagent に委譲する。

| Adapter  | 委譲先                                                          |
| -------- | --------------------------------------------------------------- |
| `codex`  | `codex-agent` subagent（内部で `codex-adapter` skill を使用）   |
| `claude` | `claude-agent` subagent（内部で `claude-adapter` skill を使用） |

ユーザーが Claude を明示した場合、または比較対象として Claude が必要な場合は `claude` adapter を指定する。
Claude 側の実行境界、蓄積 context、state 更新は `claude-adapter` が扱う。

subagent が完了したら、current round を閉じる。pending agent が 1 件だけの round は
`complete-current-round` で `review_session_id` から導出して閉じる。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" complete-current-round \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --review-session-id "<review_session_id>"
```

複数 agent の round で pending が複数ある場合は、各 adapter が書いた response file を指定して逐次閉じる。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" complete-round \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --response-file "<response-envelope.json>"
```

その後、`get-round-output` で adapter の出力本文を取得し、ユーザーへ統合結果を提示する。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" get-round-output \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --review-session-id "<review_session_id>" \
  --round "1" \
  --agent-id "codex-a"
```

`--agent-id` を省略できるのは、対象 round の output file を持つ agent が一意な場合だけである。

## 守ること

- state や artifact の直接編集はせず、runner に任せる
- adapter response は要約せず、`get-round-output` で取得した本文を使って最終表示だけを統合する
- 同じ adapter を同じ round で複数回使う場合も、異なる `agent_id` を指定する

## 深掘りと統合

`auto_deep_dive` が `false` の場合は自動深掘りしない。

Round 1 の結果（`get-round-output` で取得した出力）を確認して追加確認が必要な場合は、Round 2 の prompt を作り、同じ
adapter request 形式で原則同じ `agent_id` に送る。

Round 2 を実行しない条件:

- `auto_deep_dive` が `false`
- Round 1 が失敗しており、深掘りより復旧やユーザー確認が必要
- Round 1 が短く、明確に問題なしと結論している
- ユーザー質問が単純で、Round 1 だけで十分に回答されている

Round 2 を実行する条件:

- 重要指摘があるが具体性に欠ける
- 指摘の根拠が弱い、または言い過ぎの可能性がある
- 代替案、テスト観点、リスク評価のいずれかが薄い
- Round 1 の結論をそのまま採用するには不安が残る

## 2回目以降

追加 round は必ず以下の順序で進める。

1. 追加依頼の目的と `round_kind` を決める
2. 追加依頼本文を prompt draft file に **Write** する
3. その prompt draft file を `--prompt-file` に渡して `prepare-next-round` を実行する
4. runner が返した `requests[]` の各 request envelope file path を使って subagent に委譲する
5. subagent 完了後に round を閉じ（pending 1 件なら `complete-current-round`、複数なら
   `complete-round --response-file`）、`get-round-output` で出力本文を取得する

`prepare-next-round` は `--prompt-file` が必須。ユーザーから follow-up 指示を受けた直後に、prompt draft file を
まだ書いていない状態で runner を起動してはいけない。

追加 round は、前の round が完了済みであることを前提にする。直前の subagent 実行後に round を
まだ閉じていない場合は、follow-up prompt を書く前に current round を閉じ、`get-round-output` で出力本文を取得する。

prompt draft file は `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-<next_round>-prompt.md` に書く。
`<next_round>` は既存 session の最後の round の次の番号。runner はこの draft を読み込み、前回出力への参照や
出力方針を足した canonical prompt として各 agent の prompt artifact（`round-<next_round>-<agent_id>-prompt.md`）を作成する。

直前 round の agent state が 1 件だけなら `--agent-id`/`--adapter` は省略でき、その `agent_id`/`adapter` を引き継ぐ。
直前 round に複数 agent がある場合は、`--agent-id`/`--adapter` または `--agents` を明示する。

`round_kind` は用途で使い分ける。

| kind        | 用途                                                          |
| ----------- | ------------------------------------------------------------- |
| `deep_dive` | 対象 `agent_id` の直前 result が `completed` の場合に深掘り・反証・見落とし確認する |
| `follow_up` | 統合表示後のユーザー追加質問                                 |
| `recovery`  | 対象 `agent_id` の直前 result が `failed` の場合に、同じ session で復旧・再試行する |

### 自動深掘り

自動深掘りは `round_kind: "deep_dive"` として実行する。Round 2 の自動深掘り prompt には、Round 1 の繰り返しではなく以下を含める。

- 具体性に欠ける重要指摘の掘り下げ
- 根拠が弱い指摘や言い過ぎに見える指摘の批判的検証
- Round 1 で触れられていない重要観点の確認

**Write** `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-2-prompt.md`:

```md
<deep dive prompt>
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" prepare-next-round \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --review-session-id "<review_session_id>" \
  --agent-id "codex" \
  --adapter "codex" \
  --round-kind "deep_dive" \
  --prompt-file "${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-2-prompt.md"
```

Round 2 を実行した後は、Round 1 と同様に round を閉じ、`get-round-output` で出力本文を取得する。

Round 2 終了後は、まず Round 1 と Round 2 の結果を統合して結論を返す。その回答の末尾で、
追加質問があるかをユーザーに確認する。ユーザーから追加質問があった場合だけ、次の round を
`round_kind: "follow_up"` として開始する。

### ユーザーフォローアップ

follow-up はユーザーが追加質問、反論、別観点の確認、特定指摘の深掘りを明示した場合だけ実行する。
自動では開始しない。

follow-up の prompt draft には、最低限以下を含める。

- ユーザーの追加質問を、意味を変えずにそのまま近い形で書く
- どの既存回答や指摘に対する follow-up かを明示する
- 追加で見てほしいファイル、制約、期待する出力形式があれば書く
- 既存レビュー全体の再実行ではなく、追加質問に集中するよう指示する

**Write** `${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-<next_round>-prompt.md`:

```md
<user follow-up request>
```

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" prepare-next-round \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --review-session-id "<review_session_id>" \
  --agent-id "codex" \
  --adapter "codex" \
  --round-kind "follow_up" \
  --prompt-file "${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-<next_round>-prompt.md"
```

follow-up の agent は原則として前回 round と同じ `agent_id` にする。ユーザーが別 agent を指定した場合だけ変更する。
`previous_round` は通常指定しない。特定 round への追加質問だと明確な場合だけ `--previous-round "<round>"` を付ける。
前回出力が複数あり参照元を一意に決められない場合は `--previous-agent-id "<agent_id>"` を指定する。

Round 3 以降は原則として自動継続しない。ユーザーが明示的に深掘り継続を求めた場合だけ、
`deep_dive` を追加する。

統合表示では以下を簡潔に示す。

1. 結論サマリ
2. 重要な指摘
3. 採用・保留・追加調査が必要な判断

## 初回実行後の案内

セッション完了後、**初回のみ**、確認プロンプトを減らすための allowlist パターンをユーザーへ案内する。

以下を settings.local.json の `permissions.allow` に追加すると次回以降の確認が不要になる。

```
# context.md / round-*-prompt.md の Write
Write(${CLAUDE_PLUGIN_DATA}/artifacts/*/context.md)
Write(${CLAUDE_PLUGIN_DATA}/artifacts/*/round-*-prompt.md)

# agent-review runner（このスキル内の Bash）
Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" start-session **)
Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" prepare-initial **)
Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" prepare-next-round **)
Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" complete-current-round **)
Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" complete-round **)
Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/agent-review-runner.mjs" get-round-output **)

# codex-adapter（subagent 内の Bash）
Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-adapter-runner.mjs" prepare **)
Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-adapter-runner.mjs" complete **)
Bash(codex --ask-for-approval never exec **)

# claude-adapter（subagent 内の Bash）
Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-adapter-runner.mjs" prepare **)
Bash(node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-adapter-runner.mjs" complete **)
```

`/update-config` スキルを使えばその場で追加できることも伝える。

## 実装メモ

- `agent-review` はユーザー向け skill 名であり、レビュー orchestration layer の実装名でもある。
- 開発 repo の実装本体: `src/runners/agent-review-runner.ts`
- 配布 runner: `scripts/agent-review-runner.mjs`
- 仕様: https://github.com/akitanabe/cross-agent/blob/main/docs/agent-review-spec.md
- 開発 repo のテスト: `test/runners/agent-review-runner.test.ts`, `test/core/agent-review/*.test.ts`
- Node.js: 24+

開発 repo で runner や仕様を変更したら、少なくとも以下を実行する。

```bash
npm run check
npm test
claude plugin validate plugin
```
