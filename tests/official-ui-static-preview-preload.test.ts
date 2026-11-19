import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { JSDOM } from "jsdom";
import { webcrypto } from "node:crypto";
import { staticPreviewShell } from "../electron/official-ui/preview/static-documents";
const source = fs.readFileSync(
  new URL(
    "../electron/official-ui/preview/static-preload.cjs",
    import.meta.url,
  ),
  "utf8",
);
function fixture(url = "http://127.0.0.1:31415/", main = true) {
  const dom = new JSDOM(staticPreviewShell, { url });
  const ipc = new EventEmitter() as EventEmitter & {
    send: (...x: any[]) => void;
  };
  const sent: any[] = [];
  ipc.send = (...x) => sent.push(x);
  vm.runInNewContext(source, {
    require: (name: string) => {
      assert.equal(name, "electron");
      return { ipcRenderer: ipc };
    },
    process: {
      isMainFrame: main,
      argv: ["--claudex-static-preview-shell=http://127.0.0.1:31415/"],
    },
    location: dom.window.location,
    document: dom.window.document,
    crypto: webcrypto,
    Uint8Array,
    TextEncoder,
    addEventListener: dom.window.addEventListener.bind(dom.window),
  });
  dom.window.dispatchEvent(new dom.window.Event("DOMContentLoaded"));
  return { dom, ipc, sent };
}
function port() {
  return {
    onmessage: undefined as undefined | ((e: any) => void),
    closed: false,
    sent: [] as any[],
    start() {},
    close() {
      this.closed = true;
    },
    postMessage(x: any) {
      this.sent.push(x);
    },
  };
}
test("exact dedicated top document alone installs private IPC; no contextBridge or renderer API", () => {
  for (const [url, main] of [
    ["http://127.0.0.1:31415/other", true],
    ["http://127.0.0.1:31415/", false],
  ] as const) {
    const f = fixture(url, main);
    assert.equal(f.sent.length, 0);
    assert.equal(f.ipc.listenerCount("claudex-static-preview-bind"), 0);
    f.dom.window.close();
  }
});
test("preload only inserts payload in empty-sandbox inner frame after matching document nonce", () => {
  const f = fixture(),
    p = port();
  assert.equal(f.sent.length, 1);
  const nonce = f.sent[0][1].nonce;
  f.ipc.emit("claudex-static-preview-bind", { ports: [p] }, { nonce });
  assert.equal(p.sent[0].type, "ack");
  p.onmessage!({
    data: {
      type: "render",
      nonce,
      document: "<h1>Self authored</h1><script>inert()</script>",
    },
  });
  const inner = f.dom.window.document.querySelector("iframe")!;
  assert.equal(inner.getAttribute("sandbox"), "");
  assert.equal(
    inner.getAttribute("srcdoc"),
    "<h1>Self authored</h1><script>inert()</script>",
  );
  assert.equal(f.dom.window.document.querySelector("h1"), null);
  f.ipc.emit("claudex-static-preview-retire");
  assert.equal(p.closed, true);
  assert.equal(f.dom.window.document.querySelector("iframe"), null);
  f.dom.window.close();
});
test("wrong and duplicate port binding close offered ports; pagehide prevents late render", () => {
  const f = fixture(),
    p = port();
  f.ipc.emit("claudex-static-preview-bind", { ports: [p] }, { nonce: "wrong" });
  assert.equal(p.closed, true);
  const g = fixture(),
    q = port(),
    nonce = g.sent[0][1].nonce;
  g.ipc.emit("claudex-static-preview-bind", { ports: [q] }, { nonce });
  g.dom.window.dispatchEvent(new g.dom.window.Event("pagehide"));
  assert.equal(q.closed, true);
  assert.equal(q.onmessage, null);
  f.dom.window.close();
  g.dom.window.close();
});
