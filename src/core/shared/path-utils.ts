// クロス環境でのパス差異を吸収する共通ユーティリティ。
//
// 想定する差異:
// - Windows の区切り文字 `\`（JSON へ素で埋めると壊れるため、受理時に `/` へ統一）
// - git-bash / MSYS の drive 表記 `/c/Users/...`（Node の fs が解決できないため `C:/Users/...` へ変換）
//
// posix 環境では `\` も `/c/...` も正当な値になりうるため、変換は win32 のときだけ行う。
// platform を引数で渡せるようにして、テストを実行環境に依存させない。
export function normalizePath<T>(value: T, platform: NodeJS.Platform | string = process.platform): T | string {
  if (typeof value !== "string" || value.length === 0) return value;
  if (platform !== "win32") return value;

  // 区切り文字を `/` に統一する。Windows API は forward slash を受理する。
  let normalized = value.replace(/\\/g, "/");

  // `/c/Users/...` のような MSYS drive 表記を `C:/Users/...` へ変換する。
  // 単一英字 + (`/` または末尾) のときだけ drive とみなし、`/home/...` などは変換しない。
  const msys = /^\/([a-zA-Z])(\/|$)/.exec(normalized);
  if (msys) normalized = `${msys[1].toUpperCase()}:${normalized.slice(2)}`;

  return normalized;
}

// 文字列配列の各要素を normalizePath で正規化する。null / undefined はそのまま返す。
export function normalizePathList<T>(values: T, platform: NodeJS.Platform | string = process.platform): T | string[] {
  if (!Array.isArray(values)) return values;
  return values.map((value) => normalizePath(value, platform));
}
