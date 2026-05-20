---
name: claude-adapter
description: cross-agent から委譲される Claude 固有のアダプター。review_session_id をコンテキストファイルにマッピングし、Claude subagent 機能で独立した Claude エージェントにレビューを依頼してセッションを継続する。通常はユーザーが直接呼ばず、cross-agent オーケストレーターから呼び出される。
user-invocable: false
---

> **テンプレート段階**: このファイルは骨子です。
> [docs/cross-agent-design.md](../../docs/cross-agent-design.md) の「今後の検討事項」に
> 「claude-adapter のセッション継続の具体的な実装方法」が未確定とある。まずここを設計する。

## 責務

cross-agent から渡される `review_session_id` とコンテキストを受け取り、Claude subagent 機能で
独立した Claude エージェントにレビューを依頼する。Codex と違い CLI セッションを持たないため、
**コンテキストファイルの蓄積でセッション継続を表現する**。

## セッションマッピング

`${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json` の `agents.claude.context_file` を
読み書きする。

- **Round 1**: コンテキストファイルを新規作成し、レビュー依頼。応答を追記
- **Round 2 以降**: 蓄積済みコンテキストファイルを読み込み、追加質問とともに新しい
  Agent 呼び出しへ渡す（Claude subagent は毎回コールドスタートのため、過去のやり取りを
  コンテキストとして明示的に渡し直す必要がある）

> ⚠️ 状態は `${CLAUDE_PLUGIN_DATA}` に書く。`${CLAUDE_PLUGIN_ROOT}` は不可。

## 実装上の論点（要設計）

> TODO: 以下を確定する。
>
> - Agent ツールでどの subagent_type を使うか（`general-purpose` / `Explore` / カスタム）
> - 「独立した視点」を担保するためコンテキストの渡し方をどうするか
>   （現在の会話の結論を引きずらせない工夫）
> - Round をまたいだコンテキスト蓄積フォーマット
> - Codex 版と入出力インターフェースを揃える（cross-agent から見て両者を同じ規約で呼べるように）

## 入出力

入力は codex-adapter と同じ request envelope 規約を使う。

```json
{
  "contract_version": 1,
  "review_session_id": "uuid-xxxx",
  "agent": "claude",
  "round": 1,
  "round_kind": "initial_review",
  "target_root": "...",
  "state_file": "${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json",
  "prompt_file": "...",
  "context_file": "...",
  "target_files": [],
  "focus_question": null,
  "options": {
    "review_depth": "medium",
    "quick_mode": false,
    "timeout_seconds": null
  }
}
```

`options.review_depth` は Claude subagent の `effort` へ adapter 側で翻訳する。

| `review_depth` | Claude `effort` |
|---|---|
| `low` | `medium` |
| `medium` | `high` |
| `high` | `xhigh` |

出力も codex-adapter と同じ response envelope を返す。

```json
{
  "contract_version": 1,
  "review_session_id": "uuid-xxxx",
  "agent": "claude",
  "round": 1,
  "status": "completed",
  "output_file": "...",
  "summary": null,
  "artifacts": [],
  "error": null
}
```

深掘りループ・統合は cross-agent が行う。
