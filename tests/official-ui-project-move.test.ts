/** F029: real REST route + native handler + temporary Store, no model/network/UI. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { Readable } from "node:stream";
import { Store } from "../electron/store/store";
import {
  conversationsRoute,
  conversationRow,
  conversationAliases,
} from "../electron/official-ui/api/conversations";
import { projectsRoute } from "../electron/official-ui/api/projects";
import { cloudCodeHistoryRoute, cloudCodeSessionKey } from "../electron/official-ui/api/cloud-code-history";
import { organizationUuid } from "../electron/official-ui/api/context";
import { guardAdapterContext } from "../electron/official-ui/api/scoped-context";
import {
  newAdapterScope,
  inAdapterScope,
} from "../electron/official-ui/api/scope";
import { useElectronShim } from "./runner/runner-core-support.test";
useElectronShim();
const { registerConversationManageHandlers } =
  await import("../electron/ipc/conversation-manage-handlers");
function fixture(t: any, remoteCowork = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f029-move-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  let owner = "a",
    identity: unknown = {},
    state = root,
    current = true;
  store.projects = [
    {
      id: "project",
      kind: "chat",
      name: "Project",
      instructions: "Keep project instructions",
      createdAt: 1,
    } as any,
  ];
  store.conversations = ["a", "b", "cowork", "code"].map(
    (id) =>
      ({
        id,
        mode: id === "cowork" ? "cowork" : id === "code" ? "code" : "chat",
        title: id,
        ...(id === "cowork" ? { createdAt: 2, updatedAt: 2, environment: { kind: "space", spaceId: "workspace" } } : {}),
        turns: [],
        providerId: "inert",
        model: "inert",
      }) as any,
  );
  store.flush();
  const handlers = new Map<string, Function>(),
    calls: string[] = [];
  registerConversationManageHandlers({
    context: {
      store,
      engine: {},
      accountGeneration: () => identity,
      push() {},
    },
    engineOf: () => undefined,
    handle: (n: string, f: Function) => handlers.set(n, f),
  } as any);
  let hook: undefined | ((at: string, id?: string) => void),
    override: undefined | ((id: string, result: any) => any);
  const aliases = new Map<string, string>();
  const original: any = {
    root,
    stateDirectory: () => state,
    account: () => ({ id: owner }),
    sessionIdentity: () => identity,
    isCurrent: () => current,
    officialCoworkHistory: remoteCowork,
    allowConversationProjectMove: remoteCowork,
    strictActionSemantics: true,
    snapshot: async () => {
      hook?.("snapshot");
      return { projects: structuredClone(store.projects), conversations: store.conversations };
    },
    listConversations: async () => store.conversations,
    loadConversation: async (id: string) => {
      hook?.("load", id);
      return store.conversations.find((c) => c.id === id);
    },
    call: async (n: string, id: string, patch: any, guard?: any) => {
      calls.push(id);
      const result = await handlers.get(n)!(id, patch, guard);
      hook?.("call", id);
      return override ? override(id, result) : result;
    },
  };
  return {
    store,
    calls,
    original,
    aliases,
    setHook(fn: typeof hook) {
      hook = fn;
    },
    setResult(fn: typeof override) {
      override = fn;
    },
    retire() {
      identity = {};
    },
    switch() {
      owner = "b";
      identity = {};
    },
    changeRoot() {
      state = root + "-changed";
    },
    async run(
      body: any = { conversation_uuids: ["a"], project_uuid: "project" },
      options: any = {},
    ) {
      let status = 0,
        data: any;
      const scope = newAdapterScope(owner, root, identity);
      const ctx = options.scoped ? guardAdapterContext(original) : original;
      const req: any = Readable.from(
        (function* () {
          yield Buffer.from(JSON.stringify(body));
          hook?.("body");
        })(),
      );
      req.method = options.session ? "PATCH" : "POST";
      const org = organizationUuid(options.owner ?? owner);
      const p = options.session
        ? `/api/organizations/${org}/cowork/sessions/${options.session}/project`
        : `/api/organizations/${org}/chat_conversations/move_many`;
      const res: any = {
        writeHead(n: number) {
          status = n;
        },
        end(v: any) {
          data = v === undefined ? undefined : JSON.parse(String(v));
        },
      };
      await inAdapterScope(scope, () => {
        for (const [page, real] of aliases)
          conversationAliases.restore(page, real);
        return conversationsRoute(
          req,
          res,
          p,
          new URL(p, "http://fixture.invalid"),
          ctx,
        );
      });
      return { status, data };
    },
    session(id = "cowork") {
      return "cse_" + cloudCodeSessionKey(store.conversation(id), owner);
    },
    async coworkHistory(path: string) {
      const url = new URL(path, "http://fixture.invalid");
      let data: any;
      assert.equal(await cloudCodeHistoryRoute(
        { method: "GET", headers: {} } as any,
        {
          writeHead(status: number) { assert.equal(status, 200); },
          end(body: string) { data = JSON.parse(body); },
        } as any,
        url.pathname,
        url,
        original,
      ), true);
      return data;
    },
    async list() {
      let data: any;
      const p = `/api/organizations/${organizationUuid(owner)}/projects/project/conversations_v2`;
      await projectsRoute(
        { method: "GET" } as any,
        {
          writeHead() {},
          end(v: any) {
            data = JSON.parse(String(v));
          },
        } as any,
        p,
        new URL(p, "http://fixture.invalid"),
        original,
      );
      return data.data;
    },
    reopen: () => new Store(root),
  };
}
const archive =
  ".restore/archive-extracted/claude-frontend-4.4212.0/dist/assets/v1/";
function successConsumer(events: string[]) {
  const f = archive + "shared-m-1-Nm0kn4Ee.js",
    s = fs.readFileSync(f, "utf8"),
    ast = ts.createSourceFile(
      f,
      s,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
  let node: any;
  function visit(n: any) {
    if (
      ts.isPropertyAssignment(n) &&
      n.name.getText(ast) === "onSuccess" &&
      n.initializer.getText(ast).includes('action: "move_many"')
    )
      node = n.initializer;
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert.ok(node);
  return vm.runInNewContext("(" + node.getText(ast) + ")", {
    i() {
      events.push("invalidate");
    },
    r: {
      setQueriesData() {},
      getQueriesData() {
        return [];
      },
      invalidateQueries: async () => {},
    },
    a: {},
    s: () => ({}),
    pS() {},
    RV() {},
    LH: () => false,
    Sq: async () => {},
    At() {},
    uu: "projects",
    n: "org",
    e: (v: any) =>
      events.push("complete:" + v.moved.length + "/" + v.failed.length),
  });
}
test("strict scoped route moves Chat and Cowork, original success consumer accepts exact arrays, lists and reopen agree", async (t) => {
  const f = fixture(t);
  const r = await f.run(
    { conversation_uuids: ["a", "cowork"], project_uuid: "project" },
    { scoped: true },
  );
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { moved: ["a", "cowork"], failed: [] });
  const events: string[] = [];
  await successConsumer(events)(
    r.data,
    { project_uuid: "project" },
    { treesToRefetch: [] },
    {},
  );
  assert.deepEqual(events, ["invalidate", "complete:2/0"]);
  assert.deepEqual((await f.list()).map((c: any) => c.uuid).sort(), [
    "a",
    "cowork",
  ]);
  assert.equal(f.reopen().conversation("cowork").projectId, "project");
  assert.equal(
    conversationRow(f.store.conversation("a")).project_uuid,
    "project",
  );
});
test("mixed missing/Code rows preserve per-item success and original partial consumer without retry", async (t) => {
  const f = fixture(t);
  const r = await f.run({
    conversation_uuids: ["a", "missing", "code", "b"],
    project_uuid: "project",
  });
  assert.deepEqual(r.data, { moved: ["a", "b"], failed: ["missing", "code"] });
  assert.deepEqual(f.calls, ["a", "b"]);
  const events: string[] = [];
  await successConsumer(events)(
    r.data,
    { project_uuid: "project" },
    { treesToRefetch: [], listProjects: new Map(), treeProjects: new Map() },
    {},
  );
  assert.ok(events.includes("complete:2/2"));
});
test("original remove null clears project and list; no new model/context mutation", async (t) => {
  const f = fixture(t);
  await f.run();
  const r = await f.run({ conversation_uuids: ["a"], project_uuid: null });
  assert.deepEqual(r.data, { moved: ["a"], failed: [] });
  assert.equal(f.reopen().conversation("a").projectId, undefined);
  assert.deepEqual(await f.list(), []);
  assert.equal(f.store.projects[0].instructions, "Keep project instructions");
  assert.deepEqual(f.store.conversation("a").turns, []);
});
test("owned destination, read-only and malformed payload reject before any mutation; legacy project kind remains valid", async (t) => {
  const f = fixture(t);
  for (const body of [
    { conversation_uuids: ["a"], project_uuid: "foreign" },
    { conversation_uuids: ["a"], project_uuid: "project", extra: true },
    { conversation_uuids: ["a", "a"], project_uuid: "project" },
    { conversation_uuids: ["a"], project_uuid: 7 },
  ])
    assert.notEqual((await f.run(body)).status, 200);
  assert.equal((await f.run(undefined, { owner: "foreign" })).status, 404);
  f.original.readOnly = true;
  assert.equal((await f.run()).status, 501);
  f.original.readOnly = false;
  assert.deepEqual(f.calls, []);
  delete f.store.projects[0].kind;
  assert.equal((await f.run()).status, 200);
});
test("account, same-owner activation and root changes at every await stop later writes", async (t) => {
  for (const point of ["body", "snapshot", "load", "call"])
    for (const change of ["switch", "retire", "changeRoot"] as const) {
      const f = fixture(t);
      f.setHook((at) => {
        if (at === point) {
          f.setHook(undefined);
          f[change]();
        }
      });
      const r = await f.run({
        conversation_uuids: ["a", "b"],
        project_uuid: "project",
      });
      assert.equal(r.status, 409, point + "/" + change);
      assert.deepEqual(f.calls, point === "call" ? ["a"] : []);
      assert.match(r.data.error.message, /Earlier moves may already/);
      assert.equal(f.store.conversation("b").projectId, undefined);
    }
});
test("throw after mutation and mismatched acknowledgment are failed, never repeated or claimed moved", async (t) => {
  const f = fixture(t);
  f.setResult((id, result) => {
    if (id === "a") throw Error("Synthetic uncertain completion");
    return { ...result, projectId: "wrong" };
  });
  const r = await f.run({
    conversation_uuids: ["a", "b"],
    project_uuid: "project",
  });
  assert.deepEqual(r.data, { moved: [], failed: ["a", "b"] });
  assert.deepEqual(f.calls, ["a", "b"]);
  assert.equal(f.reopen().conversation("a").projectId, "project");
});

test("original remove consumer consumes null response and clears its pending selection", async (t) => {
  const f = fixture(t);
  await f.run();
  const file = archive + "shared-m-2-DfdOu-fU.js",
    source = fs.readFileSync(file, "utf8"),
    ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
  const node = ast.statements.find(
    (n: any) => ts.isFunctionDeclaration(n) && n.name?.text === "Gn",
  );
  assert.ok(node);
  const gn = vm.runInNewContext("(" + node.getText(ast) + ")");
  let pending = new Set<string>(),
    success = 0;
  const result = await gn(
    ["a"],
    { showSuccess: true, showError: true },
    {
      moveManyConversations: async (body: any) => {
        assert.equal(body.project_uuid, null);
        return (await f.run(body)).data;
      },
      addSuccess: () => success++,
      addError: () => assert.fail("unexpected remove error"),
      intl: { formatMessage: (m: any) => m.defaultMessage },
      setRemovingConversations: (fn: any) => (pending = fn(pending)),
    },
  );
  assert.deepEqual(Array.from(result.moved), ["a"]);
  assert.deepEqual(Array.from(result.failed), []);
  assert.equal(success, 1);
  assert.equal(pending.size, 0);
});
test("page alias preserves original UUID, alias collisions and mid-load retarget do not double dispatch", async (t) => {
  const f = fixture(t);
  f.aliases.set("page", "a");
  let r = await f.run({
    conversation_uuids: ["page"],
    project_uuid: "project",
  });
  assert.deepEqual(r.data, { moved: ["page"], failed: [] });
  assert.deepEqual(f.calls, ["a"]);
  r = await f.run({ conversation_uuids: ["page", "a"], project_uuid: null });
  assert.equal(r.status, 400);
  assert.deepEqual(f.calls, ["a"]);
  f.setHook((at) => {
    if (at === "load") conversationAliases.restore("page", "b");
  });
  r = await f.run({ conversation_uuids: ["page"], project_uuid: null });
  assert.equal(r.status, 409);
  assert.deepEqual(f.calls, ["a"]);
});
test("a local write failure preserves membership and reports one failed item", async (t) => {
  const f = fixture(t);
  const write = f.store.write.bind(f.store);
  f.store.write = (name, value) => {
    if (name === "conversations.json") {
      f.store.write = write;
      throw Error("Synthetic disk write failure");
    }
    write(name, value);
  };
  const r = await f.run({ conversation_uuids: ["a"], project_uuid: "project" });
  assert.deepEqual(r.data, { moved: [], failed: ["a"] });
  assert.deepEqual(f.calls, ["a"]);
  assert.equal(f.store.conversation("a").projectId, undefined);
  assert.equal(f.reopen().conversation("a").projectId, undefined);
});

test("remote Cowork moves and removes the same session through the original history URLs", async (t) => {
  const f = fixture(t, true);
  const session = f.session();
  const move = (project_uuid: string | null) => f.run({ project_uuid }, { session });
  const detail = () => f.coworkHistory("/v1/code/sessions/" + session);
  const list = () => f.coworkHistory("/v1/code/sessions?tags=cowork-remote");
  const membership = { uuid: "project", name: "Project" };
  assert.equal((await detail()).session.project, undefined);
  assert.equal((await move("project")).status, 204);
  assert.equal(f.reopen().conversation("cowork").projectId, "project");
  assert.deepEqual((await detail()).session.project, membership);
  assert.deepEqual((await list()).data[0].project, membership);
  assert.equal((await move(null)).status, 204);
  assert.equal(f.reopen().conversation("cowork").projectId, undefined);
  assert.equal((await detail()).session.project, undefined);
  assert.equal((await list()).data[0].project, undefined);
  assert.deepEqual(f.calls, ["cowork", "cowork"]);
});

test("remote Cowork rejects non-Cowork sessions, foreign accounts and ineligible targets", async (t) => {
  const f = fixture(t, true);
  const session = f.session();
  assert.equal((await f.run({ project_uuid: null }, { session: f.session("a") })).status, 404);
  assert.equal((await f.run({ project_uuid: null }, { session, owner: "other" })).status, 404);
  assert.equal((await f.run({ project_uuid: null, extra: true }, { session })).status, 400);
  f.store.projects[0].visibility = "public";
  assert.equal((await f.run({ project_uuid: "project" }, { session })).status, 404);
  assert.equal((await f.run({ conversation_uuids: ["a"], project_uuid: "project" })).status, 404);
  f.store.conversation("cowork").sessionAuthors = { ownerAccountUuid: "other", viewerAccountUuid: "a" };
  assert.equal((await f.run({ project_uuid: null }, { session })).status, 404);
  assert.deepEqual(f.calls, []);
});

test("retired capture errors are sanitized and batch bounds preserve empty no-op", async (t) => {
  const f = fixture(t);
  const empty = await f.run({ conversation_uuids: [], project_uuid: null });
  assert.deepEqual(empty.data, { moved: [], failed: [] });
  assert.equal(
    (
      await f.run({
        conversation_uuids: Array.from({ length: 1001 }, (_, i) => String(i)),
        project_uuid: null,
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.run({ conversation_uuids: ["x".repeat(201)], project_uuid: null }))
      .status,
    400,
  );
  f.original.stateDirectory = () => {
    throw Error("PRIVATE_SYNTHETIC_PATH");
  };
  const r = await f.run();
  assert.equal(r.status, 409);
  assert.doesNotMatch(JSON.stringify(r.data), /PRIVATE_SYNTHETIC/);
  assert.deepEqual(f.calls, []);
});

test("resolver failure before writes and after a completed move uses fixed conflict without replay", async (t) => {
  const { projectMoveRoute } =
    await import("../electron/official-ui/api/project-move");
  for (const late of [false, true]) {
    const f = fixture(t);
    let reads = 0,
      status = 0,
      data: any;
    const p = `/api/organizations/${organizationUuid("a")}/chat_conversations/move_many`;
    const req: any = Readable.from([
      Buffer.from(
        JSON.stringify({
          conversation_uuids: ["a", "b"],
          project_uuid: "project",
        }),
      ),
    ]);
    req.method = "POST";
    await projectMoveRoute(
      req,
      {
        writeHead(n: number) {
          status = n;
        },
        end(v: any) {
          data = JSON.parse(String(v));
        },
      } as any,
      p,
      new URL(p, "http://fixture.invalid"),
      f.original,
      (id: string) => {
        reads++;
        if (!late || reads === 5) throw Error("PRIVATE_ALIAS_FAILURE");
        return id;
      },
    );
    assert.equal(status, 409);
    assert.deepEqual(f.calls, late ? ["a"] : []);
    assert.match(data.error.message, /Earlier moves may already/);
    assert.doesNotMatch(JSON.stringify(data), /PRIVATE_ALIAS/);
    assert.equal(f.store.conversation("b").projectId, undefined);
  }
});
test("resolved aliases obey the same bounded nonempty ID validation", async (t) => {
  const f = fixture(t);
  for (const value of ["x".repeat(201), "   "]) {
    f.aliases.set("page", value);
    assert.equal(
      (await f.run({ conversation_uuids: ["page"], project_uuid: "project" }))
        .status,
      400,
    );
  }
  assert.deepEqual(f.calls, []);
});

test("alias retarget after acknowledged mutation must not claim old page moved", async (t) => {
  const f = fixture(t);
  f.aliases.set("page", "a");
  f.setHook((at) => {
    if (at === "call") conversationAliases.restore("page", "b");
  });
  const r = await f.run({
    conversation_uuids: ["page"],
    project_uuid: "project",
  });
  assert.deepEqual(f.calls, ["a"]);
  assert.equal(f.reopen().conversation("a").projectId, "project");
  assert.equal(f.reopen().conversation("b").projectId, undefined);
  assert.equal(r.status, 409, JSON.stringify(r));
});
test("destination changed to local while loading must not dispatch Chat move", async (t) => {
  const f = fixture(t);
  f.setHook((at) => {
    if (at === "load") f.store.projects[0].kind = "local";
  });
  const r = await f.run();
  assert.equal(f.calls.length, 0, JSON.stringify({ r, calls: f.calls }));
});
test("destination replaced while loading must not dispatch old selection", async (t) => {
  const f = fixture(t);
  f.setHook((at) => {
    if (at === "load")
      f.store.projects = [
        { ...f.store.projects[0], createdAt: 99, name: "Replacement" },
      ];
  });
  const r = await f.run();
  assert.equal(f.calls.length, 0, JSON.stringify({ r, calls: f.calls }));
});

test("REPRO: original remove consumer resolves all-failed response silently", async () => {
  const file = archive + "shared-m-2-DfdOu-fU.js";
  const ast = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const node = ast.statements.find(
    (n: any) => ts.isFunctionDeclaration(n) && n.name?.text === "Gn",
  )!;
  const gn = vm.runInNewContext("(" + node.getText(ast) + ")");
  let pending = new Set(),
    success = 0,
    errors = 0;
  const result = await gn(
    ["a"],
    { showSuccess: true, showError: true },
    {
      moveManyConversations: async () => ({ moved: [], failed: ["a"] }),
      addSuccess: () => success++,
      addError: () => errors++,
      intl: { formatMessage: (m: any) => m.defaultMessage },
      setRemovingConversations: (fn: any) => (pending = fn(pending)),
    },
  );
  assert.equal(result.failed.length, 1);
  assert.equal(pending.size, 0);
  assert.equal(success, 0);
  assert.equal(errors, 0);
});

test("destination retirement after acknowledgement preserves earlier write but stops remaining batch without replay", async (t) => {
  for (const change of ["delete", "replace", "kind", "duplicate"] as const) {
    const f = fixture(t);
    f.setHook((at) => {
      if (at !== "call") return;
      if (change === "delete") f.store.projects = [];
      if (change === "replace")
        f.store.projects = [{ ...f.store.projects[0], createdAt: 99 }];
      if (change === "kind") f.store.projects[0].kind = "local";
      if (change === "duplicate")
        f.store.projects.push({ ...f.store.projects[0] });
    });
    const r = await f.run({
      conversation_uuids: ["a", "b"],
      project_uuid: "project",
    });
    assert.equal(r.status, 409, change);
    assert.match(r.data.error.message, /Earlier moves may already/);
    assert.deepEqual(f.calls, ["a"]);
    assert.equal(f.reopen().conversation("a").projectId, "project");
    assert.equal(f.reopen().conversation("b").projectId, undefined);
  }
});
test("duplicate initial destination rejects, same selected destination metadata edits remain allowed", async (t) => {
  const duplicate = fixture(t);
  duplicate.store.projects.push({ ...duplicate.store.projects[0] });
  assert.equal((await duplicate.run()).status, 404);
  assert.deepEqual(duplicate.calls, []);
  const renamed = fixture(t);
  renamed.setHook((at) => {
    if (at === "load") renamed.store.projects[0].name = "Renamed";
  });
  assert.deepEqual((await renamed.run()).data, { moved: ["a"], failed: [] });
});
test("fresh destination verification failure is sanitized and never replays completed writes", async (t) => {
  for (const failAt of [2, 3]) {
    const f = fixture(t);
    let reads = 0;
    f.setHook((at) => {
      if (at === "snapshot" && ++reads === failAt)
        throw Error("PRIVATE_DESTINATION_READ");
    });
    const r = await f.run({
      conversation_uuids: ["a", "b"],
      project_uuid: "project",
    });
    assert.equal(r.status, 409);
    assert.doesNotMatch(JSON.stringify(r.data), /PRIVATE_DESTINATION_READ/);
    assert.deepEqual(f.calls, failAt === 2 ? [] : ["a"]);
  }
});
test("alias retarget during final destination read cannot return stale success", async (t) => {
  for (const phase of [2, 3]) {
    const f = fixture(t);
    let reads = 0;
    f.aliases.set("page", "a");
    f.setHook((at) => {
      if (at === "snapshot" && ++reads === phase)
        conversationAliases.restore("page", "b");
    });
    const r = await f.run({
      conversation_uuids: ["page"],
      project_uuid: "project",
    });
    assert.equal(r.status, 409);
    assert.deepEqual(f.calls, phase === 2 ? [] : ["a"]);
  }
});

test("loaded Chat replaced by same-ID Code during final project read cannot mutate Code", async (t) => {
  const f = fixture(t);
  let reads = 0;
  f.setHook((at) => {
    if (at === "snapshot" && ++reads === 2) {
      const previous = f.store.conversations.find((c) => c.id === "a")!;
      f.store.conversations = f.store.conversations.map((c) =>
        c === previous ? { ...c, mode: "code" } : c,
      );
    }
  });
  const r = await f.run();
  assert.deepEqual(r.data, { moved: [], failed: ["a"] });
  assert.equal(f.store.conversation("a").mode, "code");
  assert.equal(f.store.conversation("a").projectId, undefined);
  assert.equal(f.reopen().conversation("a").projectId, undefined);
  assert.deepEqual(f.calls, ["a"]);
});

test("serialized guard rejects newer Chat incarnation or membership before native effects", async (t) => {
  for (const change of ["createdAt", "membership", "mode"] as const) {
    const f = fixture(t);
    let reads = 0;
    f.setHook((at) => {
      if (at === "snapshot" && ++reads === 2) {
        const c = f.store.conversation("a");
        if (change === "createdAt")
          f.store.conversations = f.store.conversations.map((row) =>
            row === c ? { ...row, createdAt: 99 } : row,
          );
        if (change === "membership") c.projectId = "newer-project";
        if (change === "mode") c.mode = "cowork";
      }
    });
    const r = await f.run();
    assert.deepEqual(r.data, { moved: [], failed: ["a"] });
    assert.equal(
      f.store.conversation("a").projectId,
      change === "membership" ? "newer-project" : undefined,
    );
    assert.equal(f.reopen().conversation("a").projectId, undefined);
    assert.deepEqual(f.calls, ["a"]);
  }
});

test("REST carries versioned membership preconditions inside projectId, not an ignorable extra argument", async (t) => {
  const f = fixture(t);
  f.aliases.set("page", "a");
  f.store.conversation("a").createdAt = 42;
  const call = f.original.call;
  const envelopes: any[] = [];
  f.original.call = async (name: string, ...args: any[]) => {
    assert.equal(name, "updateConversation");
    assert.equal(args.length, 2);
    envelopes.push(structuredClone(args[1]));
    return call(name, ...args);
  };
  assert.deepEqual(
    (await f.run({ conversation_uuids: ["page"], project_uuid: "project" }))
      .data,
    { moved: ["page"], failed: [] },
  );
  assert.deepEqual(envelopes[0], {
    projectId: {
      version: 1,
      target: "project",
      expected: {
        conversationId: "a",
        mode: "chat",
        createdAt: 42,
        sourceProjectId: null,
        destinationCreatedAt: 1,
      },
    },
  });
  assert.deepEqual(
    (await f.run({ conversation_uuids: ["page"], project_uuid: null })).data,
    { moved: ["page"], failed: [] },
  );
  assert.deepEqual(envelopes[1], {
    projectId: {
      version: 1,
      target: null,
      expected: {
        conversationId: "a",
        mode: "chat",
        createdAt: 42,
        sourceProjectId: "project",
        destinationCreatedAt: null,
      },
    },
  });
});
