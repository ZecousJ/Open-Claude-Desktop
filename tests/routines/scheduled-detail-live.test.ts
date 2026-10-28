import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { HostContext } from "../../src/host/HostContext";
import { desktopHost, webHost } from "../../shared/host";
import { defaultSettings } from "../../electron/store/store";
import type { Routine } from "../../shared/routines";
import type { RoutineRun } from "../../shared/routine-labels";
import {
  RoutineDetail,
  type RoutineDetailProps,
} from "../../src/collections/routines/RoutineDetail";
import { openRoutineRun } from "../../src/collections/routines/RoutineHistory";
import { RoutineRunRow } from "../../src/collections/routines/RoutineRunRow";
import { RoutinesPage } from "../../src/collections/routines/RoutinesPage";
import { atomicChatDom } from "../support/atomic-chat-dom";

const now = new Date(2026, 9, 16, 20).getTime();
const routine: Routine = {
  id: "synthetic-task",
  name: "Synthetic daily review",
  prompt: "Review the changes.",
  mode: "cowork",
  providerId: "p",
  model: "Opus",
  enabled: true,
  frequency: "daily",
  repeat: { kind: "daily", time: "09:59" },
  nextRunAt: now + 86_400_000,
  executionLocation: "remote",
  permission: "auto",
  createdAt: now,
  updatedAt: now,
};
const props: RoutineDetailProps = {
  routine,
  onClose() {},
  onEdit() {},
  onRename: async () => {},
  onDelete() {},
  onRun() {},
  onEnabled() {},
  onRemoveApproval() {},
  onOpenConversation() {},
  running: false,
  disabled: false,
};
const wrap = (child: ReturnType<typeof createElement>, web = true) =>
  createElement(
    HostContext.Provider,
    { value: web ? webHost : desktopHost },
    child,
  );

test("the observed web detail has a breadcrumb, rename/menu controls, header schedule switch and editable sidebar", () => {
  const { document } = parseHTML(
    renderToStaticMarkup(wrap(createElement(RoutineDetail, props))),
  );
  assert.equal(
    document.querySelector(".scheduled-detail-toolbar a")?.getAttribute("href"),
    "/scheduled-task",
  );
  assert.equal(
    document
      .querySelector(".scheduled-detail-name")
      ?.getAttribute("aria-label"),
    `Rename ${routine.name}`,
  );
  assert.equal(
    document
      .querySelector(".scheduled-detail-options")
      ?.getAttribute("aria-haspopup"),
    "menu",
  );
  assert.equal(
    document.querySelector("h1[data-no-translate]")?.textContent,
    routine.name,
  );
  assert.deepEqual(
    Array.from(
      document.querySelectorAll(".scheduled-detail-actions > *"),
      (e) => e.className,
    ),
    ["primary scheduled-detail-run", "scheduled-detail-status"],
  );
  assert.equal(
    document.querySelector('[role="switch"]')?.getAttribute("aria-label"),
    "Enable schedule",
  );
  assert.deepEqual(
    Array.from(
      document.querySelectorAll(".scheduled-detail-sidebar h2"),
      (e) => e.textContent,
    ),
    ["Instructions", "Repeats", "Permissions"],
  );
  for (const label of [
    "Edit instructions",
    "Repeats: Daily at 9:59 AM",
    "Permissions: Auto",
  ])
    assert.ok(document.querySelector(`button[aria-label="${label}"]`), label);
  assert.equal(
    document.querySelector(".scheduled-detail-permission small")?.textContent,
    "Runs without asking.",
  );
  assert.equal(
    document.querySelectorAll(
      '.routine-detail-actions [aria-label="Edit"],.routine-detail-actions [aria-label="Delete"]',
    ).length,
    0,
  );
});

test("the shared detail renders nonempty approvals and a real SSH name; legacy desktop keeps its own layout", async () => {
  const task = {
    ...routine,
    executionLocation: "local" as const,
    cwd: "/synthetic/project",
    environment: { kind: "ssh" as const, hostId: "synthetic-host" },
    alwaysAllowed: [
      { kind: "command" as const, tool: "Run command", pattern: "git status" },
    ],
  };
  const env = await atomicChatDom({
    sshListHosts: async () => ({
      hosts: [{ id: "synthetic-host", label: "Actual SSH box" }],
    }),
    routineRunsPage: async () => ({ runs: [] }),
  } as never);
  try {
    await env.render(
      wrap(createElement(RoutineDetail, { ...props, routine: task }), false),
    );
    assert.ok(env.document.querySelector('[aria-label="Remove approval"]'));
    assert.ok(
      env.document.body.textContent?.includes("Run command (git status)"),
    );
    assert.ok(
      env.document
        .querySelector(".routine-detail-device")
        ?.textContent?.includes("Actual SSH box"),
    );
    assert.equal(
      env.document.body.textContent?.includes("synthetic-host"),
      false,
    );
    assert.ok(
      env.document
        .querySelector(".routine-detail-folder-row")
        ?.textContent?.includes("/synthetic/project"),
    );
  } finally {
    await env.clean();
  }
  const desktop = renderToStaticMarkup(
    wrap(
      createElement(RoutineDetail, { ...props, presentation: "legacy-local" }),
      false,
    ),
  );
  assert.match(desktop, /routine-detail-back/);
  assert.match(desktop, /class="routine-detail-grid"/);
  assert.doesNotMatch(desktop, /scheduled-detail-toolbar/);
  const held = renderToStaticMarkup(
    wrap(createElement(RoutineDetail, { ...props, hold: "Synthetic hold" })),
  );
  assert.match(held, /disabled="" title="Synthetic hold"/);
  assert.match(held, /On hold/);
});

test("web history uses a real destination and calendar time; Manual comes from the saved trigger", () => {
  const run: RoutineRun = {
    id: "synthetic-run",
    startedAt: now,
    status: "completed",
    trigger: "manual",
    conversationId: "synthetic-chat",
    readAt: now,
  };
  const render = (patch: Partial<RoutineRun> = {}) =>
    renderToStaticMarkup(
      wrap(
        createElement(RoutineRunRow, {
          run: { ...run, ...patch },
          local: false,
          href: "/chat/synthetic-chat",
          onOpen() {},
        }),
      ),
    );
  const html = render();
  assert.match(
    html,
    /<a class="routine-history-row" href="\/chat\/synthetic-chat">/,
  );
  assert.match(html, /<time dateTime="2026-/);
  assert.match(html, /routine-history-provenance"> · Manual/);
  assert.doesNotMatch(html, /Only this computer/);
  assert.doesNotMatch(render({ trigger: "schedule" }), / · Manual/);
  assert.doesNotMatch(render({ conversationId: undefined }), /<a /);
});

test("a slow or rejected read receipt cannot prevent opening a real run", async () => {
  const run: RoutineRun = {
    id: "run",
    startedAt: now,
    status: "completed",
    trigger: "manual",
    conversationId: "chat",
  };
  const events: string[] = [];
  let reject!: (reason: Error) => void;
  const receipt = new Promise<void>((_, fail) => {
    reject = fail;
  });
  const pending = openRoutineRun(
    "task",
    run,
    (id) => events.push(`open:${id}`),
    () => receipt,
    () => events.push("read"),
    (reason) => events.push(`error:${String(reason)}`),
  );
  assert.deepEqual(events, ["open:chat"]);
  reject(new Error("Synthetic receipt failure"));
  await pending;
  assert.deepEqual(events, [
    "open:chat",
    "error:Error: Synthetic receipt failure",
  ]);
  events.length = 0;
  await openRoutineRun(
    "task",
    run,
    (id) => events.push(`open:${id}`),
    async () => {},
    () => events.push("read"),
    () => events.push("error"),
  );
  assert.deepEqual(events, ["open:chat", "read"]);
});

test("Scheduled view is controlled by the route and internal requests use the latest callback", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  window.desktop = {
    listSchedules: async () => [],
    onEvent: () => () => {},
  } as never;
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
  const calls: string[] = [];
  const pageProps = {
    settings: defaultSettings,
    onOpenConversation() {},
    onChooseFolder: async () => null,
    onConfirmDelete() {},
    onError(error: unknown) {
      throw error;
    },
  };
  try {
    await act(async () => {
      root.render(
        wrap(
          createElement(RoutinesPage, {
            ...pageProps,
            view: "templates",
            onViewChange: (value) => calls.push(`first:${value}`),
          }),
        ),
      );
    });
    assert.equal(
      document.querySelector('.routines-tabs [aria-selected="true"]')
        ?.textContent,
      "Templates",
    );
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('.routines-tabs [data-tab="yours"]')!
        .click();
    });
    assert.deepEqual(calls, ["first:yours"]);
    assert.equal(
      document.querySelector('.routines-tabs [aria-selected="true"]')
        ?.textContent,
      "Templates",
      "address state owns selection",
    );
    await act(async () => {
      root.render(
        wrap(
          createElement(RoutinesPage, {
            ...pageProps,
            view: "yours",
            onViewChange: (value) => calls.push(`second:${value}`),
          }),
        ),
      );
    });
    assert.equal(
      document.querySelector('.routines-tabs [aria-selected="true"]')
        ?.textContent,
      "Yours",
    );
    const { requestScheduleConfirmation } =
      await import("../../src/collections/routines/schedule-request");
    await act(async () => {
      requestScheduleConfirmation({
        description: "",
        routineId: "missing-synthetic-task",
      });
    });
    assert.equal(calls.at(-1), "second:yours");
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("legacy detail waits for its real list read, keeps a missing route explicit and respects a controlled empty id", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  let resolveList!: (routines: Routine[]) => void;
  const list = new Promise<Routine[]>((resolve) => {
    resolveList = resolve;
  });
  window.desktop = {
    listSchedules: () => list,
    onEvent: () => () => {},
  } as never;
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
  const errors: string[] = [],
    details: (string | undefined)[] = [],
    views: string[] = [];
  const host = {
    ...webHost,
    capabilities: { ...webHost.capabilities, scheduledTasks: true },
  };
  const render = (detailId?: string) =>
    root.render(
      createElement(
        HostContext.Provider,
        { value: host },
        createElement(RoutinesPage, {
          settings: defaultSettings,
          detailId,
          onDetailChange: (id) => details.push(id),
          view: "yours",
          onViewChange: (value) => views.push(value),
          onOpenConversation() {},
          onChooseFolder: async () => null,
          onConfirmDelete() {},
          onError: (error) => errors.push((error as Error).message),
        }),
      ),
    );
  try {
    await act(async () => {
      render("missing-synthetic-task");
    });
    assert.deepEqual(errors, [], "pending data is not a missing task");
    await act(async () => {
      resolveList([routine]);
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(
      details,
      [],
      "missing is rendered on its route, never a silent list redirect",
    );
    assert.deepEqual(views, []);
    assert.match(
      document.body.textContent!,
      /That scheduled task is no longer available/,
    );
    await act(async () => {
      render(undefined);
    });
    await act(async () => {
      document
        .querySelector<HTMLAnchorElement>(".routine-card [data-primary]")!
        .click();
    });
    assert.equal(details.at(-1), routine.id);
    assert.ok(
      document.querySelector(".routine-card"),
      "local state cannot override a controlled empty detail id",
    );
    assert.equal(document.querySelector(".scheduled-detail-header"), null);
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
