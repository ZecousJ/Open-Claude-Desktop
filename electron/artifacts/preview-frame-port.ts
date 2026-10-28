import type { BrowserWindow, MessagePortMain } from "electron";
import type { AppContext } from "../app/app-context";
import type { AppEvent } from "../../shared/types";

const accounts = new WeakMap<
  AppContext,
  Map<number, { port: MessagePortMain; close(): void }>
>();
const generations = new WeakMap<AppContext, number>();

// Transferable frame channel.
export async function requestPreviewFramePort(
  ctx: AppContext,
  window: BrowserWindow,
) {
  let ports = accounts.get(ctx);
  if (!ports) {
    ports = new Map();
    accounts.set(ctx, ports);
    ctx.onAccountDeactivating(() => {
      generations.set(ctx, (generations.get(ctx) ?? 0) + 1);
      for (const entry of ports!.values()) entry.close();
      ports!.clear();
    });
  }
  if (ports.has(window.id) || window.isDestroyed()) return;
  const generation = generations.get(ctx) ?? 0;
  const { MessageChannelMain } = await import("electron");
  if (
    ports.has(window.id) ||
    window.isDestroyed() ||
    generation !== (generations.get(ctx) ?? 0)
  )
    return;
  const { port1, port2 } = new MessageChannelMain();
  const close = () => {
    if (ports!.get(window.id)?.port === port1) ports!.delete(window.id);
    port1.close();
    window.removeListener("closed", close);
    window.webContents.removeListener("did-start-loading", close);
    window.webContents.removeListener("render-process-gone", close);
  };
  ports.set(window.id, { port: port1, close });
  window.once("closed", close);
  window.webContents.once("did-start-loading", close);
  window.webContents.once("render-process-gone", close);
  port1.start();
  window.webContents.postMessage("app:preview-frame-port", null, [port2]);
}

export function sendPreviewFrame(
  ctx: AppContext,
  window: BrowserWindow,
  event: AppEvent,
) {
  if (window.isDestroyed()) return;
  const entry = accounts.get(ctx)?.get(window.id);
  if (entry) {
    try {
      entry.port.postMessage(event);
      return;
    } catch {
      entry.close();
    }
  }
  ctx.appWindows.send(window, event);
}
