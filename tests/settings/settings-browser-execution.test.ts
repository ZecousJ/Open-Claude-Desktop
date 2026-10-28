import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement as h } from "react";
import { routineDom } from "../support/routine-dom";
import { hasLocalBrowserExecution } from "../../shared/browser-execution-eligibility";
import { ownsNativeBrowserExecution } from "../../electron/browser/execution-owner";
import { browserToolsExtension } from "../../electron/browser/browser-tools-registration";
import { registerPanelHandlers } from "../../electron/ipc/panels";
import { ExternalLinks, OpenLink } from "../../src/ui/ExternalLinks";
import { AppContext } from "../../src/app/AppContext";
import { HostContext } from "../../src/host/HostContext";
import { desktopHost } from "../../shared/host";
import { openPolicy } from "../../shared/client-policy";
import type { Conversation } from "../../shared/types";

const conversation = (patch: object = {}) =>
  ({
    id: "local",
    mode: "cowork",
    turns: [],
    ...patch,
  }) as unknown as Conversation;
const invalid = [
  { environment: { kind: "space", spaceId: "cloud" } },
  { environment: { kind: "ssh", hostId: "remote" } },
  { linkedToComputer: true, linkedComputerId: "other" },
  { chatDeviceBinding: { deviceId: "other" } },
  { mode: "chat" },
];

test("actual MCP extension refuses cloud, SSH, logical mirrors, and mode mismatch", () => {
  const extension = browserToolsExtension({
    server: { url: () => "http://127.0.0.1/mcp/cap" },
    token: "private",
  });
  const ctx = (c: Conversation) =>
    ({
      conversation: c,
      mode: c.mode,
      policy: openPolicy,
      settings: { browserTools: true },
    }) as never;
  for (const c of [conversation(), conversation({ mode: "code" })]) {
    assert.ok(hasLocalBrowserExecution(c));
    assert.ok(extension.builtinMcpServers!(ctx(c)));
  }
  for (const patch of invalid) {
    const c = conversation(patch);
    assert.equal(hasLocalBrowserExecution(c), false);
    assert.equal(extension.builtinMcpServers!(ctx(c)), undefined);
    assert.equal(extension.developerInstructions!(ctx(c)), undefined);
  }
  assert.equal(
    extension.builtinMcpServers!({
      ...(ctx(conversation()) as object),
      mode: "code",
    } as never),
    undefined,
  );
  assert.equal(
    extension.builtinMcpServers!({
      ...(ctx(conversation()) as object),
      policy: { ...openPolicy, browser: { enabled: false } },
    } as never),
    undefined,
  );
});

test("device replica needs current backend account and a real owned workspace, not claimed metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-b34-browser-"));
  try {
    const cwd = path.join(root, "workspace/chat-devices/local");
    fs.mkdirSync(cwd, { recursive: true });
    const c = conversation({
      cwd,
      environment: { kind: "local" },
      deviceChatOrigin: { active: true, accountScope: "7" },
    });
    const ctx = {
      store: { root, conversations: [c] },
      remote: { ready: true, session: { userId: 7 } },
    } as never;
    assert.equal(ownsNativeBrowserExecution(ctx, c.id), true);
    (ctx as any).remote.session.userId = 8;
    assert.equal(ownsNativeBrowserExecution(ctx, c.id), false);
    (ctx as any).remote.session.userId = 7;
    fs.rmdirSync(cwd);
    fs.mkdirSync(path.join(root, "outside"));
    fs.symlinkSync(path.join(root, "outside"), cwd);
    assert.equal(ownsNativeBrowserExecution(ctx, c.id), false);
    assert.equal(ownsNativeBrowserExecution(ctx, "missing"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("actual panel handlers apply backend execution ownership before touching browser service", async () => {
  let c = conversation();
  let touches = 0;
  const ctx = {
    store: { conversations: [c], settings: {} },
    policy: () => openPolicy,
    callerWindow: () => ({}),
  } as never;
  const handlers = new Map<string, (...args: any[]) => any>();
  registerPanelHandlers(
    (name, fn) => handlers.set(name, fn),
    ctx,
    async () =>
      ({
        service: () => {
          touches++;
          return {
            policy: () => ({}),
            host: { state: (id: string) => ({ conversationId: id }) },
          };
        },
      }) as never,
  );
  assert.deepEqual(await handlers.get("browserState")!("local"), {
    conversationId: "local",
  });
  assert.equal(touches, 1);
  for (const patch of invalid) {
    (ctx as any).store.conversations = [(c = conversation(patch))];
    await assert.rejects(
      () => handlers.get("browserState")!("local"),
      /running on this computer/,
    );
  }
  assert.equal(touches, 1);
  (ctx as any).store.conversations = [];
  await assert.rejects(
    () => handlers.get("browserState")!("local"),
    /doesn't exist/,
  );
});

test("mounted link interaction routes local Cowork only; a cloud task gets confirmation", async () => {
  const opened: unknown[] = [];
  const env = await routineDom(
    {
      browserNewTab: async (...args: unknown[]) => {
        opened.push(args);
      },
    } as never,
    { jsdom: true },
  );
  try {
    const { useContext } = await import("react");
    function Link() {
      const open = useContext(OpenLink);
      return h(
        "button",
        { onClick: () => open("https://example.com/") },
        "Visit",
      );
    }
    const render = (active: Conversation) =>
      env.render(
        h(
          HostContext.Provider,
          { value: desktopHost },
          h(
            AppContext.Provider,
            {
              value: {
                active,
                snapshot: { settings: {} },
                setPanel() {},
              } as never,
            },
            h(ExternalLinks, {
              onError: (error: unknown) => {
                throw error;
              },
              children: h(Link),
            }),
          ),
        ),
      );
    await render(conversation());
    await env.event(env.document.querySelector("button")!, "click");
    assert.deepEqual(opened, [["local", "https://example.com/"]]);
    await render(
      conversation({ environment: { kind: "space", spaceId: "cloud" } }),
    );
    await env.event(env.document.querySelector("button")!, "click");
    assert.equal(opened.length, 1);
    assert.match(env.document.body.textContent!, /Open external link/);
  } finally {
    await env.clean();
  }
});
