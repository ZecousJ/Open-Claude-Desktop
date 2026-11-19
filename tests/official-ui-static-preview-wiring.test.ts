/** Actual production opener import; Electron and HTTP listener are fully inert. No sockets/windows. */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerHooks } from "node:module";
const ipc = new EventEmitter(),
  wins: any[] = [],
  sessions: any[] = [],
  channels: any[] = [],
  servers: any[] = [];
class Port extends EventEmitter {
  closed = false;
  sent: any[] = [];
  start() {}
  close() {
    this.closed = true;
  }
  postMessage(x: any) {
    this.sent.push(x);
  }
}
class Win extends EventEmitter {
  destroyed = false;
  shown = false;
  failDestroy = false;
  options: any;
  webContents: any;
  constructor(options: any = {}) {
    super();
    this.options = options;
    this.webContents = Object.assign(new EventEmitter(), {
      id: wins.length + 1,
      mainFrame: { url: "", parent: null, frames: [] as any[] },
      open: undefined as undefined | (() => unknown),
      setWindowOpenHandler(fn: any) {
        this.open = fn;
      },
      send() {},
      postMessage: (name: string, value: any, ports: any[]) => {
        this.webContents.transfer = { name, value, ports };
      },
    });
    wins.push(this);
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    if (this.failDestroy) throw Error("inert destroy failure");
    this.destroyed = true;
    this.emit("closed");
  }
  show() {
    this.shown = true;
  }
  async loadURL(url: string) {
    this.webContents.mainFrame.url = url;
  }
}
const mock = {
  BrowserWindow: Win,
  ipcMain: ipc,
  MessageChannelMain: class {
    port1 = new Port();
    port2 = new Port();
    constructor() {
      channels.push(this);
    }
  },
  session: {
    fromPartition: (partition: string) => {
      const s = Object.assign(new EventEmitter(), {
        partition,
        permission: undefined as undefined | ((...args: any[]) => unknown),
        permissionCheck: undefined as undefined | (() => unknown),
        setPermissionRequestHandler(fn: any) {
          this.permission = fn;
        },
        setPermissionCheckHandler(fn: any) {
          this.permissionCheck = fn;
        },
        webRequest: {
          before: undefined as undefined | ((...args: any[]) => unknown),
          onBeforeRequest(fn: any) {
            this.before = fn;
          },
        },
      });
      sessions.push(s);
      return s;
    },
  },
};
let pauseListen = false;
let finishListen = () => {};
const http = {
  createServer: (handler: any) => {
    const server = Object.assign(new EventEmitter(), {
      handler,
      closed: false,
      closes: 0,
      listen(_p: any, host: any, fn: any) {
        assert.equal(host, "127.0.0.1");
        if (pauseListen)
          finishListen = () => {
            this.closed = false;
            fn();
          };
        else fn();
      },
      address: () => ({ port: 31415 + servers.length }),
      close() {
        this.closes++;
        this.closed = true;
      },
      closeAllConnections() {},
    });
    servers.push(server);
    return server;
  },
};
(globalThis as any).__staticPreviewMocks = { mock, http };
registerHooks({
  resolve(spec, ctx, next) {
    if (
      ctx.parentURL?.endsWith("/preview/static-session.ts") &&
      ["electron", "node:http"].includes(spec)
    ) {
      const source =
        spec === "electron"
          ? "const m=globalThis.__staticPreviewMocks.mock;export const {BrowserWindow,ipcMain,MessageChannelMain,session}=m;"
          : "export default globalThis.__staticPreviewMocks.http;";
      return {
        shortCircuit: true,
        url: "data:text/javascript," + encodeURIComponent(source),
      };
    }
    return next(spec, ctx);
  },
});
const { openStaticArtifactPreview } =
  await import("../electron/official-ui/preview/static-session");
const nonce = "a".repeat(64);
async function fixture() {
  wins.length = sessions.length = channels.length = servers.length = 0;
  let active = true,
    retire = () => {};
  const owner = new Win();
  const promise = openStaticArtifactPreview({
    document: "<h1>SELF AUTHORED INERT</h1>",
    current: () => active,
    ownerWindow: owner as any,
    preloadPath: "/fixed/static-preload.cjs",
    onRetire: (fn) => {
      retire = fn;
      return () => {};
    },
  });
  void promise.catch(() => {});
  await new Promise((r) => setImmediate(r));
  const win = wins[1];
  return {
    owner,
    win,
    promise,
    retire: () => {
      active = false;
      retire();
    },
    ready(value: any = { nonce }, frame = win.webContents.mainFrame) {
      ipc.emit(
        "claudex-static-preview-ready",
        { sender: win.webContents, senderFrame: frame },
        value,
      );
    },
    ack(value: any = { type: "ack", nonce }) {
      channels[0].port1.emit("message", { data: value });
    },
  };
}
test("private nonpersistent shell receives no content until exact frame nonce ACK, then opens", async () => {
  const f = await fixture();
  assert.equal(sessions[0].partition.startsWith("persist:"), false);
  assert.equal(f.win.options.webPreferences.nodeIntegrationInSubFrames, false);
  assert.equal(f.win.options.webPreferences.contextIsolation, true);
  assert.equal(f.win.options.webPreferences.sandbox, true);
  f.ready();
  assert.equal(channels[0].port1.sent.length, 0);
  assert.deepEqual(f.win.webContents.transfer.value, { nonce });
  f.ack();
  assert.deepEqual(await f.promise, { opened: true });
  assert.equal(
    channels[0].port1.sent[0].document,
    "<h1>SELF AUTHORED INERT</h1>",
  );
  assert.equal(f.win.shown, true);
  f.retire();
  assert.equal(channels[0].port1.closed, true);
  assert.equal(f.win.destroyed, true);
});
test("wrong frame, wrong nonce and duplicate ready fail closed without artifact delivery", async () => {
  for (const scenario of ["frame", "nonce", "duplicate"]) {
    const f = await fixture();
    if (scenario === "frame")
      f.ready({ nonce }, { url: f.win.webContents.mainFrame.url });
    else {
      f.ready();
      if (scenario === "nonce") f.ack({ type: "ack", nonce: "b".repeat(64) });
      else f.ready();
    }
    await assert.rejects(f.promise, /Static preview/);
    assert.ok(channels.every((c) => c.port1.sent.length === 0));
    assert.equal(f.win.destroyed, true);
  }
});
test("retirement before ACK and stale ACK cannot revive channel even if candidate destroy fails", async () => {
  const f = await fixture();
  f.ready();
  f.win.failDestroy = true;
  f.retire();
  f.ack();
  await assert.rejects(f.promise);
  assert.equal(channels[0].port1.sent.length, 0);
  assert.equal(channels[0].port1.closed, true);
  assert.equal(servers[0].closed, true);
});
test("dedicated Session denies all later network, permissions, download and popup paths", async () => {
  const f = await fixture();
  const s = sessions[0],
    results: any[] = [];
  s.webRequest.before(
    {
      webContentsId: f.win.webContents.id,
      resourceType: "mainFrame",
      url: f.win.webContents.mainFrame.url,
    },
    (x: any) => results.push(x),
  );
  s.webRequest.before(
    {
      webContentsId: f.win.webContents.id,
      resourceType: "mainFrame",
      url: f.win.webContents.mainFrame.url,
    },
    (x: any) => results.push(x),
  );
  s.webRequest.before(
    {
      webContentsId: f.win.webContents.id,
      resourceType: "image",
      url: "https://inert.invalid/probe",
    },
    (x: any) => results.push(x),
  );
  assert.deepEqual(results, [
    { cancel: false },
    { cancel: true },
    { cancel: true },
  ]);
  assert.deepEqual(f.win.webContents.open(), { action: "deny" });
  assert.equal(s.permissionCheck(), false);
  let prevented = false;
  s.emit("will-download", {
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  f.retire();
  await assert.rejects(f.promise);
});
test("public shell endpoint rejects cookie, auth, method and unexpected host/path without reflecting data", async () => {
  const f = await fixture();
  const url = new URL(f.win.webContents.mainFrame.url);
  for (const req of [
    { headers: { host: url.host, cookie: "inert" }, url: "/", method: "GET" },
    {
      headers: { host: url.host, authorization: "inert" },
      url: "/",
      method: "GET",
    },
    { headers: { host: "wrong.invalid" }, url: "/", method: "GET" },
    { headers: { host: url.host }, url: "/other", method: "GET" },
    { headers: { host: url.host }, url: "/", method: "POST" },
  ]) {
    let status = 0,
      body = "";
    servers[0].handler(req, {
      writeHead(n: number) {
        status = n;
      },
      end(x = "") {
        body = x;
      },
    });
    assert.equal(status, 403);
    assert.equal(body, "");
  }
  f.retire();
  await assert.rejects(f.promise);
});
test("owner navigation retires mounted preview; no automatic reopen or replay", async () => {
  const f = await fixture();
  f.ready();
  f.ack();
  await f.promise;
  f.owner.webContents.emit("did-start-navigation");
  assert.equal(f.win.destroyed, true);
  assert.equal(channels[0].port1.closed, true);
  assert.equal(wins.length, 2);
});

test("retirement during pending listen closes a late listener without constructing a window", async () => {
  pauseListen = true;
  wins.length = servers.length = 0;
  let retire = () => {};
  const owner = new Win();
  const pending = openStaticArtifactPreview({
    document: "inert",
    current: () => true,
    ownerWindow: owner as any,
    preloadPath: "/fixed/preload",
    onRetire: (fn) => {
      retire = fn;
      return () => {};
    },
  });
  void pending.catch(() => {});
  retire();
  assert.equal(servers[0].closes, 1);
  // Retirement settles the opener even if listen never calls back.
  await assert.rejects(pending, /Static preview/);
  finishListen();
  assert.equal(servers[0].closed, true);
  assert.equal(servers[0].closes, 2);
  assert.equal(wins.length, 1);
  pauseListen = false;
});
test("ready shell navigation is blocked and handshake deadline has a bounded rejection", async (t) => {
  const f = await fixture();
  f.ready();
  let prevented = false;
  f.win.webContents.emit("will-frame-navigate", {
    isMainFrame: true,
    url: f.win.webContents.mainFrame.url,
    preventDefault() {
      prevented = true;
    },
  });
  await assert.rejects(f.promise);
  assert.equal(prevented, true);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const g = await fixture();
  t.mock.timers.tick(10000);
  await assert.rejects(g.promise);
  assert.equal(g.win.destroyed, true);
  t.mock.timers.reset();
});
test("port delivery failure rejects only its preview without uncaught event error", async () => {
  const f = await fixture();
  f.ready();
  channels[0].port1.postMessage = () => {
    throw Error("inert send failure");
  };
  assert.doesNotThrow(() => f.ack());
  await assert.rejects(f.promise);
  assert.equal(f.win.destroyed, true);
});
test("denied navigation cancels before retiring its preview, unlike denied passive resources", async () => {
  const f = await fixture();
  f.ready();
  f.ack();
  await f.promise;
  const s = sessions[0];
  s.webRequest.before(
    {
      webContentsId: f.win.webContents.id,
      resourceType: "image",
      url: "http://127.0.0.1:1/inert-image",
    },
    (r: any) => assert.equal(r.cancel, true),
  );
  assert.equal(f.win.destroyed, false);
  let callbackSeen = false;
  s.webRequest.before(
    {
      webContentsId: f.win.webContents.id,
      resourceType: "subFrame",
      url: "http://127.0.0.1:1/inert-link",
    },
    (r: any) => {
      assert.equal(r.cancel, true);
      assert.equal(f.win.destroyed, false);
      callbackSeen = true;
    },
  );
  assert.equal(callbackSeen, true);
  assert.equal(f.win.destroyed, true);
  assert.equal(channels[0].port1.closed, true);
});

test("CSP-denied direct artifact navigation retires, but deeper iframe resource failures do not", async () => {
  const f = await fixture();
  f.ready();
  f.ack();
  await f.promise;
  const main = f.win.webContents.mainFrame;
  const inner = { processId: 11, routingId: 22, parent: main };
  main.frames = [inner];
  f.win.webContents.emit(
    "did-fail-load",
    {},
    -30,
    "blocked",
    "http://inert.invalid/nested",
    false,
    11,
    33,
  );
  assert.equal(f.win.destroyed, false);
  f.win.webContents.emit(
    "did-fail-load",
    {},
    -30,
    "blocked",
    "http://inert.invalid/link",
    false,
    11,
    22,
  );
  assert.equal(f.win.destroyed, true);
  assert.equal(channels[0].port1.closed, true);
});
