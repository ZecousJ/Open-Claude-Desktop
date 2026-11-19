import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h, useState } from "react";
import type { Project, Snapshot } from "../../shared/types";

(globalThis as { __CLAUDEX_SURFACE__?: string }).__CLAUDEX_SURFACE__ = "web";
const [
  { ProjectReadState },
  { projectPlaceURL },
  { AppContext },
  { registerConnectionCheck },
  { HostContext },
  { webHost },
  { defaultSettings },
  { routineDom },
  { ProjectsPage },
] = await Promise.all([
  import("../../src/collections/projects/ProjectReadState"),
  import("../../src/collections/projects/project-list-url"),
  import("../../src/app/AppContext"),
  import("../../src/app/connection"),
  import("../../src/host/HostContext"),
  import("../../shared/host"),
  import("../../electron/store/store"),
  import("../support/routine-dom"),
  import("../../src/collections/projects/ProjectsPage"),
]);
type AppController = import("../../src/app/AppContext").AppController;
const noop = () => {};
const project: Project = {
  id: "known-project",
  name: "Known project",
  description: "",
  instructions: "",
  createdAt: 1,
};
const props = {
  onNewProject: noop,
  onEditProject: noop,
  onDeleteProject: noop,
  onArchiveProject: noop,
  onOpenConversation: noop,
  renderComposer: () => null,
  onSaveProject: async () => {},
  onChooseFolder: async () => null,
  onScheduled: noop,
};

async function environment() {
  const env = await routineDom({}, { jsdom: true });
  const globals = {
    innerWidth: 1280,
    innerHeight: 800,
    location: env.window.location,
    history: env.window.history,
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
      configurable: true,
      writable: true,
      value,
    });
  return {
    ...env,
    async clean() {
      await env.clean();
      for (const [key, value] of before) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

function view(rows: Project[], status: "ready" | "failed", cached: boolean) {
  const snapshot = {
    projects: rows,
    conversations: [],
    settings: defaultSettings,
    projectCatalog: { status, cached },
  } as unknown as Snapshot;
  const app = {
    accountId: "b22-owner",
    controllerScope: {},
    snapshot,
    report: noop,
  } as unknown as AppController;
  return h(
    HostContext.Provider,
    { value: webHost },
    h(
      AppContext.Provider,
      { value: app },
      h(ProjectsPage, { ...props, projects: rows, conversations: [] }),
    ),
  );
}

test("real Projects page cannot turn a failed first read or empty cache into the empty creation CTA", async () => {
  const env = await environment();
  try {
    for (const cached of [false, true]) {
      await env.render(view([], "failed", cached));
      assert.equal(
        env.document.querySelector('[role="alert"] h3')?.textContent,
        "Couldn’t load your projects",
      );
      assert.equal(
        env.document.querySelector(".empty-state-cta")?.textContent,
        "Try again",
      );
      assert.equal(
        env.document.body.textContent?.includes("Looking to start a project?"),
        false,
      );
      assert.equal(env.document.querySelector(".prj-template-section"), null);
    }
    await env.render(view([], "ready", true));
    assert.equal(env.document.querySelector('[role="alert"]'), null);
    assert.equal(
      env.document.querySelector(".empty-state-cta")?.textContent,
      "New project",
    );
  } finally {
    await env.clean();
  }
});

test("actual successful cached rows survive a source error", async () => {
  const env = await environment();
  try {
    await env.render(view([project], "failed", true));
    assert.ok(env.document.querySelector('[role="alert"]'));
    assert.match(
      env.document.querySelector(".prj-grid")?.textContent ?? "",
      /Known project/,
    );
    assert.equal(
      env.document.body.textContent?.includes("Looking to start a project?"),
      false,
    );
  } finally {
    await env.clean();
  }
});

test("actual project skeleton has8 cards and a retry remains visibly failed until acknowledged", async () => {
  const env = await environment();
  try {
    await env.render(
      h(ProjectReadState, {
        read: { status: "pending", cached: false, retry: noop },
      }),
    );
    assert.equal(env.document.querySelectorAll(".sk-card").length, 8);
    await env.render(
      h(ProjectReadState, {
        read: { status: "pending", cached: false, failed: true, retry: noop },
      }),
    );
    assert.ok(env.document.querySelector('[role="alert"]'));
    assert.equal(env.document.querySelector("button")?.disabled, true);
    assert.equal(
      env.document.querySelector("button")?.getAttribute("aria-label"),
      "Retrying…",
    );
  } finally {
    await env.clean();
  }
});

test("canonical list/detail changes retain exact unrelated parameters and Settings destinations", () => {
  const context = {
    search: "?search=arm&sort_by=name&previewTransport=data&keep=%E4%B8%AD",
    hash: "#settings/data-privacy-controls",
  };
  assert.equal(
    projectPlaceURL("project α", context),
    "/project/project%20%CE%B1" + context.search + context.hash,
  );
  assert.equal(
    projectPlaceURL(undefined, context),
    "/projects" + context.search + context.hash,
  );
});

test("the real list Retry uses the registered snapshot check and keeps failure until its acknowledgement", async () => {
  const env = await environment(),
    scope = {};
  const gate: { release?: () => void; ready(): void } = { ready: noop };
  let checks = 0;
  registerConnectionCheck(
    () =>
      new Promise<void>((resolve) => {
        checks++;
        gate.release = () => {
          gate.ready();
          resolve();
        };
      }),
  );
  function Harness() {
    const [status, setStatus] = useState<"ready" | "failed">("failed");
    gate.ready = () => setStatus("ready");
    const snapshot = {
      projects: [],
      conversations: [],
      settings: defaultSettings,
      projectCatalog: { status, cached: status === "ready" },
    } as unknown as Snapshot;
    const app = {
      accountId: "b22-retry",
      controllerScope: scope,
      snapshot,
      report: noop,
    } as unknown as AppController;
    return h(
      HostContext.Provider,
      { value: webHost },
      h(
        AppContext.Provider,
        { value: app },
        h(ProjectsPage, { ...props, projects: [], conversations: [] }),
      ),
    );
  }
  try {
    await env.render(h(Harness));
    await env.click(".prj-read-state .empty-state-cta");
    assert.equal(checks, 1);
    assert.equal(
      env.document
        .querySelector(".prj-read-state button")
        ?.getAttribute("aria-label"),
      "Retrying…",
    );
    assert.equal(
      env.document.body.textContent?.includes("Looking to start a project?"),
      false,
    );
    assert.ok(gate.release);
    await act(async () => gate.release!());
    assert.equal(env.document.querySelector('[role="alert"]'), null);
    assert.equal(
      env.document.querySelector(".empty-state-cta")?.textContent,
      "New project",
    );
  } finally {
    registerConnectionCheck(undefined);
    await env.clean();
  }
});

test("the actual project-list card Edit details opens its dedicated editor instead of Settings", async () => {
  const env = await environment();
  try {
    await env.render(view([project], "ready", true));
    await env.click(".prj-card-more");
    const edit = [...env.document.querySelectorAll('[role="menuitem"]')].find(
      (e) => e.textContent?.includes("Edit details"),
    );
    assert.ok(edit);
    await env.event(edit, "click");
    assert.equal(
      env.document.querySelector(".modal h2")?.textContent,
      "Edit details",
    );
    assert.equal(
      env.document.querySelector("textarea")?.value,
      project.description,
    );
    assert.equal(env.document.querySelector(".prj-settings-dialog"), null);
  } finally {
    await env.clean();
  }
});

test("the actual route writer retains project query state without leaking it to another area or reviving closed Settings", async () => {
  const { withProjectQuery } = await import("../../src/web/project-query");
  const current = {
    pathname: "/projects",
    search:
      "?search=robot&sort_by=name&group=type&keep=%E4%B8%AD&connector=old",
  };
  assert.equal(
    withProjectQuery("/projects", current),
    "/projects?search=robot&sort_by=name&group=type&keep=%E4%B8%AD",
  );
  assert.equal(
    withProjectQuery(
      "/project/p1?connector=new#settings/connectors",
      current,
    ),
    "/project/p1?search=robot&sort_by=name&group=type&keep=%E4%B8%AD&connector=new#settings/connectors",
  );
  assert.equal(withProjectQuery("/new", current), "/new");
  assert.equal(
    withProjectQuery("/projects", {
      pathname: "/new",
      search: "?keep=other-area",
    }),
    "/projects",
  );
  assert.equal(withProjectQuery(undefined, current), undefined);
});

test("a retired controller ref cannot restart the actual Projects snapshot read", async () => {
  const env = await environment();
  let checks = 0;
  registerConnectionCheck(async () => {
    checks++;
  });
  const app = {
    accountId: "retired",
    controllerScope: {},
    currentController: { current: undefined },
    snapshot: {
      settings: defaultSettings,
      projects: [],
      conversations: [],
      projectCatalog: { status: "failed", cached: false },
    },
    report: noop,
  } as unknown as AppController;
  app.currentController!.current = app;
  try {
    await env.render(
      h(
        HostContext.Provider,
        { value: webHost },
        h(
          AppContext.Provider,
          { value: app },
          h(ProjectsPage, { ...props, projects: [], conversations: [] }),
        ),
      ),
    );
    app.currentController!.current = undefined;
    await env.click(".prj-read-state .empty-state-cta");
    assert.equal(checks, 0);
    assert.notEqual(
      env.document
        .querySelector(".prj-read-state button")
        ?.getAttribute("aria-label"),
      "Retrying…",
    );
  } finally {
    registerConnectionCheck(undefined);
    await env.clean();
  }
});
