import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { AppContext, type AppController } from "../../src/app/AppContext";
import HomeStarters from "../../src/starter-prompts/HomeStarters";
import {
  homeStarterContextAllowed,
  starterPromptsVisible,
} from "../../src/starter-prompts/visibility";
import {
  explicitFolderSelected,
  markExplicitFolderSelection,
  folderSelectionStillCurrent,
  useExplicitFolderSelection,
} from "../../src/composer/explicit-folder-selection";

test("source context exclusion precedes staff, count and checklist eligibility", () => {
  assert.equal(homeStarterContextAllowed(), true);
  for (const targetKind of ["cowork", "code"] as const)
    assert.equal(homeStarterContextAllowed({ targetKind }), false);
  assert.equal(
    homeStarterContextAllowed({ channelProjectSelected: true }),
    false,
  );
  for (const foldersUserTouched of [false, true])
    for (const folderSelected of [false, true])
      for (const folderScopeValid of [false, true])
        assert.equal(
          homeStarterContextAllowed({
            foldersUserTouched,
            folderSelected,
            folderScopeValid,
          }),
          !(foldersUserTouched && folderSelected && folderScopeValid),
        );
  assert.equal(starterPromptsVisible({ conversationCount: 24 }), true);
  assert.equal(starterPromptsVisible({ conversationCount: 25 }), false);
});

function controller() {
  const app = {
    accountId: "a",
    controllerScope: {},
    draftSession: "draft-a",
    mode: "cowork",
    snapshot: {
      settings: {
        homeStarters: {
          chipsOverride: "show",
          prosumer_checklist_v2: { setup_project: true },
        },
        providers: [],
        mcpServers: {},
      },
    },
    latest: { current: undefined },
    policy: { research: false },
    composerDraft: { draftConnectors: {} },
  } as unknown as AppController;
  app.currentController = { current: app };
  return app;
}

test("authorized explicit choice is account, controller and draft scoped; defaults do not touch", () => {
  const a = controller();
  assert.equal(explicitFolderSelected(a), false);
  markExplicitFolderSelection(a);
  assert.equal(explicitFolderSelected(a), true);
  assert.equal(
    explicitFolderSelected({ ...a, draftSession: "draft-b" }),
    false,
  );
  assert.equal(explicitFolderSelected({ ...a, accountId: "b" }), false);
  assert.equal(explicitFolderSelected({ ...a, controllerScope: {} }), false);
});

test("late and retained folder callbacks cannot mark another live draft or account", () => {
  for (const patch of [
    { accountId: "b" },
    { controllerScope: {} },
    { draftSession: "draft-b" },
    { activeId: "conversation" },
    { incognitoShown: true },
    { sending: true },
  ]) {
    const a = controller();
    a.currentController!.current = { ...a, ...patch };
    markExplicitFolderSelection(a);
    assert.equal(explicitFolderSelected(a), false);
  }
  const unmounted = controller();
  unmounted.currentController!.current = undefined;
  markExplicitFolderSelection(unmounted);
  assert.equal(explicitFolderSelected(unmounted), false);
});

test("folder browsing and permission completion cannot write across navigation or selection", () => {
  for (const patch of [
    { accountId: "b" },
    { controllerScope: {} },
    { draftSession: "draft-b" },
    { activeId: "conversation" },
    { incognitoShown: true },
    { sending: true },
    { cwd: "/other-folder" },
    { projectId: "other-project" },
    { mode: "code" as const },
  ]) {
    const a = controller();
    assert.equal(folderSelectionStillCurrent(a), true);
    a.currentController!.current = { ...a, ...patch };
    assert.equal(folderSelectionStillCurrent(a), false);
  }
});

test("a selected channel project hides checklist and generic starters, not merely chips", () => {
  const app = controller();
  const render = () =>
    renderToStaticMarkup(
      createElement(
        AppContext.Provider,
        { value: app },
        createElement(HomeStarters, { onPick() {}, conversationCount: 0 }),
      ),
    );
  assert.match(render(), /home-checklist/);
  app.projectId = "project";
  app.project = {
    id: "project",
    name: "Empty channel project",
  } as AppController["project"];
  assert.equal(render(), "");
  app.projectId = undefined;
  app.project = undefined;
  assert.match(render(), /home-checklist/);
});

test("actual context subscriber reacts to explicit choices and releases its old draft/scope", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
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
  const root = createRoot(document.querySelector("main")!);
  function Probe({ app }: { app: AppController }) {
    return createElement(
      "output",
      null,
      String(useExplicitFolderSelection(app)),
    );
  }
  const a = controller();
  let current = a;
  const render = () =>
    act(() => root.render(createElement(Probe, { app: current })));
  try {
    await render();
    assert.equal(document.querySelector("output")!.textContent, "false");
    await act(() => markExplicitFolderSelection(a));
    assert.equal(document.querySelector("output")!.textContent, "true");
    current = { ...a, draftSession: "draft-b" };
    a.currentController!.current = current;
    await render();
    assert.equal(document.querySelector("output")!.textContent, "false");
    await act(() => markExplicitFolderSelection(a));
    assert.equal(document.querySelector("output")!.textContent, "false");
    await act(() => markExplicitFolderSelection(current));
    assert.equal(document.querySelector("output")!.textContent, "true");
    current = controller();
    await render();
    assert.equal(document.querySelector("output")!.textContent, "false");
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
