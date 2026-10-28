/**
 * Round-two seams (S0): separate conversation windows (R2), the new domain
 * stubs' honest "nothing yet" answers, the engine registry (R9), the
 * account lifecycle callbacks and the artifact placement hook (R11-E).
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import type { Conversation } from "../../shared/types";
import type { AppContext } from "../../electron/app/app-context";
import { Listeners } from "../../electron/app/app-context";
import { EngineRegistry } from "../../electron/engine/engine-registry";
import { domainMethods } from "../../shared/desktop-bridge";
import { windowRole } from "../../src/conversation-window/window-role";
import { placementFor } from "../../src/app/useDesktopEvents";
import { ArtifactPresentation } from "../../src/artifacts/artifact-presentation";
import { registerSharingHandlers } from "../../electron/ipc/sharing";
import { registerWindowsHandlers } from "../../electron/ipc/windows";
import { registerMemoryHandlers } from "../../electron/ipc/memory";
import { registerResearchHandlers } from "../../electron/ipc/research-handlers";
import { registerFaviconHandlers } from "../../electron/ipc/favicons";
import { registerSshHandlers } from "../../electron/ipc/ssh-handlers";
import { registerCoworkHandlers } from "../../electron/ipc/cowork";
import { readSource } from "../support/read-source";

const source = (file: string) =>
  fs.readFileSync(
    fileURLToPath(new URL(`../../${file}`, import.meta.url)),
    "utf8",
  );

test("a window is a conversation window only for a well-formed id", () => {
  assert.deepEqual(windowRole(""), { kind: "main" });
  assert.deepEqual(windowRole("?window=conversation&id=c-1_A"), {
    kind: "conversation",
    conversationId: "c-1_A",
  });
  assert.deepEqual(windowRole("?window=conversation"), { kind: "main" });
  assert.deepEqual(windowRole("?window=conversation&id=../x"), {
    kind: "main",
  });
  assert.deepEqual(windowRole(`?window=conversation&id=${"a".repeat(129)}`), {
    kind: "main",
  });
  assert.deepEqual(windowRole("?window=settings&id=c-1"), { kind: "main" });
});

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "c-1",
    title: "Folder notes",
    mode: "cowork",
    cwd: "/work/notes",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    turns: [],
    ...overrides,
  };
}

/** A profile folder for domains that keep a file there (Cowork folder grants). */
const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-seam-"));
after(() => fs.rmSync(profileRoot, { recursive: true, force: true }));

/** Registers one stub domain against a context holding only a store. */
function handlersOf(
  register: (handle: (name: string, fn: any) => void, ctx: AppContext) => void,
  conversations: Conversation[] = [],
  extra: Record<string, unknown> = {},
) {
  const handlers = new Map<string, (...args: any[]) => any>();
  register((name, fn) => handlers.set(name, fn), {
    store: { conversations, root: profileRoot },
    // No window is calling.
    callerWindow: () => undefined,
    ...extra,
  } as unknown as AppContext);
  return handlers;
}

/**
 * SSH (R9-S1) is a real domain now: it needs the account lifecycle, a
 * profile folder and the policy. With SSH turned off by the administrator
 * it still shows no entry and refuses to connect.
 */
const sshOff = {
  dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), "cx-seam-ssh-")),
  services: {},
  remoteFolders: new Map(),
  policy: () => ({ sshRemote: false }),
  onAccountActivated: () => () => {},
  onAccountDeactivating: () => () => {},
  onEvent: () => () => {},
  push: () => {},
};
after(() => fs.rmSync(sshOff.dataRoot, { recursive: true, force: true }));

/**
 * Research and site icons (R45c) follow the account lifecycle and the
 * policy; with web search and remote images off they still refuse Research
 * and fetch no icon.
 */
const searchOff = {
  services: {},
  policy: () => ({ webSearch: false, remoteImages: false }),
  onAccountActivated: () => () => {},
  onAccountDeactivating: () => () => {},
  push: () => {},
};

test("every new domain answers each of its calls, and answers 'nothing yet' honestly", async () => {
  const registered = new Map<string, Map<string, (...args: any[]) => any>>([
    ["sharing", handlersOf(registerSharingHandlers)],
    ["windows", handlersOf(registerWindowsHandlers)],
    // Memory (R3-S4) follows the account lifecycle; nobody is signed in here.
    ["memory", handlersOf(registerMemoryHandlers, [], sshOff)],
    ["research", handlersOf(registerResearchHandlers, [], searchOff)],
    ["favicons", handlersOf(registerFaviconHandlers, [], searchOff)],
    ["ssh", handlersOf(registerSshHandlers, [], sshOff)],
    ["cowork", handlersOf(registerCoworkHandlers, [conversation()])],
  ]);
  for (const [domain, handlers] of registered)
    assert.deepEqual(
      [...handlers.keys()].sort(),
      [...domainMethods[domain as keyof typeof domainMethods]].sort(),
      domain,
    );
  const call = (domain: string, name: string, ...args: unknown[]) =>
    registered.get(domain)!.get(name)!(...args);

  // No entry point shows: no sharing, no hosts, no memory.
  // (Computer use is implemented by R10-M: tests/computer-use-*.test.ts.)
  assert.equal(await call("sharing", "sharingStatus"), null);
  assert.deepEqual(await call("sharing", "hostedShares"), []);
  await assert.rejects(call("sharing", "shareConversation", "c-1"), /Sharing/);
  // Windows (R2-B, tests/windows-ipc.test.ts): nothing open, no handoff, and
  // no window for a conversation the signed-in account does not have.
  assert.deepEqual(await call("windows", "conversationWindows"), []);
  assert.equal(await call("windows", "takeWindowHandoff"), null);
  assert.equal(await call("windows", "setWindowPinned", true), false);
  await assert.rejects(
    call("windows", "openConversationWindow", "c-1"),
    /isn't available/,
  );
  const memory = await call("memory", "memoryStatus");
  assert.equal(memory.available, false);
  assert.equal(memory.reason, "unsupported");
  await assert.rejects(call("memory", "setMemoryPrefs", { generate: true }));
  await assert.rejects(
    call("research", "setConversationResearch", "c-1", true),
  );
  assert.deepEqual(await call("favicons", "getFavicons", ["a.example"]), {
    "a.example": null,
  });
  await assert.rejects(
    call("favicons", "getFavicons", Array(51).fill("a.example")),
  );
  const hosts = await call("ssh", "sshListHosts");
  assert.equal(hosts.sshAvailable, false);
  assert.deepEqual(hosts.hosts, []);
  await assert.rejects(call("ssh", "sshConnect", "h"));
  // A Cowork conversation's folders: its working folder until one is added (R11-A).
  assert.deepEqual(await call("cowork", "coworkFolders", "c-1"), {
    primary: "/work/notes",
    extra: [],
    browser: { kind: "native" },
  });
  await assert.rejects(call("cowork", "coworkFolders", "missing"));
  assert.deepEqual(await call("cowork", "trustedCoworkFolders"), []);
  await assert.rejects(call("cowork", "grantCoworkFolder", "/", "always"));
});

test("every conversation runs on the local engine until remote engines exist", () => {
  let busy = false;
  const local = { isBusy: () => busy } as never;
  let signedIn = true;
  const engines = new EngineRegistry(() => (signedIn ? local : undefined));
  assert.equal(engines.forConversation("c-1"), local);
  assert.deepEqual(engines.all(), [local]);
  assert.equal(engines.isBusy(), false);
  busy = true;
  assert.equal(engines.isBusy(), true);
  signedIn = false;
  assert.deepEqual(engines.all(), []);
  assert.equal(engines.isBusy(), false);
  assert.throws(() => engines.forConversation("c-1"), /Sign in/);
});

test("sign-out waits for the account services' cleanup, even when one fails", async () => {
  const listeners = new Listeners<void>();
  const done: string[] = [];
  listeners.add(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    done.push("memory");
  });
  listeners.add(() => {
    throw Error("broken");
  });
  listeners.add(() => void done.push("ssh"));
  const error = console.error;
  console.error = () => {};
  try {
    await listeners.emitAsync();
  } finally {
    console.error = error;
  }
  assert.deepEqual(done.sort(), ["memory", "ssh"]);
});

test("a presented file opens in Chat's place unless the presentation places it itself", () => {
  const presentation = new ArtifactPresentation();
  // R11-E places Cowork outputs itself; Chat keeps the artifact view at 68%.
  assert.deepEqual(
    placementFor(presentation, conversation({ mode: "chat" }), undefined),
    { surface: "artifact", width: 68, keepPanel: false },
  );
  assert.deepEqual(placementFor(presentation, conversation(), undefined), {
    surface: "file",
    width: 50,
    keepPanel: false,
  });
  const placed = Object.assign(new ArtifactPresentation(), {
    presentationFor: (c: Conversation, viewing: unknown) =>
      viewing
        ? null
        : {
            surface: "file" as const,
            width: 50,
            keepPanel: c.mode === "cowork",
          },
  });
  assert.deepEqual(placementFor(placed, conversation(), undefined), {
    surface: "file",
    width: 50,
    keepPanel: true,
  });
  assert.equal(
    placementFor(placed, conversation(), { id: "a" } as never),
    null,
  );
});

test("the main process trusts, guards and informs every app window, and ends them with the account", () => {
  const main = readSource("electron/main.ts");
  // Only an app window's own top frame may call the bridge.
  assert.match(main, /const caller = appWindowOf\(event\.sender\);/);
  assert.match(
    main,
    /if \(!caller \|\| event\.senderFrame !== event\.sender\.mainFrame\)\s*throw new Error\("Untrusted IPC sender"\)/,
  );
  // The handler behind the cloud router (electron/cloud): still in the caller's context.
  assert.match(main, /const routed = cloudSync\.route\(name, fn\);/);
  assert.match(
    main,
    /callerWindows\.run\(caller, \(\) => routed\(\.\.\.args\)\)/,
  );
  // Private device execution copies stay internal; public events still reach
  // every app window and menu commands the focused one.
  const syntax = ts.createSourceFile(
    "main.ts",
    main,
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = (name: string) => {
    const found = syntax.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    );
    assert.ok(found?.body, `${name} has a function body`);
    assert.equal(found.parameters.length, 1);
    assert.equal(found.parameters[0].name.getText(syntax), "event");
    assert.equal(found.parameters[0].type?.getText(syntax), "AppEvent");
    return found.body;
  };
  const call = (node: ts.Node, name: string) => {
    assert.ok(ts.isCallExpression(node), `${name} is called`);
    assert.equal(node.expression.getText(syntax), name);
    return node;
  };
  const expression = (node: ts.Statement) => {
    assert.ok(ts.isExpressionStatement(node));
    return node.expression;
  };
  const pushed = declaration("push").statements;
  assert.equal(
    pushed.length,
    2,
    "private guard precedes the sole public publish",
  );
  const guard = pushed[0];
  assert.ok(ts.isIfStatement(guard));
  const privateEvent = call(guard.expression, "emitPrivateDeviceEvent");
  assert.equal(privateEvent.arguments.length, 3);
  assert.equal(privateEvent.arguments[0].getText(syntax), "event");
  assert.equal(
    privateEvent.arguments[1].getText(syntax).replace(/\s+/g, ""),
    "mainState.store?.conversations??[]",
  );
  const observer = privateEvent.arguments[2];
  assert.ok(ts.isArrowFunction(observer));
  assert.equal(observer.parameters.length, 1);
  assert.equal(observer.parameters[0].name.getText(syntax), "value");
  const privateEmit = call(observer.body, "eventListeners.emit");
  assert.deepEqual(
    privateEmit.arguments.map((argument) => argument.getText(syntax)),
    ["value"],
  );
  assert.ok(
    ts.isReturnStatement(guard.thenStatement),
    "handled private events return before public routing",
  );
  assert.equal(guard.thenStatement.expression, undefined);
  assert.equal(guard.elseStatement, undefined);
  const publicPublish = call(expression(pushed[1]), "publish");
  assert.equal(publicPublish.arguments.length, 1);
  const localEvent = call(publicPublish.arguments[0], "cloudSync.localEvent");
  assert.deepEqual(
    localEvent.arguments.map((argument) => argument.getText(syntax)),
    ["event"],
  );

  const published = declaration("publish").statements;
  const emitIndex = published.findIndex(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      statement.expression.expression.getText(syntax) === "eventListeners.emit",
  );
  assert.ok(emitIndex >= 0, "public events reach main-process observers");
  assert.deepEqual(
    call(expression(published[emitIndex]), "eventListeners.emit").arguments.map(
      (argument) => argument.getText(syntax),
    ),
    ["event"],
  );
  const broadcast = published[emitIndex + 1];
  assert.ok(
    ts.isForOfStatement(broadcast),
    "each observer event is followed by the app-window broadcast",
  );
  const windows = call(broadcast.expression, "appWindows.all");
  assert.equal(windows.arguments.length, 0);
  assert.equal(broadcast.awaitModifier, undefined);
  assert.ok(ts.isVariableDeclarationList(broadcast.initializer));
  assert.ok(broadcast.initializer.flags & ts.NodeFlags.Const);
  assert.equal(broadcast.initializer.declarations.length, 1);
  assert.equal(
    broadcast.initializer.declarations[0].name.getText(syntax),
    "win",
  );
  assert.deepEqual(
    call(expression(broadcast.statement), "sendTo").arguments.map((argument) =>
      argument.getText(syntax),
    ),
    ["win", "event"],
  );
  assert.match(main, /installAppMenu\(sendCommand[,)]/);
  // The same guards as the main window: no navigation, confirmed links.
  const register = main.slice(
    main.indexOf("function registerAppWindow"),
    main.indexOf("async function loadRenderer"),
  );
  for (const guard of [
    "setWindowOpenHandler",
    '"will-frame-navigate"',
    '"will-navigate"',
    "artifactPreviews.has(event.url)",
  ])
    assert.ok(register.includes(guard), guard);
  assert.match(
    main,
    /registerAppWindow\(mainState\.window, \{ kind: "main" \}\)/,
  );
  // Separate windows close at sign-out and with the main window.
  const deactivate = main.slice(
    main.indexOf("async function deactivateAccount"),
    main.indexOf("async function activateAccount"),
  );
  assert.ok(deactivate.includes("appWindows.closeConversationWindows()"));
  assert.ok(deactivate.includes("deactivatingListeners.emitAsync()"));
  assert.ok(
    deactivate.indexOf("emitAsync") < deactivate.indexOf("engine?.stop()"),
  );
  assert.ok(deactivate.includes("remoteFolders.clear()"));
  // Signed out, the account's store and engine are gone from ctx (the "Sign in
  // to continue." guards need them undefined), after the engine has stopped.
  assert.ok(deactivate.includes("mainState.store = none"));
  assert.ok(deactivate.includes("mainState.engine = none"));
  assert.ok(
    deactivate.indexOf("engine?.stop()") <
      deactivate.indexOf("mainState.engine = none"),
  );
  // Window controls act on the window they were used in.
  assert.match(
    main,
    /const target = callerWindows\.getStore\(\) \?\? mainState\.window;/,
  );
});

test("a folder counts only in the environment it was chosen or used in", () => {
  const main = readSource("electron/main.ts");
  const allowed = main.slice(
    main.indexOf("function allowedFolder"),
    main.indexOf("function rememberAccountSession"),
  );
  assert.match(
    allowed,
    /item\.cwd === folder && sshHost\(item\.environment\) === host/,
  );
  assert.match(allowed, /remoteFolders\.get\(host\)\?\.has\(folder\)/);
  assert.match(allowed, /: selectedFolders\.has\(folder\)/);
});

test("a separate window never marks rows unread or ends the main window's incognito chat", () => {
  const events = source("src/app/useDesktopEvents.ts");
  assert.match(events, /mainWindow &&\s*finishedUnseen\(/);
  assert.match(
    events,
    /if \(mainWindow\)\s*for \(const c of s\.conversations\)/,
  );
  assert.match(events, /shownElsewhere\.has\((?:event\.)?conversation\.id\)/);
});

test("events from domain handlers reach every app window, and dialogs open over the calling window", () => {
  // Main-process code must not send to one window's webContents directly:
  // a separate conversation window would miss the change.
  for (const file of ["electron/ipc/workflow.ts", "electron/ipc/artifacts.ts"])
    assert.doesNotMatch(
      source(file).replace(/else context\.window\?\.webContents\.send/, ""),
      /context\.window\?\.webContents\.send\("app:event"/,
      file,
    );
  assert.match(
    source("electron/ipc/index.ts"),
    /push: \(event\) => ctx\.push\(event\)/,
  );
  const main = readSource("electron/main.ts");
  assert.match(
    main,
    /get window\(\) \{[^}]*return callerWindows\.getStore\(\) \?\? mainState\.window;/,
  );
  assert.match(
    main,
    /window: \(\) => appWindows\.focused\(\) \?\? mainState\.window/,
  );
});
