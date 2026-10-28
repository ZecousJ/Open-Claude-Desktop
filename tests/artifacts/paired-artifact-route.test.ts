import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  act,
  createElement as h,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  StrictMode,
} from "react";
import ts from "typescript";
import { Store } from "../../electron/store/store";
import { registerBlankArtifactHandlers } from "../../electron/ipc/blank-artifacts";
import type { AppContext as BackendContext } from "../../electron/app/app-context";
import type { CreatedBlankArtifact } from "../../shared/blank-artifacts";
import type { Snapshot, Conversation } from "../../shared/types";
import { fixtureSnapshot } from "../../scripts/preview/app-fixture";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { HostContext } from "../../src/host/HostContext";
import { webHost } from "../../shared/host";
import { BlankArtifactPanel } from "../../src/artifacts/BlankArtifactPanel";
import { blankConversationArtifact } from "../../src/artifacts/blank-artifact-model";
import { artifactRouteId } from "../../src/artifacts/artifact-route-model";
import {
  resolvePairedArtifact,
  originPairedArtifact,
} from "../../src/artifacts/paired-artifact";
import {
  parseWebRoute,
  formatWebRoute,
  urlForState,
  initialWebEntry,
  routeForNavEntry,
} from "../../src/web/routes";
import { useWebRoute } from "../../src/web/useWebRoute";
import { applyRoute } from "../../src/web/web-route-apply";
import { sameEntry } from "../../src/app/navigation-history";
import { routineDom } from "../support/routine-dom";
import { fileTransitionEvent } from "../../src/files/file-transitions";
import { readSource } from "../support/read-source";
const read = (file: string) =>
  fs.readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");
function record(id = randomUUID(), artifactId = randomUUID()): Conversation {
  return {
    id,
    title: "Untitled document",
    mode: "chat",
    providerId: "default",
    model: "model",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
    blankArtifact: {
      id: artifactId,
      kind: "docs",
      name: "Untitled",
      file: "document.html",
      createdAt: 1,
    },
  };
}
function snapshot(rows: Conversation[]): Snapshot {
  return { ...fixtureSnapshot({ history: "empty" }), conversations: rows };
}
test("paired URLs, Settings backgrounds and navigation entries retain only their opaque owned-artifact identity", () => {
  const c = record(),
    id = artifactRouteId(blankConversationArtifact(c)!);
  const route = { kind: "chat" as const, id: c.id, artifactId: id };
  const url = `/chat/${c.id}?artifact=${id}`;
  assert.deepEqual(parseWebRoute(`/chat/${c.id}`, `?artifact=${id}`), route);
  assert.equal(formatWebRoute(route), url);
  assert.equal(
    urlForState({
      page: "chat",
      mode: "chat",
      conversationId: c.id,
      pairedArtifactId: id,
    }),
    url,
  );
  assert.equal(
    urlForState({
      page: "chat",
      mode: "code",
      conversationId: c.id,
      pairedArtifactId: id,
    }),
    `/code/${c.id}`,
  );
  assert.deepEqual(parseWebRoute(`/code/${c.id}`, `?artifact=${id}`), {
    kind: "code-chat",
    id: c.id,
  });
  const entry = initialWebEntry(route)!;
  assert.equal(entry.artifactId, id);
  assert.deepEqual(routeForNavEntry(entry), route);
  assert.equal(sameEntry(entry, { ...entry, artifactId: undefined }), false);
  const settings = {
    kind: "settings" as const,
    tab: "privacy",
    background: route,
  };
  const settingsUrl = formatWebRoute(settings)!;
  const parsed = new URL(settingsUrl, "https://claudex.example");
  assert.deepEqual(
    parseWebRoute(parsed.pathname, parsed.search, parsed.hash),
    settings,
  );
  assert.deepEqual(parseWebRoute(`/chat/${c.id}`, "?artifact=..%2Fprivate"), {
    kind: "chat",
    id: c.id,
  });
  assert.equal(
    urlForState({ page: "chat", mode: "chat", conversationId: c.id }),
    `/chat/${c.id}`,
  );
});
test("metadata resolution refuses unknown, foreign-conversation, incognito, Code and ambiguous IDs before any file read", () => {
  const a = record(),
    b = record(),
    own = artifactRouteId(blankConversationArtifact(a)!),
    data = snapshot([a, b]);
  assert.equal(
    resolvePairedArtifact(data, a.id, own)?.blankArtifact?.id,
    a.blankArtifact!.id,
  );
  assert.equal(originPairedArtifact(data, a.id)?.id, a.blankArtifact!.id);
  assert.equal(resolvePairedArtifact(data, b.id, own), undefined);
  assert.equal(resolvePairedArtifact(data, a.id, randomUUID()), undefined);
  assert.equal(resolvePairedArtifact(snapshot([b]), a.id, own), undefined);
  assert.equal(originPairedArtifact(snapshot([b]), a.id), undefined);
  assert.equal(
    resolvePairedArtifact(snapshot([{ ...a, incognito: true }]), a.id, own),
    undefined,
  );
  assert.equal(
    originPairedArtifact(snapshot([{ ...a, incognito: true }]), a.id),
    undefined,
  );
  assert.equal(
    resolvePairedArtifact(snapshot([{ ...a, mode: "code" }]), a.id, own),
    undefined,
  );
  const regular = {
    ...a,
    blankArtifact: undefined,
    turns: [
      {
        id: "t",
        prompt: "x",
        attachments: [],
        createdAt: 1,
        status: "completed" as const,
        items: [
          {
            id: "reply",
            type: "agentMessage" as const,
            text: "```html\n<h1>Actual existing artifact</h1>\n```",
          },
        ],
      },
    ],
  };
  const ordinary = resolvePairedArtifact(
    snapshot([regular]),
    regular.id,
    artifactRouteId({
      id: "reply-0",
      conversationId: regular.id,
      name: "anything",
      language: "html",
      content: "",
    }),
  );
  assert.match(ordinary?.content ?? "", /Actual existing artifact/);
  assert.equal(
    originPairedArtifact(snapshot([regular]), regular.id),
    undefined,
  );
});
function actualConversationOpener() {
  const source = ts.createSourceFile(
    "app/App.tsx",
    readSource("src/app/App.tsx"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let declaration = "";
  const walk = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "openConversation"
    )
      declaration = node.getText(source);
    ts.forEachChild(node, walk);
  };
  walk(source);
  assert.ok(declaration);
  const js = ts.transpileModule(declaration, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
  return (bindings: Record<string, unknown>) =>
    Function(
      "bindings",
      `with(bindings){${js};return openConversation;}`,
    )(bindings) as AppController["openConversation"];
}
async function environment(
  t: { after(fn: () => unknown): unknown },
  initial = "paired",
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-paired-route-"));
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
  const calls = new Map<string, (...args: any[]) => any>();
  registerBlankArtifactHandlers(
    (name, handler) => calls.set(name, handler),
    context,
  );
  const create = async () =>
    (await calls.get("createBlankArtifact")!({
      requestId: randomUUID(),
      kind: "docs",
      name: "Untitled document",
      providerId: "default",
      model: "model",
    })) as CreatedBlankArtifact;
  const a = await create(),
    b = await create();
  let reads = 0;
  const bridge = {
    readBlankArtifact: async (input: any) => {
      reads++;
      return calls.get("readBlankArtifact")!(input);
    },
    saveBlankArtifact: async (input: any) =>
      calls.get("saveBlankArtifact")!(input),
  };
  const env = await routineDom(bridge, { jsdom: true }),
    owned = artifactRouteId(blankConversationArtifact(a.conversation)!),
    other = artifactRouteId(blankConversationArtifact(b.conversation)!);
  const globals = {
    location: env.window.location,
    history: env.window.history,
    addEventListener: env.window.addEventListener.bind(env.window),
    removeEventListener: env.window.removeEventListener.bind(env.window),
    DOMParser: env.window.DOMParser,
    XMLSerializer: env.window.XMLSerializer,
    CustomEvent: env.window.CustomEvent,
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
  const address =
    initial === "paired"
      ? `/chat/${a.conversation.id}?artifact=${owned}`
      : initial === "foreign"
        ? `/chat/${b.conversation.id}?artifact=${owned}`
        : `/chat/${a.conversation.id}`;
  env.window.history.replaceState(null, "", address);
  t.after(async () => {
    await env.clean();
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const errors: unknown[] = [];
  const opener = actualConversationOpener();
  let live!: AppController;
  function Route() {
    useWebRoute();
    return null;
  }
  function Harness({
    account = "A",
    rows = store.conversations,
  }: {
    account?: string;
    rows?: Conversation[];
  }) {
    const [activeId, setActiveId] = useState<string>(),
      [page, setPage] = useState("chat"),
      [mode, setMode] = useState<"chat" | "cowork" | "code">("chat"),
      [artifact, setArtifact] =
        useState<ReturnType<typeof blankConversationArtifact>>(),
      [text, setText] = useState(""),
      [settingsOpen, setSettingsOpen] = useState(false),
      [settingsTab, setSettingsTab] = useState("general"),
      [search, setSearch] = useState<string | null>(null),
      [artifactRouteId, setArtifactRouteId] = useState<string>();
    const scope = useMemo(() => ({}), [account]);
    const currentController = useRef<AppController | undefined>(undefined);
    const data = snapshot(rows),
      active = rows.find((value) => value.id === activeId);
    const noop = () => {};
    const app = {
      accountId: account,
      controllerScope: scope,
      currentController,
      snapshot: data,
      listed: rows,
      activeId,
      active,
      page,
      mode,
      artifact,
      text,
      settingsOpen,
      settingsTab,
      search,
      artifactRouteId,
      incognitoShown: false,
      policy: { incognito: true },
      setActiveId,
      setPage,
      setMode,
      setArtifact,
      setText,
      setSettingsOpen,
      setSearch,
      setArtifactRouteId,
      openSettingsTab: (tab: string) => {
        setSettingsTab(tab);
        setSettingsOpen(true);
      },
      newChat: (next?: "chat" | "cowork" | "code") => {
        setArtifact(undefined);
        setActiveId(undefined);
        setPage("chat");
        setMode(next ?? "chat");
        setText("");
      },
      report: (error: unknown) => errors.push(error),
      notify: noop,
      artifactPresentation: { current: { opened: noop } },
      sidebarView: { open: true, toggle: noop, show: noop },
    } as unknown as AppController;
    const bindings = {
      currentController,
      accountId: account,
      controllerScope: scope,
      conversationOpeningBridge: env.window.desktop,
      page,
      activeId,
      mode,
      role: { kind: "main" },
      api: env.window.desktop,
      report: app.report,
      deferFileTransition: undefined,
      resolvePairedArtifact,
      originPairedArtifact,
      selectNext: { current: false },
      setIncognito: noop,
      setActiveId,
      setPage,
      setMode,
      setProviderId: noop,
      setModel: noop,
      setEffort: noop,
      setProjectId: noop,
      setCwd: noop,
      setText,
      setAttachments: noop,
      setSearch,
      setArtifact,
      setPanel: noop,
      follow: { current: true },
      composer: { current: null },
    };
    app.openConversation = opener(bindings);
    currentController.current = app;
    useLayoutEffect(() => {
      currentController.current = app;
      return () => {
        if (currentController.current === app)
          currentController.current = undefined;
      };
    });
    live = app;
    return h(
      AppContext.Provider,
      { value: app },
      h(
        HostContext.Provider,
        { value: webHost },
        h(Route),
        h(
          "button",
          {
            "data-sidebar-origin": true,
            onClick: () => app.openConversation(rows[0]),
          },
          "Open origin",
        ),
        h("textarea", {
          "data-body": true,
          value: text,
          onChange: (event: any) => setText(event.target.value),
        }),
        artifact
          ? h(BlankArtifactPanel, {
              artifact,
              fullPage: true,
              onClose: () => setArtifact(undefined),
              onError: app.report,
            })
          : null,
      ),
    );
  }
  const render = async (
    account = "A",
    rows = store.conversations,
    key = account,
  ) => env.render(h(StrictMode, {}, h(Harness, { key, account, rows })));
  await render();
  const tick = async () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  const pop = async (direction: "back" | "forward") => {
    await act(async () => env.window.history[direction]());
    await tick();
  };
  return {
    ...env,
    store,
    a,
    b,
    owned,
    other,
    errors,
    render,
    tick,
    pop,
    get live() {
      return live;
    },
    pane: () => live.artifact,
    reads: () => reads,
    address: () => env.window.location.pathname + env.window.location.search,
  };
}
test("cold paired URL restores the same real editor; close/back/forward preserve the current composer body", async (t) => {
  const e = await environment(t);
  assert.equal(e.live.activeId, e.a.conversation.id);
  assert.equal(e.pane()?.blankArtifact?.id, e.a.document.artifact.id);
  assert.ok(e.document.querySelector('[aria-label="Document content"]'));
  assert.ok(e.reads() > 0);
  await e.change("[data-body]", "Unsent composer text");
  await e.click('[aria-label="Close"]');
  assert.equal(e.address(), `/chat/${e.a.conversation.id}`);
  assert.ok(Object.is(e.pane(), undefined));
  assert.equal(e.live.text, "Unsent composer text");
  await e.pop("back");
  assert.equal(e.address(), `/chat/${e.a.conversation.id}?artifact=${e.owned}`);
  assert.equal(e.pane()?.id, e.a.document.artifact.id);
  assert.equal(e.live.text, "Unsent composer text");
  await e.pop("forward");
  assert.ok(Object.is(e.pane(), undefined));
  assert.equal(e.live.text, "Unsent composer text");
});
test("a bare refresh stays closed, while the actual App Sidebar origin opener restores its owned editor without clearing its draft", async (t) => {
  const e = await environment(t, "bare");
  assert.ok(Object.is(e.pane(), undefined));
  assert.equal(e.reads(), 0);
  await e.change("[data-body]", "Keep this draft");
  const own = e.live.snapshot.conversations.find(
    (value) => value.id === e.a.conversation.id,
  )!;
  await act(async () => e.live.openConversation(own));
  assert.equal(e.pane()?.id, e.a.document.artifact.id);
  assert.equal(e.live.text, "Keep this draft");
  assert.equal(e.address(), `/chat/${own.id}?artifact=${e.owned}`);
});
test("a foreign-conversation query is removed before any editor/file request", async (t) => {
  const e = await environment(t, "foreign");
  assert.equal(e.live.activeId, e.b.conversation.id);
  assert.ok(Object.is(e.pane(), undefined));
  assert.equal(e.reads(), 0);
  assert.equal(e.address(), `/chat/${e.b.conversation.id}`);
  assert.equal(e.errors.length, 1);
});

test("dirty Back waits for the same real file save and then closes at that exact history entry", async (t) => {
  const e = await environment(t, "bare"),
    own = e.live.snapshot.conversations.find(
      (value) => value.id === e.a.conversation.id,
    )!;
  await act(async () => e.live.openConversation(own));
  await e.change("[data-body]", "Keep composer body");
  const editor = e.document.querySelector<HTMLElement>(
    '[aria-label="Document content"]',
  )!;
  editor.innerHTML = "<p>Save before Back</p>";
  await e.event(editor, "input");
  await e.pop("back");
  assert.equal(e.pane()?.id, e.a.document.artifact.id);
  assert.equal(e.address(), `/chat/${own.id}`);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 460));
  });
  assert.ok(Object.is(e.pane(), undefined));
  assert.equal(e.live.text, "Keep composer body");
  assert.match(
    fs.readFileSync(path.join(own.cwd!, own.blankArtifact!.file), "utf8"),
    /Save before Back/,
  );
  await e.pop("forward");
  assert.equal(e.pane()?.id, e.a.document.artifact.id);
  assert.equal(e.address(), `/chat/${own.id}?artifact=${e.owned}`);
  assert.deepEqual(e.errors, []);
});
test("cancelling a dirty Back returns to the original history entry without losing its forward/back meaning", async (t) => {
  const e = await environment(t, "bare"),
    own = e.live.snapshot.conversations.find(
      (value) => value.id === e.a.conversation.id,
    )!;
  await act(async () => e.live.openConversation(own));
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done)),
    save = e.window.desktop.saveBlankArtifact;
  e.window.desktop.saveBlankArtifact = async (input) => {
    await gate;
    return save(input);
  };
  const editor = e.document.querySelector<HTMLElement>(
    '[aria-label="Document content"]',
  )!;
  editor.innerHTML = "<p>Keep editor on cancelled Back</p>";
  await e.event(editor, "input");
  await e.pop("back");
  assert.equal(e.pane()?.id, e.a.document.artifact.id);
  const cancel = [...e.document.querySelectorAll("button")].find(
    (button) => button.textContent === "Keep editing",
  )!;
  assert.ok(cancel);
  await e.event(cancel, "click");
  await e.tick();
  assert.equal(e.address(), `/chat/${own.id}?artifact=${e.owned}`);
  assert.equal(e.pane()?.id, e.a.document.artifact.id);
  release();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 460));
  });
  await e.pop("back");
  assert.ok(Object.is(e.pane(), undefined));
  assert.equal(e.address(), `/chat/${own.id}`);
  await e.pop("forward");
  assert.equal(e.pane()?.id, e.a.document.artifact.id);
  assert.deepEqual(e.errors, []);
});
test("a newer Forward route retires the earlier dirty Back callback even after its real save finishes", async (t) => {
  const e = await environment(t, "bare"),
    own = e.live.snapshot.conversations.find(
      (value) => value.id === e.a.conversation.id,
    )!;
  await act(async () => e.live.openConversation(own));
  const editor = e.document.querySelector<HTMLElement>(
    '[aria-label="Document content"]',
  )!;
  editor.innerHTML = "<p>Latest route generation</p>";
  await e.event(editor, "input");
  await e.pop("back");
  await e.pop("forward");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 460));
  });
  assert.equal(e.address(), `/chat/${own.id}?artifact=${e.owned}`);
  assert.equal(e.pane()?.id, e.a.document.artifact.id);
  assert.deepEqual(e.errors, []);
});
for (const change of ["account", "controller", "bridge", "generation"] as const)
  test(`a delayed paired route cannot commit after ${change} replacement`, async (t) => {
    const e = await environment(t, "bare"),
      app = e.live;
    let generation = 1,
      resume: (() => void) | undefined;
    const intercept = (event: Event) => {
      event.preventDefault();
      resume = (event as CustomEvent<{ resume(): void }>).detail.resume;
    };
    e.window.addEventListener(fileTransitionEvent, intercept);
    try {
      const url = applyRoute(
        app,
        { kind: "chat", id: e.a.conversation.id, artifactId: e.owned },
        {
          codeAvailable: true,
          initial: false,
          current: () => generation === 1,
        },
      );
      assert.equal(url, `/chat/${e.a.conversation.id}?artifact=${e.owned}`);
      assert.ok(resume);
      if (change === "account")
        app.currentController!.current = { ...app, accountId: "B" };
      if (change === "controller")
        app.currentController!.current = { ...app, controllerScope: {} };
      if (change === "bridge") e.window.desktop = { ...e.window.desktop };
      if (change === "generation") generation++;
      await act(async () => resume!());
      assert.ok(Object.is(e.pane(), undefined));
      assert.equal(e.reads(), 0);
    } finally {
      e.window.removeEventListener(fileTransitionEvent, intercept);
    }
  });
