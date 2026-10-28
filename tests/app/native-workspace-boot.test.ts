import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { act, createElement as h, useEffect, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { transform } from "sucrase";
import postcss from "postcss";
import { BootShell } from "../../src/boot/BootShell";
import { BootErrorPage } from "../../src/boot/BootErrorPage";
import { ChatLoadError } from "../../src/app/ChatLoadError";
import { Star } from "../../src/ui/Star";
import { fixtureSnapshot } from "../../scripts/preview/app-fixture";
import type { Snapshot } from "../../shared/types";
import { routineDom } from "../support/routine-dom";
import { readSource } from "../support/read-source";

// As native-conversation-boot.test, execute the production App return
// statements rather than duplicate their conditions. The harness stops at
// App's first full-workspace statement; actual browser frame timing, layout
// and native dragging are deliberately left to root's preview acceptance.
const source = readSource("src/app/App.tsx");
const ast = ts.createSourceFile(
  "App.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const app = ast.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === "App",
);
assert.ok(app?.body);
const statements = app.body.statements;
const start = statements.findIndex(
  (node) =>
    ts.isIfStatement(node) &&
    node.expression.getText(ast).startsWith("!snapshot") &&
    node.expression.getText(ast).includes("bootFailure") &&
    node.expression.getText(ast).includes("conversationWindow"),
);
const end = statements.findIndex(
  (node) =>
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(
      (entry) => entry.name.getText(ast) === "startProject",
    ),
);
assert.ok(start >= 0 && end > start);
const productionBoot = statements.slice(start, end);
assert.equal(productionBoot.filter(ts.isIfStatement).length, 4);
const code = transform(
  `return function AppBoot({snapshot,bootFailure,error,buildSurface,host,conversationWindow,location,api,artifactPresentation,setSnapshot,setBootFailure,setProviderId,setModel,onSignOut,report}) {
  ${productionBoot.map((node) => node.getText(ast)).join("\n")}
  return <section data-workspace-ready="true">{snapshot.settings.name}</section>;
}`,
  { transforms: ["typescript", "jsx"], production: true },
).code;
type BootProps = {
  snapshot?: Snapshot;
  bootFailure?: { error: unknown };
  error: string;
  buildSurface: "desktop" | "web";
  host: { kind: "desktop" | "web" };
  conversationWindow: boolean;
  location: { pathname: string; reload(): void };
  api: { snapshot(): Promise<Snapshot> };
  artifactPresentation: {
    current: { seed(conversations: Snapshot["conversations"]): void };
  };
  setSnapshot(snapshot: Snapshot): void;
  setBootFailure(failure: { error: unknown } | undefined): void;
  setProviderId(id: string): void;
  setModel(model: string): void;
  onSignOut?: () => Promise<void>;
  report(error: unknown): void;
};
const AppBoot = new Function(
  "React",
  "BootShell",
  "BootErrorPage",
  "ChatLoadError",
  "Suspense",
  "Star",
  code,
)(
  React,
  BootShell,
  BootErrorPage,
  ChatLoadError,
  React.Suspense,
  Star,
) as React.ComponentType<BootProps>;
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  return {
    promise: new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    }),
    resolve: (value: T) => resolve(value),
    reject: (error: unknown) => reject(error),
  };
};

async function bootEnvironment(
  surface: "desktop" | "web" = "desktop",
  options: {
    conversationWindow?: boolean;
    error?: string;
  } = {},
) {
  const env = await routineDom();
  const first = deferred<Snapshot>();
  const ready = fixtureSnapshot();
  const calls = {
    reload: 0,
    logout: 0,
    seeds: 0,
    provider: "",
    model: "",
    errors: [] as unknown[],
  };
  const location = { pathname: "/new", reload: () => calls.reload++ };
  const intervals = new Set<() => void>();
  const globals = {
    navigator: {
      platform: "MacIntel",
      userAgent: "native-workspace-boot",
      onLine: true,
    },
    location,
    addEventListener: env.window.addEventListener.bind(env.window),
    removeEventListener: env.window.removeEventListener.bind(env.window),
    setInterval: (callback: () => void) => {
      intervals.add(callback);
      return callback;
    },
    clearInterval: (callback: () => void) => intervals.delete(callback),
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
  function Harness() {
    const [snapshot, setSnapshot] = useState<Snapshot>();
    const [bootFailure, setBootFailure] = useState<{ error: unknown }>();
    useEffect(() => {
      let live = true;
      void first.promise.then(
        (value) => {
          if (live) setSnapshot(value);
        },
        (error) => {
          if (live) setBootFailure({ error });
        },
      );
      return () => {
        live = false;
      };
    }, []);
    return h(AppBoot, {
      snapshot,
      bootFailure,
      error: options.error ?? "",
      buildSurface: surface,
      host: { kind: surface },
      conversationWindow: options.conversationWindow ?? false,
      location,
      api: { snapshot: async () => ready },
      artifactPresentation: { current: { seed: () => calls.seeds++ } },
      setSnapshot,
      setBootFailure,
      setProviderId: (id) => {
        calls.provider = id;
      },
      setModel: (model) => {
        calls.model = model;
      },
      onSignOut: async () => {
        calls.logout++;
      },
      report: (error) => calls.errors.push(error),
    });
  }
  const clean = async () => {
    await env.clean();
    for (const [key, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  };
  try {
    await env.render(h(Harness));
  } catch (error) {
    await clean();
    throw error;
  }
  return { ...env, clean, first, ready, calls, intervals };
}

test("native normal pending runs App's actual blank-shell branch, then leaves it after the controlled snapshot", async () => {
  const env = await bootEnvironment();
  try {
    const pending = env.document.querySelector(".boot-shell")!;
    assert.equal(pending.getAttribute("aria-busy"), "true");
    assert.equal(pending.textContent, "");
    assert.ok(pending.querySelector('.boot-drag-strip[aria-hidden="true"]'));
    assert.equal(
      env.document.querySelector(
        ".boot, .spin, textarea, h1, h2, button, [role=textbox]",
      ),
      null,
    );
    await act(async () => env.first.resolve(env.ready));
    assert.equal(env.document.querySelector(".boot-shell"), null);
    assert.equal(
      env.document.querySelector("[data-workspace-ready]")?.textContent,
      env.ready.settings.name,
    );
    assert.equal(pending.isConnected, false);
  } finally {
    await env.clean();
  }
});

test("web pending uses identical static/React blank markup and gains no native drag region", async () => {
  const env = await bootEnvironment("web");
  try {
    const html = readFileSync(
      new URL("../../web.html", import.meta.url),
      "utf8",
    );
    const initial = /<!-- boot:start -->([\s\S]*?)<!-- boot:end -->/.exec(
      html,
    )?.[1];
    assert.ok(initial);
    const canonical = (value: string) =>
      value.replace(/\s+/g, "").toLowerCase();
    const shell = env.document.querySelector(".boot-shell")!;
    assert.equal(shell.tagName, "DIV");
    assert.deepEqual(
      [...shell.attributes]
        .map((attribute) => [attribute.name, attribute.value])
        .sort(),
      [
        ["aria-busy", "true"],
        ["class", "boot-shell"],
      ],
    );
    assert.equal(shell.innerHTML, "");
    assert.equal(
      canonical(initial),
      canonical(renderToStaticMarkup(h(BootShell))),
    );
    assert.equal(env.document.querySelector(".boot-drag-strip"), null);
    await act(async () => env.first.resolve(env.ready));
    assert.ok(env.document.querySelector("[data-workspace-ready]"));
  } finally {
    await env.clean();
  }
});

test("native first-snapshot rejection keeps the real BootErrorPage, countdown Retry, and Log out actions", async () => {
  const env = await bootEnvironment();
  try {
    await act(async () =>
      env.first.reject(new Error("Controlled native snapshot failure")),
    );
    assert.equal(env.document.querySelector(".boot-shell"), null);
    assert.ok(
      env.document.querySelector('[data-testid="bootstrap-connection-error"]'),
    );
    assert.match(
      env.document.querySelector("h2")!.textContent!,
      /temporarily unavailable/,
    );
    const buttons = [
      ...env.document.querySelectorAll<HTMLButtonElement>("button"),
    ];
    const retry = buttons.find((button) =>
      /Try again/.test(button.textContent!),
    )!;
    assert.equal(retry.disabled, true);
    assert.ok(env.intervals.size > 0);
    for (let tick = 0; tick < 10; tick++)
      await act(async () => {
        for (const callback of [...env.intervals]) callback();
      });
    assert.equal(retry.disabled, false);
    await env.event(retry, "click");
    assert.equal(env.calls.reload, 1);
    await env.event(
      buttons.find((button) => button.textContent === "Log out")!,
      "click",
    );
    assert.equal(env.calls.logout, 1);
    assert.deepEqual(env.calls.errors, []);
  } finally {
    await env.clean();
  }
});

test("a separate conversation's first-snapshot failure retains actual ChatLoadError and its snapshot retry", async () => {
  const env = await bootEnvironment("desktop", { conversationWindow: true });
  try {
    await act(async () =>
      env.first.reject(new Error("Controlled chat snapshot failure")),
    );
    assert.ok(env.document.querySelector(".chat-load-error"));
    assert.equal(env.document.querySelector(".boot-shell, .boot-error"), null);
    await env.click(".chat-load-error button");
    assert.ok(env.document.querySelector("[data-workspace-ready]"));
    assert.equal(env.calls.seeds, 1);
    assert.equal(env.calls.provider, env.ready.settings.activeProviderId);
    assert.equal(
      env.calls.model,
      env.ready.settings.providers.find(
        (entry) => entry.id === env.calls.provider,
      )?.model,
    );
  } finally {
    await env.clean();
  }
});

test("the explicit legacy error remains visible and is never replaced by a normal pending shell", async () => {
  const env = await bootEnvironment("desktop", {
    error: "Controlled pre-snapshot error",
  });
  try {
    assert.equal(env.document.querySelector(".boot-shell"), null);
    assert.equal(
      env.document.querySelector(".error-text")?.textContent,
      "Controlled pre-snapshot error",
    );
    assert.equal(env.document.querySelector(".spin"), null);
    assert.doesNotMatch(
      env.document.body.textContent!,
      /Preparing your workspace/,
    );
    await act(async () => env.first.resolve(env.ready));
    assert.ok(env.document.querySelector("[data-workspace-ready]"));
  } finally {
    await env.clean();
  }
});

test("only the native pending shell has an invisible 48px top drag hit area outside the tab order", () => {
  const native = renderToStaticMarkup(h(BootShell, { native: true }));
  const web = renderToStaticMarkup(h(BootShell));
  assert.match(native, /class="boot-drag-strip" aria-hidden="true"/);
  assert.doesNotMatch(
    native,
    /tabindex|button|input|textarea|Loading|Preparing|<h[1-6]/i,
  );
  assert.doesNotMatch(web, /boot-drag-strip/);
  const css = postcss.parse(
    readFileSync(new URL("../../src/boot/boot.css", import.meta.url), "utf8"),
  );
  const declarations: Record<string, string> = {};
  css.walkRules(".boot-shell > .boot-drag-strip", (rule) => {
    rule.walkDecls((entry) => {
      declarations[entry.prop] = entry.value;
    });
  });
  assert.deepEqual(declarations, {
    position: "fixed",
    inset: "0 0 auto",
    height: "var(--titlebar-height, 48px)",
    "-webkit-app-region": "drag",
  });
  const foundation = postcss.parse(
    readFileSync(
      new URL("../../src/styles/00-foundation.css", import.meta.url),
      "utf8",
    ),
  );
  const heights: string[] = [];
  foundation.walkRules(":root", (rule) => {
    rule.walkDecls("--titlebar-height", (entry) => {
      heights.push(entry.value);
    });
  });
  assert.deepEqual(heights, ["48px"]);
});
