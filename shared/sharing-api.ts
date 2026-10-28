/**
 * Hosted sharing (R1): conversation snapshots, public artifact links, Open in
 * web and Publish, served by the operator's Claudex service at `/s/<token>`.
 *
 * The interface and method list were frozen by S0; R1-C implemented them in
 * `electron/ipc/sharing.ts`. The service's wire format and its parsing live
 * in `shared/sharing.ts`. On a local account, a service without sharing or
 * with sharing turned off, `sharingStatus()` is null and no Share entry shows.
 */
import { bridgeMethods } from "./bridge-methods";
import type { ArtifactShareInput, Conversation } from "./types";

export type ShareKind = "conversation" | "artifact";
export type ArtifactEditAccessResult =
  "filed" | "already_granted" | "cooldown" | "unavailable" | "failed";

/**
 * Who a conversation share reaches: "link", anyone with the link, or
 * "invited", only the people invited by e-mail (no public page).
 */
export type ShareAccess = "link" | "invited";

/**
 * The e-mails about artifacts the account wants (Settings → General →
 * Notifications): Mentions and replies, Comments on your artifacts (it
 * follows Mentions and replies until it is set) and Artifacts shared with
 * you. The service keeps them; all are on until turned off.
 */
export interface ArtifactMailPreferences {
  mentions: boolean;
  comments: boolean;
  shares: boolean;
}

/** What the service allows; null from `sharingStatus()` means no hosted sharing. */
export interface SharingStatus {
  /** Conversations can be shared (Share chat / Share session). */
  conversations: boolean;
  /** Artifacts can get a public link (Anyone with the link, Publish). */
  artifacts: boolean;
  /** The administrator's usage policy page (https only). */
  usagePolicyUrl?: string;
  /** Largest conversation snapshot the service takes, in bytes. */
  maxSnapshotBytes: number;
  /** Largest artifact body the service takes, in bytes. */
  maxArtifactBytes: number;
  /**
   * Published artifacts can be embedded on other sites (Get embed code);
   * absent on a service without it.
   */
  embeds?: boolean;
  /**
   * The administrator turned sharing off for this account: nothing new can
   * be shared (both flags above are false), existing links can still be
   * listed and stopped.
   */
  blocked?: boolean;
}

/** One hosted share of the signed-in account. */
export interface HostedShare {
  id: string;
  kind: ShareKind;
  /**
   * The conversation id or the artifact identity the share was made from;
   * empty when this computer does not know it (a share made on another
   * device: the service only keeps a hash of it).
   */
  sourceKey: string;
  title: string;
  /** Absolute http(s) address of the public page. */
  url: string;
  createdAt: number;
  snapshotAt: number;
  expiresAt?: number;
  /** "disabled": taken down by an administrator. */
  status: "active" | "disabled";
  /** Why the administrator took it down, when it said. */
  disabledReason?: string;
  /** The conversation has newer turns than the snapshot (computed by the client). */
  stale?: boolean;
  views?: number;
  /** "invited" shares require an invitation. Absent: link. */
  access?: ShareAccess;
  /** The people invited, lower-case addresses. */
  invites?: string[];
  screenshotUrl?: string;
  inviteRoles?: Record<string, "view" | "comment" | "edit">;
  /**
   * Where an invited person reads the share: the web app's `/shared/<token>`
   * on the same service. Conversations only.
   */
  inviteUrl?: string;
}

/** A chat someone shared with the signed-in account. */
export interface SharedChat {
  kind?: ShareKind;
  token: string;
  title: string;
  /** The sharer's address. */
  owner: string;
  snapshotAt: number;
}

/** A shared chat as its reader sees it: the snapshot's prompts and replies. */
export interface SharedChatContent extends SharedChat {
  canEdit?: boolean;
  canComment?: boolean;
  canRequestEdit?: boolean;
  editRequestPending?: boolean;
  editRequests?: { email: string; status: "pending"; updatedAt: number }[];
  sessionAuthors?: Conversation["sessionAuthors"];
  artifacts?: { title: string; language: string; content: string }[];
  messages: {
    role: "user" | "assistant";
    /** Markdown. */
    text: string;
    activity?: string[];
  }[];
  /** The administrator takes reports, so the reader can Report it. */
  reportable?: boolean;
}

/**
 * Report chat's answer. The category is one the form takes
 * (`reportFormCategories`); the administrator must not use a report that opts
 * out to train models.
 */
export interface SharedChatReport {
  category: string;
  notes?: string;
  reporterName?: string;
  reporterEmail?: string;
  /** "Opt out of training on this report"; off unless switched on. */
  optOutOfTraining: boolean;
}

/**
 * What the service has of one version of an artifact. Each version published
 * gets its own public link; Unpublish removes every version's link.
 */
export interface ArtifactPublication {
  /** This version's public link (active, or taken down by the administrator). */
  share: HostedShare | null;
  /** How many versions of the artifact have an active public link. */
  liveLinks: number;
  /**
   * This version's link was unpublished: it can't be published again (a
   * changed artifact is a new version and can).
   */
  unpublished: boolean;
}

/**
 * Get embed code: the iframe address of a published artifact and the domains
 * allowed to embed it. An empty list lets any site embed it.
 */
export interface ArtifactEmbed {
  /** The iframe's src: an absolute http(s) address. */
  url: string;
  /** Lower-case host names, each optionally starting with "*.". */
  domains: string[];
}

/**
 * Report artifact: the report form without the training opt-out, and a copy of
 * the artifact, since the artifact itself is not on the service.
 */
export interface ArtifactReport {
  /** One of `reportFormCategories`. */
  category: string;
  notes?: string;
  reporterName?: string;
  reporterEmail?: string;
  /** The artifact's identity in the app (the service keeps only a hash). */
  identity: string;
  title: string;
  language: string;
  /** The artifact's text, or its start (`artifactReportContentChars`). */
  content: string;
  /** The whole text's UTF-8 size, when only its start is sent. */
  contentBytes?: number;
}

/**
 * Whether Report artifact can be sent: "open", the account's service takes
 * reports; "off", its administrator turned reports off; "none", a local
 * account or a service that cannot take them.
 */
export type ArtifactReportsState = "open" | "off" | "none";

/** What inviting someone did. */
export interface ShareInviteResult {
  share: HostedShare;
  /** The address was new (an address invited again is not told again). */
  added: boolean;
  /** The service can send mail, so the person is told by e-mail. */
  mailed: boolean;
}

export interface ShareInviteOptions {
  role?: "view" | "comment" | "edit";
  notify?: boolean;
  message?: string;
}

export interface SharingAPI {
  importSharedArtifact(token: string): Promise<{
    artifact: import("./types").SavedArtifact;
    library: import("./types").ArtifactLibraryState;
  }>;
  refreshImportedArtifact(libraryId: string): Promise<{
    artifact: import("./types").SavedArtifact;
    library: import("./types").ArtifactLibraryState;
  }>;
  artifactShareState(input: ArtifactShareInput): Promise<ArtifactSharingState>;
  shareArtifact(
    input: ArtifactShareInput,
    autoUpdate: boolean,
    access?: ShareAccess,
  ): Promise<ArtifactSharingState>;
  setArtifactShareAccess(
    input: ArtifactShareInput,
    access: ShareAccess,
  ): Promise<ArtifactSharingState>;
  setArtifactAutoShare(
    input: ArtifactShareInput,
    enabled: boolean,
  ): Promise<ArtifactSharingState>;
  unshareArtifact(identity: string): Promise<void>;
  /** null: no hosted sharing (local account, service without it, or turned off). */
  sharingStatus(): Promise<SharingStatus | null>;
  conversationShare(conversationId: string): Promise<HostedShare | null>;
  /**
   * Creates the share, or uploads a fresh snapshot to the existing one.
   * `access` applies to a new share: "invited" makes one without a public page.
   */
  shareConversation(
    conversationId: string,
    access?: ShareAccess,
  ): Promise<HostedShare>;
  /**
   * Switches the conversation's share between the public link and invited
   * people only; null when it has no share yet.
   */
  setShareAccess(
    conversationId: string,
    access: ShareAccess,
  ): Promise<HostedShare | null>;
  /** Invites an address (making an invited-only share first when there is none). */
  inviteToShare(
    conversationId: string,
    email: string,
  ): Promise<ShareInviteResult>;
  /** Takes an address off the share; the last one leaving an invited-only share stops it. */
  removeShareInvite(
    conversationId: string,
    email: string,
  ): Promise<HostedShare | null>;
  /** Chats shared with the signed-in account, newest first. */
  sharedWithMe(): Promise<SharedChat[]>;
  /** One chat shared with the account (or its own share), by token. */
  readSharedChat(token: string): Promise<SharedChatContent>;
  requestArtifactEditAccess(token: string): Promise<ArtifactEditAccessResult>;
  respondArtifactEditAccess(
    token: string,
    email: string,
    allow: boolean,
  ): Promise<void>;
  inviteToArtifact(
    shareId: string,
    email: string,
    options?: ShareInviteOptions,
  ): Promise<ShareInviteResult>;
  removeArtifactInvite(shareId: string, email: string): Promise<HostedShare>;
  editSharedArtifact(
    token: string,
    patch: { content?: string; comment?: string },
  ): Promise<void>;
  /** Reports a chat shared with the account to the administrator. */
  reportSharedChat(token: string, report: SharedChatReport): Promise<void>;
  /** Whether Report artifact can be sent now. */
  artifactReportsState(): Promise<ArtifactReportsState>;
  /** Sends Report artifact to the administrator of the account's service. */
  reportArtifact(report: ArtifactReport): Promise<void>;
  unshareConversation(conversationId: string): Promise<void>;
  /**
   * Publishes this version of the artifact (its content as given) at a
   * public link of its own; a version already published answers its link.
   */
  publishArtifact(input: ArtifactShareInput): Promise<HostedShare>;
  /** The version's publication; null without hosted sharing. */
  artifactPublication(
    input: ArtifactShareInput,
  ): Promise<ArtifactPublication | null>;
  /** Unpublish: removes the public link of every version of the artifact. */
  unpublishArtifact(identity: string): Promise<void>;
  /** Get embed code: a published artifact's embed address and allowed domains. */
  artifactEmbed(shareId: string): Promise<ArtifactEmbed>;
  /** Replaces the domains allowed to embed a published artifact. */
  setArtifactEmbedDomains(
    shareId: string,
    domains: string[],
  ): Promise<ArtifactEmbed>;
  /** null: the account has no hosted sharing to be told about. */
  artifactMailPreferences(): Promise<ArtifactMailPreferences | null>;
  setArtifactMailPreferences(
    patch: Partial<ArtifactMailPreferences>,
  ): Promise<ArtifactMailPreferences>;
  hostedShares(kind?: ShareKind): Promise<HostedShare[]>;
  revokeShare(shareId: string): Promise<void>;
  /** Opens the public page in the system browser (Open in web). */
  openShare(shareId: string): Promise<void>;
}

export const sharingMethods = bridgeMethods<SharingAPI>({
  importSharedArtifact: true,
  refreshImportedArtifact: true,
  artifactShareState: true,
  shareArtifact: true,
  setArtifactShareAccess: true,
  setArtifactAutoShare: true,
  unshareArtifact: true,
  sharingStatus: true,
  conversationShare: true,
  shareConversation: true,
  setShareAccess: true,
  inviteToShare: true,
  inviteToArtifact: true,
  removeArtifactInvite: true,
  editSharedArtifact: true,
  requestArtifactEditAccess: true,
  respondArtifactEditAccess: true,
  removeShareInvite: true,
  sharedWithMe: true,
  readSharedChat: true,
  reportSharedChat: true,
  artifactReportsState: true,
  reportArtifact: true,
  unshareConversation: true,
  publishArtifact: true,
  artifactPublication: true,
  unpublishArtifact: true,
  artifactEmbed: true,
  setArtifactEmbedDomains: true,
  artifactMailPreferences: true,
  setArtifactMailPreferences: true,
  hostedShares: true,
  revokeShare: true,
  openShare: true,
});

export interface ArtifactSharingState {
  share: HostedShare | null;
  versions: { version: string; share: HostedShare }[];
  currentVersion: string;
  autoUpdate: boolean;
}

/** Sent after the account's hosted shares changed (made, refreshed, revoked). */
export interface SharingEvent {
  type: "sharing";
  kind?: ShareKind;
  /** The conversation id or artifact identity whose share changed. */
  sourceKey?: string;
}
