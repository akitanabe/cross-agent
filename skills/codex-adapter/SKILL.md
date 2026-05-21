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

request envelope を JSON ファイルとして保存し、以下を実行する。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-adapter.mjs" --request "<request-envelope.json>"
```

runner は response envelope を stdout に出力し、同じ内容を artifact directory の
`round-<N>-codex-response.json` に保存する。

## 守ること

- state は `${CLAUDE_PLUGIN_DATA}` 配下にだけ書く。`${CLAUDE_PLUGIN_ROOT}` には書かない
- adapter が所有する state は `review_session_id` から自分で導出する Codex 個別 state file のみ。`rounds[]` や session 全体の `status` は cross-agent が更新する
- agent state file の `thread_id` が無い場合は新規 Codex session を作る
- agent state file の `target_root` と request の `target_root` が異なる場合も新規 Codex session を作る
- `thread_id` があり、かつ `target_root` が一致する場合だけ `codex exec resume` を使う
- Codex の出力統合や要約は行わず、`output_file` を返すだけにする

## 実装メモ

- 実装本体: `scripts/codex-adapter.mjs`
- テスト: `test/codex-adapter.test.mjs`
- Node.js: 24+

runner を変更したら、少なくとも以下を実行する。

```bash
node --test
claude plugin validate .
```
