// 初回レビュー用の定型 prompt 本文を組み立てる。
export function buildInitialPrompt({
  focusQuestion,
  contextFile,
  targetFiles = [],
}: {
  focusQuestion?: string | null;
  contextFile?: string | null;
  targetFiles?: string[];
}): string {
  // 会話要約そのものは Skill 側で作り、この関数は定型レビュー依頼だけを組み立てる。
  const sections = [
    "あなたは独立したシニアエンジニアです。以下の情報を読み、批判的・建設的なセカンドオピニオンを提供してください。",
  ];

  if (focusQuestion) {
    sections.push(`## フォーカス質問\n${focusQuestion}`);
  }

  if (contextFile) {
    sections.push(`## コンテキストファイル\n${contextFile}`);
  }

  if (targetFiles.length) {
    sections.push(`## レビュー対象ファイル\n${targetFiles.join("\n")}\n\n必要に応じて関連ファイルも参照してください。`);
  }

  sections.push(`## レビュー観点
- 見落としているリスクや問題点
- より良いアプローチや代替案
- 全体的な設計・判断の妥当性
- 実装上の注意点
- テスト観点`);

  return `${sections.join("\n\n")}\n`;
}

// 追加 round 用の prompt 本文を組み立てる。
export function buildNextRoundPrompt({
  promptText,
  previousOutputFile = null,
  focusQuestion = null,
}: {
  promptText?: string | null;
  previousOutputFile?: string | null;
  focusQuestion?: string | null;
}): string {
  if (!promptText) throw new Error("prompt_text is required.");

  const sections = ["あなたは同じレビューセッションを継続しています。以下の追加依頼にだけ答えてください。"];

  if (previousOutputFile) {
    sections.push(`## 前回 round の出力\n${previousOutputFile}`);
  }

  if (focusQuestion) {
    sections.push(`## フォーカス質問\n${focusQuestion}`);
  }

  sections.push(`## 追加依頼\n${promptText}`);

  sections.push(`## 出力方針
- 前回 round の単なる繰り返しは避ける
- 新しく確信度が上がった点、下がった点を明示する
- 採用すべき対応、保留すべき対応、追加調査が必要な点を分ける`);

  return `${sections.join("\n\n")}\n`;
}
