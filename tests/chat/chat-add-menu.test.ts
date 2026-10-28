import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import { defaultSettings } from "../../electron/store/store";
import { openPolicy, type ClientPolicy } from "../../shared/client-policy";
import type { ChatDeviceDirectory } from "../../shared/chat-devices-api";
import type {
  CustomizeSkill,
  DesignSystem,
} from "../../shared/collections-api";
import type { Conversation } from "../../shared/types";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { ComposerAddMenu } from "../../src/composer/ComposerAddMenu";
import { PolicyProvider } from "../../src/policy/PolicyContext";
import { draftChatDevice } from "../../src/composer/chat-device-selection";
import { routineDom } from "../support/routine-dom";

const noop = () => {};
const skill: CustomizeSkill = {
  name: "reference-skill",
  description: "Reference skill",
  path: "/reference/SKILL.md",
  scope: "user",
  enabled: true,
  own: true,
};
const design: DesignSystem = {
  id: "reference-design",
  name: "Reference design",
  blurb: "",
  notes: "",
  sources: [],
  guidelines: "Reference guidelines",
  createdAt: 1,
  updatedAt: 1,
};
const device = {
  id: "reference-computer",
  name: "Reference computer",
  platform: "darwin",
  version: "1",
  connectedAt: "2026-10-18T00:00:00Z",
  online: true,
  computerAccess: true,
  chatBindingVersion: 1 as const,
  chatModes: ["chat" as const, "cowork" as const],
  chatPermissionModes: ["default" as const, "auto" as const],
};
const directory: ChatDeviceDirectory = {
  version: 1,
  accountScope: "reference-account",
  organizationId: null,
  devices: [device],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function controller(patch: Partial<AppController> = {}) {
  const app = {
    accountId: "account-a",
    controllerScope: {},
    draftSession: "draft-a",
    mode: "chat",
    running: false,
    sending: false,
    incognitoShown: false,
    snapshot: {
      settings: {
        ...defaultSettings,
        taskPermission: "default",
        mcpServers: {
          "Reference connector": { command: "reference", enabled: true },
        },
      },
    },
    composerDraft: { draftConnectors: {}, setDraftConnectors: noop },
    report: (error: unknown) => {
      throw error;
    },
    upsert: noop,
    updatePreference: async () => {},
    patchConversation: async () => {},
    ...patch,
  } as unknown as AppController;
  app.currentController = { current: app };
  return app;
}

async function environment(api: Partial<Window["desktop"]> = {}) {
  const env = await routineDom(
    {
      customizeSkills: async () => [skill],
      listDesignSystems: async () => [design],
      chatDevices: async () => directory,
      listCoworkDevices: async () => [],
      clientPolicy: async () => openPolicy,
      send: async () => assert.fail("opening an Add menu must not send"),
      setSkillEnabled: async () =>
        assert.fail("inserting a skill must not install or enable it"),
      ...api,
    },
    { jsdom: true },
  );
  env.window.matchMedia = ((query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)",
    addEventListener() {},
    removeEventListener() {},
  })) as never;
  const globals = {
    HTMLInputElement: env.window.HTMLInputElement,
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
      clearTimeout(id),
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const calls = {
    close: 0,
    files: 0,
    research: 0,
    settings: [] as string[],
    skills: [] as CustomizeSkill[],
  };
  const render = (
    app: AppController,
    props: Partial<Parameters<typeof ComposerAddMenu>[0]> = {},
  ) =>
    env.render(
      h(
        PolicyProvider,
        null,
        h(
          AppContext.Provider,
          { value: app },
          h(ComposerAddMenu, {
            presentation: "web-chat",
            platform: "darwin",
            projects: [],
            webSearch: false,
            webSearchAvailable: true,
            onWebSearch: () =>
              assert.fail("web Chat has no separate Web search row"),
            research: false,
            researchAvailable: true,
            onResearch() {
              calls.research++;
            },
            onClose() {
              calls.close++;
            },
            onFiles() {
              calls.files++;
            },
            onSkill(value) {
              calls.skills.push(value);
            },
            onProject: () =>
              assert.fail("web Chat project selection lives in the chin"),
            onCreateProject: noop,
            onGitHub: () => assert.fail("web Chat has no root GitHub row"),
            onFolder: () =>
              assert.fail("web Chat cannot authorize a native folder"),
            onThinking: noop,
            onSettings(tab) {
              calls.settings.push(tab);
            },
            onUnavailable: noop,
            ...props,
          }),
        ),
      ),
    );
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  const root = () =>
    env.document.querySelector<HTMLElement>('.composer-add-menu[role="menu"]')!;
  const panel = (name: string) =>
    env.document.querySelector<HTMLElement>(`[data-add-panel="${name}"]`)!;
  const buttons = (element: HTMLElement) => [
    ...element.querySelectorAll<HTMLButtonElement>("button"),
  ];
  const button = (element: HTMLElement, label: string) => {
    const match = buttons(element).find(
      (item) =>
        item.querySelector("span:not([aria-hidden])")?.textContent === label,
    );
    assert.ok(match, label);
    return match;
  };
  const key = async (element: Element, key: string) => {
    await env.event(element, "keydown", { key });
    await settle();
  };
  return {
    ...env,
    calls,
    render,
    settle,
    root,
    panel,
    buttons,
    button,
    key,
    async clean() {
      await env.clean();
      for (const [key, value] of previous) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("web Chat Add renders the captured root order and its working file, plugin and Research actions", async () => {
  const env = await environment();
  try {
    await env.render(controller());
    const rows = [...env.root().children].map((item) => {
      if (item.getAttribute("role") === "separator") return "separator";
      const button =
        item.tagName === "BUTTON"
          ? item
          : item.querySelector(":scope > button")!;
      return button.querySelector("span:not([aria-hidden])")?.textContent;
    });
    assert.deepEqual(rows, [
      "Upload or add files",
      "separator",
      "Skills",
      "Connectors",
      "Design system",
      "Add plugins",
      "Devices",
      "separator",
      "Research",
    ]);
    assert.deepEqual(
      [
        ...env
          .button(env.root(), "Upload or add files")
          .querySelectorAll("kbd"),
      ].map((key) => key.textContent),
      ["⌘", "U"],
    );
    await env.event(env.button(env.root(), "Upload or add files"), "click");
    await env.event(env.button(env.root(), "Add plugins"), "click");
    const research = env.button(env.root(), "Research");
    assert.equal(research.getAttribute("role"), "menuitemcheckbox");
    assert.equal(research.getAttribute("aria-checked"), "false");
    await env.event(research, "click");
    assert.deepEqual(env.calls, {
      close: 3,
      files: 1,
      research: 1,
      settings: ["plugins"],
      skills: [],
    });
  } finally {
    await env.clean();
  }
});

test("web Chat Add hides administrator-disabled attachment, Research and connector capabilities", async () => {
  const restricted: ClientPolicy = {
    ...openPolicy,
    webSearch: false,
    connectors: [],
    attachments: { maxBytes: null, types: [] },
  };
  const env = await environment({ clientPolicy: async () => restricted });
  try {
    await env.render(controller());
    const rootLabels = env
      .buttons(env.root())
      .map(
        (button) =>
          button.querySelector("span:not([aria-hidden])")?.textContent,
      );
    assert.equal(rootLabels.includes("Upload or add files"), false);
    assert.equal(rootLabels.includes("Research"), false);
    await env.click('[data-add-branch="connectors"]');
    assert.equal(
      env.panel("connectors").querySelector('[role="menuitemcheckbox"]'),
      null,
    );
    assert.ok(env.button(env.panel("connectors"), "Manage connectors"));
    // No connectors yet: the entry adds them (Browse connectors once there are some).
    assert.ok(env.button(env.panel("connectors"), "Add connectors"));
    assert.ok(
      env.root().querySelector('[data-add-branch="devices"]'),
      "device capability is independent of search/attachment policy",
    );
  } finally {
    await env.clean();
  }
});

for (const context of ["code", "incognito"] as const) {
  test(`web Chat Add does not read or display Devices for ineligible ${context} context`, async () => {
    let reads = 0;
    const env = await environment({
      chatDevices: async () => {
        reads++;
        return directory;
      },
    });
    try {
      await env.render(
        controller(
          context === "code" ? { mode: "code" } : { incognitoShown: true },
        ),
      );
      assert.equal(reads, 0);
      assert.equal(
        env.root().querySelector('[data-add-branch="devices"]'),
        null,
      );
    } finally {
      await env.clean();
    }
  });
}

test("web Chat Skills inserts only an enabled callable skill and opens management through the real callbacks", async () => {
  const env = await environment({
    customizeSkills: async () => [
      skill,
      { ...skill, name: "disabled-skill", enabled: false },
    ],
  });
  try {
    await env.render(controller());
    await env.click('[data-add-branch="skills"]');
    assert.equal(env.panel("skills").getAttribute("data-add-state"), "loaded");
    assert.deepEqual(
      env
        .buttons(env.panel("skills"))
        .map(
          (button) =>
            button.querySelector("span:not([aria-hidden])")?.textContent,
        ),
      [skill.name, "Manage skills"],
    );
    await env.event(env.button(env.panel("skills"), skill.name), "click");
    assert.deepEqual(env.calls.skills, [skill]);
    await env.event(env.button(env.panel("skills"), "Manage skills"), "click");
    assert.deepEqual(env.calls.settings, ["skills"]);
  } finally {
    await env.clean();
  }
});

test("web Chat Connectors changes the draft override and Design system saves the real preference", async () => {
  const draftChanges: Record<string, boolean>[] = [],
    preferences: unknown[] = [];
  const app = controller({
    updatePreference: async (patch) => {
      preferences.push(patch);
    },
  });
  app.composerDraft.setDraftConnectors = (patch) => {
    const next =
      typeof patch === "function"
        ? patch(app.composerDraft.draftConnectors)
        : patch;
    draftChanges.push(next);
    app.composerDraft.draftConnectors = next;
  };
  const env = await environment();
  try {
    await env.render(app);
    await env.click('[data-add-branch="connectors"]');
    const connector = env.button(
      env.panel("connectors"),
      "Reference connector",
    );
    assert.equal(connector.getAttribute("aria-checked"), "true");
    await env.event(connector, "click");
    assert.deepEqual(draftChanges, [{ "Reference connector": false }]);
    await env.render(app);
    assert.equal(connector.getAttribute("aria-checked"), "false");
    await env.click('[data-add-branch="design"]');
    await env.event(env.button(env.panel("design"), design.name), "click");
    assert.deepEqual(preferences, [{ designSystem: design.id }]);
    await env.event(
      env.button(env.panel("design"), "Manage design systems"),
      "click",
    );
    assert.deepEqual(env.calls.settings, ["design"]);
  } finally {
    await env.clean();
  }
});

test("web Chat keyboard enters every submenu, returns to its owning row, and skips a disabled Research item", async () => {
  const env = await environment();
  try {
    await env.render(controller(), { researchAvailable: false });
    assert.equal(env.document.activeElement, env.root());
    await env.key(env.root(), "Home");
    assert.equal(
      env.document.activeElement,
      env.button(env.root(), "Upload or add files"),
    );
    await env.key(env.document.activeElement!, "End");
    assert.equal(
      env.document.activeElement?.getAttribute("data-add-branch"),
      "devices",
    );
    for (const name of ["skills", "connectors", "design", "devices"]) {
      const trigger = env
        .root()
        .querySelector<HTMLElement>(`[data-add-branch="${name}"]`)!;
      await act(async () => trigger.focus());
      await env.key(trigger, "ArrowRight");
      assert.equal(trigger.getAttribute("aria-expanded"), "true");
      assert.equal(
        env.document.activeElement?.closest('[role="menu"]'),
        env.panel(name),
      );
      await env.key(env.document.activeElement!, "End");
      assert.equal(
        env.document.activeElement,
        env
          .buttons(env.panel(name))
          .filter((item) => !item.disabled)
          .at(-1),
      );
      await env.key(
        env.document.activeElement!,
        name === "devices" ? "Escape" : "ArrowLeft",
      );
      assert.equal(env.document.activeElement, trigger);
      assert.equal(
        env.document.querySelector(`[data-add-panel="${name}"]`),
        null,
      );
    }
    assert.equal(env.calls.close, 0);
    await env.key(env.document.activeElement!, "Escape");
    assert.equal(env.calls.close, 1);
  } finally {
    await env.clean();
  }
});

for (const changed of ["account", "bridge"] as const) {
  test(`web Chat Devices rejects a late ${changed} directory while the new source is loading`, async () => {
    const old = deferred<ChatDeviceDirectory>(),
      current = deferred<ChatDeviceDirectory>();
    let reads = 0;
    const env = await environment({
      chatDevices: () => (reads++ === 0 ? old.promise : current.promise),
    });
    const app = controller();
    try {
      await env.render(app);
      const nextApp =
        changed === "account" ? controller({ accountId: "account-b" }) : app;
      if (changed === "bridge")
        env.window.desktop = {
          ...env.window.desktop,
          chatDevices: () => current.promise,
        };
      await env.render(nextApp);
      await act(async () => old.resolve(directory));
      assert.equal(
        env.root().querySelector('[data-add-branch="devices"]'),
        null,
      );
      const nextDirectory = {
        ...directory,
        accountScope: "account-b",
        devices: [{ ...device, id: "new-computer", name: "New computer" }],
      };
      await act(async () => current.resolve(nextDirectory));
      await env.click('[data-add-branch="devices"]');
      const choice = env
        .panel("devices")
        .querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
      assert.equal(
        choice.querySelector("[data-no-translate]")?.textContent,
        "New computer",
      );
      await env.event(choice, "click");
      assert.equal(draftChatDevice(nextApp)?.deviceId, "new-computer");
      assert.equal(draftChatDevice(nextApp)?.accountScope, "account-b");
      assert.equal(
        env.panel("devices").textContent?.includes("Reference computer"),
        false,
      );
    } finally {
      await env.clean();
    }
  });
}

for (const changed of [
  "account",
  "controller",
  "conversation",
  "bridge",
] as const) {
  for (const outcome of ["success", "failure"] as const) {
    test(`web Chat Devices cannot publish a binding ${outcome} after ${changed} retirement`, async () => {
      const pending = deferred<Conversation>();
      const active = {
        id: "conversation-a",
        mode: "chat",
        turns: [],
      } as unknown as Conversation;
      const upserts: Conversation[] = [],
        errors: string[] = [],
        writes: unknown[] = [];
      const app = controller({
        activeId: active.id,
        active,
        upsert: (value) => upserts.push(value),
      });
      const env = await environment({
        setChatDevice: (input) => {
          writes.push(input);
          return pending.promise;
        },
      });
      try {
        await env.render(app, {
          onUnavailable: (message) => errors.push(message),
        });
        await env.click('[data-add-branch="devices"]');
        const choice = env
          .panel("devices")
          .querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
        await env.event(choice, "click");
        assert.deepEqual(writes, [
          {
            version: 1,
            accountScope: directory.accountScope,
            organizationId: null,
            conversationId: active.id,
            expectedBindingRevision: 0,
            deviceId: device.id,
            taskPermission: "default",
          },
        ]);
        assert.equal(choice.disabled, true);
        if (changed === "bridge")
          env.window.desktop = { ...env.window.desktop };
        else
          app.currentController!.current = controller({
            activeId: active.id,
            active,
            accountId: changed === "account" ? "account-b" : app.accountId,
            controllerScope:
              changed === "controller" ? {} : app.controllerScope,
            ...(changed === "conversation"
              ? { activeId: "conversation-b" }
              : {}),
          });
        await act(async () =>
          outcome === "success"
            ? pending.resolve({ ...active, chatDeviceRevision: 1 })
            : pending.reject(new Error("Retired write failure")),
        );
        assert.deepEqual(upserts, []);
        assert.deepEqual(errors, []);
      } finally {
        await env.clean();
      }
    });
  }
}

test("web Chat Devices keeps the original check on a rejected write and reflects only a confirmed current binding", async () => {
  const active = {
    id: "conversation-a",
    mode: "chat",
    turns: [],
  } as unknown as Conversation;
  const requests: ReturnType<typeof deferred<Conversation>>[] = [],
    errors: string[] = [];
  const app = controller({ activeId: active.id, active });
  app.upsert = (value) => {
    app.active = value;
  };
  const env = await environment({
    setChatDevice: () => {
      const pending = deferred<Conversation>();
      requests.push(pending);
      return pending.promise;
    },
  });
  try {
    await env.render(app, { onUnavailable: (message) => errors.push(message) });
    await env.click('[data-add-branch="devices"]');
    const choice = env
      .panel("devices")
      .querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
    await env.event(choice, "click");
    assert.equal(choice.getAttribute("aria-checked"), "false");
    await act(async () =>
      requests[0].reject(new Error("Context cannot be moved")),
    );
    assert.deepEqual(errors, ["Context cannot be moved"]);
    assert.equal(choice.disabled, false);
    assert.equal(choice.getAttribute("aria-checked"), "false");
    await env.event(choice, "click");
    await act(async () =>
      requests[1].resolve({
        ...active,
        chatDeviceBinding: {
          version: 1,
          accountScope: directory.accountScope,
          organizationId: null,
          deviceId: device.id,
          remoteConversationId: "confirmed-remote",
          revision: 1,
          permission: "default",
        },
      }),
    );
    await env.render(app);
    assert.equal(choice.getAttribute("aria-checked"), "true");
    assert.equal(choice.disabled, false);
  } finally {
    await env.clean();
  }
});

for (const changed of ["controller", "conversation"] as const) {
  test(`web Chat Devices releases a retired pending write for the next ${changed} in the same account`, async () => {
    const requests: ReturnType<typeof deferred<Conversation>>[] = [];
    const active = {
      id: "conversation-a",
      mode: "chat",
      turns: [],
    } as unknown as Conversation;
    const app = controller({ activeId: active.id, active });
    const updates: string[] = [];
    const env = await environment({
      setChatDevice: () => {
        const request = deferred<Conversation>();
        requests.push(request);
        return request.promise;
      },
    });
    try {
      await env.render(app);
      await env.click('[data-add-branch="devices"]');
      await env.event(
        env.panel("devices").querySelector('[role="menuitemcheckbox"]')!,
        "click",
      );
      const nextActive =
        changed === "conversation"
          ? { ...active, id: "conversation-b" }
          : active;
      const next = controller({
        accountId: app.accountId,
        controllerScope: changed === "controller" ? {} : app.controllerScope,
        activeId: nextActive.id,
        active: nextActive,
        upsert: (value) => updates.push(value.id),
      });
      app.currentController!.current = next;
      await env.render(next);
      const choice = env
        .panel("devices")
        .querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')!;
      assert.equal(
        choice.disabled,
        false,
        "a new owner can start its own operation immediately",
      );
      await env.event(choice, "click");
      assert.equal(requests.length, 2);
      assert.equal(choice.disabled, true);
      await act(async () =>
        requests[0].resolve({ ...active, chatDeviceRevision: 1 }),
      );
      assert.equal(
        choice.disabled,
        true,
        "retired finally cannot release the current owner's pending operation",
      );
      assert.deepEqual(updates, []);
      await act(async () =>
        requests[1].resolve({ ...nextActive, chatDeviceRevision: 1 }),
      );
      assert.equal(choice.disabled, false);
      assert.deepEqual(updates, [nextActive.id]);
    } finally {
      await env.clean();
    }
  });
}
