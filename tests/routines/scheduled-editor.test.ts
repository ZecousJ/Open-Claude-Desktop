import type { ComponentType } from "react";
import test from "node:test";
import assert from "node:assert/strict";
import { createElement as h, useState, act } from "react";
import { routineDom } from "../support/routine-dom";
import { desktopHost, webHost } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { fixtureSnapshot } from "../../scripts/preview/app-fixture";
import { ScheduledTaskDialog } from "../../src/collections/routines/ScheduledTaskDialog";
import { RoutineEditor } from "../../src/collections/routines/RoutineEditor";
import { RoutineContextFields } from "../../src/collections/routines/RoutineContextFields";
import {
  draftInput,
  editDraft,
  newDraft,
  type RoutineDraft,
} from "../../src/collections/routines/routine-draft";
import {
  createScheduledChat,
  scheduledChatPrompt,
} from "../../src/sidebar/create-scheduled-chat";
import {
  scheduledChatSetupFor,
  clearScheduledChatSetup,
} from "../../src/collections/routines/scheduled-chat-setup";
import type { AppController } from "../../src/app/AppContext";
import type { Project } from "../../shared/types";

const settings = fixtureSnapshot({}).settings;
const future = Date.now() + 86400000;
const project = (id: string, kind: Project["kind"], cwd?: string): Project => ({
  id,
  kind,
  cwd,
  name: `Project ${id}`,
  description: "",
  instructions: "",
  createdAt: 1,
});
const ready = (): RoutineDraft => ({
  ...newDraft(Date.now()),
  name: "Task",
  prompt: "Review work",
  kind: "manual",
});

test("new source choice follows scheduler capabilities; edit never adds the source switch", async () => {
  const env = await routineDom({
    routineCapabilities: async () => ({
      remote: false,
      email: false,
      slack: false,
      sources: ["chat", "code"],
    }),
  });
  let result: RoutineDraft = ready();
  function Editor({ initial }: { initial: RoutineDraft }) {
    const [draft, set] = useState(initial);
    result = draft;
    return h(
      HostContext.Provider,
      { value: desktopHost },
      h(ScheduledTaskDialog, {
        draft,
        settings,
        onChange: set,
        onCancel() {},
        onSave: async () => {},
      }),
    );
  }
  try {
    await env.render(h(Editor, { initial: ready() }));
    assert.equal(
      env.document.querySelectorAll(".routine-source-picker button").length,
      2,
    );
    await env.click('.routine-source-picker [role="radio"][aria-label="Chat"]');
    assert.equal(result.mode, "cowork");
    assert.equal(
      env.document.querySelector('input[aria-label="Description"]'),
      null,
    );
    await env.click('.routine-source-picker [role="radio"][aria-label="Code"]');
    assert.equal(result.mode, "code");
    assert.ok(env.document.querySelector('input[aria-label="Description"]'));
    await env.render(
      h(Editor, {
        key: "chat-create",
        initial: { ...ready(), mode: "cowork" },
      }),
    );
    assert.equal(
      env.document.querySelector(".routine-source-picker"),
      null,
      "ordinary Chat creation matches the live branch",
    );
    await env.render(
      h(Editor, { key: "edit", initial: { ...ready(), id: "saved" } }),
    );
    assert.equal(env.document.querySelector(".routine-source-picker"), null);
  } finally {
    await env.clean();
  }
});

test("an unresolved or unsupported Code scheduler cannot gain a Code selector from host.cloudCode", async () => {
  const env = await routineDom({
    routineCapabilities: async () => ({
      remote: true,
      email: false,
      slack: false,
    }),
  });
  try {
    await env.render(
      h(
        HostContext.Provider,
        {
          value: {
            ...webHost,
            capabilities: {
              ...webHost.capabilities,
              cloudCode: true,
              cloudCowork: true,
              scheduledTasks: true,
            },
          },
        },
        h(ScheduledTaskDialog, {
          draft: { ...ready(), mode: "cowork" },
          settings,
          onChange() {},
          onCancel() {},
          onSave: async () => {},
        }),
      ),
    );
    assert.equal(env.document.querySelector(".routine-source-picker"), null);
    assert.equal(
      env.document.querySelector('input[aria-label="Description"]'),
      null,
    );
  } finally {
    await env.clean();
  }
});

test("the conditional local description is required, while explicit-empty data remains distinct from absent", async () => {
  const editors: ComponentType<Parameters<typeof RoutineEditor>[0]>[] = [
    RoutineEditor,
    ScheduledTaskDialog,
  ];
  for (const Component of editors) {
    const env = await routineDom({}, { jsdom: true });
    let saved: ReturnType<typeof draftInput> | undefined;
    function Editor() {
      const [draft, set] = useState<RoutineDraft>({
        ...ready(),
        description: "Original",
        descriptionProvided: true,
      });
      return h(
        HostContext.Provider,
        { value: desktopHost },
        h(Component, {
          draft,
          settings,
          onChange: set,
          onCancel() {},
          onChooseFolder: async () => null,
          onSave: async () => {
            saved = draftInput(draft, settings, future);
          },
        }),
      );
    }
    try {
      await env.render(h(Editor));
      await env.change('input[aria-label="Description"]', "");
      await env.event(env.document.querySelector("form")!, "submit");
      assert.equal(
        saved,
        undefined,
        "source Vl requires a rendered local description",
      );
      // Create stays enabled; pressing it marks the empty field.
      assert.equal(
        env.document.querySelector<HTMLButtonElement>('button[type="submit"]')!
          .disabled,
        false,
      );
      assert.equal(
        env.document
          .querySelector('input[aria-label="Description"]')!
          .getAttribute("aria-invalid"),
        "true",
      );
      await env.change(
        'input[aria-label="Description"]',
        "Revised description",
      );
      await env.event(env.document.querySelector("form")!, "submit");
      const completed = saved as ReturnType<typeof draftInput> | undefined;
      assert.ok(completed);
      assert.equal(completed.description, "Revised description");
      const empty = draftInput(
        { ...ready(), description: "", descriptionProvided: true },
        settings,
        future,
      );
      assert.equal(Object.hasOwn(empty, "description"), true);
      assert.equal(empty.description, "");
    } finally {
      await env.clean();
    }
  }
});

test("Create stays enabled on an empty task; pressing it marks the name and instructions and focuses the first", async () => {
  const editors: ComponentType<Parameters<typeof RoutineEditor>[0]>[] = [
    RoutineEditor,
    ScheduledTaskDialog,
  ];
  for (const Component of editors) {
    const env = await routineDom({}, { jsdom: true });
    let saves = 0;
    function Editor() {
      const [draft, set] = useState<RoutineDraft>({
        ...newDraft(Date.now(), undefined, "cowork"),
        kind: "manual",
      });
      return h(
        HostContext.Provider,
        { value: webHost },
        h(Component, {
          draft,
          settings,
          onChange: set,
          onCancel() {},
          onChooseFolder: async () => null,
          onSave: async () => {
            saves++;
          },
        }),
      );
    }
    try {
      await env.render(h(Editor));
      const create = env.document.querySelector<HTMLButtonElement>(
        'button[type="submit"]',
      )!;
      assert.equal(create.disabled, false);
      assert.equal(env.document.querySelector(".routine-problem"), null);
      await env.event(env.document.querySelector("form")!, "submit");
      assert.equal(saves, 0);
      const problems = [
        ...env.document.querySelectorAll(".routine-problem"),
      ].map((node) => node.textContent);
      assert.deepEqual(problems, ["Enter a name.", "Enter instructions."]);
      const name = env.document.querySelector("input")!;
      assert.equal(name.getAttribute("aria-invalid"), "true");
      assert.equal(env.document.activeElement, name);
      await env.change("input", "Morning");
      await env.event(env.document.querySelector("form")!, "submit");
      assert.equal(saves, 0);
      assert.equal(
        env.document.activeElement,
        env.document.querySelector("textarea"),
      );
      await env.change("textarea", "Summarize the news");
      await env.event(env.document.querySelector("form")!, "submit");
      assert.equal(saves, 1);
    } finally {
      await env.clean();
    }
  }
});

test("new project selection binds its real folder; remote and foreign source projects are excluded", async () => {
  const env = await routineDom({}, { jsdom: true });
  const projects = [
    project("chat", "chat"),
    project("local", "local", "/real/project"),
    project("code", "code"),
  ];
  let latest = ready();
  function Context() {
    const [draft, set] = useState<RoutineDraft>({ ...ready(), mode: "cowork" });
    latest = draft;
    return h(
      HostContext.Provider,
      { value: desktopHost },
      h(RoutineContextFields, {
        draft,
        projects,
        onChange: (patch) => set((value) => ({ ...value, ...patch })),
        onChooseFolder: async () => "/picked",
      }),
    );
  }
  try {
    await env.render(h(Context));
    const select = env.document.querySelector("select")!;
    assert.deepEqual(
      [...select.querySelectorAll("option")].map((row) => row.value),
      ["", "chat", "local"],
    );
    select.value = "local";
    await env.event(select, "change");
    assert.equal(latest.projectId, "local");
    assert.equal(latest.cwd, "/real/project");
    assert.equal(latest.executionLocation, "local");
    assert.equal(env.document.querySelector(".routine-context-actions"), null);
    const input = draftInput(latest, settings, future);
    assert.equal(input.projectId, "local");
    assert.equal(input.cwd, "/real/project");
    await env.render(
      h(
        HostContext.Provider,
        { value: webHost },
        h(RoutineContextFields, {
          draft: {
            ...latest,
            projectId: undefined,
            cwd: undefined,
            executionLocation: "remote",
          },
          projects,
          onChange() {},
          onChooseFolder: async () => "/should-not-use",
        }),
      ),
    );
    assert.deepEqual(
      [...env.document.querySelectorAll("option")].map((row) => row.value),
      [],
    );
    assert.equal(env.document.querySelector(".routine-context-actions"), null);
  } finally {
    await env.clean();
  }
});

test("editing on a different host keeps the actual project, environment and optional description", async () => {
  const env = await routineDom();
  const draft = {
    ...ready(),
    id: "saved",
    projectId: "unavailable",
    cwd: "/remote/project",
    environment: { kind: "ssh" as const, hostId: "real-host" },
  };
  try {
    await env.render(
      h(
        HostContext.Provider,
        { value: webHost },
        h(RoutineContextFields, {
          draft,
          projects: [],
          onChange() {},
          onChooseFolder: async () => "/wrong-host",
        }),
      ),
    );
    assert.equal(env.document.querySelector("select")?.disabled, true);
    assert.equal(env.document.querySelector("select")?.value, "unavailable");
    assert.equal(env.document.querySelector(".routine-context-actions"), null);
    const input = draftInput(draft, settings, future);
    assert.deepEqual(input.environment, draft.environment);
    assert.equal(Object.hasOwn(input, "description"), false);
    const again = editDraft(
      { ...input, id: "saved", createdAt: 1, updatedAt: 1 },
      { kind: "manual" },
      settings,
    );
    assert.deepEqual(again.environment, draft.environment);
  } finally {
    await env.clean();
  }
});

test("Chat setup action waits for real capability and retains scoped intent through failed-send retry", async () => {
  let capable = false;
  const env = await routineDom({
    routineCapabilities: async () => ({
      remote: false,
      email: false,
      slack: false,
      setupWithChat: capable,
    }),
  });
  let opens = 0;
  const scope = {};
  const app = {
    accountId: "owner",
    controllerScope: scope,
    page: "scheduled",
    mode: "chat",
    draftSession: "old",
    text: "",
    attachments: [],
    skillTokens: [],
    incognitoShown: false,
    newChat(
      _mode: string,
      projectId: string | undefined,
      _incognito: boolean,
      after: (draft: { mode: "chat"; draftSession: string }) => void,
    ) {
      opens++;
      Object.assign(app, {
        page: "chat",
        active: undefined,
        activeId: undefined,
        draftSession: "created",
        projectId,
      });
      after({ mode: "chat", draftSession: "created" });
    },
    setText(text: string) {
      app.text = text;
    },
    setSkillTokens() {},
    setAttachments() {},
    setCwd() {},
    report(error: unknown) {
      throw error;
    },
  } as unknown as AppController;
  try {
    await env.render(
      h(
        "button",
        {
          onClick: () => {
            void createScheduledChat(app, scheduledChatPrompt, {
              projectId: "real-project",
              cwd: "/real",
            });
          },
        },
        "Create with Claudex",
      ),
    );
    await env.click("button");
    assert.equal(opens, 0);
    capable = true;
    await env.click("button");
    assert.equal(opens, 1);
    assert.equal(app.text, scheduledChatPrompt);
    const intent = scheduledChatSetupFor(app)!;
    assert.deepEqual(intent, {
      returnTo: "scheduled",
      projectId: "real-project",
      cwd: "/real",
    });
    // A rejected send does not clear it. A different account/draft cannot read it.
    assert.equal(scheduledChatSetupFor(app), intent);
    assert.equal(
      scheduledChatSetupFor({ ...app, accountId: "other" }),
      undefined,
    );
    assert.equal(
      scheduledChatSetupFor({ ...app, draftSession: "other" }),
      undefined,
    );
    clearScheduledChatSetup(app, intent);
    assert.equal(scheduledChatSetupFor(app), undefined);
  } finally {
    await env.clean();
  }
});

test("a pending local folder response cannot overwrite a changed project or a saving form", async () => {
  let resolve!: (cwd: string | null) => void;
  let writes = 0;
  const env = await routineDom();
  const initial = ready();
  const render = (draft: RoutineDraft, disabled = false) =>
    env.render(
      h(
        HostContext.Provider,
        { value: desktopHost },
        h(RoutineContextFields, {
          draft,
          disabled,
          onChange() {
            writes++;
          },
          onChooseFolder: () =>
            new Promise<string | null>((done) => {
              resolve = done;
            }),
        }),
      ),
    );
  try {
    await render(initial);
    await env.click(".routine-context-actions button");
    await render({ ...initial, projectId: "new-project" });
    await act(async () => resolve("/stale-folder"));
    assert.equal(writes, 0);
    await render(initial);
    await env.click(".routine-context-actions button");
    await render(initial, true);
    await act(async () => resolve("/saving-folder"));
    assert.equal(writes, 0);
  } finally {
    await env.clean();
  }
});

test("setup capability arriving after navigation cannot replace the user's current Chat", async () => {
  let resolve!: (value: {
    remote: boolean;
    email: boolean;
    slack: boolean;
    setupWithChat: boolean;
  }) => void;
  let opens = 0;
  const env = await routineDom({
    routineCapabilities: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const app = {
    accountId: "owner",
    controllerScope: {},
    page: "scheduled",
    mode: "chat",
    draftSession: "origin",
    newChat() {
      opens++;
    },
    report(error: unknown) {
      throw error;
    },
  } as unknown as AppController;
  try {
    const pending = createScheduledChat(app, scheduledChatPrompt);
    await Promise.resolve();
    app.page = "chat";
    app.draftSession = "user-created";
    resolve({ remote: false, email: false, slack: false, setupWithChat: true });
    assert.equal(await pending, false);
    assert.equal(opens, 0);
    assert.equal(scheduledChatSetupFor(app), undefined);
  } finally {
    await env.clean();
  }
});

test("a chosen local folder keeps the new task local until it is removed, with the create location control retained", async () => {
  const env = await routineDom({
    routineCapabilities: async () => ({
      remote: true,
      email: false,
      slack: false,
      sources: ["chat", "code"],
    }),
  });
  let latest = ready();
  function Editor() {
    const [draft, set] = useState(ready());
    latest = draft;
    return h(
      HostContext.Provider,
      { value: desktopHost },
      h(RoutineEditor, {
        draft,
        settings,
        onChange: set,
        onCancel() {},
        onSave: async () => {},
        onChooseFolder: async () => "/actual/chosen",
      }),
    );
  }
  try {
    await env.render(h(Editor));
    assert.equal(
      env.document.querySelector<HTMLButtonElement>(
        '[aria-label="Only on this computer"]',
      )?.disabled,
      false,
    );
    await env.click(".routine-context-actions button:first-child");
    assert.equal(latest.cwd, "/actual/chosen");
    assert.equal(latest.executionLocation, "local");
    assert.equal(
      env.document.querySelector<HTMLButtonElement>(
        '[aria-label="Only on this computer"]',
      )?.disabled,
      true,
    );
    await env.click(".routine-context-actions button:last-child");
    assert.equal(latest.cwd, undefined);
    assert.equal(
      env.document.querySelector<HTMLButtonElement>(
        '[aria-label="Only on this computer"]',
      )?.disabled,
      false,
    );
    await env.click('[aria-label="Only on this computer"]');
    assert.equal(latest.executionLocation, "remote");
    assert.equal(env.document.querySelector(".routine-context-actions"), null);
    assert.equal(
      env.document.querySelector('input[aria-label="Description"]'),
      null,
    );
  } finally {
    await env.clean();
  }
});
