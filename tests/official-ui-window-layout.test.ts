import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { BrowserWindow } from "electron";
import { SessionPopouts } from "../electron/app/session-popouts";
import { WindowLayoutCommands } from "../electron/app/window-layout";
import { registerWindowLayout } from "../electron/official-ui/native/window-layout";
import type { LayoutCommand } from "../shared/window-layout";

const origin = "http://fixture.invalid";
const channel = (operation: string) =>
  `$eipc_message$_2c52b292-adb9-4097-9941-2e3e2dd496b2_$_claude.web_$_${operation.replace(".", "_$_")}`;
const operations = [
  "SessionPopouts.reportOpenLayout",
  "SessionPopouts.reportOpenPopouts",
  "SessionPopouts.takeRestorableLayout",
  "SessionPopouts.takeRestorablePopouts",
  "WindowLayout.setLayoutCommandListening",
  "WindowLayout.reportLayoutCommandResult",
] as const;

class Window extends EventEmitter {
  readonly sent: unknown[][] = [];
  readonly webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    mainFrame: { url: origin + "/code" },
    navigationHistory: {
      canGoBack: () => false,
      canGoForward: () => false,
    },
    send: (...args: unknown[]) => this.sent.push(args),
  });
  constructor(readonly id: number) {
    super();
  }
  isDestroyed() {
    return false;
  }
  isFocused() {
    return false;
  }
  invokeEvent() {
    return {
      sender: this.webContents,
      senderFrame: this.webContents.mainFrame,
    };
  }
}

type Invoke = (
  event: ReturnType<Window["invokeEvent"]>,
  ...args: unknown[]
) => Promise<unknown>;
const invokes = new Map<string, Invoke>();
const windows = new WeakMap<Window["webContents"], Window>();
Object.assign(globalThis, {
  officialWindowLayoutElectron: {
    BrowserWindow: {
      fromWebContents: (contents: Window["webContents"]) =>
        windows.get(contents),
    },
    ipcMain: {
      handle: (key: string, invoke: Invoke) => invokes.set(key, invoke),
      removeHandler: (key: string) => invokes.delete(key),
      on() {},
      removeListener() {},
    },
  },
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "electron")
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const { BrowserWindow, ipcMain } = globalThis.officialWindowLayoutElectron;",
      };
    return next(specifier, context);
  },
});
const { NativeHost } = await import("../electron/official-ui/native/host");

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "official-window-layout-"),
  );
  fs.mkdirSync(path.join(root, "data"));
  fs.writeFileSync(
    path.join(root, "data", "native-ipc-contract.json"),
    JSON.stringify({
      invokes: operations.map((name) => ({ channel: channel(name) })),
      sync: [],
    }),
  );
  const file = path.join(root, "session-popouts.json");
  let sessions = new SessionPopouts(() => file);
  const commands = new WindowLayoutCommands();
  const account = { id: "active-account", email: "", name: "" };
  const unused = () => {
    throw new Error("Unexpected adapter operation");
  };
  const host = new NativeHost(origin, {
    root,
    appVersion: "test",
    account: () => account,
    settings: unused,
    snapshot: unused,
    listConversations: unused,
    loadConversation: unused,
    call: unused,
    modelCatalog: unused,
    onEvent: () => () => {},
    log() {},
  });
  const attach = (window: Window) => {
    windows.set(window.webContents, window);
    const attached = window as unknown as BrowserWindow;
    host.attach(attached);
    return attached;
  };
  const main = new Window(1);
  const extra = new Window(2);
  const attachedMain = attach(main);
  attach(extra);
  registerWindowLayout(host, {
    mainWindow: () => attachedMain,
    sessions: () => sessions,
    commands: () => commands,
  });
  host.start();
  t.after(() => {
    commands.dispose();
    host.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const call = (
    name: (typeof operations)[number],
    window: Window,
    ...args: unknown[]
  ) => {
    const invoke = invokes.get(channel(name));
    assert.ok(invoke);
    return invoke(window.invokeEvent(), ...args);
  };
  return {
    account,
    main,
    extra,
    call,
    reopen: () => {
      sessions = new SessionPopouts(() => file);
    },
    retireMain: () => host.detach(attachedMain),
    dispatch: (send: (command: LayoutCommand) => void) =>
      commands.dispatch(
        attachedMain.webContents,
        { kind: "get_layout", callerSessionId: "local_123" },
        true,
        (command) => {
          host.emitTo(attachedMain, "WindowLayout", "layoutCommand", command);
          send(command);
        },
      ),
  };
}

test("the main page restores its saved session, pane and project layout once", async (t) => {
  const { main, extra, account, call, reopen, retireMain } = fixture(t);
  const layout = {
    popouts: [
      {
        sessionId: "local_123",
        sessionType: "local",
        isSsh: true,
        alwaysOnTop: true,
        bounds: { x: -800, y: 40, width: 720, height: 540 },
      },
    ],
    panes: [
      {
        sessionId: "local_123",
        sessionType: "local",
        paneTileId: "artifact",
        view: '["artifact-id"]',
        title: "Artifact",
      },
    ],
    projects: [{ projectId: "project-1", title: "Layout test" }],
  };
  const empty = { popouts: [], panes: [] };
  assert.equal(
    await call("SessionPopouts.reportOpenLayout", main, {
      ...layout,
      accountUuid: account.id,
    }),
    undefined,
  );
  await call("SessionPopouts.reportOpenLayout", main, {
    ...empty,
    accountUuid: "another-account",
  });
  await call("SessionPopouts.reportOpenLayout", extra, empty);
  await call("SessionPopouts.reportOpenLayout", main, empty);
  await assert.rejects(
    call("SessionPopouts.reportOpenLayout", main, { popouts: [] }),
  );
  reopen();
  assert.equal(
    await call("SessionPopouts.takeRestorableLayout", extra, account.id),
    null,
  );
  assert.equal(
    await call("SessionPopouts.takeRestorableLayout", main, "another-account"),
    null,
  );
  assert.deepEqual(
    await call("SessionPopouts.takeRestorableLayout", main, account.id),
    layout,
  );
  assert.equal(
    await call("SessionPopouts.takeRestorableLayout", main, account.id),
    null,
  );
  await call("SessionPopouts.reportOpenLayout", main, {
    ...layout,
    accountUuid: account.id,
  });
  await call("SessionPopouts.reportOpenLayout", main, {
    ...empty,
    accountUuid: account.id,
  });
  reopen();
  assert.equal(
    await call("SessionPopouts.takeRestorableLayout", main, account.id),
    null,
  );
  retireMain();
  assert.throws(
    () => call("SessionPopouts.takeRestorableLayout", main),
    /Untrusted IPC sender/,
  );
});

test("legacy popout calls restore only sessions and share the full layout claim", async (t) => {
  const { main, call, reopen } = fixture(t);
  const popouts = [{ sessionId: "local_123", sessionType: "local" }];
  await call("SessionPopouts.reportOpenPopouts", main, popouts);
  reopen();
  assert.deepEqual(
    await call("SessionPopouts.takeRestorablePopouts", main),
    popouts,
  );
  assert.equal(await call("SessionPopouts.takeRestorableLayout", main), null);
  await call("SessionPopouts.reportOpenPopouts", main, popouts);
  await call("SessionPopouts.reportOpenLayout", main, {
    popouts: [],
    panes: [],
    projects: [{ projectId: "project-1" }],
  });
  reopen();
  assert.equal(await call("SessionPopouts.takeRestorablePopouts", main), null);
  assert.equal(await call("SessionPopouts.takeRestorableLayout", main), null);
  await call("SessionPopouts.reportOpenLayout", main, {
    popouts: [],
    panes: [],
    handledProjects: ["project-1"],
  });
  reopen();
  assert.equal(await call("SessionPopouts.takeRestorableLayout", main), null);
});

test("window layout sends a command to the main renderer and accepts only its result", async (t) => {
  const { main, extra, call, dispatch } = fixture(t);
  await call("WindowLayout.setLayoutCommandListening", extra, true);
  assert.deepEqual(await dispatch(() => {}), { kind: "not_listening" });
  await assert.rejects(
    call("WindowLayout.setLayoutCommandListening", main, "true"),
  );
  await call("WindowLayout.setLayoutCommandListening", main, true);
  let command: LayoutCommand | undefined;
  const pending = dispatch((value) => {
    command = value;
  });
  assert.ok(command);
  assert.deepEqual(main.sent, [
    [channel("WindowLayout.layoutCommand"), command],
  ]);
  assert.deepEqual(extra.sent, []);
  assert.equal(command.mainWindowHidden, true);
  await call("WindowLayout.reportLayoutCommandResult", extra, {
    requestId: command.requestId,
    outcome: "failed",
  });
  await assert.rejects(
    call("WindowLayout.reportLayoutCommandResult", main, {
      requestId: command.requestId,
      outcome: "unknown",
    }),
  );
  const result = {
    requestId: command.requestId,
    outcome: "done",
    layout: {
      mode: "none",
      sidebarCollapsed: false,
      primarySessionId: "local_123",
      primaryFocused: true,
      panes: [],
      popoutSessionIds: [],
      otherPopoutCount: 0,
      caller: { primary: true, popout: false },
    },
  };
  await call("WindowLayout.reportLayoutCommandResult", main, result);
  assert.deepEqual(await pending, { kind: "result", result });
  const replaced = dispatch(() => {});
  main.webContents.emit("did-navigate", {}, origin + "/code");
  assert.deepEqual(await replaced, { kind: "no_window" });
  assert.deepEqual(await dispatch(() => {}), { kind: "not_listening" });
});
