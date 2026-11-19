/** Invoked by the Go/Postgres integration test against its real HTTP router. */
import assert from "node:assert/strict";
import { ClaudexMemory } from "../../electron/sub2api/claudex-memory";
import { RemoteMemoryStore } from "../../electron/memory/remote-store";
import { MemoryService } from "../../electron/memory/service";
import { MemoryControlsConflictError } from "../../electron/memory/store";
import { openPolicy } from "../../shared/client-policy";
const [origin, root] = process.argv.slice(2);
assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
const api = new ClaudexMemory(origin);
const make = () =>
  new RemoteMemoryStore(api, (call) => call("test-token"), root);
const store = make();
const service = new MemoryService({
  store,
  policy: () => openPolicy,
  changed() {},
});
await service.ready();
await service.setPrefs({ generate: true });
const initial = service.controlsVersion("global")!;
assert.ok(initial);
const saved = await service.replaceControls(
  "global",
  ["Metric units", "Concise answers"],
  initial,
);
assert.deepEqual(
  saved.edits.map((e) => e.text),
  ["Metric units", "Concise answers"],
);
assert.notEqual(saved.controlsVersion, initial);
const other = make();
await other.load();
assert.equal(other.current()!.controlsVersions!.global, saved.controlsVersion);
await service.addEdit("global", "New preference");
await assert.rejects(
  other.replaceControls("global", ["Stale"], saved.controlsVersion!),
  MemoryControlsConflictError,
);
await service.saveDoc("global", "## Work context\nOriginal", 0);
const doc = service.docView("global")!;
await service.addEdit("global", "Changed in flight");
await assert.rejects(
  service.saveGenerated(
    "global",
    "Old generation",
    doc.revision,
    undefined,
    doc.controlsVersion,
  ),
  MemoryControlsConflictError,
);
assert.equal(service.docView("global")!.content, doc.content);
const beforeReset = service.controlsVersion("global")!;
await service.reset("global");
await assert.rejects(
  other.replaceControls("global", ["Resurrect"], beforeReset),
  (e: unknown) => e instanceof MemoryControlsConflictError && e.reset,
);
await service.replaceControls(
  "global",
  ["After reset"],
  service.controlsVersion("global")!,
);
const cached = make();
assert.deepEqual(
  cached.current()!.edits.map((e) => e.text),
  ["After reset"],
);
assert.equal(
  cached.current()!.controlsVersions!.global,
  service.controlsVersion("global"),
);
cached.close();
other.close();
service.close();
console.log(
  "PASS: real TypeScript remote store → HTTP → Go handler → PostgreSQL, including cache, atomic controls, conflicts, generated-save guard and reset tombstone.",
);
