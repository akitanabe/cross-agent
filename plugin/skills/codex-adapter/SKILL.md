---
name: codex-adapter
description: agent-review から委譲される Codex CLI 固有のアダプター。review_session_id を Codex の thread_id にマッピングしてセッションを継続し、Codex exec 専用 run spec に従ってレビューを実行する。通常はユーザーが直接呼ばず、agent-review オーケストレーターから呼び出される。
user-invocable: false
allowed-tools: Read Write Bash(node "**/codex-adapter-runner.mjs" prepare **) Bash(node "**/codex-adapter-runner.mjs" complete **) Bash(codex --ask-for-approval never exec **)
---

## 役割

codex-adapter は Codex CLI 実行境界を担当する。agent-review から request envelope file path を受け取り、
runner の `prepare` で Codex exec 専用 run spec を作成し、codex-agent が `codex exec` /
`codex exec resume` を Bash から直接実行する。実行後は runner の `complete` で Codex 固有 state と
response envelope を確定する。

runner は Codex CLI を起動しない。codex-agent も任意 command は実行せず、`codex-run.json` に書かれた
Codex exec 専用 spec を検証したうえで、許可された `codex exec` / `codex exec resume` だけを実行する。

## 入力

依頼本文には、adapter request envelope JSON の file path が含まれる。

```text
request_envelope_file: .../artifacts/<review_session_id>/round-<N>-<agent_id>-adapter-request.json
```

## 実行

`--data-dir` は必須。plugin 文脈では `${CLAUDE_PLUGIN_DATA}` をそのまま渡す。

### 1. prepare

request envelope file path を `--request` で渡して runner の `prepare` を実行する。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-adapter-runner.mjs" prepare \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --request "<request-envelope.json>"
```

`prepare` は stdout に file path だけを返す。

- `round-<N>-<agent_id>-run.json` が返った場合: Codex CLI 実行へ進む

`prepare` が失敗した場合、runner は可能な範囲で failed response envelope を保存したうえでエラー終了する。
codex-agent は runner / Bash tool のエラーとして扱い、Codex CLI 実行や `complete` へ進まない。
stdout に説明文、Markdown、複数行ログ、response envelope file path が混ざった場合も失敗扱いにする。

### 2. run spec 検証

`round-<N>-<agent_id>-run.json` を読み、次を確認する。

- `schema_version` は `1`
- `kind` は `"codex_exec"`
- `mode` は `"initial"` または `"resume"`
- `review_session_id`, `agent_id`, `adapter`, `round`, `target_root`, `prompt_file`, `output_file`, `event_log`, `exit_file` が存在する
- `adapter` は `"codex"`
- `mode == "resume"` の場合は `thread_id` が非空
- `model_reasoning_effort` は `medium`, `high`, `xhigh` のいずれか
- `skip_git_repo_check` は `true`
- `ask_for_approval` は `"never"`

run spec が不正な場合は Codex CLI を実行しない。runner の `complete` で `codex_run_spec_invalid` として
response envelope を確定できる場合は `complete` を呼び、確定できない場合は推測で続行しない。

### 3. Codex CLI 実行

prompt 本文は argv ではなく stdin で渡す。Codex CLI の `PROMPT` に `-` を指定し、
`prompt_file` を stdin redirect する。stdout/stderr は `event_log` にまとめて保存する。

initial:

```bash
codex --ask-for-approval never exec \
  -C "<target_root>" \
  --json \
  --skip-git-repo-check \
  -c "model_reasoning_effort=<model_reasoning_effort>" \
  -o "<output_file>" \
  - \
  < "<prompt_file>" \
  > "<event_log>" \
  2>&1
```

resume:

```bash
codex --ask-for-approval never exec resume \
  --json \
  --skip-git-repo-check \
  -c "model_reasoning_effort=<model_reasoning_effort>" \
  -o "<output_file>" \
  "<thread_id>" \
  - \
  < "<prompt_file>" \
  > "<event_log>" \
  2>&1
```

実行後、Bash tool が返した終了コードを `exit_file` に JSON で保存する。

```json
{
  "code": 0
}
```

Codex CLI が非 0 終了しても、そこで中断しない。必ず `exit_file` を保存し、`complete` を呼ぶ。

### 4. complete

Codex CLI 実行後、runner の `complete` を呼ぶ。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-adapter-runner.mjs" complete \
  --data-dir "${CLAUDE_PLUGIN_DATA}" \
  --run "<round-N-agent-id-run.json>"
```

`complete` は stdout に `round-<N>-<agent_id>-response.json` の file path だけを返す。
その path は親 agent へ渡す値として扱わない。親 agent は session state から response envelope
file path を導出するため、codex-agent は完了シグナルだけを最終回答にする。

## 守ること

- Codex の出力統合や要約は行わず、完了シグナルだけを返す
- `codex-run.json` に無い任意 command / 任意 argv を実行しない
- `prompt_file` の本文を argv に詰めず、必ず stdin で渡す
- `codex exec` が失敗しても、`codex-exit.json` を保存してから `complete` を呼ぶ
- 最終回答に Codex output の要約、補足説明、Markdown の前置きを混ぜない

## 実装メモ

- 開発 repo の実装本体: `src/runners/codex-adapter-runner.ts`
- 配布 runner: `scripts/codex-adapter-runner.mjs`
- 仕様: https://github.com/akitanabe/cross-agent/blob/main/docs/codex-adapter-spec.md
- 開発 repo のテスト: `test/runners/codex-adapter-runner.test.ts`, `test/core/codex-adapter/*.test.ts`
- Node.js: 24+

詳細な入出力契約、state 更新範囲、artifact、エラーコード、Codex CLI の分岐条件は
https://github.com/akitanabe/cross-agent/blob/main/docs/codex-adapter-spec.md を正とする。

開発 repo で runner を変更したら、少なくとも以下を実行する。

```bash
npm run check
npm test
claude plugin validate plugin
```
