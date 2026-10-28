import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import type {
  ArtifactMailPreferences,
  ArtifactEmbed,
  ArtifactReport,
  ArtifactReportsState,
  ShareKind,
} from "../../shared/sharing-api";
import {
  artifactReportContentChars,
  maxEmbedDomains,
  reportFormCategories,
  sharingErrorCodes,
} from "../../shared/sharing";
import { ClaudexSharing } from "../sub2api/claudex-sharing";
import { Sub2ApiError } from "../sub2api/http";
import { SnapshotError } from "../conversations/conversation-snapshot";
import { HostedShares } from "../artifacts/hosted-shares";
import { unavailableMessage } from "../artifacts/hosted-shares-support";
import { latestGeneratedFiles } from "../../shared/generated-files";
import { registerHostedShareHandlers } from "./sharing-hosted";

declare module "../app/app-context" {
  interface SharingSlot {
    /** The signed-in Claudex account's hosted shares. */
    hosted: HostedShares;
  }
}

const conversationId = z.string().min(1).max(200);
export const shareId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const email = z.string().trim().min(3).max(254);
const access = z.enum(["link", "invited"]);
const shareToken = z.string().regex(/^[A-Za-z0-9_-]{20,64}$/);
export const shareKind = z.enum(["conversation", "artifact"]).optional();
export const embedDomainList = z
  .array(z.string().trim().toLowerCase().min(1).max(253))
  .max(maxEmbedDomains);
const chatReport = z
  .object({
    category: z.enum(reportFormCategories),
    notes: z.string().max(1000).optional(),
    reporterName: z.string().max(255).optional(),
    reporterEmail: z.string().max(255).optional(),
    optOutOfTraining: z.boolean(),
  })
  .strict();
const artifactIdentity = z.string().min(1).max(3_000_000);
const artifactReport = z
  .object({
    category: z.enum(reportFormCategories),
    notes: z.string().max(1024).optional(),
    reporterName: z.string().max(255).optional(),
    reporterEmail: z.string().max(255).optional(),
    identity: z.string().min(1).max(3_000_000),
    title: z.string().max(400),
    language: z.string().max(32),
    content: z.string().max(artifactReportContentChars),
    contentBytes: z.number().int().nonnegative().optional(),
  })
  .strict();
const artifactInput = z
  .object({
    identity: artifactIdentity,
    title: z.string().min(1).max(200),
    language: z.string().min(1).max(30),
    content: z.string().max(32 * 1024 * 1024),
    screenshot: z
      .string()
      .max(2 * 1024 * 1024)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/)
      .optional(),
  })
  .strict();

/**
 * What a sharing failure means to the person (design R1 4.1): the service's
 * refusals by code, an unreachable service, a snapshot that cannot be made.
 */
export function sharingError(error: unknown, kind?: ShareKind): Error {
  if (error instanceof SnapshotError) return new Error(error.message);
  if (!(error instanceof Sub2ApiError))
    return error instanceof Error ? error : new Error(String(error));
  const tooLarge =
    kind === "artifact"
      ? "This artifact is too large to share."
      : "This chat is too large to share.";
  switch (error.code) {
    case sharingErrorCodes.tooLarge:
      return new Error(tooLarge);
    case sharingErrorCodes.blocked:
      return new Error(
        "Your administrator has turned off sharing for your account.",
      );
    case sharingErrorCodes.disabled:
    case sharingErrorCodes.kindDisabled:
      return new Error("Your administrator has turned off sharing.");
    case sharingErrorCodes.quota:
      return new Error(
        "You've reached the limit of shared links. Stop sharing an older one and try again.",
      );
    case sharingErrorCodes.notFound:
      return new Error("This link no longer exists.");
    case "UNREACHABLE":
      return new Error("Couldn't reach the Claudex service. Try again.");
  }
  if (error.status === 413) return new Error(tooLarge);
  if (error.status === 429)
    return new Error("Too many sharing requests. Try again in a minute.");
  return new Error(error.message);
}

/**
 * What a failed Report artifact says: the live viewer's two toasts, and reports
 * turned off by the administrator.
 */
export function artifactReportError(error: unknown): Error {
  if (error instanceof Sub2ApiError) {
    if (error.code === "CLAUDEX_REPORTS_OFF")
      return new Error("Your administrator has turned off reports.");
    if (error.status === 429)
      return new Error("Too many reports submitted. Try again in a moment.");
  }
  return new Error("Couldn’t send the report. Try again.");
}

/** The service calls behind Report artifact. */
interface ArtifactReportsService {
  state(): Promise<ArtifactReportsState>;
  send(report: ArtifactReport): Promise<void>;
}

/** The service calls behind Get embed code. */
export interface ArtifactMailService {
  get(): Promise<ArtifactMailPreferences>;
  set(
    patch: Partial<ArtifactMailPreferences>,
  ): Promise<ArtifactMailPreferences>;
}

export interface ArtifactEmbedsService {
  get(shareId: string): Promise<ArtifactEmbed>;
  put(shareId: string, domains: string[]): Promise<ArtifactEmbed>;
}

/**
 * What a failed Allowed domains save says: the live dialog's own message for
 * the domains the service refused, otherwise what any sharing failure says.
 */
export function embedDomainsError(error: unknown): Error {
  if (
    error instanceof Sub2ApiError &&
    error.code === "CLAUDEX_EMBED_DOMAINS_INVALID"
  ) {
    const domain = error.metadata?.domain;
    if (domain) return new Error(`${domain} is not a valid domain`);
  }
  return sharingError(error, "artifact");
}

/**
 * Hosted sharing (R1, shared/sharing-api.ts): Share chat / Share session,
 * public artifact links (Anyone with the link, Publish, Open in web) and the
 * account's list of links. Only a Claudex (Sub2API) account whose service
 * offers sharing has any; for a local account `sharingStatus()` is null and
 * every change is refused.
 */
export function registerSharingHandlers(handle: IpcHandle, ctx: AppContext) {
  let current:
    | {
        remote: object;
        hosted: HostedShares;
        reports: ArtifactReportsService;
        embeds: ArtifactEmbedsService;
        mail: ArtifactMailService;
      }
    | undefined;
  const detach = () => {
    if (!current) return;
    current.hosted.close();
    if (ctx.artifactShares?.hosted === current.hosted)
      ctx.artifactShares.hosted = undefined;
    if (ctx.services?.sharing?.hosted === current.hosted)
      delete ctx.services.sharing;
    current = undefined;
  };
  /** The signed-in account's hosted shares; undefined for a local account. */
  const hosted = (): HostedShares | undefined => {
    const remote = ctx.remote;
    if (!remote) {
      detach();
      return undefined;
    }
    if (current?.remote === remote) return current.hosted;
    detach();
    const api = new ClaudexSharing(remote.accounts.baseUrl);
    const authorized = <T>(call: (token: string) => Promise<T>) =>
      remote.session.authorized(call);
    const shares = new HostedShares({
      service: {
        requestArtifactEditAccess: (shareToken) =>
          authorized((token) =>
            api.requestArtifactEditAccess(token, shareToken),
          ),
        respondArtifactEditAccess: (shareToken, address, allow) =>
          authorized((token) =>
            api.respondArtifactEditAccess(token, shareToken, address, allow),
          ),
        status: () => authorized((token) => api.status(token)),
        create: (body) => authorized((token) => api.create(token, body)),
        list: (kind) => authorized((token) => api.list(token, kind)),
        revoke: async (id) => authorized((token) => api.revoke(token, id)),
        setAccess: (id, mode) =>
          authorized((token) => api.setAccess(token, id, mode)),
        invite: (id, address, options) =>
          authorized((token) => api.invite(token, id, address, options)),
        uninvite: (id, address) =>
          authorized((token) => api.uninvite(token, id, address)),
        sharedWithMe: () => authorized((token) => api.sharedWithMe(token)),
        readShared: (shareToken) =>
          authorized((token) => api.readShared(token, shareToken)),
        editSharedArtifact: (shareToken, patch) =>
          authorized((token) =>
            api.editSharedArtifact(token, shareToken, patch),
          ),
        reportShared: (shareToken, report) =>
          authorized((token) => api.reportShared(token, shareToken, report)),
      },
      root: ctx.store.root,
      conversation: (id) => ctx.store.conversations.find((c) => c.id === id),
      changed: (kind, sourceKey) => {
        if (ctx.remote !== remote) return;
        ctx.push({
          type: "sharing",
          kind,
          ...(sourceKey ? { sourceKey } : {}),
        });
        if (kind === "artifact")
          ctx.push({
            type: "artifact-shares",
            shares: ctx.artifactShares.list(),
          });
      },
    });
    current = {
      remote,
      hosted: shares,
      reports: {
        state: () => authorized((token) => api.artifactReportsState(token)),
        send: (report) =>
          authorized((token) => api.reportArtifact(token, report)),
      },
      mail: {
        get: () => authorized((token) => api.mailPreferences(token)),
        set: (patch) =>
          authorized((token) => api.setMailPreferences(token, patch)),
      },
      embeds: {
        get: (id) => authorized((token) => api.embed(token, id)),
        put: (id, domains) =>
          authorized((token) => api.setEmbedDomains(token, id, domains)),
      },
    };
    ctx.artifactShares.hosted = shares;
    ctx.services.sharing = { hosted: shares };
    return shares;
  };
  const required = () => {
    const shares = hosted();
    if (!shares) throw new Error(unavailableMessage);
    return shares;
  };
  const translated =
    <A extends unknown[], T>(
      run: (...args: A) => Promise<T>,
      kind?: ShareKind,
    ) =>
    async (...args: A) => {
      try {
        return await run(...args);
      } catch (error) {
        throw sharingError(error, kind);
      }
    };

  // A signed-in Claudex account reads its links once, so artifacts already
  // published show so before any Publish dialog opens.
  ctx.onAccountActivated?.(() => {
    const shares = hosted();
    if (!shares) return;
    shares
      .status()
      .then(async (status) => {
        if (!status) return;
        await shares.list();
        ctx.push({
          type: "artifact-shares",
          shares: ctx.artifactShares.list(),
        });
      })
      .catch(() => {
        // Offline: the dialogs read again when they open.
      });
  });
  ctx.onAccountDeactivating?.(detach);

  ctx.onEvent?.((event) => {
    if (event.type !== "conversation" || event.conversation.incognito) return;
    const shares = current?.hosted;
    if (!shares) return;
    for (const file of latestGeneratedFiles(
      event.conversation.turns,
    ).values()) {
      if (
        file.state !== "ready" ||
        file.blob ||
        file.tooLarge ||
        file.content === undefined
      )
        continue;
      void shares
        .syncAutoArtifact({
          identity: JSON.stringify([event.conversation.id, file.path]),
          title: file.name,
          language: file.language,
          content: file.content,
        })
        .catch((error) => console.error("Artifact automatic sharing:", error));
    }
  });

  handle(
    "artifactShareState",
    translated(
      (raw: unknown) => required().artifactShareState(artifactInput.parse(raw)),
      "artifact",
    ),
  );
  handle(
    "shareArtifact",
    translated(
      (raw: unknown, automatic: unknown, audience: unknown) =>
        required().shareArtifact(
          artifactInput.parse(raw),
          z.boolean().parse(automatic),
          z.enum(["link", "invited"]).optional().parse(audience),
        ),
      "artifact",
    ),
  );
  handle(
    "setArtifactShareAccess",
    translated(
      (raw: unknown, audience: unknown) =>
        required().setArtifactShareAccess(
          artifactInput.parse(raw),
          z.enum(["link", "invited"]).parse(audience),
        ),
      "artifact",
    ),
  );
  handle(
    "setArtifactAutoShare",
    translated(
      (raw: unknown, automatic: unknown) =>
        required().setArtifactAutoShare(
          artifactInput.parse(raw),
          z.boolean().parse(automatic),
        ),
      "artifact",
    ),
  );
  handle(
    "unshareArtifact",
    translated(
      (raw: unknown) => required().unshareArtifact(artifactIdentity.parse(raw)),
      "artifact",
    ),
  );

  handle("sharingStatus", async () => {
    const shares = hosted();
    if (!shares) return null;
    try {
      return await shares.status();
    } catch {
      // Unreachable: no Share entry until the service answers again.
      return null;
    }
  });
  handle(
    "conversationShare",
    translated(async (raw: unknown) => {
      const id = conversationId.parse(raw);
      const shares = hosted();
      return shares ? shares.conversationShare(id) : null;
    }),
  );
  handle(
    "shareConversation",
    translated(async (raw: unknown, mode?: unknown) => {
      const id = conversationId.parse(raw);
      return required().shareConversation(
        id,
        access.optional().parse(mode ?? undefined),
      );
    }, "conversation"),
  );
  handle(
    "setShareAccess",
    translated(
      async (raw: unknown, mode: unknown) =>
        required().setShareAccess(
          conversationId.parse(raw),
          access.parse(mode),
        ),
      "conversation",
    ),
  );
  handle(
    "inviteToShare",
    translated(
      async (raw: unknown, address: unknown) =>
        required().inviteToShare(
          conversationId.parse(raw),
          email.parse(address),
        ),
      "conversation",
    ),
  );
  handle(
    "removeShareInvite",
    translated(
      async (raw: unknown, address: unknown) =>
        required().removeShareInvite(
          conversationId.parse(raw),
          email.parse(address),
        ),
      "conversation",
    ),
  );
  handle(
    "sharedWithMe",
    translated(async () => {
      const shares = hosted();
      if (!shares || !(await shares.status().catch(() => null))) return [];
      return shares.sharedWithMe();
    }),
  );
  handle(
    "readSharedChat",
    translated(async (raw: unknown) =>
      required().readSharedChat(shareToken.parse(raw)),
    ),
  );
  const importShared = async (token: string, refreshId?: string) => {
    const library = ctx.artifactLibrary;
    const root = ctx.store.root;
    const shares = required();
    const content = await shares.readSharedChat(token);
    if (
      ctx.store.root !== root ||
      ctx.artifactLibrary !== library ||
      required() !== shares
    )
      throw new Error("The request failed.");
    if (
      refreshId &&
      !library
        .list()
        .copies.some(
          (entry) =>
            entry.libraryId === refreshId &&
            entry.sharedArtifactToken === token,
        )
    )
      throw new Error("The request failed.");
    const artifact = content.kind === "artifact" && content.artifacts?.[0];
    if (!artifact) throw new Error("Failed to import shared artifact.");
    return library.importShared(
      token,
      {
        name: artifact.title,
        language: artifact.language,
        content: artifact.content,
      },
      Boolean(refreshId),
    );
  };
  handle(
    "importSharedArtifact",
    translated((raw: unknown) => importShared(shareToken.parse(raw))),
  );
  handle(
    "refreshImportedArtifact",
    translated((raw: unknown) => {
      const libraryId = z.string().uuid().parse(raw);
      const copy = ctx.artifactLibrary
        .list()
        .copies.find((entry) => entry.libraryId === libraryId);
      if (!copy?.sharedArtifactToken) throw new Error("The request failed.");
      return importShared(copy.sharedArtifactToken, libraryId);
    }),
  );
  handle("requestArtifactEditAccess", async (raw: unknown) =>
    required().requestArtifactEditAccess(shareToken.parse(raw)),
  );
  handle(
    "respondArtifactEditAccess",
    translated(
      async (raw: unknown, address: unknown, allow: unknown) =>
        required().respondArtifactEditAccess(
          shareToken.parse(raw),
          email.parse(address),
          z.boolean().parse(allow),
        ),
      "artifact",
    ),
  );
  handle(
    "inviteToArtifact",
    translated(
      async (raw: unknown, address: unknown, options: unknown) =>
        required().inviteToArtifact(
          shareId.parse(raw),
          email.parse(address),
          z
            .object({
              role: z.enum(["view", "comment", "edit"]).optional(),
              notify: z.boolean().optional(),
              message: z.string().max(300).optional(),
            })
            .strict()
            .parse(options ?? {}),
        ),
      "artifact",
    ),
  );
  handle(
    "removeArtifactInvite",
    translated(
      async (raw: unknown, address: unknown) =>
        required().removeArtifactInvite(
          shareId.parse(raw),
          email.parse(address),
        ),
      "artifact",
    ),
  );
  handle(
    "editSharedArtifact",
    translated(
      async (raw: unknown, patch: unknown) =>
        required().editSharedArtifact(
          shareToken.parse(raw),
          z
            .object({
              content: z.string().max(2_000_000).optional(),
              comment: z.string().trim().min(1).max(4000).optional(),
            })
            .strict()
            .parse(patch),
        ),
      "artifact",
    ),
  );
  handle(
    "reportSharedChat",
    translated(async (raw: unknown, report: unknown) => {
      await required().reportSharedChat(
        shareToken.parse(raw),
        chatReport.parse(report),
      );
    }),
  );
  // Report artifact goes to the administrator of the account's service,
  // whether or not sharing is on there; a local account has none.
  const artifactReports = () => (hosted() ? current?.reports : undefined);
  // The account's artifact e-mails: none to set without hosted sharing.
  handle("artifactMailPreferences", async () => {
    const shares = hosted();
    if (!shares || !(await shares.status().catch(() => null))) return null;
    return current!.mail.get();
  });
  handle("setArtifactMailPreferences", async (raw: unknown) => {
    const patch = z
      .object({
        mentions: z.boolean().optional(),
        comments: z.boolean().optional(),
        shares: z.boolean().optional(),
      })
      .strict()
      .parse(raw);
    if (!hosted()) throw new Error(unavailableMessage);
    return current!.mail.set(patch);
  });
  handle("artifactReportsState", async (): Promise<ArtifactReportsState> => {
    const reports = artifactReports();
    if (!reports) return "none";
    try {
      return await reports.state();
    } catch {
      // Unreachable now: offer Report, and sending says what went wrong.
      return "open";
    }
  });
  handle("reportArtifact", async (raw: unknown) => {
    const report = artifactReport.parse(raw);
    const reports = artifactReports();
    if (!reports)
      throw new Error("Reports go to a Claudex service; sign in to one first.");
    try {
      await reports.send(report);
    } catch (error) {
      throw artifactReportError(error);
    }
  });
  handle(
    "unshareConversation",
    translated(async (raw: unknown) => {
      await required().unshareConversation(conversationId.parse(raw));
    }, "conversation"),
  );
  handle(
    "publishArtifact",
    translated(async (raw: unknown) => {
      const input = artifactInput.parse(raw);
      return required().publishArtifact(input);
    }, "artifact"),
  );
  handle(
    "artifactPublication",
    translated(async (raw: unknown) => {
      const input = artifactInput.parse(raw);
      const shares = hosted();
      return shares ? shares.publication(input) : null;
    }, "artifact"),
  );
  handle(
    "unpublishArtifact",
    translated(async (raw: unknown) => {
      await required().unpublishArtifact(artifactIdentity.parse(raw));
    }, "artifact"),
  );
  // Get embed code: only for a published artifact of this account (the
  // service checks too); the domains are checked here as the dialog does.
  const embeds = async (raw: unknown) => {
    const id = shareId.parse(raw);
    const shares = required();
    const share = await shares.find(id);
    if (!share || share.kind !== "artifact" || share.status !== "active")
      throw new Error("This link no longer exists.");
    return { id, service: current!.embeds };
  };
  registerHostedShareHandlers({
    ctx,
    embeds,
    handle,
    hosted,
    required,
    translated,
  });
}
