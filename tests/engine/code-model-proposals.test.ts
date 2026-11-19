import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { AppContext } from "../../electron/app/app-context";
import {
  actOnCodeModelProposal,
  recordCodeModelProposal,
} from "../../electron/engine/code-model-proposals";
import type { SendInput } from "../../electron/engine/new-conversation";
import { Store } from "../../electron/store/store";
import type { Conversation } from "../../shared/types";

test("concurrent and reopened Code proposal accepts use one linked child and one dispatch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "code-model-proposal-"));
  try {
    let store = new Store(root);
    const provider = store.settings.providers[0];
    const now = Date.now();
    const parent: Conversation = {
      id: randomUUID(),
      mode: "code",
      title: "Proposal parent",
      model: provider.model,
      providerId: provider.id,
      cwd: root,
      createdAt: now,
      updatedAt: now,
      archived: false,
      pinned: false,
      turns: [
        {
          id: "source",
          status: "completed",
          createdAt: now,
          prompt: "Parent prompt",
          items: [],
          attachments: [],
        },
      ],
    };
    store.conversations.push(parent);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine = {
      changed() {},
      async send(input: SendInput) {
        calls++;
        assert.equal(input.text, "Stored brief");
        assert.equal(input.parentSessionId, parent.id);
        await gate;
        assert.ok(input.conversationId);
        const child = store.conversation(input.conversationId);
        child.turns.push({
          id: "child-turn",
          officialCodeEventId: input.officialCodeEventId,
          status: "completed",
          createdAt: now,
          prompt: input.text,
          items: [],
          attachments: [],
        });
        store.flush();
      },
    };
    const ctx = {
      get store() {
        return store;
      },
      engine,
      activeAccount: { id: "fixture" },
      accountActivationIdentity: {},
      allowedFolder(folder: string) {
        assert.equal(folder, root);
      },
    } as unknown as AppContext;
    const current = () => true;
    const proposal = recordCodeModelProposal(
      ctx,
      { current, parent },
      {
        kind: "suggestion",
        context: "fresh",
        title: "Child",
        brief: "Stored brief",
        providerId: provider.id,
        sourceTurnId: "source",
        sourceCwd: root,
      },
    );
    assert.equal(store.conversations.length, 1);
    const childId = randomUUID();
    const accept = (requestedId: string) =>
      actOnCodeModelProposal(
        ctx,
        parent.id,
        proposal.id,
        { kind: "start", requestedId },
        current,
      );
    const first = accept(childId);
    const concurrent = accept(randomUUID());
    await Promise.resolve();
    assert.equal(calls, 1);
    const stored = new Store(root).conversation(childId);
    assert.equal(stored.parentSessionId, parent.id);
    assert.equal(stored.nativeSideSession?.taskId, proposal.id);
    release();
    const expected = { sessionId: `local_${childId}` };
    assert.deepEqual(await Promise.all([first, concurrent]), [
      expected,
      expected,
    ]);
    store = new Store(root);
    assert.deepEqual(await accept(randomUUID()), expected);
    assert.equal(store.conversations.length, 2);
    assert.equal(calls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
