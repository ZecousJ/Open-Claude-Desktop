import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement as h } from "react";
import { readFileSync } from "node:fs";
import { ArtifactChrome } from "../../src/artifacts/ArtifactChrome";
import { ArtifactsPage } from "../../src/artifacts/ArtifactsPage";
import { ArtifactCommentCard } from "../../src/artifacts/ArtifactCommentCard";
import {
  ArtifactMetadataProvider,
  artifactNoteKeyOf,
  useArtifactComments,
} from "../../src/artifacts/artifact-metadata";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { HostContext } from "../../src/host/HostContext";
import { webHost } from "../../shared/host";
import type { Artifact } from "../../src/ui/ArtifactTypes";
import type {
  ArtifactComment,
  ArtifactNotes,
} from "../../shared/artifact-notes";
import { collectArtifacts } from "../../src/artifacts/artifact-collection";
import { routineDom } from "../support/routine-dom";
import type { Conversation } from "../../shared/types";

const conversation = (id = "origin"): Conversation => ({
  id,
  title: "Unrelated chat label",
  mode: "chat",
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns: [
    {
      id: "turn",
      status: "completed",
      prompt: "",
      attachments: [],
      createdAt: 1,
      items: [
        {
          id: "output",
          type: "agentMessage",
          text: "```html\n<p>Frame</p>\n```",
        },
      ],
    },
  ],
});
const notesComment: ArtifactComment = {
  id: "comment",
  text: "Real saved comment",
  x: 0.2,
  y: 0.3,
  createdAt: 1,
  resolved: false,
  replies: [{ id: "reply", text: "Saved reply", createdAt: 2 }],
};
const noop = () => {};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function setup(bridge: Partial<Window["desktop"]> = {}) {
  const env = await routineDom(
    {
      artifactNotes: async () => ({}),
      voiceAvailability: async () => ({
        transcription: false,
        maxTranscriptionBytes: null,
        maxSeconds: null,
      }),
      ...bridge,
    },
    { jsdom: true },
  );
  const state = {
    conversations: [conversation()],
    artifactLibrary: { version: 1 as const, copies: [], pinned: [] },
    artifactShares: [],
    projects: [],
    settings: { name: "Person" },
  };
  const artifact = {
    ...collectArtifacts(state.conversations, [], state.artifactLibrary)[0],
    name: "Known title",
    surface: "artifact" as const,
  };
  const errors: unknown[] = [];
  const app = {
    accountId: "A",
    controllerScope: {},
    currentController: { current: undefined },
    snapshot: state,
    listed: state.conversations,
    artifact,
    page: "artifact",
    report: (error: unknown) => errors.push(error),
    notify() {},
  } as unknown as AppController;
  const render = (child: ReturnType<typeof h>, metadata = true) => {
    app.currentController!.current = app;
    return env.render(
      h(
        AppContext.Provider,
        { value: app },
        h(
          HostContext.Provider,
          {
            value: {
              ...webHost,
              capabilities: { ...webHost.capabilities, cloudCowork: true },
            },
          },
          metadata
            ? h(
                ArtifactMetadataProvider,
                {
                  accountId: app.accountId,
                  legacyOwner: false,
                  conversationIds: new Set(["origin"]),
                  children: child,
                },
                child,
              )
            : child,
        ),
      ),
    );
  };
  const query = <T extends Element = HTMLElement>(selector: string) => {
    const found = env.document.querySelector<T>(selector);
    assert.ok(found, selector);
    return found;
  };
  return { ...env, app, artifact, errors, render, query };
}
const chrome = (
  artifact: Artifact,
  props: Partial<Parameters<typeof ArtifactChrome>[0]> = {},
) =>
  h(ArtifactChrome, {
    artifact,
    standalone: true,
    expanded: true,
    onExpand: noop,
    onClose: noop,
    onRefresh: noop,
    onError: noop,
    ...props,
  });

for (const explicit of [false, true])
  test(`33: explicit ${explicit ? "caller" : "backend"} read-only rights preserve reading and remove all mutations`, async (t) => {
    let writes = 0,
      sent = 0;
    const env = await setup({
      artifactNotes: async () => ({
        [artifactNoteKeyOf(env.artifact)]: {
          comments: [notesComment],
          ...(!explicit ? { access: { read: true, write: false } } : {}),
        },
      }),
      updateArtifactNote: async () => {
        writes++;
        return {};
      },
    });
    t.after(env.clean);
    await env.render(
      chrome(env.artifact, {
        ...(explicit ? { commentAccess: { read: true, write: false } } : {}),
        onComment: async () => {
          sent++;
        },
      }),
    );
    const view = env.query<HTMLButtonElement>('[aria-label="View comments"]');
    assert.equal(view.disabled, false);
    await env.event(view, "click");
    assert.ok(env.document.querySelector('[aria-label="Done viewing"]'));
    assert.match(
      env.query(".artifact-comments-list").textContent!,
      /Real saved comment/,
    );
    assert.match(
      env.query(".artifact-comments-list").textContent!,
      /Saved reply/,
    );
    assert.equal(
      env.document.querySelector(".artifact-thread-actions button"),
      null,
    );
    assert.equal(env.document.querySelector(".artifact-thread-compose"), null);
    assert.equal(env.document.querySelector(".artifact-comment-capture"), null);
    await env.event(env.document, "keydown", { key: "c" });
    assert.equal(env.document.querySelector(".artifact-comment-capture"), null);
    assert.equal(writes, 0);
    assert.equal(sent, 0);
  });

test("33: denied reading never exposes saved comments or an enabled comment entry", async (t) => {
  const env = await setup({
    artifactNotes: async () => ({
      [artifactNoteKeyOf(env.artifact)]: {
        comments: [notesComment],
        access: { read: false, write: false },
      },
    }),
  });
  t.after(env.clean);
  await env.render(chrome(env.artifact));
  assert.equal(
    env.query<HTMLButtonElement>(".artifact-comment-buttons > button").disabled,
    true,
  );
  assert.equal(env.document.querySelector(".artifact-comment-pin"), null);
  assert.doesNotMatch(env.document.body.textContent!, /Real saved comment/);
});

test("33: shared/imported and pinned flags alone do not invent view-only note rights", async (t) => {
  const env = await setup();
  t.after(env.clean);
  await env.render(
    chrome({ ...env.artifact, sharedWithYou: true, versionPinned: true }),
  );
  assert.ok(
    env.document.querySelector('[aria-label="Comment on this artifact"]'),
  );
  assert.equal(
    env.document.querySelector('[aria-label="View comments"]'),
    null,
  );
});

test("33: the comment hook blocks retained saves after explicit rights are revoked", async (t) => {
  const env = await setup();
  t.after(env.clean);
  let hook!: ReturnType<typeof useArtifactComments>;
  let readOnly = false;
  function Probe() {
    hook = useArtifactComments(env.artifact, { read: true, write: !readOnly });
    return h("span", null, "Notes");
  }
  await env.render(h(Probe));
  const previous = hook.save;
  readOnly = true;
  await env.render(h(Probe));
  await assert.rejects(previous([notesComment]), /view-only access/);
});

for (const change of ["account", "bridge", "controller", "unmount"] as const)
  test(`33: a late comment save cannot populate another owner after ${change}`, async (t) => {
    const saving = deferred<{ comments: ArtifactComment[] }>();
    let writes = 0;
    const env = await setup({
      updateArtifactNote: async () => {
        writes++;
        return saving.promise;
      },
    });
    t.after(env.clean);
    let hook!: ReturnType<typeof useArtifactComments>;
    function Probe() {
      hook = useArtifactComments(env.artifact);
      return h(
        "span",
        null,
        hook.comments?.map((comment) => comment.text).join(",") ??
          "No saved comments",
      );
    }
    await env.render(h(Probe));
    const previousSave = hook.save;
    const started = previousSave([notesComment]);
    const rejected = assert.rejects(started, /no longer belongs/);
    if (change === "account") env.app.accountId = "B";
    if (change === "controller") env.app.controllerScope = {};
    if (change === "bridge")
      (env.window as unknown as Window).desktop = {
        artifactNotes: async () => ({}),
        updateArtifactNote: async () => ({}),
      } as never;
    await env.render(
      change === "unmount" ? h("div", null, "Replacement") : h(Probe),
    );
    await act(async () => saving.resolve({ comments: [notesComment] }));
    await rejected;
    assert.doesNotMatch(env.document.body.textContent!, /Real saved comment/);
    await assert.rejects(previousSave([notesComment]), /no longer belongs/);
    assert.equal(writes, 1);
    assert.deepEqual(env.errors, []);
  });

test("33: an old account's delayed notes read never becomes the replacement account's comments", async (t) => {
  const pending = deferred<ArtifactNotes>();
  let reads = 0;
  const env = await setup({
    artifactNotes: () =>
      ++reads === 1 ? pending.promise : Promise.resolve({}),
  });
  t.after(env.clean);
  await env.render(chrome(env.artifact));
  env.app.accountId = "B";
  await env.render(chrome(env.artifact));
  await act(async () =>
    pending.resolve({
      [artifactNoteKeyOf(env.artifact)]: { comments: [notesComment] },
    }),
  );
  await env.click('[aria-label="Comment on this artifact"]');
  assert.doesNotMatch(env.document.body.textContent!, /Real saved comment/);
  assert.deepEqual(env.errors, []);
});

test("33: a rejected backend write never appears as a successfully saved comment", async (t) => {
  const env = await setup({
    updateArtifactNote: async () => {
      throw new Error("Write refused");
    },
  });
  t.after(env.clean);
  let hook!: ReturnType<typeof useArtifactComments>;
  function Probe() {
    hook = useArtifactComments(env.artifact);
    return h(
      "span",
      null,
      hook.comments?.map((comment) => comment.text).join(",") ??
        "No saved comments",
    );
  }
  await env.render(h(Probe));
  await assert.rejects(hook.save([notesComment]), /Write refused/);
  assert.doesNotMatch(env.document.body.textContent!, /Real saved comment/);
});

test("33: a thread losing write access closes mutation UI and retires a pending mutation error", async (t) => {
  const env = await setup();
  const eventGlobals = ["addEventListener", "removeEventListener"] as const;
  const previous = eventGlobals.map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key),
  );
  eventGlobals.forEach((key) =>
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: env.window[key].bind(env.window),
    }),
  );
  t.after(async () => {
    await env.clean();
    eventGlobals.forEach((key, index) =>
      previous[index]
        ? Object.defineProperty(globalThis, key, previous[index]!)
        : Reflect.deleteProperty(globalThis, key),
    );
  });
  const pending = deferred<void>();
  let errors = 0;
  const props = {
    comment: notesComment,
    authorName: "You",
    pulse: false,
    onResolve: () => pending.promise,
    onEdit: async () => {},
    onDelete: async () => {},
    onReply: async () => {},
    onEditReply: async () => {},
    onDeleteReply: async () => {},
    onError: () => {
      errors++;
    },
  };
  await env.render(h(ArtifactCommentCard, props), false);
  await env.click(".artifact-thread-resolve");
  await env.render(h(ArtifactCommentCard, { ...props, readOnly: true }), false);
  assert.equal(env.document.querySelector("button"), null);
  // Restoring rights must not resurrect the retired operation's callbacks.
  await env.render(
    h(ArtifactCommentCard, { ...props, readOnly: false }),
    false,
  );
  await act(async () => pending.reject(new Error("Old mutation failure")));
  assert.equal(errors, 0);
  assert.equal(
    env.query<HTMLButtonElement>(".artifact-thread-resolve").disabled,
    false,
  );
  assert.match(env.document.body.textContent!, /Real saved comment/);
});

test("34/57 reused: a cached title survives notes loading and generating without manufacturing related sessions", async (t) => {
  const pending = deferred<ArtifactNotes>();
  const env = await setup({ artifactNotes: () => pending.promise });
  t.after(env.clean);
  await env.render(chrome({ ...env.artifact, generating: true }));
  assert.match(
    env.query(".artifact-title-options").textContent!,
    /Known title/,
  );
  assert.doesNotMatch(
    env.query(".artifact-collaboration-header").textContent!,
    /Loading artifact/,
  );
  assert.ok(
    env.document.querySelector(
      '[aria-label="Chat with Claudex · 1 session here"]',
    ),
  );
  await act(async () => pending.resolve({}));
  env.app.snapshot = { ...env.app.snapshot, conversations: [] };
  await env.render(chrome(env.artifact));
  assert.ok(
    env.document.querySelector(
      '[aria-label="Chat with Claudex · 0 sessions here"]',
    ),
  );
});

test("41: actual toolbar retains source order/geometry and Design is drawn only with a destination", async (t) => {
  const env = await setup();
  t.after(env.clean);
  const props = {
    artifacts: [env.artifact],
    onOpenArtifact: noop,
    onCreate: noop,
    onComment: async () => {},
    authorName: "You",
    onShareRequestConsumed: noop,
    onDuplicate: async () => {},
    onPin: async () => {},
    onDelete: noop,
    width: 50,
    onResize: noop,
    onClose: noop,
    onError: noop,
    onNotify: noop,
  };
  await env.render(h(ArtifactsPage, props), false);
  const all = [
    ...env.document.querySelectorAll<HTMLButtonElement>(
      ".artifacts-tools button",
    ),
  ];
  // Search, Group by, List view, Filter, then New at the end (Design only with
  // a destination).
  assert.deepEqual(
    all.map((button) => button.getAttribute("aria-label")),
    [
      "Search your artifacts",
      "Group by: None",
      "List view",
      "Filter by type: All types",
      "New",
    ],
  );
  const tools = all.filter(
    (button) =>
      button.classList.contains("artifacts-tool") &&
      !button.classList.contains("artifacts-new"),
  );
  const stylesheet = env.document.createElement("style");
  stylesheet.textContent = readFileSync(
    new URL("../../src/artifacts/gallery.css", import.meta.url),
    "utf8",
  );
  env.document.head.append(stylesheet);
  for (const tool of tools) {
    const css = env.window.getComputedStyle(tool);
    assert.equal(css.width, "32px");
    assert.equal(css.height, "32px");
    assert.equal(css.borderRadius, "8px");
  }
  await env.event(tools[1], "click");
  assert.ok(env.document.querySelector('[aria-label="Grid view"]'));
  let opened = 0;
  await env.render(
    h(ArtifactsPage, {
      ...props,
      onOpenDesign: () => {
        opened++;
      },
    }),
    false,
  );
  await env.click('[aria-label="Design"]');
  assert.equal(opened, 1);
  env.app.currentController!.current = undefined;
  await env.click('[aria-label="Design"]');
  assert.equal(opened, 1);
});
