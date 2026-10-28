import {
  embedDomainList,
  embedDomainsError,
  shareKind,
  shareId,
} from "./sharing";
import { invalidEmbedDomains } from "../../shared/sharing";
import type { HostedShare, ShareKind } from "../../shared/sharing-api";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { ArtifactEmbedsService } from "./sharing";
import type { HostedShares } from "../artifacts/hosted-shares";

/** What registerHostedShareHandlers needs from sharing.ts. */
export interface RegisterHostedShareHandlersKit {
  ctx: AppContext;
  embeds: (
    raw: unknown,
  ) => Promise<{ id: string; service: ArtifactEmbedsService }>;
  handle: IpcHandle;
  hosted: () => HostedShares | undefined;
  required: () => HostedShares;
  translated: <A extends unknown[], T>(
    run: (...args: A) => Promise<T>,
    kind?: ShareKind | undefined,
  ) => (...args: A) => Promise<T>;
}

export function registerHostedShareHandlers(
  kit: RegisterHostedShareHandlersKit,
) {
  const { ctx, embeds, handle, hosted, required, translated } = kit;
  handle(
    "artifactEmbed",
    translated(async (raw: unknown) => {
      const { id, service } = await embeds(raw);
      return service.get(id);
    }, "artifact"),
  );
  handle("setArtifactEmbedDomains", async (raw: unknown, list: unknown) => {
    const domains = embedDomainList.parse(list);
    const invalid = invalidEmbedDomains(domains);
    if (invalid.length) throw new Error(`${invalid[0]} is not a valid domain`);
    try {
      const { id, service } = await embeds(raw);
      return await service.put(id, domains);
    } catch (error) {
      throw embedDomainsError(error);
    }
  });
  handle(
    "hostedShares",
    translated(async (raw: unknown): Promise<HostedShare[]> => {
      const kind = shareKind.parse(raw ?? undefined);
      const shares = hosted();
      if (!shares || !(await shares.status().catch(() => null))) return [];
      return shares.list(kind, true);
    }),
  );
  handle(
    "revokeShare",
    translated(async (raw: unknown) => {
      const id = shareId.parse(raw);
      const shares = required();
      await shares.find(id);
      await shares.revoke(id);
    }),
  );
  handle(
    "openShare",
    translated(async (raw: unknown) => {
      const id = shareId.parse(raw);
      const share = await required().find(id);
      if (!share || share.status !== "active")
        throw new Error("This link no longer exists.");
      const url = new URL(share.url);
      // Plain http only for a service reached over plain http (development).
      const base = ctx.remote
        ? new URL(ctx.remote.accounts.baseUrl)
        : undefined;
      if (
        url.protocol !== "https:" &&
        !(url.protocol === "http:" && base?.protocol === "http:")
      )
        throw new Error("Only secure links can be opened.");
      // Loaded here so the handlers can be tested without Electron. The
      // address is the service's own page, so the external-links policy
      // (which governs links in replies) does not apply.
      const { shell } = await import("electron");
      await shell.openExternal(url.href);
    }),
  );
}
