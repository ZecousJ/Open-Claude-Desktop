import test from "node:test";
import assert from "node:assert/strict";
import {
  legacyMetadataKey,
  metadataStorageKey,
  scopedMetadataValue,
  legacyCommentStorageKey,
  scopedCommentStorageKey,
  scopedCommentValue,
} from "../../src/artifacts/artifact-storage";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
test("old Artifact names migrate only for conversations belonging to the first account", () => {
  const storage = new MemoryStorage();
  const own = JSON.stringify(["own", "/card.html"]),
    other = JSON.stringify(["other", "/card.html"]);
  storage.setItem(
    legacyMetadataKey,
    JSON.stringify({
      [own]: { name: "Personal", updatedAt: 4 },
      [other]: { name: "Elsewhere", updatedAt: 5 },
    }),
  );
  assert.equal(
    scopedMetadataValue(storage, "account-b", false, new Set(["own"])),
    null,
  );
  const migrated = scopedMetadataValue(
    storage,
    "account-a",
    true,
    new Set(["own"]),
  );
  assert.deepEqual(JSON.parse(migrated!), {
    [own]: { name: "Personal", updatedAt: 4 },
  });
  assert.equal(storage.getItem(metadataStorageKey("account-a")), migrated);
  assert.equal(storage.getItem(metadataStorageKey("account-b")), null);
  storage.setItem(metadataStorageKey("account-a"), "{}");
  assert.equal(
    scopedMetadataValue(storage, "account-a", true, new Set(["own"])),
    "{}",
  );
});
test("Artifact comments cannot cross accounts even when source IDs coincide", () => {
  const storage = new MemoryStorage(),
    legacy = legacyCommentStorageKey("same", "/card.html");
  storage.setItem(legacy, '[{"id":"old"}]');
  assert.equal(
    scopedCommentValue(
      storage,
      "account-b",
      "same",
      "/card.html",
      false,
      new Set(["same"]),
    ),
    null,
  );
  assert.equal(
    scopedCommentValue(
      storage,
      "account-a",
      "same",
      "/card.html",
      true,
      new Set(["same"]),
    ),
    '[{"id":"old"}]',
  );
  assert.equal(
    storage.getItem(scopedCommentStorageKey("account-b", "same", "/card.html")),
    null,
  );
  assert.notEqual(
    scopedCommentStorageKey("account-a", "same", "/card.html"),
    scopedCommentStorageKey("account-b", "same", "/card.html"),
  );
  storage.setItem(
    scopedCommentStorageKey("account-a", "same", "/card.html"),
    "[]",
  );
  assert.equal(
    scopedCommentValue(
      storage,
      "account-a",
      "same",
      "/card.html",
      true,
      new Set(["same"]),
    ),
    "[]",
  );
  assert.equal(
    scopedCommentValue(
      storage,
      "account-a",
      "unknown",
      "/card.html",
      true,
      new Set(["same"]),
    ),
    null,
  );
});
