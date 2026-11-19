import assert from "node:assert/strict";
import test from "node:test";
import { HostPowerHistory, hostPowerHistory } from "../electron/app/host-power";
import { registerHostPower } from "../electron/official-ui/native/power";
import type { NativeHost } from "../electron/official-ui/native/host";

test("sleep intervals use real suspend and resume timestamps and expire", () => {
  const power = new HostPowerHistory();
  assert.equal(power.resume(10), undefined);
  power.suspend(20);
  power.suspend(25);
  assert.equal(power.snapshot(25).suspendedSinceMs, 20);
  assert.deepEqual(power.resume(30), { fromMs: 20, toMs: 30 });
  const snapshot = power.snapshot(35);
  assert.equal(snapshot.suspendedSinceMs, undefined);
  assert.deepEqual(snapshot.recentSleeps, [{ fromMs: 20, toMs: 30 }]);
  snapshot.recentSleeps[0].toMs = 50_000;
  assert.equal(power.snapshot(45).recentSleeps[0].toMs, 30);
  assert.deepEqual(power.snapshot(30 + 15 * 60_000 + 1).recentSleeps, []);
});

test("the original host power channels read and receive the same process history", () => {
  const handlers = new Map<string, () => unknown>();
  const published: { domain: string; event: string; snapshot: unknown }[] = [];
  const fake = {
    on(name: string, handler: () => unknown) {
      handlers.set(name, handler);
    },
    emit(domain: string, event: string, snapshot: unknown) {
      published.push({ domain, event, snapshot });
    },
  } as unknown as NativeHost;
  const dispose = registerHostPower(fake);
  try {
    assert.deepEqual(handlers.get("WakeScheduler.getStatus")!(), {
      status: "notFound", requiresSetup: false, approvedThisCycle: false, supported: false,
    });
    assert.equal(handlers.get("WakeScheduler.openSettings")!(), undefined);
    const now = Date.now();
    hostPowerHistory.suspend(now - 20);
    assert.deepEqual(handlers.get("WindowState.hostPower_$store$_getStateSync")!(), {
      suspendedSinceMs: now - 20, recentSleeps: [], recentStalls: [],
    });
    assert.deepEqual(hostPowerHistory.resume(now), { fromMs: now - 20, toMs: now });
    assert.deepEqual(published.at(-1), {
      domain: "WindowState",
      event: "hostPower_$store$_update",
      snapshot: handlers.get("WindowState.hostPower_$store$_getState")!(),
    });
    dispose();
    hostPowerHistory.suspend(now);
    hostPowerHistory.resume(now + 5);
    assert.equal(published.length, 2);
  } finally {
    dispose();
  }
});
