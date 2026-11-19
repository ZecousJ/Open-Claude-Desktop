/** Pinned protocol + inert host methods. No engine/SDK/model/network calls. */
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { toBinary, fromBinary, toJson } from "@bufbuild/protobuf";
import { loadRegistry, deepCreate } from "../electron/official-ui/api/timeline";
import {
  createActionRpc,
  PERFORM_ACTION_PATH,
} from "../electron/official-ui/api/actions";
import {
  messageIndex,
  type MessageRef,
} from "../electron/official-ui/api/conversations";
import {
  inAdapterScope,
  newAdapterScope,
} from "../electron/official-ui/api/scope";
const r = loadRegistry("build/official-ui/data/conversation-protocol.json"),
  pkg = "anthropic.bard.api.v1alpha",
  input = r.getMessage(pkg + ".PerformActionRequest")!,
  output = r.getMessage(pkg + ".PerformActionResponse")!;
async function run(
  send: any,
  options: {
    binary?: boolean;
    result?: unknown;
    fail?: boolean;
    strict?: boolean;
    readFailure?: boolean;
  } = {},
) {
  const calls: any[] = [];
  return inAdapterScope(newAdapterScope("edit-fixture"), async () => {
    const turns = ["t1", "t2"].map((id) => ({
      id,
      prompt: id,
      items: [],
      attachments: [],
      status: "completed",
    }));
    const conversation = { id: "c", providerId: "p", model: "m", turns };
    messageIndex.set(
      "c",
      new Map<string, MessageRef>(
        turns.flatMap<readonly [string, MessageRef]>(
          (t) =>
            [
              [
                "u" + t.id,
                {
                  turnId: t.id,
                  kind: "user" as const,
                  branchId: "original",
                  active: true,
                },
              ],
              [
                "a" + t.id,
                {
                  turnId: t.id,
                  kind: "assistant" as const,
                  branchId: "original",
                  active: true,
                },
              ],
            ] as const,
        ),
      ),
    );
    const identity = {};
    const ctx: any = {
      account: () => ({ id: "edit-fixture" }),
      sessionIdentity: () => identity,
      isCurrent: () => true,
      strictActionSemantics: options.strict ?? true,
        settings: () => ({
        providers: [{ id: "p", backend: "sub2api", model: "m" }],
      }),
      modelCatalog: () => ({ items: [{ id: "m", efforts: ["low"] }] }),
      loadConversation: async () => { if(options.readFailure) throw Error("inert source unavailable"); return conversation; },
      call: async (name: string, ...args: any[]) => {
        calls.push([name, ...args]);
        if (options.fail) throw Error("inert failure");
        return Object.hasOwn(options, "result")
          ? options.result
          : {
              ...conversation,
              turns: [...turns, { ...turns[0], id: "new-turn" }],
            };
      },
      log() {},
    };
    const msg = deepCreate(input, {
      header: { conversationId: "c" },
      action: {
        case: "sendMessage",
        value: {
          messageId: "new-user",
          assistantMessageId: "new-assistant",
          ...send,
        },
      },
    });
    const binary = options.binary ?? true;
    const req: any = Readable.from([
      binary
        ? Buffer.from(toBinary(input, msg))
        : Buffer.from(
            JSON.stringify(toJson(input, msg, { useProtoFieldName: true })),
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
    await createActionRpc(ctx, r)(req, res, PERFORM_ACTION_PATH);
    return { calls, answer };
  });
}
const applied = (a: any) => a?.ack?.outcome?.case === "applied";
test("first prompt and earlier assistant edit use exact turn under strict adapter", async () => {
  for (const binary of [false, true])
    for (const [parent, id] of [
      ["", "t1"],
      ["at1", "t2"],
    ]) {
      const x = await run(
        { parentMessageId: parent, text: "edited" },
        { binary },
      );
      assert.equal(applied(x.answer), true, JSON.stringify(x.answer));
      assert.deepEqual(x.calls, [
        ["editPrompt", "c", id, "edited", "p", "m", { attachments: [] }],
      ]);
    }
});
test("explicit retry under user prompt targets that turn rather than editing or sending", async () => {
  for (const binary of [false, true]) {
    const x = await run({ parentMessageId: "ut1", inputMode: 2 }, { binary });
    assert.equal(applied(x.answer), true);
    assert.deepEqual(x.calls, [["retryResponse", "c", "t1", "p", "m"]]);
  }
});
test("unknown parent never falls back to plain send even on nonstrict native adapter", async () => {
  const x = await run(
    { parentMessageId: "missing", text: "edit" },
    { strict: false },
  );
  assert.equal(applied(x.answer), false);
  assert.equal(x.calls.length, 0);
});
test("edit missing or unchanged returned turn is not reported applied", async () => {
  for (const result of [
    undefined,
    { id: "other", turns: [{ id: "new" }] },
    { id: "c", turns: [{ id: "t1" }, { id: "t2" }] },
  ]) {
    const x = await run(
      { parentMessageId: "", text: "edit" },
      { strict: false, result },
    );
    assert.equal(applied(x.answer), false);
    assert.equal(x.calls.length, 1);
  }
});
test("absent parent is append, explicit root is edit, and latest assistant parent is follow-up", async () => {
  for (const binary of [false, true])
    for (const send of [
      { text: "new" },
      { parentMessageId: "at2", text: "new" },
    ]) {
      const x = await run(send, { binary });
      assert.equal(applied(x.answer), true);
      assert.equal(x.calls[0][0], "send");
    }
});
test("wrong user edit parent, retry without target and unknown effort reject before effects", async () => {
  for (const send of [
    { parentMessageId: "ut1", text: "edited" },
    { inputMode: 2 },
    {
      parentMessageId: "ut1",
      inputMode: 2,
      settingsUpdate: { settings: { effortLevelToken: "invented" } },
    },
  ]) {
    const x = await run(send);
    assert.equal(applied(x.answer), false);
    assert.equal(x.calls.length, 0);
  }
});
test("declared unknown replacement attachment rejects before edit rather than silently disappearing", async () => {
  const x = await run({
    parentMessageId: "",
    text: "edited",
    attachments: [{ id: "not-owned" }],
  });
  assert.equal(applied(x.answer), false);
  assert.equal(x.calls.length, 0);
});
test("explicit supported effort is forwarded, not ignored, and service failure is not applied", async () => {
  const good = await run({
    parentMessageId: "ut1",
    inputMode: 2,
    settingsUpdate: { settings: { effortLevelToken: "low" } },
  });
  assert.equal(applied(good.answer), true);
  assert.deepEqual(good.calls[0].at(-1), { effort: "low" });
  const bad = await run(
    { parentMessageId: "", text: "edited" },
    { fail: true },
  );
  assert.equal(applied(bad.answer), false);
  assert.equal(bad.calls.length, 1);
});
test('root edit source-read failure never becomes a new conversation send',async()=>{
 for(const binary of [false,true]){const x=await run({parentMessageId:'',text:'edited'},{binary,readFailure:true});assert.equal(applied(x.answer),false);assert.equal(x.calls.length,0);}
});
