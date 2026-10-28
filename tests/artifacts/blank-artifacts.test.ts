import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../../electron/store/store";
import { CloudStore } from "../../runner/src/cloud-store";
import { registerBlankArtifactHandlers } from "../../electron/ipc/blank-artifacts";
import {
  blankArtifactDirectory,
  resolveBlankArtifactFile,
} from "../../electron/artifacts/blank-artifact-files";
import {
  blankArtifactFiles,
  blankArtifactInitialContent,
  blankArtifactOpeningContext,
  type CreatedBlankArtifact,
} from "../../shared/blank-artifacts";
import { artifactOutputKinds } from "../../shared/artifact-output";
import type { AppContext } from "../../electron/app/app-context";
import { webMethodKind } from "../../shared/web-bridge-methods";
import { CloudRouter } from "../../electron/cloud/cloud-router";

const deferred = () => {
  let resolve!: () => void, reject!: (e: unknown) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function setup(
  t: { after(fn: () => unknown): unknown },
  storeFactory?: (root: string) => Store,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-blank-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = storeFactory?.(root) ?? new Store(root);
  store.settings.providers[0].model = "model";
  store.settings.providers[0].models = ["model"];
  const events: unknown[] = [];
  const ctx = {
    store,
    engine: {
      defaultWorkspace: path.join(root, "workspace"),
      environment: { kind: "local" },
    },
    policy: () => ({ modes: ["chat", "cowork", "code"] }),
    push: (e: unknown) => events.push(e),
  } as unknown as AppContext;
  const calls = new Map<string, (...args: any[]) => any>();
  registerBlankArtifactHandlers((name, fn) => calls.set(name, fn), ctx);
  const create = (
    kind: (typeof artifactOutputKinds)[number] = "docs",
    requestId = randomUUID(),
  ) =>
    calls.get("createBlankArtifact")!({
      requestId,
      kind,
      name: `Untitled ${kind}`,
      providerId: "default",
      model: "model",
    }) as Promise<CreatedBlankArtifact>;
  const read = (result: CreatedBlankArtifact) =>
    calls.get("readBlankArtifact")!({
      conversationId: result.conversation.id,
      artifactId: result.document.artifact.id,
    });
  const save = (
    result: CreatedBlankArtifact,
    content: string,
    expectedRevision = result.document.revision,
  ) =>
    calls.get("saveBlankArtifact")!({
      conversationId: result.conversation.id,
      artifactId: result.document.artifact.id,
      content,
      expectedRevision,
    });
  return { root, store, ctx, calls, events, create, read, save };
}
test("four templates create real private files and persisted idle Chats without a send or synthetic turn", async (t) => {
  const s = setup(t);
  for (const kind of artifactOutputKinds) {
    const value = await s.create(kind);
    assert.equal(value.conversation.mode, "chat");
    assert.equal(value.conversation.threadId, undefined);
    assert.deepEqual(value.conversation.turns, []);
    const file = resolveBlankArtifactFile(
      s.ctx.engine.defaultWorkspace,
      value.conversation,
    );
    assert.equal(path.basename(file.file), blankArtifactFiles[kind]);
    assert.equal(
      fs.readFileSync(file.file, "utf8"),
      blankArtifactInitialContent(kind),
    );
    assert.equal(value.document.content, blankArtifactInitialContent(kind));
    assert.equal(value.document.writable, true);
    assert.match(value.document.revision, /^[a-f0-9]{64}$/);
    assert.deepEqual(s.read(value), value.document);
  }
  const reopened = new Store(s.root);
  assert.equal(reopened.conversations.length, 4);
  assert.ok(
    reopened.conversations.every(
      (c) => c.blankArtifact && c.turns.length === 0,
    ),
  );
  assert.equal(s.events.length, 4);
  for (const method of [
    "createBlankArtifact",
    "readBlankArtifact",
    "saveBlankArtifact",
  ])
    assert.equal(webMethodKind(method), "remote-runner");
});
test("actual file save uses revision CAS, detects the agent's edit and never overwrites a stale revision", async (t) => {
  const s = setup(t),
    value = await s.create();
  const saved = await s.save(value, "<h1>User edit</h1>");
  assert.equal(saved.status, "saved");
  assert.notEqual(saved.document.revision, value.document.revision);
  assert.equal(s.read(value).content, "<h1>User edit</h1>");
  const file = resolveBlankArtifactFile(
    s.ctx.engine.defaultWorkspace,
    value.conversation,
  ).file;
  fs.writeFileSync(file, "<h1>Agent edit</h1>");
  assert.equal(
    (await s.save(value, "stale", saved.document.revision)).status,
    "conflict",
  );
  assert.equal(fs.readFileSync(file, "utf8"), "<h1>Agent edit</h1>");
  const current = s.read(value);
  assert.equal(
    (await s.save(value, "Both edits", current.revision)).status,
    "saved",
  );
  const c = s.store.conversation(value.conversation.id);
  c.turns.push({ status: "inProgress" } as never);
  assert.deepEqual(await s.save(value, "interrupt"), {
    status: "denied",
    reason: "generating",
  });
});
test("same request single-flights until the real store acknowledgement, and failure cannot return a rolled-back pair", async (t) => {
  const gate = deferred();
  let fail = true;
  const s = setup(t, (root) => {
    const store = new Store(root) as Store & { settled(): Promise<void> };
    store.settled = () =>
      gate.promise.then(() => {
        if (fail) throw new Error("write failed");
      });
    return store;
  });
  const id = randomUUID(),
    first = s.create("docs", id),
    second = s.create("docs", id);
  let settled = false;
  void second.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(s.store.conversations.length, 1);
  gate.resolve();
  const result = await Promise.allSettled([first, second]);
  assert.ok(result.every((r) => r.status === "rejected"));
  assert.equal(s.store.conversations.length, 0);
  assert.deepEqual(
    fs.readdirSync(
      path.join(s.ctx.engine.defaultWorkspace, ".claudex-artifacts"),
    ),
    [],
  );
  fail = false;
  const retried = await s.create("docs", id);
  assert.equal(retried.conversation.id, id);
  assert.deepEqual(retried.conversation.turns, []);
  const again = await s.create("docs", id);
  assert.equal(again.document.artifact.id, retried.document.artifact.id);
  assert.equal(s.store.conversations.length, 1);
});
test("a real CloudStore successful retry clears prior failed writes and scopes files to that runner workspace", async (t) => {
  let fail = true;
  const writes: { op: string; userId: number }[] = [];
  const s = setup(
    t,
    (root) =>
      new CloudStore({
        root,
        userId: 91,
        log: () => {},
        transport: {
          request: async (op, userId) => {
            writes.push({ op, userId });
            if (fail) throw new Error("offline");
            return {};
          },
        },
      }),
  );
  await assert.rejects(s.create(), /save/);
  assert.equal(s.store.conversations.length, 0);
  assert.ok((s.store as CloudStore).failedWrites > 0);
  fail = false;
  const value = await s.create();
  assert.equal((s.store as CloudStore).failedWrites, 0);
  assert.ok(writes.every((w) => w.userId === 91));
  assert.equal(value.conversation.environment?.kind, "local");
  assert.equal(fs.existsSync(path.join(s.root, "conversations.json")), false);
  assert.equal(s.read(value).content, blankArtifactInitialContent("docs"));
  await (s.store as CloudStore).close();
});
test("account or engine replacement rejects late creation and never touches the new account", async (t) => {
  const gate = deferred();
  const s = setup(t, (root) => {
    const store = new Store(root) as Store & { settled(): Promise<void> };
    store.settled = () => gate.promise;
    return store;
  });
  const result = s.create();
  const other = new Store(path.join(s.root, "account-b"));
  Object.assign(s.ctx, {
    store: other,
    engine: { defaultWorkspace: path.join(other.root, "workspace") },
  });
  gate.resolve();
  await assert.rejects(result, /account/);
  assert.deepEqual(other.conversations, []);
  assert.equal(fs.existsSync(path.join(other.root, "workspace")), false);
});
test("rollback preserves real edits and no input can authorize another account, absolute path, symlink or hardlink", async (t) => {
  const s = setup(t);
  const value = await s.create();
  const id = value.conversation.id,
    artifactId = value.document.artifact.id,
    file = resolveBlankArtifactFile(
      s.ctx.engine.defaultWorkspace,
      value.conversation,
    ).file;
  assert.throws(() =>
    s.calls.get("readBlankArtifact")!({
      conversationId: id,
      artifactId,
      file: "/etc/passwd",
    }),
  );
  assert.throws(() =>
    s.calls.get("readBlankArtifact")!({
      conversationId: "../escape",
      artifactId,
    }),
  );
  assert.throws(
    () =>
      s.calls.get("readBlankArtifact")!({
        conversationId: id,
        artifactId: randomUUID(),
      }),
    /account/,
  );
  fs.unlinkSync(file);
  const outside = path.join(s.root, "outside");
  fs.writeFileSync(outside, "private");
  fs.symlinkSync(outside, file);
  assert.throws(() => s.read(value), /account/);
  fs.unlinkSync(file);
  fs.linkSync(outside, file);
  assert.throws(() => s.read(value), /account/);
  assert.equal(fs.readFileSync(outside, "utf8"), "private");
  const other = setup(t);
  assert.throws(() =>
    other.calls.get("readBlankArtifact")!({ conversationId: id, artifactId }),
  );
  const next = randomUUID(),
    directory = blankArtifactDirectory(
      s.ctx.engine.defaultWorkspace,
      next,
      true,
    );
  fs.symlinkSync(outside, path.join(directory, blankArtifactFiles.docs));
  await assert.rejects(s.create("docs", next));
  assert.equal(fs.readFileSync(outside, "utf8"), "private");
});
test("opening context points both editor and engine to the canonical same file, preserving visible prompt semantics", async (t) => {
  const s = setup(t),
    value = await s.create("design"),
    resolved = resolveBlankArtifactFile(
      s.ctx.engine.defaultWorkspace,
      value.conversation,
    );
  const context = blankArtifactOpeningContext(
    value.document.artifact,
    resolved.file,
  );
  assert.ok(context.includes(JSON.stringify(resolved.file)));
  assert.match(context, /read that current file first/);
  assert.match(context, /user data/);
  const source = fs.readFileSync(
    "electron/engine/engine-turn-setup.ts",
    "utf8",
  );
  assert.match(
    source,
    /blankArtifactOpeningContext\(\s*c.blankArtifact,\s*resolveBlankArtifactFile\(this.defaultWorkspace, c\).file/,
  );
  assert.equal(value.conversation.turns.length, 0);
});
test("desktop router creates on the actual cloud runner and routes subsequent file calls by the new conversation", async () => {
  const conversation = { id: randomUUID(), turns: [] } as never;
  const calls: string[] = [];
  const client = {
    call: async (method: string) => {
      calls.push(method);
      return method === "createBlankArtifact" ? { conversation } : "real";
    },
    snapshot: async () => {
      throw new Error("unused");
    },
  };
  const router = new CloudRouter({
    client: () => client,
    push: () => {},
    attachmentBytes: async () => undefined,
  });
  let local = 0;
  await router.route("createBlankArtifact", () => {
    local++;
  })({});
  assert.equal(local, 0);
  assert.equal(
    await router.route("readBlankArtifact", () => {
      local++;
    })({ conversationId: (conversation as { id: string }).id }),
    "real",
  );
  assert.equal(local, 0);
  assert.deepEqual(calls, ["createBlankArtifact", "readBlankArtifact"]);
  const gate = deferred();
  const old = {
    ...client,
    call: async () => {
      await gate.promise;
      return { conversation };
    },
  };
  let active = old as typeof client;
  const other = new CloudRouter({
    client: () => active,
    push: () => {},
    attachmentBytes: async () => undefined,
  });
  const pending = other.route("createBlankArtifact", () => {})({});
  other.reset();
  active = client;
  gate.resolve();
  await assert.rejects(pending, /account changed/);
  assert.equal(
    other.isCloudConversation((conversation as { id: string }).id),
    false,
  );
});

test("the real Engine's first Chat send uses that same editable file while the visible user prompt stays unchanged", async (t) => {
  const { Engine } = await import("../../electron/engine/engine");
  const { openPolicy } = await import("../../shared/client-policy");
  for (const remote of [false, true]) {
    const s = setup(
      t,
      remote
        ? (root) =>
            new CloudStore({
              root,
              userId: 101,
              log: () => {},
              transport: { request: async () => ({}) },
            })
        : undefined,
    );
    const calls: { method: string; params: any }[] = [];
    const engine = new Engine(
      s.store,
      "unused",
      () => "",
      () => {},
    );
    engine.policy = () => openPolicy;
    engine.ensure = async () => {};
    engine.rpc = {
      call: async (method: string, params: any) => {
        calls.push({ method, params });
        if (method === "thread/start")
          return { thread: { id: "paired-thread" } };
        if (method === "turn/start") return { turn: { id: "paired-turn" } };
        return {};
      },
    } as never;
    Object.assign(s.ctx, { engine });
    const pair = await s.create("docs");
    const file = resolveBlankArtifactFile(
      engine.defaultWorkspace,
      pair.conversation,
    ).file;
    fs.writeFileSync(file, "<h1>Current user edit</h1>");
    const prompt = "Add a short conclusion to this document.";
    const result = await engine.send({
      conversationId: pair.conversation.id,
      text: prompt,
      mode: "chat",
      providerId: "default",
      model: "model",
      attachments: [],
    });
    assert.equal(result.id, pair.conversation.id);
    assert.equal(result.turns[0].prompt, prompt);
    const start = calls.find((c) => c.method === "thread/start")!;
    assert.ok(
      start.params.developerInstructions.includes(JSON.stringify(file)),
    );
    assert.match(
      start.params.developerInstructions,
      /read that current file first/,
    );
    assert.equal(start.params.cwd, path.dirname(file));
    assert.equal(start.params.sandbox, "workspace-write");
    const turn = calls.find((c) => c.method === "turn/start")!;
    assert.equal(turn.params.sandboxPolicy.type, "workspaceWrite");
    assert.ok(
      turn.params.sandboxPolicy.writableRoots.some((root: string) =>
        file.startsWith(path.resolve(root) + path.sep),
      ),
      "paired file is in the real turn writable policy",
    );
    assert.equal(turn.params.approvalsReviewer, "user");
    assert.equal(fs.readFileSync(file, "utf8"), "<h1>Current user edit</h1>");
    assert.equal(calls.filter((c) => c.method === "thread/start").length, 1);
    s.store.flush();
    if (remote) await (s.store as CloudStore).close();
  }
});

test("new paired runner IDs keep their owning file route when an older snapshot settles after creation", async () => {
  const { fixtureSnapshot } =
    await import("../../scripts/preview/app-fixture");
  const snapshot = fixtureSnapshot({ history: "empty" }),
    gate = deferred(),
    id = randomUUID();
  const calls: string[] = [];
  const client = {
    snapshot: async () => {
      await gate.promise;
      return { snapshot };
    },
    call: async (method: string) => {
      calls.push(method);
      return method === "createBlankArtifact"
        ? { conversation: { id, turns: [] } }
        : "owned file";
    },
  };
  const router = new CloudRouter({
    client: () => client,
    push: () => {},
    attachmentBytes: async () => undefined,
  });
  const pending = router.route("snapshot", () => snapshot)();
  await router.route("createBlankArtifact", () =>
    assert.fail("not desktop-local"),
  )({});
  gate.resolve();
  await pending;
  assert.equal(
    await router.route("readBlankArtifact", () =>
      assert.fail("must retain owning runner"),
    )({ conversationId: id }),
    "owned file",
  );
  await router.route("deleteConversation", () =>
    assert.fail("real remote delete"),
  )(id);
  assert.equal(router.isCloudConversation(id), false);
});
test("the real web runner guard accepts ID/content protocols and rejects browser path authorization", async () => {
  const { guardCall, webArguments } =
    await import("../../runner/src/method-guard");
  const id = randomUUID(),
    artifactId = randomUUID();
  for (const method of [
    "createBlankArtifact",
    "readBlankArtifact",
    "saveBlankArtifact",
  ]) {
    const input =
      method === "createBlankArtifact"
        ? {
            requestId: id,
            kind: "docs",
            name: "Untitled",
            providerId: "default",
            model: "model",
          }
        : {
            conversationId: id,
            artifactId,
            ...(method === "saveBlankArtifact"
              ? {
                  content: "<p>Real user edit</p>",
                  expectedRevision: "a".repeat(64),
                }
              : {}),
          };
    assert.doesNotThrow(() => guardCall(method, [input]));
    assert.throws(
      () => guardCall(method, [{ ...input, path: "/outside" }]),
      /Folders on the server/,
    );
  }
  assert.deepEqual(
    webArguments(
      "send",
      [{ conversationId: id, cwd: "/own/runner/file", text: "Continue" }],
      (lookup) => (lookup === id ? "/own/runner/file" : undefined),
    ),
    [{ conversationId: id, text: "Continue" }],
  );
});
test("preview fixture uses the same paired idle/read/CAS contract rather than a rendered pretend editor", async () => {
  const { createFixtureDesktop } =
    await import("../../scripts/preview/app-fixture");
  const api = createFixtureDesktop(
    { history: "empty" },
    new URLSearchParams("fonts=system"),
  );
  const requestId = randomUUID();
  const pair = await api.createBlankArtifact({
    requestId,
    kind: "docs",
    name: "Untitled document",
    providerId: "fixture",
    model: "Opus 5.5",
  });
  assert.equal(pair.conversation.turns.length, 0);
  assert.equal((await api.snapshot()).conversations[0].id, requestId);
  const saved = await api.saveBlankArtifact({
    conversationId: requestId,
    artifactId: pair.document.artifact.id,
    content: "<p>Fixture real edit</p>",
    expectedRevision: pair.document.revision,
  });
  assert.equal(saved.status, "saved");
  assert.equal(
    (
      await api.readBlankArtifact({
        conversationId: requestId,
        artifactId: pair.document.artifact.id,
      })
    ).content,
    "<p>Fixture real edit</p>",
  );
  const stale = await api.saveBlankArtifact({
    conversationId: requestId,
    artifactId: pair.document.artifact.id,
    content: "stale",
    expectedRevision: pair.document.revision,
  });
  assert.equal(stale.status, "conflict");
  assert.equal(
    (
      await api.createBlankArtifact({
        requestId,
        kind: "docs",
        name: "Untitled document",
        providerId: "fixture",
        model: "Opus 5.5",
      })
    ).document.artifact.id,
    pair.document.artifact.id,
  );
});

test("a pinned blank revision rejects another window's edit both before setup and after thread setup, before a model turn", async (t) => {
  const { Engine } = await import("../../electron/engine/engine"),
    { openPolicy } = await import("../../shared/client-policy");
  for (const change of ["before", "during"] as const) {
    const s = setup(t),
      calls: string[] = [];
    const engine = new Engine(
      s.store,
      "unused",
      () => "",
      () => {},
    );
    engine.policy = () => openPolicy;
    engine.ensure = async () => {};
    Object.assign(s.ctx, { engine });
    const pair = await s.create(),
      file = resolveBlankArtifactFile(
        engine.defaultWorkspace,
        pair.conversation,
      ).file;
    engine.rpc = {
      call: async (method: string) => {
        calls.push(method);
        if (method === "thread/start") {
          if (change === "during")
            fs.writeFileSync(file, "<p>Other window latest</p>");
          return { thread: { id: "revision-thread" } };
        }
        if (method === "turn/start") return { turn: { id: "must-not-start" } };
        return {};
      },
    } as never;
    if (change === "before")
      fs.writeFileSync(file, "<p>Other window latest</p>");
    await assert.rejects(
      engine.send({
        conversationId: pair.conversation.id,
        text: "Preserve my request",
        mode: "chat",
        providerId: "default",
        model: "model",
        attachments: [],
        blankArtifactRevision: {
          artifactId: pair.document.artifact.id,
          revision: pair.document.revision,
        },
      }),
      /saved artifact changed/,
    );
    assert.equal(calls.includes("turn/start"), false);
    assert.equal(fs.readFileSync(file, "utf8"), "<p>Other window latest</p>");
    if (change === "before")
      assert.equal(s.store.conversations[0].turns.length, 0);
    s.store.flush();
  }
});
