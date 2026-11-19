/** No processes, signals, sockets or real environment: EventEmitter fixtures only. */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runAcceptanceChild } from "../../scripts/acceptance-child-lifecycle.mjs";
const hash = "a".repeat(64);
function fixture({ throwLog = false, throwSpawn = false } = {}) {
  const child = new EventEmitter(),
    signals = new EventEmitter(),
    calls = [],
    logs = [],
    kills = [];
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    kills.push(signal);
    return true;
  };
  const env = { SECRET_FIXTURE: "must-not-log", PRESERVE: "yes" };
  const promise = runAcceptanceChild(
    {
      command: "/fixture/electron",
      args: ["."],
      cwd: "/fixture",
      env,
      buildSha256: hash,
    },
    {
      spawn(...args) {
        calls.push(args);
        if (throwSpawn) throw Error("private path must-not-log");
        return child;
      },
      signals,
      log(value) {
        if (throwLog) throw Error("logger unavailable");
        logs.push(value);
      },
    },
  );
  return { child, signals, calls, logs, kills, promise, env };
}
test("async launcher preserves options and logs only child identity/build and lifecycle", async () => {
  const f = fixture();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], [
    "/fixture/electron",
    ["."],
    { cwd: "/fixture", env: f.env, stdio: "inherit" },
  ]);
  f.child.emit("spawn");
  assert.deepEqual(f.logs[0], {
    event: "spawn",
    childPid: 12345,
    buildSha256: hash,
  });
  f.child.exitCode = 0;
  f.child.emit("exit", 0, null);
  assert.deepEqual(await f.promise, { code: 0, signal: null });
  assert.equal(f.signals.listenerCount("SIGINT"), 0);
  assert.equal(f.signals.listenerCount("SIGTERM"), 0);
  f.signals.emit("SIGTERM");
  assert.deepEqual(f.kills, []);
  assert.doesNotMatch(
    JSON.stringify(f.logs),
    /must-not-log|SECRET_FIXTURE|\/fixture/,
  );
});
test("received signal forwards once to only the owned child, without force escalation", async () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const f = fixture();
    f.child.emit("spawn");
    f.signals.emit(signal);
    f.signals.emit(signal);
    f.signals.emit(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
    assert.deepEqual(f.kills, [signal]);
    f.child.signalCode = signal;
    f.child.emit("exit", null, signal);
    assert.deepEqual(await f.promise, { code: null, signal });
    assert.equal(f.signals.listenerCount(signal), 0);
  }
});
test("exited child, unknown PID and failed forwarding never target a replacement or force kill", async () => {
  for (const state of ["exited", "missing", "throws", "false"]) {
    const f = fixture();
    if (state === "exited") f.child.exitCode = 0;
    if (state === "missing") f.child.pid = undefined;
    if (state === "throws")
      f.child.kill = (signal) => {
        f.kills.push(signal);
        throw Error("gone");
      };
    if (state === "false")
      f.child.kill = (signal) => {
        f.kills.push(signal);
        return false;
      };
    f.signals.emit("SIGTERM");
    f.signals.emit("SIGINT");
    assert.deepEqual(
      f.kills,
      state === "throws" || state === "false" ? ["SIGTERM"] : [],
    );
    f.child.emit("exit", 0, null);
    await f.promise;
  }
});
test("spawn failures and child errors are redacted and release signal handlers", async () => {
  for (const throwSpawn of [true, false]) {
    const f = fixture({ throwSpawn });
    const check = assert.rejects(f.promise, /acceptance child process failed/);
    if (!throwSpawn)
      f.child.emit("error", Error("SECRET_FIXTURE must-not-log"));
    await check;
    assert.equal(f.signals.listenerCount("SIGINT"), 0);
    assert.equal(f.signals.listenerCount("SIGTERM"), 0);
    assert.deepEqual(f.kills, []);
    assert.doesNotMatch(JSON.stringify(f.logs), /must-not-log|SECRET_FIXTURE/);
  }
});
test("logging failure never prevents child cleanup; invalid build identity never spawns", async () => {
  const f = fixture({ throwLog: true });
  f.child.emit("spawn");
  f.child.emit("exit", 7, null);
  assert.deepEqual(await f.promise, { code: 7, signal: null });
  assert.equal(f.signals.listenerCount("SIGTERM"), 0);
  let started = false;
  await assert.rejects(
    runAcceptanceChild(
      {
        command: "/fixture",
        args: [],
        cwd: "/fixture",
        env: {},
        buildSha256: "bad",
      },
      {
        spawn() {
          started = true;
        },
        signals: new EventEmitter(),
        log() {},
      },
    ),
    /Invalid/,
  );
  assert.equal(started, false);
});

test("post-spawn child error retains ownership until observed exit", async () => {
  const f = fixture();
  f.child.emit("spawn");
  f.child.emit("error", Error("signal failed; private diagnostics"));
  assert.equal(f.signals.listenerCount("SIGTERM"), 1);
  f.signals.emit("SIGTERM");
  assert.deepEqual(f.kills, ["SIGTERM"]);
  f.child.emit("exit", 9, null);
  assert.deepEqual(await f.promise, { code: 9, signal: null });
  assert.equal(f.signals.listenerCount("SIGTERM"), 0);
  assert.doesNotMatch(JSON.stringify(f.logs), /private diagnostics/);
});
