import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { act, createElement, useState, type ComponentType } from "react";
import type { Conversation } from "../../shared/types";
import { AppContext, type AppController } from "../../src/app/AppContext";
import ChatHost from "../../src/composer/ChatQueuedMessages";
import CodeHost from "../../src/composer/QueuedMessageBar";
import { useSkillDraft } from "../../src/composer/useSkillDraft";
import {
  insertSkillToken,
  prependSkillDraft,
} from "../../src/composer/skill-tokens";
import {
  addQueued,
  clearQueued,
  queuedMessages,
  removeQueued,
  useQueuedMessages,
} from "../../src/composer/queue";
import { routineDom } from "../support/routine-dom";

const callbackKey = Symbol.for("claudex-test-queued-callbacks");
type Kind = "chat" | "code";
let counter = 0;
const capturedHosts = new Map<Kind, ComponentType<any>>();

/** Observe the actual Host's callback props without replacing their behavior.
 * Keeping the callbacks before the pending render exercises the fresh queue
 * guard independently of button disabling and the new render's closures. */
async function capturedHost(kind: Kind) {
  const cached = capturedHosts.get(kind);
  if (cached) return cached;
  const url = new URL(
    `../../src/composer/${kind === "chat" ? "ChatQueuedMessages" : "QueuedMessageBar"}.tsx`,
    import.meta.url,
  );
  let source = readFileSync(url, "utf8");
  const capture = (name: string, callback: string) =>
    `((callback) => { globalThis[Symbol.for("claudex-test-queued-callbacks")]?.set("${name}", callback); return callback; })(${callback})`;
  assert.ok(source.includes("onEdit={edit}"));
  source = source.replace(
    "onEdit={edit}",
    `onEdit={${capture("edit", "edit")}}`,
  );
  const remove = kind === "chat" ? "onRemove={remove}" : "onCancel={remove}";
  assert.ok(source.includes(remove));
  source = source.replace(
    remove,
    `${kind === "chat" ? "onRemove" : "onCancel"}={${capture("remove", "remove")}}`,
  );
  const output = ts
    .transpileModule(source, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    })
    .outputText.replace(
      /((?:from\s*|import\s*\(\s*|import\s*)["'])([^"']+)(["'])/g,
      (_all, start: string, specifier: string, end: string) =>
        start +
        (specifier.startsWith(".")
          ? new URL(specifier, url).href
          : /^[a-z]+:/i.test(specifier)
            ? specifier
            : import.meta.resolve(specifier)) +
        end,
    );
  const Host = (
    await import("data:text/javascript," + encodeURIComponent(output))
  ).default as ComponentType<any>;
  capturedHosts.set(kind, Host);
  return Host;
}

async function withQueue(
  kind: Kind,
  running: boolean,
  capture: boolean,
  run: (
    env: Awaited<ReturnType<typeof routineDom>> & {
      id: string;
      entryId: string;
      draft(): ReturnType<typeof useSkillDraft>;
      callbacks: Map<string, (id: string) => void>;
      requests: unknown[][];
      delivered: Conversation[];
      resolve(): Promise<void>;
      reject(): Promise<void>;
    },
  ) => Promise<void>,
) {
  const id = `pending-queue-${++counter}`;
  const conversation: Conversation = {
    id,
    title: "Synthetic queue",
    mode: kind,
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "turn",
        prompt: "Previous",
        attachments: [],
        createdAt: 1,
        status: running ? "inProgress" : "completed",
        items: [],
      },
    ],
  };
  let complete!: (value: unknown) => void;
  let fail!: (error: Error) => void;
  const requests: unknown[][] = [];
  const request = (...args: unknown[]) => {
    requests.push(args);
    return new Promise((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
  };
  const env = await routineDom({
    steerTurn: request as never,
    send: request as never,
  });
  const domGlobals = {
    innerWidth: 1440,
    innerHeight: 900,
    HTMLElement: env.window.HTMLElement,
    HTMLInputElement: env.window.HTMLInputElement,
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
    getComputedStyle: () => ({
      overflowX: "visible",
      overflowY: "visible",
      direction: "ltr",
      getPropertyValue: () => "8",
    }),
  };
  const savedDom = new Map(
    Object.keys(domGlobals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(domGlobals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  Object.defineProperty(env.document.documentElement, "clientWidth", {
    configurable: true,
    value: 1440,
  });
  const oldCapture = Object.getOwnPropertyDescriptor(globalThis, callbackKey);
  const callbacks = new Map<string, (id: string) => void>();
  Object.defineProperty(globalThis, callbackKey, {
    configurable: true,
    value: callbacks,
  });
  const selected = insertSkillToken("Queued instructions", [], "review", 0)!;
  const current = insertSkillToken("Existing draft", [], "current", 0)!;
  const entry = addQueued(id, {
    ...selected,
    state: "queued",
    attachments: [],
    mode: kind,
    providerId: "p",
    model: "m",
    webSearch: false,
    ...(running ? {} : { error: "Retry fixture" }),
  });
  const Host = capture
    ? await capturedHost(kind)
    : kind === "chat"
      ? ChatHost
      : CodeHost;
  let live!: ReturnType<typeof useSkillDraft>;
  const delivered: Conversation[] = [];
  function Harness() {
    live = useSkillDraft();
    const [attachments, setAttachments] = useState([]);
    const app = {
      ...live,
      attachments,
      setAttachments,
      snapshot: { settings: {} },
      latest: { current: { conversations: [conversation] } },
      composer: { current: null },
      upsert: (value: Conversation) => delivered.push(value),
      report() {},
    } as unknown as AppController;
    return createElement(
      AppContext.Provider,
      { value: app },
      createElement(Host, {
        conversation,
        entries: useQueuedMessages(id),
        onEmpty() {},
        exiting: false,
        onExited() {},
      }),
    );
  }
  try {
    await env.render(createElement(Harness));
    await act(async () => {
      live.setText(current.text);
      live.setSkillTokens(current.skillTokens);
    });
    await run({
      ...env,
      id,
      entryId: entry.id,
      draft: () => live,
      callbacks,
      requests,
      delivered,
      resolve: () =>
        act(async () =>
          complete(
            running ? { messageId: "accepted", conversation } : conversation,
          ),
        ),
      reject: () =>
        act(async () => fail(new Error("Synthetic transport refusal"))),
    });
  } finally {
    await act(async () => {
      for (const item of queuedMessages(id)) removeQueued(id, item.id);
    });
    await env.clean();
    for (const [key, descriptor] of savedDom) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    if (oldCapture) Object.defineProperty(globalThis, callbackKey, oldCapture);
    else Reflect.deleteProperty(globalThis, callbackKey);
  }
}

for (const kind of ["chat", "code"] as const) {
  test(`${kind}: actual pending Send now disables Edit/Remove without extra spinners`, async () => {
    await withQueue(kind, true, false, async (env) => {
      const before = {
        text: env.draft().text,
        skillTokens: env.draft().skillTokens,
      };
      await env.click('button[aria-label="Send now"]');
      assert.equal(queuedMessages(env.id)[0].steering, true);
      for (const label of ["Edit in composer", "Remove from queue"]) {
        const button = env.document.querySelector<HTMLButtonElement>(
          `button[aria-label="${label}"]`,
        )!;
        assert.equal(button.disabled, true);
        assert.equal(button.getAttribute("aria-disabled"), "true");
        assert.equal(button.getAttribute("aria-busy"), null);
        await env.click(`button[aria-label="${label}"]`);
      }
      assert.equal(queuedMessages(env.id).length, 1);
      assert.deepEqual(
        { text: env.draft().text, skillTokens: env.draft().skillTokens },
        before,
      );
      await env.resolve();
      assert.equal(env.delivered.length, 1);
      assert.equal(queuedMessages(env.id)[0].state, "steered");
    });
  });

  for (const running of [true, false])
    for (const result of ["resolve", "reject"] as const) {
      test(`${kind}: retained Edit/Remove cannot mutate a pending ${running ? "steer" : "idle send"} before ${result}`, async () => {
        await withQueue(kind, running, true, async (env) => {
          const oldEdit = env.callbacks.get("edit")!;
          const oldRemove = env.callbacks.get("remove")!;
          assert.equal(typeof oldEdit, "function");
          assert.equal(typeof oldRemove, "function");
          const before = {
            text: env.draft().text,
            skillTokens: env.draft().skillTokens,
          };
          const entry = queuedMessages(env.id)[0];
          await env.click('button[aria-label="Send now"]');
          assert.equal(env.requests.length, 1);
          assert.equal(queuedMessages(env.id)[0].steering, true);
          await act(async () => {
            oldEdit(env.entryId);
            oldRemove(env.entryId);
          });
          assert.equal(queuedMessages(env.id).length, 1);
          assert.deepEqual(
            { text: env.draft().text, skillTokens: env.draft().skillTokens },
            before,
          );
          await env[result]();
          if (result === "resolve") {
            await act(async () => {
              oldEdit(env.entryId);
              oldRemove(env.entryId);
            });
            assert.equal(queuedMessages(env.id).length, running ? 1 : 0);
            assert.deepEqual(
              { text: env.draft().text, skillTokens: env.draft().skillTokens },
              before,
            );
          } else {
            assert.equal(queuedMessages(env.id)[0].steering, undefined);
            await env.click('button[aria-label="Edit in composer"]');
            assert.equal(queuedMessages(env.id).length, 0);
            assert.deepEqual(
              { text: env.draft().text, skillTokens: env.draft().skillTokens },
              prependSkillDraft(entry, before),
            );
          }
        });
      });
    }
}

test("Code's open row menu locks Edit/Remove and Clear all keeps the pending entry", async () => {
  await withQueue("code", true, true, async (env) => {
    const before = {
      text: env.draft().text,
      skillTokens: env.draft().skillTokens,
    };
    await act(async () => {
      addQueued(env.id, {
        text: "Waiting sibling",
        attachments: [],
        state: "queued",
        mode: "code",
        providerId: "p",
        model: "m",
        webSearch: false,
      });
    });
    await env.click(".queued-bar-summary");
    await env.click(".queued-row:first-child .queued-row-more");
    const item = (label: string) => {
      const result = [
        ...env.document.querySelectorAll<HTMLButtonElement>(
          '[role="menu"] [role="menuitem"]',
        ),
      ].find((button) => button.textContent?.includes(label));
      assert.ok(result, label);
      return result;
    };
    await env.event(item("Send now"), "click");
    assert.equal(queuedMessages(env.id)[0].steering, true);
    await env.click(".queued-row:first-child .queued-row-more");
    for (const label of ["Edit in composer", "Remove from queue"])
      assert.equal(item(label).disabled, true, label);
    await env.click(".queued-bar-clear");
    assert.deepEqual(
      queuedMessages(env.id).map((entry) => entry.id),
      [env.entryId],
    );
    assert.deepEqual(
      { text: env.draft().text, skillTokens: env.draft().skillTokens },
      before,
    );
    await env.resolve();
    assert.equal(queuedMessages(env.id)[0].state, "steered");
  });
});

test("Clear all preserves in-flight entries but still removes untouched waiting messages", () => {
  const id = `pending-clear-${++counter}`;
  const common = {
    text: "Synthetic",
    attachments: [],
    state: "queued" as const,
    mode: "chat" as const,
    providerId: "p",
    model: "m",
    webSearch: false,
  };
  const pending = addQueued(id, { ...common, steering: true });
  const taken = addQueued(id, { ...common, state: "steered" });
  addQueued(id, common);
  try {
    clearQueued(id);
    assert.deepEqual(
      queuedMessages(id).map((entry) => entry.id),
      [pending.id, taken.id],
    );
  } finally {
    for (const entry of queuedMessages(id)) removeQueued(id, entry.id);
  }
});
