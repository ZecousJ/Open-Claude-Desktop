import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerOfficialAttachmentHandlers } from "../electron/ipc/official-attachments";
import { storeCoworkAttachments } from "../electron/official-ui/native/cowork-attachments";
import { openPolicy } from "../shared/client-policy";
import type { Attachment } from "../shared/types";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-stored-path-"));
  const handlers = new Map<string, (...args: any[]) => any>();
  const selectedAttachments = new Map<string, Attachment>();
  registerOfficialAttachmentHandlers((n, f) => handlers.set(n, f), {
    store: { root },
    selectedAttachments,
    policy: () => openPolicy,
  } as never);
  const calls: string[] = [];
  const call = async (name: string, ...args: unknown[]) => {
    calls.push(name);
    return handlers.get(name)!(...args);
  };
  return {
    root,
    call,
    calls,
    selectedAttachments,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("official Cowork host-stored string paths restore real bytes without re-reading renderer paths", async () => {
  const f = fixture();
  try {
    const stored = (await f.call("officialStoreCodeAttachments", [
      {
        name: "note.txt",
        data: new TextEncoder().encode("non-sensitive test"),
      },
    ])) as Attachment[];
    f.selectedAttachments.clear();
    f.calls.length = 0;
    const restored = await storeCoworkAttachments(
      f.root,
      f.call,
      [],
      [stored[0].path],
    );
    const { lines: _lines, ...persistedFields } = stored[0];
    assert.deepEqual(restored, [
      { ...persistedFields, path: fs.realpathSync(persistedFields.path) },
    ]);
    assert.deepEqual(f.calls, ["officialRestoreCodeAttachments"]);
    assert.equal(
      fs.readFileSync(restored[0].path, "utf8"),
      "non-sensitive test",
    );
    assert.equal(
      f.selectedAttachments.get(restored[0].id)?.path,
      restored[0].path,
    );
  } finally {
    f.cleanup();
  }
});

test("Cowork denies external, sibling-prefix, relative, traversal and duplicate paths", async () => {
  const f = fixture();
  try {
    const id = "11111111-1111-4111-8111-111111111111";
    for (const file of [
      "/etc/passwd",
      path.join(f.root, "attachments-other", id, "n.txt"),
      "relative.txt",
      `${f.root}/attachments/${id}/../${id}/n.txt`,
      path.join(f.root, "attachments", id, "subdir", "n.txt"),
    ])
      await assert.rejects(
        storeCoworkAttachments(f.root, f.call, [], [file]),
        /not stored/,
      );
    const file = path.join(f.root, "attachments", id, "n.txt");
    await assert.rejects(
      storeCoworkAttachments(f.root, f.call, [], [file, file]),
      /Duplicate/,
    );
    assert.deepEqual(f.calls, []);
  } finally {
    f.cleanup();
  }
});

test("Cowork pairs inline images with owned paths once and keeps named files in selection order", async () => {
  const f = fixture();
  try {
    const png = new Uint8Array([97]);
    const paths = (await f.call("officialStoreCodeAttachments", [
      { name: "photo-a.png", data: png },
      { name: "readme.txt", data: new Uint8Array([66]) },
      { name: "photo-b.png", data: png },
    ])) as Attachment[];
    const restored = await storeCoworkAttachments(
      f.root,
      f.call,
      [
        { base64: "YQ==", mimeType: "image/png" },
        { base64: "Yw==", mimeType: "image/png" },
      ],
      paths.map((file) => file.path),
    );
    assert.deepEqual(
      restored.map((file) => file.name),
      ["image-2.png", "photo-a.png", "readme.txt", "photo-b.png"],
    );

    const once = await storeCoworkAttachments(
      f.root,
      f.call,
      [
        { base64: "YQ==", mimeType: "image/png" },
        { base64: "YQ==", mimeType: "image/png" },
      ],
      [paths[0].path],
    );
    assert.deepEqual(
      once.map((file) => file.name),
      ["image-2.png", "photo-a.png"],
    );
  } finally {
    f.cleanup();
  }
});

test("Cowork counts 12 paired images as 12 attachments", async () => {
  const f = fixture();
  try {
    const png = new Uint8Array([97]);
    const paths = (await f.call(
      "officialStoreCodeAttachments",
      Array.from({ length: 12 }, (_, i) => ({
        name: `photo-${i}.png`,
        data: png,
      })),
    )) as Attachment[];
    f.calls.length = 0;
    const restored = await storeCoworkAttachments(
      f.root,
      f.call,
      Array(12).fill({
        base64: "YQ==",
        mimeType: "image/png",
      }),
      paths.map((file) => file.path),
    );
    assert.deepEqual(
      restored.map((file) => file.id),
      paths.map((file) => file.id),
    );
    assert.deepEqual(f.calls, ["officialRestoreCodeAttachments"]);
  } finally {
    f.cleanup();
  }
});

test("Cowork restores only the current account and checks the exact host filename", async () => {
  const f = fixture(),
    other = fixture();
  try {
    const [a] = (await f.call("officialStoreCodeAttachments", [
      { name: "note.txt", data: new Uint8Array([65]) },
    ])) as Attachment[];
    await assert.rejects(
      storeCoworkAttachments(other.root, other.call, [], [a.path]),
      /not stored/,
    );
    assert.deepEqual(other.calls, []);
    await assert.rejects(
      storeCoworkAttachments(
        f.root,
        f.call,
        [],
        [path.join(path.dirname(a.path), "different.txt")],
      ),
      /no longer matches/,
    );
    // Copying just another account's UUID into this root cannot restore it.
    await assert.rejects(
      storeCoworkAttachments(
        other.root,
        other.call,
        [],
        [path.join(other.root, "attachments", a.id, a.name)],
      ),
    );
  } finally {
    f.cleanup();
    other.cleanup();
  }
});

test("the real restore handler rejects stored-file symlink replacement and changed disallowed type", async () => {
  const f = fixture();
  try {
    const [a] = (await f.call("officialStoreCodeAttachments", [
      { name: "note.txt", data: new Uint8Array([65]) },
    ])) as Attachment[];
    const outside = path.join(f.root, "outside.txt");
    fs.writeFileSync(outside, "outside");
    fs.unlinkSync(a.path);
    fs.symlinkSync(outside, a.path);
    await assert.rejects(
      storeCoworkAttachments(f.root, f.call, [], [a.path]),
      /invalid|location/i,
    );
    fs.unlinkSync(a.path);
    const exe = path.join(path.dirname(a.path), "blocked.exe");
    fs.writeFileSync(exe, "bad");
    await assert.rejects(storeCoworkAttachments(f.root, f.call, [], [exe]));
  } finally {
    f.cleanup();
  }
});

test(
  "Cowork refuses to digest a stored image linked to another file",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const f = fixture();
    try {
      const [photo] = (await f.call("officialStoreCodeAttachments", [
        { name: "photo.png", data: new Uint8Array([97]) },
      ])) as Attachment[];
      const other = path.join(f.root, "outside.png");
      fs.writeFileSync(other, new Uint8Array([97]));
      fs.unlinkSync(photo.path);
      fs.linkSync(other, photo.path);
      await assert.rejects(
        storeCoworkAttachments(
          f.root,
          f.call,
          [{ base64: "YQ==", mimeType: "image/png" }],
          [photo.path],
        ),
        /changed while checking its image/,
      );
    } finally {
      f.cleanup();
    }
  },
);

test("restored Cowork paths enforce combined attachment count and byte bounds", async () => {
  const root = path.resolve("/tmp/owned-test-root"),
    id = "11111111-1111-4111-8111-111111111111";
  const file = path.join(root, "attachments", id, "large.txt");
  let stores = 0;
  const call = async (name: string) => {
    if (name === "officialStoreCodeAttachments") {
      stores++;
      return [];
    }
    return [{ id, path: file, size: 64 * 1024 * 1024 }];
  };
  await assert.rejects(
    storeCoworkAttachments(
      root,
      call,
      [{ base64: "YQ==", mimeType: "image/png" }],
      [file],
    ),
    /Combined/,
  );
  await assert.rejects(
    storeCoworkAttachments(
      root,
      call,
      Array(12).fill({ base64: "YQ==", mimeType: "image/png" }),
      [file],
    ),
    /at most 12/,
  );
  assert.equal(stores, 0);
});
