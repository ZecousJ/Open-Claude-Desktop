import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerExperimentalCoworkSessions } from "../electron/official-ui/native/cowork-sessions";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const image = { mimeType: "image/png", base64: png };
const document = {
  name: "notes.txt",
  base64: Buffer.from("hello").toString("base64"),
};

test("a failed Cowork engine send releases the no-UUID lock for an explicit retry", async () => {
  let sends = 0;
  const h = harness({
    call: async (name) => {
      assert.equal(name, "send");
      if (++sends === 1) throw Error("provider unavailable");
      return undefined;
    },
  });
  await assert.rejects(
    h.run("sendMessage", "local_task", "first"),
    /provider unavailable/,
  );
  await h.run("sendMessage", "local_task", "retry");
  assert.equal(sends, 2);
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness(
  options: {
    call?: (name: string, ...args: any[]) => Promise<any>;
    stateDirectory?: string;
    conversation?: any;
  } = {},
) {
  let owner = "account-a";
  const calls: any[][] = [];
  const handlers = new Map<string, (...args: any[]) => any>();
  const conversation = options.conversation ?? {
    id: "task",
    title: "Task",
    mode: "cowork",
    providerId: "provider",
    model: "model",
    cwd: process.cwd(),
    turns: [],
    createdAt: 1,
    updatedAt: 1,
  };
  registerExperimentalCoworkSessions({
    ctx: {
      account: () => ({ id: owner }),
      stateDirectory: () => options.stateDirectory,
      settings: () => ({
        providers: [{ id: "provider", model: "model" }],
        activeProviderId: "provider",
      }),
      localLoadConversation: async (id: string) =>
        id === conversation.id ? conversation : undefined,
      localListConversations: async () => [conversation],
      localCall: async (name: string, ...args: any[]) => {
        calls.push([name, ...args]);
        if (options.call) return options.call(name, ...args);
        if (name === "officialStoreCodeAttachments")
          return args[0].map((file: any, index: number) => ({
            id: `attachment-${index}`,
            name: file.name,
            kind: "text",
          }));
        if (name === "send") return conversation;
        if (name === "snapshot") return { approvals: [] };
        throw Error(`Unexpected call: ${name}`);
      },
      onEvent: () => () => {},
      log() {},
    },
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, handler);
    },
    emit() {},
  } as never);
  return {
    calls,
    conversation,
    owner: (next: string) => {
      owner = next;
    },
    run: (method: string, ...args: any[]) =>
      handlers.get(`LocalAgentModeSessions.${method}`)!(...args),
  };
}

test("Cowork inline images and internal file-byte extension reach the host send boundary", async () => {
  const h = harness();
  await h.run("start", {
    message: "",
    images: [image],
    userSelectedFiles: [document],
  });
  assert.equal(h.calls[0][0], "officialStoreCodeAttachments");
  assert.deepEqual(
    h.calls[0][1].map((file: any) => file.name),
    ["image-1.png", "notes.txt"],
  );
  assert.deepEqual(
    h.calls[0][1][0].data,
    Uint8Array.from(Buffer.from(png, "base64")),
  );
  const first = h.calls[1][1];
  assert.equal(first.mode, "cowork");
  assert.deepEqual(first.attachments, [
    { id: "attachment-0" },
    { id: "attachment-1" },
  ]);
  assert.equal(first.additionalFolders, undefined);
  h.calls.length = 0;
  await h.run("sendMessage", "local_task", "follow-up", [image], [document]);
  assert.deepEqual(
    h.calls.map((call) => call[0]),
    ["officialStoreCodeAttachments", "send"],
  );
  assert.equal(h.calls[1][1].conversationId, "task");
  assert.deepEqual(h.calls[1][1].attachments, first.attachments);
});

test("Cowork rejects renderer filesystem paths and failed reads without storing or sending", async () => {
  const h = harness();
  for (const files of [
    ["/etc/passwd"],
    [{ name: "private", path: "/etc/passwd" }],
    [{ ...document, readFailed: true }],
  ]) {
    await assert.rejects(
      h.run("start", { message: "hi", userSelectedFiles: files }),
    );
    await assert.rejects(h.run("sendMessage", "local_task", "hi", [], files));
  }
  await assert.rejects(
    h.run("start", {
      message: "hi",
      userSelectedFolders: ["/etc"],
      images: [image],
    }),
    /Allow the selected Cowork folder/,
  );
  await assert.rejects(
    h.run(
      "sendMessage",
      "local_task",
      "hi",
      [image],
      [],
      "id",
      [],
      [{ id: "unverified-upload" }],
    ),
    /fileAttachments/,
  );
  assert.deepEqual(h.calls, []);
});

test("Cowork enforces total attachment count and invalid bytes before side effects", async () => {
  const h = harness();
  await assert.rejects(
    h.run("start", {
      message: "hi",
      images: Array(12).fill(image),
      userSelectedFiles: [document],
    }),
    /at most 12/,
  );
  await assert.rejects(
    h.run(
      "sendMessage",
      "local_task",
      "hi",
      [{ ...image, base64: "%%%=" }],
      [],
    ),
    /encoding/,
  );
  assert.deepEqual(h.calls, []);
});

test("Cowork serializes sends without message UUID while attachment staging is pending", async () => {
  const staging = deferred<any[]>();
  const entered = deferred<void>();
  const h = harness({
    call: async (name) => {
      if (name === "officialStoreCodeAttachments") {
        entered.resolve();
        return staging.promise;
      }
      if (name === "send") return h.conversation;
    },
  });
  const first = h.run("sendMessage", "local_task", "first", [image], []);
  await entered.promise;
  await assert.rejects(
    h.run("sendMessage", "local_task", "second", [], []),
    /still being submitted/,
  );
  assert.equal(h.calls.filter((call) => call[0] === "send").length, 0);
  staging.resolve([{ id: "stored", name: "image-1.png" }]);
  await first;
  await h.run("sendMessage", "local_task", "after", [], []);
  assert.equal(h.calls.filter((call) => call[0] === "send").length, 2);
});

test("failed Cowork attachment storage releases the submission lock without sending", async () => {
  const h = harness({
    call: async (name) => {
      if (name === "officialStoreCodeAttachments") throw Error("disk full");
      if (name === "send") return h.conversation;
    },
  });
  await assert.rejects(
    h.run("sendMessage", "local_task", "first", [image], []),
    /disk full/,
  );
  assert.equal(h.calls.filter((call) => call[0] === "send").length, 0);
  await h.run("sendMessage", "local_task", "retry without attachment", [], []);
  assert.equal(h.calls.filter((call) => call[0] === "send").length, 1);
});

test("Cowork serializes plain-text sends even when no optimistic UUID was supplied", async () => {
  const sending = deferred<any>(),
    entered = deferred<void>();
  let sent = 0;
  const h = harness({
    call: async (name) => {
      if (name === "send") {
        if (++sent === 1) {
          entered.resolve();
          return sending.promise;
        }
        return h.conversation;
      }
    },
  });
  const first = h.run("sendMessage", "local_task", "first", [], []);
  await entered.promise;
  try {
    await assert.rejects(
      h.run("sendMessage", "local_task", "second", [], []),
      /still being submitted/,
    );
    assert.equal(sent, 1);
  } finally {
    sending.resolve(h.conversation);
    await first;
  }
});

for (const method of ["stop", "delete"]) {
  test(`Cowork ${method} during attachment staging prevents a late send`, async () => {
    const stage = deferred<any[]>(),
      entered = deferred<void>();
    const h = harness({
      call: async (name) => {
        if (name === "officialStoreCodeAttachments") {
          entered.resolve();
          return stage.promise;
        }
        if (name === "send") return h.conversation;
      },
    });
    const pending = h.run(
      "sendMessage",
      "local_task",
      "do not run after cancellation",
      [image],
      [],
    );
    const cancelled = assert.rejects(pending, /cancelled before dispatch/);
    await entered.promise;
    await h.run(method, "local_task");
    stage.resolve([{ id: "staged", name: "image-1.png" }]);
    await cancelled;
    assert.equal(h.calls.filter((call) => call[0] === "send").length, 0);
    assert.deepEqual(h.calls[1], [
      method === "stop" ? "interrupt" : "deleteConversation",
      "task",
    ]);
  });
}

test("account switch cancels the old staged send and cannot unlock the new account's request", async () => {
  const oldStage = deferred<any[]>(),
    newStage = deferred<any[]>();
  const oldEntered = deferred<void>(),
    newEntered = deferred<void>();
  let stage = 0;
  const h = harness({
    call: async (name) => {
      if (name === "officialStoreCodeAttachments") {
        if (stage++ === 0) {
          oldEntered.resolve();
          return oldStage.promise;
        }
        newEntered.resolve();
        return newStage.promise;
      }
      if (name === "send") return h.conversation;
    },
  });
  const old = h.run("sendMessage", "local_task", "old account", [image], []);
  const rejected = assert.rejects(old, /account changed/);
  await oldEntered.promise;
  h.owner("account-b");
  const fresh = h.run("sendMessage", "local_task", "new account", [image], []);
  await newEntered.promise;
  oldStage.resolve([{ id: "old", name: "image-1.png" }]);
  await rejected;
  await assert.rejects(
    h.run("sendMessage", "local_task", "duplicate new", [], []),
    /still being submitted/,
  );
  newStage.resolve([{ id: "new", name: "image-1.png" }]);
  await fresh;
  const sends = h.calls.filter((call) => call[0] === "send");
  assert.equal(sends.length, 1);
  assert.equal(sends[0][1].text, "new account");
  assert.deepEqual(sends[0][1].attachments, [{ id: "new" }]);
});

test("Cowork restored transcript embeds only images in the active account attachment store", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-cowork-images-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "attachments"));
  const imagePath = path.join(directory, "attachments", "one.png");
  fs.writeFileSync(imagePath, Buffer.from(png, "base64"));
  const outside = path.join(directory, "outside.png");
  fs.writeFileSync(outside, Buffer.from(png, "base64"));
  const h = harness({ stateDirectory: directory });
  h.conversation.turns.push({
    id: "turn",
    status: "completed",
    prompt: "picture",
    createdAt: 1,
    items: [],
    attachments: [
      { id: "inside", name: "one.png", kind: "image", path: imagePath },
      { id: "outside", name: "outside.png", kind: "image", path: outside },
    ],
  });
  const rows = await h.run("getTranscript", "local_task");
  assert.deepEqual(rows[0].message.content, [
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: png },
    },
    { type: "text", text: "picture" },
  ]);
  assert.deepEqual(rows[0].file_attachments, [
    { file_uuid: "outside", file_name: "outside.png", is_image: false },
  ]);
});
