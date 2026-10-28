import { knotMarkup } from "../../shared/knot-mark";
/**
 * The pop-out window's toolbar page and its commands. No Electron imports,
 * so tests can load it; electron/artifact-popouts.ts opens the windows.
 */

/**
 * The pop-out's toolbar page. It has no preload and no IPC: its buttons
 * set the page's own URL fragment to one of a few fixed commands, which
 * the main process reads from the in-page navigation and carries out. The
 * artifact runs in a sandboxed frame (no same origin, no top navigation),
 * so it cannot reach the toolbar or send a command.
 */
export const popoutCommands = [
  "pin-on",
  "pin-off",
  "return",
  "download",
  "copy",
] as const;
export type PopoutCommand = (typeof popoutCommands)[number];

export const popoutChromeCsp =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src claudex-preview:; connect-src 'none'; form-action 'none'; base-uri 'none'";

/**
 * The address a link in a pop-out asks to open, if it is a web page: only http
 * and https leave Claudex, and only after the main window confirms them;
 * anything else is dropped.
 */
export function popoutLink(url: string): string | undefined {
  return /^https?:\/\//i.test(url) ? url : undefined;
}

/** The command in a toolbar URL fragment ("#cmd=pin-on&n=3"), if it is one. */
export function popoutCommand(url: string): PopoutCommand | undefined {
  let hash: string;
  try {
    hash = new URL(url).hash;
  } catch {
    return undefined;
  }
  const command = /^#cmd=([a-z-]+)&n=\d{1,9}$/.exec(hash)?.[1];
  return popoutCommands.find((value) => value === command);
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

/**
 * The toolbar page: a 48px bar with the title and its menu on the left and, on
 * the right, Chat, the comment pair, Share, return to the main window and keep
 * on top; the window's own controls sit beside them. Chat goes back to the main
 * window. Comments and Share act on the panel in the main window, which
 * Claudex's pop-out does not reach yet, so those two are drawn greyed with the
 * reason (UI first).
 */
export function popoutChrome(options: {
  title: string;
  frameUrl: string;
  dark: boolean;
  platform: NodeJS.Platform;
  canSave: boolean;
  canCopy?: boolean;
  previewDownload?: boolean;
  pdfLabel?: string;
  pdfError?: string;
}) {
  const { dark, platform } = options;
  const c = dark
    ? {
        bar: "#20201e",
        rule: "#262626",
        page: "#1a1a1a",
        text: "#d2d1cd",
        icon: "#c9c8c3",
        hover: "#2e2e2c",
        menu: "#202020",
        menuBorder: "#373735",
        on: "#0a2243",
        onText: "#79b0f1",
        group: "#363636",
        groupRule: "#3f3f3d",
        groupHover: "#404040",
        chat: "#f0efea",
        share: "#fbfbfb",
        shareText: "#1f1f1e",
      }
    : {
        bar: "#f5f4ef",
        rule: "#e2e0d8",
        page: "#ffffff",
        text: "#3d3d3a",
        icon: "#55544f",
        hover: "#e8e6df",
        menu: "#ffffff",
        menuBorder: "#dcdad2",
        on: "#dbe8fb",
        onText: "#1f5fb8",
        group: "#e8e6df",
        groupRule: "#d6d3ca",
        groupHover: "#dedbd3",
        chat: "#262624",
        share: "#262624",
        shareText: "#ffffff",
      };
  // macOS keeps its traffic lights on the left; elsewhere the window's
  // controls take 138px on the right.
  const left = platform === "darwin" ? 84 : 17;
  const right = platform === "darwin" ? 12 : 150;
  const menuItems = [
    ...(options.pdfLabel
      ? [
          `<button role="menuitem" data-local="pdf">${escapeHtml(options.pdfLabel)}</button>`,
        ]
      : []),
    ...(options.canSave
      ? [
          '<button role="menuitem" data-cmd="download">Download</button>',
          ...(options.canCopy !== false
            ? [
                '<button role="menuitem" data-cmd="copy">Copy as Markdown</button>',
              ]
            : []),
          '<div role="separator"></div>',
        ]
      : []),
    '<button role="menuitem" data-local="refresh">Refresh</button>',
  ].join("");
  const icon = (paths: string) =>
    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const pin =
    '<g transform="rotate(45 12 12)"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></g>';
  const back =
    '<path d="M3.5 3.5v17h17"/><path d="M19 5 9.5 14.5"/><path d="M9.5 9.5v5h5"/>';
  // The Claudex knot (the Chat button), the two comment bubbles, the
  // arrow of "more comment options" and the lock on Share.
  const star = knotMarkup({ size: 12 });
  const bubbles = icon(
    '<path d="M9.5 3.5a6 6 0 0 1 5.9 7.1 6 6 0 0 1-8.4 4.3L3.5 16l1.1-3.3A6 6 0 0 1 9.5 3.5Z"/><path d="M16.9 9.2a5 5 0 0 1 2.9 7.7l.9 3.3-3.3-.9a5 5 0 0 1-6.3-1.8"/>',
  );
  const chevron =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const lock =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
  const title = escapeHtml(options.title);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:${c.page};color:${c.text};font:13px/18px -apple-system,"Segoe UI",system-ui,sans-serif;overflow:hidden}
header{position:relative;display:flex;align-items:center;gap:4px;height:49px;padding:0 ${right}px 0 ${left - 6}px;background:${c.bar};border-bottom:1px solid ${c.rule};-webkit-app-region:drag;user-select:none}
button{font:inherit;color:inherit;border:0;background:none;-webkit-app-region:no-drag;cursor:default}
.title{display:flex;align-items:center;gap:3px;min-width:0;height:24px;padding:0 6px;border-radius:5px;color:${c.text}}
.title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.title:hover,.title[aria-expanded=true]{background:${c.hover}}
.spacer{flex:1}
.chat{display:flex;align-items:center;gap:4px;height:28px;padding:0 10px 0 6px;border-radius:7px;background:${c.group};color:${c.chat};font-size:14px}
.chat:hover{background:${c.groupHover}}
.comments{display:flex;height:28px;margin-right:1px;border-radius:7px;background:${c.group};color:${c.icon}}
.comments button{display:grid;place-items:center;width:29px;color:inherit}
.comments button+button{width:28px;border-left:1px solid ${c.groupRule};border-radius:0 7px 7px 0}
.share{display:flex;align-items:center;gap:7px;width:74px;height:28px;padding:0 0 0 7px;border-radius:7px;background:${c.share};color:${c.shareText};font-size:13px}
button:disabled{opacity:.4}
.status{color:${c.icon};font-size:12px;margin-right:6px;white-space:nowrap}
.tool{display:grid;place-items:center;width:24px;height:24px;border-radius:6px;color:${c.icon}}
.tool:hover{background:${c.hover}}
.tool[aria-pressed=true]{background:${c.on};color:${c.onText}}
.menu{position:absolute;top:42px;left:${left - 6}px;z-index:2;display:none;width:200px;padding:4px;background:${c.menu};border:1px solid ${c.menuBorder};border-radius:11px;box-shadow:0 8px 28px #0006}
.menu[data-open]{display:block}
.menu button{display:flex;align-items:center;width:100%;height:24px;padding:2px 8px;border-radius:4px;text-align:left}
.menu button:hover,.menu button:focus-visible{background:${c.hover};outline:none}
.menu [role=separator]{height:1px;margin:4px 7px;background:${c.menuBorder}}
iframe{display:block;width:100%;height:calc(100% - 49px);border:0;background:${c.page}}
</style></head><body>
<header>
<button class="title" aria-haspopup="menu" aria-expanded="false"><span>${title}</span><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
<div class="menu" role="menu" aria-label="${title}">${menuItems}</div>
<span class="spacer"></span>
<span class="status" role="status"></span>
<button class="chat" data-cmd="return" title="Back to the conversation in the main window">${star}Chat</button>
<div class="comments"><button disabled aria-label="Comment" title="Comment on the artifact in the main window">${bubbles}</button><button disabled aria-label="More comment options" title="Comment on the artifact in the main window">${chevron}</button></div>
<button class="share" disabled title="Share the artifact from the main window">${lock}Share</button>
<button class="tool" data-cmd="return" aria-label="Return to the main window" title="Return to the main window">${icon(back)}</button>
<button class="tool" data-pin aria-pressed="false" aria-label="Keep on top" title="Keep on top">${icon(pin)}</button>
</header>
<iframe title="${title}" sandbox="allow-scripts" src="${escapeHtml(options.frameUrl)}"></iframe>
<script>
(() => {
  let n = 0;
  const send = (cmd) => { location.hash = "cmd=" + cmd + "&n=" + (++n); };
  const title = document.querySelector(".title"), menu = document.querySelector(".menu");
  const frame = document.querySelector("iframe"), status = document.querySelector(".status");
  const pin = document.querySelector("[data-pin]");
  window.addEventListener("message", (event) => {
    if (${options.previewDownload === true} && event.source === frame.contentWindow && event.data?.type === "claudex-popout-download") send("download");
  });
  let timer;
  window.__claudexStatus = (text) => { status.textContent = text; clearTimeout(timer); timer = setTimeout(() => { status.textContent = ""; }, 2500); };
  const close = () => { menu.removeAttribute("data-open"); title.setAttribute("aria-expanded", "false"); };
  title.addEventListener("click", () => {
    const open = !menu.hasAttribute("data-open");
    if (open) { menu.setAttribute("data-open", ""); title.setAttribute("aria-expanded", "true"); menu.querySelector("button")?.focus(); } else close();
  });
  menu.addEventListener("click", (event) => {
    const button = event.target.closest("button"); if (!button) return;
    close();
    if (button.dataset.local === "pdf") {
      const url = new URL(frame.src);
      window.omeletteDesktopPdf?.printFrameToPdf({ origin: url.protocol + "//" + url.host, nonce: url.hash.slice(1), docTitle: document.title }).then((result) => {
        if (!result.ok && !result.canceled) window.__claudexStatus(${JSON.stringify(options.pdfError ?? "")});
      });
      return;
    }
    if (button.dataset.local === "refresh") { const src = frame.src; frame.src = "about:blank"; setTimeout(() => { frame.src = src; }, 0); }
    else if (button.dataset.cmd) send(button.dataset.cmd);
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
  document.addEventListener("pointerdown", (event) => { if (!event.target.closest(".menu, .title")) close(); });
  for (const button of document.querySelectorAll("[data-cmd=return]")) button.addEventListener("click", () => send("return"));
  pin.addEventListener("click", () => {
    const on = pin.getAttribute("aria-pressed") !== "true";
    pin.setAttribute("aria-pressed", String(on));
    pin.setAttribute("aria-label", on ? "Stop keeping on top" : "Keep on top");
    send(on ? "pin-on" : "pin-off");
  });
})();
</script></body></html>`;
}
