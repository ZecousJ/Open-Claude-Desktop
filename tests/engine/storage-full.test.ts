import assert from "node:assert/strict";
import test from "node:test";
import { bridgeErrorMessage } from "../../shared/desktop-bridge";
import {
  isStorageFullError,
  storageFullMessage,
} from "../../shared/turn-errors";
import { failureMessage } from "../../src/transcript/reply-failure";
import { codeFailure } from "../../src/transcript/CodeTurnError";
import { useElectronShim } from "../runner/runner-core-support.test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexRPC } from "../../electron/engine/rpc";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

useElectronShim();
const { callError } = await import("../../runner/src/dispatcher");
const { WebAppContext } = await import("../../runner/src/web-app-context");

test("storage errors keep actionable official copy across web, desktop and turn failures", () => {
  for (const message of [
    "ENOSPC: write /private/user/file",
    "No space left on device (os error 28)",
    "Disk quota exceeded",
    "EDQUOT: write",
  ]) {
    const error = Object.assign(new Error(message), {
      syscall: "write",
      errno: -28,
    });
    assert.equal(isStorageFullError(error), true);
    assert.deepEqual(callError(error), { message: storageFullMessage });
    assert.equal(bridgeErrorMessage(error), storageFullMessage);
    assert.equal(failureMessage(message), storageFullMessage);
    assert.equal(codeFailure(message).hint, storageFullMessage);
  }
  assert.equal(
    bridgeErrorMessage(
      new Error(
        "Error invoking remote method 'app:send': Error: ENOSPC: write",
      ),
    ),
    storageFullMessage,
  );
  assert.equal(isStorageFullError({ code: "ENOSPC" }), true);
  assert.equal(isStorageFullError("ENOENT: no such file"), false);
  assert.equal(isStorageFullError(undefined), false);
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  assert.equal(isStorageFullError(cycle), false);
  assert.equal(
    isStorageFullError(
      new Error("write failed", { cause: { code: "ENOSPC" } }),
    ),
    true,
  );
});

test("a Codex startup exit retains storage-full diagnostics without exposing stderr paths", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
  });
  const rpc = new CodexRPC();
  const start = rpc.startWith(
    () => child as unknown as ChildProcessWithoutNullStreams,
  );
  child.stderr.write("fatal: ENO");
  child.stderr.write("SPC: /private/profile/secret\n");
  child.emit("exit", 1, null);
  await assert.rejects(start, { message: storageFullMessage });
  child.stdin.end();
  child.stdout.end();
  child.stderr.end();
});

test("runner pressure housekeeping retains live sandboxes and only reclaims idle caches", (context) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-pressure-"));
  context.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const cache = (space: string) =>
    path.join(profile, "spaces", space, "codex-home", ".tmp");
  for (const space of ["active", "idle"])
    fs.mkdirSync(cache(space), { recursive: true });
  let pressure = false;
  const ctx = {
    store: { root: profile },
    runtime: { cachePressure: () => pressure },
    activeSpaces: new Set(["active"]),
    lastCacheCheck: 0,
    log() {},
  };
  WebAppContext.prototype.reclaimCaches.call(ctx as any);
  assert.equal(fs.existsSync(cache("idle")), true);
  pressure = true;
  ctx.lastCacheCheck = 0;
  WebAppContext.prototype.reclaimCaches.call(ctx as any);
  assert.equal(fs.existsSync(cache("idle")), false);
  assert.equal(fs.existsSync(cache("active")), true);
  fs.mkdirSync(cache("idle"), { recursive: true });
  WebAppContext.prototype.reclaimCaches.call(ctx as any);
  assert.equal(fs.existsSync(cache("idle")), true);
});

test("idle eviction waits for space engines to stop before the shared engine", async () => {
  const stopped: string[] = [];
  let busy = true;
  const ctx = {
    busy: () => busy,
    engines: {
      async stopRemote() {
        await Promise.resolve();
        stopped.push("spaces");
      },
    },
    engine: {
      async stop() {
        stopped.push("shared");
      },
    },
  };
  await WebAppContext.prototype.stopEngine.call(ctx as any);
  assert.deepEqual(stopped, []);
  busy = false;
  await WebAppContext.prototype.stopEngine.call(ctx as any);
  assert.deepEqual(stopped, ["spaces", "shared"]);
});

test("closing a space unlinks only its cache after releasing its sandbox", (context) => {
  const profile = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-close-cache-"),
  );
  context.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const root = path.join(profile, "spaces", "idle");
  const home = path.join(root, "codex-home");
  fs.mkdirSync(path.join(home, ".tmp"), { recursive: true });
  fs.writeFileSync(path.join(home, "session.json"), "keep");
  let released = false;
  const ctx = {
    userId: 138,
    store: { root: profile },
    activeSpaces: new Set(["idle"]),
    spaceRoot: () => root,
    runtime: {
      releaseSandbox(userId: number, sandboxId: string) {
        assert.equal(userId, 138);
        assert.equal(sandboxId, "space-138-idle");
        assert.equal(fs.existsSync(path.join(home, ".tmp")), true);
        released = true;
      },
    },
  };
  WebAppContext.prototype.spaceStopped.call(ctx as any, "idle");
  assert.equal(released, true);
  assert.equal(ctx.activeSpaces.has("idle"), false);
  assert.equal(fs.existsSync(path.join(home, ".tmp")), false);
  assert.equal(
    fs.readFileSync(path.join(home, "session.json"), "utf8"),
    "keep",
  );
});
