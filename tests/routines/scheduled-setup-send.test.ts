import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h } from "react";
import type { AppController } from "../../src/app/AppContext";
import { AppContext } from "../../src/app/AppContext";
import { sendDraft } from "../../src/app/composer-send";
import { useControllerRef } from "../../src/app/useControllerRef";
import { useComposerSending } from "../../src/composer/useComposerSending";
import { useSkillDraft } from "../../src/composer/useSkillDraft";
import { ScheduledTaskSetupReceipt } from "../../src/app/ScheduledTaskSetupReceipt";
import { Toaster } from "../../src/ui/Toaster";
import { currentToasts } from "../../src/ui/toast-store";
import {
  rememberScheduledChatSetup,
  scheduledChatSetupFor,
} from "../../src/collections/routines/scheduled-chat-setup";
import {
  onScheduleRequest,
  type ScheduleRequest,
} from "../../src/collections/routines/schedule-request";
import { formatWebRoute } from "../../src/web/routes";
import { fixtureSnapshot } from "../../scripts/preview/app-fixture";
import { openPolicy } from "../../shared/client-policy";
import type { CoreDesktopAPI, Conversation } from "../../shared/types";
import type { ScheduledTaskSetupIntent } from "../../shared/scheduled-task-setup";
import { routineDom } from "../support/routine-dom";
import "../../src/app/chat-device-send";

type SendInput = Parameters<CoreDesktopAPI["send"]>[0];
const intent: ScheduledTaskSetupIntent = {
  returnTo: "scheduled",
  projectId: "actual-project",
  cwd: "/actual/folder",
};
const record = (id: string, taskId?: string): Conversation => ({
  id,
  title: "Setup Chat",
  mode: "chat",
  providerId: "default",
  model: "model",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  turns: [],
  ...(taskId
    ? { scheduledTaskSetup: { returnTo: "scheduled", createdTaskId: taskId } }
    : {}),
});

async function harness() {
  const calls: SendInput[] = [];
  const pending: Array<{
    resolve(value: Conversation): void;
    reject(error: Error): void;
  }> = [];
  const dom = await routineDom(
    {
      send: (input) => {
        calls.push(input);
        return new Promise((resolve, reject) =>
          pending.push({ resolve, reject }),
        );
      },
    },
    { jsdom: true },
  );
  const resize = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  let live!: AppController;
  let request: Promise<void> | undefined;
  const navigation: string[] = [],
    errors: unknown[] = [],
    upserts: Conversation[] = [];
  function App({
    account = "setup-owner",
    session = "setup-draft",
    id,
    taskId,
  }: {
    account?: string;
    session?: string;
    id?: string;
    taskId?: string;
  }) {
    const draft = useSkillDraft();
    const busy = useComposerSending(
      `${account}\n${id ?? session}\nchat\nfalse`,
    );
    const controller = useControllerRef<AppController>(account);
    const active = id ? record(id, taskId) : undefined;
    live = {
      accountId: account,
      controllerScope: controller.controllerScope,
      currentController: controller.currentController,
      draftSession: session,
      ...draft,
      ...busy,
      attachments: [],
      setAttachments() {},
      active,
      activeId: id,
      page: "chat",
      mode: "chat",
      running: false,
      incognitoShown: false,
      model: "model",
      providerId: "default",
      effort: "high",
      snapshot: fixtureSnapshot({}),
      policy: openPolicy,
      draftWebSearch: false,
      selectNext: { current: false },
      follow: { current: false },
      latest: { current: { conversations: active ? [active] : [] } },
      navigation: { replaceNext() {} },
      composer: { current: { focus() {}, blur() {} } },
      setError() {},
      notify() {},
      report(error: unknown) {
        errors.push(error);
      },
      upsert(value: Conversation) {
        upserts.push(value);
      },
      setActiveId(value: string) {
        navigation.push(value);
      },
      setPage(value: string) {
        navigation.push(value);
      },
    } as unknown as AppController;
    controller.exposeController(live);
    return h(
      AppContext.Provider,
      { value: live },
      h(
        "button",
        {
          "data-send": true,
          onClick: () => {
            request = sendDraft(live);
          },
        },
        "Send",
      ),
      h("output", { "data-draft": true }, draft.text),
      h(ScheduledTaskSetupReceipt),
      h(Toaster),
    );
  }
  const render = (props: Parameters<typeof App>[0] = {}, key = "app") =>
    dom.render(h(App, { ...props, key }));
  const seed = (text: string) =>
    act(async () => {
      live.setText(text);
    });
  const start = async () => {
    const count = calls.length;
    await dom.click('[data-send="true"]');
    assert.equal(
      calls.length,
      count + 1,
      "actual sendDraft reached the transport",
    );
    assert.ok(request);
    return { request };
  };
  return {
    ...dom,
    calls,
    pending,
    render,
    seed,
    start,
    navigation,
    errors,
    upserts,
    get live() {
      return live;
    },
    async clean() {
      await dom.clean();
      if (resize) Object.defineProperty(globalThis, "ResizeObserver", resize);
      else Reflect.deleteProperty(globalThis, "ResizeObserver");
    },
  };
}

test("actual sendDraft carries explicit setup context, retains it on failure, and clears it only after a successful retry", async () => {
  const env = await harness();
  try {
    await env.render();
    await env.seed("Ask what this task should do and when to run it.");
    const original = env.live;
    rememberScheduledChatSetup(original, original.draftSession, intent);
    const first = await env.start();
    assert.equal(env.calls.length, 1);
    assert.deepEqual(env.calls[0].scheduledTaskSetup, intent);
    assert.equal(env.calls[0].mode, "chat");
    assert.equal(env.live.sending, true);
    await act(async () => {
      env.pending[0].reject(Error("transport unavailable"));
      await first.request;
    });
    assert.equal(scheduledChatSetupFor(env.live), intent);
    assert.equal(
      env.live.text,
      "Ask what this task should do and when to run it.",
    );
    assert.equal(env.live.sending, false);
    assert.equal((env.errors[0] as Error).message, "transport unavailable");
    const retry = await env.start();
    assert.equal(env.calls.length, 2);
    assert.deepEqual(env.calls[1].scheduledTaskSetup, intent);
    await act(async () => {
      env.pending[1].resolve(record("created-chat"));
      await retry.request;
    });
    assert.equal(
      scheduledChatSetupFor(original),
      undefined,
      "the original draft's intent was actually cleared",
    );
    assert.deepEqual(env.navigation, ["created-chat", "chat"]);
    assert.equal(env.upserts[0].id, "created-chat");
    assert.equal(env.live.sending, false);
  } finally {
    await env.clean();
  }
});

test("an ordinary Chat send never acquires scheduling intent from its prose", async () => {
  const env = await harness();
  try {
    await env.render();
    await env.seed("Help me set up a scheduled task, then create it.");
    const sent = await env.start();
    assert.equal(env.calls.length, 1);
    assert.equal(env.calls[0].scheduledTaskSetup, undefined);
    assert.equal(scheduledChatSetupFor(env.live), undefined);
    await act(async () => {
      env.pending[0].resolve(record("normal-chat"));
      await sent.request;
    });
    assert.deepEqual(env.navigation, ["normal-chat", "chat"]);
  } finally {
    await env.clean();
  }
});

test("the mounted creation receipt uses the existing toast View task action and exact canonical task request", async () => {
  const env = await harness();
  const requests: ScheduleRequest[] = [];
  const stop = onScheduleRequest((request) => requests.push(request));
  try {
    await env.render({ id: "setup-chat" });
    assert.equal(currentToasts().length, 0);
    await env.render({ id: "setup-chat", taskId: "actual-task" });
    assert.equal(currentToasts().length, 1);
    assert.equal(currentToasts()[0].message, "Scheduled task created");
    assert.deepEqual(
      env.navigation,
      [],
      "receipt does not move the user during the Chat turn",
    );
    const action =
      env.document.querySelector<HTMLButtonElement>(".toast-action")!;
    assert.equal(action.textContent, "View task");
    await env.click(".toast-action");
    assert.deepEqual(requests, [
      { description: "", openRoutineId: "actual-task" },
    ]);
    assert.deepEqual(env.navigation, ["scheduled"]);
    assert.equal(
      formatWebRoute({
        kind: "page",
        page: "scheduled",
        taskId: requests[0].openRoutineId!,
      }),
      "/scheduled-task/actual-task",
    );
    assert.equal(currentToasts().length, 0);
    await env.render({ id: "setup-chat", taskId: "actual-task" });
    assert.equal(
      currentToasts().length,
      0,
      "same persisted receipt is not replayed",
    );
  } finally {
    stop();
    await env.clean();
  }
});

for (const remount of [false, true])
  test(`old account toast action refuses navigation after ${remount ? "account-key unmount" : "owner change"}`, async () => {
    const env = await harness();
    const requests: ScheduleRequest[] = [];
    const stop = onScheduleRequest((request) => requests.push(request));
    try {
      await env.render({ account: "old-owner", id: "setup-chat" }, "old-key");
      await env.render(
        { account: "old-owner", id: "setup-chat", taskId: "old-task" },
        "old-key",
      );
      assert.equal(
        env.document.querySelector(".toast-action")?.textContent,
        "View task",
      );
      await env.render(
        { account: "next-owner", id: "next-chat" },
        remount ? "next-key" : "old-key",
      );
      await env.click(".toast-action");
      assert.deepEqual(requests, []);
      assert.deepEqual(env.navigation, []);
    } finally {
      stop();
      await env.clean();
    }
  });

test("opening historical completed setup Chats does not announce a new task creation", async () => {
  const env = await harness();
  try {
    await env.render({ id: "ordinary-chat" });
    await env.render({ id: "historical-one", taskId: "task-one" });
    assert.equal(currentToasts().length, 0);
    await env.render({ id: "historical-two", taskId: "task-two" });
    assert.equal(currentToasts().length, 0);
  } finally {
    await env.clean();
  }
});
