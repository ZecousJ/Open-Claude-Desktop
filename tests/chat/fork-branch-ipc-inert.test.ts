/** Registered IPC handler with inert engine methods; no Engine/SDK or service. */
import test from "node:test";
import assert from "node:assert/strict";
import { registerComposerHandlers } from "../../electron/ipc/composer";
test("branch IPC validates wire fields and carries an unforgeable host-only activation predicate", async () => {
  const handlers = new Map<string, any>(),
    calls: any[] = [];
  const ctx: any = {
    accountActivationIdentity: {},
    accountRetiring: false,
    activeAccount: { id: "a" },
    store: {},
    engine: {
      forkConversation: async (...args: any[]) => {
        calls.push(args);
        return {};
      },
    },
  };
  registerComposerHandlers((name, fn) => handlers.set(name, fn), ctx);
  const run = handlers.get("forkConversation");
  await run("c", { turnId: "t", branchId: "saved" });
  assert.deepEqual(calls[0].slice(0, 4), ["c", "t", undefined, "saved"]);
  const current = calls[0][4];
  assert.equal(current(), true);
  ctx.accountActivationIdentity = {};
  assert.equal(current(), false);
  assert.throws(() => run("c", { branchId: 3 }));
  ctx.accountRetiring = true;
  assert.throws(() => run("c", { turnId: "t", branchId: "saved" }));
  assert.equal(calls.length, 1);
});
