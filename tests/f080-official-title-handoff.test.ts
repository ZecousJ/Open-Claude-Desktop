/** Pinned original UI functions against the real isolated local Code adapter.
 * This is callback/store integration, not packaged Electron visual acceptance. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import ts from "typescript";
import { Store } from "../electron/store/store";
import {
  newConversation,
  type SendInput,
} from "../electron/engine/new-conversation";
import { registerConversationManageHandlers } from "../electron/ipc/conversation-manage-handlers";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import type { Conversation } from "../shared/types";

const root = process.env.CLAUDEX_OFFICIAL_UI_SOURCE
  ? path.join(process.env.CLAUDEX_OFFICIAL_UI_SOURCE, "src/cloud/assets/v1")
  : path.resolve(
      ".restore/archive-extracted/claude-frontend-4.4212.0/dist/assets/v1",
    );
const read = (file: string, digest: string) => {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    digest,
    "Pinned original UI source drifted",
  );
  return source;
};
const transportSource = read(
  "cef1e6037-DIC2zPYg.js",
  "892b640c3293b908fcade9ee420fe1ccf879c826e1ed720458d54ec021371408",
);
const renameSource = read(
  "c4ae8f050-Df0EcvqE.js",
  "ac74482324867edb4cbbcea044d13f1df0266d66964eb6806b30efda83821d8f",
);
function functions(source: string, names: string[]) {
  const ast = ts.createSourceFile(
    "original.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  return names
    .map((name) => {
      const fn = ast.statements.find(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
      );
      assert.ok(fn, `Missing original function ${name}`);
      return fn.getText(ast);
    })
    .join("\n");
}
const originalPlaceholder = vm.runInNewContext(
  functions(transportSource, ["fr"]) + ";fr;",
);
const rawId = "2f3a06f5-a30a-46a0-a914-5021272f6c23",
  id = `local_${rawId}`;
const prompt =
  "Review the current implementation and then improve title persistence without losing history";
const input = (text: string): SendInput => ({
  text,
  mode: "code",
  attachments: [],
  providerId: "inert",
  model: "inert",
  newConversationId: rawId,
});
const provider = { id: "inert", model: "inert", models: [] } as any;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fixture(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f080-original-ui-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.settings.providers = [provider];
  store.settings.activeProviderId = provider.id;
  const handlers = new Map<string, (...args: any[]) => any>(),
    native = new Map<string, (...args: any[]) => any>();
  let listener: (event: any) => void = () => {};
  const rows: any[] = [],
    updates: any[] = [],
    pending: Promise<unknown>[] = [];
  const manual = new Map<string, string>(),
    meta = new Map<string, any>(),
    warnings: string[] = [];
  const updateRow = (key: string, patch: any) => {
    let row = rows.find((row) => row.sessionId === key);
    if (!row) rows.push((row = { sessionId: key }));
    Object.assign(row, structuredClone(patch));
  };
  registerConversationManageHandlers({
    context: {
      store,
      engine: {},
      accountGeneration: () => 1,
      push: (event: any) => listener(event),
    },
    engineOf: () => undefined,
    handle: (name: string, fn: any) => handlers.set(name, fn),
  } as any);
  const update = (key: string, patch: any) => {
    updates.push([key, structuredClone(patch)]);
    const p = native.get("LocalSessions.updateSession")!(key, patch);
    pending.push(p);
    return p;
  };
  registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: "synthetic-owner" }),
      settings: () => store.settings,
      stateDirectory: () => dir,
      sessionIdentity: () => 1,
      localLoadConversation: async (key: string) =>
        structuredClone(store.conversations.find((c) => c.id === key)),
      localListConversations: async () => structuredClone(store.conversations),
      localCall: async (name: string, ...args: any[]) => {
        if (name === "snapshot") return { approvals: [] };
        if (name === "send") {
          const c = newConversation(
            args[0],
            provider,
            process.cwd(),
            store.settings,
          );
          c.turns.push({
            id: "turn-one",
            prompt: args[0].text,
            status: "completed",
            items: [],
            attachments: [],
            createdAt: 1,
          });
          store.conversations.push(c);
          store.flush();
          return structuredClone(c);
        }
        const fn = handlers.get(name);
        assert.ok(fn, `Unexpected native call ${name}`);
        return fn(...args);
      },
      onEvent: (fn: any) => {
        listener = fn;
        return () => {};
      },
      log() {},
    },
    on: (name: string, fn: any) => native.set(name, fn),
    emit: (_ns: string, _name: string, event: any) => {
      if (event.session) updateRow(event.sessionId, event.session);
    },
  } as any);
  const globals: any = {
    a: {
      start: (info: any) => native.get("LocalSessions.start")!(info),
      updateSession: update,
    },
    h() {},
    C: (key: string) => manual.has(key),
    De: async (value: any) => value,
    Ze: () => false,
    e: (value: any) => value,
    rt: "discarded",
    Oe: () => ({}),
    ct: () => ({}),
    ve() {},
    S() {},
    ee: (key: string) => manual.get(key),
    Je: updateRow,
    Ge: { getState: () => ({ sessions: rows }) },
    te() {},
  };
  vm.runInNewContext(
    functions(transportSource, ["fr", "fi"]) + ";this.launch = fi;",
    globals,
  );
  const renameAt = transportSource.indexOf("    async rename(e, t) {"),
    renameEnd = transportSource.indexOf("    async archive", renameAt);
  assert.ok(renameAt > 0 && renameEnd > renameAt);
  const transport = vm.runInNewContext(
    "({" + transportSource.slice(renameAt, renameEnd) + "})",
    { a: globals.a },
  );
  const query = {
    getQueryData: (key: string) => meta.get(key),
    setQueryData: (key: string, fn: any) =>
      meta.set(key, typeof fn === "function" ? fn(meta.get(key)) : fn),
    cancelQueries: async () => {},
    invalidateQueries: async () => {},
  };
  const renameGlobals: any = {
    J9: () => [],
    h: () => query,
    D: () => () => transport,
    d: () => ({}),
    o: () => ({ mutate() {} }),
    p: () => ({ addWarning: (text: string) => warnings.push(text) }),
    _: () => ({ formatMessage: (message: any) => message.defaultMessage }),
    C: globals.Ge,
    w: updateRow,
    s: { meta: (ref: any) => ref.id },
    l: (key: string, value: string) => manual.set(key, value),
    r() {},
    i: (value: any) => value,
    y: () => undefined,
    T: () => "local",
    g: (options: any) => options,
    c() {},
    f() {},
    E() {},
    n: {},
    e: (value: any) => value,
    m: "sessions",
    O: { previous_title_source: null, seconds_since_create: null },
  };
  for (const arity of [2, 3, 4, 5]) {
    renameGlobals[`J${arity}`] = () => true;
    renameGlobals[`K${arity}`] = (...args: any[]) => args.at(-1);
  }
  vm.runInNewContext(
    functions(renameSource, ["k", "A", "j", "M", "N", "P"]) +
      ";this.renameOptions = M();",
    renameGlobals,
  );
  return {
    store,
    dir,
    rows,
    updates,
    warnings,
    launch: (title: Promise<string | undefined>, text = prompt) =>
      globals.launch(
        { sessionId: id, cwd: process.cwd(), message: text, attachments: [] },
        () => title,
      ),
    rename: async (title: string) => {
      const options = renameGlobals.renameOptions,
        args = { ref: { type: "local", id }, title, via: "menu" };
      meta.set(id, { title: rows[0]?.title });
      const previous = await options.onMutate(args);
      try {
        const value = await options.mutationFn(args);
        options.onSuccess(value, args, previous);
      } catch (error) {
        options.onError(error, args, previous);
        throw error;
      }
    },
    flush: async () => {
      await tick();
      await Promise.allSettled(pending);
      await tick();
    },
    native,
  };
}

for (const text of [
  prompt,
  "  one\n two\tthree four five six seven  ",
  "中文".repeat(40),
  "😀".repeat(80),
  "A".repeat(60),
  "A".repeat(61),
])
  test(`Code placeholder agrees with pinned original fr(): ${text.slice(0, 14)}`, () => {
    assert.equal(
      newConversation(input(text), provider, "/inert").title,
      originalPlaceholder(text),
    );
  });

test("Chat, Cowork, attachment fallback and handed-off titles retain their existing behavior", () => {
  for (const mode of ["chat", "cowork"] as const)
    assert.equal(
      newConversation({ ...input(prompt), mode }, provider, "/inert").title,
      prompt.slice(0, 50),
    );
  assert.equal(
    newConversation(
      { ...input(""), attachments: [{ name: "Attachment only" }] as any },
      provider,
      "/inert",
    ).title,
    "Attachment only",
  );
  assert.equal(
    newConversation(
      { ...input(prompt), handedOffFrom: { title: "Manual handoff" } as any },
      provider,
      "/inert",
    ).title,
    "Manual handoff",
  );
});

test("original fi() persists a late generated title and keeps the same ID/body after reopening", async (t) => {
  const f = fixture(t),
    generated = deferred<string>();
  assert.equal(await f.launch(generated.promise), id);
  const before = structuredClone(f.store.conversation(rawId));
  generated.resolve("Repair title persistence");
  await f.flush();
  assert.equal(f.updates.length, 1);
  const reopened = new Store(f.dir).conversation(rawId);
  assert.equal(reopened.title, "Repair title persistence");
  assert.equal(reopened.titleSetByUser, false);
  assert.equal(reopened.id, before.id);
  assert.deepEqual(reopened.turns, before.turns);
  assert.equal(f.rows[0].title, reopened.title);
});

test("original fi() also persists a generated title that arrives before start returns", async (t) => {
  const f = fixture(t);
  await f.launch(Promise.resolve("Early generated title"));
  await f.flush();
  assert.equal(
    new Store(f.dir).conversation(rawId).title,
    "Early generated title",
  );
  assert.equal(f.rows[0].title, "Early generated title");
});

test("the original rename callback preserves a manual title against late first-title generation", async (t) => {
  const f = fixture(t),
    generated = deferred<string>();
  await f.launch(generated.promise);
  await f.rename("Chosen title");
  generated.resolve("Late automatic result");
  await f.flush();
  assert.equal(new Store(f.dir).conversation(rawId).title, "Chosen title");
  assert.equal(f.rows[0].titleSource, "user");
  assert.deepEqual(f.warnings, []);
});

test("the original title guard still protects a newer automatic title", async (t) => {
  const f = fixture(t),
    generated = deferred<string>();
  await f.launch(generated.promise);
  await f.native.get("LocalSessions.updateSession")!(id, {
    title: "Newer topic title",
    titleSource: "auto",
  });
  await f.flush();
  generated.resolve("Stale initial result");
  await f.flush();
  assert.equal(new Store(f.dir).conversation(rawId).title, "Newer topic title");
  assert.equal(f.rows[0].title, "Newer topic title");
});

test("the original rename error callback warns and restores the previous title/source after a failed save", async (t) => {
  const f = fixture(t);
  await f.launch(Promise.resolve("Initial generated title"));
  await f.flush();
  const before = structuredClone(f.store.conversation(rawId));
  const write = (f.store as any).write;
  (f.store as any).write = () => {
    throw Error("inert disk failure");
  };
  await assert.rejects(f.rename("Unsaved manual title"), /inert disk failure/);
  (f.store as any).write = write;
  assert.deepEqual(f.store.conversation(rawId), before);
  assert.equal(f.rows[0].title, before.title);
  assert.equal(f.rows[0].titleSource, "auto");
  assert.deepEqual(f.warnings, ["Rename failed. You can try again."]);
});
