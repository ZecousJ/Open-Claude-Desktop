/** Execute the actual desktop wiring with inert engine ports, never a real RPC. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createCommandDeclineHost } from "../electron/official-ui/command-decline-host";

const source = fs.readFileSync(
  new URL("../electron/official-ui/window.ts", import.meta.url),
  "utf8",
);
const start = source.indexOf("  const commandEngine = mainState.engine;");
const end = source.indexOf("  context.readConfirmedUpload =", start);
assert.ok(start > 0 && end > start);
const wiring = source.slice(start, end);

function fixture() {
  let active = true,
    dispatches = 0;
  const request: any = {
    id: 7,
    conversationId: "c",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      command: "printf inert",
    },
  };
  const c: any = {
    id: "c",
    mode: "chat",
    threadId: "thread",
    createdAt: 1,
    turns: [
      {
        id: "turn",
        createdAt: 2,
        status: "inProgress",
        items: [
          {
            id: "item",
            type: "commandExecution",
            command: "printf inert",
            status: "inProgress",
          },
        ],
      },
    ],
  };
  const engine = {
    rpc: {} as object | undefined,
    ownApprovals: [request],
    approve(id: any, value: any) {
      assert.equal(id, 7);
      assert.equal(JSON.stringify(value), '{"decision":"decline"}');
      dispatches++;
      engine.ownApprovals = engine.ownApprovals.filter((a) => a !== request);
    },
  };
  const mainState = { engine, store: { conversations: [c] } },
    context: any = {};
  vm.runInNewContext(wiring, {
    createCommandDeclineHost,
    mainState,
    context,
    runtime: { lease: { current: () => active } },
  });
  const host: ReturnType<typeof createCommandDeclineHost> =
    context.commandDeclines;
  const card = host.list("c")[0];
  return {
    mainState,
    engine,
    card,
    host,
    dispatches: () => dispatches,
    retire: () => {
      active = false;
    },
    decline: () => host.decline("c", card.elicitationId, card.askNonce),
  };
}
test("actual desktop wiring sends only a decline to the captured local engine", async () => {
  const f = fixture();
  await f.decline();
  assert.equal(f.dispatches(), 1);
  await f.decline();
  assert.equal(f.dispatches(), 1);
  assert.deepEqual(f.host.list("c"), []);
});
for (const change of ["lease", "store", "engine"])
  test(`desktop ${change} replacement rejects the previous capability`, async () => {
    const f = fixture();
    if (change === "lease") f.retire();
    if (change === "store") f.mainState.store = { ...f.mainState.store };
    if (change === "engine") f.mainState.engine = { ...f.engine };
    await assert.rejects(f.decline, /no longer available/);
    assert.equal(f.dispatches(), 0);
  });
test("missing native RPC cannot become a false successful decline", async () => {
  const f = fixture();
  f.engine.rpc = undefined;
  await assert.rejects(f.decline, /unconfirmed/);
  await assert.rejects(f.decline, /unconfirmed/);
  assert.equal(f.dispatches(), 0);
});
test("an engine that does not remove the exact request leaves an unknown result and is never replayed", async () => {
  const f = fixture();
  let calls = 0;
  f.engine.approve = () => {
    calls++;
  };
  await assert.rejects(f.decline, /unconfirmed/);
  await assert.rejects(f.decline, /unconfirmed/);
  assert.equal(calls, 1);
  assert.equal(f.host.list("c")[0].state, "unconfirmed");
});
test("native dispatch failure is not retried by repeated renderer submissions", async () => {
  const f = fixture();
  let calls = 0;
  f.engine.approve = () => {
    calls++;
    throw Error("Inert RPC write error");
  };
  await assert.rejects(f.decline, /unconfirmed/);
  await assert.rejects(f.decline, /unconfirmed/);
  assert.equal(calls, 1);
});
