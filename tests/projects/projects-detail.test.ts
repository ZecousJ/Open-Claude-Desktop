import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import type { Project, Snapshot } from "../../shared/types";

(globalThis as { __CLAUDEX_SURFACE__?: string }).__CLAUDEX_SURFACE__ = "web";
const [
  { ProjectsPage },
  { HostContext },
  { webHost },
  { AppContext },
  { routineDom },
  { defaultSettings },
  { unavailableMemory },
  { registerConnectionCheck },
  { requestProject, clearProjectRequest },
] = await Promise.all([
  import("../../src/collections/projects/ProjectsPage"),
  import("../../src/host/HostContext"),
  import("../../shared/host"),
  import("../../src/app/AppContext"),
  import("../support/routine-dom"),
  import("../../electron/store/store"),
  import("../../shared/memory-api"),
  import("../../src/app/connection"),
  import("../../src/collections/open-requests"),
]);
type Controller = import("../../src/app/AppContext").AppController;
const noop = () => {};
const project: Project = {
  id: "requested",
  name: "Requested project",
  description: "Only this project",
  instructions: "",
  createdAt: 1,
};
const other: Project = { ...project, id: "other", name: "Other project" };
const props = {
  onNewProject: noop,
  onEditProject: noop,
  onDeleteProject: noop,
  onArchiveProject: noop,
  onOpenConversation: noop,
  renderComposer: (value: Project) =>
    h("div", { "data-project-composer": value.id }, "Project composer"),
  onSaveProject: async () => {},
  onChooseFolder: async () => null,
  onScheduled: noop,
};
async function environment(
  url = "/project/requested?search=robot&group=none&keep=中#settings/data-privacy-controls",
) {
  clearProjectRequest();
  const env = await routineDom(
    {
      memoryStatus: async () => unavailableMemory,
      listProjectKnowledge: async () => ({
        files: [],
        bytes: 0,
        limit: 1_000,
        fileLimit: 1_000,
      }),
    },
    { jsdom: true },
  );
  env.window.history.replaceState({ stable: true }, "", url);
  const globals = {
    location: env.window.location,
    history: env.window.history,
    innerWidth: 1280,
    innerHeight: 800,
    cancelAnimationFrame: noop,
    addEventListener: env.window.addEventListener.bind(env.window),
    removeEventListener: env.window.removeEventListener.bind(env.window),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  };
  const before = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  const errors: unknown[] = [],
    current: { current: Controller | undefined } = { current: undefined };
  const identity = {
    accountId: "detail-b23",
    controllerScope: {},
    currentController: current,
    windowRole: { kind: "main" },
    report: (error: unknown) => errors.push(error),
  };
  let actor: Controller;
  const show = async (
    projects: Project[],
    status: "ready" | "failed",
    cached = true,
    owner = identity,
  ) => {
    actor = {
      ...owner,
      snapshot: {
        projects,
        conversations: [],
        settings: defaultSettings,
        artifactLibrary: { version: 1, copies: [], pinned: [] },
        projectCatalog: { status, cached },
      } as unknown as Snapshot,
    } as unknown as Controller;
    current.current = actor;
    await env.render(
      h(
        HostContext.Provider,
        { value: webHost },
        h(
          AppContext.Provider,
          { value: actor },
          h(ProjectsPage, { ...props, projects, conversations: [] }),
        ),
      ),
    );
  };
  return {
    ...env,
    show,
    current,
    identity,
    errors,
    get actor() {
      return actor;
    },
    async clean() {
      registerConnectionCheck(undefined);
      clearProjectRequest();
      await env.clean();
      for (const [key, value] of before)
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    },
  };
}
function noList(env: Awaited<ReturnType<typeof environment>>) {
  assert.equal(env.document.querySelector(".prj-grid"), null);
  assert.equal(env.document.querySelector(".prj-new"), null);
  assert.equal(env.document.querySelector(".prj-template-section"), null);
  assert.equal(
    env.document.body.textContent?.includes("Looking to start a project?"),
    false,
  );
}

test("an unmatched deep link has its own missing state and never displays a different project's list", async () => {
  const env = await environment();
  try {
    await env.show([other], "ready");
    assert.equal(
      env.document.querySelector(".empty-state h3")?.textContent,
      "Project not found",
    );
    assert.equal(env.document.querySelector('[role="alert"]'), null);
    noList(env);
    assert.equal(env.document.querySelector("[data-project-composer]"), null);
    assert.equal(env.window.location.pathname, "/project/requested");
    assert.equal(
      env.window.location.search,
      "?search=robot&group=none&keep=%E4%B8%AD",
    );
  } finally {
    await env.clean();
  }
});

test("a failed authoritative read is a project load error, including an empty cache, with no false not-found or creation state", async () => {
  for (const cached of [false, true]) {
    const env = await environment();
    try {
      await env.show([], "failed", cached);
      assert.equal(
        env.document.querySelector('[role="alert"] h3')?.textContent,
        "Couldn’t load this project",
      );
      assert.equal(
        env.document.querySelector(".empty-state-cta")?.textContent,
        "Try again",
      );
      assert.equal(
        env.document.body.textContent?.includes("Project not found"),
        false,
      );
      noList(env);
      assert.equal(env.window.location.pathname, "/project/requested");
    } finally {
      await env.clean();
    }
  }
});

test("missing-project Retry uses the registered real snapshot resync, holds the requested URL and becomes the resolved detail", async () => {
  const env = await environment();
  let release!: () => void;
  let checks = 0;
  registerConnectionCheck(() => {
    checks++;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  try {
    await env.show([], "ready");
    await env.click(".empty-state-cta");
    assert.equal(checks, 1);
    assert.equal(
      env.document.querySelector('[role="status"]')?.getAttribute("aria-label"),
      "Loading project",
    );
    assert.equal(
      env.document.querySelector('[role="status"]')?.getAttribute("aria-busy"),
      "true",
    );
    assert.ok(env.document.querySelector(".sk"));
    noList(env);
    assert.equal(env.document.querySelector("[data-project-composer]"), null);
    assert.equal(env.window.location.pathname, "/project/requested");
    await env.show([project, other], "ready");
    assert.equal(
      env.document.querySelector("h1")?.textContent,
      "Requested project",
    );
    assert.equal(
      env.document
        .querySelector("[data-project-composer]")
        ?.getAttribute("data-project-composer"),
      "requested",
    );
    await act(async () => release());
    assert.equal(env.document.querySelector('[role="alert"]'), null);
    noList(env);
    assert.equal(
      new URLSearchParams(env.window.location.search).get("keep"),
      "中",
    );
  } finally {
    release?.();
    await env.clean();
  }
});

test("failed-project Retry stays an error while busy, prevents repeat requests and returns to retryable failure after resync rejection", async () => {
  const env = await environment();
  let reject!: (error: unknown) => void;
  let checks = 0;
  registerConnectionCheck(() => {
    checks++;
    return new Promise<void>((_, no) => {
      reject = no;
    });
  });
  try {
    await env.show([], "failed", false);
    await env.click(".empty-state-cta");
    assert.equal(
      env.document.querySelector('[role="alert"] h3')?.textContent,
      "Couldn’t load this project",
    );
    assert.equal(
      env.document.querySelector<HTMLButtonElement>(".empty-state-cta")
        ?.disabled,
      true,
    );
    await env.click(".empty-state-cta");
    assert.equal(checks, 1);
    await act(async () => reject(new Error("internal transport diagnostics")));
    assert.equal(
      env.document.querySelector<HTMLButtonElement>(".empty-state-cta")
        ?.disabled,
      false,
    );
    assert.equal(env.errors.length, 1);
    assert.equal(
      env.document.body.textContent?.includes("internal transport diagnostics"),
      false,
    );
    assert.equal(
      env.document.body.textContent?.includes("Project not found"),
      false,
    );
    noList(env);
  } finally {
    await env.clean();
  }
});

test("a present cached project stays on its real detail when the catalog read fails", async () => {
  const env = await environment();
  try {
    await env.show([project], "failed", true);
    assert.equal(
      env.document.querySelector("h1")?.textContent,
      "Requested project",
    );
    assert.equal(
      env.document
        .querySelector("[data-project-composer]")
        ?.getAttribute("data-project-composer"),
      "requested",
    );
    assert.equal(env.document.querySelector(".prj-read-state"), null);
    noList(env);
  } finally {
    await env.clean();
  }
});

test("unresolved detail breadcrumb retains the list query and Settings destination with native link semantics", async () => {
  const env = await environment();
  try {
    await env.show([], "failed");
    const crumb = env.document.querySelector<HTMLAnchorElement>(
      'nav[aria-label="Breadcrumb"] a',
    );
    assert.ok(crumb);
    assert.equal(crumb.textContent, "Projects");
    assert.equal(
      crumb.getAttribute("href"),
      "/projects?search=robot&group=none&keep=%E4%B8%AD#settings/data-privacy-controls",
    );
    const alternate = await env.event(crumb, "click", {
      button: 0,
      ctrlKey: true,
    });
    assert.equal(alternate.defaultPrevented, false);
    assert.equal(env.window.location.pathname, "/project/requested");
    const normal = await env.event(crumb, "click", { button: 0 });
    assert.equal(normal.defaultPrevented, true);
    assert.equal(env.window.location.pathname, "/projects");
    assert.equal(env.window.location.hash, "#settings/data-privacy-controls");
    assert.equal(
      new URLSearchParams(env.window.location.search).get("search"),
      "robot",
    );
    assert.equal(
      env.document.querySelector('[role="alert"] h3')?.textContent,
      "Couldn’t load your projects",
    );
  } finally {
    await env.clean();
  }
});

test("a mounted request for another missing ID changes the requested place without rendering cached unrelated rows", async () => {
  const env = await environment();
  try {
    await env.show([other], "ready");
    await act(async () => requestProject("second"));
    assert.equal(env.window.location.pathname, "/project/second");
    assert.equal(
      env.document.querySelector(".empty-state h3")?.textContent,
      "Project not found",
    );
    noList(env);
    await env.show(
      [{ ...project, id: "second", name: "Second project" }],
      "ready",
    );
    assert.equal(
      env.document.querySelector("h1")?.textContent,
      "Second project",
    );
  } finally {
    await env.clean();
  }
});

for (const retirement of [
  "account",
  "controller",
  "bridge",
  "unmount",
] as const)
  test(`delayed detail retry cannot report into a retired ${retirement}`, async () => {
    const env = await environment();
    let reject!: (error: unknown) => void;
    registerConnectionCheck(
      () =>
        new Promise<void>((_, no) => {
          reject = no;
        }),
    );
    try {
      await env.show([], "failed");
      await env.click(".empty-state-cta");
      if (retirement === "unmount")
        await env.render(h("div", null, "Replacement"));
      else if (retirement === "bridge")
        env.window.desktop = { ...env.window.desktop };
      else
        env.current.current = {
          ...env.actor,
          ...(retirement === "account"
            ? { accountId: "replacement" }
            : { controllerScope: {} }),
        };
      await act(async () => reject(new Error("retired read")));
      assert.deepEqual(env.errors, []);
      assert.equal(env.window.location.pathname, "/project/requested");
    } finally {
      await env.clean();
    }
  });
