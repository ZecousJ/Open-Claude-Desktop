import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { bindOfficialAccountStorage, forgetOfficialAccountDrafts, seedOfficialComposerLayout } from "../../src-web/official/account-storage";
function fixture(account: string, shared?: Storage) {
  const window = new JSDOM("", { url: "http://localhost" }).window;
  if (shared)
    Object.defineProperty(window, "localStorage", {
      value: shared,
      configurable: true,
    });
  const source = window.localStorage;
  const databases: string[] = [];
  Object.defineProperty(window, "indexedDB", {
    value: {
      open: (name: string) => {
        databases.push(name);
        return name;
      },
      deleteDatabase: (name: string) => name,
      databases: async () => databases.map((name) => ({ name, version: 1 })),
    },
    configurable: true,
  });
  const stop = bindOfficialAccountStorage(window as any, account);
  return { window, source, databases, stop };
}
test("the supported composer layout seeds only an absent account latch", () => {
  const a = fixture("alice");
  seedOfficialComposerLayout(a.window.localStorage, "marlin");
  assert.equal(a.window.localStorage.getItem("composer-card-latch"), "marlin");
  assert.equal(a.source.getItem("claudex:official:alice:composer-card-latch"), "marlin");
  a.window.localStorage.setItem("composer-card-latch", "classic");
  seedOfficialComposerLayout(a.window.localStorage, "marlin");
  assert.equal(a.window.localStorage.getItem("composer-card-latch"), "classic");
  const b = fixture("bob", a.source);
  seedOfficialComposerLayout(b.window.localStorage, "unknown");
  assert.equal(b.window.localStorage.getItem("composer-card-latch"), null);
  assert.doesNotThrow(() => seedOfficialComposerLayout({ getItem() { throw Error(); } } as unknown as Storage, "marlin"));
  for (const f of [a, b]) { f.stop(); f.window.close(); }
});
test("account drafts survive reload while other accounts cannot read or clear them or unowned history", () => {
  const a = fixture("alice");
  a.source.setItem("unowned-draft", "old text");
  a.window.localStorage.setItem("composer:new", "Alice draft");
  assert.deepEqual(Object.keys(a.window.localStorage), ["composer:new"]);
  const b = fixture("bob", a.source);
  assert.equal(b.window.localStorage.getItem("composer:new"), null);
  assert.equal(b.window.localStorage.getItem("unowned-draft"), null);
  b.window.localStorage.setItem("composer:new", "Bob draft");
  b.window.localStorage.clear();
  const reopened = fixture("alice", a.source);
  assert.equal(
    reopened.window.localStorage.getItem("composer:new"),
    "Alice draft",
  );
  assert.equal(a.source.getItem("unowned-draft"), "old text");
  assert.equal(reopened.window.localStorage.length, 1);
  assert.equal(reopened.window.localStorage.key(0), "composer:new");
  for (const f of [a, b, reopened]) {
    f.stop();
    f.window.close();
  }
});
test("IndexedDB names and cleanup are account-owned", async () => {
  const a = fixture("alice");
  const b = fixture("bob");
  const an = a.window.indexedDB.open("drafts") as unknown;
  const bn = b.window.indexedDB.open("drafts") as unknown;
  assert.notEqual(an, bn);
  assert.deepEqual(await a.window.indexedDB.databases(), [
    { name: "drafts", version: 1 },
  ]);
  assert.equal(a.window.indexedDB.deleteDatabase("drafts") as unknown, an);
  for (const f of [a, b]) {
    f.stop();
    f.window.close();
  }
});
test("cross-window storage events reach only the owning account using original keys and Storage identity", () => {
  const a = fixture("alice");
  const seen: StorageEvent[] = [];
  a.window.addEventListener("storage", (e) => seen.push(e));
  for (const account of ["bob", "alice"])
    a.window.dispatchEvent(
      new a.window.StorageEvent("storage", {
        storageArea: a.source,
        key: `claudex:official:${account}:draft`,
        newValue: "text",
      }),
    );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].key, "draft");
  assert.equal(seen[0].storageArea, a.window.localStorage);
  a.stop();
  a.window.close();
});

test("sign-out removes only the departing official account's drafts", () => {
  const { window } = new JSDOM("", { url: "https://fixture.invalid" });
  try {
    for (const owner of ["alice", "bob"]) {
      const prefix = `claudex:official:${owner}:`;
      window.localStorage.setItem(prefix + "composer-draft:epitaxy-new", owner);
      window.localStorage.setItem(prefix + "epitaxy-editor-prefs", owner);
      window.sessionStorage.setItem(prefix + "claudex:pending-code-send", owner);
    }
    forgetOfficialAccountDrafts(window, "alice");
    assert.equal(window.localStorage.getItem("claudex:official:alice:composer-draft:epitaxy-new"), null);
    assert.equal(window.localStorage.getItem("claudex:official:bob:composer-draft:epitaxy-new"), "bob");
    assert.equal(window.localStorage.getItem("claudex:official:alice:epitaxy-editor-prefs"), "alice");
    assert.equal(window.sessionStorage.getItem("claudex:official:alice:claudex:pending-code-send"), null);
    assert.equal(window.sessionStorage.getItem("claudex:official:bob:claudex:pending-code-send"), "bob");
  } finally {
    window.close();
  }
});
