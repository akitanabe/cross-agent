---
name: claude-adapter
description: cross-agent から委譲される Claude 固有のアダプター。request envelope file path を受け取り、Claude subagent でレビュー本文を生成し、Claude 固有 state と response envelope を確定する。通常はユーザーが直接呼ばず、cross-agent オーケストレーターから呼び出される。
user-invocable: false
allowed-tools: Read Write Bash(node "**/claude-adapter-runner.mjs" prepare **) Bash(node "**/claude-adapter-runner.mjs" complete **)
---

## 役割

claude-adapter は Claude subagent 実行境界を担当する。cross-agent から request envelope file path を受け取り、
runner の `prepare` で Claude agent が読む実行 input と蓄積 context を準備し、Claude agent がレビュー本文を
`round-<N>-claude-output.md` に保存する。実行後は runner の `complete` で Claude 固有 state と
response envelope を確定する。

Codex と異なり、Claude subagent は adapter 側で永続的な CLI session や thread を直接 resume しない。
`review_session_id` から Claude 用の蓄積 context file を導出し、毎 round の input から過去 round の
prompt / output を明示的に読ませることでセッション継続を表現する。

## 入力

依頼本文には、adapter request envelope JSON の file path が含まれる。

```text
request_envelope_file: .../artifacts/<review_session_id>/round-<N>-adapter-request.json
```

request envelope は次の契約に従う。

```json
{
  "contract_version": 1,
  "review_session_id": "uuid-xxxx",
  "agent": "claude",
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
```

`prompt_file` がその round で Claude に渡す主要入力である。`context_file` と `target_files` は補助情報であり、
cross-agent が作成する `prompt_file` 内に必要な参照情報として含まれている前提で扱う。

## 実行

`--data-dir` は必須。plugin 文脈では `${CLAUDE_PLUGIN_DATA}` をそのまま渡す。

### 1. prepare

request envelope file path を `--request` で渡して runner の `prepare` を実行する。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-adapter-runner.mjs" prepare \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --request "<request-envelope.json>"
```

`prepare` は stdout に file path だけを返す。

- `round-<N>-claude-input.md` が返った場合: Claude レビュー本文の生成へ進む

`prepare` が失敗した場合、runner は可能な範囲で failed response envelope を保存したうえでエラー終了する。
Claude agent は runner / Bash tool のエラーとして扱い、本文生成や `complete` へ進まない。
stdout に説明文、Markdown、複数行ログ、response envelope file path が混ざった場合も失敗扱いにする。

### 2. input と required reading の確認

`round-<N>-claude-input.md` を読み、次を確認する。

- 現在 round の `prompt_file` が記載されている
- Claude 固有の `claude_context_file` が記載されている
- 出力保存先として `round-<N>-claude-output.md` が記載されている

次に `claude_context_file` を読み、`Required Reading` に列挙された全ファイルを回答前に読む。
いずれかのファイルを読めない場合、内容を推測して続行しない。読めない理由を output file にレビュー本文として
書くのではなく、adapter failure として扱えるように runner の `complete` へ進む。

読む優先順位は固定する。

1. 現在 round の `prompt_file`
2. `claude_context_file`
3. 過去 round の `prompt_file` / `output_file`
4. request envelope の構造化情報

親 agent の会話上の推測、未保存の判断、統合前の結論は前提にしない。追加 context が必要な場合は、
cross-agent が `context_file` または `prompt_file` に明示的に保存してから渡す。

### 3. Claude レビュー本文の保存

`round-<N>-claude-input.md` に記載された保存先へ、最終レビュー本文だけを書く。

```text
.../artifacts/<review_session_id>/round-<N>-claude-output.md
```

output 本文には、response envelope file path、runner の stdout、手順説明、親 agent への補足を混ぜない。

### 4. complete

output file の保存後、runner の `complete` を呼ぶ。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/claude-adapter-runner.mjs" complete \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --request "<request-envelope.json>" \
  --output-file "<round-N-claude-output.md>"
```

`complete` は output file を検証し、Claude agent state と response envelope を更新し、stdout に
`round-<N>-claude-response.json` の file path だけを返す。
その path は親 agent へ渡す値として扱わない。親 agent は session state から response envelope file path を導出するため、
Claude agent は完了シグナルだけを最終回答にする。

## Artifact と state

Claude adapter が変更してよい state は、runner が導出する Claude agent state file に限定する。

```text
${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>/agents/claude.json
${CLAUDE_PLUGIN_DATA}/sessions/<review_session_id>/agents/claude-context.md
${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-<N>-claude-input.md
${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-<N>-claude-output.md
${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-<N>-claude-diagnostic.md
${CLAUDE_PLUGIN_DATA}/artifacts/<review_session_id>/round-<N>-claude-response.json
```

cross-agent の top-level session state、`rounds[]`、`current_round`、`status`、`context`、`options` は
Claude adapter から直接変更しない。

response envelope 内の `output_file`、`artifacts[].path`、`error.details_file` などの path は、
forward slash 表記で保存される。Windows path を扱う場合も、adapter 境界では `C:/Users/...` の形を正とする。

## 守ること

- `claude-adapter-runner.mjs` の `prepare` / `complete` 以外の任意 command を実行しない
- `round-<N>-claude-input.md` を正としてレビュー本文を生成する
- `claude_context_file` と Required Reading に列挙された全ファイルを回答前に読む
- Required Reading を読めない場合は、内容を推測してレビューを続けない
- `round-<N>-claude-output.md` にはレビュー本文だけを書く
- response envelope の要約、補足説明、file path を最終回答に混ぜない
- 最終回答は完了シグナルだけにする

成功時の最終回答例:

```text
done
```

## 実装メモ

- 実装本体: `src/runners/claude-adapter-runner.ts`
- 配布 runner: `scripts/claude-adapter-runner.mjs`
- 仕様: `docs/claude-adapter-spec.md`
- Node.js: 24+

詳細な入出力契約、state 更新範囲、artifact、エラーコード、蓄積 context の形式は
[docs/claude-adapter-spec.md](../../docs/claude-adapter-spec.md) を正とする。

runner を変更したら、少なくとも以下を実行する。

```bash
npm run check
npm test
claude plugin validate .
```
