import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { Store } from "../../electron/store/store";
import { registerBlankArtifactHandlers } from "../../electron/ipc/blank-artifacts";
import type { AppContext as BackendContext } from "../../electron/app/app-context";
import type {
  CreatedBlankArtifact,
  CreateBlankArtifactInput,
} from "../../shared/blank-artifacts";
import { artifactRouteId } from "../../src/artifacts/artifact-route-model";
import { blankConversationArtifact } from "../../src/artifacts/blank-artifact-model";
import { scheduledChatPrompt } from "../../src/sidebar/create-scheduled-chat";
import {
  onComposerSubmitRequest,
  cancelComposerSubmitFor,
} from "../../src/composer/submit-request";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { Routine } from "../../shared/routines";
import type { AppController } from "../../src/app/AppContext";
import { defaultSettings } from "../../electron/store/store";
import { readSource } from "../support/read-source";

(globalThis as { __CLAUDEX_SURFACE__?: string }).__CLAUDEX_SURFACE__ = "web";
const { AppContext } = await import("../../src/app/AppContext");
const { HostContext } = await import("../../src/host/HostContext");
const { webHost } = await import("../../shared/host");
const { SearchOverlay } = await import("../../src/app/CollectionOverlays");
const { ScheduledRoute } = await import("../../src/app/CollectionPages");
const { NavCreateMenu } = await import("../../src/sidebar/NavCreateMenu");
const { MainNav } = await import("../../src/sidebar/MainNav");
const { onScheduleRequest, requestScheduleConfirmation, takeScheduleRequest } =
  await import("../../src/collections/routines/schedule-request");
// These cases exercise navigation rather than chunk loading.
await import("../../src/collections/search/SearchPalette");
await import("../../src/collections/routines/RoutineDetail");

const noop = () => {};
const now = new Date(2026, 9, 17, 9).getTime();
const routine = (id: string, updatedAt: number): Routine => ({
  id,
  name: `Task ${id}`,
  prompt: `Instructions for ${id}`,
  mode: "cowork",
  providerId: "fixture",
  model: "Opus 5.5",
  enabled: true,
  frequency: "daily",
  repeat: { kind: "daily", time: "09:00" },
  nextRunAt: now + 86_400_000,
  executionLocation: "remote",
  permission: "auto",
  createdAt: updatedAt,
  updatedAt,
  lastRunAt: updatedAt,
});
const routines = [routine("first", now), routine("selected", now - 1)];
const host = {
  ...webHost,
  capabilities: {
    ...webHost.capabilities,
    cloudCowork: true,
    scheduledTasks: true,
  },
};

function environment(path = "/new") {
  const { window, document } = parseHTML(
    '<html data-motion="reduced"><body><main></main></body></html>',
  );
  const storage = new Map<string, string>([["cmdk-mode", "search"]]);
  const location = { pathname: "", search: "", hash: "" };
  const move = (path: string) => {
    const url = new URL(path, "http://127.0.0.1:5198");
    Object.assign(location, {
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
    });
  };
  move(path);
  const pushes: string[] = [];
  const history = {
    state: { claudex: 1 },
    pushState(_state: unknown, _title: string, url: string) {
      pushes.push(url);
      move(url);
    },
  };
  const blankRoot = fs.mkdtempSync(
    nodePath.join(os.tmpdir(), "claudex-portal-blank-"),
  );
  const blankStore = new Store(blankRoot);
  blankStore.settings.providers = [
    {
      ...defaultSettings.providers[0],
      id: "fixture",
      model: "Opus 5.5",
      models: ["Opus 5.5"],
    },
  ];
  const blankHandlers = new Map<string, (...args: any[]) => any>();
  const blankRequests: CreateBlankArtifactInput[] = [],
    blankCreations: CreatedBlankArtifact[] = [];
  registerBlankArtifactHandlers(
    (name, handler) => blankHandlers.set(name, handler),
    {
      store: blankStore,
      engine: {
        defaultWorkspace: nodePath.join(blankRoot, "workspace"),
        environment: { kind: "local" },
      },
      push: () => {},
    } as unknown as BackendContext,
  );
  window.desktop = {
    createBlankArtifact: async (input: CreateBlankArtifactInput) => {
      blankRequests.push(input);
      const created = (await blankHandlers.get("createBlankArtifact")!(
        input,
      )) as CreatedBlankArtifact;
      blankCreations.push(created);
      return created;
    },
    listSchedules: async () => routines,
    routineRuns: async () => [],
    routineCapabilities: async () => ({ remote: true, setupWithChat: true }),
    onEvent: () => noop,
  } as never;
  const globals = {
    window,
    document,
    location,
    history,
    innerWidth: 1440,
    innerHeight: 900,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
      clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
    CustomEvent: window.CustomEvent,
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
  const previousScroll = window.HTMLElement.prototype.scrollIntoView;
  window.HTMLElement.prototype.scrollIntoView = noop;
  const root = createRoot(document.querySelector("main")!);
  const key = (element: HTMLElement, key: string) =>
    act(async () => {
      const event = new window.Event("keydown", {
        bubbles: true,
        cancelable: true,
      });
      Object.assign(event, {
        key,
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
      });
      element.dispatchEvent(event);
    });
  const click = (element: HTMLElement) =>
    act(async () => {
      element.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
  const settle = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    assert.ok(predicate(), "expected navigation state did not appear");
  };
  const render = (
    app: Partial<AppController>,
    element: ReturnType<typeof createElement>,
  ) =>
    act(async () => {
      root.render(
        createElement(
          HostContext.Provider,
          { value: host },
          createElement(
            AppContext.Provider,
            { value: app as AppController },
            element,
          ),
        ),
      );
    });
  return {
    window,
    document,
    root,
    location,
    pushes,
    blankRequests,
    blankCreations,
    blankStore,
    key,
    click,
    settle,
    render,
    async restore() {
      await act(async () => root.unmount());
      window.HTMLElement.prototype.scrollIntoView = previousScroll;
      takeScheduleRequest();
      fs.rmSync(blankRoot, { recursive: true, force: true });
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

function appState(extra: Record<string, unknown> = {}): Partial<AppController> {
  return {
    search: "",
    searchEntrypoint: "default",
    mode: "chat",
    page: "chat",
    text: "",
    listed: [],
    snapshot: {
      settings: defaultSettings,
      conversations: [],
      projects: [],
      approvals: [],
      artifactShares: [],
      artifactLibrary: { version: 1, copies: [], pinned: [] },
    },
    setSearch: noop,
    setSearchEntrypoint: noop,
    setPage: noop,
    newChat: noop,
    setText: noop,
    setAttachments: noop,
    openConversation: noop,
    patchConversation: noop,
    confirmDelete: noop,
    setRename: noop,
    report: noop,
    ...extra,
  } as unknown as Partial<AppController>;
}

test("the phone sheet's App close selector matches real web navigation anchors and their icon children", async () => {
  const env = environment();
  try {
    const source = readSource("src/app/App.tsx");
    const selector = /target\.closest\(\s*"([^"]*\.sidebar[^"]*)"/.exec(
      source,
    )?.[1];
    assert.ok(selector, "App supplies its phone-row close selector");
    const markup = renderToStaticMarkup(
      createElement(
        HostContext.Provider,
        { value: host },
        createElement(
          AppContext.Provider,
          { value: appState() as AppController },
          createElement(
            "aside",
            { className: "sidebar" },
            createElement(MainNav, {
              mode: "chat",
              page: "chat",
              onNewChat: noop,
              onPageChange: noop,
              onEditSidebar: noop,
            }),
          ),
        ),
      ),
    );
    const { document } = parseHTML(markup);
    const links = [
      ...document.querySelectorAll<HTMLAnchorElement>(".main-nav a"),
    ];
    assert.deepEqual(
      links.map((link) => link.getAttribute("href")),
      [
        "/new",
        "/projects",
        "/artifacts",
        "/api",
        "/status",
      ],
    );
    for (const link of links) {
      assert.ok(link.closest(selector) === link, link.getAttribute("href")!);
      const icon = link.querySelector(".nav-glyph")!;
      assert.ok(
        icon.closest(selector) === link,
        `${link.getAttribute("href")} icon`,
      );
    }
  } finally {
    await env.restore();
  }
});

for (const entrypoint of ["default", "search"] as const) {
  for (const activation of ["pointer", "Enter"] as const) {
    test(`real SearchOverlay sends the selected task id from ${entrypoint}, ${activation}`, async () => {
      const env = environment();
      const calls: unknown[] = [];
      const off = onScheduleRequest((request) =>
        calls.push(["request", request]),
      );
      try {
        await env.render(
          appState({
            searchEntrypoint: entrypoint,
            setSearch: (query: unknown) => calls.push(["search", query]),
            setPage: (page: string) => calls.push(["page", page]),
          }),
          createElement(SearchOverlay),
        );
        const target = () =>
          [
            ...env.document.querySelectorAll<HTMLElement>('[role="option"]'),
          ].find((row) => row.textContent?.includes("Task selected"));
        await env.settle(() => Boolean(target()));
        const row = target()!;
        if (activation === "pointer") await env.click(row);
        else {
          const input =
            env.document.querySelector<HTMLInputElement>('[role="combobox"]')!;
          const index = Number(row.getAttribute("data-index"));
          for (let step = 0; step < index; step++)
            await env.key(input, "ArrowDown");
          assert.equal(input.getAttribute("aria-activedescendant"), row.id);
          await env.key(input, "Enter");
        }
        assert.deepEqual(calls, [
          ["search", null],
          ["request", { description: "", openRoutineId: "selected" }],
          ["page", "scheduled"],
        ]);
        assert.equal(takeScheduleRequest(), undefined);
      } finally {
        off();
        await env.restore();
      }
    });
  }
}

test("ScheduledRoute consumes queued/live task navigation as detail, clears editors, and null returns to Yours", async () => {
  const env = environment("/scheduled-task?view=templates");
  const errors: unknown[] = [];
  try {
    requestScheduleConfirmation({ description: "", openRoutineId: "selected" });
    await env.render(
      appState({ report: (error: unknown) => errors.push(error) }),
      createElement(ScheduledRoute),
    );
    const title = () =>
      env.document.querySelector(".scheduled-detail-heading h1")?.textContent;
    await env.settle(() => title() === "Task selected");
    assert.equal(env.location.pathname, "/scheduled-task/selected");
    assert.equal(env.location.search, "");
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
    assert.deepEqual(errors, []);

    await act(async () => {
      requestScheduleConfirmation({ description: "", openRoutineId: "first" });
    });
    await env.settle(() => title() === "Task first");
    assert.equal(env.location.pathname, "/scheduled-task/first");
    assert.equal(env.document.querySelector('[role="dialog"]'), null);

    // Open the actual detail's editor. A navigation request must close it,
    // rather than display the newly selected detail behind the old editor.
    await env.click(
      env.document.querySelector<HTMLButtonElement>(
        '[aria-label="Edit instructions"]',
      )!,
    );
    await env.settle(() =>
      Boolean(
        env.document.querySelector(
          '[role="dialog"][aria-label="Edit scheduled task"]',
        ),
      ),
    );
    await act(async () => {
      requestScheduleConfirmation({
        description: "",
        openRoutineId: "selected",
      });
    });
    await env.settle(() => title() === "Task selected");
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
    assert.equal(env.location.pathname, "/scheduled-task/selected");

    await act(async () => {
      requestScheduleConfirmation({ description: "", openRoutineId: null });
    });
    await env.settle(() =>
      Boolean(env.document.querySelector(".routines-tabs")),
    );
    assert.equal(env.location.pathname, "/scheduled-task");
    assert.equal(env.location.search, "");
    assert.equal(
      env.document.querySelector('.routines-tabs [aria-selected="true"]')
        ?.textContent,
      "Yours",
    );
    assert.equal(env.document.querySelector('[role="dialog"]'), null);
    assert.equal(env.document.querySelector(".scheduled-detail-header"), null);
    assert.deepEqual(errors, []);
    assert.equal(takeScheduleRequest(), undefined);
  } finally {
    await env.restore();
  }
});

const navActions = [
  { kind: "artifacts", label: "Docs", output: "docs" },
  { kind: "artifacts", label: "Slides", output: "slides" },
  { kind: "artifacts", label: "Design", output: "design" },
  { kind: "artifacts", label: "Dashboard", output: "dashboard" },
  { kind: "scheduled", label: "Create with Claudex", chat: true },
  { kind: "scheduled", label: "Set up manually", blank: true },
] as const;

for (const phone of [true, false]) {
  for (const open of [true, false]) {
    for (const activation of ["pointer", "Enter"] as const) {
      for (const action of navActions) {
        test(`portal ${action.label}, ${activation}: ${phone ? "phone" : "desktop"} sidebar ${open ? "open" : "closed"}`, async () => {
          const env = environment();
          const calls: unknown[] = [];
          const off = onScheduleRequest((request) =>
            calls.push(["request", request]),
          );
          const shouldClose = phone && open;
          const sidebarView = {
            phone,
            open,
            toggle: () => calls.push(["toggle"]),
          };
          const owner = {},
            draftSession = "scheduled-portal-draft";
          const currentController = {
            current: undefined as AppController | undefined,
          };
          const offSubmit = onComposerSubmitRequest(
            `${draftSession}:chat`,
            () => {
              calls.push(["submit", `${draftSession}:chat`]);
            },
          );
          const app = appState({
            accountId: "portal-account",
            controllerScope: owner,
            currentController,
            draftSession: "before",
            providerId: "fixture",
            model: "Opus 5.5",
            incognitoShown: false,
            sending: false,
            running: false,
            skillTokens: [],
            attachments: [],
            sidebarView,
            newChat: (
              mode: string,
              _project?: string,
              _incognito?: boolean,
              afterStart?: (created: {
                draftSession: string;
                mode: string;
              }) => void,
            ) => {
              calls.push(["new", mode]);
              Object.assign(currentController.current!, {
                page: "chat",
                mode,
                activeId: undefined,
                active: undefined,
                draftSession,
              });
              afterStart?.({ draftSession, mode });
            },
            setText: (prompt: string) => {
              calls.push(["text", prompt]);
              currentController.current!.text = prompt;
            },
            setSkillTokens: (tokens: unknown[]) => {
              calls.push(["skills", tokens]);
              Object.assign(currentController.current!, {
                skillTokens: tokens,
              });
            },
            setAttachments: (attachments: unknown[]) => {
              calls.push(["attachments", attachments]);
              Object.assign(currentController.current!, { attachments });
            },
            upsert: (conversation: unknown) =>
              calls.push(["upsert", conversation]),
            setActiveId: (id: string) => calls.push(["active", id]),
            setMode: (mode: string) => calls.push(["mode", mode]),
            setArtifact: (artifact: unknown) =>
              calls.push(["artifact", artifact]),
            setArtifactRouteId: (id: string) =>
              calls.push(["artifact-route", id]),
            setPage: (page: string) => calls.push(["page", page]),
            report: (error: unknown) => {
              throw error;
            },
          });
          currentController.current = app as AppController;
          try {
            await env.render(
              app,
              createElement(
                "aside",
                { className: "sidebar" },
                createElement(NavCreateMenu, { kind: action.kind }),
              ),
            );
            await env.click(
              env.document.querySelector<HTMLButtonElement>(
                ".main-nav-create",
              )!,
            );
            const menu =
              env.document.querySelector<HTMLElement>('[role="menu"]')!;
            assert.ok(menu);
            assert.equal(
              menu.parentElement,
              env.document.body,
              "real menu is a portal",
            );
            assert.equal(menu.closest(".sidebar"), null);
            const items = [
              ...menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
            ];
            const index = items.findIndex((item) => {
              const primary = [...item.children].find(
                (child) =>
                  child.tagName === "SPAN" &&
                  !child.classList.contains("rate-badge"),
              );
              // The source puts New/Beta inside the primary label span;
              // identify its own text without confusing it with the badge.
              return (
                [...(primary?.childNodes ?? [])]
                  .filter((node) => node.nodeType === 3)
                  .map((node) => node.textContent)
                  .join("")
                  .trim() === action.label
              );
            });
            assert.ok(index >= 0, action.label);
            if (activation === "pointer") await env.click(items[index]);
            else {
              await env.key(menu, "Home");
              for (let step = 0; step < index; step++)
                await env.key(menu, "ArrowDown");
              await env.key(menu, "Enter");
            }
            const expected: unknown[] = shouldClose ? [["toggle"]] : [];
            if (action.kind === "artifacts") {
              await env.settle(() => env.blankCreations.length === 1);
              const result = env.blankCreations[0],
                request = env.blankRequests[0];
              assert.equal(request.kind, action.output);
              assert.equal(request.providerId, "fixture");
              assert.equal(request.model, "Opus 5.5");
              assert.deepEqual(Object.keys(request).sort(), [
                "kind",
                "model",
                "name",
                "providerId",
                "requestId",
              ]);
              assert.equal(result.conversation.id, request.requestId);
              assert.equal(result.conversation.mode, "chat");
              assert.deepEqual(result.conversation.turns, []);
              assert.equal(result.document.artifact.kind, action.output);
              assert.equal(
                result.document.conversationId,
                result.conversation.id,
              );
              assert.equal(
                fs.readFileSync(
                  nodePath.join(
                    result.conversation.cwd!,
                    result.document.artifact.file,
                  ),
                  "utf8",
                ),
                result.document.content,
              );
              assert.equal(
                new Store(env.blankStore.root).conversations[0].blankArtifact
                  ?.id,
                result.document.artifact.id,
              );
              const artifact = blankConversationArtifact(result.conversation)!;
              expected.push(
                ["upsert", result.conversation],
                ["active", result.conversation.id],
                ["mode", "chat"],
                ["artifact", undefined],
                ["artifact-route", artifactRouteId(artifact)],
                ["page", "artifact"],
              );
              assert.equal(
                calls.some(
                  (entry: any) =>
                    entry[0] === "new" ||
                    entry[0] === "text" ||
                    entry[0] === "submit",
                ),
                false,
              );
            } else if (action.label === "Create with Claudex") {
              await env.settle(() =>
                calls.some((entry: any) => entry[0] === "submit"),
              );
              expected.push(
                ["new", "chat"],
                ["text", scheduledChatPrompt],
                ["skills", []],
                ["attachments", []],
                ["submit", `${draftSession}:chat`],
              );
              assert.equal(env.blankRequests.length, 0);
              assert.equal(
                calls.some(
                  (entry: any) => entry[0] === "request" || entry[0] === "page",
                ),
                false,
              );
            } else {
              expected.push(
                ["request", { description: "", blank: true }],
                ["page", "scheduled"],
              );
              assert.equal(env.blankRequests.length, 0);
              assert.equal(
                calls.some((entry: any) => entry[0] === "submit"),
                false,
              );
            }
            assert.deepEqual(calls, expected);
            assert.equal(env.document.querySelector('[role="menu"]'), null);
            assert.equal(takeScheduleRequest(), undefined);
          } finally {
            off();
            offSubmit();
            cancelComposerSubmitFor(owner);
            await env.restore();
          }
        });
      }
    }
  }
}
