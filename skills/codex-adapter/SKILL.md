---
name: codex-adapter
description: cross-agent から委譲される Codex CLI（codex exec）固有のアダプター。review_session_id を Codex の thread_id にマッピングしてセッションを継続し、レビューを実行する。通常はユーザーが直接呼ばず、cross-agent オーケストレーターから呼び出される。
user-invocable: false
---

## 役割

codex-adapter は Codex CLI 実行境界を担当する。cross-agent から request envelope を受け取り、
Node.js runner を実行して response envelope を返す。

詳細な入出力契約、state 更新範囲、artifact、エラーコード、Codex CLI の分岐条件は
[docs/codex-adapter-spec.md](../../docs/codex-adapter-spec.md) を正とする。

## 実行

request envelope を stdin から渡して以下を実行する。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-adapter-runner.mjs" <<'REQUEST_ENVELOPE_JSON'
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
REQUEST_ENVELOPE_JSON
```

runner が stdout に出力した response envelope を cross-agent に返す。

## 守ること

- Codex の出力統合や要約は行わず、`output_file` を返すだけにする

## 実装メモ

- 実装本体: `scripts/codex-adapter-runner.mjs`
- テスト: `test/codex-adapter.test.mjs`
- Node.js: 24+

runner を変更したら、少なくとも以下を実行する。

```bash
node --test
claude plugin validate .
```
