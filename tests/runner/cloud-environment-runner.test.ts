import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useElectronShim } from "./runner-core-support.test.ts";
import { CloudEnvironments } from "../../electron/cloud/environments";
import { initialCloudEnvironment } from "../../shared/cloud-environments-api";
import { isSetupHook } from "../../shared/session-setup";

useElectronShim();
const { Dispatcher } = await import("../../runner/src/dispatcher");
const { WebAppContext } = await import("../../runner/src/web-app-context");
const { repositorySpaceId } = await import("../../runner/src/github-workspace");
const { startScheduler } =
  await import("../../runner/src/web-context-activate");
const { openPolicy } = await import("../../shared/client-policy");

test("a hosted routine stages all saved repositories and enables only its chosen connectors", async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-routine-options-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repos = ["one", "two"].map((name) => ({
    url: `https://github.com/test/${name}`,
  }));
  const servers = {
    reports: { url: "https://reports.example.test/mcp" },
    other: { url: "https://other.example.test/mcp" },
  };
  let staged: unknown;
  let input: unknown;
  const context = {
    userId: 1,
    runtime: { host: { capabilities: { cloudCode: true } } },
    store: {
      root,
      settings: {
        providers: [{ id: "p", model: "m" }],
        activeProviderId: "p",
        mcpServers: servers,
      },
    },
    engine: {
      send: async (value: unknown) => {
        input = value;
        return { id: "run", turns: [{ status: "completed", items: [] }] };
      },
    },
    spaceRoot: (spaceId: string) => path.join(root, "spaces", spaceId),
    stageCodeSession: async (
      _id: string,
      repo: unknown,
      spaceId: string,
      more: unknown[],
    ) => {
      staged = [repo, ...more];
      return { cwd: path.join(root, "spaces", spaceId), fetch: async () => {} };
    },
    busy: () => false,
    policy: () => openPolicy,
    officialSessionIdentity: () => root,
    push() {},
    log() {},
  } as unknown as import("../../runner/src/web-app-context").WebAppContext;
  startScheduler.call(context, root);
  t.after(() => context.scheduler?.stop());
  const task = context.scheduler!.save({
    name: "Test routine",
    prompt: "Review both repositories",
    mode: "code",
    model: "m",
    providerId: "p",
    frequency: "daily",
    nextRunAt: Date.now(),
    enabled: true,
    repeat: { kind: "manual" },
    executionLocation: "remote",
    repositories: repos,
    notifyOnCompletion: { push: false, email: false, slack: false },
    codeConnectorSelections: [{ key: "reports", url: servers.reports.url }],
  });
  await context.scheduler!.runNow(task.id);
  assert.deepEqual(staged, repos);
  assert.deepEqual(
    (input as { connectorOverrides: unknown }).connectorOverrides,
    { other: false },
  );
  context.store.settings.mcpServers.reports = {
    url: "https://replacement.example.test/mcp",
  };
  assert.deepEqual(context.scheduler!.list()[0].repositories, repos);
  await assert.rejects(
    context.scheduler!.runNow(task.id),
    /selected for this task is unavailable/,
  );
});

test("the runner resolves a saved profile, isolates its version, and hands variables and setup to its sandbox", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-environment-runner-"),
  );
  try {
    const profiles = new CloudEnvironments(root);
    const { id, updatedAt, ...input } = initialCloudEnvironment;
    const saved = profiles.save({
      ...input,
      name: "CI",
      variables: "NODE_ENV=test",
      setupScript: "npm ci",
      network: "none",
    });
    const repository = { url: "https://github.com/acme/tool" };
    let sandboxProfile: unknown;
    let preparedRepository: unknown;
    const context = {
      userId: 1,
      store: { root },
      runtime: {
        codexBinary: (input: any) => {
          sandboxProfile = input.cloudEnvironment;
          return "sandbox-codex";
        },
      },
      spaceRoot: (spaceId: string) => path.join(root, "spaces", spaceId),
      stageCodeSession: async (
        sessionId: string,
        repo: unknown,
        spaceId: string,
      ) => {
        preparedRepository = repo;
        return {
          cwd: path.join(root, "spaces", spaceId, "workspace", sessionId),
          fetch: async () => {},
        };
      },
    };
    const dispatcher = Object.create(Dispatcher.prototype) as any;
    const [[send, extra]] = await dispatcher.newSession(context, "send", [
      { mode: "code", repository, cloudEnvironmentId: saved.id },
    ]);
    assert.deepEqual(preparedRepository, repository);
    assert.equal(send.cloudEnvironmentId, saved.id);
    assert.notEqual(
      send.environment.spaceId,
      repositorySpaceId(repository.url),
    );
    assert.ok(isSetupHook(extra.setup));
    assert.equal(extra.setup.setupScript, "npm ci");
    const snapshot = path.join(
      context.spaceRoot(send.environment.spaceId),
      "cloud-environment.json",
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(snapshot, "utf8")), saved);
    profiles.save({
      ...input,
      id: saved.id,
      name: "Edited",
      variables: "NODE_ENV=production",
    });
    const sandbox = WebAppContext.prototype.spaceSandbox.call(
      context as any,
      send.environment.spaceId,
    );
    assert.deepEqual(sandbox.environmentVariables, { NODE_ENV: "test" });
    assert.deepEqual(sandboxProfile, saved);
    assert.equal(sandbox.binary, "sandbox-codex");
    const [[defaultSend]] = await dispatcher.newSession(context, "send", [
      { mode: "code", repository },
    ]);
    assert.equal(
      defaultSend.environment.spaceId,
      repositorySpaceId(repository.url),
    );
    await assert.rejects(
      dispatcher.newSession(context, "send", [
        { mode: "code", cloudEnvironmentId: "../../escape" },
      ]),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed setup script is resumed even after its repository was cloned successfully", async () => {
  const dispatcher = Object.create(Dispatcher.prototype) as any;
  const context = {
    store: {
      conversation: () => ({
        mode: "code",
        cwd: "/workspace/session",
        pendingSetupScript: "npm ci",
      }),
    },
  };
  const extra = dispatcher.resumedSetup(context, "session");
  assert.ok(isSetupHook(extra[0].setup));
  assert.deepEqual(extra[0].setup.repositories, []);
  assert.equal(extra[0].setup.setupScript, "npm ci");
  await extra[0].setup.fetch(new AbortController().signal);
});
