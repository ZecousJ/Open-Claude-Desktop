import { WebContentsView, session, BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NativeHost } from "./host";
import { sessionAccountScope } from "./session-account-scope";

const box = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().min(0).max(20000),
    height: z.number().min(0).max(20000),
  })
  .passthrough();
type Entry = {
  window: BrowserWindow;
  view: WebContentsView;
  consumer: string;
  key: string;
  loadSeq: number;
  ready: Promise<{ ready: boolean; signal?: string; reason?: string }>;
  lost: Promise<{ declineReason: string }>;
  lose: (reason: string) => void;
  shown: boolean;
  onWindowClosed?: () => void;
};
const live = new Set<Entry>();
export async function captureNativePdfPreview(windowId?: number) {
  const e = [...live].find(
    (e) => e.shown && (!windowId || e.window.id === windowId),
  );
  if (!e) throw Error("No visible native PDF");
  return (await e.view.webContents.capturePage()).toPNG();
}
/** Read-only E2E observations of native PDF surfaces; no document execution. */
export async function nativePdfPreviewState(windowId?: number) {
  return Promise.all(
    [...live]
      .filter((e) => !windowId || e.window.id === windowId)
      .map(async (e) => ({
        url: "native-pdf://local",
        nativePdf: true,
        windowId: e.window.id,
        loadSeq: e.loadSeq,
        shown: e.shown,
        ready: await e.ready,
        frames: e.view.webContents.mainFrame.framesInSubtree.map((f) => ({
          url: f.url.startsWith("data:")
            ? "data:application/pdf"
            : f.url.slice(0, 150),
        })),
        captureBytes: (await e.view.webContents.capturePage()).toPNG().length,
      })),
  );
}

/** Implements the official native overlay contract for local PDFs. Office files
 * decline explicitly so the unchanged official sandbox renderer handles them. */
export function registerPdfPreview(host: NativeHost) {
  const entries = new Map<string, Entry>(),
    versions = new Map<string, number>();
  let sequence = 0;
  const close = (entry: Entry) => {
    const key = entry.window.id + ":" + entry.consumer;
    if (entries.get(key) === entry) entries.delete(key);
    live.delete(entry);
    if (entry.onWindowClosed)
      entry.window.removeListener("closed", entry.onWindowClosed);
    entry.lose("viewer_unavailable");
    if (!entry.window.isDestroyed() && entry.shown)
      entry.window.contentView.removeChildView(entry.view);
    entry.shown = false;
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
  };
  const scope = sessionAccountScope(host.ctx, () => {
    for (const e of [...entries.values()]) close(e);
    versions.clear();
  });
  const caller = () => {
    const window = host.caller ?? host.window;
    if (!window || window.isDestroyed()) throw Error("No file preview window");
    return window;
  };
  const own = (consumer?: string) => {
    scope.sync();
    const w = caller();
    return entries.get(w.id + ":" + (consumer ?? "default"));
  };
  const position = (e: Entry, b: ReturnType<typeof box.parse>) => {
    const zoom = e.window.webContents.getZoomFactor();
    e.view.setBounds({
      x: Math.round(b.x * zoom),
      y: Math.round(b.y * zoom),
      width: Math.max(1, Math.round(b.width * zoom)),
      height: Math.max(1, Math.round(b.height * zoom)),
    });
    if (!e.shown) {
      e.window.contentView.addChildView(e.view);
      e.shown = true;
    }
  };
  host.on("CoworkFilePreview.isEpitaxyPreviewEnabled", () => true);
  host.on("CoworkFilePreview.isVmReady", () => false);
  host.on("CoworkFilePreview.vmReadiness", () => "unsupported");
  host.on("CoworkFilePreview.isBuiltInViewerAvailable", (extension: string) =>
    /^(?:\.)?pdf$/i.test(extension),
  );
  host.on(
    "LocalSessions.showSessionFilePreview",
    (
      rawId: unknown,
      rawPath: unknown,
      rawBounds: unknown,
      rawConsumer?: unknown,
      rawTarget?: unknown,
    ) => {
      const window = caller();
      if (rawTarget !== undefined && rawTarget !== String(window.id))
        return { ok: false, declineReason: "viewer_unavailable" };
      const consumer =
          z.string().max(250).optional().parse(rawConsumer) ?? "default",
        entryKey = window.id + ":" + consumer,
        version = (versions.get(entryKey) ?? 0) + 1;
      versions.set(entryKey, version);
      return scope.run(async () => {
        const id = z
            .string()
            .regex(/^local_.+/)
            .parse(rawId),
          file = z.string().min(1).max(4096).parse(rawPath),
          bounds = box.parse(rawBounds);
        const previous = entries.get(entryKey);
        if (previous && !previous.key.startsWith(id + "\n" + file + "\n"))
          close(previous);
        if (!/\.pdf$/i.test(file))
          return { ok: false, declineReason: "viewer_unavailable" };
        const data = (await scope.guard(() =>
          host.ctx.localCall!("officialSessionFile", {
            operation: "document",
            sessionId: id.slice(6),
            path: file,
          }),
        )) as { status: string; dataUrl?: string };
        if (
          data.status !== "ok" ||
          !data.dataUrl?.startsWith("data:application/pdf;base64,")
        )
          return {
            ok: false,
            declineReason:
              data.status === "tooLarge"
                ? "viewer_too_large"
                : "viewer_invalid_file",
          };
        if (
          !Buffer.from(
            data.dataUrl.slice("data:application/pdf;base64,".length),
            "base64",
          )
            .subarray(0, 1024)
            .includes(Buffer.from("%PDF-"))
        )
          return { ok: false, declineReason: "viewer_invalid_file" };
        if (window.isDestroyed() || versions.get(entryKey) !== version)
          return { ok: false, declineReason: "viewer_unavailable" };
        const key = id + "\n" + file + "\n" + data.dataUrl;
        let entry = entries.get(entryKey);
        if (entry?.key !== key) {
          if (entry) close(entry);
          if (entries.size >= 12) {
            const hidden = [...entries.values()].find((e) => !e.shown);
            if (hidden) close(hidden);
          }
          if (entries.size >= 12) throw Error("Too many PDF previews");
          const partition = session.fromPartition(
            "claudex-pdf-" + randomUUID(),
          );
          partition.setPermissionRequestHandler((_w, _p, done) => done(false));
          partition.webRequest.onBeforeRequest((details, done) =>
            done({ cancel: /^(https?|wss?|file):/.test(details.url) }),
          );
          const view = new WebContentsView({
            webPreferences: {
              session: partition,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              nodeIntegrationInSubFrames: false,
              plugins: true,
              webSecurity: true,
              navigateOnDragDrop: false,
            },
          });
          view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
          view.webContents.on("will-navigate", (event, url) => {
            if (
              !url.startsWith("data:application/pdf;") &&
              !url.startsWith("chrome-extension:")
            )
              event.preventDefault();
          });
          let lose!: (reason: string) => void;
          const lost = new Promise<{ declineReason: string }>((resolve) => {
            lose = (reason) => resolve({ declineReason: reason });
          });
          entry = {
            window,
            view,
            consumer,
            key,
            loadSeq: ++sequence,
            ready: Promise.resolve({ ready: false }),
            lost,
            lose,
            shown: false,
          };
          const current = entry;
          entries.set(entryKey, entry);
          live.add(entry);
          current.onWindowClosed = () => close(current);
          window.once("closed", current.onWindowClosed);
          view.webContents.once("render-process-gone", () =>
            current.lose("viewer_crashed"),
          );
          entry.ready = view.webContents
            .loadURL(data.dataUrl + "#toolbar=0&navpanes=0&view=FitH")
            .then(
              () => ({
                ready: !view.webContents.isDestroyed(),
                signal: "loaded",
              }),
              () => ({ ready: false, reason: "viewer_invalid_file" }),
            );
        }
        position(entry, bounds);
        return { ok: true, loadSeq: entry.loadSeq };
      });
    },
  );
  host.on("CoworkFilePreview.hide", (consumer?: string) => {
    const e = own(consumer),
      key = caller().id + ":" + (consumer ?? "default");
    versions.set(key, (versions.get(key) ?? 0) + 1);
    if (!e) return false;
    if (e.shown) {
      e.window.contentView.removeChildView(e.view);
      e.shown = false;
    }
    return true;
  });
  host.on("CoworkFilePreview.focus", (consumer?: string) => {
    const e = own(consumer);
    if (!e || !e.shown) return false;
    e.view.webContents.focus();
    return true;
  });
  host.on(
    "CoworkFilePreview.whenContentReady",
    (seq: number, consumer?: string) => {
      const e = own(consumer);
      return e?.loadSeq === seq
        ? scope.guard(() => e.ready)
        : { ready: false, reason: "viewer_unavailable" };
    },
  );
  host.on(
    "CoworkFilePreview.whenContentLost",
    (seq: number, consumer?: string) => {
      const e = own(consumer);
      return e?.loadSeq === seq
        ? e.lost
        : { declineReason: "viewer_unavailable" };
    },
  );
  host.on(
    "CoworkFilePreview.parkAndCapture",
    async (_bounds: unknown, consumer?: string) => {
      const e = own(consumer);
      if (!e) return null;
      const image = await scope.guard(() => e.view.webContents.capturePage());
      if (e.shown && !e.window.isDestroyed()) {
        e.window.contentView.removeChildView(e.view);
        e.shown = false;
      }
      return image.toDataURL();
    },
  );
  const off = host.ctx.onEvent(() => scope.sync());
  return () => {
    off();
    for (const e of [...entries.values()]) close(e);
  };
}
