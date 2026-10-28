import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import type { Project, Snapshot } from "../../shared/types";
import type { ProjectReadResult } from "../../shared/project-access";
(globalThis as { __CLAUDEX_SURFACE__?: string }).__CLAUDEX_SURFACE__ = "web";
const [
  { ProjectsPage },
  { AppContext },
  { HostContext },
  { webHost },
  { routineDom },
  { defaultSettings },
  { projectPlaceURL },
] = await Promise.all([
  import("../../src/collections/projects/ProjectsPage"),
  import("../../src/app/AppContext"),
  import("../../src/host/HostContext"),
  import("../../shared/host"),
  import("../support/routine-dom"),
  import("../../electron/store/store"),
  import("../../src/collections/projects/project-list-url"),
]);
const row: Project = {
  id: "private",
  name: "Private project",
  description: "",
  instructions: "",
  createdAt: 1,
};
const caps = {
  routing: "classic",
  contextFiles: true,
  contextText: true,
  localFolders: false,
  educationSuggestions: false,
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function environment(
  api: object = {},
  url = "/project/private?keep=1#settings/data-privacy-controls",
) {
  const env = await routineDom(api as never, { jsdom: true });
  env.window.history.replaceState({ keep: true }, "", url);
  const globals = {
    location: env.window.location,
    history: env.window.history,
    localStorage: env.window.localStorage,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener: env.window.addEventListener.bind(env.window),
    removeEventListener: env.window.removeEventListener.bind(env.window),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  };
  const saved = new Map(
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
  const app = {
    accountId: "a",
    controllerScope: {},
    report() {},
    snapshot: {
      settings: defaultSettings,
      projects: [],
      conversations: [],
      projectCatalog: { status: "ready", cached: true },
    } as unknown as Snapshot,
  } as unknown as import("../../src/app/AppContext").AppController;
  app.currentController = { current: app };
  const render = (projects: Project[] = [], actor = app) =>
    env.render(
      h(
        HostContext.Provider,
        { value: webHost },
        h(
          AppContext.Provider,
          { value: actor },
          h(ProjectsPage, {
            projects,
            conversations: [],
            onNewProject() {},
            onEditProject() {},
            onDeleteProject() {},
            onArchiveProject() {},
            onOpenConversation() {},
            renderComposer: () => null,
            onSaveProject: async () => {},
            onChooseFolder: async () => null,
            onScheduled() {},
          }),
        ),
      ),
    );
  return {
    ...env,
    app,
    render,
    async clean() {
      await env.clean();
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("deep links await per-project authority and do not turn an absent row into forbidden access", async () => {
  const request = deferred<ProjectReadResult>();
  const calls: string[] = [];
  const env = await environment({
    readProject: (id: string) => {
      calls.push(id);
      return request.promise;
    },
  });
  try {
    await env.render();
    assert.deepEqual(calls, ["private"]);
    assert.ok(env.document.querySelector('[aria-label="Loading project"]'));
    assert.doesNotMatch(
      env.document.body.textContent ?? "",
      /Project not found|don’t have access|Looking to start/,
    );
    await act(async () => request.resolve({ status: "missing" }));
    assert.match(env.document.body.textContent ?? "", /Project not found/);
    assert.doesNotMatch(
      env.document.body.textContent ?? "",
      /don’t have access/,
    );
    assert.equal(env.window.location.pathname, "/project/private");
    assert.equal(env.window.location.hash, "#settings/data-privacy-controls");
  } finally {
    await env.clean();
  }
});

test("an explicit forbidden response overrides a cached list project and offers the source-backed all-projects action", async () => {
  let reads = 0;
  const env = await environment({
    readProject: async () => {
      reads++;
      return { status: "forbidden" };
    },
  });
  try {
    await env.render([row]);
    assert.match(
      env.document.body.textContent ?? "",
      /You don’t have access to this project/,
    );
    assert.doesNotMatch(
      env.document.body.textContent ?? "",
      /Private project|Looking to start/,
    );
    assert.equal(
      env.document.querySelector(".prj-read-state button")?.textContent,
      "Go to all projects",
    );
    await env.click(".prj-read-state button");
    assert.equal(reads, 1);
    assert.equal(env.window.location.pathname, "/projects");
  } finally {
    await env.clean();
  }
});

test("failed project reads retain the requested place and stale Retry cannot cross a controller or bridge", async () => {
  let reads = 0;
  const env = await environment({
    readProject: async () => {
      reads++;
      throw new Error("network");
    },
  });
  try {
    await env.render();
    assert.match(
      env.document.body.textContent ?? "",
      /Couldn’t load this project/,
    );
    assert.equal(env.window.location.pathname, "/project/private");
    const button = env.document.querySelector<HTMLButtonElement>(
      ".prj-read-state button",
    )!;
    const key = Object.keys(button).find((key) =>
      key.startsWith("__reactProps$"),
    )!;
    const retry = (button as unknown as Record<string, { onClick(): void }>)[
      key
    ].onClick;
    env.app.currentController!.current = undefined;
    await act(async () => retry());
    assert.equal(reads, 1);
  } finally {
    await env.clean();
  }
});

test("late project authority from an old bridge cannot overwrite a replacement account", async () => {
  const old = deferred<ProjectReadResult>();
  const env = await environment({ readProject: () => old.promise });
  try {
    await env.render();
    env.window.desktop = {
      ...env.window.desktop,
      readProject: async () => ({ status: "missing" }),
    } as never;
    const replacement = { ...env.app, accountId: "b", controllerScope: {} };
    replacement.currentController = { current: replacement };
    env.app.currentController!.current = replacement;
    await env.render([], replacement);
    await act(async () => old.resolve({ status: "ready", project: row }));
    assert.match(env.document.body.textContent ?? "", /Project not found/);
    assert.doesNotMatch(env.document.body.textContent ?? "", /Private project/);
  } finally {
    await env.clean();
  }
});

test("education setup is an affirmative capability, while existing query/history state stays intact", async () => {
  const env = await environment(
    { projectCreationCapabilities: async () => caps },
    "/projects?search=alpha&category=shared&sort_by=name&group=type&keep=中#settings/data-privacy-controls",
  );
  try {
    await env.render();
    assert.equal(env.document.querySelector(".prj-template-section"), null);
    assert.equal(
      projectPlaceURL("private", env.window.location),
      "/project/private" +
        env.window.location.search +
        "#settings/data-privacy-controls",
    );
    assert.equal(
      new URLSearchParams(env.window.location.search).get("category"),
      "shared",
    );
    env.window.history.replaceState(
      { keep: true },
      "",
      "/projects?keep=1",
    );
    await act(async () =>
      env.window.dispatchEvent(new env.window.Event("popstate")),
    );
    env.window.desktop = {
      ...env.window.desktop,
      projectCreationCapabilities: async () => ({
        ...caps,
        educationSuggestions: true,
      }),
    } as never;
    await env.render();
    assert.ok(env.document.querySelector(".prj-template-section"));
  } finally {
    await env.clean();
  }
});

test("a failed detail remains failed and visibly retrying until its authoritative retry settles", async () => {
  let reads = 0;
  const next = deferred<ProjectReadResult>();
  const env = await environment({
    readProject: () =>
      ++reads === 1 ? Promise.reject(new Error("offline")) : next.promise,
  });
  try {
    await env.render();
    await env.click(".prj-read-state button");
    assert.equal(reads, 2);
    assert.match(
      env.document.body.textContent ?? "",
      /Couldn’t load this project/,
    );
    assert.equal(
      env.document.querySelector<HTMLButtonElement>(".prj-read-state button")
        ?.disabled,
      true,
    );
    assert.equal(
      env.document
        .querySelector(".prj-read-state button")
        ?.getAttribute("aria-label"),
      "Retrying…",
    );
    await act(async () => next.resolve({ status: "missing" }));
    assert.match(env.document.body.textContent ?? "", /Project not found/);
  } finally {
    await env.clean();
  }
});

test("actual project search replaces history after debounce and sort Back restores unrelated query/hash", async () => {
  const env = await environment(
    {},
    "/projects?sort_by=name&group=none&keep=中#settings/data-privacy-controls",
  );
  try {
    await env.render();
    const before = env.window.history.length;
    await env.click('button[aria-label="Search projects"]');
    await env.change('input[aria-label="Search projects"]', "robot");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 330));
    });
    assert.equal(env.window.history.length, before);
    assert.equal(
      new URLSearchParams(env.window.location.search).get("search"),
      "robot",
    );
    await env.click('button[aria-label="Sort projects"]');
    const created = [
      ...env.document.querySelectorAll('[role="menuitemradio"]'),
    ].find((item) => item.textContent?.includes("Date created"));
    assert.ok(created);
    await env.event(created, "click");
    assert.equal(
      new URLSearchParams(env.window.location.search).get("sort_by"),
      "created_at",
    );
    await act(async () => {
      await new Promise<void>((resolve) => {
        env.window.addEventListener("popstate", () => resolve(), {
          once: true,
        });
        env.window.history.back();
      });
    });
    const query = new URLSearchParams(env.window.location.search);
    assert.equal(query.get("sort_by"), "name");
    assert.equal(query.get("search"), "robot");
    assert.equal(query.get("keep"), "中");
    assert.equal(env.window.location.hash, "#settings/data-privacy-controls");
  } finally {
    await env.clean();
  }
});
