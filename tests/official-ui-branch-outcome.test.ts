/** Actual pinned request descriptor, inert service spies; never executes engine/SDK. */
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { toBinary, toJson, fromBinary } from "@bufbuild/protobuf";
import { loadRegistry, deepCreate } from "../electron/official-ui/api/timeline";
import {
  createActionRpc,
  PERFORM_ACTION_PATH,
} from "../electron/official-ui/api/actions";
import { messageIndex } from "../electron/official-ui/api/conversations";
import {
  newAdapterScope,
  inAdapterScope,
} from "../electron/official-ui/api/scope";
const registry = loadRegistry(
    "build/official-ui/data/conversation-protocol.json",
  ),
  pkg = "anthropic.bard.api.v1alpha";
const input = registry.getMessage(pkg + ".PerformActionRequest")!,
  output = registry.getMessage(pkg + ".PerformActionResponse")!;
const destination = "00000000-0000-4000-8000-000000000007";

async function request(
  kind: string,
  value: any,
  options: {
    binary?: boolean;
    active?: boolean;
    missing?: boolean;
    fork?: unknown;
    turnMissing?: boolean;
    fail?: boolean;
    wrongBranch?: boolean;
    user?: boolean;
  } = {},
) {
  const calls: any[] = [];
  return inAdapterScope(newAdapterScope("branch-fixture"), async () => {
    messageIndex.set(
      "source",
      new Map([
        [
          "reply",
          {
            turnId: "turn",
            kind: options.user ? "user" : "assistant",
            branchId: options.wrongBranch ? "foreign" : "original",
            active: options.active ?? true,
          },
        ],
      ]),
    );
    const turn = { id: "turn", status: "completed", responseGroupId: "group" };
    const source = {
      id: "source",
      mode: "chat",
      turns: options.turnMissing
        ? []
        : [options.active === false ? { ...turn, id: "current" } : turn],
      savedBranches:
        options.active === false ? [{ id: "original", turns: [turn] }] : [],
    };
    const route = createActionRpc(
      {
        account: () => ({ id: "test-account" }),
        sessionIdentity: () => "test-activation",
        loadConversation: async (id: string) =>
          options.missing ? undefined : id === "source" ? source : undefined,
        call: async (name: string, ...args: unknown[]) => {
          calls.push([name, ...args]);
          if (options.fail) throw Error("sensitive inert fork failure");
          return name === "forkConversation"
            ? (Object.hasOwn(options,"fork") ? options.fork : { id: destination, forkedFrom: { conversationId: "source", turnId: "turn" } })
            : source;
        },
        log() {},
      } as never,
      registry,
    );
    const message = deepCreate(input, {
      header: {
        conversationId: kind === "setCurrentLeaf" ? "source" : destination,
      },
      action: { case: kind, value },
    });
    const binary = options.binary ?? false;
    const req: any = Readable.from([
      binary
        ? Buffer.from(toBinary(input, message))
        : Buffer.from(
            JSON.stringify(toJson(input, message, { useProtoFieldName: true })),
          ),
    ]);
    req.method = "POST";
    req.headers = {
      "content-type": binary ? "application/proto" : "application/json",
    };
    let answer: any;
    const res: any = {
      writeHead() {},
      end(b: any) {
        answer = binary ? fromBinary(output, b) : JSON.parse(String(b));
      },
    };
    await route(req, res, PERFORM_ACTION_PATH);
    return { calls, answer };
  });
}
const applied = (a: any) =>
  a?.ack?.outcome?.case === "applied" || a?.ack?.applied === true;
test("unknown leaf and vanished active turn refuse rather than silently acknowledge", async () => {
  for (const binary of [false, true])
    for (const [id, opts] of [
      ["unknown", {}],
      ["reply", { turnMissing: true }],
      ["reply", { missing: true }],
    ] as const) {
      const r = await request(
        "setCurrentLeaf",
        { currentLeafMessageId: id },
        { binary, ...opts },
      );
      assert.equal(applied(r.answer), false);
      assert.equal(r.calls.length, 0);
    }
});
test("unknown through never falls back to latest or another conversation", async () => {
  for (const binary of [false, true]) {
    const r = await request(
      "continueBranchAsNewChat",
      { sourceConversationId: "source", throughMessageId: "unknown" },
      { binary },
    );
    assert.equal(applied(r.answer), false);
    assert.equal(r.calls.length, 0);
  }
});
test("saved branch fork uses explicit branch without any temporary source mutation", async () => {
  const r = await request(
    "continueBranchAsNewChat",
    { sourceConversationId: "source", throughMessageId: "reply" },
    { active: false },
  );
  assert.equal(applied(r.answer), true);
  assert.deepEqual(r.calls, [
    ["forkConversation", "source", { conversationId: destination, turnId: "turn", branchId: "original" }],
  ]);
});
test("valid active completed assistant fork preserves explicit target", async () => {
  for (const binary of [false, true]) {
    const r = await request(
      "continueBranchAsNewChat",
      { sourceConversationId: "source", throughMessageId: "reply" },
      { binary },
    );
    assert.equal(applied(r.answer), true, JSON.stringify(r.answer));
    assert.deepEqual(r.calls, [
      ["forkConversation", "source", { conversationId: destination, turnId: "turn" }],
    ]);
  }
});
test('missing, user or mismatched saved-branch targets never call backend',async()=>{
 for(const binary of [false,true])for(const options of [{missing:true},{user:true},{active:false,wrongBranch:true}]){
 const r=await request('continueBranchAsNewChat',{sourceConversationId:'source',throughMessageId:'reply'},{binary,...options});assert.equal(applied(r.answer),false);assert.equal(r.calls.length,0);
 }
});
test('fork failure or malformed result never aliases or reports applied, and is not retried',async()=>{
 for(const binary of [false,true])for(const options of [{fail:true},{fork:null},{fork:{}},{fork:{id:'source'}}]){
 const r=await request('continueBranchAsNewChat',{sourceConversationId:'source',throughMessageId:'reply'},{binary,...options});assert.equal(applied(r.answer),false);assert.equal(r.calls.length,1);assert.doesNotMatch(JSON.stringify(r.answer),/sensitive inert/);
 }
});
