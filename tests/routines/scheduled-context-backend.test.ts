import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../electron/store/store";
import { Scheduler } from "../../electron/routines/scheduler";
import { registerCollectionHandlers } from "../../electron/ipc/collections";
import { CloudRoutines } from "../../electron/cloud/cloud-routines";
import type { AppContext } from "../../electron/app/app-context";
import type { CloudCalls } from "../../electron/cloud/cloud-router";
import type { EnvironmentRef, Project } from "../../shared/types";
import type {
  Routine,
  RoutineCapabilities,
  RoutineInput,
  RoutineListResult,
} from "../../shared/routines";
import { openPolicy } from "../../shared/client-policy";

function backend(
  t: TestContext,
  sources: ("chat" | "code")[] = ["chat", "code"],
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-b30-context-"));
  const store = new Store(root);
  store.settings.providers[0].model = "owner-default-model";
  const options = {
    isBusy: () => false,
    run: async () => {
      throw new Error("These persistence tests never execute a task.");
    },
    policy: () => openPolicy,
  };
  let scheduler = new Scheduler(path.join(root, "scheduler"), options);
  const checked: { cwd?: string; environment?: EnvironmentRef }[] = [];
  const ctx = {
    store,
    get scheduler() {
      return scheduler;
    },
    dataRoot: root,
    services: {},
    engine: { approvals: [] },
    routineSources: () => sources,
    policy: () => openPolicy,
    allowedFolder(cwd?: string, environment?: EnvironmentRef) {
      checked.push({ cwd, environment: environment && { ...environment } });
      if (cwd?.startsWith("/Users/private-local"))
        throw new Error("This account does not own that local folder.");
    },
    onAccountActivated() {},
    onAccountDeactivating() {},
    onSettingsChanged: () => () => {},
  } as unknown as AppContext;
  const handlers = new Map<string, (...args: any[]) => any>();
  registerCollectionHandlers(
    (name, handler) => handlers.set(name, handler),
    ctx,
  );
  t.after(() => {
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    checked,
    handlers,
    save: (input: RoutineInput): Routine =>
      handlers.get("saveSchedule")!(input),
    list: (): Routine[] => handlers.get("listSchedules")!(),
    capabilities: (): Promise<RoutineCapabilities> =>
      handlers.get("routineCapabilities")!(),
    restart() {
      scheduler = new Scheduler(path.join(root, "scheduler"), options);
    },
  };
}
const input = (patch: Partial<RoutineInput> = {}): RoutineInput => ({
  name: "Review notes",
  prompt: "Review the project notes",
  mode: "code",
  providerId: "default",
  model: "explicit-model",
  enabled: false,
  frequency: "daily",
  repeat: { kind: "daily", time: "09:00" },
  nextRunAt: Date.now() + 86_400_000,
  ...patch,
});
const project = (id: string, patch: Partial<Project> = {}): Project => ({
  id,
  name: id,
  description: "",
  instructions: "",
  createdAt: 1,
  kind: "code",
  ...patch,
});

function connect(
  local: ReturnType<typeof backend>,
  remote: ReturnType<typeof backend>,
) {
  const received: { method: string; args: unknown[] }[] = [];
  const client = {
    async call(method: string, args: unknown[] = []) {
      received.push({ method, args: structuredClone(args) });
      const handler = remote.handlers.get(method);
      assert.ok(handler, `registered remote handler ${method}`);
      return handler(...args);
    },
  } as unknown as CloudCalls;
  const cloud = new CloudRoutines(() => client);
  const route = (name: string) =>
    cloud.route(name, (...args: unknown[]) =>
      local.handlers.get(name)!(...args),
    )!;
  route("listSchedules");
  return { received, route };
}

test("CloudRoutines forwards the owned project but strips the caller's local path/environment before the real remote save handler", async (t) => {
  const local = backend(t),
    remote = backend(t);
  remote.store.projects = [
    project("remote-project", {
      cwd: "/sandbox/owned-project",
      environment: { kind: "space", spaceId: "owned-space" },
    }),
  ];
  const { received, route } = connect(local, remote);
  const save = route("saveSchedule");
  const saved: Routine = await save(
    input({
      executionLocation: "remote",
      projectId: "remote-project",
      defaultModel: true,
      cwd: "/Users/private-local/notes",
      environment: { kind: "ssh", hostId: "private-local-host" },
      description: "Remote project summary",
      alwaysAllowed: [{ kind: "tool", tool: "private-tool" }],
    }),
  );
  const forwarded = received.find((call) => call.method === "saveSchedule")!
    .args[0] as RoutineInput;
  assert.equal(forwarded.projectId, "remote-project");
  assert.equal(Object.hasOwn(forwarded, "cwd"), false);
  assert.equal(Object.hasOwn(forwarded, "environment"), false);
  assert.deepEqual(forwarded.alwaysAllowed, []);
  assert.equal(JSON.stringify(received).includes("private-local"), false);
  assert.equal(
    local.checked.length,
    0,
    "local handler never validates or saves a remote-owned task",
  );
  assert.equal(local.list().length, 0);
  assert.deepEqual(remote.checked, [
    {
      cwd: "/sandbox/owned-project",
      environment: { kind: "space", spaceId: "owned-space" },
    },
  ]);
  assert.equal(saved.projectId, "remote-project");
  assert.equal(saved.cwd, "/sandbox/owned-project");
  assert.deepEqual(saved.environment, {
    kind: "space",
    spaceId: "owned-space",
  });
  assert.equal(saved.model, "owner-default-model");
  assert.equal(saved.description, "Remote project summary");
  remote.restart();
  assert.equal(remote.list()[0].id, saved.id);
  assert.equal(remote.list()[0].projectId, "remote-project");
  assert.deepEqual(remote.list()[0].environment, saved.environment);
});

test("remote project lookup is authoritative and rejects a project known only to the calling computer", async (t) => {
  const local = backend(t),
    remote = backend(t);
  local.store.projects = [
    project("local-only-project", { cwd: "/Users/private-local/repo" }),
  ];
  const { received, route } = connect(local, remote);
  await assert.rejects(
    route("saveSchedule")(
      input({
        executionLocation: "remote",
        projectId: "local-only-project",
        cwd: "/Users/private-local/repo",
        environment: { kind: "local" },
      }),
    ),
    /project is no longer available/,
  );
  const forwarded = received.find((call) => call.method === "saveSchedule")!
    .args[0] as RoutineInput;
  assert.equal(
    forwarded.projectId,
    "local-only-project",
    "the receiver must validate the project instead of silently unlinking it",
  );
  assert.equal(forwarded.cwd, undefined);
  assert.equal(forwarded.environment, undefined);
  assert.equal(
    remote.checked.length,
    0,
    "ownership refusal precedes folder authorization",
  );
  assert.equal(remote.list().length, 0);
  assert.equal(local.list().length, 0);
});

test("Collection save resolves Default against current owner settings while explicit models remain explicit", (t) => {
  const owner = backend(t);
  const created = owner.save(
    input({
      defaultModel: true,
      providerId: "outdated-provider",
      model: "outdated-model",
    }),
  );
  assert.equal(created.providerId, "default");
  assert.equal(created.model, "owner-default-model");
  owner.store.settings.providers.push({
    id: "next-provider",
    name: "New default",
    baseUrl: "https://example.invalid/v1",
    protocol: "responses",
    model: "new-default-model",
    models: [],
  });
  owner.store.settings.activeProviderId = "next-provider";
  const edited = owner.save({ ...created, prompt: "Updated instructions" });
  assert.equal(edited.providerId, "next-provider");
  assert.equal(edited.model, "new-default-model");
  const explicit = owner.save(
    input({
      name: "Explicit choice",
      defaultModel: false,
      model: "kept-explicit-model",
    }),
  );
  assert.equal(explicit.providerId, "default");
  assert.equal(explicit.model, "kept-explicit-model");
  assert.throws(
    () =>
      owner.save(
        input({ name: "Missing provider", providerId: "foreign-provider" }),
      ),
    /existing model provider/,
  );
  owner.restart();
  assert.equal(
    owner.list().find((task) => task.id === edited.id)?.model,
    "new-default-model",
  );
  assert.equal(
    owner.list().find((task) => task.id === explicit.id)?.model,
    "kept-explicit-model",
  );
});

test("Collection save validates active project ownership and matching Space before authorizing folders, then persists description and SSH identity", (t) => {
  const owner = backend(t);
  owner.store.projects = [
    project("ssh-project", {
      cwd: "/srv/team-repo",
      environment: { kind: "ssh", hostId: "team-build" },
    }),
    project("space-project", {
      cwd: "/sandbox/project",
      environment: { kind: "space", spaceId: "team-space" },
    }),
    project("archived-project", { archivedAt: Date.now() }),
  ];
  for (const patch of [
    { projectId: "foreign-project" },
    { projectId: "archived-project" },
    { environment: { kind: "space", spaceId: "team-space" } },
    {
      projectId: "space-project",
      environment: { kind: "space", spaceId: "foreign-space" },
    },
  ] as Partial<RoutineInput>[]) {
    const checkedBefore = owner.checked.length;
    assert.throws(() => owner.save(input(patch)));
    assert.equal(
      owner.checked.length,
      checkedBefore,
      "refused project/Space never reaches folder authorization",
    );
    assert.equal(owner.list().length, 0);
  }
  const ssh = owner.save(
    input({ projectId: "ssh-project", description: "Summary to clear" }),
  );
  assert.deepEqual(owner.checked.at(-1), {
    cwd: "/srv/team-repo",
    environment: { kind: "ssh", hostId: "team-build" },
  });
  assert.equal(ssh.projectId, "ssh-project");
  assert.equal(ssh.cwd, "/srv/team-repo");
  assert.deepEqual(ssh.environment, { kind: "ssh", hostId: "team-build" });
  const cleared = owner.save({ ...ssh, description: "" });
  owner.restart();
  const restored = owner.list().find((task) => task.id === cleared.id)!;
  assert.equal(Object.hasOwn(restored, "description"), true);
  assert.equal(restored.description, "");
  assert.deepEqual(restored.environment, ssh.environment);
  assert.equal(restored.projectId, "ssh-project");
  const space = owner.save(
    input({ name: "Owned Space", projectId: "space-project" }),
  );
  assert.deepEqual(space.environment, { kind: "space", spaceId: "team-space" });
  assert.deepEqual(owner.checked.at(-1), {
    cwd: "/sandbox/project",
    environment: { kind: "space", spaceId: "team-space" },
  });
});

test("real backend capability statuses merge without duplication and remain scoped for explicit local/remote requests", async (t) => {
  const local = backend(t, ["chat"]),
    remote = backend(t, ["code"]);
  const { route } = connect(local, remote);
  const capabilities = route("routineCapabilities");
  const combined: RoutineCapabilities = await capabilities();
  assert.deepEqual(combined.sources, ["chat", "code"]);
  assert.deepEqual(combined.statuses, [
    "active",
    "paused",
    "on-hold",
    "auto-disabled",
  ]);
  assert.deepEqual((await capabilities("local")).sources, ["chat"]);
  assert.deepEqual((await capabilities("local")).statuses, [
    "active",
    "paused",
    "on-hold",
  ]);
  assert.deepEqual((await capabilities("remote")).sources, ["code"]);
  assert.deepEqual((await capabilities("remote")).statuses, [
    "active",
    "paused",
    "auto-disabled",
    "on-hold",
  ]);
});

test("per-source read outcomes survive a partial local failure while remote rows retain their actual owner", async (t) => {
  const local = backend(t, ["chat"]),
    remote = backend(t, ["code"]);
  const kept = remote.save(input({ name: "Remote retained task" }));
  const { route } = connect(local, remote);
  local.handlers.set("querySchedules", () => {
    throw new Error("local scheduler temporarily unavailable");
  });
  const value: RoutineListResult = await route("querySchedules")();
  assert.deepEqual(
    value.sources.map(({ source, status }) => ({ source, status })),
    [
      { source: "local", status: "error" },
      { source: "remote", status: "ready" },
    ],
  );
  assert.equal(value.tasks.length, 1);
  assert.equal(value.tasks[0].id, kept.id);
  assert.equal(value.tasks[0].executionLocation, "remote");
  assert.equal(value.tasks[0].listMetadata?.provenance?.backend, "remote");
  assert.equal(value.tasks[0].listMetadata?.device, undefined);
});
