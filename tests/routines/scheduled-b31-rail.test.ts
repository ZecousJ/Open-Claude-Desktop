import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement as h } from "react";
import { desktopHost, type HostInfo } from "../../shared/host";
import { openPolicy } from "../../shared/client-policy";
import type { AppEvent, Conversation } from "../../shared/types";
import type { Routine } from "../../shared/routines";
import { fixtureSnapshot } from "../../scripts/preview/app-fixture";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { HostContext } from "../../src/host/HostContext";
import { TasksPanelOverlay } from "../../src/app/AppOverlays";
import { useTaskRail } from "../../src/cowork/useTaskRail";
import { CoworkTasksPanel } from "../../src/cowork/CoworkTasksPanel";
import { ArtifactPresentation } from "../../src/artifacts/artifact-presentation";
import { takeScheduleRequest } from "../../src/collections/routines/schedule-request";
import { atomicChatDom } from "../support/atomic-chat-dom";

const fixtures = fixtureSnapshot({ states: true });
const conversation = (id = "session-A"): Conversation => ({
  ...structuredClone(fixtures.conversations[0]),
  id,
  mode: "cowork",
  archived: false,
  incognito: false,
  environment: undefined,
  cwd: undefined,
  turns: [],
});
const routine = (id: string): Routine => ({
  id,
  name: id,
  prompt: "Task",
  mode: "cowork",
  providerId: "p",
  model: "m",
  enabled: true,
  frequency: "daily",
  nextRunAt: Date.now() + 60_000,
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
async function setup(
  bridge: Partial<Window["desktop"]> = { listSchedules: async () => [] },
) {
  const env = await atomicChatDom(bridge);
  const errors: unknown[] = [];
  const pages: string[] = [];
  const app = {
    accountId: "A",
    page: "chat",
    active: conversation(),
    controllerScope: {},
    currentController: { current: undefined },
    windowRole: { kind: "main" },
    host: desktopHost,
    policy: openPolicy,
    snapshot: { conversations: [], approvals: [], settings: {} },
    artifactPresentation: { current: new ArtifactPresentation() },
    report: (error: unknown) => errors.push(error),
    openConversation: () => {},
    setPage: (page: string) => {
      pages.push(page);
      app.page = page;
    },
  } as unknown as AppController;
  const render = () => {
    app.currentController!.current = app;
    return env.render(
      h(
        HostContext.Provider,
        { value: app.host! },
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
  };
  const query = <T extends Element = HTMLElement>(selector: string) => {
    const result = env.document.querySelector<T>(selector);
    assert.ok(result, selector);
    return result;
  };
  const click = (selector: string) =>
    act(async () => query<HTMLElement>(selector).click());
  const until = async (selector: string) => {
    for (
      let count = 0;
      count < 30 && !env.document.querySelector(selector);
      count++
    )
      await env.settle();
    return query(selector);
  };
  const toggle = () =>
    act(async () => {
      env.window.dispatchEvent(new env.window.Event("claudex:tasks-panel"));
    });
  return {
    ...env,
    mount: env.render,
    app,
    errors,
    pages,
    render,
    query,
    click,
    until,
    toggle,
  };
}

test("Scheduled36/37: mounted rail keeps explicit open/view through session and route changes, Escape closes it", async () => {
  const env = await setup();
  try {
    await env.render();
    assert.equal(env.document.querySelector(".cowork-tasks-panel"), null);
    await env.toggle();
    await env.until('[aria-label="Settings"]');
    const panel = env.query(".cowork-tasks-panel");
    await env.click('[aria-label="Settings"]');
    await env.until(".session-activity-empty");
    env.app.active = conversation("session-B");
    await env.render();
    assert.equal(
      env.query(".cowork-tasks-panel"),
      panel,
      "session navigation retains the rail component",
    );
    assert.equal(
      env.query('[aria-label="Close settings"]').getAttribute("aria-pressed"),
      "true",
    );
    env.app.page = "scheduled";
    await env.render();
    assert.equal(env.document.querySelector(".cowork-tasks-panel"), null);
    env.app.page = "chat";
    await env.render();
    await env.until(".session-activity-empty");
    assert.equal(
      env.query('[aria-label="Close settings"]').getAttribute("aria-pressed"),
      "true",
    );
    const key = await env.key(
      env.query('[aria-label="Close settings"]'),
      "Escape",
    );
    assert.equal(key.defaultPrevented, true);
    assert.equal(env.document.querySelector(".cowork-tasks-panel"), null);
    env.app.active = conversation("session-C");
    await env.render();
    assert.equal(env.document.querySelector(".cowork-tasks-panel"), null);
    await env.toggle();
    await env.until(".session-activity-empty");
    assert.ok(
      env.document.querySelector('[aria-label="Close settings"]'),
      "reopening preserves the chosen view",
    );
  } finally {
    await env.clean();
  }
});

test("Scheduled36: Ongoing opens canonical detail without changing the user's open preference", async () => {
  const env = await setup({
    listSchedules: async () => [routine("canonical / task")],
  });
  takeScheduleRequest();
  try {
    await env.render();
    await env.toggle();
    const link = await env.until(".cowork-ongoing a");
    assert.equal(
      link.getAttribute("href"),
      "/scheduled-task/canonical%20%2F%20task",
    );
    await env.click(".cowork-ongoing a");
    assert.deepEqual(takeScheduleRequest(), {
      description: "",
      openRoutineId: "canonical / task",
    });
    assert.deepEqual(env.pages, ["scheduled"]);
    await env.render();
    assert.equal(env.document.querySelector(".cowork-tasks-panel"), null);
    env.app.page = "chat";
    await env.render();
    await env.until(".cowork-tasks-panel");
  } finally {
    takeScheduleRequest();
    await env.clean();
  }
});

test("Scheduled37: actual backend capability and session source condition the switch and retire unsupported content", async () => {
  const env = await setup({});
  try {
    await env.render();
    await env.toggle();
    await env.until(".session-activity-empty");
    assert.equal(env.document.querySelector('[aria-label="Settings"]'), null);
    assert.equal(
      env.document.querySelector('[aria-label="Filter tasks"]'),
      null,
    );
    assert.equal(env.document.querySelector(".cowork-tasks-empty"), null);
    env.app.active = {
      ...conversation(),
      environment: { kind: "space", spaceId: "remote" },
    };
    await env.render();
    assert.equal(
      env.document.querySelector(".cowork-tasks-panel"),
      null,
      "unadvertised cloud tasks have no rail",
    );
    env.app.host = {
      ...desktopHost,
      capabilities: { ...desktopHost.capabilities, cloudCowork: true },
    };
    await env.render();
    await env.until(".session-activity-empty");
    env.app.active = { ...env.app.active, archived: true };
    await env.render();
    assert.equal(env.document.querySelector(".cowork-tasks-panel"), null);
    env.app.active = conversation("ordinary-chat");
    env.app.active.mode = "chat";
    await env.render();
    assert.equal(env.document.querySelector(".cowork-tasks-panel"), null);
    assert.deepEqual(env.errors, []);
  } finally {
    await env.clean();
  }
});

test("Scheduled36/37: retained callbacks retire on session/source, controller, account, bridge, and unmount", async () => {
  const env = await setup();
  let rail!: ReturnType<typeof useTaskRail>;
  function Harness() {
    rail = useTaskRail(env.app, env.app.host as HostInfo);
    return h("span", null, `${rail.open}:${rail.view}`);
  }
  const render = () => {
    env.app.currentController!.current = env.app;
    return env.mount(h(Harness));
  };
  try {
    await render();
    await act(async () => rail.toggle());
    const sessionA = rail;
    env.app.active = conversation("session-B");
    await render();
    assert.equal(sessionA.isCurrent(), false);
    await act(async () => {
      sessionA.close();
      sessionA.changeView("activity");
    });
    assert.equal(rail.open, true);
    assert.equal(rail.view, "tasks");
    const sessionB = rail;
    env.app.active = {
      ...conversation("session-B"),
      environment: { kind: "ssh", hostId: "other-host" },
    };
    await render();
    assert.equal(sessionB.isCurrent(), false);
    const source = rail;
    env.app.currentController!.current = {
      ...env.app,
      active: { ...env.app.active!, archived: true },
    };
    assert.equal(
      source.isCurrent(),
      false,
      "latest controller retirement is checked before another render",
    );
    env.app.currentController!.current = env.app;
    env.app.controllerScope = {};
    await render();
    assert.equal(source.isCurrent(), false);
    assert.equal(rail.open, false);
    await act(async () => source.toggle());
    assert.equal(rail.open, false);
    await act(async () => rail.toggle());
    const controller = rail;
    env.app.accountId = "B";
    await render();
    assert.equal(controller.isCurrent(), false);
    assert.equal(rail.open, false);
    const account = rail;
    env.app.accountId = "A";
    await render();
    assert.equal(
      controller.isCurrent(),
      false,
      "A to B to A does not reactivate old callbacks",
    );
    assert.equal(account.isCurrent(), false);
    const beforeBridge = rail;
    (env.window as unknown as Window).desktop = {
      listSchedules: async () => [],
    } as never;
    await render();
    assert.equal(beforeBridge.isCurrent(), false);
    const bridge = rail;
    await env.mount(h("div"));
    assert.equal(bridge.isCurrent(), false);
    await act(async () => {
      bridge.toggle();
      bridge.changeView("activity");
    });
  } finally {
    await env.clean();
  }
});

test("Scheduled36: late source reads/watchers cannot replace the current session's Ongoing rows", async () => {
  const first = deferred<Routine[]>(),
    second = deferred<Routine[]>();
  const callbacks: ((event: AppEvent) => void)[] = [];
  let reads = 0,
    removals = 0;
  const env = await setup({
    listSchedules: () => (++reads === 1 ? first.promise : second.promise),
    onEvent: (listener) => {
      callbacks.push(listener);
      return () => {
        removals++;
      };
    },
  });
  try {
    await env.render();
    await env.toggle();
    await env.until(".cowork-tasks-panel");
    env.app.active = conversation("replacement");
    await env.render();
    await act(async () => {
      first.resolve([routine("retired read")]);
      callbacks[0]({
        type: "schedules",
        schedules: [routine("retired event")],
      });
      second.resolve([routine("current task")]);
    });
    assert.match(env.query(".cowork-ongoing").textContent!, /current task/);
    assert.doesNotMatch(
      env.document.body.textContent!,
      /retired read|retired event/,
    );
    assert.equal(removals, 1);
    assert.deepEqual(env.errors, []);
  } finally {
    await env.clean();
  }
});

test("Scheduled37: integrated view opens a real generated output through the reused Progress surface", async () => {
  const env = await setup({
    listSchedules: async () => [],
    mcpServers: async () => ({ servers: [], configPath: "" }),
    linearStatus: async () => ({ connected: false }),
  });
  const rich = structuredClone(
    fixtures.conversations.find((value) => value.id === "c-activity")!,
  );
  const artifacts: unknown[] = [];
  const props = {
    conversations: [],
    approvals: [],
    active: rich,
    tasksAvailable: true,
    accountId: "A",
    onOpen: () => {},
    onRoutine: () => {},
    onClose: () => {},
    onError: () => {},
    onArtifact: (artifact: unknown) => artifacts.push(artifact),
  };
  try {
    await env.mount(h(CoworkTasksPanel, props));
    await env.click('[aria-label="Settings"]');
    await env.until(".progress-panel");
    const folder = [
      ...env.document.querySelectorAll<HTMLButtonElement>(
        ".progress-section-heading",
      ),
    ].find((value) =>
      value.textContent?.includes(rich.cwd!.split("/").at(-1)!),
    );
    assert.ok(folder);
    await act(async () => folder.click());
    await env.click(".progress-resource-row > button");
    assert.equal(artifacts.length, 1);
    assert.equal(
      (artifacts[0] as { conversationId: string }).conversationId,
      rich.id,
    );
    const progress = env.query(".progress-panel");
    await env.mount(
      h(CoworkTasksPanel, {
        ...props,
        active: { ...rich, environment: { kind: "ssh", hostId: "new-source" } },
      }),
    );
    assert.notEqual(
      env.query(".progress-panel"),
      progress,
      "resource disclosures retire when the same session changes source",
    );
  } finally {
    await env.clean();
  }
});
