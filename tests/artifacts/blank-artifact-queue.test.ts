import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Conversation, DesktopAPI } from "../../shared/types";
import {
  activateQueuedAccount,
  addQueued,
  queuedMessages,
  removeQueued,
} from "../../src/composer/queue";
import { sendQueuedNow } from "../../src/composer/queue";
import { registerBlankArtifactFlush } from "../../src/artifacts/blank-artifact-flush";
import { workspaceTrustMessage } from "../../shared/workspace-trust-api";
const defer = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const common = {
  text: "Queued real artifact request",
  attachments: [
    {
      id: "owned-file",
      name: "note.txt",
      kind: "text" as const,
      path: "",
      size: 0,
    },
  ],
  mode: "chat" as const,
  providerId: "p",
  model: "m",
  webSearch: false,
  state: "queued" as const,
};
function setup(
  t: { after(fn: () => unknown): unknown },
  extra: Partial<DesktopAPI> = {},
) {
  const id = randomUUID(),
    artifactId = randomUUID(),
    conversation = {
      id,
      title: "Untitled document",
      mode: "chat",
      providerId: "p",
      model: "m",
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 2,
      turns: [],
      cwd: "/owned/paired",
      blankArtifact: {
        id: artifactId,
        kind: "docs",
        file: "document.html",
        name: "Untitled",
        createdAt: 1,
      },
    } as Conversation;
  const sends: any[] = [];
  const bridge = {
    send: async (input: any) => {
      sends.push(input);
      return conversation;
    },
    ...extra,
  } as DesktopAPI;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { desktop: bridge },
  });
  let release = activateQueuedAccount("A");
  t.after(() => {
    for (const entry of queuedMessages(id)) removeQueued(id, entry.id);
    release();
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  return {
    id,
    artifactId,
    conversation,
    bridge,
    sends,
    switch(account: string) {
      release();
      release = activateQueuedAccount(account);
    },
    register(
      account: string,
      flush: () => Promise<boolean>,
      onLock = () => {},
      onRelease = () => {},
    ) {
      const off = registerBlankArtifactFlush(
        { account, owner: {}, bridge, conversationId: id, artifactId },
        {
          flush,
          revision: () => "a".repeat(64),
          lock: () => {
            onLock();
            return onRelease;
          },
        },
      );
      t.after(off);
      return off;
    },
  };
}
test("queued blank requests flush under their real queue scope and send its exact descriptor/revision, releasing only their own lock", async (t) => {
  const e = setup(t);
  let locked = 0,
    released = 0;
  e.register(
    "A",
    async () => true,
    () => locked++,
    () => released++,
  );
  const entry = addQueued(e.id, common);
  assert.equal(await sendQueuedNow(e.conversation, entry.id, () => {}), "sent");
  assert.equal(e.sends.length, 1);
  assert.deepEqual(e.sends[0].blankArtifactRevision, {
    artifactId: e.artifactId,
    revision: "a".repeat(64),
  });
  assert.equal(locked, 1);
  assert.equal(released, 1);
  assert.deepEqual(queuedMessages(e.id), []);
});
for (const outcome of ["refused", "failed"] as const)
  test(`queue prepare ${outcome} keeps the original body and attachments queued with no send`, async (t) => {
    const e = setup(t);
    let released = 0;
    e.register(
      "A",
      async () => {
        if (outcome === "failed") throw new Error("save failed");
        return false;
      },
      () => {},
      () => released++,
    );
    const entry = addQueued(e.id, common);
    assert.equal(
      await sendQueuedNow(e.conversation, entry.id, () => {}),
      "held",
    );
    assert.equal(e.sends.length, 0);
    assert.equal(queuedMessages(e.id)[0].id, entry.id);
    assert.equal(queuedMessages(e.id)[0].text, common.text);
    assert.deepEqual(queuedMessages(e.id)[0].attachments, common.attachments);
    assert.ok(queuedMessages(e.id)[0].error);
    assert.equal(released, 1);
  });
test("same-bridge account replacement during queue preparation preserves A without sending into B or releasing B's new lock", async (t) => {
  const e = setup(t),
    a = defer<boolean>(),
    b = defer<boolean>();
  let releasedA = 0,
    lockedB = 0,
    releasedB = 0;
  e.register(
    "A",
    () => a.promise,
    () => {},
    () => releasedA++,
  );
  const old = addQueued(e.id, common),
    oldRequest = sendQueuedNow(e.conversation, old.id, () => {});
  await new Promise((resolve) => setTimeout(resolve, 15));
  e.switch("B");
  e.register(
    "B",
    () => b.promise,
    () => lockedB++,
    () => releasedB++,
  );
  const own = addQueued(e.id, { ...common, text: "B stays owned" }),
    newRequest = sendQueuedNow(e.conversation, own.id, () => {});
  await new Promise((resolve) => setTimeout(resolve, 10));
  a.resolve(true);
  assert.equal(await oldRequest, "gone");
  assert.equal(e.sends.length, 0);
  assert.equal(releasedA, 1);
  assert.equal(lockedB, 1);
  assert.equal(releasedB, 0);
  assert.equal(queuedMessages(e.id)[0].id, own.id);
  b.resolve(true);
  assert.equal(await newRequest, "sent");
  assert.equal(releasedB, 1);
  assert.equal(e.sends[0].text, "B stays owned");
  e.switch("A");
  assert.equal(queuedMessages(e.id)[0].id, old.id);
  assert.equal(queuedMessages(e.id)[0].text, common.text);
  assert.equal(queuedMessages(e.id)[0].error, undefined);
});
test("the genuine trust retry re-prepares a blank editor and releases each attempt's own save lock", async (t) => {
  const { mountTrustHost, currentTrustQuestion } =
    await import("../../src/workspace-trust/trust-request");
  let attempts = 0,
    locks = 0,
    releases = 0;
  const e = setup(t, {
    send: async () => {
      attempts++;
      if (attempts === 1) throw new Error(workspaceTrustMessage);
      return e.conversation;
    },
    checkWorkspaceTrust: async () => ({
      folder: "/owned/paired",
      root: "/owned/paired",
      sources: [],
      trusted: false,
    }),
    saveWorkspaceTrust: async () => ({
      folder: "/owned/paired",
      root: "/owned/paired",
      sources: [],
      trusted: true,
    }),
  });
  e.register(
    "A",
    async () => true,
    () => locks++,
    () => releases++,
  );
  const unmount = mountTrustHost();
  t.after(unmount);
  const entry = addQueued(e.id, common),
    request = sendQueuedNow(e.conversation, entry.id, () => {});
  for (let i = 0; i < 50 && !currentTrustQuestion(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(currentTrustQuestion());
  assert.equal(releases, 1);
  currentTrustQuestion()!.answer(true);
  assert.equal(await request, "sent");
  assert.equal(attempts, 2);
  assert.equal(locks, 2);
  assert.equal(releases, 2);
});
