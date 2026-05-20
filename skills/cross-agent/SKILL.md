---
name: cross-agent
description: 複数の外部エージェント（Codex、Claude Subagent など）に横断的にセカンドオピニオン・批判的レビューを依頼するスキル。プランや設計案のレビュー、コードの問題点洗い出し、判断の妥当性確認など、独立した視点が欲しいときに使用する。「セカンドオピニオンが欲しい」「別のAIに聞いてみて」「第三者の目で見て」「クロスでレビューして」「cross-agent して」などの言葉が出たら使用する。
user-invocable: true
---

> **テンプレート段階**: このファイルは骨子です。各 Step の `TODO` を埋めて実装を完成させてください。
> 詳細な実装の参照元は [docs/SKILL.md](../../docs/SKILL.md)（既存 advice スキル）と
> [docs/cross-agent-design.md](../../docs/cross-agent-design.md)。

## 概要

cross-agent は **オーケストレーター**。自分はレビューの中身を生成せず、
コンテキストを組み立てて各エージェント Skill に委譲し、結果を統合して提示する。

設計方針（[docs/cross-agent-design.md](../../docs/cross-agent-design.md) より）:

- **拡張性**: 新エージェント追加は `skills/<name>-subagent/SKILL.md` を増やすだけ
- **責務分離**: cross-agent はセッションの中身を知らない。各エージェント Skill が自律的にセッション管理を持つ
- **プログラム的処理**: セッション管理（ID 生成・マッピング・永続化）はコードで行い、Claude の記憶に頼らない

## 使い方

```
/cross-agent                          # 直近プラン・設計案を既定エージェントに送ってレビュー
/cross-agent "特定の質問"             # 質問にフォーカス
/cross-agent path/to/file             # ファイルパスを渡してレビュー
/cross-agent --agent codex,claude ... # エージェントを明示指定
```

---

## 実行手順

### Step 1: エージェントの選択

ユーザー指定（`--agent` 等）があればそれを使う。なければ既定エージェント（TODO: 既定を決める。例 `codex`）を使う。

利用可能なエージェント Skill:

| エージェント | 委譲先 Skill |
|---|---|
| codex  | `codex-subagent`  |
| claude | `claude-subagent` |

> TODO: 複数エージェント指定時の扱いを決める。現時点の設計は直列フロー（将来的に並列対応）。

### Step 2: skill_session_id の生成・管理

cross-agent 側で `skill_session_id`（UUID 等）を生成する。中身は各エージェントに渡すだけで管理しない。

**永続化場所**: `${CLAUDE_PLUGIN_DATA}/sessions/<skill_session_id>.json`

> ⚠️ **`${CLAUDE_PLUGIN_ROOT}` には状態を書かないこと。** プラグイン更新時に
> ディレクトリが変わる ephemeral な場所であり、marketplace 経由ではキャッシュへ
> read-only でコピーされる。状態の永続化は必ず `${CLAUDE_PLUGIN_DATA}` を使う。

セッションデータ構造（[docs/cross-agent-design.md](../../docs/cross-agent-design.md) より）:

```json
{
  "skill_session_id": "uuid-xxxx",
  "created_at": "...",
  "agents": {
    "codex": { "thread_id": "..." },
    "claude": { "context_file": "..." }
  }
}
```

> TODO: 各エージェント Skill が自分のセッション情報をこの JSON に読み書きする
> 規約を確定する（cross-agent が書くのか、各 subagent が書くのか）。

### Step 3: コンテキスト・プロンプトの組み立て

[docs/SKILL.md](../../docs/SKILL.md) の Step 2-3 を転用する。

- 会話内容（プラン・要約）を一時ファイルに書き出す
- フォーカス質問・レビュー対象ファイルを整理する
- レビュー観点（リスク・代替案・妥当性・実装注意点）を含むプロンプトを組む

> TODO: advice スキルからコンテキスト書き出しとプロンプト組み立てを移植。

### Step 4: 各エージェント Skill への委譲（Round 1）

選択した各エージェントの Skill を `skill_session_id` とコンテキストパスを渡して呼び出す。
セッション管理・CLI コマンド・効率設定などエージェント固有の処理は委譲先に任せる。

> TODO: Skill ツールでの呼び出し規約（引数の渡し方）を確定する。

### Step 5: 自動深掘りループ（既定 2 往復）

[docs/SKILL.md](../../docs/SKILL.md) の Step 5 を転用する。

Round 1 の各エージェント出力を読み、以下 3 観点を 1 つの追加プロンプトに混ぜて Round 2 を投げる:

1. **深掘り** — 具体性に欠ける指摘をコード例で詰める
2. **反論・批判的検証** — 妥当性の怪しい指摘を問い直す
3. **見落とし確認** — R1 で触れられていない観点を 1〜2 個追加

「1回だけ」「クイックに」と指定された場合はスキップ。

### Step 6: 結果の統合・提示

[docs/SKILL.md](../../docs/SKILL.md) の Step 6 を転用する。複数エージェントの場合は
各エージェントの見解を対比して提示する。

1. **結論サマリ**（3〜5 行）
2. **重要な指摘**（優先度順、必要に応じてエージェント間の異同を示す）
3. **判断保留・要相談の項目**（エージェント間で見解が割れた点）

提示後「フォローアップ質問はありますか？」と確認。終了時は一時ファイルを片付ける。
