/**
 * Cloud Code sessions on the runner (runner/src/code-workspace.ts, the
 * dispatcher's `send` step, WebAppContext's folder rules, runnerHost), against
 * the same in-process service mock as runner-core-context.test.ts.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import {
  memoryWebstore,
  useElectronShim,
  type MemoryWebstore,
} from "./runner-core-support.test.ts";
import { MockSub2Api, fakeCipher } from "../support/sub2api-mock";
import type { RunnerFrame } from "../../shared/web-runner-frames";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-code-"));
const providerScript = path.join(stateDir, "provider-service.cjs");
await build({
  entryPoints: ["server/provider-service.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: providerScript,
  logLevel: "silent",
});

useElectronShim();
const { Dispatcher } = await import("../../runner/src/dispatcher");
const { RemoteAccounts } = await import("../../electron/sub2api/identity");
const { requestJson } = await import("../../electron/sub2api/http");
const { deviceRegistrationBody } =
  await import("../../shared/claudex-contract");
const { runnerHost } = await import("../../runner/src/main");
const workspace = await import("../../runner/src/code-workspace");
const { repositorySpaceId } = await import("../../runner/src/github-workspace");
const { parseNetConfig } = await import("../../runner/src/net-policy-compile");
const { resolveHost } = await import("../../shared/host");

const user = {
  id: 31,
  email: "cy@example.test",
  password: "cy-password-1",
  username: "Cy",
};
const group = {
  id: 4,
  name: "claudex-pro",
  platform: "openai",
  subscription_type: "subscription",
  status: "active",
};

let mock: InstanceType<typeof MockSub2Api>;
let web: MemoryWebstore;
let token = "";
let deviceId = "";
const results = new Map<string, Extract<RunnerFrame, { t: "result" }>>();
let dispatcher: InstanceType<typeof Dispatcher>;
let nextCall = 0;
const prepared: { sessionId: string; repository?: unknown; more?: unknown }[] =
  [];

before(async () => {
  mock = new MockSub2Api({
    users: [user],
    userApiKeys: false,
    groups: [group],
    subscriptions: [
      {
        id: 78,
        group_id: 4,
        status: "active",
        expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
      },
    ],
    models: { status: 200, body: { data: [{ id: "gpt-5.5" }] } },
  });
  await mock.start();
  const accounts = new RemoteAccounts(
    fs.mkdtempSync(path.join(os.tmpdir(), "runner-login-")),
    mock.url,
    fakeCipher,
  );
  const signIn = await accounts.login(user.email, user.password);
  if (signIn.kind !== "signedIn") throw new Error("sign-in");
  token = await signIn.session.authorized(async (t) => t);
  deviceId = randomUUID();
  web = memoryWebstore();
  dispatcher = new Dispatcher({
    runtime: {
      serviceUrl: mock.url,
      stateDir,
      providerServiceScript: providerScript,
      version: "0.0.1",
      codexBinary: () => "/bin/false",
      log: () => {},
      prepareWorkspace: async (session, repository, more) => {
        prepared.push({ sessionId: session.sessionId, repository, more });
        return workspace.emptyWorkspace(session, repository);
      },
    },
    link: {
      send: (frame) => {
        if (frame.t === "result") results.set(frame.id, frame);
        return true;
      },
      request: async (op, userId, body) => {
        if (op !== "key.get") return web.request(op, userId, body);
        const registration = await requestJson(
          fetch,
          `${mock.url}/api/v1/claudex/devices`,
          {
            method: "POST",
            token,
            deviceId,
            body: deviceRegistrationBody({
              deviceName: "Claudex on the web",
              platform: "linux",
              arch: "x64",
              appVersion: "0.0.1",
              groupId: null,
            }),
          },
        );
        return { deviceId, registration };
      },
    },
    publish: () => {},
    openUrl: () => {},
    guard: { modes: ["chat", "cowork", "code"] },
    maxEngines: 1,
    maxUsers: 4,
    log: () => {},
  });
});

after(async () => {
  await dispatcher.stop();
  await mock.close();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function call(method: string, ...args: unknown[]) {
  const id = `c${++nextCall}`;
  await dispatcher.call({
    t: "call",
    id,
    user: { id: user.id, accessToken: token, tabId: "tab-00000001" },
    method,
    args,
    deadlineMs: 60_000,
  });
  return results.get(id)!;
}

const codeSend = (extra: Record<string, unknown> = {}) => ({
  text: "hi",
  mode: "code",
  attachments: [],
  providerId: "sub2api",
  model: "gpt-5.5",
  ...extra,
});

/** Replaces the user's `send` handler with a recorder of what reaches it. */
async function recordSends() {
  await call("snapshot");
  const ctx = dispatcher.context(user.id)!;
  const seen: any[] = [];
  const original = ctx.handlers.get("send")!;
  ctx.handlers.set("send", async (input: any) => {
    seen.push(input);
    return { id: "conv-1", cwd: input.cwd };
  });
  return { ctx, seen, restore: () => ctx.handlers.set("send", original) };
}

test("a new Code session runs in its own folder in a space of its own (docs/cloud-sync.md)", async () => {
  const { ctx, seen, restore } = await recordSends();
  try {
    const first = await call("send", codeSend());
    const second = await call("send", codeSend());
    assert.equal(first.ok, true, first.error?.message);
    assert.equal(second.ok, true);
    const [a, b] = seen.map((input) => input.cwd as string);
    // Without a repository, each session gets its own space.
    const spaces = seen.map((input) => input.environment);
    for (const environment of spaces) {
      assert.equal(environment.kind, "space");
      assert.match(environment.spaceId, /^s-/);
    }
    assert.notEqual(spaces[0].spaceId, spaces[1].spaceId);
    for (const [index, cwd] of [a, b].entries()) {
      const root = workspace.codeWorkspaceRoot(
        path.join(ctx.spaceRoot(spaces[index].spaceId), "workspace"),
      );
      assert.equal(path.dirname(cwd), root);
      assert.ok(fs.statSync(cwd).isDirectory());
      assert.deepEqual(fs.readdirSync(cwd), []);
    }
    const root = workspace.codeWorkspaceRoot(ctx.workspace);
    assert.notEqual(a, b);
    // The engine's own folder rule accepts them and nothing else.
    assert.doesNotThrow(() => ctx.allowedFolder(a));
    assert.throws(
      () => ctx.allowedFolder("/etc"),
      /can't be used from the web/,
    );
    assert.throws(() => ctx.allowedFolder(ctx.workspace));
    assert.throws(() => ctx.allowedFolder(path.join(root, "..", "x")));
    // The hook saw the session, not the repository, and the handler did not.
    assert.equal(prepared.at(-1)!.repository, undefined);
    assert.equal("repository" in seen[0], false);
  } finally {
    restore();
  }
});

test("the repository goes to the hook, checked for shape, and never to the engine", async () => {
  const { seen, restore } = await recordSends();
  try {
    const url = "https://github.com/acme/tool.git";
    const ok = await call(
      "send",
      codeSend({ repository: { url, ref: "main" } }),
    );
    assert.equal(ok.ok, true, ok.error?.message);
    assert.deepEqual(prepared.at(-1)!.repository, { url, ref: "main" });
    assert.equal("repository" in seen.at(-1), false);
    const before = prepared.length;
    for (const repository of [
      { url: "http://github.com/a/b" },
      { url: "https://user:pw@github.com/a/b" },
      { url: "file:///etc" },
      { url: "https://github.com/a/b", ref: "--upload-pack=x" },
      { url: "https://github.com/a/b", ref: "a..b" },
      "https://github.com/a/b",
    ]) {
      const bad = await call("send", codeSend({ repository }));
      assert.equal(bad.ok, false, JSON.stringify(repository));
      assert.equal(bad.error!.code, "CLAUDEX_WEB_BAD_REQUEST");
    }
    assert.equal(prepared.length, before);
  } finally {
    restore();
  }
});

test("several repositories: the main one names the space, the others go to the hook", async () => {
  const { seen, restore } = await recordSends();
  try {
    const main = "https://github.com/acme/tool.git";
    const other = { url: "https://github.com/acme/lib", ref: "dev" };
    const ok = await call(
      "send",
      codeSend({
        repository: { url: main },
        repositories: [{ url: main }, other, { url: main }],
      }),
    );
    assert.equal(ok.ok, true, ok.error?.message);
    assert.deepEqual(prepared.at(-1)!.repository, { url: main });
    // The same address twice counts once.
    assert.deepEqual(prepared.at(-1)!.more, [other]);
    assert.equal("repositories" in seen.at(-1), false);
    assert.equal(
      seen.at(-1).environment.spaceId,
      (await import("../../runner/src/github-workspace")).repositorySpaceId(
        main,
      ),
    );
    const before = prepared.length;
    for (const repositories of [
      [{ url: "http://github.com/a/b" }],
      "https://github.com/a/b",
      Array.from({ length: 11 }, (_, n) => ({
        url: `https://github.com/a/r${n}`,
      })),
    ]) {
      const bad = await call("send", codeSend({ repositories }));
      assert.equal(bad.ok, false, JSON.stringify(repositories));
      assert.equal(bad.error!.code, "CLAUDEX_WEB_BAD_REQUEST");
    }
    // `repository` beside a list must be its first.
    const mismatch = await call(
      "send",
      codeSend({ repository: other, repositories: [{ url: main }, other] }),
    );
    assert.equal(mismatch.ok, false);
    assert.equal(prepared.length, before);
  } finally {
    restore();
  }
});

test("parseRepositories reads a list, or the one repository", () => {
  assert.deepEqual(workspace.parseRepositories({}), []);
  assert.deepEqual(
    workspace.parseRepositories({
      repository: { url: "https://github.com/a/b" },
    }),
    [{ url: "https://github.com/a/b" }],
  );
  assert.deepEqual(
    workspace.parseRepositories({
      repositories: [
        { url: "https://github.com/a/b" },
        { url: "https://github.com/A/B.git/" },
        { url: "https://github.com/a/c", ref: "x" },
      ],
    }),
    [
      { url: "https://github.com/a/b" },
      { url: "https://github.com/a/c", ref: "x" },
    ],
  );
  assert.throws(() => workspace.parseRepositories({ repositories: [null] }));
});

test("later messages, other modes and the browser's own folder never make a session folder", async () => {
  const { ctx, seen, restore } = await recordSends();
  try {
    const before = prepared.length;
    await call("send", codeSend({ conversationId: "conv-1" }));
    await call("send", { ...codeSend(), mode: "chat" });
    assert.equal(prepared.length, before);
    assert.equal(seen.at(-1).cwd, undefined);
    const own = await call("send", codeSend({ cwd: ctx.workspace }));
    assert.equal(own.ok, false);
    assert.equal(own.error!.code, "CLAUDEX_WEB_BAD_REQUEST");
  } finally {
    restore();
  }
});

test("a first message that fails leaves no folder behind", async () => {
  await call("snapshot");
  const ctx = dispatcher.context(user.id)!;
  const root = workspace.codeWorkspaceRoot(ctx.workspace);
  const before = fs.existsSync(root) ? fs.readdirSync(root) : [];
  // The real handler: the stand-in codex cannot start, so the send fails.
  const failed = await call("send", codeSend());
  assert.equal(failed.ok, false);
  const after = fs.existsSync(root) ? fs.readdirSync(root) : [];
  assert.deepEqual(after, before);
});

test("the snapshot tells the web app about the environment and the modes", async () => {
  const snapshot = (await call("snapshot")).value as any;
  // This dispatcher's runtime has no host of its own: the web default.
  assert.equal(snapshot.host.cloud, undefined);
  const net = parseNetConfig({}, "namespaces", []);
  const host = runnerHost({ modes: ["chat", "code"], network: net.policy });
  assert.equal(host.capabilities.cloudCode, true);
  assert.equal(host.capabilities.cloudCowork, false);
  assert.deepEqual(host.cloud, {
    environments: [
      { id: "default", name: "Default", network: "trusted", isDefault: true },
    ],
    // Bypass too: every session runs in its own sandbox.
    permissionModes: ["auto", "manual", "acceptEdits", "plan", "bypass"],
  });
  // No Code, no environment; and the web app keeps what the runner says.
  const chatOnly = runnerHost({ modes: ["chat"], network: net.policy });
  assert.equal(chatOnly.cloud, undefined);
  assert.equal(chatOnly.capabilities.cloudCode, false);
  assert.deepEqual(resolveHost("web", host).cloud, host.cloud);
  assert.equal(resolveHost("desktop", host).cloud, undefined);
});

test("parseRepository keeps a plain address and drops nothing else in", () => {
  assert.equal(workspace.parseRepository(undefined), undefined);
  assert.deepEqual(
    workspace.parseRepository({ url: "https://github.com/a/b" }),
    { url: "https://github.com/a/b" },
  );
  assert.throws(() => workspace.parseRepository({ url: 5 }));
  assert.throws(() => workspace.parseRepository([]));
  assert.equal(workspace.inCodeWorkspace("/w", "/w/code/abc/repo/src"), true);
  assert.equal(workspace.inCodeWorkspace("/w", "/w/code"), false);
  assert.equal(workspace.inCodeWorkspace("/w", "/w/codex/x"), false);
});

test("a new Chat or Cowork conversation gets a space; sessions of one repository share one", async () => {
  const { seen, restore } = await recordSends();
  try {
    await call("send", codeSend({ mode: "chat" }));
    await call("send", codeSend({ mode: "cowork" }));
    const url = "https://github.com/acme/tool.git";
    await call("send", codeSend({ repository: { url } }));
    await call(
      "send",
      codeSend({ repository: { url: "https://github.com/ACME/tool/" } }),
    );
    const [chat, cowork, first, second] = seen.map(
      (input) => input.environment,
    );
    assert.match(chat.spaceId, /^c-/);
    assert.match(cowork.spaceId, /^c-/);
    assert.notEqual(chat.spaceId, cowork.spaceId);
    assert.equal(
      seen[0].cwd,
      undefined,
      "Chat runs in its space's own workspace",
    );
    assert.match(first.spaceId, /^r-[0-9a-f]{24}$/);
    assert.equal(first.spaceId, second.spaceId, "one repository, one space");
    assert.notEqual(seen[2].cwd, seen[3].cwd, "each session its own folder");
    // A later message keeps its conversation's space (none is set again).
    await call("send", codeSend({ mode: "chat", conversationId: "conv-1" }));
    assert.equal(seen.at(-1).environment, undefined);
  } finally {
    restore();
  }
});

/** Like recordSends, keeping every argument the handler gets. */
async function recordSendArgs() {
  await call("snapshot");
  const ctx = dispatcher.context(user.id)!;
  const seen: any[][] = [];
  const original = ctx.handlers.get("send")!;
  ctx.handlers.set("send", async (...args: any[]) => {
    seen.push(args);
    return { id: "conv-1", cwd: args[0].cwd };
  });
  // The runner's own clone instead of the test's prepareWorkspace hook.
  const runtime = (ctx as any).runtime;
  const hook = runtime.prepareWorkspace;
  runtime.prepareWorkspace = undefined;
  return {
    ctx,
    seen,
    restore: () => {
      ctx.handlers.set("send", original);
      runtime.prepareWorkspace = hook;
    },
  };
}

/** A session folder in a repository's space. */
function repositoryFolder(ctx: any, url: string) {
  const root = workspace.codeWorkspaceRoot(
    path.join(ctx.spaceRoot(repositorySpaceId(url)), "workspace"),
  );
  const cwd = path.join(root, randomUUID());
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}

test("a new session with a repository opens before the clone: the engine gets the fetch as its setup", async () => {
  const { seen, restore } = await recordSendArgs();
  try {
    const url = "https://github.com/acme/tool.git";
    const before = prepared.length;
    const sent = await call(
      "send",
      codeSend({ repository: { url, ref: "main" } }),
    );
    assert.equal(sent.ok, true, sent.error?.message);
    // Nothing was cloned yet: the folder is there, empty, and the clone
    // waits in the setup the handler gets as its second argument.
    const [input, extra] = seen.at(-1)!;
    assert.equal(prepared.length, before, "the test hook is not used");
    assert.deepEqual(fs.readdirSync(input.cwd), []);
    assert.deepEqual(extra.setup.repositories, [{ url, ref: "main" }]);
    assert.equal(typeof extra.setup.fetch, "function");
    assert.equal("repository" in input, false);
    // Without a repository there is nothing to fetch.
    await call("send", codeSend());
    assert.equal(seen.at(-1)!.length, 1);
  } finally {
    restore();
  }
});

test("the browser can't hand the engine a setup, and a session whose start failed fetches again", async () => {
  const { ctx, seen, restore } = await recordSendArgs();
  try {
    await call("send", codeSend({ conversationId: "conv-1" }), {
      setup: { repositories: [{ url: "https://github.com/a/b" }] },
    });
    assert.equal(
      seen.at(-1)!.length,
      1,
      "a browser's second argument is dropped",
    );
    // A stored session whose clone failed (pendingSetup), in its folder.
    const url = "https://github.com/acme/tool.git";
    ctx.store.conversations.push({
      id: "conv-pending",
      title: "Pending",
      mode: "code",
      providerId: "sub2api",
      model: "gpt-5.5",
      cwd: repositoryFolder(ctx, url),
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      turns: [],
      pendingSetup: [{ url }],
    });
    await call("send", codeSend({ conversationId: "conv-pending" }));
    const [, extra] = seen.at(-1)!;
    assert.deepEqual(extra.setup.repositories, [{ url }]);
    assert.equal(typeof extra.setup.fetch, "function");
    // Outside a session folder nothing is fetched.
    ctx.store.conversations.at(-1)!.cwd = ctx.workspace;
    await call("send", codeSend({ conversationId: "conv-pending" }));
    assert.equal(seen.at(-1)!.length, 1);
  } finally {
    ctx.store.conversations = ctx.store.conversations.filter(
      (c) => c.id !== "conv-pending",
    );
    restore();
  }
});
