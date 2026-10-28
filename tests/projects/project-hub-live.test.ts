import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement, createRef } from "react";
import { parseHTML } from "linkedom";
import type { DesktopAPI, Project } from "../../shared/types";
import type { ProjectKnowledge } from "../../shared/collections-api";
import type { MemoryStatus } from "../../shared/memory-api";
import type { Routine } from "../../shared/routines";
import { ProjectHubCards } from "../../src/collections/projects/ProjectHubCards";
import { createFixtureDesktop } from "../../scripts/preview/app-fixture";
import { setLocale, t } from "../../src/i18n";

const project: Project = {
  id: "p",
  name: "Real project {name}",
  description: "",
  instructions: "Keep {user} text",
  createdAt: 1,
};
const prefs = { searchChats: true, generate: true };
const memoryStatus: MemoryStatus = {
  available: false,
  reason: "unsupported",
  allowed: prefs,
  prefs,
  synthesizing: false,
};
const knowledge = (count: number): ProjectKnowledge => ({
  files: Array.from({ length: count }, (_, index) => ({
    name: `file-${index}.txt`,
    bytes: 3,
    addedAt: 1,
  })),
  bytes: count * 3,
  limit: 10000,
  fileLimit: 10000,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function environment(bridge: Partial<DesktopAPI> = {}) {
  const { window, document } = parseHTML(
    '<html data-motion="reduced"><body><button id="anchor"></button><main></main></body></html>',
  );
  (document as unknown as { oninput: null }).oninput = null;
  window.desktop = {
    listProjectKnowledge: async () => knowledge(1),
    memoryStatus: async () => memoryStatus,
    onEvent: () => () => {},
    ...bridge,
  } as unknown as DesktopAPI;
  window.matchMedia = (() => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
  const globals = {
    window,
    document,
    innerWidth: 1440,
    innerHeight: 900,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: () => ({ getPropertyValue: () => "0" }),
    CSS: { escape: (value: string) => value },
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
  const proto = window.HTMLElement.prototype;
  const focus = Object.getOwnPropertyDescriptor(proto, "focus"),
    bounds = Object.getOwnPropertyDescriptor(proto, "getBoundingClientRect");
  let focused: HTMLElement | undefined;
  proto.focus = function () {
    focused = this;
  };
  proto.getBoundingClientRect = () => ({
    x: 1060,
    y: 150,
    left: 1060,
    top: 150,
    width: 344,
    height: 53,
    right: 1404,
    bottom: 203,
    toJSON() {},
  });
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => (focused?.isConnected ? focused : document.body),
  });
  const inputType = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "type",
  );
  Object.defineProperty(window.HTMLInputElement.prototype, "type", {
    configurable: true,
    get(this: HTMLInputElement) {
      return this.getAttribute("type") || "text";
    },
  });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const render = async (child: ReturnType<typeof createElement> | null) => {
    await act(async () => {
      root.render(child);
    });
  };
  const click = async (target: string | Element) => {
    await act(async () => {
      const element =
        typeof target === "string"
          ? document.querySelector<HTMLElement>(target)!
          : (target as HTMLElement);
      element.focus();
      element.click();
    });
  };
  const change = async (selector: string, value: string) => {
    const field = document.querySelector<
      HTMLInputElement | HTMLTextAreaElement
    >(selector)!;
    const prototype =
      field.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        field,
        value,
      );
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  };
  const clean = async () => {
    await act(async () => root.unmount());
    if (focus) Object.defineProperty(proto, "focus", focus);
    else Reflect.deleteProperty(proto, "focus");
    if (bounds) Object.defineProperty(proto, "getBoundingClientRect", bounds);
    else Reflect.deleteProperty(proto, "getBoundingClientRect");
    if (inputType)
      Object.defineProperty(
        window.HTMLInputElement.prototype,
        "type",
        inputType,
      );
    else Reflect.deleteProperty(window.HTMLInputElement.prototype, "type");
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  return { window, document, render, click, change, clean };
}
const props = () => ({
  project,
  tasks: [],
  onInstructions() {},
  onAddTask() {},
  onUnlinkTask: async () => {},
  onError() {},
  memoryAction: createRef<((anchor?: HTMLButtonElement) => void) | undefined>(),
  scheduling: true,
});

test("hub renders only the three captured cards and real context counts; stale project replies cannot replace the current count", async () => {
  const old = deferred<ProjectKnowledge>(),
    current = deferred<ProjectKnowledge>();
  const page = await environment({
    listProjectKnowledge: (id) => (id === "p" ? old.promise : current.promise),
  });
  const value = props();
  try {
    await page.render(createElement(ProjectHubCards, value));
    assert.deepEqual(
      Array.from(
        page.document.querySelectorAll(".prj-hub-card-title"),
        (element) => element.textContent,
      ),
      ["Instructions", "Context", "Scheduled"],
    );
    assert.equal(page.document.querySelector(".prj-context-name"), null);
    assert.match(
      page.document.querySelector(".prj-hub-cards")!.textContent!,
      /Loading…/,
    );
    assert.doesNotMatch(
      page.document.querySelector(".prj-hub-cards")!.textContent!,
      /0 files|Private/,
    );
    assert.equal(value.memoryAction.current, undefined);
    await page.render(
      createElement(ProjectHubCards, {
        ...value,
        project: { ...project, id: "q" },
      }),
    );
    await act(async () => current.resolve(knowledge(2)));
    await act(async () => old.resolve(knowledge(1)));
    assert.match(
      page.document.querySelectorAll(".prj-hub-card-meta")[1].textContent!,
      /^2 files$/,
    );
    assert.equal(
      page.document.querySelector("[data-no-translate]")!.textContent,
      project.instructions,
    );
  } finally {
    await page.clean();
  }
});

test("hub Context Add keeps late persisted results after close and rejects an older count refresh", async () => {
  let stored = knowledge(1);
  let reads = 0;
  const save = deferred<ProjectKnowledge>(),
    staleRefresh = deferred<ProjectKnowledge>();
  const writes: unknown[] = [];
  const page = await environment({
    listProjectKnowledge: async () =>
      ++reads === 3 ? staleRefresh.promise : structuredClone(stored),
    addProjectKnowledgeText: async (id, file) => {
      writes.push([id, file]);
      stored = await save.promise;
      return structuredClone(stored);
    },
  });
  try {
    await page.render(createElement(ProjectHubCards, props()));
    await page.click('.prj-hub-add[aria-label="Add to context"]');
    const addText = Array.from(
      page.document.querySelectorAll('[role="menuitem"]'),
    ).find((element) => element.textContent?.includes("Add text content"))!;
    assert.ok(addText, "Add opens the existing context add menu after loading");
    await page.click(addText);
    await page.change(".prj-text-form input", "Actual note");
    await page.change(".prj-text-form textarea", "Actual context text");
    await act(async () =>
      page.document
        .querySelector(".prj-text-form")!
        .dispatchEvent(
          new page.window.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    assert.deepEqual(writes, [
      ["p", { name: "Actual note", text: "Actual context text" }],
    ]);
    await page.click('.prj-hub-dialog > header [aria-label="Close"]');
    assert.equal(page.document.querySelector(".prj-hub-dialog"), null);
    await act(async () => save.resolve(knowledge(2)));
    await act(async () => staleRefresh.resolve(knowledge(1)));
    assert.equal(
      page.document.querySelectorAll(".prj-hub-card-meta")[1].textContent,
      "2 files",
    );
    assert.ok(
      page.document.activeElement ===
        page.document.querySelector(
          '.prj-hub-add[aria-label="Add to context"]',
        ),
      "closing restores the real Add trigger",
    );
  } finally {
    await page.clean();
  }
});

test("hub preserves capability-gated memory, real task opening/unlinking and the Add anchor", async () => {
  const task = {
    id: "task",
    name: "User task",
    projectId: project.id,
  } as Routine;
  const page = await environment({
    memoryStatus: async () => ({ ...memoryStatus, available: true }),
    memoryDoc: async () => null,
  });
  const opened: string[] = [],
    unlinked: string[] = [];
  let added: HTMLButtonElement | undefined,
    instructions = 0;
  const value = {
    ...props(),
    tasks: [task],
    onInstructions() {
      instructions++;
    },
    onAddTask(anchor: HTMLButtonElement) {
      added = anchor;
    },
    onOpenTask(routine: Routine) {
      opened.push(routine.id);
    },
    async onUnlinkTask(routine: Routine) {
      unlinked.push(routine.id);
    },
  };
  try {
    await page.render(createElement(ProjectHubCards, value));
    assert.equal(
      page.document.querySelector(".prj-hub-card-title")!.textContent,
      "Instructions",
    );
    assert.equal(page.document.querySelectorAll(".prj-hub-card").length, 3);
    assert.equal(
      page.document.querySelector(".prj-side-head"),
      null,
      "Memory stays behind its menu entry",
    );
    assert.equal(typeof value.memoryAction.current, "function");
    await act(async () =>
      value.memoryAction.current!(
        page.document.querySelector<HTMLButtonElement>("#anchor")!,
      ),
    );
    assert.match(
      page.document.querySelector(".prj-hub-dialog")!.textContent!,
      /Project memory will show here after a few chats/,
    );
    await page.click('.prj-hub-dialog > header [aria-label="Close"]');
    await page.click('.prj-hub-card-main[aria-label="Edit instructions"]');
    assert.equal(instructions, 1);
    await page.click('.prj-hub-add[aria-label="Add scheduled task"]');
    assert.equal(
      added,
      page.document.querySelector(
        '.prj-hub-add[aria-label="Add scheduled task"]',
      ),
    );
    await page.click('.prj-hub-card-main[aria-label="Scheduled tasks"]');
    await page.click(".prj-hub-task-list li button");
    await page.click('.prj-hub-task-list [aria-label="Unlink task User task"]');
    assert.deepEqual(opened, [task.id]);
    assert.deepEqual(unlinked, [task.id]);
    await page.render(null);
    assert.equal(value.memoryAction.current, undefined);
  } finally {
    await page.clean();
  }
});

test("hub failure remains unknown and retryable instead of showing an empty file count", async () => {
  let failed = true;
  const errors: unknown[] = [];
  const page = await environment({
    listProjectKnowledge: async () => {
      if (failed) throw new Error("Offline context");
      return knowledge(1);
    },
  });
  try {
    await page.render(
      createElement(ProjectHubCards, {
        ...props(),
        onError: (error) => errors.push(error),
      }),
    );
    assert.match(
      page.document.querySelectorAll(".prj-hub-card-meta")[1].textContent!,
      /Couldn’t load project context/,
    );
    assert.equal(errors.length, 1);
    assert.doesNotMatch(
      page.document.querySelector(".prj-hub-cards")!.textContent!,
      /0 files/,
    );
    failed = false;
    await page.click(".prj-hub-retry");
    assert.equal(
      page.document.querySelectorAll(".prj-hub-card-meta")[1].textContent,
      "1 file",
    );
  } finally {
    await page.clean();
  }
});

test("full fixture bridge keeps context after URL canonicalization and its actual inner Add/text flow remains usable", async () => {
  const params = new URLSearchParams(
    "projects=some&knowledge=some&fonts=system",
  );
  const bridge = createFixtureDesktop({ history: "empty" }, params);
  const snapshot = await bridge.snapshot();
  const actualProject = snapshot.projects.find(
    (value) => value.id === "p-trip",
  )!;
  assert.ok(actualProject);
  assert.equal((await bridge.listProjectKnowledge("p-site")).files.length, 8);
  params.delete("projects");
  params.delete("knowledge");
  assert.equal(
    (await bridge.listProjectKnowledge("p-site")).files.length,
    8,
    "initialized storage does not depend on the displayed URL retaining fixture flags",
  );
  for (const method of [
    "listProjectKnowledgeRepositories",
    "listProjectKnowledgeMcpServers",
    "listProjectKnowledgeDriveConnectors",
  ] as const)
    assert.deepEqual(
      await bridge[method](actualProject.id),
      [],
      "unmodeled linked sources remain honestly absent",
    );
  const page = await environment();
  page.window.desktop = bridge; // Preserve the real bridge Proxy, rather than spreading away its fallback.
  try {
    await page.render(
      createElement(ProjectHubCards, { ...props(), project: actualProject }),
    );
    assert.equal(
      page.document.querySelectorAll(".prj-hub-card-meta")[1].textContent,
      "0 files",
    );
    await page.click('.prj-hub-card-main[aria-label="Show context"]');
    await page.click('.prj-knowledge [aria-label="Add to context"]');
    const items = Array.from(
      page.document.querySelectorAll('[role="menuitem"]'),
    );
    assert.equal(items.length, 2);
    assert.doesNotMatch(
      page.document.querySelector('[role="menu"]')!.textContent!,
      /GitHub|Google Drive/,
    );
    await page.click(
      items.find((value) => value.textContent?.includes("Add text content"))!,
    );
    await page.change(".prj-text-form input", "真实备注");
    await page.change(
      ".prj-text-form textarea",
      "Context retained by the full fixture bridge.",
    );
    await act(async () => {
      page.document
        .querySelector(".prj-text-form")!
        .dispatchEvent(
          new page.window.Event("submit", { bubbles: true, cancelable: true }),
        );
    });
    assert.equal(
      (await bridge.listProjectKnowledge(actualProject.id)).files.length,
      1,
    );
    await page.click('.prj-hub-dialog > header [aria-label="Close"]');
    assert.equal(
      page.document.querySelectorAll(".prj-hub-card-meta")[1].textContent,
      "1 file",
    );
  } finally {
    await page.clean();
  }
});

test("a partial real-shape bridge returning undefined source lists cannot crash Context Add or fabricate a source", async () => {
  const bridge = createFixtureDesktop(
    { history: "empty" },
    new URLSearchParams("projects=some&fonts=system"),
  );
  const methods = new Set([
    "listProjectKnowledgeRepositories",
    "listProjectKnowledgeMcpServers",
    "listProjectKnowledgeDriveConnectors",
  ]);
  const partial = new Proxy(bridge, {
    get(target, key) {
      return typeof key === "string" && methods.has(key)
        ? async () => undefined
        : Reflect.get(target, key);
    },
  });
  const page = await environment();
  page.window.desktop = partial;
  try {
    const actualProject = (await bridge.snapshot()).projects.find(
      (value) => value.id === "p-trip",
    )!;
    await page.render(
      createElement(ProjectHubCards, { ...props(), project: actualProject }),
    );
    await page.click('.prj-hub-add[aria-label="Add to context"]');
    assert.equal(page.document.querySelectorAll('[role="menuitem"]').length, 2);
    assert.ok(page.document.querySelector(".prj-hub-dialog"));
    assert.doesNotMatch(
      page.document.querySelector('[role="menu"]')!.textContent!,
      /GitHub|Google Drive/,
    );
  } finally {
    await page.clean();
  }
});

test("long translated hub metadata preserves literal content and project actions", async () => {
  const page = await environment();
  const instructions = "ProjektkontextOhneTrennstellen".repeat(40);
  try {
    await act(async () => setLocale("de-DE"));
    await page.render(
      createElement(ProjectHubCards, {
        ...props(),
        project: { ...project, instructions },
      }),
    );
    assert.deepEqual(
      Array.from(
        page.document.querySelectorAll(".prj-hub-card-title"),
        (element) => element.textContent,
      ),
      [t("Instructions"), t("Context"), t("Scheduled")],
    );
    const metadata = page.document.querySelector(".prj-hub-card-meta")!;
    assert.equal(
      metadata.textContent,
      instructions,
      "visual clipping must not truncate or translate stored instructions",
    );
    assert.ok(metadata.hasAttribute("data-no-translate"));
    assert.equal(page.document.querySelectorAll(".prj-hub-add").length, 3);
    const actions =
      page.document.querySelectorAll<HTMLButtonElement>(".prj-hub-add");
    assert.equal(actions[0].textContent, t("Edit"));
    assert.equal(actions[0].getAttribute("aria-label"), t("Edit instructions"));
  } finally {
    await act(async () => setLocale("en-US"));
    await page.clean();
  }
});

test("standalone shell uses a scoped 40px border-box, title r6 and matching comment layer without resizing native/embedded defaults", () => {
  const css = readFileSync("src/artifacts/file-viewer-panel.css", "utf8");
  assert.match(
    css,
    /\.artifact-panel\.artifact-collaboration\[data-standalone\]\s*>\s*\.artifact-collaboration-header\s*\{[^}]*box-sizing: border-box;[^}]*height: 40px;[^}]*min-height: 40px;[^}]*border-bottom: 1px solid rgb\(255 255 255 \/ 5%\);[^}]*background: transparent;/,
  );
  assert.match(
    css,
    /\[data-standalone\]\s+\.artifact-title-options\s*\{[^}]*font-size: 13px;[^}]*border-radius: 6px;/,
  );
  assert.match(
    css,
    /\[data-standalone\]\s+\.artifact-comment-layer\s*\{[^}]*top: 40px;/,
  );
  assert.match(
    css,
    /\[data-expanded="true"\]\s*>\s*\.artifact-collaboration-header\s*\{[^}]*height: 49px;/,
  );
  // The actual FileViewer full-page/embedded predicate is exercised in
  // artifacts-b33-access; formatting its JSX is not a UI contract.
});
