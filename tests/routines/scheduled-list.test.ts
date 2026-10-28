import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultSettings } from "../../electron/store/store";
import { desktopHost, webHost, type HostInfo } from "../../shared/host";
import { openPolicy } from "../../shared/client-policy";
import type { Routine } from "../../shared/routines";
import {
  AppContext,
  type AppController,
  type NewChatDraft,
} from "../../src/app/AppContext";
import { HostContext } from "../../src/host/HostContext";
import { PolicyProvider } from "../../src/policy/PolicyContext";
import { RoutinesPage } from "../../src/collections/routines/RoutinesPage";
import { RoutineCard } from "../../src/collections/routines/RoutineCard";
import { requestScheduleConfirmation } from "../../src/collections/routines/schedule-request";
import {
  cancelComposerSubmitFor,
  onComposerSubmitRequest,
} from "../../src/composer/submit-request";
import { scheduledChatPrompt } from "../../src/sidebar/create-scheduled-chat";
import { setLocale, t } from "../../src/i18n";
import { routineDom } from "../support/routine-dom";
import { readSource } from "../support/read-source";

const routine: Routine = {
  id: "batch19-task",
  name: "Review · 夸我",
  prompt: "Review the changes.",
  mode: "code",
  providerId: "batch19-provider",
  model: "test-model",
  enabled: true,
  frequency: "daily",
  repeat: { kind: "daily", time: "09:00" },
  nextRunAt: Date.now() + 86_400_000,
  createdAt: 1,
  updatedAt: 1,
};
const settings = {
  ...defaultSettings,
  providers: [
    {
      id: routine.providerId,
      name: "Batch 19",
      baseUrl: "",
      protocol: "responses" as const,
      model: routine.model,
      models: [],
    },
  ],
  activeProviderId: routine.providerId,
};
const taskWebHost: HostInfo = {
  ...webHost,
  capabilities: {
    ...webHost.capabilities,
    cloudCowork: true,
    scheduledTasks: true,
  },
};

function controllerFixture() {
  const controllerScope = {};
  const current = { current: undefined as AppController | undefined };
  const calls: unknown[][] = [];
  let receipt: ((draft?: NewChatDraft) => void) | undefined;
  const app = {
    accountId: "batch19-owner",
    controllerScope,
    currentController: current,
    page: "scheduled",
    mode: "chat",
    activeId: "previous-chat",
    draftSession: "previous-draft",
    text: "Previous unsent text",
    attachments: [{ id: "previous-file" }],
    skillTokens: [{ raw: "$private" }],
    incognitoShown: false,
    sending: false,
    running: false,
    newChat(
      mode: string,
      project: string | undefined,
      incognito: boolean,
      afterStart?: (draft?: NewChatDraft) => void,
    ) {
      calls.push(["newChat", mode, project, incognito]);
      receipt = afterStart;
    },
    setText(text: string) {
      calls.push(["text", text]);
      current.current = { ...current.current!, text };
    },
    setSkillTokens(skillTokens: []) {
      current.current = { ...current.current!, skillTokens };
    },
    setAttachments(attachments: []) {
      current.current = { ...current.current!, attachments };
    },
  } as unknown as AppController;
  current.current = app;
  return {
    app,
    current,
    calls,
    commit(mode: NewChatDraft["mode"] = "chat") {
      current.current = {
        ...current.current!,
        page: "chat",
        activeId: undefined,
        active: undefined,
        draftSession: "batch19-new-draft",
        mode,
      };
      receipt?.({ draftSession: "batch19-new-draft", mode });
    },
  };
}

async function environment(
  options: {
    list?: Routine[];
    remote?: boolean;
    policy?: typeof openPolicy;
  } = {},
) {
  const calls: string[] = [];
  const env = await routineDom({
    listSchedules: async () => {
      calls.push("list");
      return options.list ?? [];
    },
    routineCapabilities: async () => ({
      remote: options.remote ?? false,
      email: false,
      slack: false,
      setupWithChat: true,
      sources: ["chat", "code"],
    }),
    clientPolicy: async () => options.policy ?? openPolicy,
    proposeScheduledTask: async () => {
      calls.push("proposal");
      throw new Error("The real Chat route must not call the mini-form API.");
    },
    saveSchedule: async () => {
      calls.push("save");
      throw new Error("Selecting a creation workflow must not save a task.");
    },
  });
  const globals = { innerWidth: 1440, innerHeight: 900 };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const render = (host: HostInfo, app?: AppController) =>
    env.render(
      h(
        HostContext.Provider,
        { value: host },
        h(
          PolicyProvider,
          null,
          h(
            AppContext.Provider,
            { value: app },
            h(RoutinesPage, {
              settings,
              onOpenConversation() {},
              onChooseFolder: async () => null,
              onConfirmDelete() {},
              onError(error) {
                throw error;
              },
            }),
          ),
        ),
      ),
    );
  return {
    ...env,
    calls,
    render,
    async clean() {
      await env.clean();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

for (const host of [taskWebHost, desktopHost]) {
  test(`${host.kind}: New task offers the real Chat workflow before Manual, without the description mini-form`, async () => {
    const page = await environment();
    const f = controllerFixture();
    let submits = 0;
    let stop: (() => void) | undefined;
    try {
      await page.render(host, f.app);
      await page.click(".routines-new");
      const menu = page.document.querySelector<HTMLElement>('[role="menu"]')!;
      const items = [...menu.querySelectorAll('[role="menuitem"]')];
      assert.deepEqual(
        items.map((item) => item.querySelector(":scope > span")?.textContent),
        ["Create with Claudex", "Set up manually"],
      );
      assert.deepEqual(
        items.map((item) =>
          item
            .querySelector("[data-icon]")
            ?.getAttribute("data-icon"),
        ),
        ["Chat", "Settings"],
      );
      assert.equal(
        menu.style.width,
        "180px",
        "page menu does not copy the sidebar's 183px capture",
      );
      await page.event(items[0], "click");
      assert.deepEqual(f.calls, [["newChat", "chat", undefined, false]]);
      assert.equal(
        f.current.current?.text,
        "Previous unsent text",
        "wait for the actual new Chat receipt",
      );
      assert.equal(page.document.querySelector(".task-describe"), null);
      assert.equal(page.document.querySelector('[role="dialog"]'), null);
      f.commit();
      stop = onComposerSubmitRequest("batch19-new-draft:chat", () => submits++);
      await act(async () => {});
      assert.equal(f.current.current?.text, scheduledChatPrompt);
      assert.deepEqual(f.current.current?.attachments, []);
      assert.deepEqual(f.current.current?.skillTokens, []);
      assert.equal(submits, 1);
      assert.deepEqual(
        page.calls,
        ["list"],
        "Chat navigation neither proposes nor persists a task by itself",
      );
    } finally {
      stop?.();
      cancelComposerSubmitFor(f.app.controllerScope!);
      await page.clean();
    }
  });
}

test("the actual translated creation prompt stays an editable Chat draft", async () => {
  const page = await environment();
  const f = controllerFixture();
  let submits = 0;
  let stop: (() => void) | undefined;
  try {
    await act(async () => setLocale("zh-CN"));
    await page.render(desktopHost, f.app);
    await page.click(".routines-new");
    await page.event(
      page.document.querySelector('[role="menuitem"]')!,
      "click",
    );
    f.commit();
    stop = onComposerSubmitRequest("batch19-new-draft:chat", () => submits++);
    await act(async () => {});
    assert.notEqual(t(scheduledChatPrompt), scheduledChatPrompt);
    assert.equal(f.current.current?.text, t(scheduledChatPrompt));
    assert.equal(submits, 0);
    assert.deepEqual(page.calls, ["list"]);
  } finally {
    stop?.();
    cancelComposerSubmitFor(f.app.controllerScope!);
    await act(async () => setLocale("en-US"));
    await page.clean();
  }
});

test("an embedded list has no inert Chat action and Manual still opens the real editable form", async () => {
  const page = await environment();
  try {
    await page.render(taskWebHost);
    await page.click(".routines-new");
    const items = [...page.document.querySelectorAll('[role="menuitem"]')];
    assert.deepEqual(
      items.map((item) => item.querySelector(":scope > span")?.textContent),
      ["Set up manually"],
    );
    await page.event(items[0], "click");
    assert.ok(page.document.querySelector(".scheduled-task-dialog form"));
    assert.equal(
      page.document.querySelector<HTMLSelectElement>("select")?.value,
      "daily",
    );
    assert.equal(page.document.querySelector(".task-describe"), null);
    assert.deepEqual(page.calls, ["list"]);
  } finally {
    await page.clean();
  }
});

test("the native cloud capability offers creation workflows and retains manual setup", async () => {
  const page = await environment({ remote: true });
  try {
    await page.render(desktopHost, controllerFixture().app);
    await page.click(".routines-new");
    const menu = page.document.querySelector<HTMLElement>('[role="menu"]')!;
    assert.deepEqual(
      [...menu.querySelectorAll('[role="menuitem"]')].map(
        (item) => item.querySelector(":scope > span")?.textContent,
      ),
      ["Create with Claudex", "Set up manually"],
    );
    assert.equal(menu.style.width, "180px");
    await act(async () => {
      await import("../../src/collections/routines/RoutineEditor");
    });
    await page.event(
      [...menu.querySelectorAll('[role="menuitem"]')][1],
      "click",
    );
    assert.ok(page.document.querySelector("form.routine-editor"));
    assert.deepEqual(page.calls, ["list"]);
  } finally {
    await page.clean();
  }
});

for (const gate of ["capability", "policy", "limit"] as const) {
  test(`New task preserves the ${gate} gate for both workflows`, async () => {
    const page = await environment({
      policy:
        gate === "capability"
          ? undefined
          : {
              ...openPolicy,
              scheduledTasks: {
                ...openPolicy.scheduledTasks,
                enabled: gate !== "policy",
                maxTasks: gate === "limit" ? 0 : null,
              },
            },
    });
    const host =
      gate === "capability"
        ? {
            ...webHost,
            capabilities: { ...webHost.capabilities, scheduledTasks: false },
          }
        : desktopHost;
    const f = controllerFixture();
    try {
      await page.render(host, f.app);
      assert.equal(
        page.document.querySelector<HTMLButtonElement>(".routines-new")
          ?.disabled,
        true,
      );
      assert.equal(page.document.querySelector('[role="menu"]'), null);
      await act(async () =>
        requestScheduleConfirmation({ describe: true, description: "" }),
      );
      assert.deepEqual(
        f.calls,
        [],
        "the legacy request cannot bypass the live task gate",
      );
      assert.ok(
        !page.calls.includes("proposal") && !page.calls.includes("save"),
      );
    } finally {
      cancelComposerSubmitFor(f.app.controllerScope!);
      await page.clean();
    }
  });
}

test("legacy describe requests share the real Chat workflow rather than reopening the removed mini-form", async () => {
  const page = await environment();
  const f = controllerFixture();
  try {
    await page.render(desktopHost, f.app);
    await act(async () =>
      requestScheduleConfirmation({ describe: true, description: "" }),
    );
    assert.deepEqual(f.calls, [["newChat", "chat", undefined, false]]);
    assert.equal(page.document.querySelector('[role="dialog"]'), null);
    assert.deepEqual(page.calls, ["list"]);
  } finally {
    cancelComposerSubmitFor(f.app.controllerScope!);
    await page.clean();
  }
});

test("both card variants name their action by the exact task title and use the Source DotsVertical glyph", () => {
  for (const host of [webHost, desktopHost]) {
    const html = renderToStaticMarkup(
      h(
        HostContext.Provider,
        { value: host },
        h(RoutineCard, {
          routine,
          off: false,
          starting: false,
          menuOpen: false,
          onEdit() {},
          onMenu() {},
        }),
      ),
    );
    assert.match(html, /aria-label="More options for Review · 夸我"/);
    assert.match(
      html,
      /class="routine-more"[^]*data-icon="DotsVertical"/,
    );
    assert.doesNotMatch(html, /Review · 夸我 actions/);
    assert.equal(html.includes("routine-native-item"), host.kind === "desktop");
    assert.doesNotMatch(
      html,
      /This computer|Connected|Not connected|MacBook/,
      "the existing task model cannot supply a stable device identity or connection state",
    );
  }
});

test("native card action metrics use the Source default icon Button without overriding the already-correct web rule", () => {
  const nativeCss = readFileSync(
    "src/collections/routines/routine-list.css",
    "utf8",
  );
  const webCss = readFileSync("src/collections/routines/scheduled.css", "utf8");
  const page = readSource("src/collections/routines/RoutinesPage.tsx");
  assert.match(
    nativeCss,
    /\.routine-grid \.routine-native-item \.routine-more\s*\{\s*width: 32px;\s*height: 32px;\s*border-radius: 8px;/,
  );
  assert.match(
    nativeCss,
    /\.routine-native-item \.routine-more > \[data-icon\]\s*\{\s*width: 20px;\s*height: 20px;/,
  );
  assert.doesNotMatch(nativeCss, /routine-web-item/);
  assert.match(
    webCss,
    /\.routine-grid \.routine-web-item \.routine-more\s*\{[^}]*width: 32px;[^}]*height: 32px;[^}]*border-radius: 8px;/,
  );
  assert.match(page, /import "\.\/routine-list\.css"/);
});
