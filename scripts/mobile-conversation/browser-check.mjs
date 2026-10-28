import os from "node:os";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
import { fixture } from "./fixture.mjs";
const out = path.join(os.tmpdir(), "claudex-mobile-conversation-check");
await mkdir(out, { recursive: true });
const root = path.resolve("dist-mobile-conversation");
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".map": "application/json",
};
const server = createServer(async (req, res) => {
  try {
    const p = path.resolve(
      root,
      "." +
        decodeURIComponent(
          (req.url || "/").split("?")[0] === "/"
            ? "/index.html"
            : req.url.split("?")[0],
        ),
    );
    if (!p.startsWith(root + path.sep)) throw Error();
    const b = await readFile(p);
    res.writeHead(200, {
      "content-type": mime[path.extname(p)] || "application/octet-stream",
    });
    res.end(b);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(5198, "127.0.0.1", r));
const chrome = spawn(
  process.env.CHROME_PATH || "/usr/bin/chromium",
  [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--remote-debugging-port=9338",
    "--user-data-dir=/tmp/claudex-mobile-browser-qa",
    "about:blank",
  ],
  { stdio: "ignore" },
);
let ws,
  next = 0;
const pending = new Map();
const events = [];
const errors = [];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let pages;
  for (let i = 0; i < 50; i++) {
    try {
      pages = await (await fetch("http://127.0.0.1:9338/json")).json();
      break;
    } catch {
      await pause(100);
    }
  }
  ws = new WebSocket(pages.find((p) => p.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else {
      events.push(m);
      if (m.method === "Runtime.exceptionThrown")
        errors.push(m.params.exceptionDetails);
    }
  });
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await call("Runtime.enable");
  await call("Network.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__events=[];window.webkit={messageHandlers:{claudexConversation:{postMessage(e){window.__events.push(e);if(e.requestId&&e.type!=='cancelRequest')setTimeout(()=>window.ClaudexConversation.result({version:1,sessionId:e.sessionId,requestId:e.requestId,ok:true,result:e.type==='downloadArtifact'?'report.md':e.type==='downloadArtifacts'?{saved:e.payload.files.length,cancelled:false}:true}),10);}}}};`,
  });
  await call("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await call("Page.navigate", { url: "http://127.0.0.1:5198/" });
  for (let i = 0; i < 50; i++) {
    if (await evaluate("!!window.ClaudexConversation")) break;
    await pause(100);
  }
  assert.equal(
    await evaluate(
      `window.ClaudexConversation.render(${JSON.stringify(fixture)})`,
    ),
    true,
  );
  for (let i = 0; i < 50; i++) {
    if (await evaluate('!!document.querySelector(".katex")')) break;
    await pause(100);
  }
  await evaluate('document.querySelector(".messages-scroll").scrollTop=0');
  await pause(300);
  const shape = await evaluate(
    `({turns:document.querySelectorAll('.turn').length,table:!!document.querySelector('.markdown-table'),math:!!document.querySelector('.katex'),code:!!document.querySelector('.hljs-keyword'),artifact:!!document.querySelector('.artifact-document-card'),attachments:document.querySelectorAll('.message-attachments').length,overflow:document.documentElement.scrollWidth>innerWidth,text:document.body.innerText,desktop:!!window.desktop,iframes:document.querySelectorAll('iframe').length})`,
  );
  assert.equal(shape.turns, 2);
  assert.equal(shape.table, true);
  assert.equal(shape.math, true);
  assert.equal(shape.code, true);
  assert.equal(shape.artifact, true);
  assert.equal(shape.attachments, 1);
  assert.equal(shape.overflow, false);
  assert.equal(shape.desktop, false);
  assert.equal(shape.iframes, 0);
  await writeFile(
    path.join(out, "shared-mobile-light.png"),
    Buffer.from(
      (
        await call("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        })
      ).data,
      "base64",
    ),
  );
  const click = async (selector) => {
    const box = await evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
    assert.ok(box, selector);
    await call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...box,
    });
    await call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...box,
    });
    await pause(80);
  };
  await click('.code-block button[aria-label="Copy"]');
  assert.ok(
    await evaluate(
      `window.__events.some(e=>e.type==='copyText'&&e.payload.text.includes('platforms'))`,
    ),
  );
  // A browser-script click has no trusted gesture after the lease expires.
  await pause(1600);
  const before = await evaluate(
    "window.__events.filter(e=>e.requestId).length",
  );
  await evaluate(
    "document.querySelector('.code-block button[aria-label=\"Copy\"]').click()",
  );
  await pause(50);
  assert.equal(
    await evaluate("window.__events.filter(e=>e.requestId).length"),
    before,
  );
  await click(".code-open");
  assert.ok(
    await evaluate(
      `window.__events.some(e=>e.type==='openArtifact'&&e.payload.artifactId==='fence:reply-rich:0')`,
    ),
  );
  const editSelector = '.user-message-actions button[aria-label="Edit"]';
  const labels = await evaluate(
    `Array.from(document.querySelectorAll('.user-message-actions button')).map(x=>x.getAttribute('aria-label'))`,
  );
  // Streaming patch advances one item without retransmitting history.
  assert.equal(
    await evaluate(
      `window.ClaudexConversation.update({version:1,sessionId:'browser-fixture',baseRevision:1,revision:2,changes:[{type:'appendItemText',turnId:'turn-failed',itemId:'reply-stop',text:' Appended safely.'}]})`,
    ),
    true,
  );
  await pause(100);
  assert.match(await evaluate("document.body.innerText"), /Appended safely/);
  assert.equal(
    await evaluate(
      `window.ClaudexConversation.update({version:1,sessionId:'browser-fixture',baseRevision:1,revision:3,changes:[]})`,
    ),
    false,
  );
  // Dark uses the same CSS token cascade; phone layout has no copied palette.
  const dark = { ...fixture, revision: 3, theme: "dark" };
  await evaluate(`window.ClaudexConversation.render(${JSON.stringify(dark)})`);
  await pause(150);
  await evaluate('document.querySelector(".messages-scroll").scrollTop=0');
  await writeFile(
    path.join(out, "shared-mobile-dark.png"),
    Buffer.from(
      (
        await call("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        })
      ).data,
      "base64",
    ),
  );
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1100,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(
    `window.ClaudexConversation.render(${JSON.stringify({ ...fixture, revision: 4 })})`,
  );
  await pause(150);
  await evaluate('document.querySelector(".messages-scroll").scrollTop=0');
  await writeFile(
    path.join(out, "shared-desktop-width-light.png"),
    Buffer.from(
      (
        await call("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        })
      ).data,
      "base64",
    ),
  );
  // Readonly document rendering reuses Markdown and does not run HTML.
  const doc = {
    version: 1,
    sessionId: "doc-lease",
    revision: 1,
    theme: "light",
    document: {
      id: "doc",
      language: "markdown",
      name: "Report",
      content:
        "# Shared document\n\n**Same Markdown**\n\n<script>window.__attack=true</script>\n\n```js\nconst safe = true;\n```",
    },
  };
  assert.equal(
    await evaluate(
      `window.ClaudexConversation.renderDocument(${JSON.stringify(doc)})`,
    ),
    true,
  );
  await pause(200);
  assert.equal(await evaluate("window.__attack"), undefined);
  assert.equal(
    await evaluate(
      '!!document.querySelector(".mobile-document .hljs-keyword")',
    ),
    true,
  );
  await evaluate("window.ClaudexConversation.dispose()");
  await pause(50);
  assert.equal(
    await evaluate('document.getElementById("root").textContent'),
    "",
  );
  const external = events
    .filter((e) => e.method === "Network.requestWillBeSent")
    .map((e) => e.params.request.url)
    .filter(
      (u) => !u.startsWith("http://127.0.0.1:5198/") && !u.startsWith("data:"),
    );
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  const report = {
    kind: "browser fixture, not native screenshots",
    shape,
    userMessageActionLabels: labels,
    externalRequests: external,
    exceptions: errors,
    checks: [
      "shared transcript + rich Markdown + table + KaTeX + highlight + artifact + attachment",
      "no window.desktop bridge",
      "no iframe or external request",
      "trusted copy and fence identity dispatch",
      "untrusted synthetic click refused",
      "append-text patch and stale rejection",
      "light/dark and desktop-width fixture",
      "readonly document shared Markdown; script remains inert",
      "dispose clears document",
    ],
  };
  await writeFile(
    path.join(out, "browser-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  ws?.close();
  chrome.kill();
  server.close();
}
