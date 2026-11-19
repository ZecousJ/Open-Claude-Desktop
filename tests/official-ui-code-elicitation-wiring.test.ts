import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../electron/official-ui/window.ts", import.meta.url),
  "utf8",
);
const start = source.indexOf("    respondToLocalCodeElicitation: ");
const end = source.indexOf("    withCallerWindow:", start);
assert.ok(start > 0 && end > start);
const handler = source
  .slice(start, end)
  .trim()
  .replace(/^respondToLocalCodeElicitation:\s*/, "")
  .replace(/,$/, "");

function fixture(remote: boolean) {
  const approval = {
    id: "wsl:1",
    conversationId: "code",
    params: { threadId: "thread", turnId: "turn" },
  };
  const conversation = {
    id: "code",
    archived: false,
    threadId: "thread",
    turns: [{ id: "turn", status: "inProgress" }],
  };
  const responses: unknown[] = [];
  const owner = {
    rpc: { connected: true },
    ownApprovals: [approval],
    approve: (...args: unknown[]) => responses.push(args),
  };
  const local = remote
    ? {
        rpc: { connected: true },
        ownApprovals: [],
        approve: () => assert.fail("Approval belongs to WSL"),
      }
    : owner;
  const mainState = {
    engine: local,
    store: { conversations: [conversation] },
    activeAccount: {},
    accountRetirement: { accountRetiring: false },
  };
  let running: typeof owner | undefined = owner;
  const respond = vm.runInNewContext(`(${handler})`, {
    mainState,
    ctx: {
      engines: {
        running: (id: string) => {
          assert.equal(id, "code");
          return running;
        },
      },
    },
  });
  return {
    approval,
    conversation,
    owner,
    responses,
    mainState,
    respond,
    stop: () => {
      running = undefined;
    },
  };
}

for (const remote of [false, true]) {
  test(`Code elicitation reaches the ${remote ? "WSL" : "local"} running engine`, () => {
    const f = fixture(remote);
    const response = { action: "accept", content: { decision: "once" } };
    f.respond(f.approval, response);
    assert.deepEqual(f.responses, [["wsl:1", response]]);
  });
}

test("Code elicitation refuses a stopped engine or inactive request", () => {
  for (const invalidate of [
    (f: ReturnType<typeof fixture>) => f.stop(),
    (f: ReturnType<typeof fixture>) => {
      f.owner.ownApprovals = [];
    },
    (f: ReturnType<typeof fixture>) => {
      f.conversation.turns[0].status = "completed";
    },
    (f: ReturnType<typeof fixture>) => {
      f.mainState.accountRetirement.accountRetiring = true;
    },
  ]) {
    const f = fixture(true);
    invalidate(f);
    assert.throws(
      () => f.respond(f.approval, { action: "accept" }),
      /no longer available/,
    );
    assert.deepEqual(f.responses, []);
  }
});
