import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Routine, RoutineInput } from "../../shared/routines";
import type { Project } from "../../shared/types";
import type { CoworkFolderAccess } from "../../shared/cowork-api";
import { coworkFolderPermissionMessage } from "../../shared/cowork-api";
import { desktopHost, webHost } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { RoutineDetailResources } from "../../src/collections/routines/RoutineDetailResources";
import { AutoDisabledRoutineNotice } from "../../src/collections/routines/AutoDisabledRoutineNotice";
import {
  clearProjectRequest,
  projectRequest,
} from "../../src/collections/open-requests";
import { routineDom } from "../support/routine-dom";

const task: Routine = {
  id: "b20-detail",
  name: "Real task",
  prompt: "Real instructions",
  mode: "cowork",
  model: "model-from-record",
  providerId: "provider",
  enabled: true,
  frequency: "daily",
  nextRunAt: 100,
  createdAt: 1,
  updatedAt: 1,
  executionLocation: "local",
};
const project: Project = {
  id: "project / owner",
  name: "Actual <project>",
  description: "",
  instructions: "",
  createdAt: 1,
  kind: "local",
  cwd: "/owned/project",
  additionalFolders: ["/owned/second", "/owned/project"],
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function controller(accountId = "owner-a", projects: Project[] = []) {
  const app = {
    accountId,
    controllerScope: {},
    page: "scheduled",
    snapshot: { projects },
    setPage() {},
    currentController: { current: undefined as AppController | undefined },
  } as unknown as AppController;
  app.currentController!.current = app;
  return app;
}
const wrap = (
  child: ReturnType<typeof h>,
  app?: AppController,
  host = desktopHost,
) =>
  h(
    HostContext.Provider,
    { value: host },
    h(AppContext.Provider, { value: app }, child),
  );
const resources = (routine = task, disabled = false) =>
  h(RoutineDetailResources, { routine, disabled });

test("14: ordinary unified Chat does not acquire retained read-only Model metadata; Code uses its actual model/default choice", () => {
  const plain = renderToStaticMarkup(
    wrap(
      resources({ ...task, executionLocation: "remote" }),
      undefined,
      webHost,
    ),
  );
  assert.doesNotMatch(
    plain,
    /routine-detail-model|routine-detail-project|routine-detail-folders/,
  );
  for (const defaultModel of [false, true]) {
    const html = renderToStaticMarkup(
      wrap(resources({ ...task, mode: "code", defaultModel })),
    );
    assert.match(html, /Runs with/);
    assert.ok(html.includes(defaultModel ? "Default model" : task.model));
    if (defaultModel) assert.equal(html.includes(task.model), false);
  }
});

test("14: a loaded project uses its genuine URL and normal-click project navigation; modified clicks keep link behavior", async () => {
  const env = await routineDom();
  const app = controller("a", [project]);
  const pages: string[] = [];
  app.setPage = (value) => {
    if (typeof value === "string") pages.push(value);
  };
  try {
    await env.render(wrap(resources({ ...task, projectId: project.id }), app));
    const link = env.document.querySelector<HTMLAnchorElement>(
      ".routine-detail-project a",
    )!;
    assert.equal(link.getAttribute("href"), "/project/project%20%2F%20owner");
    assert.equal(link.textContent, project.name);
    const modified = await env.event(link, "click", {
      button: 0,
      metaKey: true,
    });
    assert.equal(modified.defaultPrevented, false);
    assert.deepEqual(pages, []);
    const regular = await env.event(link, "click", { button: 0 });
    assert.equal(regular.defaultPrevented, true);
    assert.equal(projectRequest(), project.id);
    assert.deepEqual(pages, ["projects"]);
    assert.equal(
      env.document.querySelector(".routine-detail-project button"),
      null,
    );
  } finally {
    clearProjectRequest();
    await env.clean();
  }
});

test("14: a genuinely missing project can be unlinked persistently using the latest task, preserving intervening fields", async () => {
  const writes: RoutineInput[] = [];
  const associated = { ...task, projectId: "deleted-project" };
  const latest = {
    ...associated,
    name: "Name changed elsewhere",
    prompt: "Latest prompt",
    updatedAt: 5,
  };
  const env = await routineDom({
    listSchedules: async () => [latest],
    saveSchedule: async (input) => {
      writes.push(input);
      return { ...latest, ...input };
    },
  });
  try {
    await env.render(wrap(resources(associated), controller()));
    assert.match(
      env.document.querySelector(".routine-detail-project")!.textContent!,
      /no longer exists/,
    );
    await env.click(".routine-detail-project button");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].projectId, undefined);
    assert.equal(writes[0].name, latest.name);
    assert.equal(writes[0].prompt, latest.prompt);
    assert.equal(writes[0].enabled, latest.enabled);
    assert.equal(env.document.querySelector(".routine-detail-project"), null);
  } finally {
    await env.clean();
  }
});

test("14: failed/partial catalogues never pretend the absent project was deleted; retained real project links remain usable", async () => {
  const env = await routineDom();
  const app = controller();
  app.snapshot.projectCatalog = { status: "failed", cached: false };
  try {
    await env.render(wrap(resources({ ...task, projectId: project.id }), app));
    assert.equal(env.document.querySelector(".routine-detail-project"), null);
    app.snapshot.projects = [project];
    app.snapshot.projectCatalog = { status: "failed", cached: true };
    await env.render(wrap(resources({ ...task, projectId: project.id }), app));
    assert.equal(
      env.document.querySelector(".routine-detail-project a")!.textContent,
      project.name,
    );
    assert.equal(
      env.document.querySelector(".routine-detail-project button"),
      null,
    );
  } finally {
    await env.clean();
  }
});

test("14: failed unlink retains the recovery action and real error; retry persists, and repointed tasks are never overwritten", async () => {
  const associated = { ...task, projectId: "deleted" };
  const writes: RoutineInput[] = [];
  let rejectSave = true;
  const env = await routineDom({
    listSchedules: async () => [associated],
    saveSchedule: async (input) => {
      if (rejectSave) throw new Error("Actual save refusal");
      writes.push(input);
      return { ...associated, ...input };
    },
  });
  try {
    await env.render(wrap(resources(associated), controller()));
    await env.click(".routine-detail-project button");
    assert.equal(
      env.document.querySelector('[role="alert"]')!.textContent,
      "Actual save refusal",
    );
    assert.equal(writes.length, 0);
    rejectSave = false;
    await env.click(".routine-detail-project button");
    assert.equal(writes.length, 1);
    const other = { ...associated, id: "other-task" };
    env.window.desktop.listSchedules = async () => [
      { ...other, projectId: "now-another-project" },
    ];
    await env.render(wrap(resources(other), controller()));
    await env.click(".routine-detail-project button");
    assert.equal(writes.length, 1);
    assert.ok(env.document.querySelector('[role="alert"]'));
  } finally {
    await env.clean();
  }
});

for (const replacement of ["account", "bridge", "task"] as const) {
  test(`14: ${replacement} replacement while unlink reads cannot save the old task or show stale completion`, async () => {
    const read = deferred<Routine[]>();
    const writes: RoutineInput[] = [];
    const associated = { ...task, projectId: "deleted" };
    const env = await routineDom({
      listSchedules: () => read.promise,
      saveSchedule: async (input) => {
        writes.push(input);
        return { ...associated, ...input };
      },
    });
    const app = controller();
    try {
      await env.render(wrap(resources(associated), app));
      await env.click(".routine-detail-project button");
      if (replacement === "bridge")
        env.window.desktop = { ...env.window.desktop };
      const next = replacement === "account" ? controller("owner-b") : app;
      const nextTask =
        replacement === "task" ? { ...associated, id: "new-task" } : associated;
      await env.render(wrap(resources(nextTask), next));
      await act(async () => read.resolve([associated]));
      assert.equal(writes.length, 0);
      assert.ok(env.document.querySelector(".routine-detail-project button"));
      assert.equal(
        env.document
          .querySelector(".routine-detail-project button")!
          .getAttribute("aria-busy"),
        null,
      );
    } finally {
      await env.clean();
    }
  });
}

test("20: selected local folders and matching project folders are deduplicated, with the actual executing-computer name", async () => {
  const locations: Array<"local" | "remote" | undefined> = [];
  const env = await routineDom({
    routineCapabilities: async (location) => {
      locations.push(location);
      return {
        remote: false,
        email: false,
        slack: false,
        computerName: "Actual execution Mac",
      };
    },
  });
  try {
    await env.render(
      wrap(
        resources({ ...task, cwd: project.cwd, projectId: project.id }),
        controller("a", [project]),
      ),
    );
    assert.deepEqual(
      [...env.document.querySelectorAll(".routine-detail-folder-row bdi")].map(
        (node) => node.textContent,
      ),
      ["/owned/project", "/owned/second"],
    );
    assert.equal(
      env.document
        .querySelector(".routine-detail-device")!
        .textContent!.includes("Actual execution Mac"),
      true,
    );
    assert.deepEqual(locations, ["local"]);
    await env.render(
      wrap(
        resources({
          ...task,
          cwd: "/other",
          projectId: project.id,
          environment: { kind: "ssh", hostId: "other-host" },
        }),
        controller("a", [project]),
      ),
    );
    assert.deepEqual(
      [...env.document.querySelectorAll(".routine-detail-folder-row bdi")].map(
        (node) => node.textContent,
      ),
      ["/other"],
    );
  } finally {
    await env.clean();
  }
});

test("20: SSH folders name their actual registered host; cloud/browser tasks never probe or grant this computer's folders", async () => {
  const reads: string[] = [];
  const env = await routineDom({
    sshListHosts: async () => {
      reads.push("ssh");
      return {
        hosts: [
          {
            id: "opaque-id",
            label: "Actual remote host",
            destination: "owner@remote",
            createdAt: 1,
          },
        ],
        suggestions: [],
        sshAvailable: true,
      };
    },
    routineCapabilities: async () => {
      reads.push("local");
      return { remote: false, email: false, slack: false };
    },
    grantCoworkFolder: async () => {
      reads.push("grant");
      throw new Error("must not grant");
    },
  });
  try {
    const localTask = {
      ...task,
      cwd: "/private/native",
      lastError: coworkFolderPermissionMessage,
    };
    await env.render(
      wrap(
        resources({
          ...localTask,
          environment: { kind: "ssh", hostId: "opaque-id" },
        }),
      ),
    );
    assert.match(
      env.document.querySelector(".routine-detail-device")!.textContent!,
      /Actual remote host/,
    );
    assert.equal(env.document.querySelector('[aria-label^="Allow "]'), null);
    await env.render(
      wrap(
        resources({ ...localTask, executionLocation: "remote" }),
        undefined,
        webHost,
      ),
    );
    assert.equal(env.document.querySelector(".routine-detail-folders"), null);
    await env.render(wrap(resources(localTask), undefined, webHost));
    assert.equal(env.document.querySelector('[aria-label^="Allow "]'), null);
    assert.deepEqual(reads, ["ssh"]);
  } finally {
    await env.clean();
  }
});

test("20: an actual local task permission failure grants exactly that task; failures retry and do not fake enabled or allowed state", async () => {
  const calls: Array<[string, string, unknown]> = [];
  let fail = true;
  const env = await routineDom({
    grantCoworkFolder: async (folder, scope, target) => {
      calls.push([folder, scope, target]);
      if (fail) throw new Error("Actual grant refused");
      return { state: "ask", folder, name: "selected" };
    },
  });
  try {
    const denied = {
      ...task,
      cwd: "/owned/selected",
      lastError: coworkFolderPermissionMessage,
    };
    await env.render(wrap(resources(denied)));
    await env.click('[aria-label="Allow /owned/selected on this computer"]');
    assert.equal(
      env.document.querySelector('[role="alert"]')!.textContent,
      "Actual grant refused",
    );
    assert.equal(env.document.querySelector('[role="img"]'), null);
    fail = false;
    await env.click('[aria-label="Allow /owned/selected on this computer"]');
    assert.deepEqual(calls, [
      [denied.cwd, "session", { routineId: denied.id }],
      [denied.cwd, "session", { routineId: denied.id }],
    ]);
    assert.equal(
      env.document.querySelector('[role="img"]')!.getAttribute("aria-label"),
      "Allowed for this task on this computer",
    );
    assert.equal(task.enabled, true);
    await env.render(
      wrap(resources({ ...denied, id: "code-task", mode: "code" })),
    );
    assert.equal(env.document.querySelector('[aria-label^="Allow "]'), null);
  } finally {
    await env.clean();
  }
});

test("20: late grant and device results cannot acknowledge a new account's identically named task", async () => {
  const grant = deferred<CoworkFolderAccess>();
  const name = deferred<{
    remote: boolean;
    email: boolean;
    slack: boolean;
    computerName?: string;
  }>();
  const env = await routineDom({
    grantCoworkFolder: () => grant.promise,
    routineCapabilities: () => name.promise,
  });
  const denied = {
    ...task,
    cwd: "/owned/folder",
    lastError: coworkFolderPermissionMessage,
  };
  try {
    await env.render(wrap(resources(denied), controller()));
    await env.click('[aria-label="Allow /owned/folder on this computer"]');
    env.window.desktop = {
      ...env.window.desktop,
      routineCapabilities: async () => ({
        remote: false,
        email: false,
        slack: false,
        computerName: "New account computer",
      }),
    };
    await env.render(wrap(resources(denied), controller("owner-b")));
    await act(async () => {
      grant.resolve({ state: "granted", folder: denied.cwd, name: "folder" });
      name.resolve({
        remote: false,
        email: false,
        slack: false,
        computerName: "Old private computer",
      });
    });
    assert.equal(env.document.querySelector('[role="img"]'), null);
    assert.match(
      env.document.querySelector(".routine-detail-device")!.textContent!,
      /New account computer/,
    );
    assert.doesNotMatch(env.document.body.textContent!, /Old private computer/);
  } finally {
    await env.clean();
  }
});

test("17: only a genuine local Code workspace-access reason offers the real re-enable callback and retry", async () => {
  const env = await routineDom();
  const calls: string[] = [];
  let fail = true;
  const code: Routine = {
    ...task,
    mode: "code",
    enabled: false,
    cwd: "/missing/workspace",
    endedReason: "auto_disabled_repo_access",
    lastError: "ENOENT actual workspace",
  };
  const notice = (routine = code) =>
    h(AutoDisabledRoutineNotice, {
      routine,
      disabled: false,
      onEdit() {
        calls.push("edit");
      },
      onRecover: async () => {
        calls.push("recover");
        if (fail) throw new Error("Restore access first");
      },
    });
  try {
    await env.render(wrap(notice()));
    assert.match(env.document.body.textContent!, /workspace folder is missing/);
    assert.match(env.document.body.textContent!, /ENOENT actual workspace/);
    await env.click(".routine-auto-disabled button:last-child");
    assert.match(env.document.body.textContent!, /Restore access first/);
    fail = false;
    await env.click(".routine-auto-disabled button:last-child");
    assert.deepEqual(calls, ["recover", "recover"]);
    assert.equal(code.enabled, false);
    for (const routine of [
      { ...code, executionLocation: "remote" as const },
      { ...code, environment: { kind: "ssh" as const, hostId: "other" } },
    ]) {
      await env.render(wrap(notice(routine)));
      assert.doesNotMatch(
        env.document.body.textContent!,
        /workspace folder is missing|GitHub/,
      );
      assert.equal(
        env.document.querySelectorAll(".routine-auto-disabled button").length,
        1,
      );
      assert.match(env.document.body.textContent!, /ENOENT actual workspace/);
    }
    await env.render(wrap(notice({ ...code, mode: "cowork" })));
    assert.equal(env.document.querySelector(".routine-auto-disabled"), null);
    await env.render(wrap(notice({ ...code, endedReason: undefined })));
    assert.equal(env.document.querySelector(".routine-auto-disabled"), null);
  } finally {
    await env.clean();
  }
});

test("17: re-enable has a real busy lease and an old account's late error cannot alter the replacement task", async () => {
  const env = await routineDom();
  const recovery = deferred<void>();
  const calls: string[] = [];
  const code: Routine = {
    ...task,
    mode: "code",
    enabled: false,
    cwd: "/workspace",
    endedReason: "auto_disabled_repo_access",
  };
  const notice = () =>
    h(AutoDisabledRoutineNotice, {
      routine: code,
      disabled: false,
      onEdit() {},
      onRecover: () => {
        calls.push("recover");
        return recovery.promise;
      },
    });
  try {
    await env.render(wrap(notice(), controller()));
    await env.click(".routine-auto-disabled button:last-child");
    assert.equal(
      env.document.querySelector<HTMLButtonElement>(
        ".routine-auto-disabled button:last-child",
      )!.disabled,
      true,
    );
    assert.equal(
      env.document
        .querySelector(".routine-auto-disabled button:last-child")!
        .getAttribute("aria-busy"),
      "true",
    );
    await env.render(wrap(notice(), controller("owner-b")));
    await act(async () =>
      recovery.reject(new Error("Old account private error")),
    );
    assert.doesNotMatch(
      env.document.body.textContent!,
      /Old account private error/,
    );
    assert.equal(
      env.document.querySelector<HTMLButtonElement>(
        ".routine-auto-disabled button:last-child",
      )!.disabled,
      false,
    );
    assert.deepEqual(calls, ["recover"]);
  } finally {
    await env.clean();
  }
});

/** Keep the actual React callback rather than dispatching on a node after
 * React has replaced its props with the next render's callback. */
function retainedClick(node: Element): () => void {
  const key = Object.getOwnPropertyNames(node).find((name) =>
    name.startsWith("__reactProps$"),
  );
  assert.ok(key, "the actual mounted button has React props");
  const props = (node as unknown as Record<string, unknown>)[key] as {
    onClick?: () => void;
  };
  assert.equal(typeof props.onClick, "function");
  return props.onClick!;
}

for (const action of ["unlink", "allow", "recover"] as const) {
  for (const replacement of [
    "task",
    "account",
    "controller",
    "bridge",
  ] as const) {
    test(`retained ${action}: ${replacement} replacement blocks the first old RPC/callback and keeps the new action usable`, async () => {
      const calls: Array<{ method: string; id?: string; bridge?: string }> = [];
      const owned: Routine = {
        ...task,
        cwd: "/owned/retained",
        projectId: "deleted",
        lastError: coworkFolderPermissionMessage,
        ...(action === "recover"
          ? {
              mode: "code" as const,
              enabled: false,
              endedReason: "auto_disabled_repo_access" as const,
            }
          : {}),
      };
      let actual = owned;
      const bridgeMethods = (owner: string) => ({
        listSchedules: async () => {
          calls.push({ method: "list", bridge: owner });
          return [actual];
        },
        saveSchedule: async (input: RoutineInput): Promise<Routine> => {
          calls.push({ method: "save", id: input.id, bridge: owner });
          return { ...actual, ...input };
        },
        grantCoworkFolder: async (
          folder: string,
          _scope: "session" | "always",
          target?: { routineId?: string },
        ): Promise<CoworkFolderAccess> => {
          calls.push({ method: "grant", id: target?.routineId, bridge: owner });
          return { state: "granted", folder, name: "retained" };
        },
      });
      const env = await routineDom(bridgeMethods("a"));
      const app = controller("owner-a");
      const selector =
        action === "unlink"
          ? ".routine-detail-project button"
          : action === "allow"
            ? '[aria-label="Allow /owned/retained on this computer"]'
            : ".routine-auto-disabled button:last-child";
      const view = (routine: Routine, owner: AppController) =>
        action === "recover"
          ? wrap(
              h(AutoDisabledRoutineNotice, {
                routine,
                disabled: false,
                onEdit() {},
                onRecover: async () => {
                  calls.push({
                    method: "recover",
                    id: routine.id,
                    bridge: owner.accountId,
                  });
                },
              }),
              owner,
            )
          : wrap(resources(routine), owner);
      try {
        await env.render(view(owned, app));
        const oldCallback = retainedClick(
          env.document.querySelector(selector)!,
        );
        const nextApp =
          replacement === "account"
            ? controller("owner-b")
            : replacement === "controller"
              ? controller("owner-a")
              : app;
        if (replacement === "task")
          actual = { ...owned, id: "replacement-task" };
        if (replacement === "bridge")
          env.window.desktop = { ...env.window.desktop, ...bridgeMethods("b") };
        if (replacement === "account" || replacement === "controller")
          app.currentController!.current = nextApp;
        // Live authority can change before React commits its replacement UI.
        if (replacement !== "task") {
          await act(async () => oldCallback());
          assert.equal(
            calls.length,
            0,
            "the first RPC must be guarded before the replacement render",
          );
        }
        await env.render(view(actual, nextApp));
        await act(async () => oldCallback());
        assert.equal(
          calls.length,
          0,
          "an old payload must not borrow the newly rendered scope",
        );
        await env.click(selector);
        if (action === "unlink") {
          assert.deepEqual(
            calls.map((call) => call.method),
            ["list", "save"],
          );
          assert.equal(calls[1].id, actual.id);
        } else {
          assert.equal(calls.length, 1);
          assert.equal(
            calls[0].method,
            action === "allow" ? "grant" : "recover",
          );
          assert.equal(calls[0].id, actual.id);
        }
      } finally {
        await env.clean();
      }
    });
  }
}
