import { observeAccountTransition, accountDeactivated, accountForcedSignedOut } from "../electron/app/account-transition-events";
/** Actual window.ts wiring, inert Electron/service mocks; no sockets or windows. */
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "official-stage-"));
for (const dir of ["ui", "data", "host"]) fs.mkdirSync(path.join(root, dir));
fs.writeFileSync(path.join(root, "ui/index.html"), "inert");
fs.writeFileSync(
  path.join(root, "manifest.json"),
  JSON.stringify({ generatedAt: "fixture" }),
);
fs.writeFileSync(
  path.join(root, "data/capabilities.json"),
  JSON.stringify({ configurations: [{}] }),
);
fs.writeFileSync(path.join(root, "data/display-settings.json"), "{}");
fs.writeFileSync(path.join(root, "data/build.json"), "{}");
fs.writeFileSync(path.join(root, "host/window-manager.cjs"), fs.readFileSync(path.resolve("build/official-ui/host/window-manager.cjs")));
fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ generatedAt: "fixture", hostWindowManager: {
  revision: "claudex-window-activation-v1", outputSha256: createHash("sha256").update(fs.readFileSync(path.join(root,"host/window-manager.cjs"))).digest("hex"),
} }));
fs.writeFileSync(path.join(root,"inert-manager.cjs"),"exports.setupWindowManager=()=>globalThis.__inertActivationManager");
process.env.CLAUDEX_OFFICIAL_UI_ROOT = root;
delete process.env.CLAUDEX_OFFICIAL_UI_E2E;
delete process.env.CLAUDEX_OFFICIAL_UI_DEVTOOLS;
const manager = {pendingWindows:new Map<string,any>(),windows:new Map<string,any>(),setupForWindow(){},destroy(){}};
(globalThis as any).__inertActivationManager=manager;
const servers: {closed:boolean;options:any}[]=[];
let nextContentsId:number|undefined;
let classicRecoveries=0;
const retirement = new Set<() => void>();
const state: any = {
  activeAccount: { id: "a" },
  store: {root: path.join(root, "account-a")},
  accountRetirement: { accountActivationIdentity: 1, accountRetiring: false },
};
let cookieWait: Promise<void> | undefined, nextLoad: Promise<void> | undefined;
const serverReady = deferred();
let serverWait: Promise<void> | undefined, serverFailure: Error | undefined;
let serverStarts = 0,
  clearCalls = 0;
const made: FakeWindow[] = [];
const cleanupOrder: string[] = [];
class FakeWindow extends EventEmitter {
  static count = 0;
  static getAllWindows() { return made.filter(win => !win.destroyed); }
  id = ++FakeWindow.count;
  destroyed = false;
  failDestroy = false;
  shown = false;
  load = nextLoad;
  webContents = Object.assign(new EventEmitter(), {
    id: this.id,
    session: undefined as unknown,
    getUserAgent: () => "fixture",
    setUserAgent() {},
  });
  constructor(_options?: unknown) {
    super();
    if(nextContentsId!==undefined){this.webContents.id=nextContentsId;nextContentsId=undefined;}
    this.webContents.session = (_options as any)?.webPreferences?.session;
    made.push(this);
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    cleanupOrder.push("destroy");
    if (this.failDestroy) throw Error("inert private destruction failure");
    this.destroyed = true;
    this.emit("closed");
  }
  hide() { this.shown = false; }
  enabled=true;
  setEnabled(enabled: boolean) {this.enabled=enabled;}
  show() {
    this.shown = true;
  }
  showInactive() {
    this.show();
  }
  async loadURL(_url: string) {
    this.emit("ready-to-show");
    await this.load;
  }
}
const ses = {
  clearCache: async () => {
    clearCalls++;
  },
  cookies: {
    set: async () => {
      await cookieWait;
    },
  },
  setPermissionRequestHandler() {},
  webRequest: { onBeforeRequest() {} },
};
const sessions = new Map<string, unknown>();
const staticPreviewHosts:any[]=[];
const mocks: Record<string, Record<string, unknown>> = {
  "./preview/static-session": {openStaticArtifactPreview:async()=>{throw Error("Real preview must not run in staged window tests.");}},
  "./preview/static-host": {createStaticArtifactPreviewHost:(_ctx:any,host:any)=>{staticPreviewHosts.push(host);return async()=>{throw Error("Preview source dispatch is not part of this wiring fixture.");};}},
  [path.join(root, "host/window-manager.cjs")]: { setupWindowManager: () => ({ setupForWindow() {}, destroy() {} }) },
  electron: {
    dialog: {showErrorBox(){}},
    app: {
      getPath: () => root,
      getVersion: () => "fixture",
      isPackaged: false,
    },
    BrowserWindow: FakeWindow,
    nativeImage: {},
    nativeTheme: {},
    session: { fromPartition: (partition: string) => { if (!sessions.has(partition)) sessions.set(partition, { ...ses, cookies: { ...ses.cookies } }); return sessions.get(partition); } },
  },
  "../app/main-state": { mainState: state },
  "../app/main-window": {createWindow:async({stage}:any)=>{assert.equal(stage.current(),true);classicRecoveries++;const win=new FakeWindow();state.window=win;return win;}},
  "../main": {
    dirname: root,
    cloudSync: { confirmedUploadReceipt() { throw Error("Unexpected receipt read in window lifecycle fixture"); } },
    localCall() {},
    routedCall() {},
    onAppEvent: () => () => {},
    selectedFolders: new Map(),
    callerWindows: { run: (_: unknown, fn: () => unknown) => fn() },
    ctx: {},
    deactivatingListeners: {
      add: (fn: () => void) => {
        retirement.add(fn);
        return () => retirement.delete(fn);
      },
    },
  },
  "./checkout-window": {
    checkoutContents() {},
    evalInCheckoutWindow() {},
    openCheckoutWindow() {},
  },
  "./api/native-account-api": {
    createNativeAccountApi: () => async () => false,
  },
  "./native/index": {
    createNativeHost: () => ({
      host: {
        attach() {},
        detach() {
          cleanupOrder.push("detach");
        },
      },
    }),
  },
  "./native/pdf-preview": {
    nativePdfPreviewState() {},
    captureNativePdfPreview() {},
  },
  "./usercontent": {
    userContentOrigin: "https://fixture.invalid",
    createUserContentHandler() {},
  },
  "./document-preview": {
    createDocumentPreviewService: () => ({}),
  },
  "../workspace/office-conversion": {
    convertOfficeDocument() {},
  },
  "./server": {
    cookieName: "fixture-cookie",
    startOfficialUiServer: async (options:any) => {
      const id = ++serverStarts;
      await serverReady.promise;
      await serverWait;
      if (serverFailure) throw serverFailure;
      const record={closed:false,options};servers.push(record);
      return { origin: `http://localhost:${30000 + id}`, token: `inert-${id}`, close: async () => {record.closed=true;} };
    },
  },
};
(globalThis as any).__stageWiringMocks = mocks;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === path.join(root,"host/window-manager.cjs")) return {shortCircuit:true,url:pathToFileURL(path.join(root,"inert-manager.cjs")).href};
    if (
      (context.parentURL
        ?.split("?")[0]
        .endsWith("/electron/official-ui/window.ts") ||
        specifier === "electron") &&
      mocks[specifier]
    ) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `const m=globalThis.__stageWiringMocks[${JSON.stringify(specifier)}];` +
              Object.keys(mocks[specifier])
                .map((k) => `export const ${k}=m.${k};`)
                .join(""),
          ),
      };
    }
    return next(specifier, context);
  },
});
const { createOfficialWindow } = await import("../electron/official-ui/window");
function reset() {
  state.activeAccount = { id: "a" };
  state.store = {root: path.join(root, "account-a")};
  state.accountRetirement.accountActivationIdentity++;
  state.accountRetirement.accountRetiring = false;
  state.window = new FakeWindow();
  cookieWait = undefined;
  nextLoad = undefined;
  return state.window as FakeWindow;
}
function retire() {
  state.accountRetirement.accountRetiring = true;
  state.accountRetirement.accountActivationIdentity++;
  for (const fn of [...retirement]) fn();
}
async function until(predicate: () => boolean) {
  for (let i = 0; !predicate() && i < 50; i++)
    await new Promise((r) => setImmediate(r));
  assert.ok(predicate());
}
test("shared server late completion cannot commit retired creation, nor close the shared server", async () => {
  const old = reset(),
    count = made.length;
  const pending = createOfficialWindow();
  await until(() => serverStarts === 1);
  retire();
  serverReady.resolve();
  await assert.rejects(pending, /account or main window changed/);
  assert.equal(made.length, count);
  assert.equal(state.window, old);
  assert.equal(old.destroyed, false);
});
test("ready-to-show is not a commit: pending load retains login; retirement destroys only its candidate", async () => {
  const old = reset(),
    wait = deferred();
  nextLoad = wait.promise;
  const count = made.length,
    pending = createOfficialWindow();
  await until(() => made.length > count);
  const candidate = made.at(-1)!;
  assert.equal(candidate.shown, false);
  assert.equal(state.window, old);
  retire();
  assert.equal(candidate.destroyed, true);
  assert.equal(old.destroyed, false);
  reset();
  const newLogin = state.window;
  wait.resolve();
  await assert.rejects(pending, /account or main window changed/);
  assert.equal(state.window, newLogin);
  assert.equal(newLogin.destroyed, false);
});
test("cookie await retirement is rejected before window construction (already-issued cookie write not rolled back)", async () => {
  const old = reset(),
    wait = deferred();
  cookieWait = wait.promise;
  const count = made.length,
    pending = createOfficialWindow();
  await new Promise((r) => setImmediate(r));
  retire();
  wait.resolve();
  await assert.rejects(pending, /account or main window changed/);
  assert.equal(made.length, count);
  assert.equal(state.window, old);
});
test("same-account persistent storage waits old pending cookie write before starting replacement", async () => {
  reset(); const wait=deferred(); cookieWait=wait.promise;
  const pending=createOfficialWindow();
  await new Promise(resolve=>setImmediate(resolve));
  const oldServer=servers.at(-1)!; retire(); reset();
  const replacement=createOfficialWindow();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(servers.at(-1),oldServer);
  wait.resolve(); await assert.rejects(pending,/account or main window changed/);
  const win=await replacement; assert.ok(win); assert.equal(oldServer.closed,true);
  assert.equal(servers.at(-1)!.options.requireStablePort,true);
  assert.equal(servers.at(-1)!.options.portFile,oldServer.options.portFile);
});
test("concurrent candidates use main-pointer CAS and loser destroys only itself", async () => {
  reset();
  const wait = deferred();
  nextLoad = wait.promise;
  const count = made.length,
    loser = createOfficialWindow();
  await until(() => made.length > count);
  const loserWindow = made.at(-1)!;
  nextLoad = undefined;
  const winner = await createOfficialWindow();
  assert.equal(state.window, winner);
  assert.equal((winner as any).shown, true);
  wait.resolve();
  await assert.rejects(loser, /account or main window changed/);
  assert.equal(loserWindow.destroyed, true);
  assert.equal(winner.isDestroyed(), false);
});
test("load failure preserves previous main; extra success does not replace it; cleanup removes retirement subscriptions", async () => {
  const old = reset();
  nextLoad = Promise.reject(Error("inert load failure"));
  void nextLoad.catch(() => {});
  // Handler is installed by create/load in this same turn.
  const failure = createOfficialWindow();
  await assert.rejects(failure, /inert load failure/);
  assert.equal(state.window, old);
  assert.equal(old.destroyed, false);
  nextLoad = undefined;
  const extra = await createOfficialWindow({ extra: true });
  assert.equal(state.window, old);
  assert.equal((extra as any).shown, true);
  assert.equal(retirement.size, 1); // One live activation runtime; no candidate listener.
  assert.ok(serverStarts > 1); // Distinct activations no longer share a server.
  assert.equal(clearCalls, 1);
});
test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete (globalThis as any).__stageWiringMocks;
});

test("activation continuation is quiet on retirement and stale late errors, but reports current load failure without closing login", async () => {
  const { finishOfficialWindowActivation } =
    await import("../electron/official-ui/staged-window");
  let reports = 0,
    closes = 0;
  async function open() {
    const previous = state.window,
      generation = state.accountRetirement.accountActivationIdentity;
    return finishOfficialWindowActivation({
      create: () => createOfficialWindow(),
      previous,
      main: () => state.window,
      current: () =>
        generation === state.accountRetirement.accountActivationIdentity &&
        !state.accountRetirement.accountRetiring,
      close: () => {
        closes++;
      },
      reportFailure: () => {
        reports++;
      },
    });
  }
  reset();
  const wait = deferred();
  nextLoad = wait.promise;
  const count = made.length,
    pending = open();
  await until(() => made.length > count);
  retire();
  reset();
  const login = state.window;
  wait.resolve();
  await pending;
  assert.equal(reports, 0);
  assert.equal(closes, 0);
  assert.equal(state.window, login);
  nextLoad = Promise.reject(
    Error("https://fixture.invalid/private?token=not-for-dialog"),
  );
  void nextLoad.catch(() => {});
  await open();
  assert.equal(reports, 1);
  assert.equal(closes, 0);
  assert.equal(state.window, login);
  let reject!: (e: Error) => void;
  nextLoad = new Promise<void>((_, no) => {
    reject = no;
  });
  const count2 = made.length,
    late = open();
  await until(() => made.length > count2);
  retire();
  reset();
  const newLogin = state.window;
  reject(Error("late private setup error"));
  await late;
  assert.equal(reports, 1);
  assert.equal(state.window, newLogin);
  assert.equal(closes, 0);
});

test("actual retired load rejection is classified cancellation for cold-start policy, not a fatal raw ERR_ABORTED", async () => {
  const { OfficialWindowCreationCancelled } =
    await import("../electron/official-ui/staged-window");
  reset();
  let reject!: (error: Error) => void;
  nextLoad = new Promise<void>((_, fail) => {
    reject = fail;
  });
  const count = made.length,
    pending = createOfficialWindow();
  await until(() => made.length > count);
  retire();
  reset();
  const replacement = state.window;
  reject(Error("ERR_ABORTED private-url"));
  await assert.rejects(pending, OfficialWindowCreationCancelled);
  assert.equal(state.window, replacement);
  assert.equal(replacement.destroyed, false);
});

test("real window raw load rejection after retirement flows through actual cold startup without quit", async () => {
  const { runInertStartup } = await import("./support/startup-staging-fixture");
  reset();
  let reject!: (error: Error) => void;
  nextLoad = new Promise<void>((_, no) => {
    reject = no;
  });
  const count = made.length;
  const startup = runInertStartup(() => createOfficialWindow(), undefined);
  await until(() => made.length > count);
  retire();
  reject(Error("ERR_ABORTED private-url"));
  const result = await startup;
  assert.equal(result.started, true);
  assert.equal(result.quits, 0);
  assert.deepEqual(result.dialogs, []);
});
test("real shared-server rejection after retirement is cancellation before any candidate, including actual cold startup", async () => {
  const { runInertStartup } = await import("./support/startup-staging-fixture");
  reset();
  const wait = deferred();
  serverWait = wait.promise;
  const previousStarts = serverStarts,
    count = made.length;
  const fresh = await import(
    new URL(
      "../electron/official-ui/window.ts?inert-server-failure",
      import.meta.url,
    ).href
  );
  const startup = runInertStartup(
    () => fresh.createOfficialWindow(),
    undefined,
  );
  await until(() => serverStarts > previousStarts);
  retire();
  serverFailure = Error("private server failure");
  wait.resolve();
  const result = await startup;
  assert.equal(result.started, true);
  assert.equal(result.quits, 0);
  assert.deepEqual(result.dialogs, []);
  assert.equal(made.length, count);
  serverWait = undefined;
  serverFailure = undefined;
});

test("candidate authority is revoked before failed destruction; actual stale cold caller reports unconfirmed cleanup without quit", async (t) => {
  const { runInertStartup, retireInertStartup } =
    await import("./support/startup-staging-fixture");
  const log = t.mock.method(console, "error", () => {});
  reset();
  let reject!: (error: Error) => void;
  nextLoad = new Promise<void>((_, no) => {
    reject = no;
  });
  const count = made.length,
    startup = runInertStartup(() => createOfficialWindow(), undefined);
  await until(() => made.length > count);
  const candidate = made.at(-1)!;
  candidate.failDestroy = true;
  cleanupOrder.length = 0;
  assert.throws(() => retire(), /destruction failure/);
  retireInertStartup();
  assert.equal(cleanupOrder[0], "detach");
  assert.ok(cleanupOrder.indexOf("destroy") > cleanupOrder.indexOf("detach"));
  reject(Error("ERR_ABORTED"));
  const result = await startup;
  assert.equal(result.started, true);
  assert.equal(result.quits, 0);
  assert.deepEqual(result.dialogs, []);
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments),
    [["Retired official window cleanup was not confirmed."]],
  );
  assert.equal(candidate.destroyed, false);
  candidate.failDestroy = false;
  candidate.destroy();
});


test("actual native startup refuses missing, old or mismatched activation manager proof before constructing a window", async () => {
  const file=path.join(root,"manifest.json"), original=fs.readFileSync(file,"utf8");
  try {
    for(const hostWindowManager of [undefined,{revision:"old",outputSha256:"0".repeat(64)},{revision:"claudex-window-activation-v1",outputSha256:"0".repeat(64)}]) {
      reset();fs.writeFileSync(file,JSON.stringify({generatedAt:"fixture",hostWindowManager}));const count=made.length;
      await assert.rejects(createOfficialWindow(),/activation-bound window manager is unavailable/);assert.equal(made.length,count);
    }
    fs.writeFileSync(file,original);
    const managerFile=path.join(root,"host/window-manager.cjs"), bytes=fs.readFileSync(managerFile);
    try {
      fs.appendFileSync(managerFile,"\n// inert tamper");reset();const count=made.length;
      await assert.rejects(createOfficialWindow(),/activation-bound window manager is unavailable/);assert.equal(made.length,count);
    } finally {fs.writeFileSync(managerFile,bytes);}
  } finally {fs.writeFileSync(file,original);}
});

test("committed retirement hides/disables old private session; failed destruction retains denied server through A B A",async(t)=>{
 t.mock.method(console,"error",()=>{});reset();const a=await createOfficialWindow() as unknown as FakeWindow;
 const aServer=servers.at(-1)!;a.failDestroy=true;
 assert.equal(aServer.options.isCurrent(),true);
 for(const callback of [...retirement])callback();
 assert.equal(a.shown,false);assert.equal(a.enabled,false);assert.equal(aServer.options.isCurrent(),false);
 reset();state.activeAccount={id:"b"};const b=await createOfficialWindow() as unknown as FakeWindow;
 assert.notEqual(a.webContents.session,b.webContents.session);assert.equal(a.destroyed,false);assert.equal(aServer.closed,false);
 const bServer=servers.at(-1)!;reset();
 const beforeBlocked=serverStarts;await assert.rejects(createOfficialWindow(),/destruction failure/);assert.equal(serverStarts,beforeBlocked);
 a.failDestroy=false;a.destroy();const again=await createOfficialWindow() as unknown as FakeWindow;
 assert.equal(again.webContents.session,a.webContents.session);assert.notEqual(again.webContents.session,b.webContents.session);
 assert.equal(aServer.options.isCurrent(),false);assert.equal(bServer.options.isCurrent(),false);
 const starts=serverStarts;await createOfficialWindow({extra:true});assert.equal(serverStarts,starts);
 a.failDestroy=false;a.destroy();
});
test("retired manager cleanup cannot delete records for reused numeric owner ID bound to new runtime",async(t)=>{
 t.mock.method(console,"error",()=>{});reset();const old=await createOfficialWindow() as unknown as FakeWindow;
 const id=old.webContents.id;let destroyed=0;
 reset();nextContentsId=id;const gate=deferred();nextLoad=gate.promise;
 // New candidate binds its real WebContents before awaiting load; old runtime was already retired.
 const pending=createOfficialWindow();await until(()=>made.at(-1)?.webContents.id===id&&made.at(-1)!==old);
 const candidate=made.at(-1)!;const record={ownerWebContentsId:id,instance:{destroy(){destroyed++;}}};
 manager.windows.set("new-owned",record);manager.pendingWindows.set("new-pending",record);
 // End the candidate's local inert load; no actual renderer runs.
 gate.resolve();await pending;
 assert.equal(manager.windows.get("new-owned"),record);assert.equal(manager.pendingWindows.get("new-pending"),record);
 assert.equal(destroyed,0);
 manager.windows.delete("new-owned");manager.pendingWindows.delete("new-pending");nextLoad=undefined;
});

test("actual window retirement waits owned logout settlement and response close before classic recovery",async(t)=>{
 t.mock.method(console,"error",()=>{});reset();const old=await createOfficialWindow() as unknown as FakeWindow;
 const runtime=servers.at(-1)!;const finished=deferred(),operation=deferred();
 runtime.options.responseLease.trackResponse({finished:finished.promise,abort(){finished.resolve();}});
 const store=state.store,generation=state.accountRetirement.accountActivationIdentity;
 const before=classicRecoveries;
 const logout=observeAccountTransition("logoutAccount",{store,generation},async()=>{
   state.accountRetirement.accountRetiring=true;
   for(const callback of [...retirement])callback();
   state.store=undefined;state.activeAccount=undefined;
   accountDeactivated(store,generation);await operation.promise;
 });
 assert.equal(old.shown,false);assert.equal(old.enabled,false);
 await new Promise(r=>setImmediate(r));assert.equal(classicRecoveries,before);
 operation.resolve();await logout;await new Promise(r=>setImmediate(r));assert.equal(classicRecoveries,before);
 finished.resolve();await until(()=>classicRecoveries===before+1);
 assert.equal(old.destroyed,true);assert.equal(runtime.closed,true);
 accountForcedSignedOut(store,generation);await new Promise(r=>setImmediate(r));assert.equal(classicRecoveries,before+1);
});

test("static preview callback uses actual committed window WebContents runtime binding, never staged/login window",async()=>{
 const old=reset(),load=deferred();nextLoad=load.promise;const before=staticPreviewHosts.length;const pending=createOfficialWindow();
 await until(()=>staticPreviewHosts.length>before&&made.at(-1)!==old);const host=staticPreviewHosts.at(-1)!;assert.equal(host.committedWindow(),undefined);
 load.resolve();const committed=await pending;assert.equal(host.committedWindow(),committed);assert.equal(host.current(),true);
 state.window=new FakeWindow();assert.equal(host.committedWindow(),undefined);state.window=committed;
 let notices=0;const off=host.onRetire(()=>notices++);retire();assert.equal(notices,1);assert.equal(host.current(),false);off();
});
