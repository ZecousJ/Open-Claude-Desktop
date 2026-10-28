import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const chrome =
  process.env.CHROME_PATH ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/chromium");
/** Independent local Chromium profile. No signed-in/reference tab is touched. */
test(
  "actual Chromium plugin upload page keeps the observed desktop and phone shell without modal overflow",
  { skip: !fs.existsSync(chrome), timeout: 30000 },
  async (t) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "claudex-b36-upload-layout-"),
    );
    let server: ReturnType<typeof createServer> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let socket: WebSocket | undefined;
    t.after(async () => {
      socket?.close();
      if (child && child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      if (server?.listening)
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const fixture = `
import React from "react";
import {createRoot} from "react-dom/client";
import ${JSON.stringify(path.join(root, "src/styles/00-foundation.css"))};
import ${JSON.stringify(path.join(root, "src/ui/menu.css"))};
import ${JSON.stringify(path.join(root, "src/styles/50-controls-menus.css"))};
import {PluginUploadPage} from ${JSON.stringify(path.join(root, "src/plugins/PluginUploadPage.tsx"))};
window.desktop = {
 onEvent:()=>()=>{}, customizeSkills:async()=>[],mcpServers:async()=>({servers:[]}),
 listPlugins:async()=>({plugins:[],marketplaces:[],loadErrors:[]}),listApprovedDirectory:async()=>[],linearStatus:async()=>({connected:false})
};
window.__ready = new Promise(resolve => {
 const observer = new MutationObserver(()=>{if(document.querySelector('.plugin-upload-drop') && document.querySelector('.plugin-upload-back')){observer.disconnect();requestAnimationFrame(()=>requestAnimationFrame(resolve));}});
 observer.observe(document.body,{childList:true,subtree:true});
});
createRoot(document.getElementById('root')).render(<PluginUploadPage onBack={()=>{}} onUploaded={()=>{}}/>);
`;
    await build({
      stdin: {
        contents: fixture,
        resolveDir: root,
        sourcefile: "customize-b36-fixture.tsx",
        loader: "tsx",
      },
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "chrome120",
      outdir: directory,
      entryNames: "fixture",
      assetNames: "assets/[name]-[hash]",
      define: {
        __CLAUDEX_SURFACE__: '"web"',
        __APP_VERSION__: '"fixture"',
        "process.env.NODE_ENV": '"production"',
      },
      external: ["/fonts/*", "virtual:preview-runtime/*"],
      loader: {
        ".woff2": "dataurl",
        ".woff": "dataurl",
        ".ttf": "dataurl",
        ".svg": "dataurl",
        ".png": "dataurl",
      },
      logLevel: "silent",
    });
    fs.writeFileSync(
      path.join(directory, "index.html"),
      '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><style>body{margin:0}html,body{width:100%;height:100%}#root{width:calc(100% - 288px);height:100%;margin-left:288px}@media(max-width:639px){#root{width:100%;margin-left:0}}</style></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>',
    );
    server = createServer((req, res) => {
      const file = path.join(
        directory,
        req.url === "/" ? "index.html" : path.basename(req.url ?? ""),
      );
      if (!fs.existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader(
        "Content-Type",
        file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "text/html",
      );
      res.end(fs.readFileSync(file));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const port = (server.address() as import("node:net").AddressInfo).port;
    child = spawn(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-extensions",
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-debugging-port=0",
        `--user-data-dir=${path.join(directory, "profile")}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const browserProcess = child;
    const endpoint = await new Promise<string>((resolve, reject) => {
      let text = "";
      browserProcess.on("error", reject);
      browserProcess.stderr!.on("data", (chunk) => {
        text += chunk;
        const line = text
          .split("\n")
          .find((line) => line.includes("DevTools listening on "));
        if (line) resolve(line.slice(line.indexOf("ws://")).trim());
      });
      browserProcess.on("exit", (code) =>
        reject(Error(`Chromium exited before ready: ${code}`)),
      );
    });
    socket = new WebSocket(endpoint);
    await once(socket, "open");
    const protocolSocket = socket;

    let next = 0;
    const pending = new Map<
      number,
      { resolve(value: any): void; reject(error: Error): void }
    >();
    protocolSocket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const promise = pending.get(message.id);
        pending.delete(message.id);
        message.error
          ? promise?.reject(Error(message.error.message))
          : promise?.resolve(message.result);
      }
    });
    let session: string | undefined;
    const call = (method: string, params: object = {}, scoped = true) =>
      new Promise<any>((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        protocolSocket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(scoped && session ? { sessionId: session } : {}),
          }),
        );
      });
    const target = await call(
      "Target.createTarget",
      { url: "about:blank" },
      false,
    );
    session = (
      await call(
        "Target.attachToTarget",
        { targetId: target.targetId, flatten: true },
        false,
      )
    ).sessionId;
    const evaluate = async (expression: string) => {
      const result = await call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      assert.equal(
        result.exceptionDetails,
        undefined,
        JSON.stringify(result.exceptionDetails),
      );
      return result.result.value;
    };
    await call("Page.enable");
    await call("Runtime.enable");
    await call("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await call("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    await evaluate(
      `new Promise(resolve=>{if(document.readyState==='complete')resolve();else window.addEventListener('load',resolve,{once:true});}).then(()=>window.__ready)`,
    );
    const measure = () =>
      evaluate(
        `(()=>{const rect=s=>{const el=document.querySelector(s),r=el.getBoundingClientRect(),style=getComputedStyle(el);return {x:r.x,y:r.y,width:r.width,height:r.height,font:style.fontSize,line:style.lineHeight,radius:style.borderRadius,color:style.color,background:style.backgroundColor}};return {width:innerWidth,scroll:document.documentElement.scrollWidth,back:rect('.plugin-upload-back'),title:rect('h2'),lead:rect('.plugin-upload-content > p'),note:rect('.plugin-upload-warning[role="note"]'),label:rect('.plugin-upload-label'),drop:rect('.plugin-upload-drop'),rules:rect('.plugin-upload-rules'),upload:rect('.button-row .primary'),cancel:rect('.button-row .secondary'),hint:rect('.button-row > span')}})()`,
      );
    for (const width of [1280, 390]) {
      await call("Emulation.setDeviceMetricsOverride", {
        width,
        height: width === 1280 ? 720 : 844,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      const measured = await measure();
      t.diagnostic(JSON.stringify(measured));
      assert.equal(measured.scroll, width);
      assert.equal(measured.title.x, width === 1280 ? 328 : 20);
      assert.equal(measured.title.y, 112);
      assert.equal(measured.title.height, 28);
      assert.equal(measured.title.font, "22px");
      assert.equal(measured.title.line, "28px");
      assert.equal(measured.drop.width, width === 1280 ? 912 : 350);
      assert.equal(measured.drop.height, width === 1280 ? 118 : 138);
      assert.equal(measured.drop.radius, "12px");
      assert.equal(measured.label.y, width === 1280 ? 288 : 388);
      assert.equal(measured.drop.y, width === 1280 ? 316 : 416);
      assert.equal(measured.upload.y, width === 1280 ? 487 : 641);
      assert.equal(measured.rules.font, "13px");
      assert.equal(measured.rules.line, "17px");
      assert.equal(measured.upload.height, 32);
      assert.equal(measured.cancel.height, 32);
      assert.equal(
        measured.cancel.x - measured.upload.x - measured.upload.width,
        12,
      );
    }
  },
);
