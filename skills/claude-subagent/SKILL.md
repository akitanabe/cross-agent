---
name: claude-subagent
description: cross-agent から委譲される Claude Subagent 固有のサブスキル。review_session_id をコンテキストファイルにマッピングし、Agent ツールで独立した Claude エージェントにレビューを依頼してセッションを継続する。通常はユーザーが直接呼ばず、cross-agent オーケストレーターから呼び出される。
user-invocable: false
---

> **テンプレート段階**: このファイルは骨子です。
> [docs/cross-agent-design.md](../../docs/cross-agent-design.md) の「今後の検討事項」に
> 「claude-subagent のセッション継続の具体的な実装方法」が未確定とある。まずここを設計する。

## 責務

cross-agent から渡される `review_session_id` とコンテキストを受け取り、独立した Claude
エージェント（Agent ツール）にレビューを依頼する。Codex と違い CLI セッションを持たないため、
**コンテキストファイルの蓄積でセッション継続を表現する**。

## セッションマッピング

`${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json` の `agents.claude.context_file` を
読み書きする。

- **Round 1**: コンテキストファイルを新規作成し、レビュー依頼。応答を追記
- **Round 2 以降**: 蓄積済みコンテキストファイルを読み込み、追加質問とともに新しい
  Agent 呼び出しへ渡す（Claude Subagent は毎回コールドスタートのため、過去のやり取りを
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

入力は codex-subagent と同じ規約（`review_session_id` / コンテキストパス / Round）。
出力もレビュー本文を返すだけ。深掘りループ・統合は cross-agent が行う。
