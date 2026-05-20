---
name: advice
description: OpenAI Codex CLI を使ってセカンドオピニオン・第二の意見を取得するスキル。現在の会話で立てたプランや設計案のレビュー、コードの問題点洗い出し、判断の妥当性確認など、独立した視点が欲しいときに積極的に使用してください。「Codexに確認して」「セカンドオピニオンが欲しい」「別のAIに聞いてみて」「Codexにレビューしてもらって」「第二の意見」「第三者の目で見て」「adviceして」などの言葉が出たら使用してください。
user-invocable: true
---

## 概要

Codex CLI（`codex exec`）を使ってセカンドオピニオンを取得します。Codexはワーキングディレクトリのファイルシステムに直接アクセスできるため、すべての情報はファイルパスで渡します。会話内容も一時ファイルに書き出してパスを渡すことで一貫した方式にします。

**セッション方式**: Round 1 は `codex exec -C <target-root> --json` で新規セッションを開始し、JSONL ストリームの `thread.started` イベントから `thread_id` を抽出して session id とする。Round 2 以降・フォローアップは `codex exec resume <session-id>` で同じセッションに投げる。Codex 側が文脈を保持するため、追加質問は毎回それだけを送れば済む（プロンプトの積み上げ不要）。session id は Claude が会話中に記憶しておくだけでよく、ファイルには保存しない。

**`-C <target-root>` が重要**: Codex CLI はセッション作成時の cwd を「セッションの作業ルート」として固定する（`codex exec resume` には `-C/--cd` も `--add-dir` もない）。レビュー対象 repo の root を Round 1 で正しく指定しないと、sandbox の writable_roots / git 操作 / 関連ファイル探索が全部ズレる。

## 使い方

```
/advice                           # 直近プラン・設計案をCodexに送ってレビュー
/advice "特定の質問"              # 質問にフォーカスしてレビュー
/advice path/to/file.php          # ファイルパスをCodexに渡してレビュー
/advice "質問" path/to/file       # 質問 + ファイルの両方
```

既定の reasoning effort は **high**（1〜3分の精密モード）。より深い検討が必要なときは「xhigh で」「最高精度で」「じっくり考えて」などと指定すると `xhigh` に上がり、逆に「サクッと」「ざっくり」と言えば `medium` に下がります。

**既定で 2 往復の自動深掘りループを実行します。** 1往復目で Codex のレビューを受け取り、Claude がその出力を読んで深掘り・反論・見落とし確認を組み立て、2往復目で再投入します。最終的に統合した形で提示します。1回だけで済ませたい場合は「1回だけ」「クイックに」と指定してください。

Codexの回答後、さらにフォローアップ質問があれば続けてやり取りできます。

---

## 実行手順

### Step 1: コンテキストとレビュー対象 root を特定する

#### 1-a. レビューコンテキスト

以下の優先順でコンテキストを決める：

1. **プラン・設計案**: 会話中で直近に作成したプランや設計判断があればその全体
2. **会話の要約**: 現在取り組んでいる問題と議論の流れ（プランが明示されていない場合）
3. **ユーザー指定ファイル**: パスが指定されていればそのパスをそのまま使う（Claudeは読まない）
4. **フォーカス質問**: ユーザーが指定した場合はそれを盛り込む

①〜④のいずれも特定できない場合（「セカンドオピニオンが欲しい」とだけ言われた等）は、Codex を呼ぶ前にユーザーへ確認する：

> 「何についてセカンドオピニオンを取りたいですか？設計プラン・コード・問題文などを教えてください。」

#### 1-b. レビュー対象 root（`-C` で渡す cwd）

Round 1 開始前に **target-root を必ず1つ確定させる**。session 作成後は変更できない。決め方は優先順に：

1. **指定ファイルがある場合**: そのファイルの親ディレクトリから `git rev-parse --show-toplevel` で git root を取る
2. **git でない場合**: `package.json` / `composer.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` / `pnpm-workspace.yaml` などのプロジェクト marker を親方向に探す
3. **marker も無い場合**: 指定ファイルの親ディレクトリ
4. **指定ファイルが無い場合**: 会話中で明確に active な repo（直近編集していたパス、進行中のプランが対象としている repo）を採用
5. **どれも該当しない（純粋な設計議論など）**: Claude Code の現在の cwd をそのまま使う

複数 repo にまたがるレビューが必要な場合は、主対象を `-C` に、副対象を `--add-dir <other-root>` で Round 1 開始時に追加する（`--add-dir` も `codex exec resume` では効かないので、Round 1 で確定する必要あり）。

### Step 2: 会話コンテキストをファイルに書き出す

会話内容（プランや要約）がある場合、Write ツールで `C:\Windows\Temp\advice_context.md` に書き出す。ユーザー指定のファイルのみの場合はこのステップは不要。

```markdown
# レビューコンテキスト

## 取り組んでいる問題・背景
{問題の説明}

## レビュー対象のプラン・設計案
{プランや設計案の全文}
```

### Step 3: Codex へのプロンプトを組み立てる

すべてファイルパスで参照する形でプロンプトを組み立てる（日本語で書く）：

```
あなたは独立したシニアエンジニアです。以下のファイルを読んで、批判的・建設的な視点で
セカンドオピニオンを提供してください。

【フォーカス質問】（指定がある場合のみ）
{ユーザーの質問}

【コンテキストファイル】（会話内容がある場合）
C:\Windows\Temp\advice_context.md

【レビュー対象ファイル】（ユーザーがパスを指定した場合）
{指定されたファイルパス}
（必要に応じて関連ファイルも自由に参照してください）

【レビュー観点】
- 見落としているリスクや問題点はないか
- より良いアプローチや代替案があるか
- 全体的な設計・判断の妥当性
- 実装上の注意点
```

### Step 4: Codex CLI を実行する（Round 1）

Round 1 は **新規セッション作成**。`codex exec -C <target-root> --json` で実行する。`--json` を付けることで stdout が JSONL イベントストリームになり、その先頭の `thread.started` イベントから session id を構造化抽出できる。

プロンプトは Bash の single-quoted heredoc (`<<'EOF' ... EOF`) で引数として直接渡す。`-o` で最終メッセージだけ別ファイルに、stdout 全体を JSONL ログとして別ファイルにリダイレクトする。`< /dev/null` で stdin を閉じるのも忘れない（codex は引数でプロンプトを受けても stdin pipe があれば追記読みするため、PowerShell など stdin が閉じない環境では無限待機する）。

セカンドオピニオン用途は「精度・深さ重視」なので、reasoning effort は **常に high** を指定する。`-c model_reasoning_effort="high"` を必ず付ける：

```bash
codex exec -C "<target-root>" --json --skip-git-repo-check \
  -c model_reasoning_effort="high" \
  -o "C:\Windows\Temp\advice_output.txt" \
  "$(cat <<'PROMPT_EOF'
{Step 3 で組み立てたプロンプト本文}
PROMPT_EOF
)" < /dev/null > "C:\Windows\Temp\advice_events.jsonl" 2>&1

# session id を JSONL から構造化抽出（人間向けヘッダーではなく機械可読イベントに依存）
SID=$(grep '"type":"thread.started"' "C:\Windows\Temp\advice_events.jsonl" | sed 's/.*"thread_id":"\([^"]*\)".*/\1/')
```

抽出した `$SID` を Claude が記憶しておき、Round 2 以降の `codex exec resume <SID>` で使う。`advice_events.jsonl` は session id 抽出後はもう不要なので削除しても良い（フォローアップで再抽出が必要になることはない）。

heredoc の終了タグ `PROMPT_EOF` は **行頭（インデントなし）** に置く必要がある（bash の構文上の制約）。タグを single-quoted (`<<'PROMPT_EOF'`) にすることで `$`・バッククォート・`\` のシェル展開が抑止されるので、コード片や変数表記を含むプロンプトも安全に渡せる。

**effort のレベル使い分け（既定: high）:**

| レベル | 使い所 | 体感時間 |
|--------|--------|----------|
| `medium` | 通常の `codex exec` の既定値。本スキルでは原則使わない | 〜30秒 |
| `high` | **本スキルの既定。** 設計レビュー・コードレビュー・判断の妥当性確認 | 1〜3分 |
| `xhigh` | アーキテクチャ全体の方針判断・難しいバグ・本質的に深い検討が必要なとき | 3〜8分 |

ユーザーが「もっとじっくり / 最高精度で / xhigh で」と明示した場合は `xhigh` に上げる。また、**Claude（あなた）自身が「これは非常に難しい / 一筋縄ではいかない / 自分でも判断に迷う / 影響範囲が広く慎重な検討が要る」と感じた場合も自発的に `xhigh` に上げてよい**（その際は「難しい問題と判断したので xhigh で投げます」と一言ユーザーに伝える）。逆に「サクッと / ざっくり」と言われたら `medium` に下げてもよい。

実行前にユーザーへ伝える文言は effort に合わせて調整する：
- `high`（既定）: 「Codex に送ります（reasoning=high、1〜3分かかります）」
- `xhigh`: 「Codex に送ります（reasoning=xhigh、深く考えるため3〜8分かかります）」
- `medium`: 「Codex に送ります（reasoning=medium、30秒程度）」

### Step 5: 自動深掘りループ Round 2（既定で実行）

Round 1 の出力（`C:\Windows\Temp\advice_output.txt`）を Claude が読み込み、**ユーザーに見せる前に Codex と1往復追加で深掘り・議論する**。これによりセカンドオピニオンの精度を体系的に高める。

**Round 2 を実施する判断:**

以下のいずれかに該当する場合は Round 2 を **スキップ** して Step 6 へ進む：
- ユーザーが「1回だけ」「クイックに」「ざっくり」と明示している
- Round 1 の出力が非常に短い（目安: 30行未満）かつ「特に問題なし」と結論されている
- ユーザーが提示した質問が単純なYes/No確認で、Round 1 で十分明確に回答されている

それ以外は Round 2 を実施する。

**Round 2 の追加質問を組み立てる:**

Round 1 の出力を読み、以下の3観点を **混ぜて1つの追加プロンプト** にする（個別に投げず1ラウンドで完結させて時間を節約）：

1. **深掘り** — 「重要そうだが具体性に欠ける指摘」を「具体的にどういうケース？該当箇所をコード例で示せ」と詰める
2. **反論・批判的検証** — 「妥当性が怪しい / 根拠が弱い / 言い過ぎに見える指摘」について「本当にそうか？反対の見方や例外はないか？」と問い直す
3. **見落とし確認** — Round 1 で触れられていない観点（パフォーマンス・セキュリティ・既存コードとの整合性・テスト容易性など、コンテキストから重要そうなものを1〜2個）を追加で問う

**Codex 側がセッションで前回までの文脈を保持しているため、追加質問だけを書けばよい。** Round 1 の出力やコンテキストの再掲は不要。

ユーザーに「Round 2 を実施します（深掘り・反論・見落とし確認）」と一言伝えてから、Round 1 で取得した session id にぶら下げて再実行する。プロンプトは heredoc で直接渡す：

```bash
codex exec resume --skip-git-repo-check -c model_reasoning_effort="high" -o "C:\Windows\Temp\advice_output.txt" <SID> "$(cat <<'PROMPT_EOF'
前回の回答について追加で確認したい点があります。

## 深掘り
{具体例を求める質問}

## 反論・批判的検証
{「本当にそうか？」と問い直す内容}

## 見落とし確認
{R1で触れられていない観点}
PROMPT_EOF
)" < /dev/null
```

**Round 3 以降:**

Round 2 でも重要な未解決点が残っており、かつユーザーが時間的余裕を示唆している場合は、Claude の判断で最大 Round 3 まで自動で続けてよい。それ以上はユーザーに「さらに往復しますか？」と確認すること。

### Step 6: 結果を提示する

すべての Round が完了したら、**統合した形** でユーザーに提示する：

1. **結論サマリ**（3〜5行）— セカンドオピニオンの本質的な結論。Codex が指摘した重要点と、Claude の深掘り・反論で得られた補強や見直し
2. **重要な指摘**（優先度順）— 各指摘について、必要に応じて Round の流れ（例: 「R1で指摘 → R2でClaudeが反論 → R2でCodexが再回答」）を簡潔に示す
3. **判断保留・要相談の項目** — Codex と Claude で見解が割れた点、追加情報が必要な点

Round 2 以降を実施した場合は冒頭で「N 往復のやり取りを統合した結果です」と明示する。

提示後、必ず「フォローアップ質問はありますか？」と確認する。フォローアップがある場合は session id を使い続けるため、一時ファイルもそのまま残しておく（次の往復で上書きされる）。

ユーザーが「OK」「ありがとう」「終了」など対話終了を示した時点で、一時ファイルをまとめて削除する。session id は Claude のメモリから捨てるだけでよい：

```bash
rm -f "C:\Windows\Temp\advice_output.txt" "C:\Windows\Temp\advice_context.md" "C:\Windows\Temp\advice_events.jsonl"
```

---

## フォローアップ（複数回やり取り）

ユーザーが続けて質問・確認したい場合、Round 1 で取得した **同じ session id にぶら下げて投げる** だけ。Codex 側がセッション内の文脈を保持するため、プロンプトには今回の追加質問だけを書けばよい（過去のやり取りの再掲は不要）。

Round 2 と同じく heredoc で追加質問を直接渡す：

```bash
codex exec resume --skip-git-repo-check -c model_reasoning_effort="high" -o "C:\Windows\Temp\advice_output.txt" <SID> "$(cat <<'PROMPT_EOF'
{追加の質問内容}
PROMPT_EOF
)" < /dev/null
```

effort はその往復で適切なレベルを選び直してよい（追加の小さな確認なら `medium` に下げる、より深い議論が必要なら `xhigh` に上げる）。

### フォローアップで対象 repo が増えた場合

`codex exec resume` には `-C/--cd` も `--add-dir` もないため、session 作成後に作業 root を増やすことはできない。対応は 3 段階：

1. **軽い read-only 確認なら、絶対パスで追加 repo を渡す** — 「このファイルも読んで整合性を見て」程度なら実用上 OK。ただし git 操作・テスト・関連ファイル探索・書き込みは期待しない。
2. **git/test/edit/関連探索が必要なら、新 session を作る** — Claude 側で前 session の要約を作り、新しい Round 1（`-C <新root>`）に渡す。完全な文脈継承ではないがレビュー用途では十分。
3. **最初から複数 repo が見えていれば、Round 1 作成時に `--add-dir`** — Step 1-b 参照。

### セッションが切れた場合のフォールバック

何らかの理由で `codex exec resume <SID>` が失敗した場合（session id を取り違えた、Codex 側が古いセッションを破棄した等）は、Step 1-b の target-root 解決から Round 1 をやり直す。Codex は前のやり取りを覚えていないので、新しいセッションの Round 1 では `advice_context.md` をもう一度コンテキストとして渡し直す必要がある。

### 終了

ユーザーが「OK」「ありがとう」「終了」など対話終了の意思を示したら、Step 6 の後始末コマンドで一時ファイルを削除し、session id は Claude のメモリから捨てる。

---

## バージョン依存注記

この手順は **`@openai/codex 0.130.0`** で確認した挙動に基づく。具体的には：
- `codex exec resume` に `-C/--cd` および `--add-dir` が無いため、レビュー対象 root は session 作成時（Round 1）に確定する必要がある
- `--json` の最初のイベントは `{"type":"thread.started","thread_id":"<uuid>"}` 形式

Codex CLI 更新後は `codex exec --help` と `codex exec resume --help` を確認し、`resume` 側に root 変更オプションが追加されていれば手順を見直す（例: フォローアップで `--add-dir` を後付けできるようになれば Step 1-b の制約が緩む）。

---

**Codex が懸念点を指摘した場合は**、それに対してどう対応するか（受け入れる・却下する・修正する）をユーザーに確認する。