/**
 * The Claudex service's sharing API (R1, design 3.4): the status, and the
 * signed-in account's shares under `/api/v1/claudex/shares`. Every call
 * takes the current access token (`RemoteSession.authorized` renews it).
 * A service without the sharing component answers 404 to the status: that
 * reads as "no hosted sharing", like a service where it is turned off.
 */
import type {
  ArtifactEditAccessResult,
  ArtifactMailPreferences,
  ArtifactEmbed,
  ArtifactReport,
  ArtifactReportsState,
  HostedShare,
  ShareAccess,
  SharedChat,
  SharedChatContent,
  SharedChatReport,
  ShareInviteResult,
  ShareInviteOptions,
  ShareKind,
  SharingStatus,
} from "../../shared/sharing-api";
import {
  parseArtifactEmbed,
  parseArtifactReportsState,
  parseHostedShare,
  parseInviteResult,
  parseSharedChat,
  parseSharedChats,
  parseSharePage,
  parseSharingStatus,
  type CreateShareBody,
} from "../../shared/sharing";
import { requestJson, Sub2ApiError, type Fetch } from "./http";

/** Pages read for one list; 100 shares a page (the service caps each account far lower by default). */
const maxPages = 20;
const pageSize = 100;

function malformed(): never {
  throw new Sub2ApiError(
    502,
    "MALFORMED_RESPONSE",
    "The Claudex service sent an unexpected response.",
  );
}

function parseMailPreferences(value: unknown): ArtifactMailPreferences {
  const raw = (value ?? {}) as Record<string, unknown>;
  if (
    typeof raw.mentions !== "boolean" ||
    typeof raw.comments !== "boolean" ||
    typeof raw.shares !== "boolean"
  )
    malformed();
  return { mentions: raw.mentions, comments: raw.comments, shares: raw.shares };
}

export class ClaudexSharing {
  constructor(
    /** The service this account signed in to, e.g. `https://claudex.example`. */
    readonly baseUrl: string,
    private fetchImpl: Fetch = fetch,
  ) {}
  private call(
    token: string,
    route: string,
    init: { method?: string; body?: unknown } = {},
  ) {
    return requestJson(this.fetchImpl, `${this.baseUrl}/api/v1${route}`, {
      ...init,
      token,
    });
  }
  /** null: the service has no hosted sharing or the administrator turned it off. */
  async status(token: string): Promise<SharingStatus | null> {
    try {
      return parseSharingStatus(
        await this.call(token, "/claudex/sharing/status"),
      );
    } catch (error) {
      if (error instanceof Sub2ApiError && error.status === 404) return null;
      throw error;
    }
  }
  /** Creates the share, or gives the live one of the same source a fresh snapshot. */
  async create(token: string, body: CreateShareBody): Promise<HostedShare> {
    return (
      parseHostedShare(
        await this.call(token, "/claudex/shares", { method: "POST", body }),
        this.baseUrl,
      ) ?? malformed()
    );
  }
  /** Every share of the account (active and taken down; revoked ones are gone). */
  async list(token: string, kind?: ShareKind): Promise<HostedShare[]> {
    const shares: HostedShare[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const query = new URLSearchParams({
        page: String(page),
        page_size: String(pageSize),
        ...(kind ? { kind } : {}),
      });
      const result = parseSharePage(
        await this.call(token, `/claudex/shares?${query}`),
        this.baseUrl,
      );
      shares.push(...result.items);
      if (result.page >= result.pages || !result.items.length) break;
    }
    const seen = new Set<string>();
    return shares.filter((share) =>
      seen.has(share.id) ? false : (seen.add(share.id), true),
    );
  }
  /** One share; undefined when it no longer exists. */
  async get(token: string, id: string): Promise<HostedShare | undefined> {
    try {
      return parseHostedShare(
        await this.call(token, `/claudex/shares/${encodeURIComponent(id)}`),
        this.baseUrl,
      );
    } catch (error) {
      if (error instanceof Sub2ApiError && error.status === 404)
        return undefined;
      throw error;
    }
  }
  /** Stops a share; its link stops working. Stopping one already gone is not an error. */
  async revoke(token: string, id: string) {
    try {
      await this.call(token, `/claudex/shares/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
    } catch (error) {
      if (error instanceof Sub2ApiError && error.status === 404) return;
      throw error;
    }
  }
  /** Switches a share between the public link and invited people only. */
  async setAccess(
    token: string,
    id: string,
    access: ShareAccess,
  ): Promise<HostedShare> {
    return (
      parseHostedShare(
        await this.call(
          token,
          `/claudex/shares/${encodeURIComponent(id)}/access`,
          { method: "PUT", body: { access } },
        ),
        this.baseUrl,
      ) ?? malformed()
    );
  }
  /** Invites an address to a share. */
  async invite(
    token: string,
    id: string,
    email: string,
    options?: ShareInviteOptions,
  ): Promise<ShareInviteResult> {
    return (
      parseInviteResult(
        await this.call(
          token,
          `/claudex/shares/${encodeURIComponent(id)}/invites`,
          {
            method: "POST",
            body: {
              email,
              ...(options?.role ? { role: options.role } : {}),
              ...(options?.notify !== undefined
                ? { notify: options.notify }
                : {}),
              ...(options?.message ? { message: options.message } : {}),
            },
          },
        ),
        this.baseUrl,
      ) ?? malformed()
    );
  }
  /** Takes an address off a share. */
  async uninvite(
    token: string,
    id: string,
    email: string,
  ): Promise<HostedShare> {
    return (
      parseHostedShare(
        await this.call(
          token,
          `/claudex/shares/${encodeURIComponent(id)}/invites?${new URLSearchParams({ email })}`,
          { method: "DELETE" },
        ),
        this.baseUrl,
      ) ?? malformed()
    );
  }
  /** Which e-mails about artifacts the account wants. */
  async mailPreferences(token: string): Promise<ArtifactMailPreferences> {
    return parseMailPreferences(
      await this.call(token, "/claudex/sharing/mail-preferences"),
    );
  }
  async setMailPreferences(
    token: string,
    patch: Partial<ArtifactMailPreferences>,
  ): Promise<ArtifactMailPreferences> {
    return parseMailPreferences(
      await this.call(token, "/claudex/sharing/mail-preferences", {
        method: "PATCH",
        body: patch,
      }),
    );
  }
  /** A published artifact's embed address and allowed domains (Get embed code). */
  async embed(token: string, id: string): Promise<ArtifactEmbed> {
    return (
      parseArtifactEmbed(
        await this.call(
          token,
          `/claudex/shares/${encodeURIComponent(id)}/embed`,
        ),
        this.baseUrl,
      ) ?? malformed()
    );
  }
  /** Replaces the domains allowed to embed a published artifact. */
  async setEmbedDomains(
    token: string,
    id: string,
    domains: string[],
  ): Promise<ArtifactEmbed> {
    return (
      parseArtifactEmbed(
        await this.call(
          token,
          `/claudex/shares/${encodeURIComponent(id)}/embed`,
          { method: "PUT", body: { domains } },
        ),
        this.baseUrl,
      ) ?? malformed()
    );
  }
  /** Chats shared with the signed-in account. */
  async sharedWithMe(token: string): Promise<SharedChat[]> {
    return parseSharedChats(
      await this.call(token, "/claudex/sharing/shared-with-me"),
    );
  }
  async editSharedArtifact(
    token: string,
    shareToken: string,
    patch: { content?: string; comment?: string },
  ): Promise<void> {
    await this.call(
      token,
      `/claudex/sharing/shared-with-me/${encodeURIComponent(shareToken)}/artifact`,
      { method: "PUT", body: patch },
    );
  }
  async requestArtifactEditAccess(
    token: string,
    shareToken: string,
  ): Promise<ArtifactEditAccessResult> {
    try {
      const value = (await this.call(
        token,
        `/claudex/sharing/shared-with-me/${encodeURIComponent(shareToken)}/artifact-access`,
        { method: "POST", body: {} },
      )) as { status?: unknown };
      if (value.status === "pending" || value.status === "already_pending")
        return "filed";
      if (value.status === "already_granted" || value.status === "unavailable")
        return value.status;
      return "failed";
    } catch (error) {
      return error instanceof Sub2ApiError && error.status === 429
        ? "cooldown"
        : "failed";
    }
  }
  async respondArtifactEditAccess(
    token: string,
    shareToken: string,
    email: string,
    allow: boolean,
  ): Promise<void> {
    const value = (await this.call(
      token,
      `/claudex/sharing/shared-with-me/${encodeURIComponent(shareToken)}/artifact-access`,
      {
        method: "POST",
        body: { email, decision: allow ? "granted" : "declined" },
      },
    )) as { status?: unknown };
    if (value.status !== (allow ? "granted" : "declined")) malformed();
  }
  /** One shared chat's messages. */
  async readShared(
    token: string,
    shareToken: string,
  ): Promise<SharedChatContent> {
    return (
      parseSharedChat(
        await this.call(
          token,
          `/claudex/sharing/shared-with-me/${encodeURIComponent(shareToken)}`,
        ),
      ) ?? malformed()
    );
  }
  /** Reports a shared chat to the administrator (Report chat). */
  async reportShared(
    token: string,
    shareToken: string,
    report: SharedChatReport,
  ): Promise<void> {
    await this.call(
      token,
      `/claudex/sharing/shared-with-me/${encodeURIComponent(shareToken)}/report`,
      {
        method: "POST",
        body: {
          category: report.category,
          notes: report.notes ?? "",
          reporter_name: report.reporterName ?? "",
          reporter_email: report.reporterEmail ?? "",
          opt_out_of_training: report.optOutOfTraining,
        },
      },
    );
  }
  /**
   * Whether the service takes Report artifact (its status's
   * `artifact_reports`, which does not depend on sharing being on).
   */
  async artifactReportsState(token: string): Promise<ArtifactReportsState> {
    try {
      return parseArtifactReportsState(
        await this.call(token, "/claudex/sharing/status"),
      );
    } catch (error) {
      if (error instanceof Sub2ApiError && error.status === 404) return "none";
      throw error;
    }
  }
  /** Sends Report artifact to the administrator, with the artifact's copy. */
  async reportArtifact(token: string, report: ArtifactReport): Promise<void> {
    await this.call(token, "/claudex/sharing/artifact-reports", {
      method: "POST",
      body: {
        category: report.category,
        notes: report.notes ?? "",
        reporter_name: report.reporterName ?? "",
        reporter_email: report.reporterEmail ?? "",
        identity: report.identity,
        title: report.title,
        language: report.language,
        content: report.content,
        ...(report.contentBytes ? { content_bytes: report.contentBytes } : {}),
      },
    });
  }
}
