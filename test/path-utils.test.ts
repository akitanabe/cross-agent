// @ts-nocheck
import { expect, test } from "vitest";
import assert from "node:assert/strict";

import { normalizePath, normalizePathList } from "../src/core/shared/path-utils.ts";

test("normalizePath converts MSYS drive notation to Windows drive on win32", () => {
  assert.equal(normalizePath("/c/Users/x", "win32"), "C:/Users/x");
  assert.equal(normalizePath("/d/repo", "win32"), "D:/repo");
});

test("normalizePath unifies backslashes to forward slashes on win32", () => {
  assert.equal(normalizePath("C:\\Users\\x\\y", "win32"), "C:/Users/x/y");
  assert.equal(normalizePath(".claude-plugin\\plugin.json", "win32"), ".claude-plugin/plugin.json");
});

test("normalizePath handles bare drive root on win32", () => {
  assert.equal(normalizePath("/c", "win32"), "C:");
  assert.equal(normalizePath("/c/", "win32"), "C:/");
});

test("normalizePath leaves real posix paths untouched on win32", () => {
  // 単一英字 + 区切りでないものは drive とみなさない。
  assert.equal(normalizePath("/home/user", "win32"), "/home/user");
  assert.equal(normalizePath("/usr/local/bin", "win32"), "/usr/local/bin");
});

test("normalizePath is a no-op on posix", () => {
  assert.equal(normalizePath("/c/Users/x", "linux"), "/c/Users/x");
  assert.equal(normalizePath("a\\b", "linux"), "a\\b");
});

test("normalizePath passes through non-string and empty values", () => {
  assert.equal(normalizePath(null, "win32"), null);
  assert.equal(normalizePath(undefined, "win32"), undefined);
  assert.equal(normalizePath("", "win32"), "");
});

test("normalizePathList normalizes each element and passes through non-arrays", () => {
  assert.deepEqual(
    normalizePathList(["/c/a", "x\\y"], "win32"),
    ["C:/a", "x/y"],
  );
  assert.equal(normalizePathList(null, "win32"), null);
  assert.equal(normalizePathList(undefined, "win32"), undefined);
});
