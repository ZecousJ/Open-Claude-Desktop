import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  draftPlace,
  forgetAccountDrafts,
  forgetDraft,
  readDraft,
  resetDraftMemory,
  restoresOnSwitch,
  storedLimit,
  writeDraft,
  type DraftStorage,
} from "../../src/composer/draft-store";
import type { Attachment } from "../../shared/types";

/** A browser storage for the tests, since Node has none. */
class MemoryStorage implements DraftStorage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

const file: Attachment = {
  id: "a1",
  name: "notes.txt",
  path: "/tmp/notes.txt",
  kind: "text",
  size: 4,
};

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  resetDraftMemory();
});

test("each conversation and each home has its own place", () => {
  assert.deepEqual(draftPlace({ conversationId: "c1", mode: "chat" }), {
    key: "c1",
    persist: true,
  });
  // Chat and Cowork share the home; Code has its own.
  assert.equal(draftPlace({ mode: "chat" }).key, "new:chat");
  assert.equal(draftPlace({ mode: "cowork" }).key, "new:chat");
  assert.equal(draftPlace({ mode: "code" }).key, "new:code");
  // Incognito and a split pane's new session are never stored.
  assert.equal(draftPlace({ mode: "chat", incognito: true }).persist, false);
  assert.equal(
    draftPlace({ conversationId: "c2", mode: "chat", incognito: true }).persist,
    false,
  );
  assert.deepEqual(draftPlace({ mode: "code", pane: "p1" }), {
    key: "pane:p1",
    persist: false,
  });
  assert.equal(
    draftPlace({ conversationId: "c3", mode: "code", pane: "p1" }).key,
    "c3",
  );
});

test("a draft comes back for its place and its account only", () => {
  const place = draftPlace({ conversationId: "c1", mode: "chat" });
  writeDraft(
    "me",
    place,
    { text: "half a thought", attachments: [file] },
    storage,
  );
  assert.deepEqual(readDraft("me", place, storage), {
    text: "half a thought",
    attachments: [file],
  });
  assert.equal(readDraft("someone", place, storage), undefined);
  assert.equal(
    readDraft(
      "me",
      draftPlace({ conversationId: "c2", mode: "chat" }),
      storage,
    ),
    undefined,
  );
});

test("the text outlives the window; attached files do not", () => {
  const place = draftPlace({ mode: "code" });
  writeDraft(
    "me",
    place,
    { text: "fix the build", attachments: [file] },
    storage,
  );
  resetDraftMemory();
  assert.deepEqual(readDraft("me", place, storage), {
    text: "fix the build",
    attachments: [],
  });
});

test("an incognito draft is never written to storage", () => {
  const place = draftPlace({ mode: "chat", incognito: true });
  writeDraft("me", place, { text: "secret", attachments: [] }, storage);
  assert.equal(storage.length, 0);
  assert.equal(readDraft("me", place, storage)?.text, "secret");
  resetDraftMemory();
  assert.equal(readDraft("me", place, storage), undefined);
});

test("an emptied draft is forgotten", () => {
  const place = draftPlace({ conversationId: "c1", mode: "chat" });
  writeDraft("me", place, { text: "x", attachments: [] }, storage);
  writeDraft("me", place, { text: "", attachments: [] }, storage);
  assert.equal(storage.length, 0);
  assert.equal(readDraft("me", place, storage), undefined);
  writeDraft("me", place, { text: "y", attachments: [] }, storage);
  forgetDraft("me", place, storage);
  assert.equal(readDraft("me", place, storage), undefined);
});

test("only the newest drafts are kept", () => {
  for (let index = 0; index < storedLimit + 5; index++)
    writeDraft(
      "me",
      draftPlace({ conversationId: `c${index}`, mode: "chat" }),
      { text: `draft ${index}`, attachments: [] },
      storage,
      1000 + index,
    );
  resetDraftMemory();
  assert.equal(storage.length, storedLimit);
  assert.equal(
    readDraft(
      "me",
      draftPlace({ conversationId: "c0", mode: "chat" }),
      storage,
    ),
    undefined,
  );
  assert.equal(
    readDraft(
      "me",
      draftPlace({ conversationId: `c${storedLimit + 4}`, mode: "chat" }),
      storage,
    )?.text,
    `draft ${storedLimit + 4}`,
  );
});

test("switching places restores, unless the switch brought new text", () => {
  const before = { text: "for c1", attachments: [] };
  // Opening another conversation empties the composer: its draft comes back.
  assert.equal(restoresOnSwitch(before, { text: "", attachments: [] }), true);
  // New chat leaves the composer as it was: the home's draft comes back.
  assert.equal(restoresOnSwitch(before, before), true);
  // A fork opened with its message in the composer keeps that message.
  assert.equal(
    restoresOnSwitch(before, { text: "the forked prompt", attachments: [] }),
    false,
  );
  assert.equal(
    restoresOnSwitch(undefined, { text: "x", attachments: [] }),
    true,
  );
});

test("signing out forgets the account's drafts only", () => {
  const mine = draftPlace({ conversationId: "c1", mode: "chat" });
  writeDraft("me", mine, { text: "mine", attachments: [] }, storage);
  writeDraft("other", mine, { text: "theirs", attachments: [] }, storage);
  forgetAccountDrafts("me", storage);
  assert.equal(readDraft("me", mine, storage), undefined);
  assert.equal(readDraft("other", mine, storage)?.text, "theirs");
});
