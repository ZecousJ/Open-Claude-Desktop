import type { WebContents } from "electron";

/** Per-renderer maximum and navigation cleanup. */
export class ProjectPromptCounts {
  private counts = new Map<WebContents, number>();
  private registered = new WeakSet<WebContents>();

  constructor(private changed: () => void) {}

  get count() {
    return Math.max(0, ...this.counts.values());
  }

  set(sender: WebContents, value: number) {
    if (sender.isDestroyed()) return;
    if (!this.registered.has(sender)) {
      this.registered.add(sender);
      const remove = () => {
        if (this.counts.delete(sender)) this.changed();
      };
      sender.once("destroyed", remove);
      sender.on("render-process-gone", remove);
      sender.on("did-navigate", remove);
      sender.on(
        "did-fail-load",
        (_event, code, _description, _url, isMainFrame) => {
          if (isMainFrame && code !== -3) remove();
        },
      );
    }
    const count = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    if (count === (this.counts.get(sender) ?? 0)) return;
    if (count) this.counts.set(sender, count);
    else this.counts.delete(sender);
    this.changed();
  }

  clear() {
    this.counts.clear();
    this.changed();
  }
}
