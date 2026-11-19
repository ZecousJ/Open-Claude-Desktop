/** Explicitly opt-in live provider validation. Never stores or prints the credential. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Store } from "../electron/store/store";
import { Engine } from "../electron/engine/engine";
import { resolveRuntime } from "../electron/engine/runtime";
import type { Protocol } from "../shared/types";
const key = process.env.CLAUDEX_TEST_KEY;
const base = process.env.CLAUDEX_TEST_BASE;
const model = process.env.CLAUDEX_TEST_MODEL;
if (!key || !base || !model)
  throw new Error(
    "Set CLAUDEX_TEST_KEY, CLAUDEX_TEST_BASE and CLAUDEX_TEST_MODEL to explicitly opt in.",
  );
const report: any[] = [];
const selected = (process.env.CLAUDEX_TEST_PROTOCOLS ?? "chat,responses").split(
  ",",
) as Protocol[];
for (const protocol of selected) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-live-"));
  const store = new Store(root);
  const provider = {
    id: "live-test",
    name: "Test provider",
    baseUrl: base,
    protocol,
    model,
    models: [model],
  };
  store.settings.providers = [provider];
  store.settings.activeProviderId = provider.id;
  store.settings.sandbox = "read-only";
  store.settings.effort = "low";
  let approved = 0;
  const engine: Engine = new Engine(
    store,
    resolveRuntime(),
    () => key,
    (event) => {
      if (event.type === "approval") {
        approved++;
        engine.approve(event.approval.id, { decision: "decline" });
      }
    },
  );
  const start = Date.now();
  try {
    await engine.ensure(provider);
    const conversation = await engine.send({
      text: "这是一个桌面客户端兼容性测试。请先实际执行只读命令 printf CLAUDEX_LIVE_OK，不要创建或修改文件。然后用一句中文报告命令输出，并给出一个完整的简短 HTML 代码块，内容仅含标题「测试成功」。",
      mode: "code",
      attachments: [],
      providerId: provider.id,
      model,
    });
    const deadline = Date.now() + 150000;
    while (
      store.conversation(conversation.id).turns.at(-1)!.status ===
        "inProgress" &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 100));
    const first = store.conversation(conversation.id).turns.at(-1)!;
    if (first.status === "inProgress") {
      await engine.interrupt(conversation.id);
      throw new Error("Live generation timed out after 150s");
    }
    assert.equal(first.status, "completed", first.error);
    const text = first.items
      .filter((i) => i.type === "agentMessage")
      .map((i) => i.text ?? "")
      .join("\n");
    const commands = first.items.filter((i) => i.type === "commandExecution");
    assert.ok(
      commands.some((i) => i.aggregatedOutput?.includes("CLAUDEX_LIVE_OK")),
      "Expected real command output, not just model text",
    );
    assert.ok(text.length > 0, "Expected assistant message");
    await engine.send({
      conversationId: conversation.id,
      text: "刚才实际执行的命令输出是什么？请只返回该标记，不要再调用工具。",
      mode: "code",
      attachments: [],
      providerId: provider.id,
      model,
    });
    const secondDeadline = Date.now() + 90000;
    while (
      store.conversation(conversation.id).turns.at(-1)!.status ===
        "inProgress" &&
      Date.now() < secondDeadline
    )
      await new Promise((r) => setTimeout(r, 100));
    const second = store.conversation(conversation.id).turns.at(-1)!;
    assert.equal(second.status, "completed", second.error);
    assert.ok(
      second.items.some(
        (i) => i.type === "agentMessage" && i.text?.includes("CLAUDEX_LIVE_OK"),
      ),
      "Expected conversation memory",
    );
    report.push({
      protocol,
      model,
      ok: true,
      commands: commands.length,
      htmlArtifact: /```html/.test(text),
      multiTurn: true,
      approvalRequests: approved,
      durationMs: Date.now() - start,
    });
  } catch (e) {
    let message = (e as Error).message.split(key).join("[redacted]");
    report.push({
      protocol,
      model,
      ok: false,
      error: message.slice(0, 3000),
      durationMs: Date.now() - start,
    });
  } finally {
    await engine.stop();
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log(JSON.stringify(report.at(-1)));
}
if (process.env.CLAUDEX_TEST_REPORT) {
  const target = path.resolve(process.env.CLAUDEX_TEST_REPORT);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    JSON.stringify(
      { testedAt: new Date().toISOString(), base, results: report },
      null,
      2,
    ),
  );
}
if (report.some((r) => !r.ok)) process.exitCode = 1;
