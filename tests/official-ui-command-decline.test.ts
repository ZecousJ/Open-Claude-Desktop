import test from "node:test";
import assert from "node:assert/strict";
import { createCommandDeclineHost } from "../electron/official-ui/command-decline-host";
import { respondToCommandElicitation } from "../electron/official-ui/api/elicitation-response";
import type { Approval, Conversation } from "../shared/types";

function fixture() {
  const approval: Approval = {
    id: 7,
    conversationId: "c",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      command: "printf test",
    },
  };
  const conversation = {
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
            command: "printf test",
            status: "inProgress",
          },
        ],
      },
    ],
  } as unknown as Conversation;
  const state = {
    active: true,
    conversation,
    approvals: [approval],
    calls: [] as Approval[],
    dispatch: (a: Approval): unknown => {
      state.approvals = state.approvals.filter((p) => p !== a);
      return { status: "declined" };
    },
  };
  const host = createCommandDeclineHost({
    current: () => state.active,
    approvals: () => state.approvals,
    conversation: (id) =>
      id === state.conversation.id ? state.conversation : undefined,
    declineExact: (a) => {
      state.calls.push(a);
      return state.dispatch(a);
    },
    confirmationWaitMs: 10,
  });
  const ctx = { commandDeclines: host, isCurrent: () => state.active };
  const card = () => host.list("c")[0];
  const respond = (
    value = card(),
    response: Record<string, unknown> = { verdict: 2 },
  ) =>
    respondToCommandElicitation(ctx, "c", {
      elicitationId: value?.elicitationId,
      askNonce: value?.askNonce,
      response,
    });
  return { approval, state, host, ctx, card, respond };
}

test("ordinary pending command gets an opaque stable card and explicit decline once", async () => {
  const f = fixture(),
    card = f.card();
  assert.match(card.elicitationId, /^[0-9a-f-]{36}$/);
  assert.notEqual(card.askNonce, card.elicitationId);
  assert.notEqual(card.elicitationId, String(f.approval.id));
  assert.deepEqual(f.card(), card);
  assert.equal(await f.respond(card), undefined);
  assert.deepEqual(f.state.calls, [f.approval]);
  assert.deepEqual(f.host.list("c"), []);
  assert.equal(await f.respond(card), undefined);
  assert.equal(f.state.calls.length, 1);
});

for (const [name, mutate] of [
  [
    "different account/retired lease",
    (f: ReturnType<typeof fixture>) => {
      f.state.active = false;
    },
  ],
  [
    "different conversation",
    (f) => {
      f.approval.conversationId = "other";
    },
  ],
  [
    "different thread",
    (f) => {
      f.state.conversation.threadId = "other";
    },
  ],
  [
    "different active branch",
    (f) => {
      f.state.conversation.activeBranchId = "other";
    },
  ],
  [
    "replacement conversation timestamp",
    (f) => {
      f.state.conversation.createdAt++;
    },
  ],
  [
    "replacement turn timestamp",
    (f) => {
      f.state.conversation.turns[0].createdAt++;
    },
  ],
  [
    "finished turn",
    (f) => {
      f.state.conversation.turns[0].status = "completed";
    },
  ],
  [
    "new turn",
    (f) => {
      f.state.conversation.turns.push({
        ...f.state.conversation.turns[0],
        id: "new",
      });
    },
  ],
  [
    "removed request",
    (f) => {
      f.state.approvals = [];
    },
  ],
  [
    "recycled request id",
    (f) => {
      f.state.approvals = [{ ...f.approval }];
    },
  ],
  [
    "duplicate request id",
    (f) => {
      f.state.approvals.push({ ...f.approval });
    },
  ],
  [
    "changed request command",
    (f) => {
      f.approval.params.command = "different";
    },
  ],
  [
    "changed request metadata",
    (f) => {
      f.approval.params.reason = "different reason";
    },
  ],
  [
    "completed command item",
    (f) => {
      f.state.conversation.turns[0].items[0].status = "completed";
    },
  ],
  [
    "duplicate command item",
    (f) => {
      f.state.conversation.turns[0].items.push({
        ...f.state.conversation.turns[0].items[0],
      });
    },
  ],
] as [string, (f: ReturnType<typeof fixture>) => void][]) {
  test(`old card cannot dispatch after ${name}`, async () => {
    const f = fixture(),
      card = f.card();
    mutate(f);
    assert.ok(await f.respond(card));
    assert.equal(f.state.calls.length, 0);
  });
}

for (const [name, mutate] of [
  [
    "Code",
    (f: ReturnType<typeof fixture>) => {
      f.state.conversation.mode = "code";
    },
  ],
  [
    "Cowork",
    (f) => {
      f.state.conversation.mode = "cowork";
    },
  ],
  [
    "cloud",
    (f) => {
      f.state.conversation.cloudHosted = true;
    },
  ],
  [
    "SSH",
    (f) => {
      f.state.conversation.environment = { kind: "ssh" } as never;
    },
  ],
  [
    "form elicitation",
    (f) => {
      f.approval.method = "mcpServer/elicitation/request";
    },
  ],
  [
    "file change",
    (f) => {
      f.approval.method = "item/fileChange/requestApproval";
    },
  ],
  [
    "missing item",
    (f) => {
      f.state.conversation.turns[0].items = [];
    },
  ],
  [
    "missing thread",
    (f) => {
      delete f.approval.params.threadId;
    },
  ],
  [
    "different turn",
    (f) => {
      f.approval.params.turnId = "other";
    },
  ],
  [
    "missing command",
    (f) => {
      delete f.approval.params.command;
    },
  ],
  [
    "mismatched item command",
    (f) => {
      f.state.conversation.turns[0].items[0].command = "different";
    },
  ],
  [
    "network permission",
    (f) => {
      f.approval.params.networkApprovalContext = {};
    },
  ],
  [
    "directory permission",
    (f) => {
      f.approval.params.additionalPermissions = {};
    },
  ],
  [
    "network policy amendment",
    (f) => {
      f.approval.params.proposedNetworkPolicyAmendments = [];
    },
  ],
  [
    "execution policy amendment",
    (f) => {
      f.approval.params.proposedExecpolicyAmendment = [];
    },
  ],
] as [string, (f: ReturnType<typeof fixture>) => void][]) {
  test(`no ordinary command card for ${name}`, () => {
    const f = fixture();
    mutate(f);
    assert.deepEqual(f.host.list("c"), []);
    assert.equal(f.state.calls.length, 0);
  });
}

test("nonce, capability, and conversation must match; unissued ids never select latest request", async () => {
  const f = fixture(),
    card = f.card();
  for (const value of [
    { ...card, elicitationId: String(f.approval.id) },
    { ...card, askNonce: "wrong" },
    { ...card, askNonce: "" },
    { ...card, elicitationId: "" },
  ]) {
    assert.ok(await f.respond(value));
  }
  await assert.rejects(
    f.host.decline("different", card.elicitationId, card.askNonce),
  );
  assert.equal(f.state.calls.length, 0);
});

test("new account activation has no knowledge of old capabilities", async () => {
  const old = fixture(),
    fresh = fixture();
  assert.ok(await fresh.respond(old.card()));
  assert.equal(fresh.state.calls.length, 0);
});

for (const response of [
  undefined,
  {},
  { verdict: 0 },
  { verdict: 99 },
  { verdict: 1 },
  { verdict: 1, approvalOption: 1 },
  { verdict: 2, approvalOption: 2 },
  { verdict: 2, approvalOption: 3 },
  { verdict: 2, approvalOption: 4 },
  { verdict: 2, stepUpDecision: 1 },
  { verdict: 2, stepUpDecision: 2 },
  { verdict: 2, alwaysAllowTools: { tools: [] } },
  { verdict: 2, values: [{ fieldId: "x" }] },
  { verdict: 2, comment: "other content" },
  { verdict: 2, approvalOption: "1" },
]) {
  test(`unsupported response does not dispatch: ${JSON.stringify(response)}`, async () => {
    const f = fixture(),
      card = f.card();
    assert.ok(
      await respondToCommandElicitation(f.ctx, "c", {
        elicitationId: card.elicitationId,
        askNonce: card.askNonce,
        response,
      }),
    );
    assert.equal(f.state.calls.length, 0);
  });
}

test("empty decoded scalar defaults are safe for decline only", async () => {
  const f = fixture();
  assert.equal(
    await f.respond(f.card(), {
      verdict: 2,
      approvalOption: 0,
      stepUpDecision: 0,
      values: [],
    }),
    undefined,
  );
  assert.equal(f.state.calls.length, 1);
});

test("an observed retirement is irrevocable even when the same account returns", async () => {
  const f = fixture(),
    card = f.card();
  f.state.active = false;
  assert.throws(() => f.host.list("c"));
  f.state.active = true;
  assert.ok(await f.respond(card));
  assert.equal(f.state.calls.length, 0);
});

test("observed stale target cannot revive when fields are later restored", async () => {
  const f = fixture(),
    card = f.card();
  f.approval.params.command = "different";
  assert.deepEqual(f.host.list("c"), []);
  f.approval.params.command = "printf test";
  assert.deepEqual(f.host.list("c"), []);
  assert.equal((await f.respond(card))!.code, "elicitation_unavailable");
  assert.equal(f.state.calls.length, 0);
});

test("a host without explicit capability stays unsupported; no generic approve call", async () => {
  const f = fixture(),
    card = f.card();
  assert.match(
    (await respondToCommandElicitation({ isCurrent: () => true }, "c", {
      elicitationId: card.elicitationId,
      askNonce: card.askNonce,
      response: { verdict: 2 },
    }))!.message,
    /No approval or cancellation was sent/,
  );
  assert.equal(f.state.calls.length, 0);
});

test("read-only adapter cannot use an installed mutation capability", async () => {
  const f = fixture(),
    card = f.card();
  assert.ok(
    await respondToCommandElicitation({ ...f.ctx, readOnly: true }, "c", {
      elicitationId: card.elicitationId,
      askNonce: card.askNonce,
      response: { verdict: 2 },
    }),
  );
  assert.equal(f.state.calls.length, 0);
});

for (const outcome of [
  undefined,
  { status: "accepted" },
  {},
  Promise.reject(new Error("lost")),
]) {
  // Attach rejection immediately; the route installs its own consumption later.
  if (outcome instanceof Promise) outcome.catch(() => {});
  test(`unknown dispatch outcome is not replayed: ${String(outcome)}`, async () => {
    const f = fixture(),
      card = f.card();
    f.state.dispatch = () => outcome;
    assert.equal((await f.respond(card))!.code, "elicitation_unconfirmed");
    assert.equal(f.card().state, "unconfirmed");
    assert.equal((await f.respond(card))!.code, "elicitation_unconfirmed");
    assert.equal(((await f.respond(f.card())) as unknown) !== undefined, true);
    assert.equal(f.state.calls.length, 1);
  });
}

test("synchronous throw stays unconfirmed and cannot be replayed", async () => {
  const f = fixture(),
    card = f.card();
  f.state.dispatch = () => {
    throw Error("lost");
  };
  assert.equal((await f.respond(card))!.code, "elicitation_unconfirmed");
  assert.equal((await f.respond(card))!.code, "elicitation_unconfirmed");
  assert.equal(f.state.calls.length, 1);
});

test("overlapping and reentrant clicks reserve before dispatch", async () => {
  const f = fixture(),
    card = f.card();
  let second: Promise<unknown> | undefined;
  f.state.dispatch = () => {
    second = f.respond(card);
    return new Promise(() => {});
  };
  const first = f.respond(card),
    third = f.respond(card);
  await Promise.all([first, second, third]);
  assert.equal(f.state.calls.length, 1);
});

test("timeout never retries; late resolution cannot turn the old result into success", async () => {
  const f = fixture(),
    card = f.card();
  let finish!: (value: unknown) => void;
  f.state.dispatch = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  assert.equal((await f.respond(card))!.code, "elicitation_unconfirmed");
  finish({ status: "declined" });
  await Promise.resolve();
  assert.equal((await f.respond(card))!.code, "elicitation_unconfirmed");
  assert.equal(f.card().state, "unconfirmed");
  assert.equal(f.state.calls.length, 1);
});

test("account retirement during dispatch cannot report applied", async () => {
  const f = fixture(),
    card = f.card();
  f.state.dispatch = () => {
    f.state.active = false;
    return { status: "declined" };
  };
  assert.equal((await f.respond(card))!.code, "elicitation_unconfirmed");
  assert.ok(await f.respond(card));
  assert.equal(f.state.calls.length, 1);
});
