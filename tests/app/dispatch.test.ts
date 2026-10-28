import test from "node:test";
import assert from "node:assert/strict";
import { dispatchGroups } from "../../src/dispatch/model";
import type { DeviceConversationSummary } from "../../shared/remote-devices";
import { registerDispatchHandlers } from "../../electron/ipc/dispatch";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DispatchReceipts,
  readDeliveries,
  writeDeliveries,
} from "../../electron/remote-control/dispatch-delivery";

test("offline Dispatch deliveries persist and retry without repeating completed calls", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-delivery-"));
  try {
    const delivery = {
      id: "c4d69a88-f989-45dd-a7c6-9e765c639b30",
      deviceId: "desktop_123",
      method: "newSession" as const,
      args: [{ text: "task", cwd: "/project" }],
    };
    writeDeliveries(root, [delivery]);
    assert.deepEqual(readDeliveries(root), [delivery]);
    let calls = 0;
    const execute = async () => {
      calls++;
      return { conversationId: "created" };
    };
    const receipts = new DispatchReceipts(() => root);
    await Promise.all([
      receipts.run(delivery.id, execute),
      receipts.run(delivery.id, execute),
    ]);
    assert.equal(calls, 1);
    assert.deepEqual(
      await new DispatchReceipts(() => root).run(delivery.id, execute),
      { conversationId: "created" },
    );
    assert.equal(calls, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const task = (
  id: string,
  extra: Partial<DeviceConversationSummary> = {},
): DeviceConversationSummary => ({
  id,
  title: id,
  model: "model",
  updatedAt: 0,
  running: false,
  approvals: 0,
  ...extra,
});

test("remote starts export only attachments selected by the caller and retry reaches the desktop relay", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-attachments-"));
  try {
    fs.writeFileSync(path.join(root, "note.txt"), "hello");
    const handlers = new Map<string, (...args: any[]) => any>();
    const calls: unknown[] = [];
    let retries = 0;
    registerDispatchHandlers(
      (name, handler) => {
        handlers.set(name, handler);
      },
      {
        store: { root },
        selectedAttachments: new Map([
          ["selected", { name: "note.txt", path: path.join(root, "note.txt") }],
        ]),
        services: {
          dispatch: {
            retry: () => {
              retries++;
            },
            status: () => ({
              id: "desktop_123",
              online: false,
              cause: "network",
            }),
            call: async (method: string, args: unknown[]) => {
              calls.push([method, args]);
              return { conversationId: "fresh" };
            },
          },
        },
      } as any,
    );
    const status = await handlers.get("dispatchStatus")!(true);
    assert.equal(retries, 1);
    assert.equal(status.local.cause, "network");
    await handlers.get("dispatchCall")!("desktop_123", "newSession", [
      { cwd: "/work", text: "read it", attachmentIds: ["selected"] },
    ]);
    assert.deepEqual(calls, [
      [
        "newSession",
        [
          {
            cwd: "/work",
            text: "read it",
            attachments: [{ name: "note.txt", data: "aGVsbG8=" }],
          },
        ],
      ],
    ]);
    await assert.rejects(
      handlers.get("dispatchCall")!("desktop_123", "newSession", [
        { text: "read it", attachmentIds: ["/etc/passwd"] },
      ]),
      /can't be attached/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Dispatch groups tasks in sections with attention and review taking precedence", () => {
  const groups = dispatchGroups(
    [
      task("running", { running: true }),
      task("permission", { approvals: 1 }),
      task("error", { failed: true }),
      task("review", { readyReview: true }),
      task("done"),
      task("scheduled", { running: true }),
    ],
    new Set(["scheduled"]),
  );
  assert.deepEqual(
    groups.active.map((item) => item.id),
    ["running", "review"],
  );
  assert.deepEqual(
    groups.attention.map((item) => item.id),
    ["permission", "error"],
  );
  assert.deepEqual(
    groups.done.map((item) => item.id),
    ["done"],
  );
  assert.deepEqual(
    groups.ongoing.map((item) => item.id),
    ["scheduled"],
  );
});

test("Dispatch bridge serves local tasks without tokens and validates remote calls", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const calls: unknown[] = [];
  registerDispatchHandlers(
    (name, handler) => {
      handlers.set(name, handler);
    },
    {
      services: {
        dispatch: {
          status: () => ({ id: "desktop_123", online: true }),
          call: async (method: string, args: unknown[]) => {
            calls.push([method, args]);
            return [task("one")];
          },
        },
      },
    } as any,
  );
  const status = await handlers.get("dispatchStatus")!();
  assert.equal(status.appLink, "");
  assert.equal(status.paired, false);
  assert.equal(status.local.online, true);
  assert.equal((await handlers.get("dispatchTasks")!())[0].id, "one");
  assert.deepEqual(calls, [["listDispatchTasks", []]]);
  await assert.rejects(
    handlers.get("dispatchCall")!("../../escape", "send", []),
  );
  await assert.rejects(
    handlers.get("dispatchCall")!("desktop_123", "deleteConversation", []),
  );
});

test("Dispatch retries persisted offline deliveries after the host is activated again", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-outbox-"));
  const handlers = new Map<string, (...args: any[]) => any>();
  let activate: () => void = () => {};
  let deactivate: () => void = () => {};
  let online = false;
  const delivered: unknown[] = [];
  const context = {
    store: { root },
    services: {
      dispatch: {
        status: () => ({ id: "desktop_123", online }),
        call: async (method: string, args: unknown[]) => {
          if (!online) throw new Error("offline");
          delivered.push([method, args]);
        },
      },
    },
    onAccountActivated: (callback: () => void) => {
      activate = callback;
    },
    onAccountDeactivating: (callback: () => void) => {
      deactivate = callback;
    },
  };
  try {
    registerDispatchHandlers((name, handler) => {
      handlers.set(name, handler);
    }, context as any);
    await handlers.get("dispatchEnqueue")!("desktop_123", "newSession", {
      text: "Task",
      cwd: "/project",
      mode: "cowork",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(readDeliveries(root).length, 1);
    deactivate();
    online = true;
    activate();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(readDeliveries(root).length, 0);
    assert.equal(delivered.length, 1);
    assert.equal((delivered[0] as unknown[])[0], "deliverDispatch");
    await assert.rejects(
      handlers.get("dispatchEnqueue")!("desktop_123", "deleteConversation", {}),
    );
  } finally {
    deactivate();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Dispatch remembers authorized desktops and directories when a desktop goes offline", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-cache-"));
  const handlers = new Map<string, (...args: any[]) => any>();
  const originalFetch = globalThis.fetch;
  let online = true;
  const device = {
    id: "desktop_123",
    name: "My desktop",
    platform: "darwin",
    version: "1",
    connectedAt: "2026-10-16T00:00:00Z",
  };
  const folders = [
    { path: "/project", name: "project", sessions: 0, default: true },
  ];
  globalThis.fetch = (async (url: URL) => {
    if (url.pathname.endsWith("/devices"))
      return Response.json({ ok: true, value: online ? [device] : [] });
    if (!online)
      return Response.json(
        {
          ok: false,
          error: {
            code: "CLAUDEX_DEVICE_OFFLINE",
            message: "This computer is not online.",
          },
        },
        { status: 404 },
      );
    if (url.pathname.endsWith("/deviceTrustChallenge"))
      return Response.json(
        {
          ok: false,
          error: {
            code: "CLAUDEX_WEB_METHOD_UNAVAILABLE",
            message: "Not available on the web.",
          },
        },
        { status: 404 },
      );
    return Response.json({ ok: true, value: folders });
  }) as typeof fetch;
  try {
    registerDispatchHandlers(
      (name, handler) => {
        handlers.set(name, handler);
      },
      {
        store: { root },
        services: {},
        remote: {
          ready: true,
          accounts: { baseUrl: "https://service.example" },
          session: {
            authorized: (request: (token: string) => unknown) =>
              request("token"),
          },
          backend: { client: { nativeSessions: async () => ({ items: [] }) } },
        },
      } as any,
    );
    assert.deepEqual(
      (await handlers.get("dispatchStatus")!()).onlineDeviceIds,
      [device.id],
    );
    assert.deepEqual(
      await handlers.get("dispatchCall")!(device.id, "listDirectories", []),
      folders,
    );
    online = false;
    const status = await handlers.get("dispatchStatus")!();
    assert.deepEqual(status.devices, [device]);
    assert.deepEqual(status.onlineDeviceIds, []);
    assert.deepEqual(
      await handlers.get("dispatchCall")!(device.id, "listDirectories", []),
      folders,
    );
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
