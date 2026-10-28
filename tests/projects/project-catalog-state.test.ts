import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h, useRef, useState } from "react";
import type { AppEvent, Project, Snapshot } from "../../shared/types";
import { CloudRouter } from "../../electron/cloud/cloud-router";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { useDesktopEvents } from "../../src/app/useDesktopEvents";
import {
  checkConnectionNow,
  registerConnectionCheck,
} from "../../src/app/connection";
import { ArtifactPresentation } from "../../src/artifacts/artifact-presentation";
import { ProjectPicker } from "../../src/composer/ProjectPicker";
import { NativeProjectPicker } from "../../src/composer/NativeProjectPicker";
import {
  useProjectCatalogState,
  type ProjectCatalogRead,
} from "../../src/composer/useProjectCatalogState";
import { routineDom } from "../support/routine-dom";

const project = (id: string): Project => ({
  id,
  name: id,
  description: "",
  instructions: "",
  createdAt: 1,
});
const snapshot = (projects: Project[] = []): Snapshot =>
  ({
    conversations: [],
    projects,
    approvals: [],
    settings: {
      activeProviderId: "provider",
      providers: [{ id: "provider", model: "model" }],
    },
  }) as unknown as Snapshot;
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const settle = () =>
  act(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

async function pickerDom(bridge: Partial<Window["desktop"]>) {
  const env = await routineDom(bridge);
  const globals = {
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener: env.window.addEventListener.bind(env.window),
    removeEventListener: env.window.removeEventListener.bind(env.window),
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
  env.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 100,
    y: 500,
    left: 100,
    top: 500,
    bottom: 524,
    right: 180,
    width: 80,
    height: 24,
    toJSON() {},
  });
  return {
    ...env,
    async clean() {
      await env.clean();
      for (const [key, value] of saved) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

function eventsBridge(read: () => Promise<Snapshot>) {
  const listeners = new Set<(event: AppEvent) => void>();
  let reads = 0;
  const bridge = {
    snapshot: () => {
      reads++;
      return read();
    },
    onEvent: (listener: (event: AppEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    listSchedules: async () => [],
  } as unknown as Window["desktop"];
  return {
    bridge,
    reads: () => reads,
    emit(event: AppEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function makeHarness(native: boolean, errors: unknown[], boots: unknown[]) {
  const picked: string[] = [];
  const observe: { snapshot?: Snapshot; read?: ProjectCatalogRead } = {};
  function ReadState() {
    observe.read = useProjectCatalogState();
    return null;
  }
  function Harness() {
    const [state, setSnapshot] = useState<Snapshot>();
    const latest = useRef(state);
    latest.current = state;
    observe.snapshot = state;
    const scope = useRef({});
    const currentController = useRef<AppController | undefined>(undefined);
    const [, stringSetter] = useState("");
    const [, optionalSetter] = useState<string>();
    const [, numberSetter] = useState(0);
    const [, artifactSetter] = useState<never>();
    const [, panelSetter] = useState<null>(null);
    const presentation = useRef({ page: "chat", settingsOpen: false });
    const selectNext = useRef(false);
    const artifactPresentation = useRef(new ArtifactPresentation());
    const runCommand = useRef(() => {});
    useDesktopEvents({
      latest,
      presentation,
      selectNext,
      artifactPresentation,
      runCommand,
      setSnapshot,
      upsert() {},
      report(error) {
        errors.push(error);
      },
      onBootFailure(error) {
        boots.push(error);
      },
      setActiveId: optionalSetter,
      setArtifact: artifactSetter as never,
      setArtifactWidth: numberSetter,
      setPanel: panelSetter as never,
      setProviderId: stringSetter,
      setModel: stringSetter,
      setError: stringSetter,
    });
    if (!state) return h("p", { "data-boot": true }, "Boot shell");
    const app = {
      accountId: "project-catalog-account",
      controllerScope: scope.current,
      currentController,
      snapshot: state,
      report(error: unknown) {
        errors.push(error);
      },
    } as AppController;
    currentController.current = app;
    const props = {
      projects: state.projects,
      onProject(id: string) {
        picked.push(id);
      },
      onCreateProject() {
        assert.fail("Retry must not create a project");
      },
      collapsed: false,
      platform: "darwin" as const,
    };
    return h(
      AppContext.Provider,
      { value: app },
      h(ReadState),
      native
        ? h(NativeProjectPicker, {
            ...props,
            setCwd() {
              assert.fail("Retry must not select a folder");
            },
            async pickFolder() {
              assert.fail("Retry must not browse folders");
            },
          })
        : h(ProjectPicker, props),
    );
  }
  return { Harness, picked, observe };
}

for (const native of [false, true])
  test(`${native ? "native" : "web"} project picker distinguishes a real first cloud failure and retries through the registered snapshot chain once`, async () => {
    const cloudReply = deferred<{ snapshot: Snapshot }>();
    let cloudReads = 0;
    const client = {
      snapshot: () =>
        ++cloudReads === 1
          ? Promise.reject(new Error("synthetic cloud unavailable"))
          : cloudReply.promise,
      call: async () => undefined,
    };
    const router = new CloudRouter({
      device: () => ({ id: "test-device", name: "Test device" }),
      client: () => client,
      push() {},
      attachmentBytes: async () => undefined,
      setTimeout: () => 1,
      clearTimeout() {},
    });
    const api = eventsBridge(() => router.merge(snapshot()));
    const env = await pickerDom(api.bridge);
    const errors: unknown[] = [],
      boots: unknown[] = [];
    const { Harness, observe } = makeHarness(native, errors, boots);
    try {
      await env.render(h(Harness));
      await settle();
      assert.deepEqual(observe.snapshot?.projectCatalog, {
        status: "failed",
        cached: false,
      });
      assert.deepEqual(boots, []);
      await env.click(".cowork-options > button");
      await settle();
      assert.match(
        env.document.querySelector('[role="alert"]')?.textContent ?? "",
        /Couldn’t load this.*Retry/,
      );
      assert.doesNotMatch(
        env.document.body.textContent ?? "",
        /No projects yet\.|No matches/,
      );
      assert.equal(
        env.document.querySelector('[role="listbox"] [role="alert"]'),
        null,
      );
      const retry = env.document.querySelector('[role="alert"] button')!;
      await act(async () => {
        retry.dispatchEvent(new env.window.Event("click", { bubbles: true }));
        retry.dispatchEvent(new env.window.Event("click", { bubbles: true }));
      });
      assert.equal(api.reads(), 2);
      assert.equal(cloudReads, 2);
      assert.equal(
        env.document
          .querySelector('[role="listbox"]')
          ?.getAttribute("aria-busy"),
        "true",
      );
      assert.match(
        env.document
          .querySelector('[role="status"]')
          ?.getAttribute("aria-label") ?? "",
        /Loading/,
      );
      assert.equal(
        env.document.querySelectorAll('[role="status"] .project-picker-row')
          .length,
        3,
      );
      assert.deepEqual(
        [
          ...env.document.querySelectorAll(
            '[role="status"] .project-picker-row > .sk:last-child',
          ),
        ].map((row) => (row as HTMLElement).style.width),
        ["160px", "128px", "144px"],
      );
      await env.change('input[role="combobox"]', "not-yet-confirmed");
      assert.match(
        env.document.querySelector('[data-place-key="create"]')?.textContent ??
          "",
        /^New project$/,
      );
      assert.doesNotMatch(
        env.document.body.textContent ?? "",
        /Create not-yet-confirmed/,
      );
      assert.doesNotMatch(
        env.document.body.textContent ?? "",
        /No projects yet\.|No matches/,
      );
      await act(async () =>
        cloudReply.resolve({
          snapshot: snapshot([project("actual-cloud-row")]),
        }),
      );
      await env.change('input[role="combobox"]', "");
      assert.equal(api.reads(), 2);
      assert.equal(env.document.querySelector('[role="alert"]'), null);
      assert.equal(
        env.document
          .querySelector('[role="listbox"]')
          ?.getAttribute("aria-busy"),
        null,
      );
      assert.equal(
        env.document
          .querySelector('[role="listbox"]')
          ?.getAttribute("data-project-cached"),
        "true",
      );
      assert.ok(
        env.document.querySelector(
          '[data-place-key="project:actual-cloud-row"]',
        ),
      );
      assert.deepEqual(errors, []);
    } finally {
      await env.clean();
    }
  });

test("cached cloud and local project rows remain usable while a partial read fails; a known empty catalogue is genuinely empty", async () => {
  let failure = false;
  let cloudRows = [project("actual-cloud-cache")];
  const client = {
    snapshot: async () => {
      if (failure) throw Error("synthetic cached read failed");
      return { snapshot: snapshot(cloudRows) };
    },
    call: async () => undefined,
  };
  const router = new CloudRouter({
    device: () => ({ id: "test-device", name: "Test device" }),
    client: () => client,
    push() {},
    attachmentBytes: async () => undefined,
    setTimeout: () => 1,
    clearTimeout() {},
  });
  let localRows = [project("actual-local-row")];
  const api = eventsBridge(() => router.merge(snapshot(localRows)));
  const env = await pickerDom(api.bridge);
  const errors: unknown[] = [],
    boots: unknown[] = [];
  const { Harness, picked } = makeHarness(false, errors, boots);
  try {
    await env.render(h(Harness));
    await settle();
    await env.click(".cowork-options > button");
    await settle();
    failure = true;
    await act(async () => {
      api.emit({ type: "resync" });
    });
    assert.equal(
      env.document
        .querySelector('[role="listbox"]')
        ?.getAttribute("data-project-cached"),
      "true",
    );
    assert.equal(
      env.document
        .querySelector('[role="listbox"]')
        ?.getAttribute("data-project-catalog"),
      "failed",
    );
    assert.ok(
      env.document.querySelector(
        '[data-place-key="project:actual-cloud-cache"]',
      ),
    );
    assert.ok(
      env.document.querySelector('[data-place-key="project:actual-local-row"]'),
    );
    await env.click('[data-place-key="project:actual-local-row"]');
    assert.deepEqual(picked, ["actual-local-row"]);
    failure = false;
    cloudRows = [];
    localRows = [];
    await act(async () => {
      await checkConnectionNow();
    });
    await env.click(".cowork-options > button");
    assert.match(
      env.document.querySelector('[role="listbox"]')?.textContent ?? "",
      /No projects yet\./,
    );
    assert.equal(env.document.querySelector('[role="alert"]'), null);
    assert.equal(
      env.document
        .querySelector('[role="listbox"]')
        ?.getAttribute("data-project-cached"),
      "true",
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(boots, []);
  } finally {
    await env.clean();
  }
});

test("whole snapshot failures retain BootError and reconnect reporting instead of becoming an empty project catalogue", async () => {
  let failure = true;
  const api = eventsBridge(async () => {
    if (failure) throw Error("synthetic whole snapshot failed");
    return snapshot([project("local-usable")]);
  });
  const env = await pickerDom(api.bridge);
  const errors: unknown[] = [],
    boots: unknown[] = [];
  const { Harness, observe } = makeHarness(false, errors, boots);
  try {
    await env.render(h(Harness));
    await settle();
    assert.equal(boots.length, 1);
    assert.equal(observe.snapshot, undefined);
    assert.equal(env.document.querySelector(".cowork-options"), null);
    failure = false;
    await act(async () => {
      await checkConnectionNow();
    });
    await env.click(".cowork-options > button");
    await settle();
    assert.equal(
      (observe.snapshot as Snapshot | undefined)?.projectCatalog,
      undefined,
    );
    failure = true;
    await act(async () => {
      await checkConnectionNow();
    });
    assert.equal(errors.length, 1);
    assert.ok(
      env.document.querySelector('[data-place-key="project:local-usable"]'),
    );
    assert.equal(env.document.querySelector('[role="alert"]'), null);
    assert.equal(observe.read?.status, "ready");
  } finally {
    await env.clean();
  }
});

test("a late resync from a replaced bridge cannot replace the current project's catalogue or report its error", async () => {
  const old = deferred<Snapshot>();
  let oldReads = 0;
  const a = eventsBridge(() =>
    ++oldReads === 1
      ? Promise.resolve(snapshot([project("bridge-a")]))
      : old.promise,
  );
  const b = eventsBridge(async () => snapshot([project("bridge-b")]));
  const env = await pickerDom(a.bridge);
  const errors: unknown[] = [],
    boots: unknown[] = [];
  const { Harness, observe } = makeHarness(false, errors, boots);
  try {
    await env.render(h(Harness));
    await settle();
    let pending!: Promise<void>;
    await act(async () => {
      pending = checkConnectionNow();
    });
    env.window.desktop = b.bridge;
    await env.render(h(Harness));
    await act(async () => {
      await checkConnectionNow();
    });
    assert.equal(b.reads(), 1);
    await act(async () => {
      old.resolve(snapshot([project("stale-bridge-a")]));
      await pending;
    });
    assert.deepEqual(
      observe.snapshot?.projects.map((row) => row.id),
      ["bridge-b"],
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(boots, []);
  } finally {
    await env.clean();
  }
});

test("project Retry clears its pending slot on account/bridge replacement and ignores retained callbacks and unmounted failures", async () => {
  const env = await pickerDom({});
  const pending: ReturnType<typeof deferred<void>>[] = [];
  let checks = 0;
  registerConnectionCheck(() => {
    checks++;
    const next = deferred<void>();
    pending.push(next);
    return next.promise;
  });
  const errors: unknown[] = [];
  let read!: ProjectCatalogRead;
  const controllerScope = {};
  const failed = {
    ...snapshot(),
    projectCatalog: { status: "failed" as const, cached: false },
  };
  function Probe() {
    read = useProjectCatalogState();
    return h("output", null, read.status);
  }
  const render = (accountId: string) =>
    env.render(
      h(
        AppContext.Provider,
        {
          value: {
            accountId,
            controllerScope,
            snapshot: failed,
            report(error: unknown) {
              errors.push(error);
            },
          } as AppController,
        },
        h(Probe),
      ),
    );
  try {
    await render("account-a");
    const staleA = read.retry;
    await act(async () => {
      read.retry();
      read.retry();
    });
    assert.equal(checks, 1);
    assert.equal(read.status, "pending");
    await render("account-b");
    assert.equal(read.status, "failed");
    await act(async () => staleA());
    assert.equal(checks, 1);
    await act(async () => {
      pending[0].reject(Error("late account-a"));
    });
    assert.equal(read.status, "failed");
    assert.deepEqual(errors, []);
    const staleB = read.retry;
    env.window.desktop = { ...env.window.desktop };
    await render("account-b");
    await act(async () => staleB());
    assert.equal(checks, 1);
    await act(async () => read.retry());
    assert.equal(checks, 2);
    await env.render(h("p", null, "closed"));
    await act(async () => pending[1].reject(Error("late unmounted retry")));
    assert.deepEqual(errors, []);
  } finally {
    registerConnectionCheck(undefined);
    await env.clean();
  }
});

test("a current Retry rejection reports the real error once and leaves the failed catalogue retryable", async () => {
  const env = await pickerDom({});
  const failure = Error("synthetic checker rejected");
  let calls = 0;
  registerConnectionCheck(async () => {
    calls++;
    throw failure;
  });
  let read!: ProjectCatalogRead;
  const errors: unknown[] = [];
  function Probe() {
    read = useProjectCatalogState();
    return null;
  }
  try {
    await env.render(
      h(
        AppContext.Provider,
        {
          value: {
            accountId: "retry-errors",
            snapshot: {
              ...snapshot(),
              projectCatalog: { status: "failed", cached: false },
            },
            report(error: unknown) {
              errors.push(error);
            },
          } as AppController,
        },
        h(Probe),
      ),
    );
    await act(async () => read.retry());
    assert.equal(calls, 1);
    assert.equal(read.status, "failed");
    assert.deepEqual(errors, [failure]);
    await act(async () => read.retry());
    assert.equal(calls, 2);
    assert.deepEqual(errors, [failure, failure]);
  } finally {
    registerConnectionCheck(undefined);
    await env.clean();
  }
});
