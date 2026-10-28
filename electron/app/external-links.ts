import { shell } from "electron";
import { z } from "zod";
import {
  downloadPage,
  linkOpens,
  remoteImageAllowed,
} from "../../shared/external-links";
import type { AppContext, IpcHandle } from "./app-context";
import { connectAppMenu } from "./app-menu";
import { fetchRemoteImage } from "../workspace/remote-image";
import { previewLinkRouter } from "../artifacts/preview-link-routing";

/**
 * Leaving the app: links open in the system browser and remote Markdown images
 * load only as the administrator's policy allows. With external links off, the
 * pages the administrator named in the policy and hosts on its trusted domain
 * list still open; with an image domain list, images load only from those
 * hosts, redirects included.
 */
export function registerExternalLinkHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  handle("setRoutedLinkConfirmReady", (raw: unknown) => {
    const ready = z.boolean().parse(raw);
    const contents = ctx.window?.webContents;
    if (!contents) return;
    const router = previewLinkRouter(ctx);
    router.setReady(contents.id, ready);
    if (ready)
      contents.once("destroyed", () => router.setReady(contents.id, false));
  });
  handle("resolveRoutedLinkConfirm", (rawId: unknown, rawAllow: unknown) => {
    const id = z.string().uuid().parse(rawId);
    const allow = z.boolean().parse(rawAllow);
    if (ctx.window)
      return previewLinkRouter(ctx).resolve(
        ctx.window.webContents.id,
        id,
        allow,
      );
  });
  handle("openExternal", async (value: unknown) => {
    const url = new URL(z.string().max(4000).parse(value));
    if (!["https:", "http:"].includes(url.protocol))
      throw new Error("Only HTTP(S) links can be opened.");
    if (!linkOpens(url.href, ctx.policy()))
      throw new Error("Your administrator has turned off external links.");
    await shell.openExternal(url.href);
  });
  handle("loadRemoteImage", (value: unknown) => {
    const url = z.string().max(4000).parse(value);
    const policy = ctx.policy();
    if (!policy.remoteImages)
      throw new Error("Your administrator has turned off remote images.");
    return fetchRemoteImage(url, fetch, undefined, (next) =>
      remoteImageAllowed(next, ctx.policy()),
    );
  });
  handle("openUpdateDownload", () => openUpdateDownload(ctx));
  // The application menu's Check for Updates and Help read the same policy.
  connectAppMenu(ctx);
}

/** Opens the published update's https download page; nothing else. */
export async function openUpdateDownload(ctx: Pick<AppContext, "policy">) {
  const page = downloadPage(ctx.policy().update);
  if (!page)
    throw new Error("Your administrator hasn't published a download page.");
  await shell.openExternal(page);
}
