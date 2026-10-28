import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../electron/store/store";
import { Engine } from "../../electron/engine/engine";
import { registerCoworkHandlers } from "../../electron/ipc/cowork";
import { coworkFolderGrants } from "../../electron/workspace/cowork-folders";
import { ExecutionFolderBrowser } from "../../electron/workspace/execution-folder-browser";
import { coworkExtension } from "../../electron/connectors/cowork-extension";
import type { Conversation } from "../../shared/types";
import type { AppContext } from "../../electron/app/app-context";
import { webMethodKind } from "../../shared/web-bridge-methods";

function setup() {
  const temporary = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "scheduled-b31-folders-")),
  );
  const store = new Store(path.join(temporary, "account-a"));
  store.settings.computerAccess = true;
  const workspace = path.join(store.root, "spaces", "own-space", "workspace");
  const other = path.join(store.root, "spaces", "sibling-space", "workspace");
  const account = path.join(
    temporary,
    "account-b",
    "spaces",
    "own-space",
    "workspace",
  );
  for (const folder of [
    workspace,
    other,
    account,
    path.join(workspace, "notes"),
    path.join(workspace, "empty"),
  ])
    fs.mkdirSync(folder, { recursive: true });
  const conversation: Conversation = {
    id: "actual-chat",
    mode: "chat",
    title: "Actual Chat",
    providerId: "default",
    model: "m",
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    turns: [],
    cwd: workspace,
    environment: { kind: "space", spaceId: "own-space" },
  };
  store.conversations.push(conversation);
  const handlers = new Map<string, (...args: any[]) => any>();
  const ctx = {
    store,
    engine: { extensions: { has: () => false, add: () => () => {} } },
    connectors: {},
    services: {},
    allowedFolder: () => {
      throw Error("global runner allowedFolder stays closed");
    },
    onAccountActivated() {},
    onAccountDeactivating() {},
  } as unknown as AppContext;
  registerCoworkHandlers(
    ((name: string, handler: (...args: any[]) => any) =>
      handlers.set(name, handler)) as never,
    ctx,
  );
  return {
    store,
    workspace,
    other,
    account,
    conversation,
    ctx,
    call: (name: string, ...args: unknown[]) => handlers.get(name)!(...args),
    close() {
      store.flush();
      fs.rmSync(temporary, { recursive: true, force: true });
    },
  };
}

test("33/34: real remote Chat advertises only its own execution browser; list/access/grant and next-turn context use that root", async () => {
  const env = setup();
  try {
    for (const name of [
      "coworkFolders",
      "listTaskFolderDirectory",
      "coworkFolderAccess",
      "grantCoworkFolder",
    ])
      assert.equal(webMethodKind(name), "remote-runner");
    const snapshot = await env.call("coworkFolders", env.conversation.id);
    assert.deepEqual(snapshot.browser, {
      kind: "execution",
      root: env.workspace,
      initialPath: env.workspace,
    });
    assert.deepEqual(
      await env.call(
        "listTaskFolderDirectory",
        env.conversation.id,
        env.workspace,
      ),
      { path: env.workspace, directories: ["empty", "notes"] },
    );
    const selected = path.join(env.workspace, "notes");
    assert.equal(
      (await env.call("coworkFolderAccess", selected, env.conversation.id))
        .state,
      "ask",
    );
    assert.equal(
      (
        await env.call("grantCoworkFolder", selected, "session", {
          conversationId: env.conversation.id,
        })
      ).state,
      "granted",
    );
    assert.deepEqual(
      (await env.call("coworkFolders", env.conversation.id)).extra,
      [selected],
    );
    const extension = coworkExtension({
      folders: () => coworkFolderGrants(env.store.root),
    });
    const ctx = {
      conversation: { ...env.conversation, threadId: "thread" },
      mode: "chat",
      settings: env.store.settings,
      sandbox: "workspace-write",
    } as never;
    assert.deepEqual(extension.turnSandboxExtras!(ctx), [selected]);
    assert.ok(JSON.stringify(extension.turnContext!(ctx)).includes(selected));
    env.store.settings.computerAccess = false;
    assert.equal(
      (await env.call("coworkFolders", env.conversation.id)).browser,
      undefined,
    );
    await assert.rejects(
      env.call("listTaskFolderDirectory", env.conversation.id, selected),
      /unavailable/,
    );
    await assert.rejects(
      env.call("coworkFolderAccess", selected, env.conversation.id),
      /unavailable/,
    );
    await assert.rejects(
      env.call("grantCoworkFolder", selected, "session", {
        conversationId: env.conversation.id,
      }),
      /unavailable/,
    );
    assert.deepEqual(
      extension.turnSandboxExtras!(ctx),
      [],
      "actual turn drops Chat roots when computer access turns off",
    );
  } finally {
    env.close();
  }
});

test("34: sibling spaces/accounts, traversal, files, relative paths, symlinks and changed roots are rejected by actual handlers", async () => {
  const env = setup();
  try {
    const browser = new ExecutionFolderBrowser(env.workspace);
    const realpath = fs.realpathSync.native;
    let externalProbes = 0;
    fs.realpathSync.native = ((...args: Parameters<typeof realpath>) => {
      externalProbes++;
      return realpath(...args);
    }) as typeof realpath;
    try {
      assert.throws(() => browser.checked(env.account));
    } finally {
      fs.realpathSync.native = realpath;
    }
    assert.equal(
      externalProbes,
      0,
      "outside paths are rejected before the filesystem is probed",
    );
    const escape = path.join(env.workspace, "escape");
    fs.symlinkSync(env.other, escape);
    fs.writeFileSync(path.join(env.workspace, "file"), "x");
    for (const target of [
      env.other,
      env.account,
      escape,
      path.join(env.workspace, ".."),
      path.join(env.workspace, "file"),
      "relative",
    ]) {
      await assert.rejects(
        env.call("listTaskFolderDirectory", env.conversation.id, target),
      );
      await assert.rejects(
        env.call("coworkFolderAccess", target, env.conversation.id),
      );
      await assert.rejects(
        env.call("grantCoworkFolder", target, "session", {
          conversationId: env.conversation.id,
        }),
      );
    }
    assert.ok(
      !(
        await env.call(
          "listTaskFolderDirectory",
          env.conversation.id,
          env.workspace,
        )
      ).directories.includes("escape"),
    );
    const selected = path.join(env.workspace, "notes");
    await env.call("grantCoworkFolder", selected, "session", {
      conversationId: env.conversation.id,
    });
    fs.rmSync(selected, { recursive: true });
    fs.symlinkSync(env.other, selected);
    const extension = coworkExtension({
      folders: () => coworkFolderGrants(env.store.root),
    });
    assert.deepEqual(
      extension.turnSandboxExtras!({
        conversation: env.conversation,
        mode: "chat",
        settings: env.store.settings,
      } as never),
      [],
      "symlink replacement cannot widen next-turn roots",
    );
    fs.renameSync(env.workspace, env.workspace + "-old");
    fs.symlinkSync(env.other, env.workspace);
    await assert.rejects(env.call("coworkFolders", env.conversation.id));
    await assert.rejects(
      env.call("listTaskFolderDirectory", env.conversation.id, env.workspace),
    );
  } finally {
    env.close();
  }
});

test("33/34: stale, bound-computer, SSH and unknown execution sessions never acquire picker/grant capabilities", async () => {
  const env = setup();
  try {
    await assert.rejects(
      env.call("listTaskFolderDirectory", "deleted", env.workspace),
      /not found/,
    );
    for (const replacement of [
      { environment: { kind: "ssh", hostId: "remote" } },
      { environment: { kind: "space", spaceId: "../sibling-space" } },
      { linkedToComputer: true },
      { chatDeviceBinding: {} },
    ]) {
      const original = { ...env.conversation };
      Object.assign(env.conversation, replacement);
      assert.equal(
        (await env.call("coworkFolders", env.conversation.id)).browser,
        undefined,
      );
      await assert.rejects(
        env.call(
          "grantCoworkFolder",
          path.join(env.workspace, "notes"),
          "session",
          { conversationId: env.conversation.id },
        ),
      );
      for (const key of Object.keys(env.conversation))
        delete (env.conversation as any)[key];
      Object.assign(env.conversation, original);
    }
    const directory = new ExecutionFolderBrowser(env.workspace).list(
      path.join(env.workspace, "empty"),
    );
    assert.equal(directory.parent, env.workspace);
    assert.deepEqual(directory.directories, []);
  } finally {
    env.close();
  }
});

test("33: real Chat Engine turn/start receives confirmed native roots and removes them after computer access is disabled", async () => {
  const env = setup();
  try {
    const native = path.join(path.dirname(env.store.root), "native-work");
    const extra = path.join(path.dirname(env.store.root), "native-extra");
    fs.mkdirSync(native);
    fs.mkdirSync(extra);
    const engine = new Engine(
      env.store,
      "unused",
      () => "",
      () => {},
    );
    const calls: any[] = [];
    engine.ensure = async () => {};
    engine.rpc = {
      async call(method: string, params: unknown) {
        calls.push({ method, params });
        if (method === "thread/start") return { thread: { id: "real-thread" } };
        if (method === "turn/start")
          return { turn: { id: `turn-${calls.length}` } };
        return {};
      },
      respond() {},
      reject() {},
    } as never;
    (engine as any).windowsSandbox = {
      assertReady() {},
      async ensureReady() {},
    };
    engine.extensions.add(
      coworkExtension({ folders: () => coworkFolderGrants(env.store.root) }),
    );
    const first = await engine.send({
      text: "Work",
      mode: "chat",
      cwd: native,
      attachments: [],
      providerId: "default",
      model: "m",
    });
    for (const turn of env.store.conversation(first.id).turns)
      turn.status = "completed";
    coworkFolderGrants(env.store.root).grantConversation(first, extra);
    await engine.send({
      conversationId: first.id,
      text: "Next",
      mode: "chat",
      attachments: [],
      providerId: "default",
      model: "m",
    });
    const second = calls
      .filter((call) => call.method === "turn/start")
      .at(-1).params;
    assert.ok(second.sandboxPolicy.writableRoots.includes(extra));
    assert.ok(JSON.stringify(second.additionalContext).includes(extra));
    for (const turn of env.store.conversation(first.id).turns)
      turn.status = "completed";
    env.store.settings.computerAccess = false;
    await engine.send({
      conversationId: first.id,
      text: "Again",
      mode: "chat",
      attachments: [],
      providerId: "default",
      model: "m",
    });
    const third = calls
      .filter((call) => call.method === "turn/start")
      .at(-1).params;
    assert.ok(!third.sandboxPolicy.writableRoots?.includes(extra));
    assert.ok(
      JSON.stringify(third.additionalContext).includes("no longer available"),
    );
  } finally {
    env.close();
  }
});

test("33/34: an actual space peer inherits the registered folder extension and sends confirmed execution folder context", async () => {
  const env = setup();
  try {
    const account = new Engine(
      env.store,
      "unused",
      () => "",
      () => {},
    );
    const activate: (() => void)[] = [],
      deactivate: (() => void)[] = [];
    const ctx = {
      ...env.ctx,
      engine: account,
      services: {},
      onAccountActivated: (fn: () => void) => activate.push(fn),
      onAccountDeactivating: (fn: () => void) => deactivate.push(fn),
    } as unknown as AppContext;
    registerCoworkHandlers((() => {}) as never, ctx);
    for (const fn of activate) fn();
    const selected = path.join(env.workspace, "notes");
    await env.call("grantCoworkFolder", selected, "session", {
      conversationId: env.conversation.id,
    });
    const peer = account.createPeer({
      environment: env.conversation.environment!,
      root: path.dirname(env.workspace),
    });
    const calls: any[] = [];
    peer.ensure = async () => {};
    peer.rpc = {
      async call(method: string, params: unknown) {
        calls.push({ method, params });
        if (method === "thread/start")
          return { thread: { id: "space-thread" } };
        if (method === "turn/start") return { turn: { id: "space-turn" } };
        return {};
      },
      respond() {},
      reject() {},
    } as never;
    (peer as any).windowsSandbox = { assertReady() {}, async ensureReady() {} };
    await peer.send({
      conversationId: env.conversation.id,
      text: "Work in notes",
      mode: "chat",
      attachments: [],
      providerId: "default",
      model: "m",
    });
    const turn = calls.find((call) => call.method === "turn/start").params;
    assert.ok(JSON.stringify(turn.additionalContext).includes(selected));
    assert.ok(turn.sandboxPolicy.writableRoots.includes(selected));
    for (const fn of deactivate) fn();
    assert.ok(
      !account.peerExtensions.some(
        (extension) => extension.id === "cowork-folders",
      ),
    );
  } finally {
    env.close();
  }
});
