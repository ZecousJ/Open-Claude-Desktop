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
import { defaultSettings } from "../../electron/store/store";
const root = fileURLToPath(new URL("../../", import.meta.url));
const chrome =
  process.env.CHROME_PATH ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/chromium");
/** Independent local Chromium profile. No signed-in/reference tab is touched. */
test(
  "actual Chromium Customize viewport wraps keep source headings and controls reachable without horizontal overflow",
  { skip: !fs.existsSync(chrome), timeout: 30000 },
  async (t) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "claudex-b36-layout-"),
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
import {CustomizePage} from ${JSON.stringify(path.join(root, "src/collections/customize/CustomizePage.tsx"))};
window.desktop = {
 onEvent:()=>()=>{}, customizeSkills:async()=>[],mcpServers:async()=>({servers:[]}),
 listPlugins:async()=>({plugins:[{id:'data@knowledge-work-plugins',name:'data',title:'Data',marketplace:'knowledge-work-plugins',marketplacePath:'/m',installed:false,enabled:true,installable:true,source:'git',category:'data',description:'Query, chart and explain your data — SQL, spreadsheets and dashboards in one place.'},{id:'docs@knowledge-work-plugins',name:'docs',title:'Docs',marketplace:'knowledge-work-plugins',marketplacePath:'/m',installed:false,enabled:true,installable:true,source:'git',category:'productivity',description:'Write documents'}],marketplaces:[{name:'knowledge-work-plugins',path:'/m',plugins:2,source:'git'}],loadErrors:[]}),listApprovedDirectory:async()=>[{id:'e',kind:'plugin',name:'Docs',slug:'docs',description:'',url:'https://fixture.invalid',added:'2026-10-01T00:00:00Z',curation:{isNew:true,popular:true}}],linearStatus:async()=>({connected:false})
};
window.__ready = new Promise(resolve => {
 const observer = new MutationObserver(()=>{if(document.querySelector('.customize-feature') && document.querySelector('.plugin-discovery-heading')){observer.disconnect();requestAnimationFrame(()=>requestAnimationFrame(resolve));}});
 observer.observe(document.body,{childList:true,subtree:true});
});
createRoot(document.getElementById('root')).render(<CustomizePage settings={${JSON.stringify(defaultSettings)}} route={{section:'skills',view:'discover'}} onUseSkill={()=>{}} onOpenSettings={()=>{}} onConfirmRemove={()=>{}} onError={e=>{throw e}}/>);
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
      '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"><style>body{margin:0}html,body,#root{width:100%;height:100%}</style></head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>',
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
        // Overlay scrollbars, as on the Macs the layout was measured on; a
        // runner with classic scrollbars would take 11px off every width.
        "--hide-scrollbars",
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
        `(()=>{const rect=s=>{const el=document.querySelector(s),r=el.getBoundingClientRect(),style=getComputedStyle(el);return {x:r.x,y:r.y,width:r.width,height:r.height,font:style.fontSize,line:style.lineHeight}};return {searchInput:!!document.querySelector('input[aria-label="Search"]'),searchButton:!!document.querySelector('button[aria-label="Search"]'),width:innerWidth,scroll:document.documentElement.scrollWidth,view:document.querySelector('.customize-view').scrollWidth,title:rect('h1'),tabs:rect('.customize-tabs'),hero:rect('.customize-feature'),heroTitle:rect('.customize-feature h3'),shelf:rect('.plugin-discovery-heading h3'),tools:rect('.customize-tools'),nav:rect('.customize-nav'),tryButton:rect('.customize-catalogue-try'),addButton:rect('.customize-catalogue-add'),card:rect('.customize-catalogue-cards .customize-card'),buttons:[...document.querySelectorAll('.customize-head button')].map(el=>({label:el.getAttribute('aria-label')||el.textContent.trim(),x:el.getBoundingClientRect().x,right:el.getBoundingClientRect().right,y:el.getBoundingClientRect().y}))}})()`,
      );
    for (const width of [390, 768, 1040]) {
      await call("Emulation.setDeviceMetricsOverride", {
        width,
        height: 844,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      const measured = await measure();
      t.diagnostic(JSON.stringify(measured));
      assert.equal(measured.searchInput, width === 1040);
      assert.equal(measured.searchButton, width !== 1040);
      assert.equal(measured.scroll, width);
      assert.equal(measured.view, width);
      assert.equal(measured.title.x, width === 390 ? 24 : 40);
      assert.equal(measured.title.y, 56);
      assert.equal(measured.title.height, 32);
      for (const button of measured.buttons)
        assert.ok(
          button.x >= 0 && button.right <= width,
          `${width}: ${button.label} escaped viewport`,
        );
      assert.equal(measured.tabs.y, 112);
      assert.equal(measured.tabs.height, 32);
      // // /tmp/claudex-b35-evidence/official-customize-{390,768}.png.
      if (width === 390 || width === 768) {
        assert.equal(measured.hero.height, 195);
        assert.equal(measured.heroTitle.x, width === 390 ? 48 : 64);
        assert.equal(measured.heroTitle.y, width === 390 ? 309 : 221);
        assert.equal(measured.heroTitle.font, "22px");
        assert.equal(measured.heroTitle.line, "28px");
      }
      if (width === 390) assert.ok(measured.tools.y > measured.tabs.y);
      // below 640px Try is a 28×28 icon, 12px before Add, both 14px inside a
      // 342×105 card; wider it reads "Try".
      if (width === 390) {
        assert.deepEqual(
          [measured.card.x, measured.card.width, measured.card.height],
          [24, 342, 105],
        );
        assert.deepEqual(
          [measured.tryButton.x, measured.tryButton.width],
          [284, 28],
        );
        assert.deepEqual(
          [measured.addButton.x, measured.addButton.width],
          [324, 28],
        );
      } else
        // Content-sized (10px padding, the glyph 4px into it, 6px gap):
        // the live English button is 60.5px in its own font.
        assert.ok(
          Math.abs(measured.tryButton.width - 60.5) <= 7,
          String(measured.tryButton.width),
        );
    }
  },
);
