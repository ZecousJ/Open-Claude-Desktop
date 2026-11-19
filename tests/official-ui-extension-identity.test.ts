import test from "node:test";
import assert from "node:assert/strict";
import { officialExtensionId } from "../electron/connectors/extension-identity";

test("local extension identifiers follow the official author and name rules", () => {
  assert.equal(officialExtensionId({ name: "Same Name", author: { name: "First Author" } }, "local.mcpb"), "local.mcpb.first-author.same-name");
  assert.equal(officialExtensionId({ name: "工具", author: { name: "作者" } }, "local.dxt"), "local.dxt.x08800350aaab1be95aa0732ffb9c6d9a.x08802590d8ab1be95aa07330112e01f5");
});
