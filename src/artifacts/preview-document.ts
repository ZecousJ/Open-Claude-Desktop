/**
 * Documents for the sandboxed preview frame. Everything a preview needs is
 * inline: the page's CSP (and the preview protocol's header) allow inline
 * scripts and data: images only, no network and no eval.
 */
export const previewMessageType = "claudex-preview-error";
import {
  artifactDataMessage,
  artifactDataResult,
} from "../../shared/artifact-data";
const csp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

/** Keeps script text from closing its element or opening an HTML comment. */
export function inlineScript(code: string) {
  return `<script>${code.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--")}</script>`;
}
/** A JSON literal that is safe inside an inline script. */
export function scriptJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Reports uncaught errors to the panel, which offers Try fixing. */
const errorBridge = inlineScript(
  `(()=>{const post=m=>{try{parent.postMessage({type:${scriptJson(previewMessageType)},message:String(m||"Unknown error").slice(0,4000)},"*")}catch(e){}};` +
    `addEventListener("error",e=>post(e.error&&e.error.stack&&e.error.message?e.error.name+": "+e.error.message:e.message));` +
    `addEventListener("unhandledrejection",e=>post(e.reason&&e.reason.message?e.reason.message:e.reason));` +
    `window.__claudexReportError=post;})()`,
);
function head(style = "", extra = "") {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">${errorBridge}${extra}<style>*{box-sizing:border-box}${style}</style>`;
}

/** An artifact's `window.claude.complete(prompt)` request to the page. */
export const completeMessageType = "claudex-complete";
/** The page's answer: `{type, id, text}` or `{type, id, error}`. */
export const completeResultType = "claudex-complete-result";
import {
  artifactToolMessage,
  artifactToolResult,
} from "../../shared/artifact-tools";

const toolApi = inlineScript(
  `(()=>{let sequence=0;const pending=new Map();addEventListener("message",event=>{const data=event.data;if(event.source!==parent||!data||data.type!==${scriptJson(artifactToolResult)}||!pending.has(data.id))return;const task=pending.get(data.id);pending.delete(data.id);clearTimeout(task.timer);typeof data.error==="string"?task.reject(new Error(data.error)):task.resolve(data.result)});const request=(method,args)=>new Promise((resolve,reject)=>{if(pending.size>=16)return reject(new Error("The request failed."));const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error("The request failed."))},300000);pending.set(id,{resolve,reject,timer});parent.postMessage({type:${scriptJson(artifactToolMessage)},id,method,args},"*")});const mcp={listTools:()=>request("listTools",[]),serverTools:server=>request("serverTools",[server]),describeTool:(server,tool)=>request("describeTool",[server,tool]),callTool:(server,tool,input={},options={})=>request("callTool",[server,tool,input,options])};window.claude=Object.assign(window.claude||{},{mcp});window.mcp=mcp;})()`,
);
const scheduledTaskApi = inlineScript(
  `(()=>{let sequence=0;const pending=new Map();addEventListener("message",event=>{const data=event.data;if(event.source!==parent||data?.type!==${scriptJson(artifactToolResult)}||!pending.has(data.id))return;const task=pending.get(data.id);pending.delete(data.id);clearTimeout(task.timer);data.error?task.reject(new Error(data.error)):task.resolve(data.result)});window.claude=Object.assign(window.claude||{},{runScheduledTask(taskId){return new Promise((resolve,reject)=>{if(pending.size)return reject(new Error("The request failed."));const id="scheduled:"+(++sequence);const timer=setTimeout(()=>{pending.delete(id);reject(new Error("The request failed."))},300000);pending.set(id,{resolve,reject,timer});parent.postMessage({type:${scriptJson(artifactToolMessage)},id,method:"runScheduledTask",args:[taskId,navigator.userActivation?.isActive===true]},"*")})}})})()`,
);
/**
 * AI-powered artifacts: `window.claude.complete` posts the prompt to the
 * page and resolves with the answer it posts back. Only the parent's
 * messages are taken (the frame has no origin of its own to check).
 */
const claudeApi = inlineScript(
  `(()=>{let n=0;const w=new Map();addEventListener("message",e=>{const d=e.data;if(e.source!==parent||!d||d.type!==${scriptJson(completeResultType)}||!w.has(d.id))return;const p=w.get(d.id);w.delete(d.id);typeof d.error==="string"?p[1](new Error(d.error)):p[0](String(d.text))});` +
    `window.claude=Object.assign(window.claude||{},{complete(prompt){return new Promise((resolve,reject)=>{const id=++n;w.set(id,[resolve,reject]);parent.postMessage({type:${scriptJson(completeMessageType)},id,prompt:String(prompt)},"*")})}});})()`,
);

/** A visualization's height, posted whenever its content resizes. */
export const visualizationSizeType = "claudex-visualization-size";

export function htmlDocument(content: string, claude = false) {
  return `${head("body{font-family:system-ui;margin:24px}", toolApi + scheduledTaskApi + storageApi + (claude ? claudeApi : ""))}${content}`;
}

const storageApi = inlineScript(
  `(()=>{let sequence=0;const pending=new Map();addEventListener("message",event=>{const data=event.data;if(event.source!==parent||data?.type!==${scriptJson(artifactDataResult)}||!pending.has(data.id))return;const task=pending.get(data.id);pending.delete(data.id);clearTimeout(task.timer);data.error?task.reject(new Error(data.error)):task.resolve(data.result)});const request=(method,args)=>new Promise((resolve,reject)=>{if(pending.size>=16)return reject(new Error("The request failed."));const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error("The request failed."))},30000);pending.set(id,{resolve,reject,timer});parent.postMessage({type:${scriptJson(artifactDataMessage)},id,request:{method,...args}},"*")});const api=resource=>({get:key=>request("get",{...resource,key}),set:(key,value)=>request("set",{...resource,key,value}),delete:key=>request("delete",{...resource,key}),list:prefix=>request("list",{...resource,...(prefix===undefined?{}:{prefix})})});window.storage={...api({}),files:api({resource:"files"})};})()`,
);

/**
 * An inline visualization (Settings → Capabilities): the model's HTML or
 * SVG drawn in the reply, on the reply's own background, reporting its
 * height so the frame grows with it. Colours as the office previews.
 */
export function visualizationDocument(content: string, dark: boolean) {
  const size = inlineScript(
    `(()=>{const post=()=>parent.postMessage({type:${scriptJson(visualizationSizeType)},height:Math.ceil(document.documentElement.getBoundingClientRect().height)},"*");new ResizeObserver(post).observe(document.documentElement);addEventListener("load",post)})()`,
  );
  return `${head(`:root{color-scheme:${dark ? "dark" : "light"}}html,body{margin:0;background:transparent;color:${dark ? "#e8e6dc" : "#1f1e1d"};font:14px/1.5 system-ui}svg{max-width:100%;height:auto}`, size)}${content}`;
}

export interface Runtime {
  /** The bundled library (React, Mermaid, pdf.js or Mammoth) as script text. */
  source: string;
}

/** A compiled React module; `error` is a compile failure to report instead. */
export function reactDocument(
  runtime: Runtime,
  compiled: { code: string } | { error: string },
  claude = false,
) {
  const body =
    "code" in compiled
      ? inlineScript(
          `ClaudexReact.mount(function(require,module,exports){${compiled.code}\n});`,
        )
      : inlineScript(`__claudexReportError(${scriptJson(compiled.error)});`);
  return `${head("body{font-family:system-ui;margin:0}", toolApi + scheduledTaskApi + storageApi + (claude ? claudeApi : ""))}<div id="root"></div>${inlineScript(runtime.source)}${body}`;
}

export function mermaidDocument(runtime: Runtime, code: string, dark: boolean) {
  return `${head(`html,body{margin:0;background:${dark ? "#1f1e1d" : "#fff"}}#diagram{display:flex;justify-content:center;padding:24px}#diagram svg{max-width:100%;height:auto}`)}<div id="diagram"></div>${inlineScript(runtime.source)}${inlineScript(
    `mermaid.initialize({startOnLoad:false,securityLevel:"strict",theme:${scriptJson(dark ? "dark" : "default")}});` +
      `mermaid.render("claudex-diagram",${scriptJson(code)}).then(r=>{document.getElementById("diagram").innerHTML=r.svg}).catch(e=>{document.querySelectorAll("#dclaudex-diagram,#claudex-diagram").forEach(n=>n.remove());__claudexReportError(e&&e.message?e.message:e)});`,
  )}`;
}

/** Binary previews receive their bytes as base64. */
export function pdfDocument(runtime: Runtime, base64: string, dark: boolean) {
  return `${head(`html,body{margin:0;background:${dark ? "#262624" : "#f0eee6"}}#pages{display:flex;flex-direction:column;align-items:center;gap:16px;padding:24px 16px}#pages canvas{max-width:100%;height:auto;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.25)}`)}<div id="pages"></div>${inlineScript(runtime.source)}${inlineScript(`ClaudexPdf.render(${scriptJson(base64)},document.getElementById("pages"));`)}`;
}

export function docxDocument(runtime: Runtime, base64: string, dark: boolean) {
  const colors = dark
    ? "background:#262624;color:#e8e6dc"
    : "background:#fff;color:#1f1e1d";
  return `${head(`html,body{margin:0;${colors}}#doc{max-width:760px;margin:0 auto;padding:40px 32px;font:15px/1.6 system-ui}#doc img{max-width:100%}#doc table{border-collapse:collapse}#doc td,#doc th{border:1px solid #8886;padding:4px 8px}`)}<article id="doc"></article>${inlineScript(runtime.source)}${inlineScript(
    `(()=>{const b=atob(${scriptJson(base64)}),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);` +
      `mammoth.convertToHtml({arrayBuffer:a.buffer}).then(r=>{document.getElementById("doc").innerHTML=r.value}).catch(e=>__claudexReportError(e&&e.message?e.message:e));})()`,
  )}`;
}

/**
 * Excel and PowerPoint (runtime/office-runtime.ts): a workbook as the
 * original's spreadsheet viewer shows it; slides as white boxes of their
 * own proportions, one under another.
 */
export function officeDocument(
  runtime: Runtime,
  kind: "xlsx" | "pptx",
  base64: string,
  dark: boolean,
) {
  const page = dark ? "#262624" : "#f0eee6";
  // The workbook is the original's spreadsheet viewer: white in both themes; a
  // 32px formula bar (monospace 12/24, an italic serif "fx" #888, the cell's
  // reference behind a #ccc rule, a #d8d9e5 rule under it); sheet tabs on a
  // 40px #f3f4f6 foot, each hanging from its #d1d5db rule (12px, padding 6 16,
  // #6b7280; the open one white and black); all in a #d1d5db frame of radius 8.
  // The cells' own rules are in runtime/office-runtime.ts.
  const sheetFont =
    'Calibri,Carlito,Candara,Segoe,"Segoe UI",Frutiger,"Frutiger Linotype","Dejavu Sans","Helvetica Neue",Helvetica,"Liberation Sans",Arial,"Arial Nova",sans-serif';
  const style =
    kind === "xlsx"
      ? `*{box-sizing:border-box}html,body{margin:0;height:100%;background:#fff;-webkit-font-smoothing:antialiased;font-family:ui-sans-serif,system-ui,sans-serif,"Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol","Noto Color Emoji"}` +
        `#doc{height:100%}` +
        `.sheet{display:flex;flex-direction:column;height:100%;border:1px solid #d1d5db;border-radius:8px;color:#374151;overflow:hidden}` +
        `.fx{flex:none;display:flex;align-items:center;width:100%;height:32px;border-radius:8px 8px 0 0;background:#fff;border-bottom:1px solid #d8d9e5;font-family:monospace;font-size:12px;line-height:24px}` +
        `.fx>*{padding:0 8px}.prefix{position:relative;width:12px;color:#888;font-family:serif;font-style:italic}` +
        `.ref{position:relative;min-width:60px;padding:0 12px;color:#888;text-align:center;white-space:nowrap}` +
        `.ref::after{content:"";position:absolute;top:4px;bottom:4px;left:0;border-left:1px solid #ccc}` +
        `.formula{flex:1 1 100%;display:flex;align-items:center;height:24px;white-space:pre;overflow-x:auto;color:#374151}` +
        `.grid{flex:1;overflow:auto;background:#fff;cursor:cell}` +
        `table{border-collapse:collapse;table-layout:fixed;width:max-content}` +
        `td{padding:0 4px;overflow:hidden;white-space:nowrap;color:#282b3e;border:0 solid transparent}` +
        `table.lines td{border:0.5px solid #d8d9e5}` +
        `td.selected{outline:2px solid #217346;outline-offset:-1px}` +
        `th{position:sticky;top:0;z-index:2;height:18px;padding:0;overflow:hidden;border:1.5px solid #d8d9e5;background:#f5f5f5;color:#282b3e;font:13px/18px ${sheetFont};font-weight:400;text-align:center;vertical-align:bottom;white-space:nowrap}` +
        `th.n{position:sticky;left:0;z-index:1}thead th.n{z-index:3}col.n{width:25px}` +
        `tr.hidden{display:none}` +
        `nav{flex:none;display:flex;height:40px;padding:0 0 6px 6px;overflow-x:auto;scrollbar-width:none;background:#f3f4f6;border-top:1px solid #d1d5db}` +
        `nav button{flex-shrink:0;margin-right:4px;padding:6px 16px;border:1px solid #d1d5db;border-top:0;border-radius:0 0 4px 4px;background:#f3f4f6;color:#6b7280;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}` +
        `nav button:hover{background:#e5e7eb;color:#000}nav button[aria-selected=true]{background:#fff;color:#000}`
      : `html,body{margin:0;background:${page};font-family:system-ui}` +
        `#doc{display:flex;flex-direction:column;align-items:center;gap:16px;padding:24px 16px}` +
        `.slide{position:relative;width:100%;max-width:960px;background:#fff;color:#1f1e1d;container-type:inline-size;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.25)}` +
        `.box{position:absolute;overflow:hidden;box-sizing:border-box}.box.text{display:flex;flex-direction:column}.box p{margin:0;line-height:1.2}.bullet{display:inline-block;text-indent:0}` +
        `img.box{object-fit:contain}.box table{width:100%;height:100%;border-collapse:collapse}.box td{border:1px solid #bbb;padding:2px 4px;vertical-align:top}`;
  const render = kind === "xlsx" ? "renderXlsx" : "renderPptx";
  return `${head(style)}<div id="doc"></div>${inlineScript(runtime.source)}${inlineScript(
    `ClaudexOffice.${render}(${scriptJson(base64)},document.getElementById("doc")).catch(e=>__claudexReportError(e&&e.message?e.message:e));`,
  )}`;
}
