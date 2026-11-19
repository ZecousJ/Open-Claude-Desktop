import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalMemoryStore } from "../../electron/memory/local-store";
import { MemoryService } from "../../electron/memory/service";
import { MemorySynthesizer } from "../../electron/memory/synthesizer";
import { MemoryControlsConflictError } from "../../electron/memory/store";
import { openPolicy } from "../../shared/client-policy";
import { chat } from "../support/memory-fixtures";
import { batchChats } from "../../electron/memory/digest";

const project = "project:1b4e28ba-2fa1-11d2-883f-0016d3cca427" as const;
const notes = (text: string) => `## Work context\n${text}`;
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { open, promise };
}
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-controls-"));
  const store = new LocalMemoryStore(root);
  const service = new MemoryService({
    store,
    policy: () => openPolicy,
    changed() {},
  });
  t.after(() => {
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, store, service };
}

test("control replacement validates everything, preserves order, persists and isolates scopes", async (t) => {
  const { root, service } = fixture(t);
  await service.setPrefs({ generate: true });
  await service.addEdit(project, "Project only");
  const first = await service.replaceControls(
    "global",
    ["  Concise\nreplies ", "Use metric", "Use metric"],
    service.controlsVersion("global")!,
  );
  assert.deepEqual(
    first.edits.map((e) => e.text),
    ["Concise replies", "Use metric", "Use metric"],
  );
  assert.equal(new LocalMemoryStore(root).current().edits.length, 4);
  const bytes = fs.readFileSync(path.join(root, "memory.json"), "utf8");
  for (const controls of [
    ["Valid", "password=secret123"],
    ["x".repeat(501)],
    [""],
    Array(51).fill("Many"),
  ]) {
    await assert.rejects(
      service.replaceControls("global", controls, first.controlsVersion!),
    );
    assert.equal(
      fs.readFileSync(path.join(root, "memory.json"), "utf8"),
      bytes,
    );
  }
  const cleared = await service.replaceControls(
    "global",
    [],
    first.controlsVersion!,
  );
  assert.deepEqual(cleared.edits, []);
  assert.deepEqual(
    service.docView(project)!.edits.map((e) => e.text),
    ["Project only"],
  );
});

test("two loaded windows cannot overwrite controls; reset tombstones survive reopening", async (t) => {
  const { root, service } = fixture(t);
  await service.setPrefs({ generate: true });
  const other = new LocalMemoryStore(root);
  const base = service.controlsVersion("global")!;
  const results = await Promise.allSettled([
    service.replaceControls("global", ["First"], base),
    other.replaceControls("global", ["Second"], base),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.filter(
      (r) =>
        r.status === "rejected" &&
        r.reason instanceof MemoryControlsConflictError,
    ).length,
    1,
  );
  await service.refresh();
  const saved = service.controlsVersion("global")!;
  await service.reset("global");
  await assert.rejects(
    other.replaceControls("global", ["Resurrect"], saved),
    (e: unknown) => e instanceof MemoryControlsConflictError && e.reset,
  );
  const afterScopeReset = service.controlsVersion("global")!;
  await service.reset();
  await assert.rejects(
    new LocalMemoryStore(root).replaceControls(
      "global",
      ["Resurrect"],
      afterScopeReset,
    ),
    (e: unknown) => e instanceof MemoryControlsConflictError && e.reset,
  );
  assert.equal(service.docView("global"), null);
});

test("regeneration reads beyond the nightly batch cap and commits one document", async (t) => {
  const { root, service } = fixture(t);
  await service.setPrefs({ generate: true });
  await service.saveDoc("global", notes("Original"), 0);
  await service.addEdit("global", "Use metric");
  const history = Array.from({ length: batchChats * 3 + 1 }, (_, i) =>
    chat(`c${i}`, `C${i}`, [[`Fact ${i}`, "Noted"]], { updatedAt: i + 1 }),
  );
  history.push(
    chat("private", "Private", [["PrivateMarker", "a"]], { incognito: true }),
    chat("code", "Code", [["CodeMarker", "a"]], { mode: "code" }),
    chat("project", "Project", [["ProjectMarker", "a"]], {
      projectId: project.slice(8),
    }),
  );
  let calls = 0;
  const task = new MemorySynthesizer({
    root,
    service,
    conversations: () => history,
    complete: async (prompt) => {
      calls++;
      assert.match(prompt.input, /Use metric/);
      assert.doesNotMatch(
        prompt.input,
        /PrivateMarker|CodeMarker|ProjectMarker/,
      );
      assert.equal(service.docView("global")!.content, notes("Original"));
      return notes(`Batch ${calls}`);
    },
  });
  t.after(() => task.stop());
  const result = await task.regenerate("global");
  assert.equal(result.status, "done");
  assert.equal(result.conversations, batchChats * 3 + 1);
  assert.equal(calls, 4);
  assert.equal(service.docView("global")!.revision, 2);
  assert.equal(service.docView("global")!.content, notes("Batch 4"));
  assert.equal(service.docView("global")!.edits.length, 1);
});

test("regeneration with no new chats applies controls; failures and concurrent edits keep old memory", async (t) => {
  const { root, service } = fixture(t);
  await service.setPrefs({ generate: true });
  await service.saveDoc("global", notes("Original"), 0);
  await service.addEdit("global", "Use metric");
  let action: "ok" | "fail" | "change" | "reset" | "stop" = "ok";
  const task = new MemorySynthesizer({
    root,
    service,
    conversations: () => [],
    complete: async (prompt) => {
      assert.match(prompt.input, /Use metric/);
      if (action === "fail") throw new Error("Model unavailable");
      if (action === "change")
        await service.addEdit("global", "New preference");
      if (action === "reset") await service.reset("global");
      if (action === "stop") task.stop();
      return notes("Metric units");
    },
  });
  t.after(() => task.stop());
  assert.equal((await task.regenerate("global")).status, "done");
  const revision = service.docView("global")!.revision;
  for (const next of ["fail", "change"] as const) {
    action = next;
    assert.equal((await task.regenerate("global")).status, "failed");
    assert.equal(service.docView("global")!.revision, revision);
  }
  action = "reset";
  assert.equal((await task.regenerate("global")).status, "failed");
  assert.equal(service.docView("global"), null);
  await service.addEdit("global", "Use metric");
  action = "stop";
  assert.equal((await task.regenerate("global")).status, "failed");
  assert.equal(service.docView("global")!.content, "");
});

test("a later model batch failure preserves both the document and all unread cursors", async (t) => {
  const { root, service } = fixture(t);
  await service.setPrefs({ generate: true });
  await service.saveDoc("global", notes("Original"), 0);
  let calls = 0;
  const task = new MemorySynthesizer({
    root,
    service,
    conversations: () =>
      Array.from({ length: batchChats + 1 }, (_, i) =>
        chat(`c${i}`, "Fact", [["A", "B"]]),
      ),
    complete: async () => {
      if (++calls === 2) throw new Error("Second batch failed");
      return notes("Partial");
    },
  });
  t.after(() => task.stop());
  assert.equal((await task.regenerate("global")).status, "failed");
  assert.equal(service.docView("global")!.content, notes("Original"));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, "memory-cursor.json"), "utf8"))
      .cursors,
    {},
  );
});

test("duplicate regenerations share one model run while project and scheduled work wait", async (t) => {
  const { root, service } = fixture(t);
  await service.setPrefs({ generate: true });
  const started = gate(),
    release = gate();
  const prompts: string[] = [];
  const task = new MemorySynthesizer({
    root,
    service,
    conversations: () => [
      chat("g", "Global", [["Global history", "A"]]),
      chat("p", "Project", [["Project history", "A"]], {
        projectId: project.slice(8),
      }),
      chat("o", "Other", [["Other history", "A"]], {
        projectId: "11111111-1111-4111-8111-111111111111",
      }),
    ],
    complete: async ({ input }) => {
      prompts.push(input);
      if (prompts.length === 1) {
        started.open();
        await release.promise;
      }
      return notes(`Result ${prompts.length}`);
    },
  });
  t.after(() => task.stop());
  const owner = task.regenerate("global");
  await started.promise;
  const joiner = task.regenerate("global");
  const detached = new AbortController();
  const disconnected = task.regenerate("global", detached.signal);
  const projectRun = task.regenerate(project);
  const scheduled = task.run();
  detached.abort();
  assert.match((await disconnected).message ?? "", /cancelled/);
  assert.equal(prompts.length, 1);
  release.open();

  assert.deepEqual(await owner, await joiner);
  assert.equal((await projectRun).status, "done");
  assert.equal((await scheduled).conversations, 1);
  assert.equal(prompts.length, 3);
  assert.match(prompts[0], /Global history/);
  assert.match(prompts[1], /Project history/);
  assert.match(prompts[2], /Other history/);
  assert.equal(service.docView("global")?.revision, 1);
  assert.equal(service.docView(project)?.revision, 1);
});

test("cancelling the owner aborts the shared model request and preserves the previous document and cursor", async (t) => {
  const { root, service } = fixture(t);
  await service.setPrefs({ generate: true });
  const original = await service.saveDoc("global", notes("Original"), 0);
  const started = gate(),
    release = gate();
  let modelSignal: AbortSignal | undefined;
  const task = new MemorySynthesizer({
    root,
    service,
    conversations: () => [chat("g", "Global", [["Global history", "A"]])],
    complete: async (_prompt, options) => {
      modelSignal = options?.signal;
      started.open();
      await release.promise;
      return notes("Late answer");
    },
  });
  t.after(() => task.stop());
  const controller = new AbortController();
  const owner = task.regenerate("global", controller.signal);
  await started.promise;
  const joiner = task.regenerate("global");
  const queuedController = new AbortController();
  const queued = task.regenerate(project, queuedController.signal);
  queuedController.abort();
  assert.match((await queued).message ?? "", /cancelled/);
  controller.abort();
  assert.equal(modelSignal?.aborted, true);
  release.open();
  const result = await owner;
  assert.match(result.message ?? "", /cancelled/);
  assert.deepEqual(await joiner, result);
  assert.deepEqual(service.docView("global"), original);
  assert.equal(service.docView(project), null);
  assert.equal(fs.existsSync(path.join(root, "memory-cursor.json")), false);
});

test("closing the account while a write is queued prevents a later local commit", async (t) => {
  const { root, service } = fixture(t);
  await service.setPrefs({ generate: true });
  const pending = service.replaceControls(
    "global",
    ["Too late"],
    service.controlsVersion("global")!,
  );
  service.close();
  await assert.rejects(pending, /account changed/);
  assert.deepEqual(new LocalMemoryStore(root).current().edits, []);
});
