import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useElectronShim } from "../runner/runner-core-support.test.ts";
import { Scheduler } from "../../electron/routines/scheduler";
import { registerBrowserTools } from "../../electron/browser/browser-tools-registration";
import { openPolicy } from "../../shared/client-policy";
import { webMethodKind } from "../../shared/web-bridge-methods";
useElectronShim();
const { registerCollectionHandlers } =
  await import("../../electron/ipc/collections");
test("actual collection IPC validates IDs, inventories/revokes only owned native task and returns explicit runner unsupported", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-b35-browser-ipc-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scheduler = new Scheduler(root, {
    now: () => 1000000,
    isBusy: () => false,
    run: async () => {
      throw Error("No model calls in this fixture");
    },
  });
  const task = scheduler.save({
    name: "Browser",
    prompt: "Inspect",
    mode: "code",
    providerId: "p",
    model: "m",
    enabled: false,
    frequency: "hourly",
    nextRunAt: 2000000,
  });
  const activations: (() => void)[] = [],
    deactivations: (() => Promise<void>)[] = [];
  let ready!: () => void;
  const registered = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const ctx = {
    store: {
      root,
      settings: { browserTools: true, providers: [], mcpServers: {} },
      projects: [],
      conversations: [],
    },
    scheduler,
    engine: {
      extensions: {
        add() {
          ready();
          return () => {};
        },
      },
    },
    services: {},
    policy: () => openPolicy,
    onAccountActivated: (cb: () => void) => activations.push(cb),
    onAccountDeactivating: (cb: () => Promise<void>) => deactivations.push(cb),
    onSettingsChanged() {},
  } as any;
  const handlers = new Map<string, (...args: any[]) => any>();
  registerCollectionHandlers((name, action) => handlers.set(name, action), ctx);
  const read = handlers.get("routineBrowserPermissions")!,
    revoke = handlers.get("clearRoutineBrowserPermissions")!;
  assert.equal(webMethodKind("routineBrowserPermissions"), "remote-runner");
  assert.equal(
    webMethodKind("clearRoutineBrowserPermissions"),
    "remote-runner",
  );
  assert.equal(read(task.id).status, "unsupported");
  assert.throws(() => revoke(task.id), /unavailable/);
  for (const bad of ["", null, { id: task.id }, "x".repeat(201)])
    assert.throws(() => read(bad));
  assert.throws(() => read("other-account-task"), /no longer exists/);
  registerBrowserTools(ctx, {
    service: async () => {
      throw Error("Inventory never creates a Browser panel");
    },
    siteRisk: async () => undefined,
  });
  const stop = deactivations.at(-1)!;
  t.after(async () => {
    await stop();
  });
  activations.at(-1)!();
  await registered;
  scheduler.allowBrowserSite(task.id, "https://example.com");
  assert.deepEqual(read(task.id), {
    status: "supported",
    readOnly: false,
    grant: {
      mode: "domains",
      domains: ["https://example.com"],
      approvedAt: 1000000,
    },
  });
  ctx.store.settings.browserTools = false;
  assert.equal(
    read(task.id).status,
    "supported",
    "turning tools off does not hide retained approval inventory",
  );
  revoke(task.id);
  assert.equal(read(task.id).grant, undefined);
  assert.equal(
    new Scheduler(root, {
      isBusy: () => false,
      run: async () => {
        throw Error("Never run");
      },
    }).browserGrant(task.id),
    undefined,
  );
  await stop();
  assert.equal(read(task.id).status, "unsupported");
});
