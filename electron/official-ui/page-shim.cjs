/**
 * Claudex's own preload for the official window (registered beside the
 * official one, electron/official-ui/window.ts). It leaves the page's
 * modules alone and only adjusts what leaves the page:
 * - a copied share link: the page builds `<its origin>/share/<id>`
 *   (c843d26a9 Re, c5e674140 w, cf6c0e3a1), which on this client is a
 *   loopback address; the copy becomes the share's public Claudex address.
 * - buying credits: the page's purchase panel takes cards only (Stripe
 *   Elements); a Claudex account adds funds with WeChat Pay or Alipay, so
 *   "Buy usage credits" and its kin open Claudex's own top-up window
 *   (owner, 2026-10-31) instead of the panel.
 * - Payment management opens the native Billing window from the derived
 *   Billing pane.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.executeInMainWorld({
  func: () => {
    if (window.top === window && location.protocol === "http:" && location.hostname === "localhost")
      Object.defineProperty(window, "__claudexMcpAppsSandboxUrl", {
        value: "https://www.claudeusercontent.com/mcp_apps",
      });
    const clipboard = navigator.clipboard;
    if (!clipboard || clipboard.__claudex) return;
    const write = clipboard.writeText.bind(clipboard);
    const writeItems = clipboard.write?.bind(clipboard);
    const publicLink = async (text) => {
      if (typeof text !== "string") return text;
      let source;
      try { source = new URL(text); } catch { return text; }
      const match = source.origin === location.origin && !source.search && !source.hash &&
        /^\/share\/([A-Za-z0-9_-]{1,64})$/.exec(source.pathname);
      if (!match) return text;
      const response = await fetch(`/api/__claudex/share-url/${encodeURIComponent(match[1])}`);
      if (!response.ok) throw new Error("The shared link could not be resolved.");
      const raw = await response.text();
      const resolved = raw.trim();
      if (!resolved || resolved.length > 8192 || /[\u0000-\u001f\u007f]/.test(raw))
        throw new Error("The shared link is invalid.");
      const target = new URL(resolved);
      if (!["https:", "http:"].includes(target.protocol) || target.username || target.password ||
          (target.origin === location.origin && /^\/share(?:\/|$)/.test(target.pathname)))
        throw new Error("The shared link is invalid.");
      return resolved;
    };
    Object.defineProperty(clipboard, "__claudex", { value: true });
    // Also callable on its own (the e2e tests check it without the system clipboard).
    Object.defineProperty(window, "__claudexPublicLink", { value: publicLink });
    clipboard.writeText = async (text) => write(await publicLink(text));
    // The original Share consumer prefers one promised text/plain ClipboardItem.
    // Keep the native call synchronous so its user gesture is not manufactured or
    // lost to network latency. Read only this authored payload, never the clipboard.
    if (writeItems && typeof ClipboardItem === "function")
      clipboard.write = (items) => {
        if (!Array.isArray(items) || items.length !== 1 ||
            items[0]?.types?.length !== 1 || items[0].types[0] !== "text/plain")
          return writeItems(items);
        const item = items[0];
        const mapped = item.getType("text/plain").then(async (blob) => {
          if (blob.size > 8192) return blob;
          const text = await blob.text();
          const resolved = await publicLink(text);
          return resolved === text ? blob : new Blob([resolved], { type: "text/plain" });
        });
        // The consumer/native operation owns rejection; avoid an unhandled promise
        // if Chromium refuses the operation before it consumes the promised data.
        void mapped.catch(() => {});
        return writeItems([new ClipboardItem({ "text/plain": mapped },
          { presentationStyle: item.presentationStyle })]);
      };
  },
});

contextBridge.executeInMainWorld({
  func: () => {
    if (window.__claudexTopUp) return;
    const label = /^(Buy (usage |extra )?credits|Buy more|Buy extra usage|Add credits|Get more usage)(\b|$)/;
    const openTopUp = () => fetch("/api/__claudex/checkout", { method: "POST" }).then((r) => r.ok);
    const openBilling = () => fetch("/api/__claudex/billing", { method: "POST" }).then((r) => r.ok);
    Object.defineProperty(window, "__claudexTopUp", { value: openTopUp });
    Object.defineProperty(window, "__claudexBilling", { value: openBilling });
    const purchase = (target) => {
      const control = target instanceof Element ? target.closest("button, a, [role=button], [role=menuitem], [role=tab], [role=link]") : null;
      if (!control) return null;
      // Icon glyphs (private-use characters) come before some labels.
      const text = (control.innerText || control.textContent || "").replace(/[\uE000-\uF8FF]/g, "").trim();
      if (label.test(text)) return openTopUp;
      return null;
    };
    // Capture phase, before the page's own handlers; the press that would
    // open the panel never reaches it.
    for (const type of ["pointerdown", "mousedown", "click"])
      document.addEventListener(
        type,
        (event) => {
          const open = purchase(event.target);
          if (!open) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          if (type === "click") void open();
        },
        true,
      );
    document.addEventListener(
      "keydown",
      (event) => {
        const open = (event.key === "Enter" || event.key === " ") && purchase(event.target);
        if (open) {
          event.preventDefault();
          event.stopImmediatePropagation();
          void open();
        }
      },
      true,
    );
  },
});

// The official preload's getPathForFile exposes a genuine selected File's OS
// path, but not its bytes, to the composer. Register only trusted File selections in
// this isolated preload; no callable registration API enters the main world.
(() => {
  const { ipcRenderer, webUtils } = require("electron");
  if (window.top !== window) return;
  const capture = (event) => {
    const query = new URLSearchParams(location.search);
    const coworkHome = location.pathname === "/new" &&
      query.getAll("mode").length === 1 && query.get("mode") === "cowork" &&
      query.getAll("surface").length <= 1 &&
      (!query.has("surface") || query.get("surface") === "cowork");
    const coworkSession = /^\/cowork\/local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(location.pathname);
    if (!event.isTrusted || !(coworkHome || coworkSession || /^\/(?:task|epitaxy)(?:\/|$)/.test(location.pathname))) return;
    let files;
    if (event.type === "change") {
      const input = event.target;
      if (!(input instanceof HTMLInputElement) || input.type !== "file") return;
      files = input.files;
    } else if (event.type === "drop") files = event.dataTransfer?.files;
    if (!files?.length || files.length > 12) return;
    try {
      const paths = [];
      let bytes = 0;
      for (const file of files) {
        if (!(file instanceof File)) return;
        bytes += file.size;
        if (bytes > 64 * 1024 * 1024) return;
        // Newly constructed JS Files have no native path. Never accept a
        // .path property, DataTransfer text, or a path supplied by page code.
        const path = webUtils.getPathForFile(file);
        if (!path) {
          if (/^\/epitaxy(?:\/|$)/.test(location.pathname) && file.type.startsWith("image/")) continue;
          return;
        }
        paths.push(path);
      }
      if (paths.length) ipcRenderer.sendSync("claudex:trusted-file-selection", paths);
    } catch {
      // Fail closed: send will refuse an unregistered path, not read it.
    }
  };
  window.addEventListener("change", capture, true);
  window.addEventListener("drop", capture, true);
})();

if (process.isMainFrame && location.protocol === "http:" && location.hostname === "localhost") {
  contextBridge.exposeInMainWorld("__claudexAccountExport", {
    scope: "device",
    save: (options) => ipcRenderer.invoke("claudex:export-account-data", options),
  });
}

// Record the native File objects from a trusted extension drop before the page handles it.
(() => {
  if (window.top !== window) return;
  const { ipcRenderer, webUtils } = require("electron");
  window.addEventListener("drop", (event) => {
    if (!event.isTrusted || !(location.pathname === "/epitaxy" && /^#settings\/desktop\/extensions(?:\/|$)/.test(location.hash))) return;
    const files = event.dataTransfer?.files;
    if (!files?.length) return;
    const paths = [];
    for (const file of files) {
      if (!/\.(?:dxt|mcpb)$/i.test(file.name)) continue;
      try {
        const path = webUtils.getPathForFile(file);
        if (path) paths.push(path);
      } catch {}
    }
    if (paths.length) ipcRenderer.sendSync("claudex:extension-drop", paths);
  }, true);
})();

// Keep a notification received during the initial query available to the shell.
if (process.isMainFrame) {
  let revision = 0;
  contextBridge.executeInMainWorld({ func: () => { window.__claudexConversationListsRevision = 0; } });
  ipcRenderer.on("claudex:conversation-lists-invalidated", () => {
    contextBridge.executeInMainWorld({
      func: (value) => {
        window.__claudexConversationListsRevision = value;
        window.dispatchEvent(new Event("claudex:conversation-lists-invalidated"));
      },
      args: [++revision],
    });
  });
}
