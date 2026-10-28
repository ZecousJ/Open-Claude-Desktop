import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h, createRef } from "react";
import type { Project } from "../../shared/types";
import type {
  KnowledgeFile,
  KnowledgePreview,
} from "../../shared/collections-api";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { ProjectHubCards } from "../../src/collections/projects/ProjectHubCards";
import { routineDom } from "../support/routine-dom";

const project: Project = {
  id: "p",
  name: "Project",
  description: "",
  instructions: "",
  createdAt: 1,
};
const csv = 'item,value\r\nalpha,1\r\n"beta, quoted",2\r\n"two\nlines","3"\r\n';
const files: KnowledgeFile[] = [
  {
    name: "project sample.csv",
    bytes: Buffer.byteLength(csv),
    addedAt: Date.UTC(2026, 8, 26),
  },
  { name: "notes.html", bytes: 100, addedAt: Date.UTC(2026, 8, 27) },
];
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
async function environment({
  twoPane = true,
  knowledgeFiles = files,
  sync = async (_id: string, _name: string) => ({
    files: knowledgeFiles,
    bytes: 150,
    limit: 10000,
    fileLimit: 10000,
  }),
  read = async (_id: string, name: string): Promise<KnowledgePreview> => ({
    name,
    bytes: 20,
    kind: "text",
    text: name.endsWith("csv")
      ? csv
      : '<script>window.executed = true</script><svg onload="alert(1)">text</svg>',
  }),
} = {}) {
  const calls: string[][] = [];
  const env = await routineDom(
    {
      memoryStatus: async () => ({
        available: false,
        reason: "unsupported",
        allowed: { searchChats: true, generate: true },
        prefs: { searchChats: true, generate: true },
        synthesizing: false,
      }),
      listProjectKnowledge: async () => ({
        files: knowledgeFiles,
        bytes: 150,
        limit: 10000,
        fileLimit: 10000,
      }),
      readProjectKnowledge: async (id, name) => {
        calls.push([id, name]);
        return read(id, name);
      },
      syncProjectKnowledge: sync,
      listProjectKnowledgeDriveConnectors: async () => [],
      listProjectKnowledgeMcpServers: async () => [],
      listProjectKnowledgeRepositories: async () => [],
    },
    { jsdom: true },
  );
  const saved = new Map(
    ["innerWidth", "innerHeight", "cancelAnimationFrame"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  Object.defineProperty(globalThis, "innerWidth", {
    configurable: true,
    value: twoPane ? 1280 : 390,
  });
  Object.defineProperty(globalThis, "innerHeight", {
    configurable: true,
    value: 720,
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: env.window.requestAnimationFrame.bind(env.window),
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: env.window.cancelAnimationFrame.bind(env.window),
  });
  const listeners = new Set<() => void>();
  const media = {
    matches: twoPane,
    addEventListener: (_: string, callback: () => void) =>
      listeners.add(callback),
    removeEventListener: (_: string, callback: () => void) =>
      listeners.delete(callback),
  };
  env.window.matchMedia = ((query: string) =>
    query === "(min-width: 768px)"
      ? media
      : {
          matches: true,
          addEventListener() {},
          removeEventListener() {},
        }) as never;
  const reference = { current: undefined as AppController | undefined };
  const owner = {
    accountId: "owner",
    controllerScope: {},
    currentController: reference,
    snapshot: { projects: [project] },
  } as unknown as AppController;
  reference.current = owner;
  await env.render(
    h(
      AppContext.Provider,
      { value: owner },
      h(ProjectHubCards, {
        project,
        tasks: [],
        onInstructions() {},
        onAddTask() {},
        onUnlinkTask: async () => {},
        onError(error) {
          throw error;
        },
        memoryAction: createRef<(anchor?: HTMLButtonElement) => void>(),
        scheduling: false,
      }),
    ),
  );
  await env.click('[aria-label="Show context"]');
  const open = async (name = files[0].name) => {
    await env.click(`button[aria-label="${name}"]`);
    await settle();
  };
  return {
    ...env,
    calls,
    owner,
    reference,
    open,
    async resize(value: boolean) {
      await act(async () => {
        media.matches = value;
        listeners.forEach((callback) => callback());
      });
    },
    async clean() {
      await env.clean();
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("hub CSV opens beside the retained list in the same Context dialog, with actual table cells and metadata", async () => {
  const env = await environment();
  try {
    const dialog = env.document.querySelector('[role="dialog"]');
    const list = env.document.querySelector(".prj-context-list");
    await env.open();
    assert.equal(env.document.querySelectorAll('[role="dialog"]').length, 1);
    assert.ok(dialog?.parentElement?.parentElement === env.document.body);
    assert.ok(env.document.querySelector('[role="dialog"]') === dialog);
    assert.ok(env.document.querySelector(".prj-context-list") === list);
    assert.equal(
      env.document.querySelector<HTMLElement>(".prj-knowledge-list-pane")
        ?.hidden,
      false,
    );
    assert.equal(
      env.document
        .querySelector(".prj-context-row[data-viewing] button")
        ?.getAttribute("aria-label"),
      files[0].name,
    );
    assert.equal(
      env.document.querySelector(".prj-knowledge-preview-header h3 > span")
        ?.textContent,
      "project sample",
    );
    assert.match(
      env.document.querySelector(".prj-knowledge-preview-header small")
        ?.textContent ?? "",
      /CSV.*B/,
    );
    assert.equal(
      env.document
        .querySelector(".prj-knowledge-preview-header time")
        ?.getAttribute("datetime"),
      new Date(files[0].addedAt).toISOString(),
    );
    assert.deepEqual(
      [...env.document.querySelectorAll("th")].map((item) => item.textContent),
      ["item", "value"],
    );
    assert.deepEqual(
      [...env.document.querySelectorAll("td")].map((item) => item.textContent),
      ["alpha", "1", "beta, quoted", "2", "two\nlines", "3"],
    );
    await env.click('[aria-label="Close preview"]');
    assert.ok(env.document.querySelector('[role="dialog"]') === dialog);
    assert.equal(
      env.document.querySelector(".prj-knowledge-preview-pane"),
      null,
    );
    assert.ok(
      env.document.activeElement ===
        env.document.querySelector(`button[aria-label="${files[0].name}"]`),
    );
    assert.equal(
      env.document.querySelector(".prj-context-row[data-viewing]"),
      null,
    );
  } finally {
    await env.clean();
  }
});

test("pane loading, read failure, retry and unsupported content retain the same list and dialog", async () => {
  let attempts = 0;
  const env = await environment({
    read: async (_id, name) => {
      attempts++;
      if (attempts === 1) throw Error("read refused");
      return { name, bytes: 5, kind: "unsupported", reason: "encoding" };
    },
  });
  try {
    const dialog = env.document.querySelector('[role="dialog"]');
    await env.open();
    assert.match(
      env.document.querySelector('[role="alert"]')?.textContent ?? "",
      /Failed to load file/,
    );
    const retry = [...env.document.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    )!;
    await env.event(retry, "click");
    assert.equal(attempts, 2);
    assert.match(
      env.document.querySelector(".prj-knowledge-preview-pane")?.textContent ??
        "",
      /No preview.*not UTF-8/s,
    );
    assert.equal(
      env.document.querySelector('[aria-label="Download file"]'),
      null,
    );
    assert.equal(
      env.document.querySelector(".prj-knowledge-preview-pane iframe"),
      null,
    );
    assert.ok(env.document.querySelector('[role="dialog"]') === dialog);
    await env.click('[aria-label="Close preview"]');
    assert.equal(env.document.querySelectorAll(".prj-context-row").length, 2);
  } finally {
    await env.clean();
  }
});

test("switching files during a delayed read rejects the old result and keeps HTML and SVG inert", async () => {
  let release!: (value: KnowledgePreview) => void;
  const pending = new Promise<KnowledgePreview>(
    (resolve) => (release = resolve),
  );
  const markup =
    '<script>window.executed=true</script><svg onload="alert(1)">reference</svg>';
  const env = await environment({
    read: async (_id, name) =>
      name.endsWith("csv")
        ? pending
        : { name, bytes: 10, kind: "text", text: markup },
  });
  try {
    await env.open();
    assert.match(
      env.document.querySelector('.prj-knowledge-preview-pane [role="status"]')
        ?.textContent ?? "",
      /Loading file/,
    );
    await env.open("notes.html");
    await act(async () =>
      release({ name: files[0].name, bytes: 10, kind: "text", text: csv }),
    );
    assert.equal(env.document.querySelector("pre")?.textContent, markup);
    assert.equal(
      env.document.querySelector(
        ".prj-knowledge-preview-pane script, .prj-knowledge-preview-pane svg:not([data-icon])",
      ),
      null,
    );
    assert.equal(env.document.querySelector("table"), null);
    assert.equal(env.document.querySelectorAll('[role="dialog"]').length, 1);
  } finally {
    await env.clean();
  }
});

test("phone drills into one preview pane and Back restores the same searched list and focus", async () => {
  const env = await environment({ twoPane: false });
  try {
    await env.click('[aria-label="Search files"]');
    await env.change(".prj-knowledge-search", "sample");
    const list = env.document.querySelector(".prj-context-list");
    await env.open();
    assert.equal(
      env.document.querySelector<HTMLElement>(".prj-knowledge-list-pane")
        ?.hidden,
      true,
    );
    assert.equal(
      env.document.querySelector('[aria-label="Close preview"]'),
      null,
    );
    assert.equal(env.document.querySelectorAll('[role="dialog"]').length, 1);
    await env.click('[aria-label="Back to context"]');
    assert.equal(
      env.document.querySelector<HTMLElement>(".prj-knowledge-list-pane")
        ?.hidden,
      false,
    );
    assert.ok(env.document.querySelector(".prj-context-list") === list);
    assert.equal(
      env.document.querySelector<HTMLInputElement>(".prj-knowledge-search")
        ?.value,
      "sample",
    );
    assert.ok(
      env.document.activeElement ===
        env.document.querySelector(`button[aria-label="${files[0].name}"]`),
    );
  } finally {
    await env.clean();
  }
});

test("Escape first closes only the preview and then the Context dialog", async () => {
  const env = await environment();
  try {
    await env.open();
    await env.event(
      env.document.querySelector('[aria-label="Close preview"]')!,
      "keydown",
      { key: "Escape" },
    );
    assert.equal(
      env.document.querySelector(".prj-knowledge-preview-pane"),
      null,
    );
    assert.equal(env.document.querySelectorAll('[role="dialog"]').length, 1);
    await env.event(env.document, "keydown", { key: "Escape" });
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
  } finally {
    await env.clean();
  }
});

test("resizing an open pane keeps one dialog; keyboard focus cycles through the visible phone pane", async () => {
  const env = await environment();
  try {
    await env.open();
    await env.resize(false);
    const back = env.document.querySelector<HTMLElement>(
      '[aria-label="Back to context"]',
    )!;
    const download = env.document.querySelector<HTMLElement>(
      '[aria-label="Download file"]',
    )!;
    assert.ok(env.document.activeElement === back);
    download.focus();
    const tab = await env.event(download, "keydown", { key: "Tab" });
    assert.equal(tab.defaultPrevented, true);
    assert.ok(env.document.activeElement === back);
    await env.event(back, "keydown", { key: "Tab", shiftKey: true });
    assert.ok(env.document.activeElement === download);
    await env.resize(true);
    assert.equal(
      env.document.querySelector<HTMLElement>(".prj-knowledge-list-pane")
        ?.hidden,
      false,
    );
    assert.ok(env.document.querySelector('[aria-label="Close preview"]'));
    assert.equal(env.document.querySelectorAll('[role="dialog"]').length, 1);
  } finally {
    await env.clean();
  }
});

for (const retirement of [
  "account",
  "controller",
  "bridge",
  "project",
] as const)
  test(`same-dialog preview ignores a delayed response after ${retirement} retirement`, async () => {
    let release!: (value: KnowledgePreview) => void;
    const pending = new Promise<KnowledgePreview>(
      (resolve) => (release = resolve),
    );
    const env = await environment({ read: async () => pending });
    try {
      await env.open();
      if (retirement === "account")
        env.reference.current = { ...env.owner, accountId: "replacement" };
      if (retirement === "controller")
        env.reference.current = { ...env.owner, controllerScope: {} };
      if (retirement === "bridge")
        env.window.desktop = { ...env.window.desktop };
      if (retirement === "project")
        env.reference.current = {
          ...env.owner,
          snapshot: { ...env.owner.snapshot, projects: [] },
        };
      await act(async () =>
        release({ name: files[0].name, bytes: 10, kind: "text", text: csv }),
      );
      assert.equal(env.document.querySelector("table"), null);
      assert.equal(
        env.document.querySelector('[aria-label="Download file"]'),
        null,
      );
      assert.deepEqual(env.calls, [["p", files[0].name]]);
    } finally {
      await env.clean();
    }
  });

test("initial Context dialog keyboard navigation stays within visible controls", async () => {
  const env = await environment();
  try {
    const dialog = env.document.querySelector<HTMLElement>('[role="dialog"]')!;
    dialog.focus();
    await env.event(dialog, "keydown", { key: "Tab" });
    assert.ok(
      env.document.activeElement ===
        env.document.querySelector('[aria-label="Search files"]'),
    );
    dialog.focus();
    await env.event(dialog, "keydown", { key: "Tab", shiftKey: true });
    assert.ok(
      env.document.activeElement ===
        env.document.querySelectorAll(".prj-context-more").item(1),
    );
  } finally {
    await env.clean();
  }
});

test("same-dialog Download retains exact CSV bytes and refuses a retained action after owner retirement", async () => {
  const env = await environment();
  const copied: Blob[] = [];
  const create = Object.getOwnPropertyDescriptor(URL, "createObjectURL"),
    revoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  const click = env.window.HTMLAnchorElement.prototype.click;
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: (blob: Blob) => {
      copied.push(blob);
      return "blob:knowledge-test";
    },
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value() {},
  });
  env.window.HTMLAnchorElement.prototype.click = function () {};
  try {
    await env.open();
    const download = env.document.querySelector(
      '[aria-label="Download file"]',
    )!;
    await env.event(download, "click");
    assert.equal(await copied[0].text(), csv);
    env.reference.current = { ...env.owner, accountId: "replacement" };
    await env.event(download, "click");
    assert.equal(copied.length, 1);
  } finally {
    env.window.HTMLAnchorElement.prototype.click = click;
    if (create) Object.defineProperty(URL, "createObjectURL", create);
    else Reflect.deleteProperty(URL, "createObjectURL");
    if (revoke) Object.defineProperty(URL, "revokeObjectURL", revoke);
    else Reflect.deleteProperty(URL, "revokeObjectURL");
    await env.clean();
  }
});

for (const state of ["failed", "inaccessible"] as const)
  test(`source ${state} keeps its cached preview and exposes only supported source actions`, async () => {
    const linked: KnowledgeFile = {
      name: "linked.md",
      bytes: 10,
      addedAt: 1,
      source: {
        provider: "mcp",
        server: "Research",
        uri: "test://page",
        name: "Source page",
        status: state,
        failure: state === "failed" ? "temporary" : "forbidden",
        lastSyncedAt: 1,
      },
    };
    const synced: string[][] = [];
    const env = await environment({
      knowledgeFiles: [linked],
      read: async (_id, name) => ({
        name,
        bytes: 10,
        kind: "text",
        text: "cached source reference",
      }),
      sync: async (id, name) => {
        synced.push([id, name]);
        return { files: [linked], bytes: 10, limit: 10000, fileLimit: 10000 };
      },
    });
    try {
      const status = env.document.querySelector(".prj-context-row small")!;
      assert.equal(
        Boolean(status.querySelector('[data-icon="Warning"]')),
        state === "failed",
      );
      assert.equal(
        status.classList.contains("prj-sync-inaccessible"),
        state === "inaccessible",
      );
      await env.click('[aria-label="More options for Source page"]');
      const menu = env.document.querySelector('[role="menu"]')!;
      const labels = [...menu.querySelectorAll('[role="menuitem"]')].map(
        (item) => item.lastElementChild?.textContent?.trim(),
      );
      assert.ok(labels.includes("Remove from project"), JSON.stringify(labels));
      assert.equal(labels.includes("Check source again"), false);
      if (state === "failed") {
        const retry = [...menu.querySelectorAll('[role="menuitem"]')].find(
          (item) => item.lastElementChild?.textContent?.trim() === "Retry sync",
        )!;
        assert.ok(retry);
        await env.event(retry, "click");
        assert.deepEqual(synced, [["p", "linked.md"]]);
      } else {
        assert.deepEqual(labels, ["Remove from project"]);
        await env.event(menu, "keydown", { key: "Escape" });
        assert.deepEqual(synced, []);
      }
      await env.open("Source page");
      assert.equal(
        env.document.querySelector("pre")?.textContent,
        "cached source reference",
      );
      assert.equal(env.document.querySelectorAll('[role="dialog"]').length, 1);
    } finally {
      await env.clean();
    }
  });

test("the actual knowledge PDF descriptor selects the binary PDF runtime rather than an empty HTML fallback", async () => {
  const { knowledgePdfArtifact } =
    await import("../../src/collections/projects/KnowledgePreview");
  const { artifactKind } = await import("../../src/artifacts/artifact-kind");
  const descriptor = knowledgePdfArtifact({
    name: "summary.pdf",
    bytes: 5,
    kind: "pdf",
    base64: "JVBERi0=",
  });
  assert.equal(artifactKind(descriptor), "pdf");
  assert.equal(descriptor.blob, true);
});

test("late search animation frames cannot steal the restored file focus after a fast phone preview and Back", async () => {
  const env = await environment({ twoPane: false });
  const beforeRaf = Object.getOwnPropertyDescriptor(
      globalThis,
      "requestAnimationFrame",
    ),
    beforeCancel = Object.getOwnPropertyDescriptor(
      globalThis,
      "cancelAnimationFrame",
    );
  let next = 0;
  const frames = new Map<number, FrameRequestCallback>();
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) => {
      frames.set(++next, callback);
      return next;
    },
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: (id: number) => frames.delete(id),
  });
  const paint = () =>
    act(async () => {
      const pending = [...frames];
      frames.clear();
      for (const [, callback] of pending) callback(0);
    });
  try {
    await env.click('[aria-label="Search files"]');
    await env.change(".prj-knowledge-search", "sample");
    await paint();
    await paint();
    assert.ok(
      frames.size > 0,
      "the actual deferred focus frame is still outstanding",
    );
    await env.open();
    await env.click('[aria-label="Back to context"]');
    const row = env.document.querySelector(
      `button[aria-label="${files[0].name}"]`,
    );
    assert.equal(env.document.activeElement, row);
    await paint();
    await paint();
    assert.equal(env.document.activeElement, row);
  } finally {
    if (beforeRaf)
      Object.defineProperty(globalThis, "requestAnimationFrame", beforeRaf);
    if (beforeCancel)
      Object.defineProperty(globalThis, "cancelAnimationFrame", beforeCancel);
    await env.clean();
  }
});
