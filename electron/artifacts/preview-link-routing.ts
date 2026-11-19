import { randomUUID } from "node:crypto";
import { dialog, shell, type BrowserWindow } from "electron";
import { linkOpens } from "../../shared/external-links";
import type { AppContext } from "../app/app-context";
import { nativeTranslator } from "../app/native-i18n";
import { preference } from "../../shared/settings-extras";
import { previewLinkLabel } from "../../shared/preview-link-label";

const routers = new WeakMap<AppContext, PreviewLinkRouter>();

export class PreviewLinkRouter {
  private ready = new Set<number>();
  private pending = new Map<
    string,
    {
      windowId: number;
      url: string;
      timer: NodeJS.Timeout;
      open(url: string): Promise<void>;
      settle(opened: boolean): void;
    }
  >();

  constructor(
    private ctx: AppContext,
    private confirmNative?: (url: string) => Promise<boolean>,
  ) {}

  setReady(windowId: number, ready: boolean) {
    if (ready) this.ready.add(windowId);
    else {
      this.ready.delete(windowId);
      for (const [id, request] of this.pending)
        if (request.windowId === windowId) this.take(id)?.settle(false);
    }
  }

  async request(url: string, options?: {
    window: BrowserWindow;
    notify(requestId: string, url: string): void;
    open(url: string): Promise<void>;
  }) {
    const window = options?.window ?? this.ctx.appWindows.focused() ?? this.ctx.appWindows.main();
    if (!window || options?.window.isDestroyed() || !linkOpens(url, this.ctx.policy())) return false;
    const windowId = window.webContents.id;
    if (
      [...this.pending.values()].some(
        (request) => request.windowId === windowId,
      )
    )
      return false;
    const requestId = randomUUID();
    const timer = setTimeout(() => this.take(requestId)?.settle(false), 120_000);
    timer.unref?.();
    const completion = new Promise<boolean>((settle) => {
      this.pending.set(requestId, {
        windowId, url, timer, settle,
        open: options?.open ?? ((address) => shell.openExternal(address)),
      });
    });
    if (!this.ready.has(windowId)) {
      try {
        let allow = false;
        if (this.confirmNative) allow = await this.confirmNative(url);
        else {
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (this.pending.has(requestId) && !window.isDestroyed()) {
            const translate = await nativeTranslator(
              preference(this.ctx.store.settings, "locale"),
            );
            if (this.pending.has(requestId) && !window.isDestroyed()) {
              const result = await dialog.showMessageBox(window, {
                type: "question",
                message: translate("Open this link in your browser?"),
                detail: previewLinkLabel(url, false),
                buttons: [translate("Cancel"), translate("Open")],
                defaultId: 0,
                cancelId: 0,
              });
              allow = result.response === 1;
            }
          }
        }
        await this.resolve(windowId, requestId, allow);
      } finally {
        this.take(requestId)?.settle(false);
      }
    } else if (options) options.notify(requestId, url);
    else this.ctx.appWindows.send(window, {
      type: "routed-link-confirm",
      requestId,
      url,
    });
    return completion;
  }

  private take(requestId: string) {
    const request = this.pending.get(requestId);
    if (!request) return;
    this.pending.delete(requestId);
    clearTimeout(request.timer);
    return request;
  }

  async resolve(windowId: number, requestId: string, allow: boolean) {
    const request = this.pending.get(requestId);
    if (!request || request.windowId !== windowId) return;
    this.take(requestId);
    let opened = false;
    try {
      if (allow && linkOpens(request.url, this.ctx.policy())) {
        await request.open(request.url);
        opened = true;
      }
    } finally {
      request.settle(opened);
    }
  }

  dispose() {
    for (const id of this.pending.keys()) this.take(id)?.settle(false);
    this.ready.clear();
  }
}

export function previewLinkRouter(ctx: AppContext) {
  let router = routers.get(ctx);
  if (!router) {
    router = new PreviewLinkRouter(ctx);
    routers.set(ctx, router);
    ctx.onAccountDeactivating(() => router?.dispose());
  }
  return router;
}
