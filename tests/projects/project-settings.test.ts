import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { Project } from "../../shared/types";
import { desktopHost, webHost, type HostInfo } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { ProjectSettingsDialog } from "../../src/dialogs/ProjectSettingsDialog";
import { ProjectOverview } from "../../src/collections/projects/ProjectOverview";
import { projectIcons, projectColors } from "../../src/dialogs/project-icons";
import { projectChanged } from "../../src/collections/projects/project-list";

const project: Project = {
  id: "garden",
  name: "Garden",
  description: "Original description",
  instructions: "Stay concise.",
  createdAt: 1,
};

test("project settings retains the official icon and color choices and tracks defaults", () => {
  assert.equal(Object.keys(projectIcons).length, 84);
  assert.equal(Object.keys(projectColors).length, 18);
  for (const change of [
    { icon: "Beaker" },
    { color: "blue" },
    { defaultModel: "model" },
    { defaultProviderId: "provider" },
    { defaultEffort: "medium" as const },
  ]) {
    assert.equal(projectChanged(project, { ...project, ...change }), true);
  }
  const html = renderToStaticMarkup(
    createElement(ProjectSettingsDialog, {
      project,
      providers: [],
      onChange() {},
      onClose() {},
      onSave: async () => {},
      onArchive() {},
      onDelete() {},
      onError(error) {
        throw error;
      },
    }),
  );
  assert.match(html, /Project settings/);
  assert.match(html, /Name and icon/);
  assert.match(html, /maxLength="200"/);
  assert.match(html, /Project instructions/);
  assert.match(html, /aria-label="Model" aria-haspopup="listbox"/);
  assert.match(html, /<span>Default<\/span>/);
  assert.doesNotMatch(
    html,
    /Description \(optional\)|Working folder|type="submit"[^>]*disabled/,
  );
});

test("project header exposes functional pin state and archived/example badges", () => {
  const page = (value: Project, host: HostInfo = webHost) =>
    renderToStaticMarkup(
      createElement(
        HostContext.Provider,
        { value: host },
        createElement(ProjectOverview, {
          project: value,
          chats: [],
          composer: null,
          menuOpen: false,
          onBack() {},
          onMenu() {},
          onSave: async () => {},
          onScheduled() {},
          onOpenConversation() {},
        }),
      ),
    );
  assert.match(page(project), /aria-label="Pin project" aria-pressed="false"/);
  assert.match(
    page({ ...project, pinned: true }),
    /aria-label="Unpin project" aria-pressed="true"/,
  );
  assert.match(
    page(project, desktopHost),
    /aria-label="Pin project" aria-pressed="false"/,
  );
  assert.match(
    page({ ...project, pinned: true }, desktopHost),
    /aria-label="Unpin project" aria-pressed="true"/,
  );
  const archived = page({ ...project, archivedAt: 1, isStarterProject: true });
  assert.match(archived, /Archived/);
  assert.match(archived, /Example project/);
  assert.doesNotMatch(
    archived,
    /aria-label="(?:Unpin|Pin|Star|Unstar) project"/,
  );
});

test("settings icon choices, defaults, Save, and Advanced actions work", async () => {
  const { window } = parseHTML("<html><body><main></main></body></html>");
  const globals = {
    window,
    document: window.document,
    navigator: { userAgent: "node" },
    Node: window.Node,
    innerWidth: 1024,
    innerHeight: 768,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
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
  const { createRoot } = await import("react-dom/client");
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    top: 0,
    left: 0,
    right: 400,
    bottom: 32,
    width: 224,
    height: 32,
    x: 0,
    y: 0,
    toJSON() {},
  });
  const { flushSync } = await import("react-dom");
  const root = createRoot(window.document.querySelector("main")!);
  let draft = project;
  let savedProject: Project | undefined;
  let archived = 0;
  let deleted = 0;
  let failSave = false;
  let errorMessage = "";
  const render = () =>
    flushSync(() =>
      root.render(
        createElement(ProjectSettingsDialog, {
          project: draft,
          providers: [
            {
              id: "provider",
              name: "Provider",
              protocol: "responses",
              baseUrl: "https://example.test",
              model: "model",
              models: ["model"],
            },
          ],
          onChange(value) {
            draft = value;
            render();
          },
          onClose() {},
          onSave: async (value) => {
            if (failSave) throw new Error("offline");
            savedProject = value;
          },
          onArchive() {
            archived++;
          },
          onDelete() {
            deleted++;
          },
          onError(error) {
            errorMessage = (error as Error).message;
          },
        }),
      ),
    );
  const click = (selector: string) =>
    flushSync(() =>
      window.document.querySelector<HTMLButtonElement>(selector)!.click(),
    );
  try {
    render();
    click('[aria-label="Customize project icon and color"]');
    assert.equal(
      window.document.querySelectorAll('.prj-settings-icons [role="radio"]')
        .length,
      84,
    );
    click('[aria-label="Beaker"]');
    click('[aria-label="Deep blue"]');
    assert.equal(draft.icon, "Beaker");
    assert.equal(draft.color, "blue-deep");
    click(".prj-settings-icon-picker > button");
    assert.equal(draft.icon, undefined);
    assert.equal(draft.color, undefined);
    click('[aria-label="Customize project icon and color"]');
    click('button[aria-label="Model"]');
    flushSync(() =>
      [...window.document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((option) => option.textContent === "model")!
        .click(),
    );
    assert.equal(draft.defaultModel, "model");
    assert.equal(draft.defaultProviderId, "provider");
    click('button[aria-label="Effort"]');
    flushSync(() =>
      [...window.document.querySelectorAll<HTMLElement>('[role="option"]')]
        .find((option) => option.textContent === "Medium")!
        .click(),
    );
    assert.equal(draft.defaultEffort, "medium");
    flushSync(() =>
      window.document
        .querySelector("form")!
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    const saveButton = () =>
      window.document.querySelector<HTMLButtonElement>(
        'button[type="submit"]',
      )!;
    // Await the rendered idle state as well as the callback; a fixed50ms can
    // submit again while React still renders the previous busy closure.
    for (
      let i = 0;
      i < 100 &&
      (savedProject?.defaultModel !== "model" || saveButton().disabled);
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(savedProject?.defaultModel, "model");
    assert.equal(saveButton().disabled, false);
    failSave = true;
    flushSync(() =>
      window.document
        .querySelector("form")!
        .dispatchEvent(
          new window.Event("submit", { bubbles: true, cancelable: true }),
        ),
    );
    // The failed save settles asynchronously; give a busy machine time.
    for (let i = 0; i < 100 && (!errorMessage || saveButton().disabled); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      errorMessage,
      "Couldn’t save settings. Click Save again to retry.",
    );
    assert.equal(
      window.document.querySelector<HTMLButtonElement>('button[type="submit"]')!
        .disabled,
      false,
    );
    const advanced = [
      ...window.document.querySelectorAll<HTMLButtonElement>("nav button"),
    ].find((button) => button.textContent === "Advanced")!;
    flushSync(() => advanced.click());
    assert.match(window.document.body.textContent!, /Danger zone/);
    click(".prj-settings-row button");
    click(".prj-settings-delete");
    assert.equal(archived, 1);
    assert.equal(deleted, 1);
  } finally {
    flushSync(() => root.unmount());
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
