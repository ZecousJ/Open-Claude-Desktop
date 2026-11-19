import test from "node:test";
import assert from "node:assert/strict";
import {
  internalIpcMethods,
  isInternalIpcMethod,
  registerIpcHandler,
} from "../../electron/app/internal-ipc";
import { guardCall } from "../../runner/src/method-guard";
import { desktopMethods } from "../../shared/desktop-bridge";

test("private IPC operations stay in the in-process registry", async () => {
  const local = new Map<string, (...args: any[]) => any>();
  const routed = new Map<string, (...args: any[]) => any>();
  const ipc = new Map<string, (...args: any[]) => any>();
  let routes = 0;
  for (const method of internalIpcMethods) {
    registerIpcHandler(method, (id, offer) => `${id}:${offer}`, {
      local,
      routed,
      route: (_name, fn) => {
        routes++;
        return fn;
      },
      expose: (name, fn) => {
        ipc.set(`app:${name}`, fn);
      },
    });
    assert.equal(await local.get(method)!("owned", "offer"), "owned:offer");
    assert.equal(routed.has(method), false);
    assert.equal(ipc.has(`app:${method}`), false);
    assert.equal(desktopMethods.includes(method), false);
    assert.throws(() => guardCall(method, [], { modes: ["code", "cowork"] }));
  }
  assert.equal(routes, 0);
  assert.equal(isInternalIpcMethod("officialGitDirectory"), true);
  for (const name of internalIpcMethods) {
    assert.equal(isInternalIpcMethod(name + "Extra"), false);
    assert.equal(isInternalIpcMethod(name + " "), false);
  }
  assert.equal(isInternalIpcMethod("toString"), false);
});

test("private classification is exact and ordinary handler routing remains unchanged", () => {
  const local = new Map(),
    routed = new Map(),
    exposed = new Map();
  let routes = 0;
  for (const name of [
    "send",
    "officialReleaseCodeNewTaskExtra",
    "officialReleaseCodeNewTask ",
    "officialreleasecodenewtask",
  ]) {
    assert.equal(isInternalIpcMethod(name), false);
    registerIpcHandler(name, () => name, {
      local,
      routed,
      route: (_name, fn) => {
        routes++;
        return fn;
      },
      expose: (n, fn) => {
        exposed.set(n, fn);
      },
    });
  }
  assert.equal(routes, 4);
  assert.equal(local.size, 4);
  assert.equal(routed.size, 4);
  assert.equal(exposed.size, 4);
});
