# cross-agent スキル 設計骨子

## 概要

複数の外部エージェント（Codex、Claude Subagentなど）に横断的に質問・レビューを依頼するスキル。
セカンドオピニオン・批判的レビュー・設計判断の妥当性確認などに使用する。

## 設計方針

- **拡張性重視**: 新しいエージェントを追加する際は、そのエージェント用Skillを追加するだけでよい
- **責務分離**: cross-agent自体はセッションの中身を知らない。各エージェントSkillが自律的にセッション管理を持つ
- **プログラム的処理**: セッション管理（ID生成・マッピング・永続化）はコードで行い、Claudeの記憶に頼らない

## ファイル構成（予定）

```
cross-agent/
├── SKILL.md               # メインスキル（エージェント選択・セッションID生成・深掘りループ・結果統合）
├── session.json           # skill_session_id → エージェント別セッション情報のマッピング
├── codex-subagent/
│   └── SKILL.md           # Codex固有の実装（thread_id管理・codex execコマンド）
└── claude-subagent/
    └── SKILL.md           # Claude Subagent固有の実装（コンテキストファイルベースのセッション管理）
```

## セッション管理の仕組み

### skill_session_id

- cross-agent側が生成（UUID等）
- 各エージェントに渡すだけで、中身は管理しない

### セッションデータ構造（session.json）

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

### 各エージェントの責務

| エージェント | セッション継続の仕組み |
|---|---|
| codex-subagent | skill_session_id → thread_id のマッピングを自前管理 |
| claude-subagent | skill_session_id → コンテキストファイルのマッピングを自前管理 |

## cross-agent SKILL.md の責務

1. エージェントの選択（ユーザー指定 or 既定）
2. skill_session_idの生成・管理
3. コンテキスト・プロンプトの組み立て（既存adviceスキルから転用）
4. 各エージェントSkillへの委譲
5. 自動深掘りループ（既定2往復）
6. 結果の統合・提示

## 既存 advice スキルからの移行

### 捨てる部分
- session id管理（thread_id抽出、resume）※ codex-subagent側に移動
- `-C <target-root>` の複雑な解決ロジック ※ codex-subagent側に移動
- `--json` フラグ、JSONLパース ※ codex-subagent側に移動
- セッション切れ時のフォールバック ※ codex-subagent側に移動
- バージョン依存注記 ※ codex-subagent側に移動

### 転用する部分
- コンテキストのファイル書き出し（Step 2）
- プロンプトの組み立て方（Step 3）
- 自動深掘りループの考え方（Step 5）
- 結果の統合・提示フォーマット（Step 6）

## 今後の検討事項

- claude-subagentのセッション継続の具体的な実装方法
- 複数エージェントへの並列投げ（現時点は直列フロー、将来的に対応予定）
- session.jsonの保存場所・ライフサイクル管理
