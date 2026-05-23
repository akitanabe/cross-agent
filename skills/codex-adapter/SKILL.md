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
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-adapter-runner.mjs" [--launcher <shell>] <<'REQUEST_ENVELOPE_JSON'
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

## --launcher の選択

codex CLI を直接 `spawn` できない環境 (Windows の `.cmd` shim 等) では、POSIX shell 経由で
起動する必要がある。runner には platform 分岐コードを置かず、**呼び出し側が `--launcher` で
明示する** 契約。判定は次の手順で行う。

```bash
uname -s
```

出力に応じて選ぶ。

| `uname -s` の出力 | 渡す `--launcher` |
|---|---|
| `MINGW*` / `MSYS*` / `CYGWIN*` (Git Bash on Windows) | `--launcher bash` |
| `Linux` / `Darwin` / その他 POSIX | 渡さない (省略) |

`bash` が PATH 上で解決されない環境では、絶対パス (POSIX 形式) を渡す。例:
`--launcher /c/Program\ Files/Git/bin/bash.exe`

runner は `--launcher` 指定時、`<launcher> -c 'exec "$@"' <launcher> codex ...` の形で wrap
する。`exec "$@"` により shell の word splitting / 変数展開は完全に bypass され、prompt 等
の argv は文字列として codex に届く。

## 守ること

- Codex の出力統合や要約は行わず、`output_file` を含む response envelope を返すだけにする
- launcher 判定をスキップせず、起動前に必ず `uname -s` で観測する

## 実装メモ

- 実装本体: `scripts/codex-adapter-runner.mjs`
- テスト: `test/codex-adapter.test.mjs`
- Node.js: 24+

runner を変更したら、少なくとも以下を実行する。

```bash
node --test
claude plugin validate .
```
