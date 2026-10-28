import test from "node:test";
import assert from "node:assert/strict";
import type { AppEvent } from "../../shared/types";
import { createFixtureDesktop } from "../../scripts/preview/app-fixture";

const fixture = (params = "") =>
  createFixtureDesktop(
    { history: "empty" },
    new URLSearchParams(`fonts=system&${params}`),
  );

test("CLI renderer data requires explicit nativeCli=some opt in", async () => {
  for (const query of ["", "nativeCli=none", "nativeCli=unknown"]) {
    const api = fixture(query);
    assert.equal(await api.probeImportableCliSessions(), undefined);
    assert.equal(await api.listResumableSessions(), undefined);
    assert.equal(await api.importAllCliSessions(), undefined);
    assert.deepEqual((await api.snapshot()).conversations, []);
  }
});

test("synthetic CLI import only consumes this fixture list and emits its own conversations", async () => {
  const api = fixture("nativeCli=some");
  const events: AppEvent[] = [];
  const stop = api.onEvent((event) => events.push(event));
  try {
    assert.deepEqual(await api.probeImportableCliSessions(), { count: 2 });
    const listed = await api.listResumableSessions();
    assert.equal(listed.length, 2);
    for (const entry of listed) {
      assert.match(entry.title!, /^Synthetic CLI session /);
      assert.match(entry.cwd, /^\/synthetic\/cli-fixture\/workspace-/);
      assert.equal(entry.liveness, "closed");
    }
    listed[0].title = "Mutated answer";
    assert.equal(
      (await api.listResumableSessions())[0].title,
      "Synthetic CLI session 1",
    );
    assert.deepEqual((await api.snapshot()).conversations, []);
    assert.deepEqual(await api.importAllCliSessions(), {
      imported: 2,
      skipped: 0,
    });
    assert.deepEqual(await api.probeImportableCliSessions(), { count: 0 });
    assert.deepEqual(await api.listResumableSessions(), []);
    const imported = (await api.snapshot()).conversations;
    assert.equal(imported.length, 2);
    assert.ok(
      imported.every((entry) => entry.importedHistory && entry.mode === "code"),
    );
    assert.ok(imported.every((entry) => entry.id.startsWith("synthetic-cli-")));
    assert.ok(imported.every((entry) => entry.cwd?.startsWith("/synthetic/")));
    assert.equal(
      events.filter((event) => event.type === "conversation").length,
      2,
    );
    assert.deepEqual(await api.importAllCliSessions(), {
      imported: 0,
      skipped: 0,
    });
    assert.equal(events.length, 2, "repeated import emits no duplicates");
    assert.deepEqual(
      await fixture("nativeCli=some").probeImportableCliSessions(),
      {
        count: 2,
      },
    );
    assert.deepEqual((await fixture().snapshot()).conversations, []);
  } finally {
    stop();
  }
});
