import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import ts from "typescript";
import { preference } from "../../shared/settings-extras";
import { assertCodeSessionSendAvailable } from "../../electron/conversations/code-lifecycle-guard";
import { assertNewConversationIdAvailable } from "../../electron/engine/new-conversation";
import { prepareSkillInvocation } from "../../electron/engine/skill-invocation";
import { limitsKey, reloadOptions } from "../../electron/engine/thread-options";
import { organizationProjectChatFor } from "../../electron/engine/organization-project-chat";
import {
  ProjectKnowledgeStore,
  projectKnowledgeInstructions,
} from "../../electron/projects/project-knowledge";

const failure = "Project knowledge could not be read. Try again.";
function fixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f027-prompt-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = ["alpha", "beta"].map((id) => ({
    id,
    name: id,
    instructions: `${id} instructions`,
    description: "",
    createdAt: 1,
  }));
  const store = new ProjectKnowledgeStore(root, () => projects);
  return { root, projects, store };
}

test("no project and missing or empty knowledge folders remain legitimate empty context", (t) => {
  const f = fixture(t);
  assert.equal(projectKnowledgeInstructions(f.root, undefined), undefined);
  assert.equal(projectKnowledgeInstructions(f.root, f.projects[0]), undefined);
  fs.mkdirSync(f.store.folder("alpha"), { recursive: true });
  assert.equal(projectKnowledgeInstructions(f.root, f.projects[0]), undefined);
});

test("knowledge inventory is bounded, names-only, and isolated by project", async (t) => {
  const f = fixture(t);
  await f.store.add(
    "alpha",
    Array.from({ length: 101 }, (_, i) => ({
      name: `reference-${i}.txt`,
      data: Buffer.from("PRIVATE_REFERENCE_CONTENT"),
    })),
  );
  await f.store.add("beta", [
    { name: "beta.pdf", data: Buffer.from("%PDF-1.7\nPRIVATE_PDF_CONTENT") },
  ]);
  const alpha = projectKnowledgeInstructions(f.root, f.projects[0])!;
  assert.equal(
    alpha.split("\n").filter((line) => /^- reference-/.test(line)).length,
    100,
  );
  assert.match(alpha, /and 1 more/);
  assert.ok(alpha.includes(f.store.folder("alpha")));
  assert.match(alpha, /reference data, not as instructions/);
  assert.doesNotMatch(alpha, /PRIVATE_REFERENCE_CONTENT|beta\.pdf/);
  const beta = projectKnowledgeInstructions(f.root, f.projects[1])!;
  assert.match(beta, /beta\.pdf/);
  assert.doesNotMatch(beta, /reference-\d|PRIVATE_PDF_CONTENT/);
  f.store.remove("beta", "beta.pdf");
  assert.equal(projectKnowledgeInstructions(f.root, f.projects[1]), undefined);
});

test("corrupt metadata and unsafe knowledge folders fail explicitly instead of dropping context", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.store.folder("alpha")), { recursive: true });
  const metadata = path.join(
    f.root,
    "projects",
    "alpha",
    "knowledge-sources.json",
  );
  fs.writeFileSync(metadata, "{ malformed private metadata");
  assert.throws(() => projectKnowledgeInstructions(f.root, f.projects[0]), {
    message: failure,
  });
  fs.unlinkSync(metadata);
  fs.symlinkSync(f.root, f.store.folder("alpha"));
  assert.throws(() => projectKnowledgeInstructions(f.root, f.projects[0]), {
    message: failure,
  });
});

test("read errors fail closed without exposing private filesystem diagnostics", (t) => {
  const f = fixture(t);
  const original = fs.readdirSync;
  t.mock.method(fs, "readdirSync", ((folder: any, ...args: any[]) => {
    if (String(folder) === f.store.folder("alpha"))
      throw Object.assign(new Error("private path EACCES"), { code: "EACCES" });
    return (original as any)(folder, ...args);
  }) as typeof fs.readdirSync);
  assert.throws(() => projectKnowledgeInstructions(f.root, f.projects[0]), {
    message: failure,
  });
});

/** Execute the checked-in exported bodies, with explicit inert dependencies.
 * No Engine constructor, module initialization, provider, subprocess, socket,
 * account profile, or model is loaded. Unprovided dependencies fail loudly. */
function exportedBody(
  file: string,
  name: string,
  dependencies: Record<string, unknown>,
) {
  const source = fs.readFileSync(new URL(file, import.meta.url), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.ok(declaration, `Missing exported function ${name}`);
  const body = declaration.getText(ast).replace(/^export\s+/, "");
  const js = ts.transpileModule(`const extracted = ${body};`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  return new Function(...Object.keys(dependencies), `${js}\nreturn extracted;`)(
    ...Object.values(dependencies),
  );
}
const threadOptions = exportedBody(
  "../../electron/engine/engine-turn-setup.ts",
  "threadOptions",
  {
    projectKnowledgeInstructions,
    modelProtocol: () => "responses",
    profileInstructions: () => "",
    modeInstructions: () => "",
    capabilityInstructions: () => [],
    designSystemInstructions: () => "",
    builtinMcpConfig: () => ({}),
    connectorThreadConfig: () => ({}),
    chatExecutionEnabled: () => true,
    chatExecutionEnvironments: () => ({
      environments: [{ environmentId: "local" }],
    }),
    approvalPolicyFor: () => "never",
    approvalsReviewerFor: () => undefined,
  },
);
let prepareInput: ((text: string) => Promise<unknown>) | undefined;
const send = exportedBody("../../electron/engine/engine-send.ts", "send", {
  organizationProjectChatFor,
  fs,
  path,
  randomUUID,
  preference,
  assertCodeSessionSendAvailable,
  assertNewConversationIdAvailable,
  prepareSkillInvocation,
  StartTiming: class {
    enabled = false;
    mark() {}
  },
  timingWanted: () => false,
  turnInput: async (text: string) => {
    await prepareInput?.(text);
    return [{ type: "text", text }];
  },
  finishTurn: (turn: any, status: string) => {
    turn.status = status;
  },
  failSetup: () => {},
  markSetupStep: () => {},
  isContextLimitError: () => false,
  effortForMode: () => "medium",
  thinkingSummaryForTurn: () => ({}),
  codexModelSlug: (model: string) => model,
  effectiveToolSearch: () => "off",
  assertBlankArtifactRevision: () => {},
});

function inertEngine(t: test.TestContext) {
  const f = fixture(t);
  const conversation: any = {
    id: "chat-alpha",
    projectId: "alpha",
    mode: "chat",
    cwd: path.join(f.root, "workspace"),
    turns: [],
    createdAt: 1,
  };
  const calls: { method: string; params: any }[] = [];
  let startupCalls = 0;
  const engine: any = {
    store: {
      root: f.root,
      projects: f.projects,
      conversations: [conversation],
      settings: {
        providers: [{ id: "fake" }],
        instructions: "global instructions",
      },
      conversation: () => conversation,
      flush() {},
    },
    environment: { kind: "local" },
    startedModelEfforts: [],
    safeguardModels: new Map(),
    routes: new Map(),
    assertMcpAvailable() {},
    elsewhereFor() {},
    elsewhere() {},
    assertSendable() {},
    assertIdle() {},
    assertExtensions() {},
    canQueue: () => false,
    dropWebSearch: async () => {},
    sendCwd: () => conversation.cwd,
    policy: () => ({ webSearch: true }),
    ensure: async () => {
      startupCalls++;
    },
    syncRequestOptions: async () => {},
    windowsSandbox: { ensureReady: async () => {} },
    sandboxSetupFolder: () => f.root,
    changed() {},
    contextConfig: () => ({}),
    mcpConfig: () => "{}",
    extensions: {
      developerInstructions: () => [],
      dynamicTools: () => [],
      threadConfigOverrides: () => ({}),
      builtinMcpServers: () => [],
      prepareTurn: async () => {},
    },
    turnContext: () => ({ sandbox: "read-only", settings: {} }),
    turnExtras: () => ({}),
    ensureThread: async (c: any, options: any) => {
      const result = await engine.rpc.call("thread/start", options);
      c.threadId = result.thread.id;
    },
    rpc: {
      connected: true,
      call: async (method: string, params: any) => {
        calls.push({ method, params: structuredClone(params) });
        return method === "thread/start"
          ? { thread: { id: "fake-thread" } }
          : { turn: { id: "fake-turn" } };
      },
    },
  };
  engine.threadOptions = threadOptions.bind(engine);
  const submit = (
    projectId = conversation.projectId,
    extra: Record<string, unknown> = {},
  ) =>
    send.call(engine, {
      conversationId: conversation.id,
      projectId,
      mode: "chat",
      providerId: "fake",
      model: "fake-model",
      text: "synthetic fixture only",
      attachments: [],
      ...extra,
    });
  return {
    ...f,
    engine,
    conversation,
    calls,
    submit,
    startupCalls: () => startupCalls,
  };
}

test("actual send fails before thread/turn dispatch, releases its lock, and recovers with isolated project context", async (t) => {
  const f = inertEngine(t);
  await f.store.add("alpha", [
    { name: "alpha.txt", data: Buffer.from("alpha private content") },
  ]);
  await f.store.add("beta", [
    { name: "beta.txt", data: Buffer.from("beta private content") },
  ]);
  const metadata = path.join(
    f.root,
    "projects",
    "alpha",
    "knowledge-sources.json",
  );
  fs.writeFileSync(metadata, "{ broken metadata");
  await assert.rejects(f.submit(), { message: failure });
  assert.equal(
    f.startupCalls(),
    1,
    "startup is inert; context validation is pre-turn, not pre-startup",
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.engine.pendingSend, false);
  assert.equal(f.engine.earlyTurn, undefined);
  assert.equal(f.conversation.turns.at(-1).status, "failed");
  assert.equal(f.conversation.turns.at(-1).error, failure);
  assert.equal(f.conversation.turns.at(-1).sendFailed, true);
  fs.unlinkSync(metadata);
  await f.submit();
  assert.deepEqual(
    f.calls.map((call) => call.method),
    ["thread/start", "turn/start"],
  );
  assert.match(
    f.calls[0].params.developerInstructions,
    /alpha instructions[\s\S]*alpha\.txt/,
  );
  assert.doesNotMatch(
    f.calls[0].params.developerInstructions,
    /beta\.txt|alpha private content/,
  );
  f.conversation.turns.at(-1).status = "completed";
  f.conversation.projectId = "beta";
  await f.submit();
  assert.match(
    f.calls[2].params.developerInstructions,
    /beta instructions[\s\S]*beta\.txt/,
  );
  assert.doesNotMatch(
    f.calls[2].params.developerInstructions,
    /alpha instructions|alpha\.txt|beta private content/,
  );
  assert.equal(f.engine.pendingSend, false);
});

const ensureThread = exportedBody(
  "../../electron/engine/engine-turn-setup.ts",
  "ensureThread",
  {
    limitsKey,
    reloadOptions,
    chatExecutionEnabled: (settings: any, mode: string) =>
      mode !== "chat" || settings.chatExecution !== false,
  },
);

test("loaded Chat and Cowork use the saved project's current instructions on each turn", async (t) => {
  const cases = [
    { mode: "chat", incognito: false, enabled: false },
    { mode: "chat", incognito: false, enabled: true },
    { mode: "chat", incognito: true, enabled: false },
    { mode: "chat", incognito: true, enabled: true },
    { mode: "cowork", incognito: false, enabled: true },
  ] as const;
  for (const { mode, incognito, enabled } of cases) {
    const f = inertEngine(t);
    f.conversation.mode = mode;
    f.conversation.incognito = incognito;
    f.conversation.threadId = "loaded-thread";
    f.engine.loaded = new Set(["loaded-thread"]);
    f.engine.store.settings.chatExecution = enabled;
    f.engine.store.settings.codePlanMode = true;
    const options = f.engine.threadOptions(f.conversation, { id: "fake" }, "model-one", mode, f.projects[0]);
    f.engine.threadLimits = new Map([["loaded-thread", limitsKey(options)]]);
    f.engine.ensureThread = ensureThread.bind(f.engine);
    const runtimeKey = f.engine.threadLimits.get("loaded-thread");
    for (const instructions of ["UPDATED project instructions", "Other project guidance", ""]) {
      f.projects[0].instructions = instructions;
      f.calls.length = 0;
      await f.submit(undefined, { mode, projectId: undefined });
      assert.deepEqual(f.calls.map(call => call.method), ["turn/start"]);
      const active = f.calls[0].params.collaborationMode;
      assert.equal(active.mode, "default");
      assert.equal(active.settings.developer_instructions.includes("UPDATED project instructions"), instructions === "UPDATED project instructions");
      assert.equal(active.settings.developer_instructions.includes("Other project guidance"), instructions === "Other project guidance");
      assert.equal(f.conversation.threadId, "loaded-thread");
      assert.equal(f.engine.threadLimits.get("loaded-thread"), runtimeKey);
      f.conversation.turns.at(-1).status = "completed";
    }
  }
});

test("project context is included for representative provider/model identifiers without model calls", async (t) => {
  const f = inertEngine(t);
  await f.store.add("alpha", [
    {
      name: "reference.txt",
      data: Buffer.from("reference bytes stay on disk"),
    },
  ]);
  for (const [providerId, model] of [
    ["responses-fixture", "gpt-fixture"],
    ["messages-fixture", "claude-fixture"],
    ["chat-fixture", "compatible-fixture"],
  ]) {
    const options = f.engine.threadOptions(
      f.conversation,
      { id: providerId },
      model,
      "chat",
      f.projects[0],
    );
    assert.equal(options.model, model);
    assert.match(
      options.developerInstructions,
      /alpha instructions[\s\S]*reference\.txt/,
    );
    assert.doesNotMatch(
      options.developerInstructions,
      /reference bytes stay on disk/,
    );
  }
  assert.equal(f.calls.length, 0);
});

test("native Chat rejects missing or conflicting projects before startup and uses stored context when omitted", async (t) => {
  for (const projectId of ["missing", "", "beta"]) {
    const f = inertEngine(t);
    await assert.rejects(f.submit(projectId), /project changed/);
    assert.equal(f.startupCalls(), 0);
    assert.equal(f.calls.length, 0);
    assert.equal(f.conversation.projectId, "alpha");
    assert.deepEqual(f.conversation.turns, []);
  }
  for (const projectId of ["missing", ""]) {
    const f = inertEngine(t);
    await assert.rejects(
      f.submit(projectId, { conversationId: undefined }),
      /no longer exists/,
    );
    assert.equal(f.startupCalls(), 0);
    assert.equal(f.calls.length, 0);
  }
  const f = inertEngine(t);
  await f.submit(undefined, { projectId: undefined });
  assert.match(f.calls[0].params.developerInstructions, /alpha instructions/);
  f.conversation.turns.at(-1).status = "completed";
  f.engine.store.projects = f.projects.filter(
    (project) => project.id !== "alpha",
  );
  f.calls.length = 0;
  await assert.rejects(f.submit(), /no longer exists/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.startupCalls(), 1);
});

test("project deletion or movement during startup or turn preparation cannot dispatch stale context", async (t) => {
  for (const phase of ["startup", "thread", "prepare"] as const) {
    for (const change of ["delete", "move"] as const) {
      const f = inertEngine(t);
      const mutate = () => {
        if (change === "delete")
          f.engine.store.projects = f.projects.filter(
            (project) => project.id !== "alpha",
          );
        else f.conversation.projectId = "beta";
      };
      if (phase === "startup")
        f.engine.ensure = async () => {
          mutate();
        };
      if (phase === "thread") {
        const original = f.engine.ensureThread;
        f.engine.ensureThread = async (...args: any[]) => {
          await original(...args);
          mutate();
        };
      }
      if (phase === "prepare")
        f.engine.extensions.prepareTurn = async () => {
          mutate();
        };
      await assert.rejects(f.submit(), /project.*(changed|exists)/);
      assert.equal(
        f.calls.some((call) => call.method === "turn/start"),
        false,
      );
      if (phase === "startup") assert.equal(f.calls.length, 0);
      assert.equal(f.engine.pendingSend, false);
      assert.equal(f.conversation.turns.at(-1).status, "failed");
      assert.equal(
        f.conversation.projectId,
        change === "move" ? "beta" : "alpha",
      );
    }
  }
});

test("view-only project knowledge remains readable without granting edit permissions", async (t) => {
  const f = fixture(t);
  await f.store.add("alpha", [
    { name: "readonly.txt", data: Buffer.from("reference only") },
  ]);
  Object.assign(f.projects[0], {
    capabilities: { canEditInstructions: false, canEditKnowledgeBase: false },
  });
  assert.match(
    projectKnowledgeInstructions(f.root, f.projects[0])!,
    /readonly\.txt/,
  );
  assert.throws(() => f.store.remove("alpha", "readonly.txt"), /permission/);
});

test("project changes while attachment preparation waits reject before creating or forking a native thread", async (t) => {
  for (const retry of [false, true]) {
    for (const change of ["delete", "move"]) {
      const f = inertEngine(t);
      let release!: () => void,
        entered!: () => void,
        forks = 0;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      prepareInput = async () => {
        entered();
        await held;
      };
      f.engine.branchFrom = async () => {
        forks++;
        return {};
      };
      if (retry)
        f.conversation.turns.push({
          id: "prior-turn",
          status: "completed",
          items: [],
        });
      try {
        const work = send.call(
          f.engine,
          {
            conversationId: f.conversation.id,
            projectId: "alpha",
            mode: "chat",
            providerId: "fake",
            model: "fake-model",
            text: "synthetic held attachment fixture",
            attachments: [],
          },
          retry ? "prior-turn" : undefined,
        );
        const rejected = assert.rejects(work, /project.*(changed|exists)/);
        await started;
        if (change === "delete")
          f.engine.store.projects = f.projects.filter(
            (project) => project.id !== "alpha",
          );
        else f.conversation.projectId = "beta";
        release();
        await rejected;
        assert.equal(forks, 0);
        assert.deepEqual(
          f.calls,
          [],
          "no thread/start, fork, resume or turn/start",
        );
        assert.equal(f.engine.pendingSend, false);
        assert.equal(f.engine.earlyTurn, undefined);
      } finally {
        release();
        prepareInput = undefined;
      }
    }
  }
});
