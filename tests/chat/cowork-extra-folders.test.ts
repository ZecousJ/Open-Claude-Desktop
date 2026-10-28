/**
 * R11-D: folders added to a Cowork task reach Codex as extra writable roots
 * (turn/start sandboxPolicy) and as turn context, are checked again every
 * turn, and are added from the window only through the access dialog.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { CoworkFolderGrants } from "../../electron/workspace/cowork-folders";
import {
  coworkAddedFolders,
  coworkExtension,
  coworkExtensionId,
  registerCoworkExtension,
} from "../../electron/connectors/cowork-extension";
import { openPolicy } from "../../shared/client-policy";
import { turnSandboxPolicy } from "../../shared/sandbox-policy";
import type { CoworkFolderAccess } from "../../shared/cowork-api";
import type { Conversation } from "../../shared/types";
import {
  addCoworkTaskFolder,
  watchCoworkFolders,
} from "../../src/cowork/task-folders";
import {
  pendingFolderAccess,
  resetFolderAccessForTests,
} from "../../src/cowork/useFolderAccess";
import { notAvailableOnWeb } from "../../shared/web-bridge-methods";

type Call = { method: string; params: any };

function setup() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "claudex-extra-folders-")),
  );
  const profile = path.join(root, "profile");
  fs.mkdirSync(profile);
  const store = new Store(profile);
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.policy = () => openPolicy;
  const calls: Call[] = [];
  let threads = 0;
  engine.ensure = async () => {};
  engine.rpc = {
    async call(method: string, params: any) {
      calls.push({ method, params: structuredClone(params) });
      if (method === "thread/start" || method === "thread/fork")
        return { thread: { id: `thread-${++threads}` } };
      if (method === "turn/start")
        return { turn: { id: `turn-${calls.length}` } };
      return {};
    },
    respond() {},
    reject() {},
  } as any;
  (engine as any).windowsSandbox = { assertReady() {}, async ensureReady() {} };
  const work = path.join(root, "work");
  const extra = path.join(root, "extra");
  fs.mkdirSync(work);
  fs.mkdirSync(extra);
  const grants = new CoworkFolderGrants(profile, {
    platform: "linux",
    home: path.join(root, "home"),
  });
  const turns = () => calls.filter((call) => call.method === "turn/start");
  return {
    root,
    store,
    engine,
    calls,
    grants,
    work,
    extra,
    lastTurn: () => turns().at(-1)!.params,
    async send(extraInput: Record<string, unknown> = {}) {
      const conversation = await engine.send({
        text: "Hello",
        mode: "cowork",
        cwd: work,
        attachments: [],
        providerId: "default",
        model: "m",
        ...extraInput,
      });
      for (const turn of store.conversation(conversation.id).turns)
        turn.status = "completed";
      return store.conversation(conversation.id);
    },
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const originalPlatform = process.platform;
function onPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform });
}
test.afterEach(() => onPlatform(originalPlatform));

test("Cowork reads edited folder instructions on the next turn and clears deleted instructions", async () => {
  onPlatform("darwin");
  const env = setup();
  try {
    env.engine.extensions.add(coworkExtension({ folders: () => env.grants }));
    const file = path.join(env.work, "CLAUDE.md");
    fs.writeFileSync(file, "Use tables.");
    const first = await env.send();
    const key = `${coworkExtensionId}.folder-instructions`;
    assert.match(env.lastTurn().additionalContext[key].value, /Use tables\./);
    fs.writeFileSync(file, "Use concise tables.");
    await env.send({ conversationId: first.id });
    assert.match(
      env.lastTurn().additionalContext[key].value,
      /Use concise tables\./,
    );
    fs.unlinkSync(file);
    await env.send({ conversationId: first.id });
    assert.equal(
      env.lastTurn().additionalContext[key].value,
      "Folder instructions (CLAUDE.md):\n",
    );
    await env.send({ mode: "code" });
    assert.equal(env.lastTurn().additionalContext?.[key], undefined);
  } finally {
    env.close();
  }
});

test("unattended URL sign-in requests hold the task and stop its turn; attended follow-ups still ask", async () => {
  onPlatform("darwin");
  const env = setup();
  try {
    const conversation = await env.send({
      scheduledRun: true,
      scheduledTaskId: "routine",
    });
    env.store.settings.mcpServers = {
      notion: { url: "https://mcp.notion.com/mcp" },
    };
    const holds: unknown[] = [];
    const responses: unknown[] = [];
    let unattended = true;
    let interrupted = false;
    env.engine.routineApprovals = {
      isUnattended: () => unattended,
      holdForConnection: (id, hold) => holds.push([id, hold]),
      allowed: () => [],
      allow() {},
    };
    env.engine.rpc!.respond = (id, result) => {
      responses.push([id, result]);
    };
    env.engine.interrupt = async () => {
      interrupted = true;
    };
    const request = {
      id: "sign-in",
      method: "mcpServer/elicitation/request",
      params: {
        threadId: conversation.threadId,
        serverName: "notion",
        mode: "url",
        url: "https://mcp.notion.com/sign-in",
      },
    };
    (env.engine as any).request(request);
    assert.deepEqual(holds, [
      ["routine", { service: "notion", url: "https://mcp.notion.com/sign-in" }],
    ]);
    assert.deepEqual(responses, [["sign-in", { action: "cancel" }]]);
    assert.equal(interrupted, true);
    unattended = false;
    interrupted = false;
    (env.engine as any).request({ ...request, id: "attended-sign-in" });
    assert.equal(holds.length, 1);
    assert.equal(responses.length, 1);
    assert.equal(interrupted, false);
    assert.equal(env.engine.approvals.length, 1);
  } finally {
    env.close();
  }
});

test("turnSandboxPolicy: extra roots only widen workspace-write", () => {
  assert.deepEqual(turnSandboxPolicy("workspace-write", "/w", ["/w", "/x"]), {
    type: "workspaceWrite",
    writableRoots: ["/w", "/x"],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  });
  assert.deepEqual(turnSandboxPolicy("read-only", "/w", ["/x"]), {
    type: "readOnly",
    networkAccess: false,
  });
  assert.deepEqual(turnSandboxPolicy("danger-full-access", "/w", ["/x"]), {
    type: "dangerFullAccess",
  });
});

test("Cowork tasks follow their permission mode and name an added folder once per thread", async () => {
  onPlatform("darwin");
  const env = setup();
  const workspace = (roots: string[]) => ({
    type: "workspaceWrite",
    writableRoots: roots,
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  });
  try {
    env.engine.extensions.add(coworkExtension({ folders: () => env.grants }));
    const first = await env.send();
    // Manual (the default): the task's folder, asking the person before
    // anything else; no added folders yet, so nothing to say.
    assert.deepEqual(env.lastTurn().sandboxPolicy, workspace([env.work]));
    assert.equal(env.lastTurn().approvalPolicy, "on-request");
    assert.equal(env.lastTurn().approvalsReviewer, "user");
    assert.equal(env.lastTurn().additionalContext, undefined);

    env.grants.grantConversation(first, env.extra);
    await env.send({ conversationId: first.id });
    // An added folder is writable too.
    assert.deepEqual(
      env.lastTurn().sandboxPolicy,
      workspace([env.work, env.extra]),
    );
    const context =
      env.lastTurn().additionalContext[`${coworkExtensionId}.folders`];
    assert.equal(context.kind, "application");
    assert.match(context.value, new RegExp(`- ${env.extra}\\n`));
    assert.match(context.value, /read and change files/);

    // Same folders on the same thread: no repeated context. Auto keeps the
    // sandbox and lets the reviewer answer; Full access never asks.
    env.store.settings.taskPermission = "auto";
    await env.send({ conversationId: first.id });
    assert.equal(env.lastTurn().additionalContext, undefined);
    assert.equal(env.lastTurn().approvalsReviewer, "auto_review");
    assert.equal(env.lastTurn().approvalPolicy, "on-request");
    // A scheduled task's run has full access whatever the home's mode.
    await env.send({ scheduledRun: true });
    assert.deepEqual(env.lastTurn().sandboxPolicy, {
      type: "dangerFullAccess",
    });
    assert.equal(env.lastTurn().approvalPolicy, "never");
    assert.equal(env.lastTurn().approvalsReviewer, "user");
    env.store.settings.taskPermission = "bypass";
    await env.send({ conversationId: first.id });
    assert.deepEqual(env.lastTurn().sandboxPolicy, {
      type: "dangerFullAccess",
    });
    assert.equal(env.lastTurn().approvalPolicy, "never");
    assert.equal(env.lastTurn().approvalsReviewer, "user");
    // A task from an outside prompt (a quick task window's link or address)
    // asks first whatever the mode, on every later turn too.
    const outside = await env.send({ asksFirst: true });
    assert.equal(outside.asksFirst, true);
    assert.equal(env.lastTurn().approvalPolicy, "on-request");
    assert.equal(env.lastTurn().approvalsReviewer, "user");
    await env.send({ conversationId: outside.id });
    assert.equal(env.lastTurn().approvalPolicy, "on-request");

    // The folder disappears: the next turn says so.
    fs.rmSync(env.extra, { recursive: true });
    await env.send({ conversationId: first.id });
    assert.match(
      env.lastTurn().additionalContext[`${coworkExtensionId}.folders`].value,
      /no longer available/,
    );
  } finally {
    env.close();
  }
});

test("folders are named again when the turn that named them never started", async () => {
  onPlatform("darwin");
  const env = setup();
  try {
    env.engine.extensions.add(coworkExtension({ folders: () => env.grants }));
    const first = await env.send();
    env.grants.grantConversation(first, env.extra);
    const call = env.engine.rpc!.call.bind(env.engine.rpc);
    let failNext = true;
    (env.engine.rpc as any).call = async (method: string, params: any) => {
      const result = await call(method, params);
      if (method === "turn/start" && failNext) {
        failNext = false;
        throw new Error("offline");
      }
      return result;
    };
    await assert.rejects(env.send({ conversationId: first.id }), /offline/);
    assert.ok(env.lastTurn().additionalContext[`${coworkExtensionId}.folders`]);
    await env.send({ conversationId: first.id });
    assert.match(
      env.lastTurn().additionalContext[`${coworkExtensionId}.folders`].value,
      new RegExp(`- ${env.extra}\\n`),
    );
  } finally {
    env.close();
  }
});

test("Code conversations never get a Cowork task's folders", async () => {
  onPlatform("darwin");
  const env = setup();
  try {
    env.engine.extensions.add(coworkExtension({ folders: () => env.grants }));
    const code = await env.send({ mode: "code" });
    // A grant recorded under this id (it can't happen through the IPC,
    // which only grants Cowork conversations) still gives nothing.
    env.grants.grantConversation(code, env.extra);
    await env.send({ conversationId: code.id, mode: "code" });
    assert.deepEqual(env.lastTurn().sandboxPolicy.writableRoots, [env.work]);
    assert.equal(env.lastTurn().additionalContext, undefined);
  } finally {
    env.close();
  }
});

test("coworkAddedFolders re-checks every folder and ignores SSH tasks", () => {
  const env = setup();
  try {
    const conversation = {
      id: "c1",
      mode: "cowork",
      cwd: env.work,
      turns: [],
    } as unknown as Conversation;
    const link = path.join(env.root, "link");
    fs.symlinkSync(env.extra, link);
    env.grants.grantConversation(conversation, link);
    assert.deepEqual(
      coworkAddedFolders(conversation, "cowork", env.grants),
      [env.extra],
      "real paths, not the link",
    );
    assert.deepEqual(coworkAddedFolders(conversation, "chat", env.grants), []);
    assert.deepEqual(
      coworkAddedFolders(
        { ...conversation, environment: { kind: "ssh" } } as any,
        "cowork",
        env.grants,
      ),
      [],
    );
    assert.deepEqual(coworkAddedFolders(conversation, "cowork", undefined), []);
  } finally {
    env.close();
  }
});

test("registerCoworkExtension adds the extension per account and removes it", () => {
  const env = setup();
  try {
    let activate = () => {};
    let deactivate = () => {};
    const ctx = {
      engine: env.engine,
      services: {},
      onAccountActivated: (listener: () => void) => {
        activate = listener;
      },
      onAccountDeactivating: (listener: () => void) => {
        deactivate = listener;
      },
    } as any;
    registerCoworkExtension(ctx);
    assert.equal(env.engine.extensions.has(coworkExtensionId), false);
    activate();
    activate();
    assert.equal(env.engine.extensions.has(coworkExtensionId), true);
    deactivate();
    assert.equal(env.engine.extensions.has(coworkExtensionId), false);
  } finally {
    env.close();
  }
});

function fakeApi(
  state: CoworkFolderAccess["state"],
  picked: string | null = "/data/extra",
) {
  const grants: unknown[][] = [];
  return {
    grants,
    api: {
      chooseFolder: async () => picked,
      coworkFolderAccess: async (
        folder: string,
      ): Promise<CoworkFolderAccess> => ({
        state,
        folder,
        name: path.basename(folder),
        ...(state === "refused" ? { reason: "Not this one." } : {}),
      }),
      grantCoworkFolder: async (...args: unknown[]) => {
        grants.push(args);
        return {
          state: "granted",
          folder: String(args[0]),
          name: "extra",
        } as CoworkFolderAccess;
      },
    },
  };
}

const task = { id: "c1", turns: [] } as unknown as Conversation;

test("addCoworkTaskFolder records a trusted folder for the task without asking", async () => {
  resetFolderAccessForTests(0);
  const { api, grants } = fakeApi("trusted");
  assert.equal(await addCoworkTaskFolder(task, { api }), "/data/extra");
  assert.deepEqual(grants, [
    ["/data/extra", "session", { conversationId: "c1" }],
  ]);
});

test("addCoworkTaskFolder asks through the dialog; Cancel adds nothing", async () => {
  resetFolderAccessForTests(1);
  const { api, grants } = fakeApi("ask");
  const cancelled = addCoworkTaskFolder(task, { api });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await pendingFolderAccess()!.answer("cancel");
  assert.equal(await cancelled, undefined);
  assert.deepEqual(grants, []);

  const notes: string[] = [];
  const allowed = addCoworkTaskFolder(
    { ...task, turns: [{ status: "inProgress" }] } as any,
    { api, notify: (message) => notes.push(message) },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(pendingFolderAccess()!.target, { conversationId: "c1" });
  await pendingFolderAccess()!.answer("allow");
  assert.equal(await allowed, "/data/extra");
  assert.deepEqual(grants, [
    ["/data/extra", "session", { conversationId: "c1" }],
  ]);
  assert.deepEqual(notes, ["Claudex can use this folder from its next turn."]);
  resetFolderAccessForTests(0);
});

test("addCoworkTaskFolder explains folders it can't add", async () => {
  resetFolderAccessForTests(0);
  for (const [state, message] of [
    ["refused", "Not this one."],
    ["granted", "This folder is already part of this task."],
    ["default", "Cowork's own workspace can't be added to a task."],
  ] as const) {
    const { api, grants } = fakeApi(state);
    const notes: string[] = [];
    assert.equal(
      await addCoworkTaskFolder(task, {
        api,
        notify: (note) => notes.push(note),
      }),
      undefined,
    );
    assert.deepEqual(notes, [message]);
    assert.deepEqual(grants, []);
  }
  const { api, grants } = fakeApi("ask", null);
  assert.equal(await addCoworkTaskFolder(task, { api }), undefined);
  assert.deepEqual(grants, []);
});

test("watchCoworkFolders follows this task's events and reports unsupported explicitly", async () => {
  const listeners: ((event: any) => void)[] = [];
  let loads = 0;
  const seen: unknown[] = [];
  const errors: unknown[] = [];
  const stop = watchCoworkFolders(
    {
      coworkFolders: async () => ({ primary: "/w", extra: [`/x${++loads}`] }),
      onEvent: (listener: (event: any) => void) => {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
    } as any,
    "c1",
    (folders) => seen.push(folders),
    (error) => errors.push(error),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  listeners[0]({ type: "cowork-folders", conversationId: "other" });
  listeners[0]({ type: "cowork-folders", conversationId: "c1" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen, [
    { primary: "/w", extra: ["/x1"] },
    { primary: "/w", extra: ["/x2"] },
  ]);
  stop();
  assert.equal(listeners.length, 0);

  const webSeen: unknown[] = [];
  const web = watchCoworkFolders(
    {
      coworkFolders: async () => {
        throw new Error(`Error invoking remote method: ${notAvailableOnWeb}`);
      },
      onEvent: () => () => {},
    } as any,
    "c1",
    (folders) => webSeen.push(folders),
    (error) => errors.push(error),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  web();
  assert.equal(errors.length, 1);
  assert.equal(
    (errors[0] as Error).message,
    `Error invoking remote method: ${notAvailableOnWeb}`,
  );
  assert.deepEqual(webSeen, []);
});
