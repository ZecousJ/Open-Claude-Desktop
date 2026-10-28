import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { act, createElement as h } from "react";
import { Store } from "../../electron/store/store";
import { Scheduler } from "../../electron/routines/scheduler";
import { registerCollectionHandlers } from "../../electron/ipc/collections";
import { coworkFolderGrants } from "../../electron/workspace/cowork-folders";
import type { AppContext as Backend } from "../../electron/app/app-context";
import { openPolicy } from "../../shared/client-policy";
import { desktopHost } from "../../shared/host";
import type { Project } from "../../shared/types";
import type { Routine, RoutineInput } from "../../shared/routines";
import {
  routineWorkspaceMessages as messages,
  type RoutineWorkspaceDiagnostics,
} from "../../shared/routine-workspace";
import { HostContext } from "../../src/host/HostContext";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { RoutineDetailResources } from "../../src/collections/routines/RoutineDetailResources";
import { RoutineSettings } from "../../src/collections/routines/RoutineSettings";
import { newDraft } from "../../src/collections/routines/routine-draft";
import { routineDom } from "../support/routine-dom";

function backend(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-b31-workspace-"));
  const store = new Store(root);
  const scheduler = new Scheduler(root, {
    isBusy: () => false,
    run: async () => {
      throw Error("Never execute a test task");
    },
    policy: () => openPolicy,
  });
  const ctx = {
    store,
    scheduler,
    dataRoot: root,
    services: {},
    engine: { approvals: [] },
    routineSources: () => ["chat", "code"],
    policy: () => openPolicy,
    allowedFolder() {},
    onAccountActivated() {},
    onAccountDeactivating() {},
    onSettingsChanged: () => () => {},
  } as unknown as Backend;
  const handlers = new Map<string, (...args: any[]) => any>();
  registerCollectionHandlers((name, fn) => handlers.set(name, fn), ctx);
  t.after(() => {
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const save = (patch: Partial<RoutineInput> = {}) =>
    handlers.get("saveSchedule")!({
      name: "Workspace check",
      prompt: "Inspect notes",
      mode: "cowork",
      providerId: "default",
      model: "Opus",
      enabled: false,
      frequency: "daily",
      nextRunAt: Date.now() + 86400000,
      ...patch,
    }) as Routine;
  return {
    root,
    store,
    ctx,
    save,
    read: async (id: string) =>
      (await handlers.get("routineWorkspace")!(
        id,
      )) as RoutineWorkspaceDiagnostics,
  };
}

test("20: registered handler reads only the saved task, detects missing folders and acknowledges the actual routine grant", async (t) => {
  const b = backend(t),
    folder = path.join(b.root, "selected");
  fs.mkdirSync(folder);
  const task = b.save({ cwd: folder });
  assert.equal((await b.read(task.id)).folders[0].state, "permission-required");
  coworkFolderGrants(b.root).grantRoutine(task.id, folder);
  assert.equal((await b.read(task.id)).folders[0].state, "ready");
  fs.rmSync(folder, { recursive: true });
  assert.deepEqual((await b.read(task.id)).folders[0], {
    path: folder,
    state: "missing",
    message: messages.missing,
  });
  await assert.rejects(b.read("another-account-task"), /no longer exists/);
});

test("20: project folder diagnostics preserve malformed selection evidence instead of truncating it away", async (t) => {
  const b = backend(t),
    folder = path.join(b.root, "selected");
  fs.mkdirSync(folder);
  const extra = Array.from({ length: 17 }, (_, i) =>
    path.join(b.root, `folder-${i}`),
  );
  b.store.projects = [
    {
      id: "project",
      name: "Own project",
      description: "",
      instructions: "",
      kind: "local",
      cwd: folder,
      additionalFolders: [folder, ...extra],
      createdAt: 1,
      updatedAt: 1,
    } as Project,
  ];
  const task = b.save({ cwd: folder, projectId: "project" });
  assert.deepEqual((await b.read(task.id)).problems, ["too-many", "duplicate"]);
  assert.equal((await b.read(task.id)).folders.length, 18);
});

test("20: an SSH path is not probed on this computer even when an identically named local directory exists", async (t) => {
  const b = backend(t),
    folder = path.join(b.root, "selected");
  fs.mkdirSync(folder);
  const task = b.save({
    mode: "code",
    cwd: folder,
    environment: { kind: "ssh", hostId: "host-a" },
  });
  const original = fs.realpathSync;
  let probes = 0;
  fs.realpathSync = ((value: any, ...args: any[]) => {
    if (value === folder) probes++;
    return (original as any)(value, ...args);
  }) as typeof fs.realpathSync;
  try {
    const result = await b.read(task.id);
    assert.equal(result.host, "ssh");
    assert.equal(result.folders[0].state, "not-checked");
    assert.equal(probes, 0);
  } finally {
    fs.realpathSync = original;
  }
});

test("20: Space diagnostics reject lexical and symlink escapes without inspecting another execution host", async (t) => {
  const b = backend(t),
    spaceId = "space-owned",
    root = path.join(b.root, "spaces", spaceId, "workspace");
  fs.mkdirSync(root, { recursive: true });
  const outside = path.join(b.root, "outside");
  fs.mkdirSync(outside);
  const link = path.join(root, "escape");
  fs.symlinkSync(outside, link, "dir");
  b.store.projects = [
    {
      id: "space-project",
      name: "Owned space",
      description: "",
      instructions: "",
      kind: "code",
      environment: { kind: "space", spaceId },
      createdAt: 1,
      updatedAt: 1,
    } as Project,
  ];
  for (const cwd of [outside, link]) {
    const task = b.save({
      name: `Task ${path.basename(cwd)}`,
      mode: "code",
      cwd,
      projectId: "space-project",
      environment: { kind: "space", spaceId },
    });
    const result = await b.read(task.id);
    assert.deepEqual(result.problems, ["unsupported"]);
    assert.equal(result.folders[0].state, "unavailable");
  }
});

test("20: real directory-check script is batched only on the selected ready SSH transport and quotes shell metacharacters", async (t) => {
  const b = backend(t),
    folder = path.join(b.root, "quote's $(touch marker)");
  fs.mkdirSync(folder);
  const missing = path.join(b.root, "missing");
  let calls = 0;
  const connection = {
    status: { state: "ready" },
    exec: async (script: string) => {
      calls++;
      return {
        code: 0,
        stdout: execFileSync("sh", ["-c", script], {
          encoding: "utf8",
          cwd: b.root,
        }),
      };
    },
  };
  b.ctx.services.ssh = {
    allowed: () => true,
    hosts: { get: () => ({ id: "host-a" }) },
    existing: () => connection,
  } as unknown as NonNullable<typeof b.ctx.services.ssh>;
  b.store.projects = [
    {
      id: "remote-project",
      kind: "local",
      name: "Host project",
      description: "",
      instructions: "",
      cwd: folder,
      additionalFolders: [missing],
      environment: { kind: "ssh", hostId: "host-a" },
      createdAt: 1,
      updatedAt: 1,
    } as Project,
  ];
  const task = b.save({
    cwd: folder,
    projectId: "remote-project",
    environment: { kind: "ssh", hostId: "host-a" },
  });
  const result = await b.read(task.id);
  assert.deepEqual(
    result.folders.map((row) => row.state),
    ["ready", "missing"],
  );
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(path.join(b.root, "marker")), false);
});

test("20: opening an offline task does not connect automatically and only advertises an explicit reconnect", async (t) => {
  const b = backend(t);
  let calls = 0;
  b.ctx.services.ssh = {
    allowed: () => true,
    hosts: { get: () => ({ id: "host-a" }) },
    existing: () => undefined,
    connect: async () => {
      calls++;
    },
  } as unknown as NonNullable<typeof b.ctx.services.ssh>;
  const task = b.save({
    cwd: "/remote/notes",
    mode: "code",
    environment: { kind: "ssh", hostId: "host-a" },
  });
  assert.equal((await b.read(task.id)).canReconnect, true);
  assert.equal(calls, 0);
});

function controller() {
  const app = {
    accountId: "owner",
    controllerScope: {},
    page: "scheduled",
    snapshot: { projects: [] },
    currentController: { current: undefined },
  } as unknown as AppController;
  app.currentController!.current = app;
  return app;
}
const routine: Routine = {
  id: "task",
  name: "Task",
  prompt: "Notes",
  mode: "cowork",
  cwd: "/selected",
  providerId: "default",
  model: "Opus",
  frequency: "daily",
  enabled: false,
  nextRunAt: 1,
  createdAt: 1,
  updatedAt: 1,
  executionLocation: "local",
};
const wrap = (app: AppController, child: ReturnType<typeof h>) =>
  h(
    HostContext.Provider,
    { value: desktopHost },
    h(AppContext.Provider, { value: app }, child),
  );

test("20: mounted offline-host recovery reconnects only the saved host and rereads its actual folder state", async () => {
  let connected = false,
    calls = 0;
  const saved = {
    ...routine,
    mode: "code" as const,
    environment: { kind: "ssh" as const, hostId: "host-a" },
  };
  const env = await routineDom({
    routineWorkspace: async () => ({
      taskId: saved.id,
      host: "ssh",
      canReconnect: !connected,
      problems: [],
      folders: [
        { path: saved.cwd!, state: connected ? "ready" : "not-checked" },
      ],
    }),
    sshConnect: async (id) => {
      assert.equal(id, "host-a");
      calls++;
      connected = true;
      return { state: "ready" } as Awaited<
        ReturnType<Window["desktop"]["sshConnect"]>
      >;
    },
  });
  try {
    await env.render(
      wrap(
        controller(),
        h(RoutineDetailResources, { routine: saved, disabled: false }),
      ),
    );
    const button = [...env.document.querySelectorAll("button")].find(
      (node) => node.textContent === "Reconnect",
    )!;
    assert.ok(button);
    await env.event(button, "click");
    assert.equal(calls, 1);
    assert.equal(
      [...env.document.querySelectorAll("button")].some(
        (node) => node.textContent === "Reconnect",
      ),
      false,
    );
  } finally {
    await env.clean();
  }
});

test("20: actual detail exposes the real missing-folder recovery and recovers a failed read with Retry", async () => {
  let fail = true,
    edits = 0;
  const env = await routineDom({
    routineWorkspace: async () => {
      if (fail) throw Error("temporary read failure");
      return {
        taskId: "task",
        host: "local",
        problems: [],
        folders: [
          { path: "/selected", state: "missing", message: messages.missing },
        ],
      };
    },
  });
  const app = controller();
  try {
    await env.render(
      wrap(
        app,
        h(RoutineDetailResources, {
          routine,
          disabled: false,
          onEdit: () => edits++,
        }),
      ),
    );
    assert.match(env.document.body.textContent!, /temporary read failure/);
    const retry = [...env.document.querySelectorAll("button")].find(
      (n) => n.textContent === "Retry",
    )!;
    fail = false;
    await env.event(retry, "click");
    assert.match(
      env.document.body.textContent!,
      /This folder no longer exists/,
    );
    const edit = [...env.document.querySelectorAll("button")].find(
      (n) => n.textContent === "Edit task",
    )!;
    await env.event(edit, "click");
    assert.equal(edits, 1);
  } finally {
    await env.clean();
  }
});

test("20: real permission diagnostics enable the existing routine-scoped grant even without a matching legacy lastError string", async () => {
  let granted = false,
    calls = 0;
  const env = await routineDom({
    routineWorkspace: async () => ({
      taskId: "task",
      host: "local",
      problems: [],
      folders: [
        {
          path: "/selected",
          state: granted ? "ready" : "permission-required",
          message: granted ? undefined : messages.permission,
        },
      ],
    }),
    grantCoworkFolder: async (folder, scope, target) => {
      assert.equal(folder, "/selected");
      assert.equal(scope, "session");
      assert.deepEqual(target, { routineId: "task" });
      calls++;
      granted = true;
      return { state: "ask", folder, name: "selected" };
    },
  });
  try {
    await env.render(
      wrap(
        controller(),
        h(RoutineDetailResources, { routine, disabled: false }),
      ),
    );
    await env.click('[aria-label="Allow /selected on this computer"]');
    assert.equal(calls, 1);
    assert.ok(
      env.document.querySelector(
        '[aria-label="Allowed for this task on this computer"]',
      ),
    );
    assert.doesNotMatch(
      env.document.body.textContent!,
      /This task needs permission/,
    );
  } finally {
    await env.clean();
  }
});

test("20: late folder diagnostics from the previous account cannot appear in its replacement", async () => {
  let resolve!: (value: RoutineWorkspaceDiagnostics) => void;
  const pending = new Promise<RoutineWorkspaceDiagnostics>(
    (done) => (resolve = done),
  );
  const env = await routineDom({ routineWorkspace: () => pending });
  const app = controller();
  try {
    await env.render(
      wrap(app, h(RoutineDetailResources, { routine, disabled: false })),
    );
    const next = controller();
    next.accountId = "replacement";
    env.window.desktop = {
      ...env.window.desktop,
      routineWorkspace: async () => ({
        taskId: "task",
        host: "local",
        problems: [],
        folders: [],
      }),
    };
    await env.render(
      wrap(next, h(RoutineDetailResources, { routine, disabled: false })),
    );
    await act(async () =>
      resolve({
        taskId: "task",
        host: "local",
        problems: [],
        folders: [
          {
            path: "/selected",
            state: "missing",
            message: "PRIVATE OLD DIAGNOSTIC",
          },
        ],
      }),
    );
    assert.doesNotMatch(env.document.body.textContent!, /PRIVATE OLD/);
  } finally {
    await env.clean();
  }
});

test("5 partial: actual existing-task location switch is locked; a new draft still chooses its execution location", async () => {
  let changes = 0;
  const env = await routineDom({
    routineCapabilities: async () => ({
      remote: true,
      email: false,
      slack: false,
    }),
  });
  const draft = {
    ...newDraft(Date.now()),
    id: "existing",
    executionLocation: "local" as const,
  };
  try {
    await env.render(h(RoutineSettings, { draft, onChange: () => changes++ }));
    const toggle = env.document.querySelector<HTMLButtonElement>(
      '[aria-label="Only on this computer"]',
    )!;
    assert.equal(toggle.disabled, true);
    assert.match(
      env.document.body.textContent!,
      /can’t be changed after it’s created/,
    );
    await env.event(toggle, "click");
    assert.equal(changes, 0);
    await env.render(
      h(RoutineSettings, {
        draft: { ...draft, id: undefined },
        onChange: () => changes++,
      }),
    );
    await env.click('[aria-label="Only on this computer"]');
    assert.equal(changes, 1);
  } finally {
    await env.clean();
  }
});
