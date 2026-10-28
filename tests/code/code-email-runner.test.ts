import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  memoryWebstore,
  useElectronShim,
} from "../runner/runner-core-support.test.ts";
import { webHost } from "../../shared/host";
import type { Conversation } from "../../shared/types";
import type { WebAppContext as RunnerContext } from "../../runner/src/web-app-context";

useElectronShim();
const { WebAppContext } = await import("../../runner/src/web-app-context");
const { CloudStore } = await import("../../runner/src/cloud-store");

test("cloud email preference persists to account webstore and rejects failed durable writes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-email-store-"));
  const service = memoryWebstore();
  const store = new CloudStore({
    root,
    userId: 7,
    transport: service,
    log() {},
  });
  try {
    store.settings.notifyCodeEmail = true;
    await store.persistCodeEmailPreference();
    assert.equal((service.users.get(7)!.settings as any).notifyCodeEmail, true);
    service.failNext("store.settings.put");
    store.settings.notifyCodeEmail = false;
    await assert.rejects(
      store.persistCodeEmailPreference(),
      /email preference couldn’t be saved/,
    );
    assert.equal((service.users.get(7)!.settings as any).notifyCodeEmail, true);
    await store.persistCodeEmailPreference();
    assert.equal(
      (service.users.get(7)!.settings as any).notifyCodeEmail,
      false,
    );
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("actual runner push dispatches email with no connected browser and keeps two account sessions isolated", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-email-context-"));
  const service = memoryWebstore();
  const sent: { token: string | null; event: any; persisted: boolean }[] = [];
  const contexts: RunnerContext[] = [];
  try {
    for (const userId of [7, 8]) {
      // Exercise real context construction/push/teardown without starting an engine.
      const context = Reflect.construct(WebAppContext, [
        {
          stateDir: root,
          serviceUrl: "https://service.test",
          version: "test",
          providerServiceScript: "/unused",
          transport: service,
          host: {
            ...webHost,
            capabilities: { ...webHost.capabilities, cloudCode: true },
          },
          log() {},
          publish() {},
          fetch: async (_input: unknown, init: RequestInit) => {
            if (init.method === "POST")
              sent.push({
                token: new Headers(init.headers).get("authorization"),
                event: JSON.parse(String(init.body)),
                persisted:
                  (service.users.get(userId)?.settings as any)
                    ?.notifyCodeEmail === true,
              });
            return new Response(
              JSON.stringify({
                code: 0,
                data:
                  init.method === "POST" ? { sent: true } : { available: true },
              }),
            );
          },
        },
        userId,
      ]) as RunnerContext;
      contexts.push(context);
      context.store = new CloudStore({
        root: context.dataRoot,
        userId,
        transport: service,
        log() {},
      });
      context.store.settings.notifyCodeEmail = true;
      context.session = {
        authorized: (call: (token: string) => unknown) =>
          call(`user-${userId}`),
        end() {},
      } as never;
      assert.deepEqual(await context.codeEmailStatus(), { available: true });
      const code = {
        id: "same-id",
        mode: "code",
        title: "Task",
        turns: [
          {
            id: "turn1",
            status: "inProgress",
            items: [],
            attachments: [],
            prompt: "x",
            createdAt: 1,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      } as unknown as Conversation;
      context.store.conversations = [code];
      context.push({
        type: "conversation",
        conversation: structuredClone(code),
      });
      code.turns[0].status = "completed";
      context.push({
        type: "conversation",
        conversation: structuredClone(code),
      });
      context.push({
        type: "conversation",
        conversation: structuredClone(code),
      });
    }
    const deadline = performance.now() + 15_000;
    while (sent.length < 2) {
      assert.ok(
        performance.now() < deadline,
        "cloud email deliveries did not complete",
      );
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(sent.map((value) => value.token).sort(), [
      "Bearer user-7",
      "Bearer user-8",
    ]);
    assert.ok(
      sent.every(
        (value) =>
          value.persisted &&
          value.event.conversationId === "same-id" &&
          value.event.outcome === "completed",
      ),
    );
    await contexts[0].close();
    assert.deepEqual(await contexts[0].codeEmailStatus(), { available: false });
    contexts[0].push({
      type: "approval",
      approval: {
        id: 2,
        conversationId: "same-id",
        method: "item/commandExecution/requestApproval",
        params: {},
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sent.length, 2);
  } finally {
    for (const context of contexts) await context.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
