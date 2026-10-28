import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PrivacyDataService } from "../../electron/account/privacy-data";
import {
  deleteOwnedUpload,
  readOwnedUploadInventory,
} from "../../electron/account/privacy-data-uploads";
import type { Conversation } from "../../shared/types";
const id = "eb526839-061b-44e0-9fe2-621d8d80f116";
const item = {
  id,
  createdAt: "2026-10-19T12:00:00Z",
  rating: "down",
  categories: ["wrong"],
  comment: "synthetic",
  hasExcerpt: false,
};
const partial = {
  items: [],
  complete: false as const,
  scope: "managed-attachments" as const,
  skipped: 0,
  truncated: false,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { resolve, promise };
}

test("privacy status probes actual management independently of collection; only missing routes are unsupported", async () => {
  const owner = {},
    calls: string[] = [];
  let status = 200;
  const service = new PrivacyDataService({
    owner: () => owner,
    feedback: () => ({
      request: async (method, route) => {
        calls.push(`${method} ${route}`);
        if (status !== 200)
          throw Object.assign(Error("service failed"), { status });
        return { version: 1, items: [] };
      },
    }),
    readUploads: async () => partial,
  });
  assert.deepEqual(await service.privacyDataStatus(), {
    feedback: { supported: true },
    uploads: { supported: true },
  });
  assert.deepEqual(calls, ["GET feedback/history?limit=1"]);
  status = 404;
  assert.equal((await service.privacyDataStatus()).feedback.supported, false);
  for (const code of [401, 403, 500]) {
    status = code;
    await assert.rejects(service.privacyDataStatus(), /service failed/);
  }
  const local = new PrivacyDataService({
    owner: () => owner,
    feedback: () => undefined,
  });
  assert.equal((await local.privacyDataStatus()).feedback.supported, false);
  await assert.rejects(
    local.feedbackHistory(),
    /no feedback collection service/,
  );
  await assert.rejects(local.uploadedFiles(), /cannot list/);
});

test("feedback continuation makes a real request and is opaque, owner-bound, kind-bound and expires", async () => {
  let owner = {},
    now = 0;
  const calls: string[] = [];
  const service = new PrivacyDataService({
    owner: () => owner,
    now: () => now,
    feedback: () => ({
      request: async (_, route) => {
        calls.push(route);
        return calls.length === 1
          ? { version: 1, items: [item], nextCursor: "server-page-2" }
          : { version: 1, items: [] };
      },
    }),
    readUploads: async () => partial,
  });
  const page = await service.feedbackHistory();
  assert.ok(page.nextCursor);
  assert.notEqual(page.nextCursor, "server-page-2");
  assert.deepEqual(await service.feedbackHistory({ cursor: page.nextCursor }), {
    items: [],
  });
  assert.equal(calls[1], "feedback/history?limit=50&cursor=server-page-2");
  await assert.rejects(
    service.uploadedFiles({ cursor: page.nextCursor }),
    /expired|another account/,
  );
  await assert.rejects(
    service.feedbackHistory({ cursor: "forged" }),
    /expired|another account/,
  );
  owner = {};
  await assert.rejects(
    service.feedbackHistory({ cursor: page.nextCursor }),
    /expired|another account/,
  );
  // Returning to the old owner still cannot revive an expired token.
  now = 300_001;
  await assert.rejects(
    service.feedbackHistory({ cursor: page.nextCursor }),
    /expired|another account/,
  );
  assert.equal(calls.length, 2);
});

test("late feedback status, listing, withdrawal and uploads refuse a retired owner", async () => {
  for (const operation of [
    "status",
    "history",
    "withdraw",
    "uploads",
  ] as const) {
    let owner = {};
    const pending = deferred<unknown>();
    const service = new PrivacyDataService({
      owner: () => owner,
      feedback: () => ({ request: () => pending.promise }),
      readUploads: () => pending.promise as Promise<typeof partial>,
    });
    const promise =
      operation === "status"
        ? service.privacyDataStatus()
        : operation === "history"
          ? service.feedbackHistory()
          : operation === "withdraw"
            ? service.withdrawFeedback(id)
            : service.uploadedFiles();
    owner = {};
    pending.resolve(
      operation === "withdraw"
        ? { withdrawn: true }
        : operation === "uploads"
          ? partial
          : { version: 1, items: [] },
    );
    await assert.rejects(promise, /retired account/);
  }
});

test("malformed service data and failed withdrawals propagate; no empty success or false acknowledgement", async () => {
  let answer: unknown = { items: [] };
  const calls: string[] = [];
  const service: PrivacyDataService = new PrivacyDataService({
    owner: (): object => service,
    feedback: () => ({
      request: async (method, route) => {
        calls.push(`${method} ${route}`);
        return answer;
      },
    }),
  });
  await assert.rejects(service.privacyDataStatus());
  await assert.rejects(service.feedbackHistory());
  answer = { withdrawn: false };
  await assert.rejects(service.withdrawFeedback(id));
  answer = { withdrawn: true };
  assert.deepEqual(await service.withdrawFeedback(id), answer);
  assert.equal(calls.at(-1), `DELETE feedback/history/${id}`);
  await assert.rejects(service.withdrawFeedback("../other"));
  answer = { version: 1, items: Array.from({ length: 101 }, () => item) };
  await assert.rejects(service.feedbackHistory());
});

test("upload snapshot pagination is bounded and stable", async () => {
  let reads = 0,
    now = 0;
  const owner = {};
  const entries = Array.from({ length: 120 }, (_, index) => ({
    id: String(index),
    name: `fixture-${index}`,
    bytes: index,
    uploadedAt: null,
    surface: "chat" as const,
    locations: [],
    storage: "managed-attachment" as const,
  }));
  const service = new PrivacyDataService({
    owner: () => owner,
    now: () => now,
    feedback: () => undefined,
    readUploads: async () => {
      reads++;
      return { ...partial, items: entries };
    },
  });
  const first = await service.uploadedFiles();
  assert.equal(first.items.length, 50);
  assert.equal(first.complete, false);
  const second = await service.uploadedFiles({ cursor: first.nextCursor });
  assert.equal(second.items[0].name, "fixture-50");
  const last = await service.uploadedFiles({ cursor: second.nextCursor });
  assert.equal(last.items.length, 20);
  assert.equal(last.nextCursor, undefined);
  assert.equal(reads, 1);
  now = 300_001;
  await assert.rejects(
    service.uploadedFiles({ cursor: first.nextCursor }),
    /expired/,
  );
});

test("actual disk inventory includes owned copies only, preserves originals and dates each copy", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "privacy-b34-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const root = path.join(folder, "account-a"),
    other = path.join(folder, "account-b");
  await fs.mkdir(root);
  await fs.mkdir(other);
  assert.deepEqual(await readOwnedUploadInventory(root, []), partial);
  const upload = path.join(root, "attachments", randomUUID());
  await fs.mkdir(upload, { recursive: true });
  const owned = path.join(upload, "owned.txt"),
    external = path.join(other, "original.txt");
  await fs.writeFile(owned, "owned bytes");
  await fs.writeFile(external, "external original");
  await fs.symlink(external, path.join(upload, "external-link.txt"));
  const reference = {
    id: "a",
    name: "owned.txt",
    path: owned,
    kind: "text",
    size: 11,
  };
  const conversations = [
    {
      id: "chat-a",
      title: "Owned chat",
      turns: [{ attachments: [reference, { ...reference, path: external }] }],
      savedBranches: [{ turns: [{ attachments: [reference] }] }],
    },
  ] as unknown as Conversation[];
  const inventory = await readOwnedUploadInventory(root, conversations);
  assert.equal(inventory.items.length, 1);
  assert.ok(Math.abs(inventory.items[0].uploadedAt! - Date.now()) < 60_000);
  assert.equal(inventory.items[0].surface, "chat");
  assert.equal(inventory.items[0].bytes, 11);
  assert.deepEqual(inventory.items[0].locations, [
    { conversationId: "chat-a", title: "Owned chat" },
  ]);
  assert.equal(inventory.skipped, 1);
  assert.equal(inventory.complete, false);
  assert.equal(await fs.readFile(external, "utf8"), "external original");
  await fs.rm(path.join(root, "attachments"), { recursive: true });
  await fs.symlink(other, path.join(root, "attachments"));
  await assert.rejects(
    readOwnedUploadInventory(root, conversations),
    /boundary changed/,
  );
});

test("inventory errors remain errors and no incognito relationship is exposed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "privacy-b34-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const upload = path.join(root, "attachments", randomUUID());
  await fs.mkdir(upload, { recursive: true });
  const file = path.join(upload, "fixture.txt");
  await fs.writeFile(file, "fixture");
  const rows = [
    {
      id: "secret",
      title: "Incognito",
      incognito: true,
      turns: [{ attachments: [{ path: file }] }],
    },
  ] as unknown as Conversation[];
  assert.deepEqual(
    (await readOwnedUploadInventory(root, rows)).items[0].locations,
    [],
  );
  await assert.rejects(
    readOwnedUploadInventory(path.join(root, "missing-account"), []),
    /ENOENT/,
  );
});

test("continuation storage is bounded and cannot cross service instances", async () => {
  const owner = {},
    reply = { version: 1, items: [], nextCursor: "next" };
  const deps = {
    owner: () => owner,
    feedback: () => ({ request: async () => reply }),
  };
  const service = new PrivacyDataService(deps),
    other = new PrivacyDataService(deps);
  const first = await service.feedbackHistory();
  await assert.rejects(
    other.feedbackHistory({ cursor: first.nextCursor }),
    /expired|another account/,
  );
  for (let i = 0; i < 64; i++) await service.feedbackHistory();
  await assert.rejects(
    service.feedbackHistory({ cursor: first.nextCursor }),
    /expired|another account/,
  );
});

test("late failures from retired transport and upload readers are replaced by owner refusal", async () => {
  for (const operation of ["history", "withdraw", "uploads"] as const) {
    let owner = {};
    let reject!: (reason: unknown) => void;
    const failure = new Promise<never>((_, no) => {
      reject = no;
    });
    const service = new PrivacyDataService({
      owner: () => owner,
      feedback: () => ({ request: () => failure }),
      readUploads: () => failure,
    });
    const result =
      operation === "history"
        ? service.feedbackHistory()
        : operation === "withdraw"
          ? service.withdrawFeedback(id)
          : service.uploadedFiles();
    owner = {};
    reject(Error("retired private transport detail"));
    await assert.rejects(result, /retired account/);
  }
});

test("deleting a stored copy removes only that app-owned file, never an original or a busy one", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "privacy-delete-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const root = path.join(folder, "account-a");
  const id = randomUUID();
  const upload = path.join(root, "attachments", id);
  await fs.mkdir(upload, { recursive: true });
  const owned = path.join(upload, "owned.txt");
  const original = path.join(folder, "original.txt");
  await fs.writeFile(owned, "owned bytes");
  await fs.writeFile(original, "original");
  await fs.symlink(original, path.join(upload, "link.txt"));
  const busy = [
    {
      id: "chat-a",
      title: "Busy",
      turns: [
        {
          status: "inProgress",
          attachments: [{ id: "a", name: "owned.txt", path: owned }],
        },
      ],
    },
  ] as unknown as Conversation[];
  await assert.rejects(
    deleteOwnedUpload(root, busy, `${id}/owned.txt`),
    /being used by a response/,
  );
  for (const bad of [
    `${id}/../original.txt`,
    `${id}/link.txt`,
    "not-a-uuid/owned.txt",
    `${id}/missing.txt`,
    `${id}`,
  ])
    await assert.rejects(deleteOwnedUpload(root, [], bad), /already deleted/);
  assert.equal(await fs.readFile(original, "utf8"), "original");
  await deleteOwnedUpload(root, [], `${id}/owned.txt`);
  await assert.rejects(fs.stat(owned));
  assert.equal(await fs.readFile(original, "utf8"), "original");
});

test("the service deletes through its owner and forgets listed pages", async () => {
  const owner = {};
  const removed: string[] = [];
  const service = new PrivacyDataService({
    owner: () => owner,
    feedback: () => undefined,
    readUploads: async () => ({
      ...partial,
      items: Array.from({ length: 60 }, (_, index) => ({
        id: `x/${index}`,
        name: String(index),
        bytes: 1,
        uploadedAt: null,
        surface: "chat" as const,
        locations: [],
        storage: "managed-attachment" as const,
      })),
    }),
    deleteUpload: async (id) => {
      removed.push(id);
    },
  });
  const first = await service.uploadedFiles();
  assert.deepEqual(await service.deleteUploadedFile("x/3"), { deleted: true });
  assert.deepEqual(removed, ["x/3"]);
  await assert.rejects(
    service.uploadedFiles({ cursor: first.nextCursor }),
    /expired/,
  );
});
