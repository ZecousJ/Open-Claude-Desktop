/** Execute exact pinned original offer/callback code with inert host ports. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { createHash } from "node:crypto";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { createCommandDeclineHost } from "../electron/official-ui/command-decline-host";
import { commandDeclineElicitations } from "../electron/official-ui/api/command-decline-projection";
import { respondToCommandElicitation } from "../electron/official-ui/api/elicitation-response";
import { deepCreate, loadRegistry } from "../electron/official-ui/api/timeline";

const sourceRoot =
  process.env.CLAUDEX_OFFICIAL_UI_SOURCE ??
  ".restore/archive-extracted/claude-frontend-4.4212.0";
const name = "30d42b21c0beac5d9cf92fe74ad903f7b6e31755849b8edc-BRBPiM5u.js";
const source = fs.readFileSync(
  path.join(sourceRoot, "src/cloud/assets/v1", name),
  "utf8",
);
assert.equal(
  createHash("sha256").update(source).digest("hex"),
  "569a3265363bffd3e2e6bd4d8f6dcf6b9dacc4a8250f2577aeccdb3f597b7dca",
);
const ast = ts.createSourceFile(
  name,
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const functions = [
  "$S",
  "eC",
  "tC",
  "nC",
  "rC",
  "iC",
  "aC",
  "oC",
  "nre",
  "vle",
  "R5",
].map((name) => {
  const node = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(node, `Pinned original function ${name} is present`);
  return node.getText(ast);
});
let callback: ts.ArrowFunction | undefined;
const mapper = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "xN",
);
assert.ok(mapper);
function visit(node: ts.Node) {
  if (
    ts.isPropertyAssignment(node) &&
    node.name.getText(ast) === "respond" &&
    ts.isConditionalExpression(node.initializer) &&
    ts.isArrowFunction(node.initializer.whenTrue)
  )
    callback = node.initializer.whenTrue;
  ts.forEachChild(node, visit);
}
visit(mapper);
assert.ok(callback);
const callbackSource = callback.getText(ast);
const registry = loadRegistry(
  "build/official-ui/data/conversation-protocol.json",
);
const pkg = "anthropic.bard.api.v1alpha.";
function fixture(unknown = false) {
  let calls = 0,
    active = true;
  const approval: any = {
    id: 1,
    conversationId: "c",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      command: "printf inert",
    },
  };
  const conversation: any = {
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
  let approvals = [approval];
  const host = createCommandDeclineHost({
    current: () => active,
    approvals: () => approvals,
    conversation: () => conversation,
    declineExact: () => {
      calls++;
      if (unknown) throw Error("Inert unknown receipt");
      approvals = [];
      return { status: "declined" };
    },
  });
  const card = host.list("c")[0];
  const schema = registry.getMessage(pkg + "ConversationUpdate")!;
  const decoded: any = fromBinary(
    schema,
    toBinary(
      schema,
      deepCreate(schema, {
        elicitations: commandDeclineElicitations([card], "c"),
      }),
    ),
  );
  const d = decoded.elicitations[0],
    dispatched: any[] = [];
  const env: any = {
    bd: { UNSPECIFIED: 0, ONCE: 1, ALWAYS: 2, PER_CHAT: 3, SITE: 4 },
    Of: { APPROVED: 1, DECLINED: 2 },
    Bd: { QUESTION: 2 },
    XS: new Set(["allow_all_scheduled_runs"]),
    rre: "allow_site",
    ZS: {},
    QS: "decision",
    le: false,
    ue: undefined,
    Se: undefined,
    t: {},
    h: card.elicitationId,
    g: card.elicitationId,
    c: card.askNonce,
    d,
    fN: () => undefined,
    vC: () => {},
    tre: () => [],
    n: (...args: any[]) => {
      const [id, fields, nonce, typed] = args;
      const action = env.R5(id, nonce, fields, typed);
      dispatched.push(action);
      return action;
    },
  };
  vm.createContext(env);
  vm.runInContext(functions.join("\n"), env);
  env.k = env.rC(d.request);
  const respond = vm.runInContext("(" + callbackSource + ")", env);
  const route = async (action: any) => {
    const schema = registry.getMessage(pkg + "PerformActionRequest")!;
    const req: any = fromBinary(
      schema,
      toBinary(
        schema,
        deepCreate(schema, { header: { conversationId: "c" }, action }),
      ),
    );
    return respondToCommandElicitation(
      { commandDeclines: host, isCurrent: () => active },
      "c",
      req.action.value,
    );
  };
  return {
    env,
    respond,
    route,
    dispatched,
    host,
    card,
    calls: () => calls,
    retire: () => {
      active = false;
    },
  };
}

test("the original pinned offer parser recognizes only the decline vocabulary", () => {
  const f = fixture();
  assert.equal(f.env.k.declineOnly, true);
  assert.equal(f.env.k.source, "vocabulary");
  assert.deepEqual(Object.keys(f.env.k.byDecision), ["deny"]);
  assert.equal(f.env.k.offersPerChat, false);
  assert.equal(f.env.k.site, undefined);
});
test("the exact original callback and action builder roundtrip through the adapter", async () => {
  const f = fixture(),
    action = await f.respond("deny");
  assert.equal(action.value.askNonce, f.card.askNonce);
  assert.equal(action.value.elicitationId, f.card.elicitationId);
  assert.equal(action.value.response.verdict, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(action.value.response.values)), [
    { fieldName: "decision", value: { case: "stringValue", value: "deny" } },
    {
      fieldName: "tool_use_id",
      value: { case: "stringValue", value: f.card.elicitationId },
    },
  ]);
  assert.equal(await f.route(action), undefined);
  assert.equal(f.calls(), 1);
  assert.equal(await f.route(action), undefined);
  assert.equal(f.calls(), 1);
});
for (const choice of ["once", "always", "perChat", "site", "allow"])
  test(`original decline-only callback cannot submit ${choice}`, async () => {
    const f = fixture();
    await assert.rejects(() => f.respond(choice), /offers only a decline/);
    assert.equal(f.dispatched.length, 0);
    assert.equal(f.calls(), 0);
  });
test("original optional denial feedback remains outside this scoped contract", async () => {
  const f = fixture(),
    action = await f.respond("deny", {
      _feedbackMessage: "optional explanation",
    });
  assert.equal(action.value.response.values.length, 3);
  assert.ok(await f.route(action));
  assert.equal(f.calls(), 0);
});
test("a cached original callback cannot dispatch after account retirement", async () => {
  const f = fixture(),
    action = await f.respond("deny");
  f.retire();
  assert.equal((await f.route(action))?.code, "elicitation_unavailable");
  assert.equal(f.calls(), 0);
});
test("unknown outcome from the original callback is not replayed by another press", async () => {
  const f = fixture(true);
  assert.equal(
    (await f.route(await f.respond("deny")))?.code,
    "elicitation_unconfirmed",
  );
  assert.equal(
    (await f.route(await f.respond("deny")))?.code,
    "elicitation_unconfirmed",
  );
  assert.equal(f.calls(), 1);
  assert.equal(f.host.list("c")[0].state, "unconfirmed");
});
