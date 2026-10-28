import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type {
  LayoutCommand,
  LayoutCommandResult,
} from "../../shared/window-layout";

export type LayoutDispatchResult =
  | { kind: "result"; result: LayoutCommandResult }
  | { kind: "no_window" | "not_listening" | "timeout" };

// .
export class WindowLayoutCommands {
  private listening = new WeakSet<WebContents>();
  private registered = new WeakSet<WebContents>();
  private pending = new Map<
    string,
    {
      contents: WebContents;
      timer: ReturnType<typeof setTimeout>;
      resolve: (result: LayoutDispatchResult) => void;
    }
  >();

  setListening(contents: WebContents, listening: boolean) {
    if (!this.registered.has(contents)) {
      this.registered.add(contents);
      const drop = () => this.drop(contents, "no_window");
      contents.on("did-navigate", drop);
      contents.on("render-process-gone", drop);
      contents.on("destroyed", drop);
    }
    if (listening) this.listening.add(contents);
    else this.drop(contents, "not_listening");
  }

  report(contents: WebContents, result: LayoutCommandResult) {
    const pending = this.pending.get(result.requestId);
    if (!pending || pending.contents !== contents) return;
    clearTimeout(pending.timer);
    this.pending.delete(result.requestId);
    pending.resolve({ kind: "result", result });
  }

  dispatch(
    contents: WebContents | undefined,
    command: Omit<LayoutCommand, "requestId" | "deadline" | "mainWindowHidden">,
    hidden: boolean,
    send: (command: LayoutCommand) => void,
    timeout = 10000,
  ): Promise<LayoutDispatchResult> {
    if (!contents || contents.isDestroyed())
      return Promise.resolve({ kind: "no_window" });
    if (!this.listening.has(contents))
      return Promise.resolve({ kind: "not_listening" });
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ kind: "timeout" });
      }, timeout);
      this.pending.set(requestId, { contents, timer, resolve });
      try {
        send({
          ...command,
          requestId,
          deadline: Date.now() + timeout,
          mainWindowHidden: hidden,
        });
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        resolve({ kind: "no_window" });
      }
    });
  }

  dispose() {
    for (const { contents } of this.pending.values())
      this.drop(contents, "no_window");
    this.listening = new WeakSet();
  }

  private drop(contents: WebContents, kind: "no_window" | "not_listening") {
    this.listening.delete(contents);
    for (const [id, pending] of this.pending) {
      if (pending.contents !== contents) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve({ kind });
    }
  }
}
