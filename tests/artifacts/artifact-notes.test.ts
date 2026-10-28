import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ArtifactLibrary,
  ArtifactNotesStore,
  savedReferences,
} from "../../electron/artifacts/artifact-library";
import {
  GeneratedBlobs,
  collectGeneratedSnapshots,
  maxBlobBytes,
} from "../../electron/artifacts/generated-blobs";
import { captureGeneratedFiles } from "../../electron/artifacts/generated-files";
import {
  artifactNoteKey,
  artifactNoteLimits,
} from "../../shared/artifact-notes";
import { artifactIdentity } from "../../src/artifacts/artifact-metadata";
import {
  importStoredArtifactNames,
  storedNamesAsNotes,
  forgetStoredComments,
  forgetStoredNames,
  legacyMetadataKey,
  metadataStorageKey,
  scopedCommentStorageKey,
} from "../../src/artifacts/artifact-storage";

function profile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-notes-"));
  return {
    root,
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("deferred rename migration imports only this account's names and retains storage on failure", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  const identity = JSON.stringify(["own", "/card.html"]);
  const key = metadataStorageKey("account");
  try {
    storage.setItem(
      key,
      JSON.stringify({ [identity]: { name: " Renamed ", updatedAt: 4 } }),
    );
    await assert.rejects(
      importStoredArtifactNames(
        {
          importArtifactNotes: async () => {
            throw new Error("offline");
          },
        },
        "account",
        false,
        new Set(["own"]),
        artifactNoteKey,
      ),
      /offline/,
    );
    assert.notEqual(storage.getItem(key), null);
    const migrated = await importStoredArtifactNames(
      { importArtifactNotes: async (notes) => notes },
      "account",
      false,
      new Set(["own"]),
      artifactNoteKey,
    );
    assert.deepEqual(migrated, {
      [artifactNoteKey(identity)]: {
        conversationId: "own",
        name: "Renamed",
        renamedAt: 4,
      },
    });
    assert.equal(storage.getItem(key), null);
  } finally {
    if (saved) Object.defineProperty(globalThis, "localStorage", saved);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
const comment = (id: string, extra = {}) => ({
  id,
  text: "Make the button blue",
  x: 0.25,
  y: 0.5,
  createdAt: 10,
  resolved: false,
  ...extra,
});

test("note keys are fixed-length, stable and distinct", () => {
  const long = JSON.stringify(["c", "<html>" + "x".repeat(500_000)]);
  assert.match(artifactNoteKey(long), /^[0-9a-f]{32}$/);
  assert.equal(artifactNoteKey(long), artifactNoteKey(long.slice(0)));
  assert.notEqual(
    artifactNoteKey('["c","/a.html"]'),
    artifactNoteKey('["c","/b.html"]'),
  );
});

test("names, open times and comments persist per profile and are validated", () => {
  const p = profile();
  let now = 100;
  try {
    const store = new ArtifactNotesStore(p.root, () => now);
    const key = artifactNoteKey('["chat","/card.html"]');
    assert.deepEqual(
      store.update(key, { conversationId: "chat", name: " Card " }),
      { conversationId: "chat", name: "Card", renamedAt: 100 },
    );
    now = 200;
    store.update(key, { viewed: true, comments: [comment("a")] });
    const again = new ArtifactNotesStore(p.root).all()[key];
    assert.equal(again.name, "Card");
    assert.equal(again.viewedAt, 200);
    assert.equal(again.comments?.[0].text, "Make the button blue");
    for (const [badKey, patch] of [
      ["../../etc", { viewed: true }],
      [key, { name: "" }],
      [key, { name: "x".repeat(201) }],
      [key, { comments: [comment("b", { x: 2 })] }],
      [key, { comments: [comment("b", { text: "x".repeat(10_001) })] }],
      [key, { comments: [comment("b", { extra: 1 })] }],
      [key, { viewed: false }],
    ] as const)
      assert.throws(() => store.update(badKey, patch));
    assert.equal(new ArtifactNotesStore(p.root).all()[key].name, "Card");
  } finally {
    p.close();
  }
});

test("a damaged notes file is reported and kept", () => {
  const p = profile();
  try {
    const file = path.join(p.root, "artifact-notes.json");
    fs.writeFileSync(file, "{broken");
    const store = new ArtifactNotesStore(p.root);
    assert.throws(() => store.all(), /cannot be read/);
    assert.throws(
      () => store.update(artifactNoteKey("x"), { viewed: true }),
      /cannot be read/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), "{broken");
    // Opening the account still works; tidying leaves the file alone.
    fs.writeFileSync(path.join(p.root, "conversations.json"), "[]");
    new ArtifactLibrary(p.root);
    assert.equal(fs.readFileSync(file, "utf8"), "{broken");
  } finally {
    p.close();
  }
});

test("moving window-storage notes keeps what the profile already has", () => {
  const p = profile();
  try {
    const store = new ArtifactNotesStore(p.root, () => 50);
    const kept = artifactNoteKey('["chat","/kept.html"]');
    store.update(kept, { name: "Profile name", comments: [] });
    const moved = storedNamesAsNotes(
      {
        '["chat","/kept.html"]': { name: "Old name", updatedAt: 1 },
        '["chat","/new.html"]': { name: " New name ", updatedAt: 2 },
        '["library","6f0e5d1c-6a5e-4c55-9d8e-2c4c1d0a7b31"]': {
          name: "Copy",
          updatedAt: 3,
        },
        "not json": { name: "Lost", updatedAt: 4 },
      },
      artifactNoteKey,
    );
    assert.equal(Object.keys(moved).length, 3);
    const notes = store.import({
      ...moved,
      notakey: { name: "ignored" },
      [artifactNoteKey("bad")]: { name: 7 },
    });
    assert.equal(notes[kept].name, "Profile name");
    const added = notes[artifactNoteKey('["chat","/new.html"]')];
    assert.deepEqual(added, {
      conversationId: "chat",
      name: "New name",
      renamedAt: 2,
    });
    const copy =
      notes[
        artifactNoteKey('["library","6f0e5d1c-6a5e-4c55-9d8e-2c4c1d0a7b31"]')
      ];
    assert.equal(copy.conversationId, undefined);
    assert.equal(Object.keys(notes).length, 3);
  } finally {
    p.close();
  }
});

test("window-storage keys are removed only for the account that moved them", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => void values.set(k, v),
    removeItem: (k: string) => void values.delete(k),
  };
  for (const key of [
    metadataStorageKey("a"),
    metadataStorageKey("b"),
    legacyMetadataKey,
    scopedCommentStorageKey("a", "chat", "/card.html"),
    scopedCommentStorageKey("b", "chat", "/card.html"),
  ])
    values.set(key, "{}");
  forgetStoredNames(storage, "a", false);
  forgetStoredComments(storage, "a", "chat", "/card.html", false);
  assert.deepEqual(
    [...values.keys()].sort(),
    [
      legacyMetadataKey,
      metadataStorageKey("b"),
      scopedCommentStorageKey("b", "chat", "/card.html"),
    ].sort(),
  );
  forgetStoredNames(storage, "b", true);
  assert.equal(values.has(legacyMetadataKey), false);
});

test("a full notes file forgets the oldest open time, never a name or comment", () => {
  const p = profile();
  try {
    const notes: Record<string, object> = {};
    for (let i = 0; i < artifactNoteLimits.notes; i++)
      notes[artifactNoteKey(`n${i}`)] =
        i === 0 ? { name: "Named", viewedAt: 1 } : { viewedAt: 10 + i };
    fs.writeFileSync(
      path.join(p.root, "artifact-notes.json"),
      JSON.stringify({ version: 1, notes }),
    );
    const store = new ArtifactNotesStore(p.root);
    store.update(artifactNoteKey("new"), { viewed: true });
    const after = store.all();
    assert.equal(Object.keys(after).length, artifactNoteLimits.notes);
    assert.equal(after[artifactNoteKey("n0")].name, "Named");
    assert.equal(after[artifactNoteKey("n1")], undefined);
  } finally {
    p.close();
  }
});

test("opening the account drops leftovers of deleted chats and unused snapshots", () => {
  const p = profile();
  const digest = (c: string) => c.repeat(64);
  const old = Date.now() - 60 * 60 * 1000;
  try {
    fs.writeFileSync(
      path.join(p.root, "conversations.json"),
      JSON.stringify(
        [
          {
            id: "kept-chat",
            turns: [{ items: [{ generatedFiles: [{ digest: digest("a") }] }] }],
          },
        ],
        null,
        2,
      ),
    );
    const blobs = new GeneratedBlobs(p.root);
    for (const c of ["a", "b", "c"]) blobs.put(digest(c), Buffer.from(c));
    const folder = path.join(p.root, "generated-files");
    fs.writeFileSync(path.join(folder, `${digest("d")}.12.tmp`), "partial");
    for (const name of [digest("a"), digest("b"), `${digest("d")}.12.tmp`])
      fs.utimesSync(path.join(folder, name), old / 1000, old / 1000);
    const kept = { id: "k", name: "K", language: "html", content: "" };
    const identity = (conversationId: string) =>
      artifactIdentity({ ...kept, conversationId, sourcePath: "/k.html" });
    const seed = new ArtifactLibrary(p.root);
    seed.pin(identity("kept-chat"), true);
    seed.pin(identity("deleted-chat"), true);
    seed.notes.update(artifactNoteKey(identity("kept-chat")), {
      conversationId: "kept-chat",
      viewed: true,
    });
    seed.notes.update(artifactNoteKey(identity("deleted-chat")), {
      conversationId: "deleted-chat",
      name: "Gone",
    });
    const copy = seed.duplicate({
      name: "Copy",
      language: "html",
      content: "<p>copy</p>",
    }).artifact;
    seed.notes.update(
      artifactNoteKey(JSON.stringify(["library", copy.libraryId])),
      { name: "Copy name" },
    );
    const opened = new ArtifactLibrary(p.root);
    assert.deepEqual(opened.list().pinned, [identity("kept-chat")]);
    const notes = opened.notes.all();
    assert.equal(Object.keys(notes).length, 2);
    assert.equal(notes[artifactNoteKey(identity("deleted-chat"))], undefined);
    assert.deepEqual(fs.readdirSync(folder).sort(), [digest("a"), digest("c")]);
    opened.deleteCopy(copy.libraryId);
    assert.equal(Object.keys(opened.notes.all()).length, 1);
  } finally {
    p.close();
  }
});

test("a snapshot written again is kept by the next collection", () => {
  const p = profile();
  try {
    const blobs = new GeneratedBlobs(p.root);
    const digest = "e".repeat(64);
    blobs.put(digest, Buffer.from("x"));
    const file = path.join(p.root, "generated-files", digest);
    fs.utimesSync(file, 1, 1);
    blobs.put(digest, Buffer.from("x"));
    assert.deepEqual(collectGeneratedSnapshots(p.root, new Set()), {
      files: 0,
      bytes: 0,
    });
    fs.utimesSync(file, 1, 1);
    assert.deepEqual(collectGeneratedSnapshots(p.root, new Set()), {
      files: 1,
      bytes: 1,
    });
  } finally {
    p.close();
  }
});

test("an unreadable history keeps every snapshot", () => {
  const p = profile();
  try {
    fs.mkdirSync(path.join(p.root, "conversations.json"));
    assert.equal(savedReferences(p.root), undefined);
  } finally {
    p.close();
  }
});

test("one file change can snapshot a binary as large as the snapshot store allows", () => {
  const p = profile();
  try {
    const cwd = path.join(p.root, "workspace");
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, "big.pdf"), Buffer.alloc(12 * 1024 * 1024));
    const [file] = captureGeneratedFiles(
      {
        id: "i",
        type: "fileChange",
        status: "completed",
        changes: [{ path: "big.pdf", kind: { type: "add" }, diff: "" }],
      },
      cwd,
      new GeneratedBlobs(p.root),
    );
    assert.equal(file.state, "ready", file.error);
    assert.equal(file.blob, true);
  } finally {
    p.close();
  }
});

test("snapshots are read by digest only, never through links or past the size limit", () => {
  const p = profile();
  try {
    const blobs = new GeneratedBlobs(p.root);
    const folder = path.join(p.root, "generated-files");
    const ok = "1".repeat(64),
      big = "2".repeat(64),
      link = "3".repeat(64);
    blobs.put(ok, Buffer.from("pdf"));
    fs.writeFileSync(path.join(folder, big), Buffer.alloc(maxBlobBytes + 1));
    fs.writeFileSync(path.join(p.root, "outside"), "secret");
    fs.symlinkSync(path.join(p.root, "outside"), path.join(folder, link));
    assert.equal(blobs.read(ok).toString(), "pdf");
    assert.throws(() => blobs.read(big), /no longer available/);
    assert.throws(() => blobs.read(link), /no longer available/);
    assert.throws(() => blobs.read("../outside"), /Invalid file snapshot/);
    assert.throws(() => blobs.read("A".repeat(64)), /Invalid file snapshot/);
  } finally {
    p.close();
  }
});
