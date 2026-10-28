import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import { act, createElement as h } from "react";
import type { Conversation, Snapshot } from "../../shared/types";
import type { Artifact } from "../../src/ui/ArtifactTypes";
import type { AppContext as BackendContext } from "../../electron/app/app-context";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { collectArtifacts } from "../../src/artifacts/artifact-collection";
import { ArtifactChrome } from "../../src/artifacts/ArtifactChrome";
import { ArtifactPanel } from "../../src/artifacts/FileViewer";
import { BlankArtifactPanel } from "../../src/artifacts/BlankArtifactPanel";
import {
  relatedArtifactSessions,
  artifactChatAction,
} from "../../src/artifacts/related-sessions";
import { artifactRouteId } from "../../src/artifacts/artifact-route-model";
import { blankConversationArtifact } from "../../src/artifacts/blank-artifact-model";
import { registerBlankArtifactHandlers } from "../../electron/ipc/blank-artifacts";
import { resolveBlankArtifactFile } from "../../electron/artifacts/blank-artifact-files";
import { Store } from "../../electron/store/store";
import { routineDom } from "../support/routine-dom";

const conversation = (id = "origin"): Conversation => ({
  id,
  title: "Same title",
  mode: "chat",
  providerId: "default",
  model: "model",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns: [
    {
      id: "t",
      prompt: "",
      attachments: [],
      status: "completed",
      createdAt: 1,
      items: [
        {
          id: "same-message-id",
          type: "agentMessage",
          text: "```html\n<p>Same content</p>\n```",
        },
      ],
    },
  ],
});
const snapshot = (rows = [conversation()]): Snapshot =>
  ({
    conversations: rows,
    artifactLibrary: { version: 1, copies: [], pinned: [] },
    artifactShares: [],
    projects: [],
    settings: { name: "Person" },
  }) as unknown as Snapshot;
const source = (state: Snapshot) =>
  collectArtifacts(state.conversations, [], state.artifactLibrary)[0];
const ids = (state: Snapshot, artifact: Artifact) =>
  relatedArtifactSessions(state, artifact).map((c) => c.id);

function controller(state: Snapshot, artifact: Artifact) {
  const calls: unknown[][] = [],
    currentController: { current: AppController | undefined } = {
      current: undefined,
    };
  const app = {
    accountId: "account",
    controllerScope: {},
    currentController,
    snapshot: state,
    listed: state.conversations,
    page: "artifact",
    artifactRouteId: artifactRouteId(artifact),
    artifact,
    openConversation: (c: Conversation, options: unknown) =>
      calls.push(["open", c.id, options]),
    newChat: (mode: string) => calls.push(["new", mode]),
    setArtifact: (a: Artifact) => calls.push(["artifact", a.libraryId ?? a.id]),
    report: (e: unknown) => {
      throw e;
    },
    notify() {},
  } as unknown as AppController;
  currentController.current = app;
  return { app, calls, currentController };
}
async function environment(bridge: Partial<Window["desktop"]> = {}) {
  const env = await routineDom(bridge, { jsdom: true });
  const extras = {
    CustomEvent: env.window.CustomEvent,
    DOMParser: env.window.DOMParser,
    XMLSerializer: env.window.XMLSerializer,
  };
  const before = new Map(
    Object.keys(extras).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(extras))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  return {
    ...env,
    async clean() {
      await env.clean();
      for (const [key, value] of before) {
        if (value) Object.defineProperty(globalThis, key, value);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
async function until(label: string, condition: () => boolean) {
  const deadline = performance.now() + 5000;
  while (!condition()) {
    assert.ok(performance.now() < deadline, label);
    await act(async () => {
      await tick();
    });
  }
}

test("session identity comes from actual ownership, never another chat's equal title, body or message ID", () => {
  const state = snapshot([
      conversation("origin"),
      conversation("same-content-other-chat"),
    ]),
    artifact = source(state);
  assert.deepEqual(ids(state, artifact), ["origin"]);
  assert.deepEqual(
    ids({ ...state, conversations: [state.conversations[1]] }, artifact),
    [],
  );
  assert.deepEqual(
    ids(
      {
        ...state,
        conversations: [{ ...state.conversations[0], incognito: true }],
      },
      artifact,
    ),
    [],
  );
  assert.deepEqual(
    ids(
      {
        ...state,
        conversations: [state.conversations[0], state.conversations[0]],
      },
      artifact,
    ),
    [],
  );
  assert.deepEqual(ids(state, { ...artifact, id: "unowned" }), []);
});

test("library origins are explicit, independently identified records; imports and missing origins have zero sessions", () => {
  const state = snapshot(),
    artifact = source(state);
  state.artifactLibrary.copies = [
    {
      libraryId: "copy",
      name: artifact.name,
      language: artifact.language,
      content: artifact.content,
      createdAt: 1,
      originConversationId: "origin",
    },
    {
      libraryId: "unlinked",
      name: artifact.name,
      language: artifact.language,
      content: artifact.content,
      createdAt: 1,
    },
    {
      libraryId: "imported",
      name: artifact.name,
      language: artifact.language,
      content: artifact.content,
      createdAt: 1,
      originConversationId: "origin",
      sharedArtifactToken: "external-token",
    },
  ];
  for (const [id, expected] of [
    ["copy", ["origin"]],
    ["unlinked", []],
    ["imported", []],
  ] as const) {
    const copy = collectArtifacts(
      state.conversations,
      [],
      state.artifactLibrary,
    ).find((a) => a.libraryId === id)!;
    assert.deepEqual(ids(state, copy), expected);
  }
  const copy = { ...artifact, id: "copy", libraryId: "copy" };
  assert.deepEqual(ids({ ...state, conversations: [] }, copy), []);
});

test("the actual generic standalone header exposes the computed count and opens the proven owner", async () => {
  const state = snapshot([conversation(), conversation("unrelated")]),
    artifact = source(state),
    c = controller(state, artifact),
    env = await environment();
  const render = () =>
    env.render(
      h(
        AppContext.Provider,
        { value: c.app },
        h(ArtifactChrome, {
          artifact,
          expanded: true,
          standalone: true,
          onExpand: artifactChatAction(c.app, artifact),
          onClose() {},
          onRefresh() {},
          onError: c.app.report,
        }),
      ),
    );
  try {
    await render();
    const chat = env.document.querySelector(
      'button[aria-label="Chat with Claudex · 1 session here"]',
    )!;
    assert.equal(chat.textContent?.trim(), "Chat");
    await env.event(chat, "click");
    assert.deepEqual(c.calls, [
      ["open", "origin", { artifactId: artifactRouteId(artifact) }],
    ]);
    c.app.snapshot = { ...state, conversations: [state.conversations[1]] };
    await render();
    assert.ok(
      env.document.querySelector(
        'button[aria-label="Chat with Claudex · 0 sessions here"]',
      ),
    );
    await env.event(chat, "click");
    assert.equal(c.calls.length, 1);
  } finally {
    await env.clean();
  }
});

test("an unlinked imported artifact starts a new chat without claiming an existing related session", async () => {
  const state = snapshot();
  state.artifactLibrary.copies.push({
    libraryId: "imported",
    name: "Imported",
    language: "html",
    content: "body",
    createdAt: 1,
    sharedArtifactToken: "token",
  });
  const artifact = collectArtifacts(
      state.conversations,
      [],
      state.artifactLibrary,
    ).find((a) => a.libraryId === "imported")!,
    c = controller(state, artifact),
    env = await environment();
  try {
    await env.render(
      h(
        AppContext.Provider,
        { value: c.app },
        h(ArtifactChrome, {
          artifact,
          expanded: true,
          standalone: true,
          onExpand: artifactChatAction(c.app, artifact),
          onClose() {},
          onRefresh() {},
          onError: c.app.report,
        }),
      ),
    );
    await env.click('button[aria-label="Chat with Claudex · 0 sessions here"]');
    assert.deepEqual(c.calls, [
      ["new", "chat"],
      ["artifact", "imported"],
    ]);
  } finally {
    await env.clean();
  }
});

for (const retired of [
  "account",
  "controller",
  "bridge",
  "route",
  "unmounted",
] as const)
  test(`retained header navigation rejects ${retired} retirement`, async () => {
    const state = snapshot(),
      artifact = source(state),
      c = controller(state, artifact),
      env = await environment();
    try {
      await env.render(
        h(
          AppContext.Provider,
          { value: c.app },
          h(ArtifactChrome, {
            artifact,
            expanded: true,
            standalone: true,
            onExpand: artifactChatAction(c.app, artifact),
            onClose() {},
            onRefresh() {},
            onError: c.app.report,
          }),
        ),
      );
      if (retired === "account")
        c.currentController.current = { ...c.app, accountId: "other" };
      if (retired === "controller")
        c.currentController.current = { ...c.app, controllerScope: {} };
      if (retired === "bridge") env.window.desktop = { ...env.window.desktop };
      if (retired === "route")
        c.currentController.current = {
          ...c.app,
          artifactRouteId: "other-route",
        };
      if (retired === "unmounted") c.currentController.current = undefined;
      await env.click(
        'button[aria-label="Chat with Claudex · 1 session here"]',
      );
      assert.deepEqual(c.calls, []);
    } finally {
      await env.clean();
    }
  });

async function blank(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-b23-sessions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root),
    handlers = new Map<string, (...args: any[]) => any>();
  const context = {
    store,
    engine: {
      defaultWorkspace: path.join(root, "workspace"),
      environment: { kind: "local" },
    },
    push() {},
  } as unknown as BackendContext;
  registerBlankArtifactHandlers(
    (name, handler) => handlers.set(name, handler),
    context,
  );
  const created = await handlers.get("createBlankArtifact")!({
    requestId: randomUUID(),
    kind: "docs",
    name: "Document",
    providerId: "default",
    model: "model",
  });
  const artifact = blankConversationArtifact(created.conversation)!,
    state = snapshot(store.conversations),
    c = controller(state, artifact);
  let release!: () => void,
    started = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const env = await environment({
    readBlankArtifact: async (input) =>
      handlers.get("readBlankArtifact")!(input),
    saveBlankArtifact: async (input) => {
      started = true;
      await gate;
      return handlers.get("saveBlankArtifact")!(input);
    },
  });
  await env.render(
    h(
      AppContext.Provider,
      { value: c.app },
      h(BlankArtifactPanel, {
        artifact,
        fullPage: true,
        onChat: artifactChatAction(c.app, artifact),
        onClose() {},
        onError: c.app.report,
      }),
    ),
  );
  await until(
    "real blank editor mounted",
    () =>
      env.document.querySelector(".blank-save-status")?.textContent === "Saved",
  );
  return {
    ...env,
    ...c,
    context,
    store,
    artifact,
    release,
    started: () => started,
  };
}

test("actual blank header counts its stored pair and keeps Chat navigation pending until real file saving succeeds", async (t) => {
  const env = await blank(t);
  try {
    const button = env.document.querySelector(
      'button[aria-label="Chat with Claudex · 1 session here"]',
    )!;
    assert.ok(button.textContent?.trim().endsWith("Chat"));
    const editor = env.document.querySelector(
      '[aria-label="Document content"]',
    )!;
    editor.innerHTML = "<p>Saved before navigation</p>";
    await env.event(editor, "input");
    await env.event(button, "click");
    assert.deepEqual(env.calls, []);
    await until("real save was requested", env.started);
    assert.deepEqual(env.calls, []);
    await act(async () => env.release());
    await until(
      "Chat opens after persisted file acknowledgement",
      () => env.calls.length > 0,
    );
    assert.deepEqual(env.calls[0], [
      "open",
      env.artifact.conversationId,
      { artifactId: artifactRouteId(env.artifact) },
    ]);
    const file = resolveBlankArtifactFile(
      env.context.engine.defaultWorkspace,
      env.store.conversation(env.artifact.conversationId!),
    ).file;
    assert.ok(
      fs.readFileSync(file, "utf8").includes("Saved before navigation"),
    );
  } finally {
    env.release();
    await env.clean();
  }
});

for (const retired of ["account", "bridge", "route", "deleted"] as const)
  test(`a pending blank save cannot resume Chat navigation after ${retired} retirement`, async (t) => {
    const env = await blank(t);
    try {
      const editor = env.document.querySelector(
        '[aria-label="Document content"]',
      )!;
      editor.innerHTML = "<p>Pending draft</p>";
      await env.event(editor, "input");
      await env.click(
        'button[aria-label="Chat with Claudex · 1 session here"]',
      );
      await until("pending real save", env.started);
      if (retired === "account")
        env.currentController.current = { ...env.app, accountId: "other" };
      if (retired === "bridge") env.window.desktop = { ...env.window.desktop };
      if (retired === "route")
        env.currentController.current = {
          ...env.app,
          artifactRouteId: "another-artifact",
        };
      if (retired === "deleted")
        env.currentController.current = {
          ...env.app,
          snapshot: { ...env.app.snapshot, conversations: [] },
        };
      await act(async () => env.release());
      await until(
        "save acknowledgement reached the retained editor",
        () =>
          env.document.querySelector(".blank-save-status")?.textContent ===
          "Saved",
      );
      assert.deepEqual(env.calls, []);
    } finally {
      env.release();
      await env.clean();
    }
  });

test("rewriting an existing editable frame keeps its known title, chrome, and independent action readiness", async () => {
  const state = snapshot(),
    artifact = { ...source(state), surface: "artifact" as const },
    c = controller(state, artifact),
    env = await environment();
  const render = (generating: boolean) =>
    env.render(
      h(
        AppContext.Provider,
        { value: c.app },
        h(ArtifactPanel, {
          artifact: { ...artifact, generating },
          onClose() {},
          onError: c.app.report,
        }),
      ),
    );
  try {
    await render(true);
    const header = env.document.querySelector(
      ".artifact-collaboration-header",
    )!;
    assert.ok(header);
    assert.equal(header.getAttribute("aria-busy"), null);
    assert.equal(
      env.document.querySelector("[data-artifact-pending-title]"),
      null,
    );
    const title = env.document.querySelector(".artifact-title-options")!;
    assert.ok(title.textContent?.includes(artifact.name));
    assert.equal(
      title.getAttribute("aria-label")?.includes("Loading artifact"),
      false,
    );
    assert.equal(
      env.document.querySelector<HTMLButtonElement>('[aria-label="Comment"]')
        ?.disabled,
      false,
    );
    assert.ok(env.document.querySelector('[aria-label="Generating"]'));
    await render(false);
    assert.equal(
      env.document.querySelector(".artifact-collaboration-header"),
      header,
    );
    assert.equal(env.document.querySelector('[aria-label="Generating"]'), null);
  } finally {
    await env.clean();
  }
});

for (const boundary of ["shared", "version"] as const)
  test(`generating ${boundary} surfaces retain their separate pending renderer`, async () => {
    const state = snapshot(),
      artifact = {
        ...source(state),
        surface: "artifact" as const,
        generating: true,
        ...(boundary === "shared"
          ? { sharedWithYou: true }
          : { versionPinned: true }),
      },
      c = controller(state, artifact),
      env = await environment();
    try {
      await env.render(
        h(
          AppContext.Provider,
          { value: c.app },
          h(ArtifactPanel, { artifact, onClose() {}, onError: c.app.report }),
        ),
      );
      assert.equal(
        env.document.querySelector(".artifact-collaboration-header"),
        null,
      );
      assert.equal(
        env.document.querySelector("[data-artifact-pending-title]"),
        null,
      );
      assert.ok(env.document.querySelector('[aria-label="Generating"]'));
    } finally {
      await env.clean();
    }
  });
