import fs from "node:fs";
import path from "node:path";
import type {
  ArtifactEditAccessResult,
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
import type { CreateShareBody } from "../../shared/sharing";
import { shareExpired } from "../../shared/sharing";
import type { Conversation } from "../../shared/types";
import type { HostedArtifactLinks } from "./artifact-shares";
import { lastSharedTurn } from "../conversations/conversation-snapshot";
import {
  unavailableMessage,
  maxSources,
  maxStoredSource,
  sourceKeyOf,
  versionSource,
  sharingSource,
  sharingStopKey,
} from "./hosted-shares-support";
import * as hostedSharesConversations from "./hosted-shares-conversations";
import { installMethods } from "./install-methods";
import * as hostedSharesArtifacts from "./hosted-shares-artifacts";

/** The service calls HostedShares makes (ClaudexSharing with the session's token). */
export interface SharingService {
  requestArtifactEditAccess?(token: string): Promise<ArtifactEditAccessResult>;
  respondArtifactEditAccess?(
    token: string,
    email: string,
    allow: boolean,
  ): Promise<void>;
  status(): Promise<SharingStatus | null>;
  create(body: CreateShareBody): Promise<HostedShare>;
  list(kind?: ShareKind): Promise<HostedShare[]>;
  revoke(id: string): Promise<void>;
  setAccess(id: string, access: ShareAccess): Promise<HostedShare>;
  invite(
    id: string,
    email: string,
    options?: ShareInviteOptions,
  ): Promise<ShareInviteResult>;
  uninvite(id: string, email: string): Promise<HostedShare>;
  sharedWithMe(): Promise<SharedChat[]>;
  readShared(token: string): Promise<SharedChatContent>;
  editSharedArtifact?(
    token: string,
    patch: { content?: string; comment?: string },
  ): Promise<void>;
  reportShared(token: string, report: SharedChatReport): Promise<void>;
}

export interface HostedSharesOptions {
  service: SharingService;
  /** The account profile folder (`hosted-shares.json`). */
  root: string;
  /** A conversation of this account, or undefined. */
  conversation(id: string): Conversation | undefined;
  /** A share was made, refreshed or stopped (the window is told). */
  changed(kind: ShareKind, sourceKey?: string): void;
  now?: () => number;
  /** How long a status or list stays fresh. */
  cacheMs?: number;
}

interface Source {
  kind: ShareKind;
  sharing?: true;
  /** The conversation id or artifact identity. */
  source: string;
  /** The last turn the conversation's snapshot included. */
  turn?: string;
  /**
   * sha256 of the artifact snapshot last uploaded, for a link made before
   * each version was published on its own (that link followed changes).
   */
  digest?: string;
  /** The artifact version the link keeps (`versionOf`). */
  version?: string;
}

export class HostedShares implements HostedArtifactLinks {
  private readonly file: string;
  readonly now: () => number;
  private readonly cacheMs: number;
  sources = new Map<string, Source>();
  /** Version keys unpublished here, oldest first. */
  unpublished = new Set<string>();
  autoArtifacts = new Set<string>();
  artifactUpdates = new Map<string, Promise<unknown>>();
  autoRevisions = new Map<string, number>();
  private statusCache?: { at: number; value: SharingStatus | null };
  private statusLoad?: Promise<SharingStatus | null>;
  listCache?: { at: number; shares: HostedShare[] };
  private listLoad?: Promise<HostedShare[]>;
  /**
   * Bumped when an artifact's links stop (by identity), so an upload
   * already on its way does not bring one back.
   */
  stops = new Map<string, number>();
  closed = false;
  constructor(public options: HostedSharesOptions) {
    this.file = path.join(options.root, "hosted-shares.json");
    this.now = options.now ?? Date.now;
    this.cacheMs = options.cacheMs ?? 60_000;
    this.read();
  }

  // ---- remembered sources

  private read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
      const automatic = (data as { autoArtifacts?: unknown })?.autoArtifacts;
      if (Array.isArray(automatic))
        for (const identity of automatic.slice(-maxSources))
          if (
            typeof identity === "string" &&
            identity.length <= maxStoredSource
          )
            this.autoArtifacts.add(identity);
      const unpublished = (data as { unpublished?: unknown })?.unpublished;
      if (Array.isArray(unpublished))
        for (const key of unpublished.slice(-maxSources))
          if (typeof key === "string" && /^[a-f0-9]{64}$/.test(key))
            this.unpublished.add(key);
      const sources = (data as { sources?: unknown })?.sources;
      if (!sources || typeof sources !== "object") return;
      for (const [key, raw] of Object.entries(sources)) {
        const value = raw as Partial<Source>;
        const version =
          value.kind === "artifact" &&
          typeof value.version === "string" &&
          /^[a-f0-9]{64}$/.test(value.version)
            ? value.version
            : undefined;
        if (
          /^[a-f0-9]{64}$/.test(key) &&
          (value.kind === "conversation" || value.kind === "artifact") &&
          typeof value.source === "string" &&
          sourceKeyOf(
            value.kind,
            version
              ? versionSource(
                  value.sharing ? sharingSource(value.source) : value.source,
                  version,
                )
              : value.sharing
                ? sharingSource(value.source)
                : value.source,
          ) === key
        )
          this.sources.set(key, {
            kind: value.kind,
            source: value.source,
            ...(typeof value.turn === "string" ? { turn: value.turn } : {}),
            ...(typeof value.digest === "string" &&
            /^[a-f0-9]{64}$/.test(value.digest)
              ? { digest: value.digest }
              : {}),
            ...(version ? { version } : {}),
            ...(value.sharing === true ? { sharing: true } : {}),
          });
      }
    } catch {
      // Missing or unreadable: links made here show without their source
      // until they are shared again; nothing else depends on the file.
    }
  }
  save() {
    if (this.closed) return;
    const entries = [...this.sources].filter(
      ([, value]) => value.source.length <= maxStoredSource,
    );
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          version: 1,
          sources: Object.fromEntries(entries.slice(-maxSources)),
          unpublished: [...this.unpublished],
          autoArtifacts: [...this.autoArtifacts],
        }),
        { mode: 0o600 },
      );
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error(
        "Couldn't save the shared links' sources:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  remember(key: string, source: Source) {
    this.sources.delete(key);
    this.sources.set(key, source);
    this.save();
  }

  // ---- service state

  /** What the service allows now; null without hosted sharing. Cached for a minute. */
  async status(force = false): Promise<SharingStatus | null> {
    const cached = this.statusCache;
    if (!force && cached && this.now() - cached.at < this.cacheMs)
      return cached.value;
    this.statusLoad ??= this.options.service
      .status()
      .then((value) => {
        this.statusCache = { at: this.now(), value };
        return value;
      })
      .catch((error: unknown) => {
        // Offline: keep offering what the service allowed last.
        if (cached) return cached.value;
        throw error;
      })
      .finally(() => {
        this.statusLoad = undefined;
      });
    return this.statusLoad;
  }
  async allowed(kind: ShareKind) {
    const status = await this.status();
    if (!status) throw new Error(unavailableMessage);
    if (status.blocked)
      throw new Error(
        "Your administrator has turned off sharing for your account.",
      );
    if (!(kind === "conversation" ? status.conversations : status.artifacts))
      throw new Error(
        kind === "conversation"
          ? "Your administrator has turned off sharing chats."
          : "Your administrator has turned off sharing artifacts.",
      );
    return status;
  }
  /** The account's links, with their sources where this computer knows them. */
  async list(kind?: ShareKind, force = false): Promise<HostedShare[]> {
    const cached = this.listCache;
    let shares: HostedShare[];
    if (!force && cached && this.now() - cached.at < this.cacheMs)
      shares = cached.shares;
    else {
      this.listLoad ??= this.options.service
        .list()
        .then((value) => {
          this.listCache = { at: this.now(), shares: value };
          return value;
        })
        .finally(() => {
          this.listLoad = undefined;
        });
      shares = await this.listLoad;
    }
    return shares
      .filter((share) => !kind || share.kind === kind)
      .filter((share) => !shareExpired(share, this.now()))
      .map((share) => this.present(share));
  }
  /** A wire share as the window sees it: its source, and whether it is behind. */
  present(share: HostedShare): HostedShare {
    const known = this.sources.get(share.sourceKey);
    const source = known?.kind === share.kind ? known.source : "";
    const shown: HostedShare = { ...share, sourceKey: source };
    if (share.kind === "conversation" && source) {
      const conversation = this.options.conversation(source);
      if (conversation) {
        const last = lastSharedTurn(conversation);
        const stale = known?.turn
          ? last !== undefined && last !== known.turn
          : conversation.turns.some(
              (turn) =>
                turn.status !== "inProgress" &&
                turn.createdAt > share.snapshotAt,
            );
        if (stale) shown.stale = true;
      }
    }
    return shown;
  }
  /** The cached share of a source (active or taken down), if the list was read. */
  cachedFor(kind: ShareKind, source: string) {
    const key = sourceKeyOf(kind, source);
    return this.listCache?.shares.find(
      (share) =>
        share.kind === kind &&
        share.sourceKey === key &&
        !shareExpired(share, this.now()),
    );
  }
  store(share: HostedShare) {
    const shares = (this.listCache?.shares ?? []).filter(
      (item) => item.id !== share.id,
    );
    this.listCache = {
      at: this.listCache?.at ?? 0,
      shares: [share, ...shares],
    };
  }
  forget(id: string) {
    if (this.listCache)
      this.listCache = {
        ...this.listCache,
        shares: this.listCache.shares.filter((share) => share.id !== id),
      };
  }
  /** The artifact's newest active public link (HostedArtifactLinks). */
  screenshot(identity: string) {
    return this.artifactShares(identity).find(
      (share) => share.status === "active",
    )?.screenshotUrl;
  }
  link(identity: string) {
    const shared = this.artifactShares(identity, true).find(
      (share) =>
        share.status === "active" &&
        !this.sources.get(share.sourceKey)?.version,
    );
    if (shared) return shared.url;
    const active = this.artifactShares(identity)
      .filter((share) => share.status === "active")
      .sort((a, b) => b.createdAt - a.createdAt);
    return active[0]?.url;
  }
  /** Identities of artifacts with an active public link this computer knows. */
  identities() {
    const found = new Set<string>();
    for (const share of this.listCache?.shares ?? []) {
      const known = this.sources.get(share.sourceKey);
      if (
        share.kind === "artifact" &&
        share.status === "active" &&
        known?.kind === "artifact" &&
        !shareExpired(share, this.now())
      )
        found.add(known.source);
    }
    return [...found];
  }
  /** Stops every public link of the artifact at once (a local link made private). */
  stop(identity: string) {
    this.autoArtifacts.delete(identity);
    this.stops.set(
      sharingStopKey(identity),
      (this.stops.get(sharingStopKey(identity)) ?? 0) + 1,
    );
    const shares = [
      ...this.artifactShares(identity),
      ...this.artifactShares(identity, true),
    ];
    if (!shares.length) return;
    this.stops.set(identity, (this.stops.get(identity) ?? 0) + 1);
    // The window shows the artifact private at once.
    for (const share of shares) this.forget(share.id);
    void (async () => {
      for (const share of shares) await this.revoke(share.id, share);
    })().catch((error: unknown) => {
      console.error(
        "Couldn't stop the artifact's public link:",
        error instanceof Error ? error.message : String(error),
      );
      // Read the links again so the window shows what is really shared.
      this.list(undefined, true)
        .then(() => this.options.changed("artifact", identity))
        .catch(() => {});
    });
  }

  // ---- any share

  /** A share of the account by id; the list is read again when it is not cached. */
  async find(id: string) {
    const cached = this.listCache?.shares.find((share) => share.id === id);
    if (cached) return this.present(cached);
    return (await this.list(undefined, true)).find((share) => share.id === id);
  }
  /** Stops a share by id; its link stops working at once. */
  async revoke(id: string, cached?: HostedShare) {
    const share =
      cached ?? this.listCache?.shares.find((item) => item.id === id);
    const key = share?.sourceKey;
    const known = key ? this.sources.get(key) : undefined;
    if (known?.kind === "artifact") {
      const stopKey = known.sharing
        ? sharingStopKey(known.source)
        : known.source;
      this.stops.set(stopKey, (this.stops.get(stopKey) ?? 0) + 1);
      if (known.sharing && !known.version)
        this.autoArtifacts.delete(known.source);
    }
    await this.options.service.revoke(id);
    this.forget(id);
    if (key && known) {
      this.sources.delete(key);
      this.save();
    }
    this.options.changed(share?.kind ?? "artifact", known?.source);
  }
  /** Forgets everything at sign-out; later calls answer nothing. */
  close() {
    this.closed = true;
    this.listCache = undefined;
    this.statusCache = undefined;
  }
}

export interface HostedShares {
  artifactShares: OmitThisParameter<
    typeof hostedSharesArtifacts.artifactShares
  >;
  versionShare: OmitThisParameter<typeof hostedSharesArtifacts.versionShare>;
  publication: OmitThisParameter<typeof hostedSharesArtifacts.publication>;
  publishArtifact: OmitThisParameter<
    typeof hostedSharesArtifacts.publishArtifact
  >;
  artifactShareState: OmitThisParameter<
    typeof hostedSharesArtifacts.artifactShareState
  >;
  shareArtifact: OmitThisParameter<typeof hostedSharesArtifacts.shareArtifact>;
  setArtifactShareAccess: OmitThisParameter<
    typeof hostedSharesArtifacts.setArtifactShareAccess
  >;
  setArtifactAutoShare: OmitThisParameter<
    typeof hostedSharesArtifacts.setArtifactAutoShare
  >;
  syncAutoArtifact: OmitThisParameter<
    typeof hostedSharesArtifacts.syncAutoArtifact
  >;
  unshareArtifact: OmitThisParameter<
    typeof hostedSharesArtifacts.unshareArtifact
  >;
  upload: OmitThisParameter<typeof hostedSharesArtifacts.upload>;
  unpublishArtifact: OmitThisParameter<
    typeof hostedSharesArtifacts.unpublishArtifact
  >;
  markUnpublished: OmitThisParameter<
    typeof hostedSharesArtifacts.markUnpublished
  >;
}
installMethods(HostedShares.prototype, hostedSharesArtifacts);

export interface HostedShares {
  conversationShare: OmitThisParameter<
    typeof hostedSharesConversations.conversationShare
  >;
  shareConversation: OmitThisParameter<
    typeof hostedSharesConversations.shareConversation
  >;
  setShareAccess: OmitThisParameter<
    typeof hostedSharesConversations.setShareAccess
  >;
  inviteToShare: OmitThisParameter<
    typeof hostedSharesConversations.inviteToShare
  >;
  removeShareInvite: OmitThisParameter<
    typeof hostedSharesConversations.removeShareInvite
  >;
  sharedWithMe: OmitThisParameter<
    typeof hostedSharesConversations.sharedWithMe
  >;
  inviteToArtifact: OmitThisParameter<
    typeof hostedSharesConversations.inviteToArtifact
  >;
  removeArtifactInvite: OmitThisParameter<
    typeof hostedSharesConversations.removeArtifactInvite
  >;
  editSharedArtifact: OmitThisParameter<
    typeof hostedSharesConversations.editSharedArtifact
  >;
  readSharedChat: OmitThisParameter<
    typeof hostedSharesConversations.readSharedChat
  >;
  requestArtifactEditAccess: OmitThisParameter<
    typeof hostedSharesConversations.requestArtifactEditAccess
  >;
  respondArtifactEditAccess: OmitThisParameter<
    typeof hostedSharesConversations.respondArtifactEditAccess
  >;
  reportSharedChat: OmitThisParameter<
    typeof hostedSharesConversations.reportSharedChat
  >;
  unshareConversation: OmitThisParameter<
    typeof hostedSharesConversations.unshareConversation
  >;
}
installMethods(HostedShares.prototype, hostedSharesConversations);
