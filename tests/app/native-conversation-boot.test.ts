import {
  originPairedArtifact,
  resolvePairedArtifact,
} from "../../src/artifacts/paired-artifact";
import type { AppController } from "../../src/app/AppContext";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  act,
  createElement,
  StrictMode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { parseHTML } from "linkedom";
import ts from "typescript";
import { transform } from "sucrase";
import { codeEntryConversation, parseDeepLink } from "../../shared/deep-links";
import { windowRole } from "../../src/conversation-window/window-role";
import type { Conversation, Mode } from "../../shared/types";
import { readSource } from "../support/read-source";

// Execute the actual App callback bodies in a small cold-boot React harness.
// Hook-phase assertions are separate: a DOM fixture has no browser paint
// clock, so this suite does not substitute for the native rAF sampler.
const source = readSource("src/app/App.tsx");
const ast = ts.createSourceFile(
  "App.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function find<T extends ts.Node>(predicate: (node: ts.Node) => node is T): T {
  const found: T[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(found.length, 1);
  return found[0];
}
function bootEffect(marker: string) {
  return find(
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ["useEffect", "useLayoutEffect"].includes(node.expression.getText(ast)) &&
      Boolean(node.arguments[0]?.getText(ast).includes(marker)),
  );
}
const lockedEffect = bootEffect("lockedOpened.current");
const linkEffect = bootEffect("bootLinkDone.current");
const openFunction = find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "openConversation",
);
const linkAssignment = find(
  (node): node is ts.BinaryExpression =>
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    node.left.getText(ast) === "runDeepLink.current",
);
function execute<T>(node: ts.Node, values: Record<string, unknown>): T {
  const code = transform(`return (${node.getText(ast)});`, {
    transforms: ["typescript", "jsx"],
    production: true,
  }).code;
  return new Function(...Object.keys(values), code)(...Object.values(values));
}
const record = (
  id: string,
  mode: Mode,
  patch: Partial<Conversation> = {},
): Conversation => ({
  id,
  title: `Stored ${mode}`,
  mode,
  providerId: "synthetic",
  model: "Sonnet",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns: [],
  ...patch,
});

async function environment(search: string, surface = "desktop") {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  const location = { pathname: "/index.html", search, hash: "#kept" };
  const replacements: string[] = [];
  const opens: string[] = [],
    notifications: string[] = [],
    fields: string[] = [];
  let handoffReads = 0;
  let handoff: ((value: { text: string } | null) => void) | undefined;
  const handoffPromise = new Promise<{ text: string } | null>((resolve) => {
    handoff = resolve;
  });
  const api = {
    takeWindowHandoff: () => {
      handoffReads++;
      return handoffPromise;
    },
    forwardToMainWindow: async () => {},
  };
  const fakeWindow = {
    location,
    history: {
      state: { preserved: true },
      replaceState: (_state: unknown, _title: string, value: string) => {
        replacements.push(value);
        location.search = new URL(value, "http://fixture.test").search;
      },
    },
  };
  const globals = {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
    matchMedia: () => ({ matches: true }),
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
  type Data = { conversations: Conversation[]; projects: []; approvals: [] };
  function Harness({ snapshot }: { snapshot?: Data }) {
    const [activeId, setActiveId] = useState<string>();
    const [mode, setMode] = useState<Mode>("code");
    const [text, setText] = useState("");
    const lockedOpened = useRef(false),
      bootLinkDone = useRef(false),
      follow = useRef(false),
      selectNext = useRef(true);
    const stateRef = useRef(snapshot);
    stateRef.current = snapshot;
    const runDeepLink = useRef<(link: unknown) => void>(() => {});
    const role = windowRole(search);
    const conversationWindow = role.kind === "conversation";
    const locked =
      role.kind === "conversation"
        ? snapshot?.conversations.find(
            (c) => c.id === role.conversationId && !c.incognito,
          )
        : undefined;
    const controllerScope = useRef({}).current;
    const currentController = useRef<AppController | undefined>(undefined);
    currentController.current = {
      accountId: "native-boot",
      controllerScope,
      page: "chat",
      activeId,
      mode,
      snapshot: snapshot ?? { conversations: [] },
    } as unknown as AppController;
    const noop = () => {};
    const openConversation = execute<(c: Conversation) => void>(openFunction, {
      role,
      api,
      currentController,
      accountId: "native-boot",
      controllerScope,
      conversationOpeningBridge: window.desktop,
      page: "chat",
      activeId,
      mode,
      originPairedArtifact,
      resolvePairedArtifact,
      deferFileTransition: () => false,
      setIncognito: noop,
      setActiveId: (id: string) => {
        assert.equal(
          selectNext.current,
          false,
          "opening an existing chat cancels a pending new-chat auto-selection",
        );
        opens.push(id);
        setActiveId(id);
      },
      setPage: noop,
      setMode,
      setProviderId: noop,
      setModel: noop,
      setEffort: noop,
      setProjectId: noop,
      setCwd: noop,
      setText,
      setAttachments: noop,
      setSearch: noop,
      setArtifact: noop,
      setPanel: noop,
      follow,
      selectNext,
      composer: { current: null },
      report: (error: unknown) => {
        throw error;
      },
    });
    runDeepLink.current = execute(linkAssignment.right, {
      conversationWindow,
      stateRef,
      codeEntryConversation,
      openConversation,
      deferFileTransition: () => false,
      notify: (message: string) => notifications.push(message),
      t: (value: string) => value,
      mode,
      setMode,
      newChat: (value: Mode) => setMode(value),
      requestProject: noop,
      setPage: noop,
      setCwd: noop,
      setText,
      report: (error: unknown) => {
        throw error;
      },
    });
    execute(lockedEffect, {
      useEffect,
      useLayoutEffect,
      locked,
      lockedOpened,
      openConversation,
      api,
      setText: (value: string) => {
        fields.push(value);
        setText(value);
      },
      setAttachments: noop,
      setProviderId: noop,
      setModel: noop,
      report: (error: unknown) => {
        throw error;
      },
    });
    execute(linkEffect, {
      useEffect,
      useLayoutEffect,
      snapshot,
      bootLinkDone,
      buildSurface: surface,
      window: fakeWindow,
      URLSearchParams,
      parseDeepLink,
      runDeepLink,
    });
    return snapshot
      ? createElement(
          "div",
          {
            className: `app mode-${mode === "code" ? "code" : "chat"}`,
            "data-execution-mode": mode,
            "data-conversation-id": activeId,
          },
          text,
        )
      : createElement(
          "div",
          { className: "boot" },
          "Preparing your workspace…",
        );
  }
  return {
    document,
    opens,
    notifications,
    replacements,
    fields,
    handoffReads: () => handoffReads,
    async render(conversations?: Conversation[], strict = false) {
      const node = createElement(Harness, {
        snapshot: conversations
          ? { conversations, projects: [], approvals: [] }
          : undefined,
      });
      await act(async () =>
        root.render(strict ? createElement(StrictMode, {}, node) : node),
      );
    },
    async handoff(text: string) {
      await act(async () => handoff?.({ text }));
    },
    async clean() {
      await act(async () => root.unmount());
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("native boot target effects run in the layout phase without changing the default mode", () => {
  assert.equal(lockedEffect.expression.getText(ast), "useLayoutEffect");
  assert.equal(linkEffect.expression.getText(ast), "useLayoutEffect");
  assert.match(
    source,
    /const \[mode, setMode\] = useState<Mode>\([\s\S]*?: "code",\s*\)/,
  );
  const opening = openFunction.getText(ast);
  assert.ok(opening.includes("setActiveId(c.id)"));
  assert.ok(opening.includes("setMode(c.mode)"));
  assert.doesNotMatch(opening, /await |\.then\([^]*setMode/);
});

test("cold native conversation links use the real stored Chat, Cowork or Code mode after snapshot", async () => {
  for (const mode of ["chat", "cowork", "code"] as const) {
    const target = record(`arbitrary-id-for-${mode}`, mode);
    const env = await environment(
      `?profile=kept&deeplink=${encodeURIComponent(`claudex://conversation/${target.id}`)}`,
    );
    try {
      await env.render(undefined, true);
      assert.equal(env.document.querySelector(".app"), null);
      assert.ok(env.document.querySelector(".boot"));
      await env.render([target], true);
      const app = env.document.querySelector(".app")!;
      assert.equal(app.getAttribute("data-execution-mode"), mode);
      assert.equal(app.getAttribute("data-conversation-id"), target.id);
      assert.deepEqual(env.opens, [target.id]);
      assert.equal(env.replacements.length, 1);
      assert.match(env.replacements[0], /\?profile=kept#kept$/);
      await env.render([target], true);
      assert.deepEqual(env.opens, [target.id]);
    } finally {
      await env.clean();
    }
  }
});

test("locked native windows open their stored record before an asynchronous draft handoff completes", async () => {
  const target = record("chat-looking-id", "cowork");
  const env = await environment(`?window=conversation&id=${target.id}`);
  try {
    await env.render();
    assert.equal(env.document.querySelector(".app"), null);
    await env.render([target]);
    assert.equal(
      env.document.querySelector(".app")?.getAttribute("data-execution-mode"),
      "cowork",
    );
    assert.equal(
      env.document.querySelector(".app")?.getAttribute("data-conversation-id"),
      target.id,
    );
    assert.deepEqual(env.opens, [target.id]);
    assert.equal(env.handoffReads(), 1);
    assert.deepEqual(env.fields, []);
    await env.handoff("Synthetic carried draft");
    assert.equal(
      env.document.querySelector(".app")?.textContent,
      "Synthetic carried draft",
    );
    await env.render([target]);
    assert.deepEqual(env.opens, [target.id]);
    assert.equal(env.handoffReads(), 1);
  } finally {
    await env.clean();
  }
});

test("missing and private native link records do not acquire a mode guessed from their id", async () => {
  for (const records of [
    [],
    [record("chat-looking-id", "chat", { incognito: true })],
  ]) {
    const env = await environment(
      `?deeplink=${encodeURIComponent("claudex://conversation/chat-looking-id")}`,
    );
    try {
      await env.render(records);
      assert.deepEqual(env.opens, []);
      assert.equal(
        env.document.querySelector(".app")?.getAttribute("data-execution-mode"),
        "code",
      );
      assert.deepEqual(env.notifications, [
        "This conversation isn’t available.",
      ]);
    } finally {
      await env.clean();
    }
  }
});

test("the native boot-link path remains excluded from the web host", async () => {
  const target = record("synthetic-web-record", "chat");
  const env = await environment(
    `?deeplink=${encodeURIComponent(`claudex://conversation/${target.id}`)}`,
    "web",
  );
  try {
    await env.render([target]);
    assert.deepEqual(env.opens, []);
    assert.deepEqual(env.replacements, []);
  } finally {
    await env.clean();
  }
});
