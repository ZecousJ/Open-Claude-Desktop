import { mergeCodePermissionResponse } from "../../src/app/code-permission-state";
import type { Snapshot } from "../../shared/types";
import assert from "node:assert/strict";
import test from "node:test";
import {
  codeSessionSettings,
  codeExecutionSettings,
  codePermissionModeOf,
  type CodePermissionPatch,
} from "../../shared/code-session-permissions";
import type { Conversation, Settings } from "../../shared/types";
import {
  setSessionCodePermission as persistSessionPermission,
  waitForCodePermissions,
} from "../../src/app/code-permission-state";
import type { AppController } from "../../src/app/AppContext";
import { defaultSettings } from "../../electron/store/store";
import { act, createElement, StrictMode } from "react";
import { parseHTML } from "linkedom";
import { useControllerRef } from "../../src/app/useControllerRef";
import { webHost, resolveHost } from "../../shared/host";

const setSessionCodePermission = (
  app: AppController,
  patch: CodePermissionPatch,
  target = app.active,
) =>
  persistSessionPermission(app, patch, target, async (c, mode) => {
    await app.patchConversation(c, { codePermissionMode: mode });
    return {
      ...c,
      codePermissionMode: mode,
      codePermissionRevision:
        (app.snapshot.conversations.find((item) => item.id === c.id)
          ?.codePermissionRevision ?? 0) + 1,
    };
  });

const base: Settings = {
  ...structuredClone(defaultSettings),
  codeSandbox: "workspace-write",
  autoAcceptEdits: false,
  codePlanMode: false,
  bypassFolders: [],
  allowBypassPermissions: false,
};
const plan = {
  ...base,
  codeSandbox: "read-only",
  codePlanMode: true,
} as CodePermissionPatch;
const auto = { ...base } as CodePermissionPatch;
const edits = { ...base, autoAcceptEdits: true } as CodePermissionPatch;
const conversation = (id = "a") =>
  ({ id, mode: "code", turns: [] }) as unknown as Conversation;

test("Code session modes round-trip independently of account defaults and keep trust eligibility", () => {
  for (const mode of [
    "auto",
    "manual",
    "acceptEdits",
    "plan",
    "bypass",
  ] as const) {
    const applied = codeSessionSettings(base, mode);
    assert.equal(codePermissionModeOf(applied), mode);
    assert.equal(applied.allowBypassPermissions, false);
    assert.equal(applied.bypassFolders, base.bypassFolders);
  }
  assert.equal(codeSessionSettings(base), base);
  assert.equal(base.codePlanMode, false);
  const a = { ...conversation(), codePermissionMode: "plan" as const };
  const b = {
    ...conversation("b"),
    codePermissionMode: "acceptEdits" as const,
  };
  assert.equal(codeExecutionSettings(base, a).codePlanMode, true);
  assert.equal(codeExecutionSettings(base, b).autoAcceptEdits, true);
  assert.equal(codeExecutionSettings(base, { ...a, mode: "chat" }), base);
});

test("older backends do not implicitly advertise session permissions on either surface", async () => {
  for (const kind of ["web", "desktop"] as const) {
    assert.equal(resolveHost(kind).capabilities.codeSessionPermissions, false);
    assert.equal(
      resolveHost(kind, { capabilities: { cloudCode: true } }).capabilities
        .codeSessionPermissions,
      false,
    );
    assert.equal(
      resolveHost(kind, { capabilities: { codeSessionPermissions: true } })
        .capabilities.codeSessionPermissions,
      true,
    );
  }
  const env = controller();
  env.app.snapshot.host = webHost;
  await setSessionCodePermission(env.app, plan, conversation());
  assert.deepEqual(env.saved, []);
});

test("running Code turns retain their permission snapshot while the session chooses its next mode", () => {
  const c = {
    ...conversation(),
    codePermissionMode: "acceptEdits" as const,
    turns: [{ status: "inProgress", codePermissionMode: "plan" }],
  } as unknown as Conversation;
  assert.equal(codeExecutionSettings(base, c).codePlanMode, true);
  assert.equal(codeExecutionSettings(base, c).autoAcceptEdits, false);
  c.turns[0].status = "completed";
  assert.equal(codeExecutionSettings(base, c).codePlanMode, false);
  assert.equal(codeExecutionSettings(base, c).autoAcceptEdits, true);
});

function controller() {
  const saved: { target: string; mode: string }[] = [];
  const accountPatches: unknown[] = [];
  const draftModes: unknown[] = [];
  const app = {
    accountId: "scope-account",
    controllerScope: {},
    draftSession: "draft-a",
    sending: false,
    snapshot: {
      settings: { ...base, bypassFolders: [] },
      conversations: [conversation("a"), conversation("b")],
      host: {
        ...webHost,
        capabilities: { ...webHost.capabilities, codeSessionPermissions: true },
      },
    },
    setSnapshot: (value: any) => {
      const next = typeof value === "function" ? value(app.snapshot) : value;
      if (next) app.snapshot = next;
    },
    composerDraft: {
      setDraftCodePermissionMode: (mode: unknown) => draftModes.push(mode),
    },
    patchConversation: async (
      c: Conversation,
      patch: { codePermissionMode: string },
    ) => {
      saved.push({ target: c.id, mode: patch.codePermissionMode });
    },
    updatePreference: async (patch: Partial<Settings>) => {
      accountPatches.push(patch);
      Object.assign(app.snapshot.settings, patch);
    },
  } as unknown as AppController;
  app.currentController = { current: app };
  return { app, saved, accountPatches, draftModes };
}

test("a footer change edits only its session or draft and preserves account defaults", async () => {
  const env = controller();
  await setSessionCodePermission(env.app, plan, conversation("a"));
  await setSessionCodePermission(env.app, edits, conversation("b"));
  await setSessionCodePermission(env.app, plan);
  assert.deepEqual(env.saved, [
    { target: "a", mode: "plan" },
    { target: "b", mode: "acceptEdits" },
  ]);
  assert.deepEqual(env.draftModes, ["plan"]);
  assert.deepEqual(env.accountPatches, []);
  assert.equal(env.app.snapshot.settings.codePlanMode, false);
});

test("session permission writes stay ordered and a failed write does not poison later selections", async () => {
  const env = controller();
  let first = true;
  env.app.patchConversation = async (c, patch) => {
    if (first) {
      first = false;
      throw Error("write failed");
    }
    env.saved.push({ target: c.id, mode: patch.codePermissionMode! });
  };
  const failed = setSessionCodePermission(env.app, plan, conversation());
  const next = setSessionCodePermission(env.app, edits, conversation());
  await assert.rejects(failed, /write failed/);
  await next;
  assert.deepEqual(env.saved, [{ target: "a", mode: "acceptEdits" }]);
  assert.deepEqual(env.accountPatches, []);
});

test("queued permission changes cannot cross account, unmount, draft reset or pending-send boundaries", async () => {
  for (const kind of ["account", "unmount", "draft", "reentry"] as const) {
    const env = controller();
    const pending = setSessionCodePermission(env.app, plan);
    if (kind === "account")
      env.app.currentController!.current = { ...env.app, accountId: "other" };
    if (kind === "unmount") env.app.currentController!.current = undefined;
    if (kind === "draft")
      env.app.currentController!.current = {
        ...env.app,
        draftSession: "new-draft",
      };
    if (kind === "reentry")
      env.app.currentController!.current = { ...env.app, controllerScope: {} };
    await pending;
    assert.deepEqual(env.draftModes, [], kind);
    assert.deepEqual(env.saved, [], kind);
  }
});

test("only an explicit changed bypass-folder grant touches account preferences, and stale completion is ignored", async () => {
  const env = controller();
  let release!: () => void;
  env.app.updatePreference = async (patch) => {
    env.accountPatches.push(patch);
    await new Promise<void>((resolve) => (release = resolve));
  };
  const pending = setSessionCodePermission(
    env.app,
    { ...auto, bypassFolders: ["/trusted"] },
    conversation(),
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(typeof release, "function");
  env.app.currentController!.current = { ...env.app, accountId: "other" };
  release();
  await pending;
  assert.deepEqual(env.accountPatches, [{ bypassFolders: ["/trusted"] }]);
  assert.deepEqual(env.saved, []);
});

test("live controllers survive StrictMode setup/cleanup and expire on unmount or account re-entry", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const globals = {
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    navigator: { userAgent: "controller-test" },
    IS_REACT_ACT_ENVIRONMENT: true,
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
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  let latest!: ReturnType<typeof useControllerRef<{ accountId: string }>>;
  function Probe({ owner }: { owner: string }) {
    latest = useControllerRef<{ accountId: string }>(owner);
    latest.exposeController({ accountId: owner });
    return null;
  }
  try {
    await act(async () =>
      root.render(
        createElement(StrictMode, null, createElement(Probe, { owner: "a" })),
      ),
    );
    const first = latest.controllerScope;
    assert.equal(latest.currentController.current?.accountId, "a");
    await act(async () =>
      root.render(
        createElement(StrictMode, null, createElement(Probe, { owner: "b" })),
      ),
    );
    assert.equal(latest.currentController.current?.accountId, "b");
    await act(async () =>
      root.render(
        createElement(StrictMode, null, createElement(Probe, { owner: "a" })),
      ),
    );
    assert.equal(latest.currentController.current?.accountId, "a");
    assert.notEqual(latest.controllerScope, first);
    await act(async () => root.unmount());
    assert.equal(latest.currentController.current, undefined);
  } finally {
    for (const [key, value] of saved)
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
  }
});

test("permission acknowledgements preserve newer revisions, transcripts and archive state without resurrecting deletions", () => {
  const current: Conversation = {
    ...conversation(),
    title: "Current title",
    archived: true,
    codePermissionMode: "plan",
    codePermissionRevision: 3,
    turns: [
      {
        id: "t1",
        prompt: "Current prompt",
        attachments: [],
        items: [],
        status: "completed",
        createdAt: 1,
      },
      {
        id: "t2",
        prompt: "New turn",
        attachments: [],
        items: [],
        status: "inProgress",
        createdAt: 2,
      },
    ],
  };
  const snapshot: Snapshot = {
    artifactLibrary: { version: 1, copies: [], pinned: [] },
    dismissedBackgroundTasks: [],
    artifactShares: [],
    settings: base,
    conversations: [current],
    projects: [],
    engine: { state: "ready" },
    approvals: [],
    platform: "darwin",
    replyFeedback: {},
  };
  const older: Conversation = {
    ...current,
    codePermissionMode: "auto",
    codePermissionRevision: 2,
  };
  assert.equal(mergeCodePermissionResponse(snapshot, older), snapshot);
  const ack: Conversation = {
    ...current,
    title: "Old title",
    archived: false,
    codePermissionMode: "acceptEdits",
    codePermissionRevision: 4,
    turns: [
      {
        ...current.turns[0],
        prompt: "Old prompt",
        status: "inProgress",
        codePermissionMode: "auto",
      },
    ],
  };
  const merged = mergeCodePermissionResponse(snapshot, ack)!;
  assert.equal(merged.conversations[0].codePermissionMode, "acceptEdits");
  assert.equal(merged.conversations[0].codePermissionRevision, 4);
  assert.equal(merged.conversations[0].title, "Current title");
  assert.equal(merged.conversations[0].archived, true);
  assert.equal(merged.conversations[0].turns.length, 2);
  assert.equal(merged.conversations[0].turns[0].prompt, "Current prompt");
  assert.equal(merged.conversations[0].turns[0].status, "completed");
  assert.equal(merged.conversations[0].turns[0].codePermissionMode, "auto");
  assert.equal(merged.conversations[0].turns[1], current.turns[1]);
  const deleted = { ...snapshot, conversations: [] };
  assert.equal(mergeCodePermissionResponse(deleted, ack), deleted);
  assert.equal(mergeCodePermissionResponse(undefined, ack), undefined);
});

test("a slow previous controller does not block a new account scope's permission choices", async () => {
  const old = controller();
  const fresh = controller();
  let release!: () => void;
  old.app.patchConversation = async () => {
    await new Promise<void>((resolve) => (release = resolve));
  };
  const slow = setSessionCodePermission(old.app, plan, conversation());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(typeof release, "function");
  const next = setSessionCodePermission(fresh.app, edits, conversation());
  await next;
  assert.deepEqual(fresh.saved, [{ target: "a", mode: "acceptEdits" }]);
  release();
  await slow;
});

test("sending waits for an already requested permission save, and new choices are disabled during preparation", async () => {
  const env = controller();
  let release!: () => void;
  env.app.patchConversation = async () => {
    await new Promise<void>((resolve) => (release = resolve));
  };
  const update = setSessionCodePermission(env.app, plan, conversation());
  await Promise.resolve();
  await Promise.resolve();
  let continued = false;
  const waiting = waitForCodePermissions(env.app, "a").then(() => {
    continued = true;
  });
  await Promise.resolve();
  assert.equal(continued, false);
  release();
  await update;
  await waiting;
  assert.equal(continued, true);
  env.app.sending = true;
  await setSessionCodePermission(env.app, edits, conversation());
  assert.deepEqual(env.saved, []);
});
