---
name: cross-agent
description: 外部エージェント（Codex、Claude など）を選んでセカンドオピニオン・批判的レビューを依頼するスキル。プランや設計案のレビュー、コードの問題点洗い出し、判断の妥当性確認など、独立した視点が欲しいときに使用する。「セカンドオピニオンが欲しい」「別のAIに聞いてみて」「第三者の目で見て」「クロスでレビューして」「cross-agent して」などの言葉が出たら使用する。
user-invocable: true
---

> **テンプレート段階**: このファイルは骨子です。各 Step の `TODO` を埋めて実装を完成させてください。
> 詳細な実装の参照元は [docs/SKILL.md](../../docs/SKILL.md)（既存 advice スキル）と
> [docs/cross-agent-design.md](../../docs/cross-agent-design.md)。

## 概要

cross-agent は **オーケストレーター**。自分はレビューの中身を生成せず、
コンテキストを組み立てて各エージェント adapter に委譲し、結果を統合して提示する。

セッション初期化、state JSON 作成、artifact 作成、初回 adapter request envelope 作成、
adapter response の state 反映は `scripts/cross-agent.mjs` で行う。

```bash
node scripts/cross-agent.mjs prepare-initial --input "<input.json>"
node scripts/cross-agent.mjs complete-round --input "<input.json>"
```

設計方針（[docs/cross-agent-design.md](../../docs/cross-agent-design.md) より）:

- **拡張性**: 新エージェント追加は `skills/<name>-adapter/SKILL.md` を増やすだけ
- **責務分離**: cross-agent はセッションの中身を知らない。各 adapter が自律的にセッション管理を持つ
- **プログラム的処理**: セッション管理（ID 生成・マッピング・永続化）はコードで行い、Claude の記憶に頼らない

## 使い方

```
/cross-agent                          # 直近プラン・設計案を既定エージェントに送ってレビュー
/cross-agent "特定の質問"             # 質問にフォーカス
/cross-agent path/to/file             # ファイルパスを渡してレビュー
/cross-agent --agent claude ...       # エージェントを明示指定
```

---

## 実行手順

### Step 1: ユーザー入力の解釈

ユーザー指定（`--agent` 等）があればそれを使う。なければ既定エージェントとして `codex` を使う。

利用可能なエージェント Skill:

| エージェント | 委譲先 Skill |
|---|---|
| codex  | `codex-adapter`  |
| claude | `claude-adapter` |

以下を抽出する:

- `initial_agent`: 未指定なら `"codex"`
- `focus_question`: 引用文字列や明示された質問
- `target_files`: パスとして解釈できる引数
- `review_depth`: 既定 `medium`。「軽く」「ざっくり」なら `low`、「深く」「じっくり」なら `high`
- `max_rounds`: 既定 `2`。「1回だけ」「クイックに」なら `1`

`review_depth` は cross-agent の抽象設定であり、各 adapter が agent 固有の実行設定へ翻訳する。

v1では1roundにつき1つのagentを使う。複数エージェントによる同一roundの比較レビューは、
MCP state serverや統合ポリシーを設計する段階で改めて扱う。フォローアップで別agentに
追加相談する場合は、そのroundの `agent` に記録する。

対象や質問がまったく特定できない場合、adapterを呼ぶ前に通常会話でユーザーに確認する。
v1では `needs_user_input` stateは使わない。

### Step 2: target_root の決定

`target_root` はレビューセッション全体の作業rootとして cross-agent が決める。
エージェント固有の実行方法や制約はここでは扱わない。

優先順:

1. `target_files` がある場合、そのファイル群に共通するgit root
2. git rootが取れない場合、project markerを親方向に探索
3. markerもない場合、指定ファイルの親ディレクトリ
4. `target_files` がない場合、Claude Codeの現在のcwd

複数の候補rootが出て自動決定できない場合はユーザーへ確認する。

### Step 3: review_session_id の生成・管理

cross-agent 側で `review_session_id`（UUID 等）を生成する。中身は各エージェントに渡すだけで管理しない。
実装では `scripts/cross-agent.mjs prepare-initial` が `review_session_id`、state file、
artifact directory、初回 prompt、adapter request envelope をまとめて作る。

**永続化場所**: `${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>.json`

> ⚠️ **`${CLAUDE_PLUGIN_ROOT}` には状態を書かないこと。** プラグイン更新時に
> ディレクトリが変わる ephemeral な場所であり、marketplace 経由ではキャッシュへ
> read-only でコピーされる。状態の永続化は必ず `${CLAUDE_PLUGIN_DATA}` を使う。

セッションデータ構造（[docs/cross-agent-design.md](../../docs/cross-agent-design.md) より）:

```json
{
  "schema_version": 1,
  "review_session_id": "uuid-xxxx",
  "created_at": "...",
  "updated_at": "...",
  "status": "active",
  "current_round": 1,
  "options": {},
  "context": {},
  "agents": {
    "codex": { "thread_id": "..." },
    "claude": { "context_file": "..." }
  },
  "rounds": [
    {
      "round": 1,
      "kind": "initial_review",
      "agent": "codex",
      "prompt_file": "...",
      "agent_result": null
    }
  ],
  "artifacts": { "files": [] },
  "errors": []
}
```

state ownership:

- `cross-agent`: session root / options / context / rounds / 全体 status
- `codex-adapter`: `agents.codex`
- `claude-adapter`: `agents.claude`
- `artifacts` / `errors`: 作成者・発生元が append する共有領域

### Step 4: コンテキスト・プロンプトの組み立て

[docs/SKILL.md](../../docs/SKILL.md) の Step 2-3 を転用する。

- 会話内容（プラン・要約）を一時ファイルに書き出す
- フォーカス質問・レビュー対象ファイルを整理する
- レビュー観点（リスク・代替案・妥当性・実装注意点）を含むプロンプトを組む

artifact directory:

```text
${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/
```

作成するファイル:

- `context.md`: 会話や設計案の要約。ファイル指定だけで十分な場合は省略可
- `round-1-prompt.md`: Round 1で選んだagentに渡す初回レビュー依頼

定型の初回プロンプトファイル作成は `scripts/cross-agent.mjs prepare-initial` に任せる。
ユーザー入力の解釈や会話要約の作成は Skill 側で行い、runner には構造化済み input として渡す。

### Step 5: エージェント Skill への委譲（Round 1）

Round 1に記録したagentの Skill を `review_session_id` とコンテキストパスを渡して呼び出す。
セッション管理・CLI コマンド・効率設定などエージェント固有の処理は adapter に任せる。

委譲時は依頼本文に request envelope を含める。

```json
{
  "contract_version": 1,
  "review_session_id": "uuid-xxxx",
  "agent": "codex",
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
    "timeout_seconds": null
  }
}
```

adapter は response envelope を返す。cross-agent はこれを `rounds[].agent_result` に
記録する。

```json
{
  "contract_version": 1,
  "review_session_id": "uuid-xxxx",
  "agent": "codex",
  "round": 1,
  "status": "completed",
  "output_file": "...",
  "artifacts": [],
  "error": null
}
```

adapter response を受け取ったら `scripts/cross-agent.mjs complete-round` で state に反映する。

### Step 6: 自動深掘りループ（既定 2 往復）

[docs/SKILL.md](../../docs/SKILL.md) の Step 5 を転用する。

Round 1 の出力を読み、以下 3 観点を 1 つの追加プロンプトに混ぜて Round 2 を投げる:

1. **深掘り** — 具体性に欠ける指摘をコード例で詰める
2. **反論・批判的検証** — 妥当性の怪しい指摘を問い直す
3. **見落とし確認** — R1 で触れられていない観点を 1〜2 個追加

`max_rounds <= 1` の場合はスキップ。
Round 2はRound 1と同じagentで実行する。

### Step 7: 結果の統合・提示

[docs/SKILL.md](../../docs/SKILL.md) の Step 6 を転用する。

1. **結論サマリ**（3〜5 行）
2. **重要な指摘**（優先度順）
3. **判断保留・要相談の項目**

提示後はフォローアップ可能なため、sessionは `active` のまま維持する。
ユーザーが終了を示した時点で `completed` にする。

### Step 8: フォローアップ

ユーザーが追加質問をした場合、既存の `review_session_id` を継続して
`kind: "follow_up"` のroundを追加する。
agent指定があればそのagentをroundに記録し、未指定なら直前roundと同じagentを使う。

### Step 9: 終了とcleanup

ユーザーが「OK」「ありがとう」「終了」など終了を示したら、`session.status` を
`completed` にする。

- `temporary: true` のartifactは削除してよい
- `temporary: false` のartifactは残す
- `keep_artifacts: true` の場合はtemporary artifactも残す

ユーザーが明示的に中断した場合は `abandoned`、復旧不能なエラーで処理を終える場合は
`failed` とする。
