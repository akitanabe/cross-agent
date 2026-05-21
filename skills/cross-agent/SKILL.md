---
name: cross-agent
description: 外部エージェント（Codex、Claude など）を選んでセカンドオピニオン・批判的レビューを依頼するスキル。プランや設計案のレビュー、コードの問題点洗い出し、判断の妥当性確認など、独立した視点が欲しいときに使用する。「セカンドオピニオンが欲しい」「別のAIに聞いてみて」「第三者の目で見て」「クロスでレビューして」「cross-agent して」などの言葉が出たら使用する。
user-invocable: true
---

## 役割

cross-agent は外部エージェントへレビューを委譲するオーケストレーター。
自分ではレビュー本文を生成せず、ユーザー依頼を整理し、共通コンテキストとプロンプトを作り、
選択した adapter に渡し、戻ってきた出力を統合してユーザーへ提示する。

詳細な state schema、adapter 入出力契約、artifact、status、round の仕様は
[docs/cross-agent-spec.md](../../docs/cross-agent-spec.md) を正とする。

## 実行

ユーザー依頼から以下を判断する。

- `agent`: 未指定なら `codex`
- `focus_question`: 依頼の主眼
- `target_files`: レビュー対象として指定されたファイル
- `target_root`: レビュー対象の作業 root
- `review_depth`: 既定 `medium`
- `max_rounds`: 既定 `2`

対象や質問が特定できない場合は、adapter を呼ぶ前に通常会話で確認する。

機械的にできる初期化処理は runner に任せる。会話要約や設計案が必要な場合は
`context_text` として整理し、構造化 input を stdin から渡して以下を実行する。

```bash
node scripts/cross-agent.mjs prepare-initial <<'JSON'
{
  "agent": "codex",
  "target_root": "<target_root>",
  "focus_question": "<focus_question>",
  "context_text": "<context_text>",
  "target_files": [],
  "options": {
    "review_depth": "medium",
    "max_rounds": 2
  }
}
JSON
```

runner は以下の JSON を返す。

```json
{
  "review_session_id": "...",
  "state_file": "...",
  "artifact_dir": "...",
  "context_file": "...",
  "prompt_file": "...",
  "adapter_request_file": "...",
  "adapter_request": {
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
}
```

`adapter_request` を依頼本文に含め、対応する adapter Skill を呼ぶ。

| Agent | 委譲先 Skill |
|---|---|
| `codex` | `codex-adapter` |
| `claude` | `claude-adapter` |

adapter response を受け取ったら、round 完了処理も runner に任せる。

```bash
node scripts/cross-agent.mjs complete-round <<'JSON'
{
  "state_file": "<state_file>",
  "response": <adapter_response_json>
}
JSON
```

その後、adapter response の `output_file` を読み、ユーザーへ統合結果を提示する。

## 守ること

- state は `${CLAUDE_PLUGIN_DATA}` 配下にだけ書く。`${CLAUDE_PLUGIN_ROOT}` には書かない
- state / artifact / prompt / adapter request の初期作成は `prepare-initial` に任せる
- adapter response の `rounds[].agent_result` 反映は `complete-round` に任せる
- cross-agent は agent 固有 state を直接変更しない
- `state_file` や `agent_state_file` は adapter request envelope に含めない
- adapter 由来の artifacts/errors を top-level state に重複 append しない
- adapter response は要約せず、`output_file` を読んで最終表示だけを統合する

## 深掘りと統合

`max_rounds <= 1` の場合は深掘りしない。

Round 1 の結果を読んで追加確認が必要な場合は、Round 2 の prompt を作り、同じ
adapter request 形式で原則同じ agent に送る。現時点では Round 2 の prompt 作成と
追加 round 登録は完全には runner 化されていないため、仕様に従って Skill 側で補助する。

統合表示では以下を簡潔に示す。

1. 結論サマリ
2. 重要な指摘
3. 採用・保留・追加調査が必要な判断

## 実装メモ

- 実装本体: `scripts/cross-agent.mjs`
- 仕様: `docs/cross-agent-spec.md`
- 設計背景: `docs/cross-agent-design.md`
- テスト: `test/cross-agent.test.mjs`
- Node.js: 24+

runner や仕様を変更したら、少なくとも以下を実行する。

```bash
node --test
claude plugin validate .
```
