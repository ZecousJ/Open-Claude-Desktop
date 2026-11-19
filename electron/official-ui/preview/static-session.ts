import http from "node:http";
import { randomUUID } from "node:crypto";
import { BrowserWindow, MessageChannelMain, ipcMain, session } from "electron";
import { staticPreviewShell, staticPreviewShellCsp } from "./static-documents";

const allocatedWindows = new Set<BrowserWindow>();
let pendingWindows = 0;

export interface StaticPreviewOptions {
  document: string;
  current(): boolean;
  ownerWindow: BrowserWindow;
  /** Host-owned absolute packaged preload path, never supplied by a renderer. */
  preloadPath: string;
  /** Must synchronously notify account retirement, including before account fields clear. */
  onRetire(listener: () => void): () => void;
  log?(message: string): void;
}
/** Opens only a fixed public shell, in a new in-memory Session with no official shim.
 * opened means host channel accepted; it does not assert browser pixel rendering.
 */
export async function openStaticArtifactPreview(
  options: StaticPreviewOptions,
): Promise<{ opened: true }> {
  const owner = options.ownerWindow;
  const current = () => {
    try {
      return !owner.isDestroyed() && options.current() === true;
    } catch {
      return false;
    }
  };
  if (
    !current() ||
    typeof options.document !== "string" ||
    Buffer.byteLength(options.document) > 1100000
  )
    throw Error("Static preview is unavailable.");
  if (allocatedWindows.size + pendingWindows >= 8)
    throw Error("Close an existing static preview before opening another.");
  pendingWindows++;
  let pendingSlot = true;
  const diagnostic = () => {
    try {
      options.log?.("Static preview cleanup could not be confirmed.");
    } catch {}
  };
  let retired = false,
    win: BrowserWindow | undefined;
  let shellURL = "",
    initialRequest = false,
    initialNavigation = false,
    innerNavigation = false;
  let channel: MessageChannelMain | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  let off: (() => void) | undefined;
  let settle: ((error?: Error) => void) | undefined;
  let completed = false;
  let rejectListening: ((error: Error) => void) | undefined;
  const server = http.createServer((req, res) => {
    if (retired || !current() || !shellURL) {
      res.writeHead(410);
      res.end();
      return;
    }
    const expected = new URL(shellURL);
    if (
      req.headers.host !== expected.host ||
      req.url !== "/" ||
      !["GET", "HEAD"].includes(req.method ?? "") ||
      req.headers.cookie ||
      req.headers.authorization
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": staticPreviewShellCsp,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(req.method === "HEAD" ? undefined : staticPreviewShell);
  });
  const retire = () => {
    if (retired) return;
    retired = true;
    if (timer) clearTimeout(timer);
    if (handshakeTimer) clearTimeout(handshakeTimer);
    ipcMain.removeListener("claudex-static-preview-ready", ready);
    owner.removeListener("closed", retire);
    owner.webContents.removeListener("did-start-navigation", retire);
    try {
      off?.();
    } catch {
      diagnostic();
    }
    try {
      channel?.port1.close();
    } catch {}
    try {
      channel?.port2.close();
    } catch {}
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send("claudex-static-preview-retire");
      } catch {}
      try {
        win.destroy();
      } catch {
        diagnostic();
      }
    }
    try {
      server.close();
      server.closeAllConnections();
    } catch {
      diagnostic();
    }
    rejectListening?.(
      Error("Static preview was closed or its account changed."),
    );
    settle?.(Error("Static preview was closed or its account changed."));
  };
  const live = () => {
    if (retired) return false;
    if (!current()) {
      retire();
      return false;
    }
    return true;
  };
  const ready = (event: Electron.IpcMainEvent, value: unknown) => {
    try {
      if (!win || event.sender !== win.webContents) return;
      if (
        !live() ||
        event.senderFrame !== win.webContents.mainFrame ||
        event.senderFrame?.url !== shellURL ||
        channel ||
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        !("nonce" in value) ||
        typeof value.nonce !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.nonce)
      ) {
        retire();
        return;
      }
      initialNavigation = true;
      const nonce = value.nonce;
      const frame = event.senderFrame;
      channel = new MessageChannelMain();
      channel.port1.on("message", (event) => {
        try {
          const value = event.data;
          if (
            !live() ||
            !win ||
            win.webContents.mainFrame !== frame ||
            frame.url !== shellURL ||
            completed ||
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            Object.keys(value).length !== 2 ||
            value.type !== "ack" ||
            value.nonce !== nonce
          ) {
            retire();
            return;
          }
          completed = true;
          if (handshakeTimer) clearTimeout(handshakeTimer);
          channel!.port1.postMessage({
            type: "render",
            nonce,
            document: options.document,
          });
          if (!live()) return;
          win.show();
          settle?.();
        } catch {
          retire();
        }
      });
      channel.port1.start();
      win.webContents.postMessage("claudex-static-preview-bind", { nonce }, [
        channel.port2,
      ]);
    } catch {
      retire();
    }
  };
  try {
    off = options.onRetire(retire);
    // A synchronous subscription notification must not leak the returned disposer.
    if (retired) {
      off();
      throw Error("Static preview is unavailable.");
    }
    owner.once("closed", retire);
    owner.webContents.on("did-start-navigation", retire);
    await new Promise<void>((resolve, reject) => {
      rejectListening = reject;
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        rejectListening = undefined;
        if (retired || !current()) {
          try {
            server.close();
            server.closeAllConnections();
          } catch {
            diagnostic();
          }
          reject(Error("Static preview is unavailable."));
          return;
        }
        resolve();
      });
    });
    rejectListening = undefined;
    if (!live()) {
      server.close();
      server.closeAllConnections();
      throw Error("Static preview is unavailable.");
    }
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Static preview is unavailable.");
    shellURL = `http://127.0.0.1:${address.port}/`;
    const isolated = session.fromPartition(
      `claudex-static-preview-${randomUUID()}`,
    );
    isolated.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    isolated.setPermissionCheckHandler(() => false);
    isolated.on("will-download", (event) => event.preventDefault());
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const own = !!win && details.webContentsId === win.webContents.id;
      if (
        live() &&
        own &&
        !initialRequest &&
        details.resourceType === "mainFrame" &&
        details.url === shellURL
      ) {
        initialRequest = true;
        callback({ cancel: false });
        return;
      }
      callback({ cancel: true });
      // A denied navigation can still replace an inner document with Chromium's
      // blank error surface. Revoke after answering the request; ordinary denied
      // image/script/style resources must not close a usable static page.
      if (
        own &&
        completed &&
        ["mainFrame", "subFrame"].includes(details.resourceType)
      )
        retire();
    });
    win = new BrowserWindow({
      show: false,
      width: 900,
      height: 720,
      title: "Static preview",
      parent: owner,
      webPreferences: {
        session: isolated,
        preload: options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        additionalArguments: [`--claudex-static-preview-shell=${shellURL}`],
      },
    });
    allocatedWindows.add(win);
    pendingWindows--;
    pendingSlot = false;
    win.once("closed", () => allocatedWindows.delete(win!));
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-frame-navigate", (event) => {
      if (!live()) {
        event.preventDefault();
        return;
      }
      if (event.isMainFrame && !initialNavigation && event.url === shellURL) {
        initialNavigation = true;
        return;
      }
      if (
        !event.isMainFrame &&
        completed &&
        !innerNavigation &&
        event.url === "about:srcdoc" &&
        event.frame?.parent === win!.webContents.mainFrame
      ) {
        innerNavigation = true;
        return;
      }
      event.preventDefault();
      retire();
    });
    win.webContents.on("will-redirect", (event) => {
      event.preventDefault();
      retire();
    });
    // CSP may reject a child navigation before webRequest/will-frame-navigate.
    // Only the native direct artifact frame is relevant, not blocked resources
    // or deeper artifact-authored iframe attempts.
    win.webContents.on(
      "did-fail-load",
      (_event, _code, _description, url, isMainFrame, processId, routingId) => {
        if (!completed || !win || retired) return;
        try {
          const frame = win.webContents.mainFrame.frames.find(
            (candidate) =>
              candidate.processId === processId &&
              candidate.routingId === routingId,
          );
          if (
            isMainFrame ||
            (frame?.parent === win.webContents.mainFrame &&
              url !== "about:srcdoc")
          )
            retire();
        } catch {
          retire();
        }
      },
    );
    win.webContents.on("render-process-gone", retire);
    win.once("closed", retire);
    ipcMain.on("claudex-static-preview-ready", ready);
    const accepted = new Promise<{ opened: true }>((resolve, reject) => {
      settle = (error) => {
        if (error) reject(error);
        else resolve({ opened: true });
      };
    });
    // Attach rejection handling before an awaited load may fail/retire.
    void accepted.catch(() => {});
    timer = setTimeout(retire, 5 * 60_000);
    timer.unref?.();
    handshakeTimer = setTimeout(retire, 10_000);
    handshakeTimer.unref?.();
    await win.loadURL(shellURL);
    initialNavigation = true;
    if (!live()) throw Error("Static preview is unavailable.");
    return await accepted;
  } catch {
    retire();
    throw Error("Static preview could not be opened.");
  } finally {
    if (pendingSlot) pendingWindows--;
  }
}
