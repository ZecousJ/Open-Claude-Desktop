import { z } from "zod";
import { maxFaviconHosts } from "../../shared/favicon-api";
import type { AppContext, IpcHandle } from "../app/app-context";
import {
  FaviconService,
  electronFetchIcon,
  type FetchIcon,
} from "../app/favicons";

const hosts = z.array(z.string().min(1).max(253)).max(maxFaviconHosts);

/**
 * Site icons (R5, shared/favicon-api.ts; electron/favicons.ts). Each
 * signed-in account keeps its own icon cache. With remote images turned off
 * by the administrator nothing is fetched and every host answers null (the
 * window draws its initial-letter placeholder).
 */
export function registerFaviconHandlers(
  handle: IpcHandle,
  ctx: AppContext,
  fetchIcon: FetchIcon = electronFetchIcon(),
) {
  let service: FaviconService | undefined;
  ctx.onAccountActivated(() => {
    service = new FaviconService(ctx.store.root, (url, options) =>
      ctx.store.settings.disableNonessentialServices
        ? Promise.resolve(null)
        : fetchIcon(url, options),
    );
  });
  ctx.onAccountDeactivating(() => {
    service = undefined;
  });
  handle("getFavicons", async (raw: unknown) => {
    const asked = hosts.parse(raw);
    const policy = ctx.policy();
    if (
      !service ||
      !policy.remoteImages ||
      ctx.store.settings.disableNonessentialServices
    )
      return Object.fromEntries(asked.map((host) => [host, null]));
    const icons = await service.icons(asked, policy);
    return ctx.store.settings.disableNonessentialServices
      ? Object.fromEntries(asked.map((host) => [host, null]))
      : icons;
  });
}
