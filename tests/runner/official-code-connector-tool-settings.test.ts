import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { connectorUuid } from "../../electron/official-ui/api/connectors";
import { defaultSettings } from "../../electron/store/store";
import type { GuardOptions } from "../../runner/src/method-guard";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import type { OfficialUiReadRequest } from "../../shared/official-ui-web";

test("the original Code toggle writes only known connector tool settings through the runner", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f044-tool-settings-"));
  t.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 550));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const account = { id: "f044", email: "fixture@example.invalid", name: "Fixture" };
  const session = {};
  const key = `${connectorUuid("wiki")}:lookup`;
  let enabled = true;
  let authorized = true;
  const commits: unknown[] = [];
  const inventory = () => ({
    servers: [{
      name: "wiki", url: "https://fixture.example.invalid/mcp", state: "ready",
      toolList: [{ name: "lookup", description: "Look up a term", enabled }],
    }],
  });
  const host = {
    account: () => account, stateDirectory: () => root, sessionIdentity: () => session,
    settings: () => ({ ...defaultSettings, mcpServers: { wiki: {
      url: "https://fixture.example.invalid/mcp", disabled_tools: enabled ? [] : ["lookup"],
    } } }),
    onEvent: () => () => {}, appVersion: "test", log() {},
    authorizeConnectorPreferences(kind: "account" | "chat") {
      assert.equal(kind, "account");
      if (!authorized) throw Error("Authorization expired");
    },
  };
  const dispatch = async (method: string, args: unknown[]) => {
    if (method === "mcpServers") return inventory();
    assert.equal(method, "setConnectorToolPermissions");
    commits.push(args[0]);
    enabled = !enabled;
    return inventory();
  };
  const options = { allowTextActions: true, allowAppearanceSettings: true };
  const build = path.resolve("build/official-ui");
  const guard = { modes: ["chat", "code"] } satisfies GuardOptions;
  const run = createRunnerOfficialAdapter(host, dispatch, build, guard, options);
  const patch = (value: unknown): OfficialUiReadRequest => ({
    method: "PATCH", path: "/api/account/settings", contentType: "application/json",
    body: Buffer.from(JSON.stringify(value)),
  });
  const disabled = await run(patch({ enabled_mcp_tools: { [key]: false } }));
  assert.equal(disabled.status, 200);
  assert.equal(JSON.parse(Buffer.from(disabled.body).toString()).settings.enabled_mcp_tools[key], false);
  assert.deepEqual(commits, [[{ name: "wiki", tool: "lookup", permission: "block" }]]);

  const unknown = await run(patch({ enabled_mcp_tools: { forged: true } }));
  assert.ok(unknown.status >= 400);
  const mixed = await run(patch({ enabled_mcp_tools: { [key]: true }, chat_font: "serif" }));
  assert.equal(mixed.status, 400);
  const readOnly = createRunnerOfficialAdapter(host, dispatch, build, guard);
  assert.equal((await readOnly(patch({ enabled_mcp_tools: { [key]: true } }))).status, 403);
  authorized = false;
  assert.ok((await run(patch({ enabled_mcp_tools: { [key]: true } }))).status >= 400);
  assert.equal(commits.length, 1);
});
