import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Gateway } from "../../electron/engine/gateway";
import { resolveRuntime } from "../../electron/engine/runtime";
import { approvalsReviewerFor } from "../../shared/sandbox-policy";
import { runWindowsSandboxSetup } from "../../electron/workspace/windows-sandbox";
import { CodexHost, FAKE_KEY, MODEL, MockResponses, findTool, functionCall, message, tempRoot } from "../spikes/harness";

let runtimeAvailable = true;
try { resolveRuntime(); } catch { runtimeAvailable = false; }

test("Code permissions reach the real execution process", { skip: !runtimeAvailable, timeout: 120_000 }, async t => {
  for (const outcome of ["allow", "deny", "manual"] as const) await t.test(outcome, async () => {
    const root = tempRoot("code-auto-review");
    const mock = await new MockResponses().start();
    let reviews = 0;
    let supportsEscalation = false;
    mock.script = (body, index) => {
      if (index === 0) {
        const shell = findTool(body, name => ["exec_command", "shell_command", "shell"].includes(name));
        assert.ok(shell);
        supportsEscalation = !!shell.parameters?.properties?.sandbox_permissions;
        return [functionCall(shell, "fixture-command", {
          ...(shell.name === "exec_command" ? { cmd: "echo fixture" } : { command: "echo fixture" }),
          sandbox_permissions: "require_escalated", justification: "Run the fixture command",
        })];
      }
      if (body.text?.format?.schema?.properties?.outcome) {
        reviews++;
        return [message(JSON.stringify({ outcome, risk_level: "low", user_authorization: "high", rationale: "Fixture review" }))];
      }
      return [message("Fixture complete")];
    };
    const gateway = new Gateway(() => ({ provider: { id: "fixture", name: "Fixture", model: MODEL, models: [], baseUrl: mock.url, protocol: "responses" }, apiKey: FAKE_KEY }));
    await gateway.start();
    const host = new CodexHost(path.join(root, "home"), { url: gateway.url } as MockResponses,
      process.platform === "win32" ? { "windows.sandbox": "unelevated" } : {}, { SPIKE_GATEWAY_TOKEN: gateway.token });
    try {
      if (outcome === "manual") host.onRequest = request => {
        if (!request.method.endsWith("/requestApproval")) return undefined;
        return { decision: "accept" };
      };
      await host.start();
      const reviewer = approvalsReviewerFor("code", {}, false, false, undefined, outcome === "manual" ? "manual" : "auto");
      const cwd = path.join(root, "work");
      fs.mkdirSync(cwd, { recursive: true });
      if (process.platform === "win32") await runWindowsSandboxSetup(host.rpc, cwd);
      const thread = await host.thread(MODEL, cwd, { approvalsReviewer: reviewer, sandbox: outcome === "manual" ? "read-only" : "workspace-write" });
      const result = await host.turn(thread, "Run the fixture command", { approvalsReviewer: reviewer });
      assert.equal(result.completed.turn.status, "completed");
      const command = result.items.find(item => item.type === "commandExecution");
      const evidence = JSON.stringify({ command, supportsEscalation, methods: host.serverRequests.map(request => request.method), requests: mock.requests.length });
      assert.equal(reviews, outcome === "manual" ? 0 : 1, evidence);
      assert.equal(host.serverRequests.filter(request => request.method.endsWith("/requestApproval")).length, outcome === "manual" ? 1 : 0, evidence);
      assert.equal(command?.status, outcome === "deny" ? "declined" : "completed");
      if (outcome !== "deny") assert.match(command.aggregatedOutput, /fixture/);
    } finally {
      await host.stop();
      await gateway.close();
      await mock.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
