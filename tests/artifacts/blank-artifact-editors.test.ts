import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { act, createElement as h, StrictMode } from "react";
import { Store } from "../../electron/store/store";
import { registerBlankArtifactHandlers } from "../../electron/ipc/blank-artifacts";
import { resolveBlankArtifactFile } from "../../electron/artifacts/blank-artifact-files";
import { AppContext, type AppController } from "../../src/app/AppContext";
import type { AppContext as BackendContext } from "../../electron/app/app-context";
import type { CreatedBlankArtifact } from "../../shared/blank-artifacts";
import {
  blankConversationArtifact,
  editorMarkup,
} from "../../src/artifacts/blank-artifact-model";
import { BlankArtifactPanel } from "../../src/artifacts/BlankArtifactPanel";
import { collectArtifacts } from "../../src/artifacts/artifact-collection";
import { createBlankArtifact } from "../../src/artifacts/create-blank-artifact";
import { retireBlankArtifactCreates } from "../../src/artifacts/blank-artifact-request";
import { routineDom } from "../support/routine-dom";
import { fileTransitionEvent } from "../../src/files/file-transitions";
function backend(t: { after(fn: () => unknown): unknown }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-blank-editor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.settings.providers[0].model = "model";
  const context = {
    store,
    engine: {
      defaultWorkspace: path.join(root, "workspace"),
      environment: { kind: "local" },
    },
    push: () => {},
  } as unknown as BackendContext;
  const handlers = new Map<string, (...args: any[]) => any>();
  registerBlankArtifactHandlers((name, fn) => handlers.set(name, fn), context);
  const bridge = {
    createBlankArtifact: async (input: any) =>
      handlers.get("createBlankArtifact")!(input),
    readBlankArtifact: async (input: any) =>
      handlers.get("readBlankArtifact")!(input),
    saveBlankArtifact: async (input: any) =>
      handlers.get("saveBlankArtifact")!(input),
  };
  const create = async (
    kind: "docs" | "slides" | "design" | "dashboard" = "docs",
  ) =>
    (await bridge.createBlankArtifact({
      requestId: randomUUID(),
      kind,
      name: "Untitled",
      providerId: "default",
      model: "model",
    })) as CreatedBlankArtifact;
  return { root, store, context, bridge, create };
}
async function mounted(
  t: { after(fn: () => unknown): unknown },
  kind: "docs" | "slides" | "design" | "dashboard" = "docs",
) {
  const b = backend(t),
    pair = await b.create(kind),
    env = await routineDom(b.bridge, { jsdom: true });
  const globals = {
    DOMParser: env.window.DOMParser,
    XMLSerializer: env.window.XMLSerializer,
    CustomEvent: env.window.CustomEvent,
  };
  const previous = new Map(
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
  t.after(async () => {
    await env.clean();
    for (const [key, value] of previous) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const errors: unknown[] = [];
  let closed = 0;
  let app = {
    accountId: "a",
    controllerScope: {},
    snapshot: { conversations: b.store.conversations },
    notify: () => {},
    report: (error: unknown) => errors.push(error),
  } as unknown as AppController;
  const artifact = blankConversationArtifact(pair.conversation)!;
  const render = async (key = "one") =>
    env.render(
      h(
        StrictMode,
        {},
        h(
          AppContext.Provider,
          { value: app },
          h(BlankArtifactPanel, {
            key,
            artifact,
            fullPage: true,
            onClose: () => closed++,
            onError: app.report,
          }),
        ),
      ),
    );
  await render();
  await waitFor(
    "the initial real editor read and mount",
    () =>
      env.document.querySelector(".blank-save-status")?.textContent === "Saved",
  );
  return {
    ...b,
    ...env,
    pair,
    artifact,
    errors,
    render,
    setApp: (next: AppController) => {
      app = next;
    },
    getApp: () => app,
    closed: () => closed,
    file: () =>
      resolveBlankArtifactFile(
        b.context.engine.defaultWorkspace,
        b.store.conversation(pair.conversation.id),
      ).file,
  };
}
/** Let timers, backend I/O and React commits progress, then inspect the real
 * condition. The deadline diagnoses a hang; it never defines readiness. */
async function waitFor(label: string, ready: () => boolean) {
  const deadline = performance.now() + 15_000;
  while (!ready()) {
    assert.ok(performance.now() < deadline, `Timed out waiting for ${label}`);
    await act(async () => {
      await nextTurn();
    });
  }
}
async function completion<T>(label: string, request: Promise<T>): Promise<T> {
  let settled = false;
  void request.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await waitFor(label, () => settled);
  return request;
}
function saved(e: Awaited<ReturnType<typeof mounted>>, label: string) {
  return waitFor(
    label,
    () =>
      e.document.querySelector(".blank-save-status")?.textContent === "Saved",
  );
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** Preserve the actual CAS/file handler, while the test controls both slow
 * persistence and its later acknowledgement. No elapsed time implies pending. */
function holdSaves(e: Awaited<ReturnType<typeof mounted>>) {
  const write = deferred<void>(),
    ack = deferred<void>();
  const original = e.window.desktop.saveBlankArtifact;
  const requests: ReturnType<typeof original>[] = [];
  let started = 0,
    persisted = 0;
  e.window.desktop.saveBlankArtifact = (input) => {
    const request = (async () => {
      started++;
      await write.promise;
      const result = await original(input);
      persisted++;
      await ack.promise;
      return result;
    })();
    requests.push(request);
    return request;
  };
  const release = () => {
    write.resolve();
    ack.resolve();
  };
  return {
    started: () => started,
    persisted: () => persisted,
    write: () => write.resolve(),
    acknowledge: () => ack.resolve(),
    release,
    drain: async () => {
      await act(async () => {
        release();
        await Promise.allSettled(requests);
      });
    },
  };
}
test("real Docs DOM edits save to its actual file; closing waits for CAS save and reopening reads it", async (t) => {
  const e = await mounted(t);
  const held = holdSaves(e);
  t.after(held.drain);
  const editor = e.document.querySelector<HTMLElement>(
    '[aria-label="Document content"]',
  )!;
  assert.ok(editor);
  assert.equal(e.document.querySelector('[aria-label^="Share"]'), null);
  editor.innerHTML = "<h1>User title</h1><p>Current real edit</p>";
  await e.event(editor, "input");
  await e.click('[aria-label="Close"]');
  assert.equal(e.closed(), 0);
  assert.match(e.document.body.textContent!, /Changes are still/);
  await waitFor("the blocked close save", () => held.started() === 1);
  held.write();
  await waitFor("the close file persistence", () => held.persisted() === 1);
  assert.match(fs.readFileSync(e.file(), "utf8"), /Current real edit/);
  assert.equal(e.closed(), 0, "file bytes alone do not acknowledge the save");
  assert.equal(
    e.document.querySelector(".blank-save-status")!.textContent,
    "Saving…",
  );
  held.acknowledge();
  await waitFor("the saved close transition", () => e.closed() === 1);
  assert.equal(e.closed(), 1);
  assert.match(fs.readFileSync(e.file(), "utf8"), /Current real edit/);
  assert.match(e.document.body.textContent!, /Saved/);
  await e.render("reopened");
  await saved(e, "the reopened editor read");
  assert.match(
    e.document.querySelector('[aria-label="Document content"]')!.textContent!,
    /Current real edit/,
  );
  assert.deepEqual(e.errors, []);
});
test("Docs toolbar performs real edits and a concurrent agent write yields conflict without discarding the local draft", async (t) => {
  const e = await mounted(t);
  await e.click('[aria-label="Table"]');
  assert.ok(e.document.querySelector(".blank-document-body table"));
  await saved(e, "the toolbar table CAS acknowledgement");
  assert.match(fs.readFileSync(e.file(), "utf8"), /<table>/);
  fs.writeFileSync(
    e.file(),
    "<!doctype html><html><body><article data-claudex-document><section data-tab=1><p>Agent latest</p></section></article></body></html>",
  );
  const editor = e.document.querySelector<HTMLElement>(
    '[aria-label="Document content"]',
  )!;
  editor.innerHTML = "<p>My unsaved draft</p>";
  await e.event(editor, "input");
  await waitFor("the real file conflict", () =>
    Boolean(e.document.querySelector('[role="alert"]')),
  );
  assert.match(
    e.document.querySelector('[role="alert"]')!.textContent!,
    /saved file changed/,
  );
  assert.match(editor.textContent!, /My unsaved draft/);
  assert.match(fs.readFileSync(e.file(), "utf8"), /Agent latest/);
  const reload = [...e.document.querySelectorAll("button")].find(
    (button) => button.textContent === "Reload saved version",
  )!;
  await e.event(reload, "click");
  assert.match(
    e.document.querySelector('[aria-label="Document content"]')!.textContent!,
    /Agent latest/,
  );
});
test("Slides Add slide and text edit persist in the same paired source instead of generating a pretend response", async (t) => {
  const e = await mounted(t, "slides");
  assert.match(e.document.body.textContent!, /no slides yet/);
  const add = [...e.document.querySelectorAll("button")].find(
    (button) => button.textContent === "Add slide",
  )!;
  await e.event(add, "click");
  assert.ok(e.document.querySelector('[aria-label="Slide content"]'));
  await e.click('[aria-label="Text"]');
  await saved(e, "the slide/text CAS acknowledgement");
  assert.match(fs.readFileSync(e.file(), "utf8"), /data-slide="1"/);
  assert.match(fs.readFileSync(e.file(), "utf8"), />Text</);
  assert.equal(e.store.conversations[0].turns.length, 0);
  await e.render("reopened");
  await saved(e, "the reopened editor read");
  assert.equal(
    e.document.querySelectorAll(".blank-slides-workspace nav button").length,
    2,
  );
});
test("Design artboards and elements are genuine saved SVG, and Dashboard exposes only page/source with its observed empty state", async (t) => {
  const e = await mounted(t, "design");
  const add = [...e.document.querySelectorAll("button")].find(
    (button) => button.textContent === "Add an artboard",
  )!;
  await e.event(add, "click");
  await e.click('[aria-label="Rectangle"]');
  await saved(e, "the SVG artboard/rectangle CAS acknowledgement");
  const svg = fs.readFileSync(e.file(), "utf8");
  assert.match(svg, /data-artboard="1"/);
  assert.match(svg, /fill="#c96442"/);
  assert.equal(e.store.conversations[0].turns.length, 0);
});
test("Dashboard page/source radios preserve the real initial file and do not invent content", async (t) => {
  const e = await mounted(t, "dashboard");
  assert.match(e.document.body.textContent!, /Nothing on this dashboard yet/);
  assert.equal(e.document.querySelectorAll('[role="radio"]').length, 2);
  await e.click('[aria-label="See where numbers come from"]');
  assert.equal(
    e.document.querySelector("pre")!.textContent,
    fs.readFileSync(e.file(), "utf8"),
  );
  assert.equal(e.store.conversations[0].turns.length, 0);
});
test("real account/bridge replacement hides the previous content immediately and retires its late read", async (t) => {
  const e = await mounted(t);
  let resolve!: (value: any) => void;
  const delayed = new Promise<any>((done) => (resolve = done));
  const old = e.window.desktop;
  e.window.desktop = { ...old, readBlankArtifact: () => delayed };
  await e.render("delayed");
  assert.equal(
    e.document.querySelector('[aria-label="Document content"]'),
    null,
  );
  e.window.desktop = {
    ...old,
    readBlankArtifact: async () => ({
      ...e.pair.document,
      content:
        '<html><body><article data-claudex-document><section data-tab="1"><p>Account B</p></section></article></body></html>',
    }),
  };
  e.setApp({ ...e.getApp(), accountId: "b", controllerScope: {} });
  await e.render("delayed");
  assert.match(e.document.body.textContent!, /Account B/);
  await act(async () =>
    resolve({ ...e.pair.document, content: "private old A" }),
  );
  assert.doesNotMatch(e.document.body.textContent!, /private old A/);
  assert.match(e.document.body.textContent!, /Account B/);
});
test("navigation event defers until a real save, with no duplicate transition under StrictMode", async (t) => {
  const e = await mounted(t),
    editor = e.document.querySelector<HTMLElement>(
      '[aria-label="Document content"]',
    )!;
  const held = holdSaves(e);
  t.after(held.drain);
  editor.innerHTML = "<p>Save before navigation</p>";
  await e.event(editor, "input");
  let moved = 0;
  const event = new e.window.CustomEvent(fileTransitionEvent, {
    cancelable: true,
    detail: { scope: "session", resume: () => moved++ },
  });
  await act(async () => {
    e.window.dispatchEvent(event);
  });
  assert.equal(event.defaultPrevented, true);
  assert.equal(moved, 0);
  await waitFor("the blocked navigation save", () => held.started() === 1);
  assert.equal(moved, 0);
  held.release();
  await waitFor("the saved navigation event", () => moved === 1);
  assert.equal(moved, 1);
  assert.match(fs.readFileSync(e.file(), "utf8"), /Save before navigation/);
});
test("blank artifacts are discoverable before any messages and host HTML never executes scripts/event handlers", async (t) => {
  const e = await mounted(t);
  const listed = collectArtifacts(e.store.conversations, [], {
    version: 1,
    copies: [],
    pinned: [],
  });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].blankArtifact?.id, e.pair.document.artifact.id);
  assert.equal(listed[0].content, "");
  assert.equal(listed[0].sourcePath, undefined);
  const safe = editorMarkup(
    '<p onclick="bad()">Text</p><script>bad()</script><iframe src="https://bad.invalid"></iframe><svg><animate attributeName="href" values="javascript:bad()"/></svg><img src="javascript:bad()">',
  );
  assert.doesNotMatch(safe, /onclick|script|iframe|animate|javascript/);
  assert.match(safe, />Text</);
});
test("actual blank creation opens the real paired Chat or full-page artifact, and delayed navigation cannot hijack the next page", async (t) => {
  const e = await mounted(t);
  const receipt = e.pair;
  let resolve!: (value: CreatedBlankArtifact) => void;
  const pending = new Promise<CreatedBlankArtifact>((done) => (resolve = done));
  e.window.desktop = {
    ...e.window.desktop,
    createBlankArtifact: () => pending,
  };
  const calls: string[] = [];
  const current = { current: undefined as AppController | undefined };
  let app = {
    accountId: "a",
    controllerScope: {},
    currentController: current,
    page: "chat",
    mode: "chat",
    draftSession: "draft",
    text: "",
    providerId: "default",
    model: "model",
    upsert: () => calls.push("upsert"),
    setActiveId: () => calls.push("active"),
    setMode: () => calls.push("mode"),
    setArtifact: () => calls.push("artifact"),
    setArtifactRouteId: () => calls.push("route"),
    setPage: () => calls.push("page"),
    openConversation: () => calls.push("chat"),
    report: (error: unknown) => {
      throw error;
    },
  } as unknown as AppController;
  current.current = app;
  const request = createBlankArtifact(app, "docs");
  current.current = { ...app, page: "projects" };
  retireBlankArtifactCreates();
  current.current = app;
  await act(async () => resolve(receipt));
  await request;
  assert.deepEqual(calls, []);
  e.window.desktop = {
    ...e.window.desktop,
    createBlankArtifact: async () => receipt,
  };
  await createBlankArtifact(app, "docs");
  assert.deepEqual(calls, [
    "upsert",
    "active",
    "mode",
    "artifact",
    "route",
    "page",
  ]);
  calls.length = 0;
  app = {
    ...app,
    active: receipt.conversation,
    activeId: receipt.conversation.id,
  };
  current.current = app;
  await createBlankArtifact(app, "docs");
  assert.deepEqual(calls, ["upsert", "chat", "artifact"]);
});

test("blank gallery Duplicate and Download read current bytes instead of the descriptor's empty snapshot content", async (t) => {
  const e = await mounted(t);
  fs.writeFileSync(e.file(), "<h1>Actual latest backing file</h1>");
  const { ArtifactLibrary } =
    await import("../../electron/artifacts/artifact-library");
  const library = new ArtifactLibrary(e.root);
  let downloaded = "";
  e.window.desktop = {
    ...e.window.desktop,
    duplicateArtifact: async (input) => library.duplicate(input),
    saveArtifact: async (filename, content) => {
      downloaded = content;
      return filename;
    },
  };
  const { downloadArtifact } =
    await import("../../src/artifacts/artifact-actions");
  assert.equal(
    await downloadArtifact(e.artifact, "document.html"),
    "document.html",
  );
  assert.equal(downloaded, "<h1>Actual latest backing file</h1>");
  const { duplicateArtifact } =
    await import("../../src/artifacts/library-actions");
  let opened: any;
  const app = {
    ...e.getApp(),
    setSnapshot: () => {},
    setArtifact: (value: any) => {
      opened = value;
    },
    setArtifactWidth: () => {},
    setPage: () => {},
  } as AppController;
  await duplicateArtifact(app, e.artifact);
  assert.equal(opened.content, "<h1>Actual latest backing file</h1>");
  assert.equal(opened.blankArtifact, undefined);
  assert.equal(
    new ArtifactLibrary(e.root).list().copies[0].content,
    "<h1>Actual latest backing file</h1>",
  );
});
test("a late blank download/duplicate after account replacement produces no output or mutation in the new account", async (t) => {
  const e = await mounted(t);
  let resolve!: (value: any) => void;
  const pending = new Promise<any>((done) => (resolve = done));
  let downloads = 0,
    duplicates = 0,
    mutations = 0;
  e.window.desktop = {
    ...e.window.desktop,
    readBlankArtifact: () => pending,
    saveArtifact: async () => {
      downloads++;
      return "file";
    },
    duplicateArtifact: async () => {
      duplicates++;
      throw new Error("must not call");
    },
  };
  const { downloadArtifact } =
      await import("../../src/artifacts/artifact-actions"),
    { duplicateArtifact } = await import("../../src/artifacts/library-actions");
  let current = true;
  const ref = { current: undefined as AppController | undefined };
  const app = {
    ...e.getApp(),
    currentController: ref,
    setSnapshot: () => {
      mutations++;
    },
  } as AppController;
  ref.current = app;
  const download = downloadArtifact(e.artifact, "document.html", () => current),
    duplicate = duplicateArtifact(app, e.artifact);
  current = false;
  ref.current = { ...app, accountId: "b", controllerScope: {} };
  resolve(e.pair.document);
  assert.equal(await download, null);
  await duplicate;
  assert.equal(downloads, 0);
  assert.equal(duplicates, 0);
  assert.equal(mutations, 0);
});

test("before-send flush waits for the real latest file save and conflicts cannot send stale document contents", async (t) => {
  const e = await mounted(t),
    editor = e.document.querySelector<HTMLElement>(
      '[aria-label="Document content"]',
    )!;
  e.setApp({
    ...e.getApp(),
    active: e.store.conversations[0],
    activeId: e.pair.conversation.id,
  });
  await e.render();
  await saved(e, "the active before-send editor read");
  const held = holdSaves(e);
  t.after(held.drain);
  assert.equal(editor.isConnected, true);
  assert.equal(editor.getAttribute("contenteditable"), "true");
  editor.innerHTML = "<h1>Must be saved before the model reads</h1>";
  await e.event(editor, "input");
  const { flushBlankArtifactDrafts } =
    await import("../../src/artifacts/blank-artifact-flush");
  let flushed = false;
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = flushBlankArtifactDrafts(e.getApp());
    void pending.then(() => {
      flushed = true;
    });
  });
  assert.equal(flushed, false);
  await waitFor("the held before-send save", () => held.started() === 1);
  assert.equal(flushed, false);
  held.write();
  await waitFor(
    "the before-send file persistence",
    () => held.persisted() === 1,
  );
  assert.equal(flushed, false, "file bytes alone do not acknowledge the flush");
  assert.match(fs.readFileSync(e.file(), "utf8"), /Must be saved before/);
  held.acknowledge();
  assert.equal(
    await completion("the successful before-send flush", pending),
    true,
  );
  assert.match(fs.readFileSync(e.file(), "utf8"), /Must be saved before/);
  fs.writeFileSync(e.file(), "<p>Agent external edit</p>");
  editor.innerHTML = "<p>Unsaved competing draft</p>";
  await e.event(editor, "input");
  await act(async () => {
    pending = flushBlankArtifactDrafts(e.getApp());
  });
  assert.equal(
    await completion("the conflicting before-send flush", pending),
    false,
  );
  assert.match(fs.readFileSync(e.file(), "utf8"), /Agent external edit/);
  assert.match(editor.textContent!, /Unsaved competing draft/);
});
test("retiring a mounted pending save resolves its send lease false and cannot wait forever or resume in another account", async (t) => {
  const e = await mounted(t);
  e.setApp({
    ...e.getApp(),
    active: e.store.conversations[0],
    activeId: e.pair.conversation.id,
  });
  await e.render();
  const held = holdSaves(e);
  t.after(held.drain);
  const editor = e.document.querySelector<HTMLElement>(
    '[aria-label="Document content"]',
  )!;
  editor.innerHTML = "<p>Old account draft</p>";
  await e.event(editor, "input");
  const { flushBlankArtifactDrafts } =
    await import("../../src/artifacts/blank-artifact-flush");
  let pending!: Promise<boolean>;
  await act(async () => {
    pending = flushBlankArtifactDrafts(e.getApp());
  });
  await waitFor(
    "the actually pending save before account retirement",
    () => held.started() === 1,
  );
  e.setApp({ ...e.getApp(), accountId: "b", controllerScope: {} });
  await e.render();
  assert.equal(await completion("the retired pending flush", pending), false);
  await held.drain();
});

function sendingApp(
  e: Awaited<ReturnType<typeof mounted>>,
  attachments: any[] = [],
) {
  const ref = { current: undefined as AppController | undefined };
  const app = {
    ...e.getApp(),
    currentController: ref,
    mode: "chat",
    page: "chat",
    draftSession: "blank-draft",
    active: e.store.conversations[0],
    activeId: e.pair.conversation.id,
    text: "Revise this document",
    attachments,
    model: "model",
    providerId: "default",
    incognitoShown: false,
    sending: false,
    running: false,
    policy: { webSearch: false },
    snapshot: {
      settings: e.store.settings,
      conversations: e.store.conversations,
    },
    latest: { current: { conversations: e.store.conversations } },
    selectNext: { current: false },
    follow: { current: false },
    composer: { current: { focus() {}, blur() {} } },
    navigation: { replaceNext() {} },
    setError() {},
    setText(value: any) {
      app.text = typeof value === "function" ? value(app.text) : value;
    },
    setAttachments(value: any) {
      app.attachments =
        typeof value === "function" ? value(app.attachments) : value;
    },
    setSending(value: any) {
      app.sending = value;
    },
    upsert() {},
    setActiveId() {},
    setPage() {},
  } as unknown as AppController;
  ref.current = app;
  e.setApp(app);
  return { app, ref };
}
for (const failed of [false, true])
  test(`before-send lease waits for the mounted editor reread${failed ? " and refuses a failed read" : " and captures its revision"}`, async (t) => {
    const e = await mounted(t),
      { app } = sendingApp(e),
      bridge = e.window.desktop,
      read = deferred<void>();
    t.after(() => read.resolve());
    e.window.desktop = {
      ...bridge,
      readBlankArtifact: async (input) => {
        await read.promise;
        if (failed) throw new Error("Read unavailable");
        return bridge.readBlankArtifact(input);
      },
    };
    await e.render();
    assert.equal(
      e.document.querySelector('[aria-label="Document content"]'),
      null,
    );
    assert.match(e.document.body.textContent!, /Loading artifact/);
    const { prepareBlankArtifactSend } =
      await import("../../src/artifacts/blank-artifact-flush");
    let settled = false;
    let pending!: ReturnType<typeof prepareBlankArtifactSend>;
    await act(async () => {
      pending = prepareBlankArtifactSend(app);
      void pending.then(() => {
        settled = true;
      });
    });
    assert.equal(settled, false, "loading is not a saved editor revision");
    await act(async () => read.resolve());
    const lease = await completion("the mounted editor reread lease", pending);
    try {
      assert.equal(lease.saved, !failed);
      if (failed) {
        assert.equal(lease.expected, undefined);
        assert.match(
          e.document.querySelector('[role="alert"]')!.textContent!,
          /Read unavailable/,
        );
      } else {
        assert.equal(lease.expected?.artifactId, e.pair.document.artifact.id);
        assert.equal(lease.expected?.revision, e.pair.document.revision);
        assert.equal(
          e.document
            .querySelector('[aria-label="Document content"]')!
            .getAttribute("contenteditable"),
          "false",
        );
      }
    } finally {
      await act(async () => lease.release());
    }
  });

test("the real sendDraft waits for an immediate edit, holds its read-only lease, and the real Engine turn sees those exact latest bytes", async (t) => {
  const e = await mounted(t),
    { app } = sendingApp(e);
  await e.render();
  const { Engine } = await import("../../electron/engine/engine"),
    { openPolicy } = await import("../../shared/client-policy"),
    { sendDraft } = await import("../../src/app/composer-send");
  const calls: any[] = [];
  const engine = new Engine(
    e.store,
    "unused",
    () => "",
    () => {},
  );
  engine.policy = () => openPolicy;
  engine.ensure = async () => {};
  engine.rpc = {
    call: async (method: string, params: any) => {
      if (method === "turn/start")
        calls.push({ params, bytes: fs.readFileSync(e.file(), "utf8") });
      if (method === "thread/start")
        return { thread: { id: "editor-paired-thread" } };
      if (method === "turn/start")
        return { turn: { id: "editor-paired-turn" } };
      return {};
    },
  } as never;
  let payload: any;
  const bridge = e.window.desktop,
    read = deferred<void>();
  let reading = false;
  e.window.desktop = {
    ...bridge,
    readBlankArtifact: async (input) => {
      reading = true;
      await read.promise;
      return bridge.readBlankArtifact(input);
    },
    send: async (input) => {
      payload = input;
      assert.equal(
        e.document
          .querySelector('[aria-label="Document content"]')!
          .getAttribute("contenteditable"),
        "false",
      );
      return engine.send(input);
    },
  };
  await e.render();
  // Replacing the bridge retires the previous read scope. Hold that actual read
  // to exercise a slow host without relying on elapsed time or stale DOM nodes.
  assert.equal(reading, true);
  assert.equal(
    e.document.querySelector('[aria-label="Document content"]'),
    null,
  );
  await act(async () => read.resolve());
  await saved(e, "the send bridge's actual editor read");
  const held = holdSaves(e);
  t.after(held.drain);
  const editor = e.document.querySelector<HTMLElement>(
    '[aria-label="Document content"]',
  )!;
  assert.equal(editor.isConnected, true);
  assert.equal(editor.getAttribute("contenteditable"), "true");
  editor.innerHTML = "<h1>Latest editor text for the model</h1>";
  await e.event(editor, "input");
  let request!: Promise<void>;
  await act(async () => {
    request = sendDraft(app);
  });
  assert.equal(calls.length, 0);
  await waitFor("the real Engine pre-send save", () => held.started() === 1);
  assert.equal(
    e.document
      .querySelector('[aria-label="Document content"]')!
      .getAttribute("contenteditable"),
    "false",
  );
  held.write();
  await waitFor(
    "the Engine draft file persistence",
    () => held.persisted() === 1,
  );
  assert.equal(
    calls.length,
    0,
    "Engine cannot read before the real save acknowledgement",
  );
  assert.match(
    fs.readFileSync(e.file(), "utf8"),
    /Latest editor text for the model/,
  );
  held.acknowledge();
  await completion("the real Engine send", request);
  assert.match(calls[0].bytes, /Latest editor text for the model/);
  assert.equal(
    payload.blankArtifactRevision.artifactId,
    e.pair.document.artifact.id,
  );
  assert.match(payload.blankArtifactRevision.revision, /^[a-f0-9]{64}$/);
  assert.equal(app.text, "");
  assert.equal(calls.length, 1);
  e.store.flush();
});
for (const outcome of [
  "conflict",
  "failure",
  "navigation",
  "account",
  "bridge",
] as const)
  test(`blank send ${outcome} during flush keeps the real body/attachments and cannot send stale contents`, async (t) => {
    const e = await mounted(t),
      files = [{ id: "file-1", name: "note.txt", kind: "text" }],
      { app, ref } = sendingApp(e, files);
    await e.render();
    const { sendDraft } = await import("../../src/app/composer-send");
    let sends = 0,
      saves = 0,
      release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const original = e.window.desktop;
    e.window.desktop = {
      ...original,
      send: async () => {
        sends++;
        throw new Error("must not send");
      },
      saveBlankArtifact: async (input) => {
        saves++;
        await gate;
        if (outcome === "failure") throw new Error("disk unavailable");
        if (outcome === "conflict")
          return { status: "conflict", currentRevision: "b".repeat(64) };
        return original.saveBlankArtifact(input);
      },
    };
    await e.render();
    await saved(e, `the ${outcome} bridge's actual editor read`);
    const editor = e.document.querySelector<HTMLElement>(
      '[aria-label="Document content"]',
    )!;
    editor.innerHTML = "<p>Unsaved latest draft</p>";
    await e.event(editor, "input");
    let request!: Promise<void>;
    await act(async () => {
      request = sendDraft(app);
    });
    await waitFor("the held blank save", () => saves === 1);
    if (outcome === "navigation") {
      ref.current = { ...app, page: "projects" };
      retireBlankArtifactCreates();
      ref.current = app;
    }
    if (outcome === "account")
      ref.current = {
        ...app,
        accountId: "b",
        controllerScope: {},
        text: "B stays",
        attachments: [],
      };
    if (outcome === "bridge") e.window.desktop = { ...e.window.desktop };
    release();
    await completion(`the ${outcome} send cancellation`, request);
    assert.equal(sends, 0);
    assert.equal(app.text, "Revise this document");
    assert.deepEqual(app.attachments, files);
    if (outcome === "account") assert.equal(ref.current?.text, "B stays");
  });

test("a flushed blank draft stays locked through a real model-catalog wait; navigation retires it permanently before send", async (t) => {
  const e = await mounted(t),
    { app, ref } = sendingApp(e);
  app.model = "";
  app.remoteAccount = true;
  app.setSnapshot = () => {};
  app.setProviderId = () => {};
  app.setModel = () => {};
  await e.render();
  let release!: (value: any) => void;
  const catalog = new Promise<any>((done) => (release = done));
  let reads = 0,
    sends = 0;
  e.window.desktop = {
    ...e.window.desktop,
    refreshModels: async () => {
      reads++;
      return catalog;
    },
    send: async () => {
      sends++;
      throw new Error("must not send");
    },
  };
  await e.render();
  await saved(e, "the model-catalog bridge's actual editor read");
  const { sendDraft } = await import("../../src/app/composer-send");
  let request!: Promise<void>;
  await act(async () => {
    request = sendDraft(app);
  });
  await waitFor("the actual model-catalog request", () => reads === 1);
  assert.equal(reads, 1);
  assert.equal(
    e.document
      .querySelector('[aria-label="Document content"]')!
      .getAttribute("contenteditable"),
    "false",
  );
  ref.current = { ...app, page: "projects" };
  retireBlankArtifactCreates();
  ref.current = app;
  await act(async () => release({ settings: e.store.settings }));
  await completion("the retired model-catalog send", request);
  assert.equal(sends, 0);
  assert.equal(app.text, "Revise this document");
  assert.deepEqual(app.attachments, []);
  assert.equal(
    e.document
      .querySelector('[aria-label="Document content"]')!
      .getAttribute("contenteditable"),
    "true",
  );
});
test("creating another real blank template waits for an existing dirty paired artifact before replacing its pane", async (t) => {
  const e = await mounted(t),
    editor = e.document.querySelector<HTMLElement>(
      '[aria-label="Document content"]',
    )!;
  editor.innerHTML = "<p>Keep this before another template</p>";
  await e.event(editor, "input");
  let creates = 0;
  const bridge = e.window.desktop;
  e.window.desktop = {
    ...bridge,
    createBlankArtifact: async (input) => {
      creates++;
      assert.match(fs.readFileSync(e.file(), "utf8"), /Keep this before/);
      return bridge.createBlankArtifact(input);
    },
  };
  const app = {
    ...e.getApp(),
    page: "chat",
    mode: "chat",
    active: e.store.conversations[0],
    activeId: e.pair.conversation.id,
    draftSession: "current",
    text: "",
    providerId: "default",
    model: "model",
    upsert() {},
    openConversation() {},
    setArtifact() {},
    setMode() {},
    setArtifactRouteId() {},
    setPage() {},
  } as AppController;
  e.setApp(app);
  await e.render();
  const held = holdSaves(e);
  t.after(held.drain);
  // The bridge read has retained the saved document; seed the real current editor again.
  const active = e.document.querySelector<HTMLElement>(
    '[aria-label="Document content"]',
  )!;
  active.innerHTML = "<p>Keep this before another template</p>";
  await e.event(active, "input");
  await act(async () => {
    await createBlankArtifact(app, "slides");
  });
  assert.equal(creates, 0);
  await waitFor("the blocked prior-template save", () => held.started() === 1);
  assert.equal(creates, 0);
  held.release();
  await waitFor("the saved template transition", () => creates === 1);
  assert.equal(creates, 1);
  assert.match(fs.readFileSync(e.file(), "utf8"), /Keep this before/);
});

test("standalone editor Home keeps the actual user identity and waits for latest file persistence before navigating", async (t) => {
  const e = await mounted(t),
    calls: string[] = [];
  e.setApp({
    ...e.getApp(),
    snapshot: { ...e.getApp().snapshot, settings: { name: "Actual reader" } },
    newChat: (mode: string) => calls.push(mode),
  } as unknown as AppController);
  await e.render();
  assert.equal(
    e.document.querySelector('[aria-label="You"]')?.getAttribute("title"),
    "Actual reader",
  );
  assert.equal(
    e.document.querySelector('a[aria-label="Home"]')?.getAttribute("href"),
    "/new",
  );
  const held = holdSaves(e);
  t.after(held.drain);
  const editor = e.document.querySelector<HTMLElement>(
    '[aria-label="Document content"]',
  )!;
  editor.innerHTML = "<p>Latest bytes before Home</p>";
  await e.event(editor, "input");
  await e.event(e.document.querySelector('a[aria-label="Home"]')!, "click");
  await waitFor(
    "Home's actual pre-navigation save",
    () => held.started() === 1,
  );
  assert.equal(calls.length, 0);
  held.release();
  await waitFor(
    "Home after its save acknowledgement",
    () => calls.length === 1,
  );
  assert.deepEqual(calls, ["chat"]);
  assert.match(fs.readFileSync(e.file(), "utf8"), /Latest bytes before Home/);
});
