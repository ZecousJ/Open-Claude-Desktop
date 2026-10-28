import test from "node:test";
import assert from "node:assert/strict";
import { createFixtureDesktop } from "../../scripts/preview/app-fixture";

async function withTimer(
  check: (timers: { callback(): void; delay: number }[]) => Promise<void>,
) {
  const original = globalThis.setTimeout;
  const timers: { callback(): void; delay: number }[] = [];
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    timers.push({ callback, delay });
    return timers.length;
  }) as unknown as typeof setTimeout;
  try {
    await check(timers);
  } finally {
    globalThis.setTimeout = original;
  }
}
const fixture = (query = "") =>
  createFixtureDesktop(
    { history: "empty" },
    new URLSearchParams(`fonts=system&${query}`),
  );

test("fixture snapshot delay starts on the first read and concurrent initial reads share one wait", async () => {
  await withTimer(async (timers) => {
    const api = fixture("snapshotDelay=1250");
    assert.equal(
      timers.length,
      0,
      "creating a fixture never starts its snapshot clock",
    );
    let settled = 0;
    const first = api.snapshot().then((value) => {
      settled++;
      return value;
    });
    const second = api.snapshot().then((value) => {
      settled++;
      return value;
    });
    assert.deepEqual(
      timers.map((entry) => entry.delay),
      [1250],
    );
    await Promise.resolve();
    assert.equal(settled, 0);
    timers[0]!.callback();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(settled, 2);
    assert.deepEqual(a, b);
    assert.notEqual(
      a,
      b,
      "each caller still gets an independent snapshot clone",
    );
    await api.saveSettings({ ...a.settings, name: "Fixture after boot" });
    const after = await api.snapshot();
    assert.equal(after.settings.name, "Fixture after boot");
    assert.equal(
      timers.length,
      1,
      "later reads never repeat the startup delay",
    );
    a.settings.name = "Caller mutation";
    assert.equal((await api.snapshot()).settings.name, "Fixture after boot");
  });
});

test("ordinary fixture snapshots stay immediate and opt-in delays are bounded to 0..5000 ms", async () => {
  await withTimer(async (timers) => {
    for (const query of [
      "",
      "snapshotDelay=0",
      "snapshotDelay=-10",
      "snapshotDelay=invalid",
      "snapshotDelay=Infinity",
    ])
      assert.ok((await fixture(query).snapshot()).settings);
    assert.equal(timers.length, 0);
    const capped = fixture("snapshotDelay=999999").snapshot();
    assert.equal(timers[0]!.delay, 5000);
    timers[0]!.callback();
    assert.ok((await capped).settings);
    assert.equal(timers.length, 1);
  });
});
