/**
 * WebAppContext through the dispatcher, end to end against the in-process
 * Claudex service mock (tests/sub2api-mock.ts) and an in-memory webstore:
 * two users side by side, the desktop IPC handlers they reach, what stays
 * per user, and what the web refuses.
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

// The provider service each engine and model read starts, as the runner
// ships it (built before useElectronShim makes the platform read "linux").
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-ctx-"));
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
const { previewDocumentMethod } = await import("../../runner/src/previews");

const users = [
  {
    id: 21,
    email: "ada@example.test",
    password: "ada-password-1",
    username: "Ada",
  },
  {
    id: 22,
    email: "bo@example.test",
    password: "bo-password-12",
    username: "Bo",
  },
];
const group = {
  id: 4,
  name: "claudex-pro",
  platform: "openai",
  subscription_type: "subscription",
  status: "active",
};

let mock: InstanceType<typeof MockSub2Api>;
let web: MemoryWebstore;
const tokens = new Map<number, string>();
const webDevice = new Map<number, string>();
const results = new Map<string, Extract<RunnerFrame, { t: "result" }>>();
const opened: { userId: number; url: string }[] = [];
const events: { userId: number; type: string }[] = [];
let dispatcher: InstanceType<typeof Dispatcher>;
let nextCall = 0;

before(async () => {
  mock = new MockSub2Api({
    users,
    userApiKeys: false,
    groups: [group],
    subscriptions: [
      {
        id: 77,
        group_id: 4,
        status: "active",
        expires_at: new Date(Date.now() + 30 * 86400_000).toISOString(),
      },
    ],
    models: { status: 200, body: { data: [{ id: "gpt-5.5" }] } },
  });
  await mock.start();
  for (const user of users) {
    const accounts = new RemoteAccounts(
      fs.mkdtempSync(path.join(os.tmpdir(), "runner-login-")),
      mock.url,
      fakeCipher,
    );
    const signIn = await accounts.login(user.email, user.password);
    if (signIn.kind !== "signedIn") throw new Error("sign-in");
    tokens.set(user.id, await signIn.session.authorized(async (t) => t));
    webDevice.set(user.id, randomUUID());
  }
  web = memoryWebstore();
  dispatcher = new Dispatcher({
    runtime: {
      serviceUrl: mock.url,
      stateDir,
      providerServiceScript: providerScript,
      version: "0.0.1",
      codexBinary: () => "/bin/false",
      log: () => {},
    },
    link: {
      send: (frame) => {
        if (frame.t === "result") results.set(frame.id, frame);
        return true;
      },
      // key.get: what W-KEY answers, here the service's own device
      // registration for the user's web device.
      request: async (op, userId, body) => {
        if (op !== "key.get") return web.request(op, userId, body);
        const deviceId = webDevice.get(userId)!;
        const registration = await requestJson(
          fetch,
          `${mock.url}/api/v1/claudex/devices`,
          {
            method: "POST",
            token: tokens.get(userId)!,
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
    publish: (userId, event) => events.push({ userId, type: event.type }),
    openUrl: (userId, url) => opened.push({ userId, url }),
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

async function call(userId: number, method: string, ...args: unknown[]) {
  const id = `c${++nextCall}`;
  await dispatcher.call({
    t: "call",
    id,
    user: {
      id: userId,
      accessToken: tokens.get(userId)!,
      tabId: "tab-00000001",
    },
    method,
    args,
    deadlineMs: 60_000,
  });
  const result = results.get(id)!;
  assert.ok(result, `no result for ${method}`);
  return result;
}
const value = async (userId: number, method: string, ...args: unknown[]) => {
  const result = await call(userId, method, ...args);
  assert.equal(result.ok, true, `${method}: ${result.error?.message}`);
  return result.value as any;
};

test("a user's snapshot: the plan's models, the web host, nothing local", async () => {
  const snapshot = await value(21, "snapshot");
  // A first visit takes the account's name, as a new desktop profile does.
  assert.equal(snapshot.settings.name, "Ada");
  assert.equal(snapshot.host.kind, "web");
  assert.equal(snapshot.host.capabilities.localFolders, false);
  assert.equal(snapshot.settings.providers.length, 1);
  assert.deepEqual(snapshot.settings.providers[0].models, ["gpt-5.5"]);
  // No provider address or key reaches the window.
  assert.equal(snapshot.settings.providers[0].baseUrl, "");
  assert.equal(snapshot.modelUnavailable, undefined);
  assert.equal(snapshot.engine.state, "stopped");
  assert.equal(dispatcher.users, 1);
  // The key never reaches webstore.
  const key = mock.keys.find((k) => k.user_id === 21)!.key;
  assert.ok(key);
  assert.equal(JSON.stringify(web.log).includes(key), false);
  const settingsDoc = JSON.stringify(web.users.get(21)!.settings);
  assert.equal(settingsDoc.includes(key), false);
});

test("settings are saved per user; servers and folders stay as the service set them", async () => {
  const snapshot = await value(22, "snapshot");
  const saved = await value(22, "saveSettings", {
    ...snapshot.settings,
    theme: "light",
    prAutoFix: true,
    mcpServers: { evil: { command: "/bin/sh", args: ["-c", "id"] } },
  });
  assert.equal(saved.theme, "light");
  assert.equal(saved.prAutoFix, true);
  assert.deepEqual(saved.mcpServers, {});
  await dispatcher.context(22)!.store.settled();
  assert.equal((web.users.get(22)!.settings as any).theme, "light");
  assert.notEqual((web.users.get(21)?.settings as any)?.theme, "light");
  assert.equal((web.users.get(22)!.settings as any).prAutoFix, true);
  assert.notEqual((web.users.get(21)?.settings as any)?.prAutoFix, true);
});

test("projects and conversations of one user are not the other's", async () => {
  await value(21, "saveProject", {
    id: "p-ada",
    name: "Ada's project",
    description: "",
    instructions: "",
    icon: "Beaker",
    color: "blue-deep",
    defaultModel: "model",
    defaultProviderId: "provider",
    defaultEffort: "medium",
    createdAt: 1,
  });
  const a = dispatcher.context(21)!;
  const b = dispatcher.context(22)!;
  assert.equal(a.store.projects[0].defaultEffort, "medium");
  assert.equal(a.store.projects[0].defaultModel, "model");
  assert.equal(a.store.projects[0].defaultProviderId, "provider");
  assert.equal(a.store.projects[0].icon, "Beaker");
  assert.equal(a.store.projects[0].color, "blue-deep");
  assert.notEqual(a.store, b.store);
  assert.notEqual(a.handlers, b.handlers);
  assert.notEqual(a.dataRoot, b.dataRoot);
  assert.deepEqual(
    (await value(22, "snapshot")).projects.map((p: any) => p.id),
    [],
  );
  await a.store.settled();
  assert.ok(web.users.get(21)!.projects.has("p-ada"));
  assert.equal(web.users.get(22)!.projects.size, 0);
});

test("folders, absent calls and closed modes are refused", async () => {
  const folder = await call(21, "saveProject", {
    id: "p2",
    name: "P2",
    description: "",
    instructions: "",
    cwd: "/etc",
    createdAt: 1,
  });
  assert.equal(folder.ok, false);
  assert.equal(folder.error!.code, "CLAUDEX_WEB_BAD_REQUEST");
  const absent = await call(21, "chooseFolder");
  assert.equal(absent.error!.message, "Not available on the web.");
  assert.equal(absent.error!.code, "CLAUDEX_WEB_METHOD_UNAVAILABLE");
  const code = await call(21, "send", {
    text: "hi",
    mode: "code",
    attachments: [],
    providerId: "sub2api",
    model: "gpt-5.5",
  });
  assert.equal(code.error!.message, "Code isn't available on the web yet.");
  const bad = await call(21, "updateConversation", 42, {});
  assert.equal(bad.error!.message, "The request was not valid.");
});

test("an uploaded file becomes an attachment in the user's own folder", async () => {
  web.files.set("up-1", {
    userId: 21,
    bytes: new TextEncoder().encode("hello"),
  });
  const attachment = await value(21, "addAttachmentData", "notes.txt", {
    $upload: "up-1",
  });
  const ctx = dispatcher.context(21)!;
  assert.equal(attachment.name, "notes.txt");
  // The browser does not learn where the runner keeps the file.
  assert.equal(attachment.path, "");
  const stored = ctx.selectedAttachments.get(attachment.id)!;
  assert.ok(
    stored.path.startsWith(path.join(ctx.dataRoot, "profile", "attachments")),
  );
  assert.equal(fs.readFileSync(stored.path, "utf8"), "hello");
  assert.equal(
    dispatcher.context(22)!.selectedAttachments.has(attachment.id),
    false,
  );
  // Another user's upload is not theirs to read.
  const stolen = await call(22, "addAttachmentData", "x.txt", {
    $upload: "up-1",
  });
  assert.equal(stolen.ok, false);
});

test("previews are served per user through previewDocument", async () => {
  const url = await value(21, "createArtifactPreview", "<p>hi</p>");
  assert.match(url, /^\/api\/v1\/claudex\/web\/preview\/21\.[0-9a-f-]{36}$/);
  const id = url.split("/").pop();
  const doc = await value(21, previewDocumentMethod, id);
  assert.equal(doc.content, "<p>hi</p>");
  assert.match(doc.csp, /sandbox allow-scripts/);
  const other = await call(22, previewDocumentMethod, id);
  assert.equal(other.ok, false);
  await value(21, "releaseArtifactPreview", url);
  assert.equal((await call(21, previewDocumentMethod, id)).ok, false);
});

test("a connector keeps its tools' approval modes, and only those", async () => {
  await value(21, "snapshot");
  const ctx = dispatcher.context(21)!;
  const approve = { create_issue: { approval_mode: "approve" } };
  ctx.mcpConfig.update({
    docs: {
      url: "https://docs.example.test/mcp",
      tools: approve,
      command: "/bin/sh",
    },
  });
  // Only the web's own keys survive: the table, never a command.
  assert.deepEqual(ctx.store.settings.mcpServers.docs, {
    url: "https://docs.example.test/mcp",
    tools: approve,
  });
  assert.throws(
    () =>
      ctx.mcpConfig.update({
        docs: {
          url: "https://docs.example.test/mcp",
          tools: { create_issue: { approval_mode: "approve", command: "x" } },
        },
      }),
    /tool permissions are not valid/,
  );
  assert.throws(
    () =>
      ctx.mcpConfig.update({
        docs: {
          url: "https://docs.example.test/mcp",
          tools: { create_issue: { approval_mode: "writes" } },
        },
      }),
    /tool permissions are not valid/,
  );
  // Nothing changed by the refusals.
  assert.deepEqual(ctx.store.settings.mcpServers.docs, {
    url: "https://docs.example.test/mcp",
    tools: approve,
  });
  ctx.mcpConfig.update({});
});

test("a signed-out user's context closes and its data is written", async () => {
  const ctx = dispatcher.context(22)!;
  await dispatcher.signedOut({
    t: "user-signed-out",
    userId: 22,
    reason: "revoked",
  });
  assert.equal(ctx.closed, true);
  assert.equal(dispatcher.context(22), undefined);
  // A new call (after signing in again) opens a fresh context from webstore.
  const snapshot = await value(22, "snapshot");
  assert.equal(snapshot.settings.theme, "light");
  assert.equal(snapshot.settings.prAutoFix, true);
  assert.notEqual(dispatcher.context(22), ctx);
});
