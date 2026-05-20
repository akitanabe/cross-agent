---
name: codex-subagent
description: cross-agent から委譲される Codex CLI（codex exec）固有のサブスキル。review_session_id を Codex の thread_id にマッピングしてセッションを継続し、レビューを実行する。通常はユーザーが直接呼ばず、cross-agent オーケストレーターから呼び出される。
user-invocable: false
---

> **テンプレート段階**: このファイルは骨子です。実装の詳細な参照元は
> [docs/SKILL.md](../../docs/SKILL.md)（既存 advice スキルの Codex 実装そのもの）。
> advice スキルの Codex 固有ロジックをここへ移植する。

## 責務

cross-agent から渡される `review_session_id` とコンテキストを受け取り、Codex CLI で
レビューを実行する。Codex 固有のセッション管理・CLI 呼び出しはすべてここに閉じる。

[docs/cross-agent-design.md](../../docs/cross-agent-design.md) で「codex-subagent 側に移動」と
された部分の実装場所:

- `review_session_id` → `thread_id` のマッピング（自前管理）
- `-C <target-root>` の解決ロジック
- `--json` フラグと JSONL パース（thread_id 抽出）
- `codex exec resume` によるセッション継続
- セッション切れ時のフォールバック
- バージョン依存注記

## 入力（cross-agent から）

| 引数 | 内容 |
|---|---|
| `review_session_id` | cross-agent が生成したレビューセッション ID |
| コンテキストファイルパス | レビュー対象の会話・プラン・ファイル |
| reasoning effort | 既定 `high`（`medium` / `xhigh` に上下可） |
| Round | Round 1（新規）か Round 2 以降（resume）か |

## セッションマッピング

`${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json` の `agents.codex.thread_id` を
読み書きする。

- **Round 1**: thread_id が無 → `codex exec -C <root> --json` で新規セッション開始、
  `thread.started` イベントから thread_id を抽出して保存
- **Round 2 以降**: 保存済み thread_id で `codex exec resume <thread_id>`

> ⚠️ 状態は `${CLAUDE_PLUGIN_DATA}` に書く。`${CLAUDE_PLUGIN_ROOT}` は不可。

## 実装手順

> TODO: [docs/SKILL.md](../../docs/SKILL.md) の Step 1-b（target-root 解決）、Step 4
> （Round 1 実行・thread_id 抽出）、Step 5/フォローアップ（resume）、バージョン依存注記を
> ここへ移植する。session id を「Claude が記憶」する方式から「JSON ファイルで永続化」する
> 方式へ変更する点に注意。

### 出力（cross-agent へ）

Codex の最終メッセージ（レビュー本文）のパスを返す。深掘りループの判断・統合は
cross-agent 側が行うため、ここでは生のレビュー結果を返すだけでよい。

```json
{
  "agent": "codex",
  "round": 1,
  "status": "completed",
  "output_file": "...",
  "summary": null,
  "error": null
}
```
