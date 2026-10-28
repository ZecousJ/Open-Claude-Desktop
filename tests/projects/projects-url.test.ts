import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import type { ComponentProps } from "react";
import type { Project, Snapshot } from "../../shared/types";

(globalThis as { __CLAUDEX_SURFACE__?: string }).__CLAUDEX_SURFACE__ = "web";
const [
  { ProjectsPage },
  { ArtifactsPage },
  { HostContext },
  { webHost },
  { AppContext },
  { routineDom },
  { defaultSettings },
] = await Promise.all([
  import("../../src/collections/projects/ProjectsPage"),
  import("../../src/artifacts/ArtifactsPage"),
  import("../../src/host/HostContext"),
  import("../../shared/host"),
  import("../../src/app/AppContext"),
  import("../support/routine-dom"),
  import("../../electron/store/store"),
]);
const { useWebRoute } = await import("../../src/web/useWebRoute");
type Controller = import("../../src/app/AppContext").AppController;
const noop = () => {};
const rows: Project[] = [
  {
    id: "alpha",
    name: "Alpha",
    description: "",
    instructions: "",
    createdAt: 1,
  },
  {
    id: "zulu",
    name: "Zulu",
    description: "",
    instructions: "",
    createdAt: 3,
    kind: "code",
  },
  { id: "beta", name: "Beta", description: "", instructions: "", createdAt: 2 },
  {
    id: "archive",
    name: "Archived Alpha",
    description: "",
    instructions: "",
    createdAt: 4,
    archivedAt: 5,
  },
];
const projectProps: ComponentProps<typeof ProjectsPage> = {
  projects: rows,
  conversations: [],
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
const galleryProps: ComponentProps<typeof ArtifactsPage> = {
  artifacts: [
    {
      id: "own",
      name: "Own Alpha",
      language: "markdown",
      content: "# Alpha",
      updatedAt: 2,
    },
    {
      id: "shared",
      name: "Shared Beta",
      language: "html",
      content: "<p>Beta</p>",
      updatedAt: 1,
      sharedWithYou: true,
    },
  ],
  onOpenArtifact: noop,
  onCreate: noop,
  onComment: async () => {},
  authorName: "You",
  onShareRequestConsumed: noop,
  onDuplicate: async () => {},
  onPin: async () => {},
  onDelete: noop,
  width: 60,
  onResize: noop,
  onClose: noop,
  onError: noop,
  onNotify: noop,
};
function controller() {
  return {
    accountId: "b23",
    controllerScope: {},
    snapshot: {
      settings: defaultSettings,
      projects: rows,
      conversations: [],
    } as unknown as Snapshot,
  } as Controller;
}
async function environment(url: string) {
  const env = await routineDom({}, { jsdom: true });
  env.window.history.replaceState({ keepState: true }, "", url);
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
      value,
      configurable: true,
      writable: true,
    });
  const app = controller();
  const wrap = (child: ReturnType<typeof h>, actor = app) =>
    h(
      HostContext.Provider,
      { value: webHost },
      h(AppContext.Provider, { value: actor }, child),
    );
  const project = (actor = app, key = "projects") =>
    env.render(wrap(h(ProjectsPage, { ...projectProps, key }), actor));
  const gallery = (props = galleryProps, actor = app, key = "gallery") =>
    env.render(wrap(h(ArtifactsPage, { ...props, key }), actor));
  function RoutedGallery() {
    useWebRoute();
    return h(ArtifactsPage, galleryProps);
  }
  const routedGallery = () => env.render(wrap(h(RoutedGallery)));
  const wait = (ms = 330) =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  const travel = async (direction: "back" | "forward") => {
    await act(async () => {
      await new Promise<void>((resolve) => {
        env.window.addEventListener("popstate", () => resolve(), {
          once: true,
        });
        env.window.history[direction]();
      });
    });
  };
  const select = async (text: string) => {
    const option = [
      ...env.document.querySelectorAll(
        '[role="menuitemradio"], [role="menuitemcheckbox"], [role="tab"]',
      ),
    ].find((e) => e.textContent === text);
    assert.ok(option, text);
    await env.event(option, "click");
  };
  return {
    ...env,
    app,
    project,
    gallery,
    routedGallery,
    wait,
    travel,
    select,
    async clean() {
      await env.clean();
      for (const [key, value] of saved)
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
    },
  };
}
const names = (env: Awaited<ReturnType<typeof environment>>) =>
  [...env.document.querySelectorAll(".prj-card-link")].map(
    (e) => e.textContent,
  );
const param = (env: Awaited<ReturnType<typeof environment>>, key: string) =>
  new URLSearchParams(env.window.location.search).get(key);

test("Projects initial URL and refresh restore search, canonical sort, archived, and grouping", async () => {
  const env = await environment(
    "/projects?search=Alpha&sort_by=name&archived=true&group=type&category=mine&keep=中#settings/data-privacy-controls",
  );
  try {
    await env.project();
    assert.equal(
      env.document.querySelector<HTMLInputElement>(
        'input[aria-label="Search projects"]',
      )?.value,
      "Alpha",
    );
    assert.deepEqual(names(env), ["Archived Alpha"]);
    assert.equal(
      env.document.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent,
      "Archived",
    );
    await env.project(env.app, "reload");
    assert.deepEqual(names(env), ["Archived Alpha"]);
    assert.equal(env.window.location.hash, "#settings/data-privacy-controls");
    assert.equal(param(env, "keep"), "中");
    assert.deepEqual(env.window.history.state, { keepState: true });
  } finally {
    await env.clean();
  }
});

test("Projects sort, grouping and archive controls push history and real Back/Forward restores the rendered list", async () => {
  const env = await environment(
    "/projects?group=none&keep=one&connector=calendar#settings/connectors",
  );
  try {
    await env.project();
    const start = env.window.history.length;
    await env.click('[aria-label="Sort projects"]');
    await env.select("Alphabetical");
    assert.equal(param(env, "sort_by"), "name");
    assert.deepEqual(names(env), ["Alpha", "Beta", "Zulu"]);
    await env.click('[aria-label="Sort projects"]');
    await env.select("Group by type");
    assert.equal(param(env, "group"), "type");
    assert.equal(
      env.document.querySelector(".prj-group-heading")?.textContent,
      "Code",
    );
    await env.select("Archived");
    assert.equal(param(env, "category"), "mine");
    assert.equal(param(env, "archived"), "true");
    assert.deepEqual(names(env), ["Archived Alpha"]);
    assert.equal(env.window.history.length, start + 3);
    await env.travel("back");
    assert.equal(param(env, "archived"), null);
    assert.equal(
      env.document.querySelector(".prj-group-heading")?.textContent,
      "Code",
    );
    await env.travel("back");
    assert.equal(param(env, "group"), "none");
    assert.equal(env.document.querySelector(".prj-group-heading"), null);
    await env.travel("back");
    assert.deepEqual(names(env), ["Zulu", "Beta", "Alpha"]);
    await env.travel("forward");
    assert.deepEqual(names(env), ["Alpha", "Beta", "Zulu"]);
    assert.equal(param(env, "connector"), "calendar");
    assert.equal(param(env, "keep"), "one");
    assert.equal(env.window.location.hash, "#settings/connectors");
  } finally {
    await env.clean();
  }
});

test("Projects search filters immediately, replaces after300ms and flushes clear without one entry per character", async () => {
  const env = await environment(
    "/projects?template=docs&keep=yes#settings/data-privacy-controls",
  );
  try {
    await env.project();
    const start = env.window.history.length;
    await env.click('button[aria-label="Search projects"]');
    await env.change('input[aria-label="Search projects"]', "Al");
    assert.deepEqual(names(env), ["Alpha"]);
    assert.equal(param(env, "search"), null);
    await env.change('input[aria-label="Search projects"]', "Alpha");
    await env.wait();
    assert.equal(param(env, "search"), "Alpha");
    assert.equal(env.window.history.length, start);
    await env.change('input[aria-label="Search projects"]', "Zulu");
    await env.click('[aria-label="Close search"]');
    assert.equal(param(env, "search"), null);
    assert.equal(names(env).length, 3);
    await env.wait();
    assert.equal(param(env, "search"), null);
    assert.equal(param(env, "template"), "docs");
    assert.equal(env.window.location.hash, "#settings/data-privacy-controls");
  } finally {
    await env.clean();
  }
});

test("Projects history navigation cancels pending search and restores URL input without overwriting the destination", async () => {
  const env = await environment("/projects?search=Alpha&keep=back");
  try {
    await env.project();
    await env.click('[aria-label="Sort projects"]');
    await env.select("Alphabetical");
    await env.change('input[aria-label="Search projects"]', "Zulu");
    await env.travel("back");
    assert.equal(
      env.document.querySelector<HTMLInputElement>("input")?.value,
      "Alpha",
    );
    assert.deepEqual(names(env), ["Alpha"]);
    await env.wait();
    assert.equal(param(env, "search"), "Alpha");
    assert.equal(param(env, "sort_by"), null);
  } finally {
    await env.clean();
  }
});

test("Gallery URL mine/shared tabs and search restore, tab replacement preserves template, Settings and history state", async () => {
  const env = await environment(
    "/artifacts?tab=mine&search=Alpha&template=slides&keep=中#settings/data-privacy-controls",
  );
  try {
    await env.gallery();
    const length = env.window.history.length;
    assert.equal(
      env.document.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent,
      "Yours",
    );
    assert.equal(
      env.document.querySelector<HTMLInputElement>("input")?.value,
      "Alpha",
    );
    assert.equal(
      env.document.querySelectorAll(".artifacts-grid > li").length,
      1,
    );
    await env.click('[aria-label="Close search"]');
    await env.select("Shared with you");
    assert.equal(param(env, "tab"), "shared");
    assert.equal(env.window.history.length, length);
    assert.match(
      env.document.querySelector(".artifacts-grid")?.textContent ?? "",
      /Shared Beta/,
    );
    await env.gallery(galleryProps, env.app, "reload");
    assert.equal(
      env.document.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent,
      "Shared with you",
    );
    await env.select("All");
    assert.equal(param(env, "tab"), null);
    assert.equal(param(env, "template"), "slides");
    assert.equal(param(env, "keep"), "中");
    assert.equal(env.window.location.hash, "#settings/data-privacy-controls");
    assert.deepEqual(env.window.history.state, { keepState: true });
  } finally {
    await env.clean();
  }
});

test("Gallery browser Back/Forward restores query/tab and cancels a pending search", async () => {
  const env = await environment(
    "/artifacts?tab=mine&search=Alpha&template=docs",
  );
  try {
    await env.gallery();
    await act(async () => {
      env.window.history.pushState(
        {},
        "",
        "/artifacts?tab=shared&search=Beta&template=docs#settings/data-privacy-controls",
      );
      env.window.dispatchEvent(new env.window.Event("popstate"));
    });
    assert.equal(
      env.document.querySelector<HTMLInputElement>("input")?.value,
      "Beta",
    );
    assert.equal(
      env.document.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent,
      "Shared with you",
    );
    await env.change("input", "wrong destination");
    await env.travel("back");
    assert.equal(
      env.document.querySelector<HTMLInputElement>("input")?.value,
      "Alpha",
    );
    await env.wait();
    assert.equal(param(env, "search"), "Alpha");
    await env.travel("forward");
    assert.equal(
      env.document.querySelector<HTMLInputElement>("input")?.value,
      "Beta",
    );
    assert.equal(env.window.location.hash, "#settings/data-privacy-controls");
  } finally {
    await env.clean();
  }
});

test("Gallery validates unsupported/unavailable tabs without inventing membership or losing future/template parameters", async () => {
  for (const tab of ["pinned", "projects", "shared", "future"]) {
    const env = await environment(
      `/artifacts?tab=${tab}&template=slides&future=keep`,
    );
    try {
      await env.gallery({ ...galleryProps, sharedTabEnabled: false });
      assert.equal(
        env.document.querySelector('[role="tab"][aria-selected="true"]')
          ?.textContent,
        "All",
      );
      assert.equal(
        env.document.querySelectorAll(".artifacts-grid > li").length,
        2,
      );
      assert.equal(param(env, "tab"), tab);
      assert.equal(param(env, "template"), "slides");
      assert.equal(param(env, "future"), "keep");
    } finally {
      await env.clean();
    }
  }
});

for (const page of ["projects", "gallery"] as const)
  test(`${page} cancels pending URL work on account/controller/bridge retirement and unmount`, async () => {
    for (const retirement of [
      "account",
      "scope",
      "bridge",
      "current",
      "unmount",
    ] as const) {
      const env = await environment(
        page === "projects"
          ? "/projects?keep=safe"
          : "/artifacts?template=slides",
      );
      try {
        await env[page === "projects" ? "project" : "gallery"]();
        await env.click(
          page === "projects"
            ? 'button[aria-label="Search projects"]'
            : '[aria-label="Search your artifacts"]',
        );
        await env.change("input", "retired draft");
        if (retirement === "bridge")
          env.window.desktop = { ...env.window.desktop };
        else if (retirement === "current")
          env.app.currentController = { current: undefined };
        else if (retirement === "unmount")
          await env.render(h("div", null, "gone"));
        else {
          const next = {
            ...env.app,
            ...(retirement === "account"
              ? { accountId: "next" }
              : { controllerScope: {} }),
          };
          if (page === "projects") await env.project(next);
          else await env.gallery(galleryProps, next);
          assert.equal(
            env.document.querySelector<HTMLInputElement>("input")?.value ?? "",
            "",
          );
        }
        await env.wait();
        assert.equal(param(env, "search"), null, retirement);
      } finally {
        await env.clean();
      }
    }
  });

test("Projects accepts only source sort/archive/group values and writes created_at and group=none from actual controls", async () => {
  const env = await environment(
    "/projects?sort_by=bad&archived=1&group=type&category=future&view=tasks&keep=yes",
  );
  try {
    await env.project();
    assert.equal(
      env.document.querySelector('[role="tab"][aria-selected="true"]')
        ?.textContent,
      "Your projects",
    );
    assert.equal(
      env.document.querySelector(".prj-group-heading")?.textContent,
      "Code",
    );
    await env.click('[aria-label="Sort projects"]');
    await env.select("Date created");
    assert.equal(param(env, "sort_by"), "created_at");
    await env.click('[aria-label="Sort projects"]');
    await env.select("Group by type");
    assert.equal(param(env, "group"), "none");
    assert.deepEqual(names(env), ["Zulu", "Beta", "Alpha"]);
    assert.equal(param(env, "category"), "future");
    assert.equal(param(env, "view"), "tasks");
    await env.select("Archived");
    assert.equal(param(env, "category"), "mine");
    assert.equal(param(env, "view"), null);
  } finally {
    await env.clean();
  }
});

test("Gallery search replaces after the source debounce, flushes Escape and retains template parameters", async (context) => {
  const env = await environment(
    "/artifacts?tab=mine&template=slides#settings/data-privacy-controls",
  );
  try {
    await env.gallery();
    const length = env.window.history.length;
    await env.click('[aria-label="Search your artifacts"]');
    context.mock.timers.enable({ apis: ["setTimeout"] });
    await env.change("input", "Alpha");
    assert.equal(
      env.document.querySelectorAll(".artifacts-grid > li").length,
      1,
    );
    await act(async () => context.mock.timers.tick(299));
    assert.equal(param(env, "search"), null);
    await act(async () => context.mock.timers.tick(1));
    assert.equal(param(env, "search"), "Alpha");
    await env.change("input", "uncommitted");
    await env.event(env.document.querySelector("input")!, "keydown", {
      key: "Escape",
    });
    assert.equal(param(env, "search"), null);
    assert.equal(env.document.querySelector("input"), null);
    await act(async () => context.mock.timers.tick(330));
    assert.equal(param(env, "search"), null);
    assert.equal(param(env, "template"), "slides");
    assert.equal(env.window.location.hash, "#settings/data-privacy-controls");
    assert.equal(env.window.history.length, length);
  } finally {
    context.mock.timers.reset();
    await env.clean();
  }
});

for (const surface of ["chat", "code"] as const)
  test(`the mounted ${surface} gallery router preserves tab/search through canonicalization, refresh, and Settings history`, async () => {
    const env = await environment(
      `/artifacts?tab=mine&search=Alpha&template=docs&keep=中${surface === "code" ? "&surface=code" : ""}`,
    );
    Object.assign(env.app, {
      page: "artifacts",
      mode: surface,
      settingsOpen: false,
      settingsTab: "general",
      search: null,
      incognitoShown: false,
      setPage(value: string) {
        env.app.page = value as Controller["page"];
      },
      setMode(value: Controller["mode"]) {
        env.app.mode = value;
      },
      setSettingsOpen(value: boolean) {
        env.app.settingsOpen = value;
      },
      setSearch(value: string | null) {
        env.app.search = value;
      },
      openSettingsTab(value: string) {
        env.app.settingsTab = value as Controller["settingsTab"];
        env.app.settingsOpen = true;
      },
      report(reason: unknown) {
        throw reason;
      },
    });
    try {
      await env.routedGallery();
      assert.equal(param(env, "search"), "Alpha");
      assert.equal(param(env, "tab"), "mine");
      assert.equal(param(env, "template"), "docs");
      assert.equal(param(env, "surface"), surface === "code" ? "code" : null);
      assert.equal(
        env.document.querySelector<HTMLInputElement>(
          'input[aria-label="Search your artifacts"]',
        )?.value,
        "Alpha",
      );
      assert.equal(
        env.document.querySelector('[role="tab"][aria-selected="true"]')
          ?.textContent,
        "Yours",
      );
      await env.select("Shared with you");
      assert.equal(param(env, "tab"), "shared");
      env.app.openSettingsTab("general");
      await env.routedGallery();
      assert.equal(env.window.location.hash, "#settings/general");
      assert.equal(param(env, "tab"), "shared");
      assert.equal(param(env, "keep"), "中");
      await env.travel("back");
      assert.equal(env.app.settingsOpen, false);
      assert.equal(param(env, "tab"), "shared");
      await env.travel("forward");
      assert.equal(env.app.settingsOpen, true);
      assert.equal(param(env, "search"), "Alpha");
    } finally {
      await env.clean();
    }
  });

test("gallery query preservation owns only its collection and lets routing replace Code and Settings state", async () => {
  const { withProjectQuery } = await import("../../src/web/project-query");
  const current = {
    pathname: "/artifacts",
    search: "?tab=mine&search=Alpha&template=docs&surface=code&connector=old",
  };
  assert.equal(
    withProjectQuery("/artifacts", current),
    "/artifacts?tab=mine&search=Alpha&template=docs",
  );
  assert.equal(
    withProjectQuery(
      "/artifacts?surface=code&connector=new#settings/connectors",
      current,
    ),
    "/artifacts?tab=mine&search=Alpha&template=docs&surface=code&connector=new#settings/connectors",
  );
  assert.equal(withProjectQuery("/projects", current), "/projects");
  assert.equal(
    withProjectQuery("/artifacts", {
      pathname: "/projects",
      search: "?search=Other",
    }),
    "/artifacts",
  );
});
