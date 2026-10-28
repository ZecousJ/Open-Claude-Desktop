import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./fixture.mjs";
const root = path.resolve("dist-mobile-conversation");
const hostScript = `window.fixtureEvents=[];window.webkit={messageHandlers:{claudexConversation:{postMessage(e){fixtureEvents.push(e);const log=document.getElementById('fixture-status');if(log)log.textContent=e.type;if(e.type==='ready'){const state=${JSON.stringify(fixture)};const query=new URLSearchParams(location.search);state.theme=query.get('theme')||'light';if(query.get('mode'))state.conversation.mode=query.get('mode');window.fixtureState=state;window.ClaudexConversation.render(state);}else if(e.type==='stateApplied'){document.querySelector('.messages-scroll')?.scrollTo(0,0);}else if(e.requestId&&e.type!=='cancelRequest'){setTimeout(()=>window.ClaudexConversation.result({version:1,sessionId:e.sessionId,requestId:e.requestId,ok:true,result:e.type==='downloadArtifact'?'report.md':e.type==='downloadArtifacts'?{saved:e.payload.files.length,cancelled:false}:true}),10);}}}}};`;
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    let content, type;
    if (u.pathname === "/fixture-host.js") {
      content = hostScript;
      type = "text/javascript";
    } else if (u.pathname === "/fixture.html") {
      content = (await readFile(path.join(root, "index.html"), "utf8")).replace(
        "<body>",
        '<body><script src="./fixture-host.js"></script>',
      );
      type = "text/html";
    } else if (u.pathname === "/qa.html") {
      content = `<!doctype html><meta charset="utf-8"><title>Shared component browser fixtures</title><style>body{margin:0;padding:16px;background:#eee;font:14px system-ui}main{display:flex;gap:16px}.fixture h2{font-size:14px;font-weight:500}iframe{border:1px solid #aaa;height:820px}h1{font-size:20px}</style><h1>Actual shared components • browser fixtures, not native screenshots</h1><main><section class="fixture"><h2>Desktop-width fixture (760 px)</h2><iframe title="Desktop width" src="fixture.html" width="760"></iframe></section><section class="fixture"><h2>Phone-width fixture (390 px)</h2><iframe title="Phone width" src="fixture.html" width="390"></iframe></section></main>`;
      type = "text/html";
    } else {
      const file = path.resolve(
        root,
        "." +
          (u.pathname === "/" ? "/index.html" : decodeURIComponent(u.pathname)),
      );
      if (!file.startsWith(root + path.sep)) throw Error();
      content = await readFile(file);
      type =
        {
          ".html": "text/html",
          ".css": "text/css",
          ".js": "text/javascript",
          ".woff2": "font/woff2",
          ".woff": "font/woff",
          ".ttf": "font/ttf",
        }[path.extname(file)] || "application/octet-stream";
    }
    res.writeHead(200, { "content-type": type });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
server.listen(5198, "0.0.0.0", () =>
  console.log("Fixture server http://127.0.0.1:5198/qa.html"),
);
