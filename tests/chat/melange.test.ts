import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  Melange,
  MelangeConflictError,
  melangeStateSchema,
  type MelangeCompleter,
  type MelangeSnapshot,
  type MelangeStore,
} from "../../electron/memory/melange";

const project = "28977543-6d83-42fd-9cce-0df02ce3ce80";
const projectPath = `projects/${project}.md`;

function stateStore(initial: MelangeSnapshot = { revision: 0, state: null }) {
  let snapshot = structuredClone(initial);
  return {
    async load() {
      return structuredClone(snapshot);
    },
    async save(
      baseRevision: number,
      state: NonNullable<MelangeSnapshot["state"]>,
      checkBeforeWrite?: () => void,
    ) {
      checkBeforeWrite?.();
      if (baseRevision !== snapshot.revision) throw new MelangeConflictError();
      snapshot = {
        revision: baseRevision + 1,
        state: melangeStateSchema.parse(state),
      };
      return structuredClone(snapshot);
    },
    reset() {
      snapshot = { revision: snapshot.revision + 1, state: null };
    },
  } satisfies MelangeStore & { reset(): void };
}

function make(
  store: MelangeStore,
  complete: MelangeCompleter,
  ownsProject = () => true,
) {
  return new Melange({ store, complete, isCurrent: () => true, ownsProject });
}

function answer(
  write: { path: string; content: string }[],
  remove: string[] = [],
  rejected: "sensitive" | null = null,
) {
  return JSON.stringify({
    write,
    delete: remove,
    rejected,
    text: "Updated memory.",
  });
}

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await read();
    if (ready(value)) return value;
    await delay(10);
  }
  throw Error("Memory import did not settle.");
}

test("classified edits update or delete only the reported paths after a commit", async () => {
  const store = stateStore();
  let observed = "";
  const melange = make(store, async (prompt, options) => {
    assert.equal(options?.model, "configured-model");
    assert.ok(options?.maxOutputTokens);
    observed = prompt.input;
    return answer(
      [
        {
          path: "/preferences/writing.md",
          content: "# Writing\nUses short paragraphs.",
        },
      ],
      ["topics/old.md"],
    );
  });
  await melange.setMode("melange", "classic");
  await melange.writeFile("topics/old.md", "Old notes.");
  await melange.writeFile(projectPath, "Project-only notes.");
  const stages: string[] = [];
  const result = await melange.edit({
    request: "Change my writing preference.",
    model: "configured-model",
    onStage: (stage) => stages.push(stage.op),
  });
  assert.deepEqual(result, {
    written: ["preferences/writing.md"],
    deleted: ["topics/old.md"],
    rejected: null,
    text: "Updated memory.",
  });
  assert.deepEqual(stages, ["list", "read", "write", "delete"]);
  assert.match(observed, /Old notes/);
  assert.doesNotMatch(observed, /Project-only notes/);
  assert.equal(await melange.readFile("topics/old.md"), undefined);
  assert.match(
    (await melange.readFile("/preferences/writing.md"))?.content ?? "",
    /short paragraphs/,
  );
  assert.deepEqual(
    (await melange.list()).map((file) => file.path),
    [projectPath, "preferences/writing.md"],
  );
  await melange.setMode("off", "melange");
  assert.ok(await melange.readFile("/preferences/writing.md"));
  assert.equal((await melange.list()).length, 2);
  await assert.rejects(
    melange.deleteFile("/preferences/writing.md"),
    /not enabled/,
  );
});

test("a project edit cannot overwrite another scope or partly apply an invalid plan", async () => {
  const store = stateStore();
  const melange = make(store, async (prompt) => {
    assert.match(prompt.input, /Project-only notes/);
    assert.doesNotMatch(prompt.input, /User-wide notes/);
    return answer([
      { path: projectPath, content: "Modified project." },
      { path: "summary.md", content: "Accidentally leaked project." },
    ]);
  });
  await melange.setMode("melange", "classic");
  await melange.writeFile(projectPath, "Project-only notes.");
  await melange.writeFile("summary.md", "User-wide notes.");
  await assert.rejects(
    melange.edit({ path: `/projects/${project}`, request: "Update project." }),
    /outside/,
  );
  assert.equal(
    (await melange.readFile(projectPath))?.content,
    "Project-only notes.",
  );
  assert.equal(
    (await melange.readFile("summary.md"))?.content,
    "User-wide notes.",
  );
});

test("aborted, rejected, and stale model edits leave memory unchanged", async () => {
  const store = stateStore();
  const abort = new AbortController();
  const melange = make(store, async (prompt, options) => {
    if (prompt.input.includes("abort")) {
      abort.abort();
      options?.signal?.throwIfAborted();
    }
    if (prompt.input.includes("reset")) store.reset();
    return answer(
      [{ path: "summary.md", content: "Unexpected update." }],
      [],
      prompt.input.includes("reject") ? "sensitive" : null,
    );
  });
  await melange.setMode("melange", "classic");
  await melange.writeFile("summary.md", "Original.");
  await assert.rejects(
    melange.edit({ request: "abort", signal: abort.signal }),
    { name: "AbortError" },
  );
  assert.equal(
    (await melange.edit({ request: "reject" })).rejected,
    "sensitive",
  );
  assert.equal((await melange.readFile("summary.md"))?.content, "Original.");
  await assert.rejects(
    melange.edit({ request: "reset" }),
    MelangeConflictError,
  );
  assert.deepEqual(await melange.read("classic"), {
    mode: "classic",
    files: [],
  });
});

test("an expired import lease resumes and the same successful export skips another model call", async () => {
  const store = stateStore();
  let requests = 0;
  const first = make(store, async () => {
    throw Error("Restarted before inference.");
  });
  await first.setMode("melange", "classic");
  first.dispose();
  const id = "34848077-8199-4bb9-b00e-966d20d60dd8";
  const snapshot = await store.load();
  assert.ok(snapshot.state);
  const seed = make(store, async () => {
    requests++;
    return answer([
      { path: "topics/travel.md", content: "Uses rail for regional travel." },
    ]);
  });
  const { raw_hash: submitted } = await seed.startImport(
    "externalImport",
    "Takes trains. api key: raw-credential.",
  );
  const completed = await until(
    () => seed.importStatus("externalImport"),
    (status) => status.status === "ok",
  );
  assert.equal(completed.raw_hash, submitted);
  assert.equal(completed.rejected, 1);
  assert.equal(completed.created, 1);
  assert.equal(requests, 1);
  assert.deepEqual(
    await seed.startImport(
      "externalImport",
      "Takes trains. api key: raw-credential.",
    ),
    { status: "unchanged", raw_hash: submitted },
  );
  assert.equal(requests, 1);
  const stored = await store.load();
  assert.ok(stored.state);
  const terminal = stored.state.externalImport;
  assert.ok(terminal?.status === "ok" && terminal.dedupeKey);
  await store.save(stored.revision, {
    ...stored.state,
    externalImport: {
      status: "pending",
      id,
      ts: completed.ts ?? new Date().toISOString(),
      source: {
        kind: "external",
        content: "Takes trains.",
        redacted: false,
        dedupeKey: terminal.dedupeKey,
      },
      lease: { id: submitted, expiresAt: Date.now() - 1 },
    },
  });
  seed.dispose();
  const resumed = make(store, async (prompt) => {
    requests++;
    assert.match(prompt.input, /Takes trains/);
    assert.doesNotMatch(prompt.input, /raw-credential/);
    return answer([
      { path: "topics/travel.md", content: "Uses rail for regional travel." },
    ]);
  });
  const recovered = await until(
    () => resumed.importStatus("externalImport"),
    (status) => status.status === "ok",
  );
  assert.equal(recovered.raw_hash, id);
  assert.equal(recovered.created, 0);
  assert.equal(requests, 2);
});

test("switch import keeps existing project memory out of general model inputs", async () => {
  const store = stateStore();
  let requests = 0;
  const melange = make(
    store,
    async (prompt) => {
      requests++;
      assert.match(prompt.input, /General facts/);
      assert.doesNotMatch(prompt.input, /Project-only facts/);
      return answer([
        { path: "profile.md", content: "Classified general facts." },
      ]);
    },
    () => true,
  );
  await melange.setMode("melange", "classic", [
    { scope: "global", content: "General facts." },
    { scope: `project:${project}`, content: "Project-only facts." },
  ]);
  const status = await until(
    () => melange.importStatus("switchImport"),
    (job) => job.status === "ok",
  );
  assert.equal(status.created, 2);
  assert.equal(requests, 1);
  assert.equal(
    (await melange.readFile(projectPath))?.content,
    "Project-only facts.",
  );
  assert.equal(
    (await melange.readFile("profile.md"))?.content,
    "Classified general facts.",
  );
});

test("a failed external import can be retried with the same export", async () => {
  const store = stateStore();
  let requests = 0;
  const melange = make(store, async () => {
    if (++requests === 1) throw Error("Provider was unavailable.");
    return answer([{ path: "topics/tools.md", content: "Uses Vim." }]);
  });
  await melange.setMode("melange", "classic");
  const first = await melange.startImport("externalImport", "Uses Vim.");
  const failed = await until(
    () => melange.importStatus("externalImport"),
    (job) => job.status === "failed",
  );
  assert.equal(failed.raw_hash, first.raw_hash);
  assert.deepEqual(await melange.list(), []);
  const retry = await melange.startImport("externalImport", "Uses Vim.");
  assert.notEqual(retry.raw_hash, first.raw_hash);
  const completed = await until(
    () => melange.importStatus("externalImport"),
    (job) => job.status === "ok",
  );
  assert.equal(completed.raw_hash, retry.raw_hash);
  assert.equal(
    (await melange.readFile("topics/tools.md"))?.content,
    "Uses Vim.",
  );
});

test("sensitive opt-out preserves memory until explicit cleanup, which removes only selected material", async () => {
  const store = stateStore();
  const keep = "Uses short paragraphs.";
  const health = "Receives insulin treatment.";
  const profile = `${keep}\n${health}`;
  const fallback = async () => "off" as const;
  const source = "sensitive_memory_popup_modal";
  let cleanupCalls = 0;
  const melange = make(store, async ({ input, instructions }) => {
    if (instructions.startsWith("Remove sensitive personal details")) {
      cleanupCalls++;
      assert.match(input, /Receives insulin treatment/);
      assert.doesNotMatch(input, /Private project facts/);
      return JSON.stringify({
        partial: false,
        changes: [
          { op: "remove", path: "profile.md", fragments: [`\n${health}`] },
          { op: "delete", path: "topics/health.md" },
        ],
      });
    }
    if (instructions.includes("has opted in")) {
      return answer([{ path: "profile.md", content: profile }, { path: "topics/health.md", content: health }]);
    }
    assert.match(instructions, /Never add or expand those facts/);
    return answer([], [], "sensitive");
  }, () => false);
  const offScope = { path: projectPath, content: "Private project facts.", updated_at: new Date().toISOString() };
  await store.save(0, { mode: "melange", files: [offScope] });
  assert.equal((await melange.sensitiveConsent()).consent_decision, null);
  assert.equal((await melange.edit({ request: health })).rejected, "sensitive");

  await melange.setSensitiveConsent({ decision: "CONSENT_DECISION_OPT_IN", source }, false, fallback);
  assert.deepEqual((await melange.edit({ request: health })).written, ["profile.md", "topics/health.md"]);
  await assert.rejects(melange.startSensitiveCleanup(), /Turn off saving sensitive topics/);
  await melange.setSensitiveConsent({ decision: "CONSENT_DECISION_OPT_OUT", source }, false, fallback);
  assert.equal((await melange.readFile("profile.md"))?.content, profile);
  assert.equal((await melange.edit({ request: "Remember my other treatment." })).rejected, "sensitive");

  const { cleanup_id } = await melange.startSensitiveCleanup();
  const result = await until(() => melange.sensitiveCleanupStatus(), ({ state }) => state === "done");
  assert.deepEqual(result, { state: "done", cleanup_id });
  assert.equal(cleanupCalls, 1);
  assert.equal((await melange.readFile("profile.md"))?.content, keep);
  assert.equal(await melange.readFile("topics/health.md"), undefined);
  assert.deepEqual((await store.load()).state?.files.find((file) => file.path === projectPath), offScope);
  const restarted = make(store, async () => { throw Error("Unexpected generation."); });
  assert.equal((await restarted.sensitiveConsent()).consent_decision, "CONSENT_DECISION_OPT_OUT");
  assert.deepEqual(await restarted.sensitiveCleanupStatus(), result);
});

test("cleanup discards a plan that targets an unrelated path", async () => {
  const store = stateStore();
  const melange = make(store, async () => JSON.stringify({
    partial: false,
    changes: [
      { op: "delete", path: "profile.md" },
      { op: "delete", path: projectPath },
    ],
  }), () => false);
  await melange.setMode("melange", "off");
  await melange.writeFile("profile.md", "Uses short paragraphs.");
  const started = await melange.startSensitiveCleanup("sensitive_memory_couldnt_save_notice");
  assert.equal(started.consent_recorded, true);
  const result = await until(() => melange.sensitiveCleanupStatus(), ({ state }) => state !== "running");
  assert.deepEqual(result, { state: "failed", cleanup_id: started.cleanup_id });
  assert.equal((await melange.readFile("profile.md"))?.content, "Uses short paragraphs.");
  assert.equal((await melange.sensitiveConsent()).consent_decision, "CONSENT_DECISION_OPT_OUT");
});
