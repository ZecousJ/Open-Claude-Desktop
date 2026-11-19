import assert from "node:assert/strict";
import { test } from "node:test";
import { signInError } from "../../electron/sub2api/identity-support";
import { Sub2ApiError } from "../../electron/sub2api/http";
import zh from "../../shared/i18n/catalogs/zh-CN";

test("native unreachable errors use existing translated actionable copy without exposing transport details", () => {
  const error = signInError(
    new Sub2ApiError(0, "UNREACHABLE", "internal transport detail"),
  );
  assert.equal(
    error.message,
    "The Claudex service is unreachable. Check your connection.",
  );
  assert.equal(zh[error.message], "无法连接到服务。请检查网络连接后重试。");
  assert.equal(error.message.includes("internal"), false);
});
