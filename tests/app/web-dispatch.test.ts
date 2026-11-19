import assert from "node:assert/strict";
import test from "node:test";
import type { DispatchTask } from "../../shared/dispatch-api";
import type { DeviceInfo, DeviceMethod } from "../../shared/remote-devices";
import { createWebDispatch } from "../../src-web/bridge/dispatch";
import { FakeBrowser, fakeTab, flush } from "./web-bridge-fakes.test";

const desktop = "desktop_123";
const laptop = "laptop_1234";
const device = (id: string): DeviceInfo => ({
  id,
  name: id,
  platform: "darwin",
  version: "1",
  connectedAt: "2026-11-14T00:00:00Z",
  online: true,
});
const folder = {
  name: "project",
  path: "/work/project",
  default: true,
  sessions: 0,
};
const offline = () =>
  Object.assign(new Error("This computer is not online."), {
    code: "CLAUDEX_DEVICE_OFFLINE",
  });
const input = (text: string, deviceId = desktop) => ({
  deviceId,
  cwd: folder.path,
  mode: "cowork" as const,
  text,
});

function setup(
  tab = fakeTab(),
  notify?: NonNullable<Parameters<typeof createWebDispatch>[1]["notify"]>,
) {
  let active: { account: string } | undefined = { account: "a" };
  let inventory = [device(desktop), device(laptop)];
  const rpc: Array<{ device: string; method: DeviceMethod; args: unknown[] }> =
    [];
  let respond: (
    device: string,
    method: DeviceMethod,
    args: unknown[],
  ) => Promise<unknown> = async () => ({
    status: "accepted",
    value: { conversationId: "conversation-1" },
  });
  const api = createWebDispatch(tab.env, {
    devices: {
      list: async () => inventory,
      rpc: async (device, method, args) => {
        rpc.push({ device, method, args });
        return respond(device, method, args);
      },
    },
    account: () => active?.account,
    captureActivation() {
      const current = active;
      return () => {
        if (active !== current)
          throw new DOMException("The active account changed.", "AbortError");
      };
    },
    notify,
  });
  return {
    api,
    clock: tab.clock,
    rpc,
    respond(next: typeof respond) {
      respond = next;
    },
    inventory(next: DeviceInfo[]) {
      inventory = next;
      api.wake();
    },
    switchAccount(account?: string) {
      active = account ? { account } : undefined;
      api.reset();
    },
  };
}

test("Web Dispatch retries a lost acknowledgement with the same ID and keeps order per computer", async () => {
  const test = setup();
  test.inventory([{ ...device(desktop), online: false }, device(laptop)]);
  const first = await test.api.deliver(input("first"));
  const second = await test.api.deliver(input("second"));
  const other = await test.api.deliver(input("laptop task", laptop));
  await flush();
  await test.clock.advance(3000);
  assert.deepEqual(
    test.rpc.map((call) => call.device),
    [laptop],
  );
  assert.deepEqual(
    (await test.api.status()).pending.map((item) => item.id),
    [first.id, second.id],
  );
  const acknowledged = new Set([other.id]);
  let lost = false;
  test.respond(async (_device, _method, args) => {
    assert.ok(
      args[0] &&
        typeof args[0] === "object" &&
        "id" in args[0] &&
        typeof args[0].id === "string",
    );
    const id = args[0].id;
    if (!acknowledged.has(id)) acknowledged.add(id);
    if (id === first.id && !lost) {
      lost = true;
      throw offline();
    }
    return { status: "accepted", value: { conversationId: "remote-task" } };
  });
  test.inventory([device(desktop), device(laptop)]);
  await flush();
  assert.equal(test.rpc.filter((call) => call.device === desktop).length, 1);
  assert.deepEqual(
    (await test.api.status()).pending.map((item) => item.id),
    [first.id, second.id],
  );
  await test.clock.advance(3000);
  const deliveries = test.rpc.filter((call) => call.device === desktop);
  assert.deepEqual(deliveries[0].args, deliveries[1].args);
  assert.deepEqual(deliveries[2].args, [
    {
      id: second.id,
      method: "newSession",
      args: [{ text: "second", cwd: folder.path, mode: "cowork" }],
    },
  ]);
  assert.deepEqual([...acknowledged], [other.id, first.id, second.id]);
  assert.deepEqual(
    (await test.api.status()).deliveries?.map((row) => row.state),
    ["delivered", "delivered", "delivered"],
  );
  test.api.dispose();
});

test("Web Dispatch restores only the signed-in account’s outbox and directory inventory after reload", async () => {
  const browser = new FakeBrowser();
  const original = setup(fakeTab(browser));
  original.respond(async (_device, method) => {
    assert.equal(method, "listDirectories");
    return [folder];
  });
  await original.api.trust(desktop);
  original.inventory([{ ...device(desktop), online: false }]);
  const queued = await original.api.deliver(input("account A’s task"));
  await flush();
  original.api.dispose();

  const reloaded = setup(fakeTab(browser));
  reloaded.inventory([{ ...device(desktop), online: false }]);
  reloaded.respond(async () => {
    throw offline();
  });
  assert.deepEqual(await reloaded.api.directories(desktop), [folder]);
  assert.deepEqual((await reloaded.api.status()).pairedDeviceIds, [desktop]);
  assert.deepEqual(
    (await reloaded.api.status()).pending.map((item) => item.id),
    [queued.id],
  );

  reloaded.switchAccount("b");
  assert.deepEqual((await reloaded.api.status()).pending, []);
  assert.deepEqual((await reloaded.api.status()).pairedDeviceIds, []);
  await assert.rejects(reloaded.api.directories(desktop), /not online/);
  await reloaded.clock.advance(3000);
  assert.ok(reloaded.rpc.every((call) => call.method === "listDirectories"));

  reloaded.switchAccount("a");
  reloaded.respond(async () => {
    throw new Error("This device’s access was revoked.");
  });
  await assert.rejects(reloaded.api.directories(desktop), /revoked/);
  reloaded.respond(async () => {
    throw offline();
  });
  await assert.rejects(reloaded.api.directories(desktop), /not online/);
  reloaded.respond(async () => ({
    status: "accepted",
    value: { conversationId: "reloaded-task" },
  }));
  reloaded.inventory([device(desktop)]);
  await flush();
  const delivery = reloaded.rpc.find(
    (call) => call.method === "deliverDispatch",
  );
  assert.deepEqual(delivery?.args, [
    {
      id: queued.id,
      method: "newSession",
      args: [{ text: "account A’s task", cwd: folder.path, mode: "cowork" }],
    },
  ]);
  assert.deepEqual((await reloaded.api.status()).deliveries?.[0], {
    id: queued.id,
    deviceId: desktop,
    title: "account A’s task",
    state: "delivered",
    conversationId: "reloaded-task",
  });
  reloaded.api.dispose();
});

test("Web Dispatch releases the queue after a refusal, retaining the row for explicit retry", async () => {
  const test = setup();
  let reject = true;
  test.respond(async () => {
    if (!reject) return { status: "accepted", value: null };
    reject = false;
    return {
      status: "rejected",
      code: "invalid",
      message: "That folder isn't available.",
    };
  });
  const first = await test.api.deliver(input("wrong folder"));
  const second = await test.api.followUp({
    deviceId: desktop,
    conversationId: "task",
    text: "follow-up",
  });
  await flush();
  await test.clock.advance(3000);
  assert.deepEqual((await test.api.status()).deliveries, [
    {
      id: first.id,
      deviceId: desktop,
      title: "wrong folder",
      state: "failed",
      error: "That folder isn't available.",
    },
    {
      id: second.id,
      deviceId: desktop,
      title: "follow-up",
      state: "delivered",
    },
  ]);
  assert.equal((await test.api.retry(first.id))?.id, first.id);
  await flush();
  assert.notDeepEqual(test.rpc[0].args, test.rpc[2].args);
  assert.equal((await test.api.status()).deliveries?.at(-1)?.id, first.id);
  assert.equal(
    (await test.api.status()).deliveries?.at(-1)?.state,
    "delivered",
  );
  test.api.dispose();
});

test("Web Dispatch reports signed approval and completion transitions only for the active account", async () => {
  const notices: string[] = [];
  const test = setup(fakeTab(), (_device, notice) => notices.push(notice.body));
  let task: DispatchTask = {
    id: "task",
    title: "Do work",
    updatedAt: 1,
    running: true,
    approvals: 0,
    model: "fixture",
    mode: "cowork",
  };
  test.respond(async (_device, method) => {
    if (method === "listDispatchTasks") return [task];
    if (method === "dispatchPreferences") return true;
    if (method === "deviceTrustSummary") return { requireTrustedDevices: true };
    throw new Error(method);
  });
  await test.api.tasks(desktop);
  assert.deepEqual(notices, []);
  task = { ...task, updatedAt: 2, approvals: 1 };
  await test.api.tasks(desktop);
  await flush();
  task = { ...task, updatedAt: 3, approvals: 0, running: false };
  await test.api.tasks(desktop);
  await flush();
  await test.api.tasks(desktop);
  test.switchAccount("b");
  await test.api.tasks(desktop);
  await flush();
  assert.deepEqual(notices, [
    "Claudex is waiting for your input",
    "Claudex finished a task",
  ]);
  test.api.dispose();
});

test("Web Dispatch holds later tasks behind an unknown outcome until it is dismissed", async () => {
  const test = setup();
  test.respond(async () => ({
    status: "unknown",
    message: "The computer restarted before confirming delivery.",
  }));
  const first = await test.api.deliver(input("uncertain outcome"));
  const second = await test.api.deliver(input("still queued"));
  await flush();
  await test.clock.advance(6000);
  assert.equal(test.rpc.length, 1);
  const status = await test.api.status();
  assert.equal(status.deliveries?.[0]?.state, "unknown");
  assert.deepEqual(
    status.pending.map((row) => row.id),
    [second.id],
  );
  await assert.rejects(test.api.remove(second.id), /awaiting delivery/);
  assert.equal((await test.api.retry(first.id))?.state, "unknown");
  assert.equal(test.rpc.length, 1);
  test.respond(async () => ({
    status: "accepted",
    value: { conversationId: "second-only" },
  }));
  await test.api.remove(first.id);
  await flush();
  assert.equal(test.rpc.length, 2);
  assert.equal((await test.api.status()).deliveries?.[0]?.id, second.id);
  assert.equal((await test.api.status()).deliveries?.[0]?.state, "delivered");
  test.api.dispose();
});

test("Web Dispatch drains a different computer while an earlier request waits for its reply", async () => {
  const test = setup();
  let resume!: (value: unknown) => void;
  const waiting = new Promise((resolve) => {
    resume = resolve;
  });
  test.respond(async (deviceId) =>
    deviceId === desktop ? waiting : { status: "accepted", value: null },
  );
  test.inventory([
    { ...device(desktop), online: false },
    { ...device(laptop), online: false },
  ]);
  const first = await test.api.deliver(input("desktop task"));
  const other = await test.api.deliver(input("laptop task", laptop));
  await flush();
  test.inventory([device(desktop), device(laptop)]);
  await flush();
  assert.deepEqual(
    (await test.api.status()).deliveries?.map(({ id, state }) => [id, state]),
    [
      [first.id, "pending"],
      [other.id, "delivered"],
    ],
  );
  resume({ status: "accepted", value: null });
  await flush();
  assert.equal((await test.api.status()).pending.length, 0);
  test.api.dispose();
});
