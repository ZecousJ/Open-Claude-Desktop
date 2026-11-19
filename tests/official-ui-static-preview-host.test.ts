/** Actual host glue and content collector, fake account source/window/opener. No Electron import/runtime. */
import test from "node:test";
import assert from "node:assert/strict";
import { createStaticArtifactPreviewHost } from "../electron/official-ui/preview/static-host";
import { conversationSnippets } from "../electron/official-ui/api/artifacts";
import type { Conversation } from "../shared/types";
import type { AdapterContext } from "../electron/official-ui/api/context";
function fixture() {
  let active = true,
    activation = 1,
    root = "/inert/A",
    sourceReads = 0;
  const originalWindow = { isDestroyed: () => false };
  let window: typeof originalWindow | undefined = originalWindow;
  const c: Conversation = {
    id: "inert-chat",
    title: "Example",
    mode: "chat",
    model: "inert",
    providerId: "inert",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "turn",
        prompt: "inert",
        attachments: [],
        status: "completed",
        createdAt: 1,
        items: [
          {
            id: "answer",
            type: "agentMessage",
            text: "```html\n<h1>Inert</h1>\n```",
          },
        ],
      },
    ],
  };
  const snippet = conversationSnippets("A", c)[0];
  let onRead = async () => {},
    onOpen = async () => {};
  const openings: any[] = [];
  let listener = () => {},
    unsubscribe = 0;
  const ctx = {
    account: () => ({ id: "A" }),
    sessionIdentity: () => activation,
    stateDirectory: () => root,
    isCurrent: () => active,
    loadConversation: async () => {
      sourceReads++;
      await onRead();
      return c;
    },
    log: () => {},
  } as unknown as AdapterContext;
  const onRetire = (fn: () => void) => {
    listener = fn;
    return () => {
      unsubscribe++;
    };
  };
  const run = createStaticArtifactPreviewHost(ctx, {
    current: () => active,
    committedWindow: () => window as any,
    onRetire,
    preloadPath: "/fixed/packaged/static-preload.cjs",
    open: async (options) => {
      openings.push(options);
      await onOpen();
      return { opened: true };
    },
  });
  return {
    run,
    selection: {
      conversationId: c.id,
      artifactId: snippet.artifact_uuid,
      versionId: snippet.uuid,
    },
    originalWindow,
    openings,
    onRetire,
    reads: () => sourceReads,
    unsubscribe: () => unsubscribe,
    emit: () => listener(),
    clearWindow: () => (window = undefined),
    replaceWindow: () => (window = { isDestroyed: () => false }),
    retire: () => {
      active = false;
      activation++;
    },
    replaceRoot: () => (root = "/inert/B"),
    onRead: (fn: () => Promise<void>) => (onRead = fn),
    onOpen: (fn: () => Promise<void>) => (onOpen = fn),
  };
}
test("committed owner and exact source selection reach packaged opener, with retirement callback bound", async () => {
  const f = fixture();
  assert.deepEqual(await f.run(f.selection), { opened: true });
  assert.equal(f.openings.length, 1);
  const o = f.openings[0];
  assert.equal(o.ownerWindow, f.originalWindow);
  assert.equal(o.preloadPath, "/fixed/packaged/static-preload.cjs");
  assert.equal(o.onRetire, f.onRetire);
  assert.ok(o.document.includes("<h1>Inert</h1>"));
  assert.equal(o.current(), true);
  let notified = 0;
  const off = o.onRetire(() => notified++);
  f.emit();
  assert.equal(notified, 1);
  off();
  assert.equal(f.unsubscribe(), 1);
  f.retire();
  assert.equal(o.current(), false);
});
test("missing staged or non-runtime committed window is rejected before reading account source", async () => {
  const f = fixture();
  f.clearWindow();
  await assert.rejects(f.run(f.selection), /current account window/);
  assert.equal(f.reads(), 0);
  assert.equal(f.openings.length, 0);
});
test("window replacement or activation retirement while reading source never invokes opener", async () => {
  for (const change of ["window", "retire", "root"]) {
    const f = fixture();
    f.onRead(async () => {
      if (change === "window") f.replaceWindow();
      else if (change === "retire") f.retire();
      else f.replaceRoot();
    });
    await assert.rejects(f.run(f.selection), /changed/);
    assert.equal(f.openings.length, 0);
  }
});
test("window disappearance or account retirement while opener awaits cannot report current opened", async () => {
  for (const change of ["window", "retire"]) {
    const f = fixture();
    f.onOpen(async () => {
      if (change === "window") f.replaceWindow();
      else f.retire();
    });
    await assert.rejects(f.run(f.selection), /changed/);
    assert.equal(f.openings.length, 1);
    assert.equal(f.openings[0].current(), false);
  }
});
test("real source errors and wrong version are propagated without opening a preview", async () => {
  const f = fixture();
  f.onRead(async () => {
    throw Error("inert source error");
  });
  await assert.rejects(f.run(f.selection), /source error/);
  assert.equal(f.openings.length, 0);
  const g = fixture();
  await assert.rejects(
    g.run({
      ...g.selection,
      versionId: "11111111-1111-4111-8111-111111111111",
    }),
    /version/,
  );
  assert.equal(g.openings.length, 0);
});
