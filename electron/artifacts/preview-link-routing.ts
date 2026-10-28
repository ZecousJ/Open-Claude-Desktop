import { randomUUID } from "node:crypto";
import { dialog, shell } from "electron";
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
    { windowId: number; url: string; timer: NodeJS.Timeout }
  >();
  private generation = 0;

  constructor(
    private ctx: AppContext,
    private confirmNative?: (url: string) => Promise<boolean>,
  ) {}

  setReady(windowId: number, ready: boolean) {
    if (ready) this.ready.add(windowId);
    else {
      this.ready.delete(windowId);
      for (const [id, request] of this.pending)
        if (request.windowId === windowId) {
          clearTimeout(request.timer);
          this.pending.delete(id);
        }
    }
  }

  async request(url: string) {
    const window = this.ctx.appWindows.focused() ?? this.ctx.appWindows.main();
    if (!window || !linkOpens(url, this.ctx.policy())) return;
    if (
      [...this.pending.values()].some(
        (request) => request.windowId === window.webContents.id,
      )
    )
      return;
    const requestId = randomUUID();
    const timer = setTimeout(() => this.pending.delete(requestId), 120_000);
    timer.unref?.();
    this.pending.set(requestId, {
      windowId: window.webContents.id,
      url,
      timer,
    });
    if (!this.ready.has(window.webContents.id)) {
      const generation = this.generation;
      let allow = false;
      try {
        if (this.confirmNative) allow = await this.confirmNative(url);
        else {
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (generation !== this.generation || window.isDestroyed()) return;
          const translate = await nativeTranslator(
            preference(this.ctx.store.settings, "locale"),
          );
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
        if (generation === this.generation)
          await this.resolve(window.webContents.id, requestId, allow);
      } finally {
        clearTimeout(timer);
        this.pending.delete(requestId);
      }
      return;
    }
    this.ctx.appWindows.send(window, {
      type: "routed-link-confirm",
      requestId,
      url,
    });
  }

  async resolve(windowId: number, requestId: string, allow: boolean) {
    const request = this.pending.get(requestId);
    if (!request || request.windowId !== windowId) return;
    this.pending.delete(requestId);
    clearTimeout(request.timer);
    if (allow && linkOpens(request.url, this.ctx.policy()))
      await shell.openExternal(request.url);
  }

  dispose() {
    this.generation++;
    for (const request of this.pending.values()) clearTimeout(request.timer);
    this.pending.clear();
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
