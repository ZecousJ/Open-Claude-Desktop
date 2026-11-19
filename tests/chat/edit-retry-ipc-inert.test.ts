/** Actual IPC registration with inert owned attachment map and engine spies. */
import test from "node:test";
import assert from "node:assert/strict";
import { registerConversationTurnHandlers } from "../../electron/ipc/conversation-turn-handlers";
function setup() {
  const handlers = new Map<string, any>(),
    calls: any[] = [];
  const attachment = {
    id: "owned",
    path: "/inert-owned/file.txt",
    name: "file.txt",
  };
  const conversation = { id: "c", mode: "chat", turns: [] };
  const context: any = {
    accountActivationIdentity: {},
    accountRetiring: false,
    activeAccount: { id: "a" },
    store: { root: "/inert-version-fixture", conversation: () => conversation },
    selectedAttachments: new Map([["owned", attachment]]),
    engine: {
      editPrompt: async (...args: any[]) => {
        calls.push(args);
        return conversation;
      },
      retryResponse: async (...args: any[]) => {
        calls.push(args);
        return conversation;
      },
    },
  };
  registerConversationTurnHandlers({
    context,
    handle: (n: string, f: (...args: any[]) => any) => handlers.set(n, f),
    cli: {},
    resumable: {},
  } as any);
  return { context, handlers, calls, attachment };
}
test("IPC options distinguish omitted files from empty and resolve only owned IDs", async () => {
  for (const name of ["editPrompt", "retryResponse"])
    for (const value of [
      undefined,
      { attachments: [] },
      { attachments: [{ id: "owned" }], effort: "low" },
    ]) {
      const f = setup();
      const args =
        name === "editPrompt"
          ? ["c", "t", "edited", "p", "m"]
          : ["c", "t", "p", "m"];
      await f.handlers.get(name)(...args, value);
      const options = f.calls[0].at(-1);
      assert.equal(typeof options.current, "function");
      assert.equal(options.current(), true);
      assert.deepEqual(
        options.attachments,
        value?.attachments === undefined
          ? undefined
          : value.attachments.length
            ? [f.attachment]
            : [],
      );
      assert.equal(options.effort, value?.effort);
    }
});
test("unknown IDs, supplied paths, forged current and invalid effort refuse before engine mutation", () => {
  for (const raw of [
    { attachments: [{ id: "missing" }] },
    { attachments: [{ id: "owned", path: "/not-owned" }] },
    { current: () => true },
    { effort: "invented" },
  ]) {
    const f = setup();
    assert.throws(() =>
      f.handlers.get("retryResponse")("c", "t", "p", "m", raw),
    );
    assert.equal(f.calls.length, 0);
  }
});
test("actual host predicate rejects account ABA and response retirement without replay", async () => {
  const f = setup();
  let resolve!: (v: any) => void;
  let options: any;
  f.context.engine.retryResponse = async (...args: any[]) => {
    options = args.at(-1);
    return new Promise((r) => (resolve = r));
  };
  const p = f.handlers.get("retryResponse")("c", "t", "p", "m");
  const rejected = assert.rejects(p, /account changed/i);
  f.context.accountActivationIdentity = {};
  assert.equal(options.current(), false);
  resolve({ id: "c" });
  await rejected;
});
