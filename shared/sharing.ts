/**
 * Hosted sharing (R1): the Claudex service's wire format for shares and
 * snapshots (design R1 3.2–3.4), and how the desktop reads it. Answers are
 * read field by field; anything unexpected reads as "none" rather than
 * breaking a page, and a link is only ever an absolute http(s) address.
 */
import type {
  ArtifactEmbed,
  HostedShare,
  ShareAccess,
  SharedChat,
  SharedChatContent,
  ShareInviteResult,
  ShareKind,
  SharingStatus,
} from "./sharing-api";

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.slice(0, max) : "";
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
const time = (value: unknown) => {
  const at =
    typeof value === "string"
      ? Date.parse(value)
      : typeof value === "number"
        ? value
        : NaN;
  return Number.isFinite(at) && at > 0 ? at : undefined;
};

/** What the service takes by default (design 3.3), when an answer leaves a size out. */
export const defaultSnapshotBytes = 8 * 1024 * 1024;
export const defaultArtifactBytes = 2 * 1024 * 1024;
/** Hard limits of a snapshot (design 3.2); the service refuses anything larger. */
export const snapshotLimits = {
  title: 200,
  messages: 500,
  artifacts: 20,
  userText: 100_000,
  assistantText: 200_000,
  activity: 8,
  activityText: 80,
} as const;

/** The service's error codes for sharing (design 1 errors.go). */
export const sharingErrorCodes = {
  disabled: "CLAUDEX_SHARING_DISABLED",
  kindDisabled: "CLAUDEX_SHARING_KIND_DISABLED",
  blocked: "CLAUDEX_SHARING_USER_BLOCKED",
  tooLarge: "CLAUDEX_SHARE_TOO_LARGE",
  quota: "CLAUDEX_SHARE_QUOTA",
  notFound: "CLAUDEX_SHARE_NOT_FOUND",
} as const;

/**
 * The categories of the live claude.ai report form that the form itself takes,
 * as the service stores them. Copyright, trademark, private information and
 * court orders point to a separate form instead.
 */
export const reportFormCategories = [
  "child_safety",
  "fraud",
  "sexually_explicit_content",
  "non_consensual_intimate_imagery",
  "violence_and_hate",
  "illegal_goods",
  "defamation",
  "other_illegal",
  "violation_of_terms",
] as const;

/**
 * The longest artifact text Report artifact sends, in characters; the
 * service keeps up to 512 KiB of it.
 */
export const artifactReportContentChars = 512 * 1024;

/**
 * What the service's status says about Report artifact: "open" or "off" from
 * its `artifact_reports`, "none" from a service that predates it.
 */
export function parseArtifactReportsState(
  value: unknown,
): "open" | "off" | "none" {
  const data = object(value);
  if (typeof data.artifact_reports !== "boolean") return "none";
  return data.artifact_reports ? "open" : "off";
}

/** One artifact of a snapshot (wire, schema 1). */
export interface SnapshotArtifact {
  title: string;
  language: "html" | "svg" | "markdown" | "mermaid" | "code";
  /** Only for language "code": the file's language as the app names it. */
  code_language?: string;
  content: string;
}
/** One message of a conversation snapshot: a prompt or a reply's text. */
export interface SnapshotMessage {
  role: "user" | "assistant";
  /** Markdown. */
  text: string;
  /** One-line summaries of what the reply did ("Ran 2 commands"); never commands or output. */
  activity?: string[];
  /** Indexes into `artifacts`. */
  artifacts?: number[];
}
/** The body of a share (schema 1, design 3.2). */
export interface ShareSnapshot {
  repositories?: string[];
  screenshot?: string;
  sessionAuthors?: SharedChatContent["sessionAuthors"];
  kind: ShareKind;
  title: string;
  mode?: "chat" | "cowork" | "code";
  model_label?: string;
  messages?: SnapshotMessage[];
  artifacts?: SnapshotArtifact[];
}

/** `POST /claudex/shares` */
export interface CreateShareBody {
  kind: ShareKind;
  /** sha256 of the conversation id or artifact identity; the service never sees the raw one. */
  source_key: string;
  title: string;
  snapshot: ShareSnapshot;
  /** A new conversation share limited to the people invited to it. */
  access?: ShareAccess;
}

/** The languages a snapshot keeps as themselves; everything else is code. */
export function snapshotLanguage(language: string): {
  language: SnapshotArtifact["language"];
  code_language?: string;
} {
  const value = language.trim().toLowerCase();
  if (["html", "htm"].includes(value)) return { language: "html" };
  if (value === "svg") return { language: "svg" };
  if (["markdown", "md"].includes(value)) return { language: "markdown" };
  if (["mermaid", "mmd"].includes(value)) return { language: "mermaid" };
  const code = value.replace(/[^a-z0-9+#._-]/g, "").slice(0, 30);
  return { language: "code", ...(code ? { code_language: code } : {}) };
}

/**
 * `GET /claudex/sharing/status` → what the desktop may offer; null when the
 * administrator has not turned sharing on. A blocked account keeps its
 * status (its links can still be listed and revoked) but may not share.
 */
export function parseSharingStatus(value: unknown): SharingStatus | null {
  const data = object(value);
  if (data.enabled !== true) return null;
  const blocked = data.blocked === true;
  const policy = text(data.usage_policy_url, 2000);
  const positive = (raw: unknown, fallback: number) => {
    const bytes = count(raw);
    return bytes && bytes > 0 ? bytes : fallback;
  };
  return {
    conversations: !blocked && data.conversations === true,
    artifacts: !blocked && data.artifacts === true,
    ...(httpsUrl(policy) ? { usagePolicyUrl: httpsUrl(policy) } : {}),
    maxSnapshotBytes: positive(data.max_snapshot_bytes, defaultSnapshotBytes),
    maxArtifactBytes: positive(data.max_artifact_bytes, defaultArtifactBytes),
    ...(!blocked && data.artifact_embeds === true ? { embeds: true } : {}),
    ...(blocked ? { blocked: true } : {}),
  };
}

/**
 * One allowed embed domain as the live dialog checks it: host labels of
 * letters, digits and inner hyphens, a top-level label of 2-26 characters,
 * optionally "*." first. The service checks the same.
 */
export const embedDomainPattern =
  /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,24}[a-z0-9]$/;

/** The longest list of allowed domains the service keeps. */
export const maxEmbedDomains = 50;

/**
 * The domains typed in Allowed domains: split at commas, trimmed, lower
 * case, empty entries dropped (as the live dialog reads the field).
 */
export function embedDomainsOf(value: string): string[] {
  return value
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter((domain) => domain.length > 0);
}

/** The domains of a list the check refuses. */
export function invalidEmbedDomains(domains: string[]): string[] {
  return domains.filter(
    (domain) => domain.length > 253 || !embedDomainPattern.test(domain),
  );
}

/**
 * The embed code of a published artifact: an iframe 100% wide and 600 high, its
 * title the artifact's (& and " escaped), "Claudex Artifact" when it has none.
 */
export function embedCode(url: string, title: string): string {
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<iframe src="${escape(url)}" title="${escape(title || "Claudex Artifact")}" width="100%" height="600" frameborder="0" allow="clipboard-write" allowfullscreen></iframe>`;
}

/** The service's embed answer (`EmbedDTO`); undefined when unusable. */
export function parseArtifactEmbed(
  value: unknown,
  serviceBaseUrl: string,
): ArtifactEmbed | undefined {
  const data = object(value);
  const url = shareUrl(data, serviceBaseUrl);
  if (!url || !/\/s\/[A-Za-z0-9_-]{20,64}\/embed$/.test(new URL(url).pathname))
    return undefined;
  const domains = Array.isArray(data.domains)
    ? data.domains
        .filter((domain): domain is string => typeof domain === "string")
        .slice(0, maxEmbedDomains)
    : [];
  return { url, domains };
}

/** An https address as written, or undefined. */
export function httpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The public page of a share: the service's absolute `url` when it sent
 * one (the administrator's public base URL), otherwise its `path` on the
 * service this app is signed in to. Undefined when neither is usable.
 */
export function shareUrl(
  data: { url?: unknown; path?: unknown },
  serviceBaseUrl: string,
): string | undefined {
  const absolute = text(data.url, 4000);
  if (absolute)
    try {
      const url = new URL(absolute);
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password
      )
        return url.href;
    } catch {
      // Fall back to the path.
    }
  const path = text(data.path, 1000);
  if (!/^\/(?!\/)[A-Za-z0-9._~\-/]{1,999}$/.test(path)) return undefined;
  try {
    const base = new URL(serviceBaseUrl);
    if (base.protocol !== "https:" && base.protocol !== "http:")
      return undefined;
    // A service mounted under a prefix keeps it: `<base>/s/<token>`.
    return new URL(base.pathname.replace(/\/+$/, "") + path, base.origin).href;
  } catch {
    return undefined;
  }
}

/** The service's share (`HostedShareDTO`) as the app shows it; undefined when unusable. */
export function parseHostedShare(
  value: unknown,
  serviceBaseUrl: string,
): HostedShare | undefined {
  const data = object(value);
  const rawId = data.id;
  const id =
    typeof rawId === "number" && Number.isSafeInteger(rawId) && rawId > 0
      ? String(rawId)
      : typeof rawId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(rawId)
        ? rawId
        : "";
  const kind = data.kind;
  const status = data.status;
  if (!id || (kind !== "conversation" && kind !== "artifact")) return undefined;
  // A revoked share is gone; anything else unknown is not shown either.
  if (status !== "active" && status !== "disabled") return undefined;
  const url = shareUrl(data, serviceBaseUrl);
  if (!url) return undefined;
  const createdAt = time(data.created_at) ?? 0;
  const expiresAt = time(data.expires_at);
  const views = count(data.view_count);
  const reason = text(data.disabled_reason, 500).trim();
  const invites = Array.isArray(data.invites)
    ? data.invites
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.slice(0, 254))
        .slice(0, 100)
    : [];
  const token = /\/s\/([A-Za-z0-9_-]{20,64})$/.exec(new URL(url).pathname)?.[1];
  return {
    ...(data.invited_only === true ? { access: "invited" as const } : {}),
    ...(typeof data.screenshot_url === "string" &&
    data.screenshot_url === `${url}/screenshot`
      ? { screenshotUrl: data.screenshot_url }
      : {}),
    ...(invites.length || data.invited_only === true ? { invites } : {}),
    ...(data.invite_roles
      ? {
          inviteRoles: Object.fromEntries(
            Object.entries(object(data.invite_roles)).filter(
              (entry): entry is [string, "view" | "comment" | "edit"] =>
                invites.includes(entry[0]) &&
                ["view", "comment", "edit"].includes(String(entry[1])),
            ),
          ),
        }
      : {}),
    ...(token
      ? {
          inviteUrl: new URL(
            `${new URL(url).pathname.replace(/\/s\/[^/]*$/, "")}${sharedPath}/${token}`,
            new URL(url).origin,
          ).href,
        }
      : {}),
    id,
    kind,
    sourceKey: text(data.source_key, 128),
    title: text(data.title, snapshotLimits.title),
    url,
    createdAt,
    snapshotAt: time(data.snapshot_at) ?? createdAt,
    ...(expiresAt ? { expiresAt } : {}),
    status,
    ...(views !== undefined ? { views } : {}),
    ...(status === "disabled" && reason ? { disabledReason: reason } : {}),
  };
}

/** `GET /claudex/shares`: a list, or a Sub2API page `{items, page, pages}`. */
export function parseSharePage(
  value: unknown,
  serviceBaseUrl: string,
): { items: HostedShare[]; page: number; pages: number } {
  const data = object(value);
  const raw = Array.isArray(value)
    ? value
    : Array.isArray(data.items)
      ? data.items
      : [];
  const page = Math.max(1, count(data.page) ?? 1);
  return {
    items: raw.flatMap((item) => parseHostedShare(item, serviceBaseUrl) ?? []),
    page,
    pages: Array.isArray(value) ? page : Math.max(page, count(data.pages) ?? 1),
  };
}

/** Where the web app shows a share to an invited person. */
export const sharedPath = "/shared";

/** The reply of `POST .../invites`. */
export function parseInviteResult(
  value: unknown,
  serviceBaseUrl: string,
): ShareInviteResult | undefined {
  const data = object(value);
  const share = parseHostedShare(data.share, serviceBaseUrl);
  if (!share) return undefined;
  return { share, added: data.added === true, mailed: data.mailed === true };
}

/** `GET /claudex/sharing/shared-with-me` */
export function parseSharedChats(value: unknown): SharedChat[] {
  const list = Array.isArray(value) ? value : [];
  return list.flatMap((raw) => {
    const item = object(raw);
    const token = text(item.token, 64);
    if (
      !/^[A-Za-z0-9_-]{20,64}$/.test(token) ||
      (item.kind !== "conversation" && item.kind !== "artifact")
    )
      return [];
    return [
      {
        token,
        ...(item.kind === "artifact" ? { kind: "artifact" as const } : {}),
        title: text(item.title, snapshotLimits.title),
        owner: text(item.owner, 254),
        snapshotAt: time(item.snapshot_at) ?? 0,
      },
    ];
  });
}

/** `GET /claudex/sharing/shared-with-me/:token` */
export function parseSharedChat(value: unknown): SharedChatContent | undefined {
  const data = object(value);
  const [head] = parseSharedChats([{ ...data, kind: data.kind }]);
  const snapshot = object(data.snapshot);
  const authors = object(snapshot.sessionAuthors);
  const validAuthors = [
    authors.viewerAccountUuid,
    authors.ownerAccountUuid,
  ].every(
    (id) => typeof id === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(id),
  );
  if (!head || (!Array.isArray(snapshot.messages) && head.kind !== "artifact"))
    return undefined;
  const messages = (
    Array.isArray(snapshot.messages) ? snapshot.messages : []
  ).flatMap((raw: unknown) => {
    const message = object(raw);
    const role: "user" | "assistant" =
      message.role === "assistant" ? "assistant" : "user";
    const body = text(
      message.text,
      role === "assistant"
        ? snapshotLimits.assistantText
        : snapshotLimits.userText,
    );
    const activity = Array.isArray(message.activity)
      ? message.activity
          .filter((item: unknown): item is string => typeof item === "string")
          .map((item: string) => item.slice(0, snapshotLimits.activityText))
          .slice(0, snapshotLimits.activity)
      : [];
    return body || activity.length
      ? [{ role, text: body, ...(activity.length ? { activity } : {}) }]
      : [];
  });
  return {
    ...head,
    ...(typeof data.can_edit === "boolean" ? { canEdit: data.can_edit } : {}),
    ...(typeof data.can_comment === "boolean"
      ? { canComment: data.can_comment }
      : {}),
    ...(typeof data.can_request_edit === "boolean"
      ? { canRequestEdit: data.can_request_edit }
      : {}),
    ...(typeof data.edit_request_pending === "boolean"
      ? { editRequestPending: data.edit_request_pending }
      : {}),
    ...(Array.isArray(data.edit_requests)
      ? {
          editRequests: data.edit_requests.flatMap((value: unknown) => {
            const request = object(value);
            const updatedAt =
              typeof request.updated_at === "string"
                ? Date.parse(request.updated_at)
                : NaN;
            return request.status === "pending" &&
              typeof request.email === "string" &&
              Number.isFinite(updatedAt)
              ? [
                  {
                    email: text(request.email, 254),
                    status: "pending" as const,
                    updatedAt,
                  },
                ]
              : [];
          }),
        }
      : {}),
    ...(validAuthors
      ? {
          sessionAuthors: {
            viewerAccountUuid: authors.viewerAccountUuid as string,
            ownerAccountUuid: authors.ownerAccountUuid as string,
          },
        }
      : {}),
    ...(head.kind === "artifact" && Array.isArray(snapshot.artifacts)
      ? {
          artifacts: snapshot.artifacts.slice(0, 20).map((raw: unknown) => {
            const artifact = object(raw);
            return {
              title: text(artifact.title, 200),
              language: text(artifact.language, 32),
              content: text(artifact.content, 2_000_000),
            };
          }),
        }
      : {}),
    messages: [
      ...messages,
      ...(head.kind === "artifact" && Array.isArray(snapshot.comments)
        ? snapshot.comments.slice(0, 500).map((raw: unknown) => {
            const comment = object(raw);
            return {
              role: "user" as const,
              text: `${text(comment.author, 254)}: ${text(comment.text, 4000)}`,
            };
          })
        : []),
    ].slice(0, snapshotLimits.messages),
    ...(data.reportable === true ? { reportable: true } : {}),
  };
}

/** A share has expired (the service stops serving it at `expiresAt`). */
export function shareExpired(share: HostedShare, now = Date.now()) {
  return share.expiresAt !== undefined && share.expiresAt <= now;
}
