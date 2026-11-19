import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { deriveOfficialUiUserContent, hostUserContentRules, hostUserContentHashes } from "../scripts/official-ui-host-usercontent.mjs";

const file = Object.keys(hostUserContentHashes)[0];
const assets = process.env.CLAUDEX_F019_SOURCE ?? path.join(
  process.env.CLAUDEX_OFFICIAL_EXTRACTED ?? ".restore/archive-extracted",
  "claude-frontend-4.4212.0/src/cloud/assets/v1",
);
const source = fs.readFileSync(path.join(assets, file), "utf8");

test("official viewer and MCP App configuration use their host addresses with the original defaults", () => {
  const derived = deriveOfficialUiUserContent(file, source);
  const original = hostUserContentRules.reduce((module, rule) => module.replace(rule.after, rule.before), derived);
  assert.equal(original, source);
  const expression = `({${hostUserContentRules.map(({ after }) => after).join("\n")}})`;
  assert.deepEqual({ ...vm.runInNewContext(expression, {}) }, {
    userContentRendererUrl: "https://www.claudeusercontent.com",
    mcpAppsSandboxProxyUrl: "https://sandbox.claudemcpcontent.com/mcp_apps",
  });
  assert.deepEqual({ ...vm.runInNewContext(expression, {
    __claudexOfficialUserContentOrigin: "http://localhost:5200",
    __claudexMcpAppsSandboxUrl: "http://localhost:5200/mcp_apps",
  }) }, {
    userContentRendererUrl: "http://localhost:5200",
    mcpAppsSandboxProxyUrl: "http://localhost:5200/mcp_apps",
  });
  assert.throws(() => deriveOfficialUiUserContent(file, source + "\n"), /hash mismatch/);
});
