import { webContents, type WebContents } from "electron";
import { z } from "zod";
import type { EditCommand } from "../../shared/edit-commands-api";
import type { AppContext, IpcHandle } from "./app-context";

const owners = new WeakMap<
  WebContents,
  { contextMenuAt?: number; ownHistory?: boolean }
>();
const watched = new WeakSet<WebContents>();

// Claimed history belongs to the focused editor, not embedded pages.
export function routeEditCommand(
  command: EditCommand,
  contents = webContents.getFocusedWebContents(),
) {
  if (!contents || contents.isDestroyed()) return;
  if (
    owners.has(contents) &&
    (!contents.focusedFrame || contents.focusedFrame === contents.mainFrame)
  ) {
    contents.send("app:event", { type: "edit-command", command });
  } else contents[command]();
}

export function contextMenuOwnsHistory(
  contents: WebContents,
  now = Date.now(),
) {
  const owner = owners.get(contents);
  if (!owner) return false;
  const recent =
    owner.ownHistory === true && now - (owner.contextMenuAt ?? 0) < 1000;
  delete owner.contextMenuAt;
  delete owner.ownHistory;
  return recent;
}

export function registerEditCommandHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  handle("claimEditCommands", () => {
    const contents = ctx.window?.webContents;
    if (!contents || owners.has(contents)) return;
    owners.set(contents, {});
    if (!watched.has(contents)) {
      watched.add(contents);
      contents.on("did-navigate", () => owners.delete(contents));
      contents.on("render-process-gone", () => owners.delete(contents));
      contents.once("destroyed", () => owners.delete(contents));
    }
  });
  handle("releaseEditCommands", () => {
    const contents = ctx.window?.webContents;
    if (contents) owners.delete(contents);
  });
  handle("reportContextMenuEditor", (value: unknown) => {
    const ownHistory = z.boolean().parse(value);
    const contents = ctx.window?.webContents;
    const owner = contents && owners.get(contents);
    if (owner) Object.assign(owner, { ownHistory, contextMenuAt: Date.now() });
  });
  handle("editCommandUnclaimed", (value: unknown) => {
    const command = z.enum(["undo", "redo"]).parse(value);
    ctx.window?.webContents[command]();
  });
}
