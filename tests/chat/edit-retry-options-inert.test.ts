/** Exported functions on inert contexts, no Engine/SDK construction or provider calls. */
import test from "node:test";
import assert from "node:assert/strict";
import { editPrompt, retryResponse } from "../../electron/engine/engine-send";
function setup() {
  const old = {
      id: "old-file",
      path: "/inert-owned/old.txt",
      name: "old.txt",
      kind: "text" as const,
      size: 1,
    },
    added = {
      id: "new-file",
      path: "/inert-owned/new.txt",
      name: "new.txt",
      kind: "text" as const,
      size: 1,
    };
  const source: any = {
    id: "c",
    mode: "chat",
    turns: [{ id: "t", prompt: "original", attachments: [old] }],
  };
  const sends: any[] = [];
  const e: any = {
    elsewhereFor: () => undefined,
    store: { conversation: () => source },
    modelEfforts: () => ["low"],
    send: async (...args: any[]) => {
      sends.push(args);
      return source;
    },
  };
  return { e, old, added, sends };
}
test("undefined options preserve original attachments, explicit empty clears and replacement uses owned attachments", async () => {
  for (const edit of [false, true])
    for (const mode of ["absent", "clear", "replace"]) {
      const f = setup();
      const options =
        mode === "absent"
          ? undefined
          : {
              attachments: mode === "clear" ? [] : [f.added],
              effort: "low" as const,
            };
      if (edit)
        await editPrompt.call(f.e, "c", "t", "edited", "p", "m", options);
      else await retryResponse.call(f.e, "c", "t", "p", "m", options);
      assert.deepEqual(
        f.sends[0][0].attachments,
        mode === "absent" ? [f.old] : mode === "clear" ? [] : [f.added],
      );
      assert.equal(f.sends[0][0].effort, mode === "absent" ? undefined : "low");
      assert.equal(f.sends[0][1], "t");
      assert.equal(f.sends[0][2], edit || mode !== "absent");
    }
});
test("unknown or unavailable model effort refuses before send", async () => {
  for (const efforts of [undefined, [], ["medium"]]) {
    const f = setup();
    f.e.modelEfforts = () => efforts;
    await assert.rejects(
      retryResponse.call(f.e, "c", "t", "p", "m", { effort: "low" }),
      /support/,
    );
    assert.equal(f.sends.length, 0);
  }
});
test("peer engine receives explicit version overrides without executing a local send", async () => {
  const f = setup();
  let args: any[] = [];
  f.e.elsewhereFor = () => ({
    editPrompt: async (...a: any[]) => {
      args = a;
      return {};
    },
  });
  const options = { attachments: [], effort: "low" as const };
  await editPrompt.call(f.e, "c", "t", "edited", "p", "m", options);
  assert.equal(args[5], options);
  assert.equal(f.sends.length, 0);
});
test("attachment-only and effort-only edits work while unchanged legacy prompt still refuses", async () => {
  const f = setup();
  await editPrompt.call(f.e, "c", "t", "original", "p", "m", {
    attachments: [],
  });
  assert.deepEqual(f.sends[0][0].attachments, []);
  const g = setup();
  await editPrompt.call(g.e, "c", "t", "original", "p", "m", { effort: "low" });
  assert.equal(g.sends[0][0].effort, "low");
  const h = setup();
  await assert.rejects(
    editPrompt.call(h.e, "c", "t", "original", "p", "m"),
    /Change the message/,
  );
  assert.equal(h.sends.length, 0);
});
