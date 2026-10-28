import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement as h, Fragment } from "react";
import { randomUUID } from "node:crypto";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { ComposerAddMenu } from "../../src/composer/ComposerAddMenu";
import {
  draftChatDevice,
  electDraftChatDevice,
} from "../../src/composer/chat-device-selection";
import { sendWithChatDevice } from "../../src/app/chat-device-send";
import type { ChatDeviceDirectory } from "../../shared/chat-devices-api";
import type { Conversation } from "../../shared/types";
import { defaultSettings } from "../../electron/store/store";
import { routineDom } from "../support/routine-dom";
import { signedInBridge } from "../app/web-bridge-fakes.test.ts";
import { CloudRouter } from "../../electron/cloud/cloud-router";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ConversationList } from "../../src/sidebar/ConversationList";
import { collectArtifacts } from "../../src/artifacts/artifact-collection";
import { searchLocalConversations } from "../../electron/conversations/history-search";
import { conversationsToMove } from "../../electron/cloud/migrate";
import { emitPrivateDeviceEvent } from "../../electron/remote-control/device-public-projection";
import { isDeviceExecutionCopy } from "../../shared/chat-devices-api";
import { createFixtureDesktop } from "../../scripts/preview/app-fixture";
import { useChatDevices } from "../../src/composer/ChatDeviceMenu";

const device = {
  id: "pc-reference",
  name: "Reference computer",
  platform: "darwin",
  version: "1",
  connectedAt: "2026-10-18T00:00:00Z",
  online: true,
  computerAccess: true,
  chatBindingVersion: 1 as const,
  chatModes: ["chat" as const, "cowork" as const],
  chatPermissionModes: ["default" as const, "auto" as const],
  lastSeenAt: "2026-10-17T00:00:00Z",
};
const directory: ChatDeviceDirectory = {
  version: 1,
  accountScope: "7",
  organizationId: null,
  devices: [device],
};
const noop = () => {};
function controller(patch: Partial<AppController> = {}) {
  const app = {
    accountId: "owner",
    controllerScope: {},
    draftSession: "draft-a",
    mode: "chat",
    incognitoShown: false,
    running: false,
    sending: false,
    snapshot: { settings: defaultSettings },
    upsert: noop,
    ...patch,
  } as AppController;
  app.currentController = { current: app };
  return app;
}
const menu = (
  app: AppController,
  presentation: "native-chat" | "web-chat" | "legacy" = "native-chat",
  onSettings: (tab: string) => void = noop,
  onError: (message: string) => void = noop,
) =>
  h(
    AppContext.Provider,
    { value: app },
    h(ComposerAddMenu, {
      presentation,
      platform: "darwin",
      projects: [],
      webSearch: false,
      webSearchAvailable: true,
      onWebSearch: noop,
      onFiles: noop,
      onProject: noop,
      onCreateProject: noop,
      onClose: noop,
      onSettings,
      onUnavailable: onError,
    }),
  );

test("the actual native Chat Add menu elects and cancels only a real negotiated draft device; no message or binding is invented", async () => {
  let sends = 0,
    binds = 0;
  const env = await routineDom(
    {
      customizeSkills: async () => [],
      listDesignSystems: async () => [],
      chatDevices: async () => directory,
      setChatDevice: async () => {
        binds++;
        throw new Error("must not bind a draft");
      },
      sendOnChatDevice: async (input) => {
        sends++;
        return { id: input.requestId } as Conversation;
      },
    },
    { jsdom: true },
  );
  const app = controller();
  try {
    await env.render(menu(app));
    await env.click('[data-add-branch="devices"]');
    const row = env.document.querySelector<HTMLButtonElement>(
      '[data-add-panel="devices"] [role="menuitemcheckbox"]',
    )!;
    assert.equal(row.disabled, false);
    assert.equal(row.getAttribute("aria-checked"), "false");
    assert.ok(row.querySelector(".composer-device-check"));
    assert.equal(
      row.querySelector(".composer-device-check")!.childElementCount,
      0,
    );
    assert.equal(row.querySelector('[role="switch"]'), null);
    await env.click('[data-add-panel="devices"] [role="menuitemcheckbox"]');
    assert.equal(row.getAttribute("aria-checked"), "true");
    assert.equal(
      row.querySelector(".composer-device-check")!.childElementCount,
      1,
    );
    assert.equal(draftChatDevice(app)?.deviceId, device.id);
    assert.equal(binds, 0);
    assert.equal(sends, 0);
    await env.click('[data-add-panel="devices"] [role="menuitemcheckbox"]');
    assert.equal(row.getAttribute("aria-checked"), "false");
    assert.equal(draftChatDevice(app), undefined);
    await env.click('[data-add-panel="devices"] [role="menuitemcheckbox"]');
    await sendWithChatDevice(app, {
      mode: "chat",
      text: "Reference",
      providerId: "p",
      model: "m",
      attachments: [],
    });
    assert.equal(sends, 1);
    assert.equal(binds, 0);
    assert.equal(draftChatDevice(app), undefined);
  } finally {
    await env.clean();
  }
});

test("an old device is honestly read-only and the real management entry remains available; legacy/Code projections gain no Devices row", async () => {
  let tab = "";
  const env = await routineDom(
    {
      customizeSkills: async () => [],
      listDesignSystems: async () => [],
      chatDevices: async () => {
        throw new Error("Old service");
      },
      listCoworkDevices: async () => [
        { ...device, chatBindingVersion: undefined },
      ],
    },
    { jsdom: true },
  );
  try {
    await env.render(
      menu(controller(), "native-chat", (value: string) => {
        tab = value;
      }),
    );
    await env.click('[data-add-branch="devices"]');
    const row = env.document.querySelector<HTMLButtonElement>(
      '[data-add-panel="devices"] [role="menuitemcheckbox"]',
    )!;
    assert.equal(row.disabled, true);
    assert.equal(row.getAttribute("aria-checked"), "false");
    assert.match(row.title, /Old service/);
    const manage = [
      ...env.document.querySelectorAll<HTMLButtonElement>(
        '[data-add-panel="devices"] button',
      ),
    ].find((button) => button.textContent?.includes("Manage computers"))!;
    await env.event(manage, "click");
    assert.equal(tab, "cowork");
    await env.render(menu(controller({ mode: "code" }), "legacy"));
    assert.equal(
      env.document.querySelector('[data-add-branch="devices"]'),
      null,
    );
  } finally {
    await env.clean();
  }
});

test("the default offline fixture and a malformed legacy device response keep unsupported Devices hidden", async () => {
  const bridge = createFixtureDesktop({ states: true }, new URLSearchParams());
  const env = await routineDom({}, { jsdom: true });
  env.window.desktop = bridge;
  let resource!: ReturnType<typeof useChatDevices>;
  function Probe() {
    resource = useChatDevices(true);
    return null;
  }
  try {
    assert.equal(await bridge.chatDevices(), undefined);
    assert.deepEqual(await bridge.listCoworkDevices(), []);
    await env.render(h(Fragment, null, h(Probe), menu(controller())));
    assert.equal(resource.status, "loaded");
    assert.deepEqual(resource.value?.devices, []);
    assert.equal(resource.value?.directory, undefined);
    // Older hosts may fulfil an unsupported method with undefined. Exercise
    // that distinct malformed response without changing the default fixture.
    env.window.desktop = {
      ...bridge,
      listCoworkDevices: async () => undefined as never,
    };
    await env.render(h(Fragment, null, h(Probe), menu(controller())));
    assert.equal(resource.status, "failed");
    assert.equal(resource.value, undefined);
    assert.ok(env.document.querySelector('.composer-add-menu[role="menu"]'));
    assert.equal(
      env.document.querySelector('[data-add-branch="devices"]'),
      null,
    );
    assert.equal(
      env.document.querySelector('[data-add-panel="devices"]'),
      null,
    );
  } finally {
    await env.clean();
  }
});

test("an existing Chat's checked device changes only after the real binding operation confirms; busy and failed operations keep the original check", async () => {
  let resolve!: (value: Conversation) => void,
    reject!: (error: Error) => void,
    writes = 0;
  const active = {
    id: randomUUID(),
    mode: "chat",
    turns: [],
    chatDeviceBinding: {
      version: 1,
      accountScope: "7",
      organizationId: null,
      deviceId: device.id,
      remoteConversationId: "remote",
      revision: 1,
      permission: "default",
    },
  } as unknown as Conversation;
  const upserts: Conversation[] = [],
    errors: string[] = [];
  const app = controller({
    activeId: active.id,
    active,
    upsert: (c) => upserts.push(c),
  });
  const env = await routineDom(
    {
      customizeSkills: async () => [],
      listDesignSystems: async () => [],
      chatDevices: async () => directory,
      setChatDevice: () => {
        writes++;
        return new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        });
      },
    },
    { jsdom: true },
  );
  try {
    await env.render(
      menu(app, "native-chat", noop, (message: string) => errors.push(message)),
    );
    await env.click('[data-add-branch="devices"]');
    const row = env.document.querySelector<HTMLButtonElement>(
      '[data-add-panel="devices"] [role="menuitemcheckbox"]',
    )!;
    await env.event(row, "click");
    assert.equal(writes, 1);
    assert.equal(row.disabled, true);
    assert.equal(row.getAttribute("aria-checked"), "true");
    assert.equal(upserts.length, 0);
    await act(async () => reject(new Error("Complete context unavailable")));
    assert.equal(row.getAttribute("aria-checked"), "true");
    assert.equal(upserts.length, 0);
    assert.deepEqual(errors, ["Complete context unavailable"]);
    await env.event(row, "click");
    assert.equal(writes, 2);
    app.currentController!.current = controller({
      accountId: "other",
      activeId: "B",
    });
    await act(async () => resolve({ ...active, chatDeviceBinding: undefined }));
    assert.equal(
      upserts.length,
      0,
      "late A binding result cannot alter another account's UI",
    );
  } finally {
    await env.clean();
  }
});

test("the real send wrapper refuses stale drafts and unsupported blank/folder contexts without falling back to ordinary send", async () => {
  let ordinary = 0,
    remote = 0;
  const env = await routineDom({
    send: async () => {
      ordinary++;
      return {} as Conversation;
    },
    sendOnChatDevice: async () => {
      remote++;
      return {} as Conversation;
    },
  });
  try {
    const app = controller();
    electDraftChatDevice(app, directory, device.id);
    await assert.rejects(
      sendWithChatDevice(app, {
        mode: "chat",
        text: "Reference",
        providerId: "p",
        model: "m",
        attachments: [],
        cwd: "/user-folder",
      }),
      /complete context/,
    );
    assert.equal(ordinary, 0);
    assert.equal(remote, 0);
    assert.equal(draftChatDevice(app)?.deviceId, device.id);
    app.currentController!.current = controller({ draftSession: "new-draft" });
    await assert.rejects(
      sendWithChatDevice(app, {
        mode: "chat",
        text: "Reference",
        providerId: "p",
        model: "m",
        attachments: [],
      }),
      /account or draft changed/,
    );
    assert.equal(ordinary, 0);
    assert.equal(remote, 0);
  } finally {
    await env.clean();
  }
});

test("actual WebBridge and Electron CloudRouter transport the independent V1 API rather than ordinary send", async () => {
  const id = randomUUID();
  const input = {
    version: 1 as const,
    accountScope: "42",
    organizationId: null,
    requestId: id,
    deviceId: device.id,
    mode: "chat" as const,
    text: "Reference",
    providerId: "p",
    model: "m",
    taskPermission: "default" as const,
    attachments: [],
  };
  const h = await signedInBridge((method) =>
    method === "chatDevices"
      ? { ...directory, accountScope: "42" }
      : method === "sendOnChatDevice"
        ? { id }
        : null,
  );
  try {
    assert.equal((await h.bridge.api.chatDevices()).version, 1);
    assert.equal((await h.bridge.api.sendOnChatDevice(input)).id, id);
    assert.deepEqual(
      h.calls.map((call) => call.method),
      ["chatDevices", "sendOnChatDevice"],
    );
    assert.deepEqual(h.calls[1].args, [input]);
  } finally {
    h.bridge.dispose();
  }
  const calls: string[] = [];
  const cloud = {
    call: async (name: string) => {
      calls.push(name);
      return { id };
    },
    snapshot: async () => ({ snapshot: {} as never }),
  };
  const router = new CloudRouter({
    client: () => cloud,
    push: noop,
    attachmentBytes: async () => undefined,
  });
  const fallback = () =>
    assert.fail("explicit device requests must not use local send");
  await router.route("sendOnChatDevice", fallback)(input);
  await router.route("chatDevices", fallback)();
  assert.deepEqual(calls, ["sendOnChatDevice", "chatDevices"]);
});

test("the actual sidebar/search/artifact/P5 projections expose one logical record while internal runtime subscribers still receive its private copy", () => {
  const logical: Conversation = {
    id: "logical",
    title: "Reference logical",
    mode: "chat",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "t",
        prompt: "Reference",
        attachments: [],
        status: "completed",
        createdAt: 1,
        items: [
          {
            id: "i",
            type: "fileChange",
            generatedFiles: [
              {
                id: "file",
                name: "reference.html",
                path: "/workspace/reference.html",
                language: "html",
                operation: "create",
                state: "ready",
                content: "<html><body>Reference</body></html>",
              },
            ],
          },
        ],
      },
    ],
  };
  const copy: Conversation = {
    ...structuredClone(logical),
    id: "remote-runtime",
    deviceChatOrigin: {
      version: 1,
      accountScope: "7",
      logicalConversationId: logical.id,
      active: true,
      permission: "default",
    },
  };
  const stored = [logical, copy];
  const projected = stored.filter((c) => !isDeviceExecutionCopy(c));
  const html = renderToStaticMarkup(
    h(ConversationList, {
      mode: "chat",
      page: "chat",
      conversations: projected,
      projects: [],
      approvalIds: new Set<string>(),
      onPageChange: noop,
      onReorder: async () => {},
      onError: noop,
      onOpen: noop,
      onRename: noop,
      onMoveToProject: noop,
      onToggleArchive: noop,
      onDelete: noop,
      onToggleUnread: noop,
      onOpenIn: noop,
    }),
  );
  const document = parseHTML(html).document;
  assert.equal(document.querySelectorAll(".conversation-row").length, 1);
  assert.equal(
    searchLocalConversations(projected, "Reference").results.length,
    1,
  );
  assert.equal(
    collectArtifacts(stored, [], { version: 1, copies: [], pinned: [] }).length,
    1,
  );
  assert.deepEqual(
    conversationsToMove(
      {
        store: { root: "/not-read", conversations: stored, projects: [] },
        inCloud: () => false,
      },
      new Set(),
    ).map((c) => c.id),
    [logical.id],
  );
  const internal: string[] = [],
    publicEvents: string[] = [];
  for (const event of [
    { type: "conversation", conversation: copy },
    {
      type: "approval",
      approval: {
        id: 1,
        conversationId: copy.id,
        method: "approval",
        params: {},
      },
    },
  ] as const)
    if (
      !emitPrivateDeviceEvent(event, stored, (event) =>
        internal.push(event.type),
      )
    )
      publicEvents.push(event.type);
  assert.deepEqual(internal, ["conversation", "approval"]);
  assert.deepEqual(publicEvents, []);
  assert.equal(
    emitPrivateDeviceEvent(
      { type: "conversation", conversation: logical },
      stored,
      () => assert.fail("logical event must use the public dispatcher"),
    ),
    false,
  );
});
