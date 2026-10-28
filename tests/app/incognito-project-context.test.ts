import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { transform } from "sucrase";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { ProjectKnowledgeStore } from "../../electron/projects/project-knowledge";
import { registerConversationHandlers } from "../../electron/ipc/conversations";
import { openPolicy } from "../../shared/client-policy";
import type { Conversation, Project } from "../../shared/types";
import { readSource } from "../support/read-source";

function setup(space = false) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-incognito-project-"),
  );
  const store = new Store(root);
  const privateFolder = path.join(root, "private-working-folder");
  fs.mkdirSync(privateFolder);
  const project: Project = {
    id: "project",
    name: "Actual project",
    description: "",
    instructions: "Actual project instructions survive incognito selection.",
    cwd: privateFolder,
    createdAt: 1,
  };
  store.projects.push(project);
  new ProjectKnowledgeStore(root, () => store.projects).add(project.id, [
    {
      name: "reference.txt",
      data: Buffer.from("Reference content stays a project file."),
    },
  ]);
  const engineRoot = space ? path.join(root, "cloud-space") : root;
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    space
      ? {
          environment: { kind: "space", spaceId: "incognito-space" },
          root: engineRoot,
        }
      : {},
  );
  engine.policy = () => openPolicy;
  engine.ensure = async () => {};
  const calls: { method: string; params: any }[] = [];
  engine.rpc = {
    async call(method: string, params: unknown) {
      calls.push({ method, params: structuredClone(params) });
      if (method === "thread/start")
        return { thread: { id: `thread-${calls.length}` } };
      if (method === "turn/start")
        return { turn: { id: `turn-${calls.length}` } };
      return {};
    },
    respond() {},
    reject() {},
  } as never;
  (engine as any).windowsSandbox = { assertReady() {}, async ensureReady() {} };
  const handlers = new Map<string, (...args: any[]) => any>();
  const folders: (string | undefined)[] = [];
  const trust: { cwd?: string }[] = [];
  registerConversationHandlers((name, handler) => handlers.set(name, handler), {
    store,
    engine,
    selectedAttachments: new Map(),
    replyFeedback: {} as never,
    allowedFolder(folder?: string) {
      folders.push(folder);
    },
    noActive() {},
    services: {
      workspaceTrust: {
        assert(input: { cwd?: string }) {
          trust.push(input);
        },
      },
    } as never,
  });
  const send = (extra: Record<string, unknown> = {}) =>
    handlers.get("send")!({
      text: "Unsent fixture submitted only to the mock RPC",
      mode: "chat",
      projectId: project.id,
      attachments: [],
      providerId: "default",
      model: "m",
      ...(space
        ? { environment: { kind: "space", spaceId: "incognito-space" } }
        : {}),
      ...extra,
    }) as Promise<Conversation>;
  return {
    root,
    store,
    project,
    engine,
    calls,
    folders,
    trust,
    send,
    managed: path.join(engineRoot, "workspace"),
    update: (id: string, projectId: string) =>
      handlers.get("updateConversation")!(id, { projectId }),
    finish(id: string) {
      for (const turn of store.conversation(id).turns)
        turn.status = "completed";
    },
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("incognito project context retains instructions and knowledge without inheriting its local working folder", async () => {
  for (const space of [false, true]) {
    const env = setup(space);
    try {
      const chat = await env.send({ incognito: true });
      assert.equal(chat.projectId, env.project.id);
      assert.equal(chat.cwd, env.managed);
      assert.equal(chat.incognito, true);
      assert.ok(env.folders.every((folder) => !folder));
      assert.ok(env.trust.every((input) => !input.cwd));
      const start = env.calls.find(
        (call) => call.method === "thread/start",
      )!.params;
      assert.equal(start.cwd, env.managed);
      assert.equal(start.ephemeral, true);
      assert.match(
        start.developerInstructions,
        /Actual project instructions survive incognito selection/,
      );
      assert.match(start.developerInstructions, /reference\.txt/);
      assert.doesNotMatch(
        start.developerInstructions,
        /Reference content stays a project file/,
      );
      const turn = env.calls.find(
        (call) => call.method === "turn/start",
      )!.params;
      assert.equal(JSON.stringify(turn).includes(env.project.cwd!), false);
      env.finish(chat.id);
      env.project.cwd = path.join(env.root, "changed-private-folder");
      env.update(chat.id, env.project.id);
      assert.equal(env.store.conversation(chat.id).cwd, env.managed);
      assert.ok(
        env.folders.every((folder) => !folder),
        "moving an incognito chat cannot authorize the project's folder",
      );
      await env.send({ conversationId: chat.id });
      assert.equal(env.store.conversation(chat.id).cwd, env.managed);
      env.store.flush();
      assert.equal(
        new Store(env.root).conversations.some((entry) => entry.id === chat.id),
        false,
      );
    } finally {
      env.close();
    }
  }
});

test("normal project chats, Code and explicit authorized folders retain their existing working folder rules", async () => {
  for (const input of [
    { mode: "chat" },
    { mode: "code", incognito: true },
    { mode: "chat", incognito: true, explicit: true },
  ]) {
    const env = setup();
    try {
      const { explicit, ...extra } = input;
      const own = path.join(env.root, "explicit-authorized-folder");
      fs.mkdirSync(own);
      const chat = await env.send({
        ...extra,
        ...(explicit ? { cwd: own } : {}),
      });
      assert.equal(chat.cwd, explicit ? own : env.project.cwd);
      assert.equal(
        env.calls.find((call) => call.method === "thread/start")!.params.cwd,
        chat.cwd,
      );
      if (extra.mode === "code") assert.equal(chat.incognito, undefined);
    } finally {
      env.close();
    }
  }
});

test("the actual App project callback keeps incognito project-only and preserves normal selection behavior", async () => {
  const source = readSource("src/app/App.tsx");
  const ast = ts.createSourceFile(
    "App.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let callback: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "addConversationToProject"
    )
      callback = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(callback);
  const code = transform(`return (${callback.getText(ast)});`, {
    transforms: ["typescript", "jsx"],
    production: true,
  }).code;
  for (const incognitoShown of [false, true]) {
    const project = { id: "project", cwd: "/actual-project-folder" };
    const selected: string[] = [],
      folders: string[] = [];
    const values = {
      snapshot: { projects: [project] },
      active: undefined,
      incognitoShown,
      setProjectId: (id: string) => selected.push(id),
      setCwd: (cwd: string) => folders.push(cwd),
    };
    const apply = new Function(...Object.keys(values), code)(
      ...Object.values(values),
    );
    await apply(project.id);
    assert.deepEqual(selected, [project.id]);
    assert.deepEqual(folders, incognitoShown ? [] : [project.cwd]);
    await assert.rejects(apply("deleted"), /Project no longer exists/);
  }
});
