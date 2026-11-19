import { removeSessionWorktree } from "../electron/git/code-worktree";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { Store } from "../electron/store/store";
import { registerConversationManageHandlers } from "../electron/ipc/conversation-manage-handlers";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
test("inert native archive, actual persisted handler, list, original archived predicate, unarchive", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f096-inert-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.conversations.push({
    id: "f096",
    mode: "code",
    cwd: dir,
    title: "Synthetic archive contract",
    providerId: "p",
    model: "m",
    turns: [],
    createdAt: 1,
    updatedAt: 1,
    archived: false,
  } as any);
  store.flush();
  const handlers = new Map<string, Function>(),
    native = new Map<string, Function>();
  let closes = 0;
  const operations: string[] = [];
  registerConversationManageHandlers({
    context: {
      store,
      activeAccount: { id: "synthetic" },
      accountGeneration: () => 1,
      closeTerminals: () => {
        closes++;
      },
      engine: {},
    },
    engineOf: () => undefined,
    handle: (n: string, f: Function) => handlers.set(n, f),
  } as any);
  const ctx: any = {
    account: () => ({ id: "synthetic" }),
    sessionIdentity: () => store,
    isCurrent: () => true,
    stateDirectory: () => dir,
    settings: () => store.settings,
    localListConversations: async () => structuredClone(store.conversations),
    localLoadConversation: async (id: string) =>
      structuredClone(store.conversation(id)),
    localCall: async (n: string, ...args: any[]) => {
      operations.push(n);
      if (n === "snapshot") return { approvals: [] };
      assert.equal(n, "updateConversation");
      return handlers.get(n)!(...args);
    },
    onEvent: () => () => {},
  };
  registerExperimentalCodeSessions({
    ctx,
    on: (n: string, f: Function) => native.set(n, f),
    emit() {},
  } as any);
  const assets = "build/official-ui/ui/assets/v1/";
  const p21 = fs.readFileSync(assets + "shared-21-BEljNzmn.js", "utf8"),
    p20 = fs.readFileSync(assets + "shared-20-C2JgSgMH.js", "utf8"),
    p39 = fs.readFileSync(assets + "shared-39-BVbIfnmZ.js", "utf8");
  const scope: any = {};
  vm.runInNewContext(
    p39.slice(
      p39.indexOf("function nW(e) {"),
      p39.indexOf("function Jt(e) {"),
    ) +
      ";this.w0=_w;" +
      p20.slice(
        p20.indexOf("function Mt(e) {"),
        p20.indexOf("function bi(e) {"),
      ) +
      p20.slice(
        p20.indexOf("function Kn(e) {"),
        p20.indexOf("function Pl(e) {"),
      ) +
      p21.slice(
        p21.indexOf("function Wj(e) {"),
        p21.indexOf("function Nu(e, t) {"),
      ),
    scope,
  );
  const visible = async () => {
    const result = await native.get("LocalSessions.getSessionList")!();
    assert.equal(result.archivedPending, false);
    assert.equal(result.sessions.length, 1);
    return {
      row: result.sessions[0],
      enabled: scope["i$"](
        {
          cloudPossible: false,
          listSettled: true,
          listErrored: false,
          archivedInHand: result.sessions.some(scope.Kn),
          filtered: false,
          emptyCase: "not-empty",
        },
        "unasked",
      ),
    };
  };
  const producer = fs.readFileSync(assets + "c6b8adeaf-9EdC4eB_.js", "utf8");
  const anchor =
    ".archive(e.id, { forceWorktreeCleanup: a, discardChangesIn: o })";
  assert.ok(producer.includes(anchor));
  const expression = anchor.slice(
    anchor.indexOf("{"),
    anchor.lastIndexOf("}") + 1,
  );
  const normalOptions = vm.runInNewContext("(" + expression + ")", {
    a: false,
    o: [],
  });
  // Negative control records the previous omitted-options coverage gap: the
  // original consumer's ordinary payload was rejected before any update.
  const oldRefusal = (options: any) => {
    if (options && Object.keys(options).length)
      throw Error("Code archive options are not supported yet.");
  };
  assert.throws(() => oldRefusal(normalOptions), /not supported/);
  assert.doesNotThrow(() => oldRefusal(undefined));
  for (const bad of [
    null,
    false,
    [],
    1,
    "",
    { forceWorktreeCleanup: true },
    { cleanupWorktree: false },
    { cleanupWorktree: 1 },
    { forceWorktreeCleanup: 0 },
    { discardChangesIn: ["/synthetic"] },
    { discardChangesIn: "" },
    { cleanupWorktree: null },
    { unknown: false },
  ]) {
    await assert.rejects(
      native.get("LocalSessions.archive")!("local_f096", bad),
      /Code archive options are not supported yet/,
    );
    assert.equal(store.conversation("f096").archived, false);
  }
  assert.equal(operations.filter((x) => x === "updateConversation").length, 0);
  assert.equal((await visible()).enabled, false);
  const transportSource = fs.readFileSync(
    assets + "cef1e6037-DIC2zPYg.js",
    "utf8",
  );
  const start = transportSource.indexOf("    async archive(e, t) {"),
    end = transportSource.indexOf("    async unarchive(e) {", start);
  assert.ok(start > 0 && end > start);
  const received: any[] = [];
  const transport = (feature: boolean) => {
    const box: any = {
      Hr: () => feature,
      a: {
        archive: async (id: string, options: any) => {
          received.push(options);
          return native.get("LocalSessions.archive")!(id, options);
        },
      },
    };
    vm.runInNewContext(
      "this.transport=({" + transportSource.slice(start, end) + "});",
      box,
    );
    return box.transport;
  };
  // The prior fix tested Ca only and missed Z.archive injecting cleanupWorktree.
  await transport(false).archive("local_f096", normalOptions);
  assert.equal(received.at(-1).cleanupWorktree, true);
  assert.deepEqual(Object.keys(received.at(-1)), [
    "cleanupWorktree",
    "forceWorktreeCleanup",
  ]);
  let r = await visible();
  assert.equal(r.row.isArchived, true);
  assert.equal(r.enabled, true);
  assert.equal(new Store(dir).conversation("f096").archived, true);
  assert.equal(closes, 1);
  assert.equal(store.conversation("f096").worktree, undefined);
  await native.get("LocalSessions.unarchive")!("local_f096");
  r = await visible();
  assert.equal(r.row.isArchived, false);
  assert.equal(r.enabled, false);
  assert.equal(new Store(dir).conversation("f096").archived, false);
  assert.equal(store.conversations.length, 1);
  assert.equal(closes, 1);
  assert.equal(operations.filter((x) => x === "updateConversation").length, 2);
  for (const feature of [false, true])
    for (const input of [normalOptions, undefined]) {
      await transport(feature).archive("local_f096", input);
      assert.equal(new Store(dir).conversation("f096").archived, true);
      assert.equal(received.at(-1).cleanupWorktree, true);
      assert.equal(Object.hasOwn(received.at(-1), "discardChangesIn"), feature);
      await native.get("LocalSessions.unarchive")!("local_f096");
    }
  const beforeRefused = operations.filter(
    (x) => x === "updateConversation",
  ).length;
  for (const feature of [false, true])
    await assert.rejects(
      transport(feature).archive("local_f096", {
        forceWorktreeCleanup: true,
        discardChangesIn: [],
      }),
      /not supported/,
    );
  await assert.rejects(
    transport(true).archive("local_f096", {
      forceWorktreeCleanup: false,
      discardChangesIn: ["/synthetic"],
    }),
    /not supported/,
  );
  assert.equal(
    operations.filter((x) => x === "updateConversation").length,
    beforeRefused,
  );
  for (const compatible of [
    undefined,
    {},
    { forceWorktreeCleanup: false },
    { discardChangesIn: [] },
    {
      cleanupWorktree: undefined,
      forceWorktreeCleanup: undefined,
      discardChangesIn: undefined,
    },
    { cleanupWorktree: true },
  ]) {
    await native.get("LocalSessions.archive")!("local_f096", compatible);
    assert.equal(store.conversation("f096").archived, true);
    await native.get("LocalSessions.unarchive")!("local_f096");
    assert.equal(new Store(dir).conversation("f096").archived, false);
  }
  console.log(
    "Synthetic archive -> list.isArchived -> original Kn/i$ enables recovery; unarchive persists. No model/deletion/worktree path.",
  );
});

test("existing clean-only worktree removal never forces dirty or unverifiable contents", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "f096-worktree-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${path.join(dir, "fixture")}`);
  for (const state of ["clean", "dirty", "unknown"]) {
    const calls: string[][] = [];
    const git = async (_cwd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "status") {
        if (state === "unknown") throw Error("inert status failure");
        return state === "dirty" ? " M file.txt\n" : "";
      }
      if (args[0] === "rev-parse")
        return dir + "\n" + (args.includes("HEAD") ? "refs/heads/synthetic\n" : "");
      return "";
    };
    const outcome = await removeSessionWorktree(
      { path: dir, repository: dir, branch: "synthetic", name: "fixture" } as any,
      git,
    );
    assert.equal(outcome, state === "clean" ? "deleted" : "kept");
    assert.equal(
      calls.some((a) => a.includes("--force")),
      false,
    );
    assert.equal(
      calls.some((a) => a.includes("remove")),
      state === "clean",
    );
    assert.equal(fs.existsSync(dir), true);
  }
});
