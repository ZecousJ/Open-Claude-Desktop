import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WindowsSandbox,
  runWindowsSandboxSetup,
} from "../../electron/workspace/windows-sandbox";

class MockRPC extends EventEmitter {
  calls: string[] = [];
  readiness = "ready";
  async call(method: string): Promise<any> {
    this.calls.push(method);
    if (method === "windowsSandbox/readiness")
      return { status: this.readiness };
    queueMicrotask(() => this.complete());
    return { started: true };
  }
  complete(success = true) {
    this.emit("notification", {
      method: "windowsSandbox/setupCompleted",
      params: {
        mode: "unelevated",
        success,
        error: success ? null : "preflight failed",
      },
    });
  }
}
function temporary(t: any) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-windows-sandbox-test-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("Windows is blocked until a successful setup receipt and native readiness agree", async (t) => {
  const root = temporary(t);
  const rpc = new MockRPC();
  const sandbox = new WindowsSandbox(root, "win32");
  assert.throws(() => sandbox.assertReady(), /Settings → Claudex Code/);
  assert.equal(await sandbox.check(rpc), false);
  assert.throws(() => sandbox.assertReady());
  assert.deepEqual(await sandbox.setup(rpc, root), {
    ready: true,
    message:
      "The Windows restricted-token sandbox is set up. You can start conversations and run local tasks.",
  });
  assert.doesNotThrow(() => sandbox.assertReady());
  const resumed = new WindowsSandbox(root, "win32");
  assert.equal(await resumed.check(rpc), true);
  rpc.readiness = "updateRequired";
  assert.equal(await resumed.check(rpc), false);
  assert.throws(() => resumed.assertReady());
});

test("successful completion before the start response is handled and listeners cleaned", async () => {
  const rpc = new MockRPC();
  rpc.call = async () => {
    rpc.complete();
    return { started: true };
  };
  await runWindowsSandboxSetup(rpc, "/test");
  assert.equal(rpc.listenerCount("notification"), 0);
  assert.equal(rpc.listenerCount("failure"), 0);
});

test("failed setup never creates a receipt or enables commands", async (t) => {
  const root = temporary(t);
  const rpc = new MockRPC();
  const sandbox = new WindowsSandbox(root, "win32");
  rpc.call = async () => {
    queueMicrotask(() => rpc.complete(false));
    return { started: true };
  };
  await assert.rejects(sandbox.setup(rpc, root), /preflight failed/);
  assert.throws(() => sandbox.assertReady());
  assert.equal(fs.existsSync(path.join(root, "windows-sandbox.json")), false);
});

test("RPC rejection and timeout both clean up setup listeners", async () => {
  const rpc = new MockRPC();
  rpc.call = async () => {
    throw new Error("not supported");
  };
  await assert.rejects(runWindowsSandboxSetup(rpc, "/test"), /not supported/);
  assert.equal(rpc.listenerCount("notification"), 0);
  rpc.call = async () => ({ started: true });
  await assert.rejects(runWindowsSandboxSetup(rpc, "/test", 10), /timed out/);
  assert.equal(rpc.listenerCount("notification"), 0);
  assert.equal(rpc.listenerCount("failure"), 0);
});

test("process failure interrupts pending setup", async () => {
  const rpc = new MockRPC();
  rpc.call = async () => ({ started: true });
  const setup = runWindowsSandboxSetup(rpc, "/test");
  rpc.emit("failure", new Error("process exited"));
  await assert.rejects(setup, /process exited/);
  assert.equal(rpc.listenerCount("notification"), 0);
});

test("duplicate setup callers share one request; reconnect invalidates old completion", async (t) => {
  const root = temporary(t);
  const rpc = new MockRPC();
  const sandbox = new WindowsSandbox(root, "win32");
  const first = sandbox.setup(rpc, root);
  assert.equal(sandbox.setup(rpc, root), first);
  sandbox.reset();
  await assert.rejects(first, /reconnected/);
  assert.equal(
    rpc.calls.filter((method) => method === "windowsSandbox/setupStart").length,
    1,
  );
  assert.equal(fs.existsSync(path.join(root, "windows-sandbox.json")), false);
  assert.throws(() => sandbox.assertReady());
});

test("stale or malformed receipt cannot bypass setup", async (t) => {
  const root = temporary(t);
  const rpc = new MockRPC();
  const sandbox = new WindowsSandbox(root, "win32");
  const receipt = path.join(root, "windows-sandbox.json");
  fs.writeFileSync(
    receipt,
    JSON.stringify({ version: 1, runtimeVersion: "0.1.0", mode: "unelevated" }),
  );
  assert.equal(await sandbox.check(rpc), false);
  fs.writeFileSync(receipt, "invalid json");
  assert.equal(await sandbox.check(rpc), false);
  assert.throws(() => sandbox.assertReady());
});

test("non-Windows platform never invokes native Windows setup", async (t) => {
  const root = temporary(t);
  const rpc = new MockRPC();
  const sandbox = new WindowsSandbox(root, "darwin");
  assert.doesNotThrow(() => sandbox.assertReady());
  assert.equal(await sandbox.check(rpc), true);
  assert.equal((await sandbox.setup(rpc, root)).ready, true);
  assert.equal(rpc.calls.length, 0);
});
