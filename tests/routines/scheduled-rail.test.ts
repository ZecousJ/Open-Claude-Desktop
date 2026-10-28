import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { act, createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import postcss from "postcss";
import { desktopHost, webHost } from "../../shared/host";
import { openPolicy } from "../../shared/client-policy";
import type { Routine, RoutineListResult } from "../../shared/routines";
import type { Conversation, AppEvent } from "../../shared/types";
import { fixtureSnapshot } from "../../scripts/preview/app-fixture";
import { CoworkTasksPanel } from "../../src/cowork/CoworkTasksPanel";
import CoworkActiveSection from "../../src/cowork/CoworkActiveSection";
import { CoworkTasksPanelOverlay } from "../../src/cowork/CoworkTasksPanelOverlay";
import { taskRailContext } from "../../src/cowork/task-rail-context";
import { HostContext } from "../../src/host/HostContext";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { takeScheduleRequest } from "../../src/collections/routines/schedule-request";
import { atomicChatDom } from "../support/atomic-chat-dom";

const noop = () => {};
const fixtures = fixtureSnapshot({ states: true });
const conversation = (id = "task-session"): Conversation => ({
  ...structuredClone(fixtures.conversations[0]),
  id,
  mode: "cowork",
  archived: false,
  incognito: false,
  cwd: undefined,
  environment: undefined,
  turns: [],
});
const routine = (id = "task / one"): Routine => ({
  id,
  name: id,
  prompt: "Neutral task",
  mode: "cowork",
  providerId: "p",
  model: "m",
  enabled: true,
  frequency: "daily",
  nextRunAt: Date.now() + 86_400_000,
  createdAt: 1,
  updatedAt: 1,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function transport(read: () => Promise<Routine[]>) {
  const listeners = new Set<(event: AppEvent) => void>();
  const all: ((event: AppEvent) => void)[] = [];
  let reads = 0;
  return {
    bridge: {
      listSchedules: () => {
        reads++;
        return read();
      },
      onEvent: (listener: (event: AppEvent) => void) => {
        listeners.add(listener);
        all.push(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      mcpServers: async () => ({ servers: [] }),
      linearStatus: async () => ({ connected: false }),
    },
    emit: (rows: Routine[]) =>
      listeners.forEach((listener) =>
        listener({ type: "schedules", schedules: rows }),
      ),
    emitEvent: (event: AppEvent) =>
      listeners.forEach((listener) => listener(event)),
    all,
    listeners,
    reads: () => reads,
  };
}
async function setup(source = transport(async () => [])) {
  const env = await atomicChatDom(source.bridge as never);
  const errors: unknown[] = [];
  const opened: string[] = [];
  const props = {
    conversations: [] as Conversation[],
    approvals: [],
    accountId: "A",
    onOpen: (value: Conversation) => opened.push(value.id),
    onRoutine: (id: string) => opened.push(id),
    onClose: noop,
    onError: (error: unknown) => {
      errors.push(error);
    },
  };
  const query = <T extends Element = HTMLElement>(selector: string) => {
    const element = env.document.querySelector<T>(selector);
    assert.ok(element, selector);
    return element;
  };
  const click = async (selector: string, init: MouseEventInit = {}) => {
    const event = new env.window.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    await act(async () => {
      query(selector).dispatchEvent(event);
    });
    return event;
  };
  const panel = (patch: Partial<Parameters<typeof CoworkTasksPanel>[0]> = {}) =>
    env.render(
      h(
        HostContext.Provider,
        { value: desktopHost },
        h(CoworkTasksPanel, { ...props, ...patch }),
      ),
    );
  return { ...env, query, click, panel, source, errors, opened, props };
}

test("typed source failures keep actual cached cloud rows through ordinary events until recovery is acknowledged", async () => {
  const local = {
    ...routine("local kept"),
    executionLocation: "local" as const,
  };
  const remote = {
    ...routine("cloud retained"),
    executionLocation: "remote" as const,
  };
  let result: RoutineListResult = {
    tasks: [local, remote],
    sources: [
      { source: "local", status: "ready" },
      { source: "remote", status: "ready" },
    ],
  };
  let pending: Promise<RoutineListResult> | undefined;
  const source = transport(async () => []);
  Object.assign(source.bridge, {
    querySchedules: () => pending ?? Promise.resolve(result),
  });
  const env = await setup(source);
  try {
    await env.panel();
    assert.match(env.document.body.textContent!, /cloud retained/);
    result = {
      tasks: [local],
      sources: [
        { source: "local", status: "ready" },
        { source: "remote", status: "error" },
      ],
    };
    await act(async () => source.emitEvent({ type: "resync" }));
    assert.match(
      env.query('[role="alert"]').textContent!,
      /Couldn’t load cloud scheduled tasks/,
    );
    assert.match(env.document.body.textContent!, /local kept/);
    assert.match(env.document.body.textContent!, /cloud retained/);
    const gate = deferred<RoutineListResult>();
    pending = gate.promise;
    await act(async () => source.emit([local]));
    assert.match(
      env.query('[role="alert"]').textContent!,
      /cloud scheduled tasks/,
    );
    assert.match(env.document.body.textContent!, /cloud retained/);
    await act(async () =>
      gate.resolve({
        tasks: [],
        sources: [
          { source: "local", status: "ready" },
          { source: "remote", status: "ready" },
        ],
      }),
    );
    assert.equal(env.document.querySelector('[role="alert"]'), null);
    assert.equal(env.query(".cowork-tasks-empty").textContent, "No tasks yet");
  } finally {
    await env.clean();
  }
});

test("replacing a controller in the same account retires the previous task read", async () => {
  const older = deferred<Routine[]>(),
    newer = deferred<Routine[]>();
  let calls = 0;
  const env = await setup(
    transport(() => (++calls === 1 ? older.promise : newer.promise)),
  );
  try {
    await env.panel({ controllerScope: {} });
    await env.panel({ controllerScope: {} });
    await act(async () => newer.resolve([routine("current controller")]));
    await act(async () => older.resolve([routine("retired controller")]));
    assert.match(env.document.body.textContent!, /current controller/);
    assert.doesNotMatch(env.document.body.textContent!, /retired controller/);
  } finally {
    await env.clean();
  }
});

test("Scheduled39: pending/error/retry/empty are distinct real read states", async () => {
  const first = deferred<Routine[]>(),
    retry = deferred<Routine[]>();
  let request = 0;
  const env = await setup(
    transport(() => (request++ ? retry.promise : first.promise)),
  );
  try {
    await env.panel();
    assert.ok(env.document.querySelector('[role="status"]'));
    assert.equal(env.document.querySelector(".cowork-tasks-empty"), null);
    await act(async () => first.reject(new Error("unreachable")));
    assert.match(
      env.query('[role="alert"]').textContent!,
      /Couldn’t load scheduled tasks/,
    );
    assert.equal(env.document.querySelector(".cowork-tasks-empty"), null);
    assert.equal(env.errors.length, 1);
    await env.click('[role="alert"] button');
    assert.ok(env.document.querySelector('[role="status"]'));
    await act(async () => retry.resolve([]));
    assert.equal(env.query(".cowork-tasks-empty").textContent, "No tasks yet");
    assert.equal(env.document.querySelector('[role="alert"]'), null);
  } finally {
    await env.clean();
  }
});

test("Scheduled39: a failed refresh retains successful schedules and new events win over older reads", async () => {
  const pending = deferred<Routine[]>(),
    retry = deferred<Routine[]>();
  let request = 0;
  const env = await setup(
    transport(() => (request++ ? retry.promise : pending.promise)),
  );
  try {
    await env.panel();
    await act(async () => env.source.emit([routine("known")]));
    await act(async () => pending.reject(new Error("older request")));
    assert.equal(env.errors.length, 0);
    assert.match(env.query(".cowork-ongoing").textContent!, /known/);
    // An invalid result is an error, not an invented successful empty list.
    await act(async () => env.source.emit(undefined as never));
    assert.ok(env.document.querySelector('[role="alert"]'));
    assert.match(env.query(".cowork-ongoing").textContent!, /known/);
    await env.click('[role="alert"] button');
    assert.match(env.query(".cowork-ongoing").textContent!, /known/);
    await act(async () => retry.reject(new Error("refresh failed")));
    assert.match(env.query(".cowork-ongoing").textContent!, /known/);
    assert.equal(env.document.querySelector(".cowork-tasks-empty"), null);
  } finally {
    await env.clean();
  }
});

test("Scheduled39: account/bridge changes hide retained rows and reject late reads and old watchers", async () => {
  const a = deferred<Routine[]>(),
    b = deferred<Routine[]>();
  const sourceA = transport(() => a.promise),
    sourceB = transport(() => b.promise);
  const env = await setup(sourceA);
  try {
    await env.panel();
    await act(async () => sourceA.emit([routine("private A")]));
    (env.window as unknown as Window).desktop = sourceB.bridge as never;
    await env.panel({ accountId: "B" });
    assert.equal(env.document.querySelector(".cowork-ongoing"), null);
    assert.ok(env.document.querySelector('[role="status"]'));
    await act(async () => {
      a.resolve([routine("late A")]);
      sourceA.all[0]({
        type: "schedules",
        schedules: [routine("old watcher A")],
      });
      b.resolve([routine("B task")]);
    });
    assert.match(env.query(".cowork-ongoing").textContent!, /B task/);
    assert.doesNotMatch(
      env.document.body.textContent!,
      /private A|late A|old watcher A/,
    );
    assert.equal(sourceA.listeners.size, 0);
    assert.equal(env.errors.length, 0);
  } finally {
    await env.clean();
  }
  assert.equal(sourceB.listeners.size, 0);
});

test("Scheduled39: real resync refresh retains rows through rejection and retry, then an empty success is authoritative", async () => {
  const refresh = deferred<Routine[]>(),
    retry = deferred<Routine[]>();
  let request = 0;
  const env = await setup(
    transport(() => {
      request++;
      return request === 1
        ? Promise.resolve([routine("retained")])
        : request === 2
          ? refresh.promise
          : retry.promise;
    }),
  );
  try {
    await env.panel();
    await act(async () => env.source.emitEvent({ type: "resync" }));
    assert.ok(env.document.querySelector('[role="status"]'));
    assert.match(env.query(".cowork-ongoing").textContent!, /retained/);
    await act(async () => refresh.reject(new Error("real refresh rejected")));
    assert.ok(env.document.querySelector('[role="alert"]'));
    assert.match(env.query(".cowork-ongoing").textContent!, /retained/);
    await env.click('[role="alert"] button');
    assert.match(env.query(".cowork-ongoing").textContent!, /retained/);
    await act(async () => retry.resolve([]));
    assert.equal(env.document.querySelector(".cowork-ongoing"), null);
    assert.equal(env.query(".cowork-tasks-empty").textContent, "No tasks yet");
  } finally {
    await env.clean();
  }
});

test("Scheduled39: same bridge A→B→A leases never flash or restore another account's read/event rows", async () => {
  const requests = [
    deferred<Routine[]>(),
    deferred<Routine[]>(),
    deferred<Routine[]>(),
  ];
  let request = 0;
  const source = transport(() => requests[request++].promise);
  const env = await setup(source);
  try {
    await env.panel();
    await act(async () => source.emit([routine("A private")]));
    await env.panel({ accountId: "B" });
    assert.equal(env.document.querySelector(".cowork-ongoing"), null);
    await act(async () => {
      requests[0].resolve([routine("late A")]);
      source.all[0]({
        type: "schedules",
        schedules: [routine("stale A event")],
      });
      source.emit([routine("B private")]);
    });
    assert.match(env.query(".cowork-ongoing").textContent!, /B private/);
    await env.panel({ accountId: "A" });
    assert.equal(env.document.querySelector(".cowork-ongoing"), null);
    await act(async () => {
      requests[1].resolve([routine("late B")]);
      source.all[1]({
        type: "schedules",
        schedules: [routine("stale B event")],
      });
      requests[2].resolve([routine("fresh A")]);
    });
    assert.match(env.query(".cowork-ongoing").textContent!, /fresh A/);
    assert.doesNotMatch(
      env.document.body.textContent!,
      /B private|late B|stale B|A private/,
    );
    assert.equal(source.listeners.size, 1);
  } finally {
    await env.clean();
  }
});

test("Scheduled36: Ongoing is a canonical detail anchor; modifiers keep native link navigation", async () => {
  const env = await setup(transport(async () => [routine()]));
  try {
    await env.panel();
    const link = env.query<HTMLAnchorElement>(".cowork-ongoing-track a");
    assert.equal(link.getAttribute("href"), "/scheduled-task/task%20%2F%20one");
    let nativeAllowed = false;
    const preventJsdomNavigation = (event: MouseEvent) => {
      if (!event.metaKey) return;
      nativeAllowed = !event.defaultPrevented;
      event.preventDefault();
    };
    env.window.addEventListener("click", preventJsdomNavigation as never);
    await env.click(".cowork-ongoing-track a", { metaKey: true });
    env.window.removeEventListener("click", preventJsdomNavigation as never);
    assert.equal(
      nativeAllowed,
      true,
      "React leaves modifier navigation to the browser",
    );
    assert.deepEqual(env.opened, []);
    assert.equal(
      (await env.click(".cowork-ongoing-track a")).defaultPrevented,
      true,
    );
    assert.deepEqual(env.opened, ["task / one"]);
  } finally {
    await env.clean();
  }
});

test("Scheduled37: Tasks/settings switch reuses actual Activity and preserves view/filter across task sessions", async () => {
  const env = await setup(
    transport(async () => [routine("ongoing code unaffected")]),
  );
  const rich = structuredClone(
    fixtures.conversations.find((value) => value.id === "c-activity")!,
  );
  const artifacts: unknown[] = [];
  try {
    await env.panel({
      active: rich,
      onArtifact: (value) => artifacts.push(value),
    });
    await env.click('[aria-label="Filter tasks"]');
    const code = [
      ...env.document.querySelectorAll<HTMLElement>(
        '[role="menuitemcheckbox"]',
      ),
    ].find((value) => value.textContent?.includes("Code"))!;
    assert.ok(code);
    await act(async () => code.click());
    await env.click('[aria-label="Settings"]');
    await env.settle();
    assert.equal(
      env.query('[aria-label="Close settings"]').getAttribute("aria-pressed"),
      "true",
    );
    assert.ok(
      env.document.querySelector(".cowork-task-activity .progress-panel"),
    );
    assert.equal(
      env.document.querySelector(
        ".cowork-task-activity .session-activity-empty",
      ),
      null,
    );
    const fileHeading = [
      ...env.document.querySelectorAll<HTMLButtonElement>(
        ".progress-section-heading",
      ),
    ].find((value) =>
      value.textContent?.includes(rich.cwd!.split("/").at(-1)!),
    )!;
    await act(async () => fileHeading.click());
    await act(async () =>
      env.query<HTMLButtonElement>(".progress-resource-row > button").click(),
    );
    assert.equal(artifacts.length, 1);
    const firstActivity = env.query(".progress-panel");
    await env.panel({
      active: { ...rich, id: "second-rich" },
      onArtifact: (value) => artifacts.push(value),
    });
    assert.notEqual(
      env.query(".progress-panel"),
      firstActivity,
      "resource UI belongs to its conversation, not the retained Tasks rail",
    );
    await env.panel({
      active: conversation("second"),
      onArtifact: (value) => artifacts.push(value),
    });
    assert.ok(
      env.document.querySelector(
        ".cowork-task-activity .session-activity-empty",
      ),
    );
    assert.equal(
      env.source.reads(),
      3,
      "session replacement retires the previous rail read",
    );
    await env.click('[aria-label="Close settings"]');
    assert.equal(
      env.query('[aria-label="Filter tasks"]').getAttribute("aria-pressed"),
      "true",
    );
    assert.match(
      env.query(".cowork-ongoing").textContent!,
      /ongoing code unaffected/,
    );
  } finally {
    await env.clean();
  }
});

test("Scheduled36/37: real context capabilities exclude ordinary Chat/Code/Mini and unsupported sources", () => {
  const base = {
    page: "chat",
    active: conversation(),
    role: "main" as const,
    host: desktopHost,
    scheduledEnabled: true,
  };
  assert.equal(taskRailContext(base)?.tasksAvailable, true);
  assert.equal(
    taskRailContext({ ...base, active: { ...base.active, mode: "chat" } }),
    undefined,
  );
  assert.equal(
    taskRailContext({ ...base, active: { ...base.active, mode: "code" } }),
    undefined,
  );
  assert.equal(taskRailContext({ ...base, role: "conversation" }), undefined);
  assert.equal(taskRailContext({ ...base, page: "scheduled" }), undefined);
  assert.equal(taskRailContext({ ...base, active: undefined }), undefined);
  assert.equal(taskRailContext({ ...base, host: webHost }), undefined);
  const remote = {
    ...base.active,
    environment: { kind: "space" as const, spaceId: "actual-space" },
  };
  const capable = {
    ...webHost,
    capabilities: {
      ...webHost.capabilities,
      cloudCowork: true,
      scheduledTasks: true,
    },
  };
  assert.equal(
    taskRailContext({ ...base, active: remote, host: capable })?.tasksAvailable,
    true,
  );
  assert.equal(
    taskRailContext({ ...base, active: remote, host: webHost }),
    undefined,
  );
  assert.equal(
    taskRailContext({ ...base, scheduledEnabled: false })?.tasksAvailable,
    false,
  );
});

test("Scheduled37: tasks unavailable shows real session Activity without calling an unavailable scheduler", async () => {
  const env = await setup(
    transport(async () => {
      throw new Error("must not call");
    }),
  );
  try {
    await env.panel({ tasksAvailable: false, active: conversation() });
    assert.ok(env.document.querySelector(".session-activity-empty"));
    assert.equal(
      env.document.querySelector('[aria-label="Filter tasks"]'),
      null,
    );
    assert.equal(env.document.querySelector('[aria-label="Settings"]'), null);
    assert.equal(env.source.reads(), 0);
    assert.deepEqual(env.errors, []);
  } finally {
    await env.clean();
  }
});

test("Scheduled36/38: the legacy opener uses the same real context gate, so a draft or ordinary Chat has no dead Tasks button", () => {
  const render = (active?: Conversation) =>
    renderToStaticMarkup(
      h(
        HostContext.Provider,
        { value: desktopHost },
        h(
          AppContext.Provider,
          {
            value: {
              page: "chat",
              active,
              windowRole: { kind: "main" },
              host: desktopHost,
              policy: openPolicy,
            } as AppController,
          },
          h(CoworkActiveSection, {
            conversations: [],
            onOpen: noop,
            onClear: noop,
          }),
        ),
      ),
    );
  assert.doesNotMatch(render(), /cowork-open-tasks/);
  assert.doesNotMatch(
    render({ ...conversation(), mode: "chat" }),
    /cowork-open-tasks/,
  );
  assert.doesNotMatch(
    render({ ...conversation(), mode: "code" }),
    /cowork-open-tasks/,
  );
  assert.match(render(conversation()), /class="cowork-open-tasks"/);
});

test("Scheduled38: portal is inside real available Chat content and width state cleans up without app grid columns", async () => {
  const env = await setup();
  try {
    const render = (active = conversation()) =>
      env.render(
        h(
          "div",
          { className: "app" },
          h("nav", { className: "sidebar" }),
          h(
            "div",
            { className: "workspace" },
            h(
              "div",
              { className: "chat-layout" },
              h(
                "main",
                { className: "chat-main" },
                h("div", { className: "messages-scroll" }, "Transcript"),
              ),
              h("aside", { className: "work-panel" }, "Another panel"),
            ),
          ),
          h(CoworkTasksPanelOverlay, { ...env.props, active }),
        ),
      );
    await render();
    const main = env.query<HTMLElement>(".chat-main");
    assert.ok(
      main.querySelector(
        ":scope > .cowork-task-rail-slot > .cowork-tasks-panel",
      ),
    );
    assert.equal(
      main.style.getPropertyValue("--cowork-task-rail-width"),
      "320px",
    );
    const separator = env.query(".cowork-tasks-resize");
    await env.key(separator, "ArrowLeft");
    assert.equal(
      main.style.getPropertyValue("--cowork-task-rail-width"),
      "336px",
    );
    const panel = env.query<HTMLElement>(".cowork-tasks-panel");
    panel.getBoundingClientRect = () => ({
      left: 564,
      right: 900,
      top: 0,
      bottom: 800,
      width: 336,
      height: 800,
      x: 564,
      y: 0,
      toJSON: () => ({}),
    });
    (separator as HTMLElement).hasPointerCapture = () => true;
    const pointer = new env.window.Event("pointermove", { bubbles: true });
    Object.assign(pointer, { pointerId: 1, clientX: 500 });
    await act(async () => {
      separator.dispatchEvent(pointer);
    });
    assert.equal(
      main.style.getPropertyValue("--cowork-task-rail-width"),
      "400px",
      "resize uses the content rail's right edge, not outer window width",
    );
    await render(conversation("new-session"));
    assert.equal(env.source.reads(), 2);
    assert.equal(env.query(".chat-main"), main);
    const css = postcss.parse(
      readFileSync(
        new URL("../../src/cowork/cowork-active.css", import.meta.url),
        "utf8",
      ),
    );
    const hiddenAt = (width: number) => {
      let hidden = false;
      css.walkAtRules("container", (rule) => {
        const maximum = rule.params.match(
          /cowork-task-content \(max-width: (\d+)px\)/,
        );
        if (maximum && width <= Number(maximum[1]))
          rule.walkRules((child) => {
            if (
              main
                .querySelector(".cowork-task-rail-slot")!
                .matches(child.selector)
            )
              child.walkDecls("display", (value) => {
                hidden = value.value === "none";
              });
          });
      });
      return hidden;
    };
    assert.equal(hiddenAt(767), true);
    assert.equal(hiddenAt(768), false);
    assert.equal(
      hiddenAt(1200 - 280 - 200),
      true,
      "a wide viewport can have narrow content after sidebar/another pane",
    );
    assert.equal(hiddenAt(1024 - 240), false);
    assert.equal(hiddenAt(390), true);
    assert.doesNotMatch(
      css.toString(),
      /\.app[^{}]*cowork-tasks-panel[^{}]*\{[^}]*grid-template-columns/,
    );
    await env.render(h("div"));
    assert.equal(main.style.getPropertyValue("--cowork-task-rail-width"), "");
  } finally {
    await env.clean();
  }
});

test("Scheduled36: actual App overlay requests detail and preserves the explicit open preference across routes", async () => {
  const env = await setup(transport(async () => [routine("route-task")]));
  const { TasksPanelOverlay } = await import("../../src/app/AppOverlays");
  const pages: string[] = [];
  takeScheduleRequest();
  const app = {
    accountId: "A",
    page: "chat",
    active: conversation(),
    windowRole: { kind: "main" },
    host: desktopHost,
    policy: openPolicy,
    snapshot: { conversations: [], approvals: [] },
    report: (error: unknown) => env.errors.push(error),
    openConversation: noop,
    setPage: (page: string) => {
      pages.push(page);
      app.page = page;
    },
  } as unknown as AppController;
  const render = () =>
    env.render(
      h(
        HostContext.Provider,
        { value: desktopHost },
        h(
          AppContext.Provider,
          { value: app },
          h(
            "div",
            { className: "app" },
            h(
              "div",
              { className: "workspace" },
              h(
                "div",
                { className: "chat-layout" },
                h("main", { className: "chat-main" }),
              ),
            ),
            h(TasksPanelOverlay),
          ),
        ),
      ),
    );
  try {
    await render();
    assert.equal(env.document.querySelector(".cowork-tasks-panel"), null);
    await act(async () =>
      env.window.dispatchEvent(new env.window.Event("claudex:tasks-panel")),
    );
    for (
      let attempt = 0;
      attempt < 30 && !env.document.querySelector(".cowork-ongoing a");
      attempt++
    )
      await env.settle();
    await env.click(".cowork-ongoing a");
    assert.deepEqual(takeScheduleRequest(), {
      description: "",
      openRoutineId: "route-task",
    });
    assert.deepEqual(pages, ["scheduled"]);
    await render();
    assert.equal(env.document.querySelector(".cowork-tasks-panel"), null);
    app.active = conversation("other");
    app.page = "chat";
    await render();
    await env.settle();
    assert.ok(env.document.querySelector(".cowork-tasks-panel"));
  } finally {
    takeScheduleRequest();
    await env.clean();
  }
});
