import type { RoutineBrowserGrant } from "../../shared/routine-browser";
/**
 * Which pages Claude may use its Browser tools on (R8 design 6.3).
 *
 * - Local development addresses (localhost, 127.x, [::1], *.localhost) and
 *   blank pages need no approval.
 * - Allowed sites (Settings → Claude Code → Browser → Allowed sites,
 *   `browserAllowedSites`) need none either; "Always allow this site" adds
 *   to that list.
 * - Any other site asks the person once per session (Allow once lasts for
 *   the rest of the conversation, in memory only).
 * - The administrator's blocked domains win over everything, and
 *   `externalSites: false` keeps Claude on local development addresses.
 *
 * The decision is about the page's main frame origin: a page that moved to
 * another origin is judged again before Claude reads or touches it.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostBlocked, isLocalDevHost } from "../../shared/browser";
import type { BrowserPolicy } from "../../shared/client-policy";
import {
  previewOrigin,
  previewOriginUnsafe,
} from "../../shared/preview-origin";
import {
  allowedSiteValid,
  browserAllowedSitesLimit,
} from "../../shared/settings-extras";

/** What a page is, for permissions. */
export type SiteKey =
  | { kind: "blank" }
  | { kind: "web"; origin: string; host: string; local: boolean }
  | { kind: "file"; origin: string }
  | { kind: "other"; scheme: string };

/** The page `url` belongs to: its web origin, its file folder, or nothing. */
export function siteKey(url: string): SiteKey {
  if (!url || /^about:blank$/i.test(url)) return { kind: "blank" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "other", scheme: "" };
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:")
    return {
      kind: "web",
      origin: parsed.origin,
      host: parsed.host,
      local: isLocalDevHost(parsed.host),
    };
  if (parsed.protocol === "file:" && !parsed.host) {
    let folder: string;
    try {
      folder = path.dirname(fileURLToPath(parsed));
    } catch {
      return { kind: "other", scheme: "file" };
    }
    return { kind: "file", origin: `file://${folder.replace(/\\/g, "/")}` };
  }
  return { kind: "other", scheme: parsed.protocol.replace(/:$/, "") };
}

/**
 * An Allowed sites entry in its compared form (`https://example.com`,
 * `http://localhost:*`), or undefined when it is not a valid entry.
 */
export function normalizeAllowedSite(entry: string): string | undefined {
  const text = entry.trim();
  if (!allowedSiteValid(text)) return undefined;
  const anyPort = /:\*$/.test(text);
  try {
    const url = new URL(anyPort ? text.replace(/:\*$/, "") : text);
    const origin = previewOrigin(url.href);
    return origin ? (anyPort ? `${origin}:*` : origin) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether an Allowed sites entry covers a web origin (exact, or any port with `:*`). */
export function allowedSiteMatches(entry: string, origin: string) {
  const normal = normalizeAllowedSite(entry);
  if (!normal) return false;
  const normalizedOrigin = previewOrigin(origin);
  if (!normal.endsWith(":*"))
    return (
      normal === normalizedOrigin ||
      (normalizedOrigin?.startsWith("https://") === true &&
        normal === normalizedOrigin.replace(/^https:/, "http:"))
    );
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return normal === `${url.protocol}//${url.hostname}:*`;
}

export type SiteDecision =
  | {
      access: "allow";
      origin: string;
      /** Why no question is needed. */
      reason: "blank" | "local" | "allowed-site" | "all-sites" | "session";
    }
  | {
      access: "ask";
      origin: string;
      /** "Always allow this site" can be offered (web origins only). */
      canAlwaysAllow: boolean;
    }
  | { access: "deny"; origin: string; message: string };

export interface RoutineBrowserAccess {
  taskId: string;
  active: boolean;
  revision: number;
  grant?: RoutineBrowserGrant;
  allow(origin: string): void;
}
export interface SitePermissionsDeps {
  /** A backend Scheduler binding, consulted live for every action. */
  routine?(conversationId: string): RoutineBrowserAccess | undefined;
  /** Settings → Allowed sites now. */
  allowedSites(): readonly string[];
  /** Saves a new Allowed sites list (Settings). */
  setAllowedSites(sites: string[]): void;
  /** Settings → Browser use → Allow all browser actions. */
  allowAllBrowserActions?(): boolean;
  /** The administrator's Browser policy now. */
  policy(): Pick<BrowserPolicy, "externalSites" | "blockedDomains">;
}

export const siteMessages = Object.freeze({
  blocked: "Your administrator doesn't allow this site.",
  localOnly:
    "Your administrator only allows Claudex to use the browser on local development addresses (localhost).",
  scheme: "Claudex can't use the browser on this kind of page.",
  safety: "This site can’t be added due to safety restrictions.",
});

/** Allowed sites plus the approvals given in each conversation. */
export class SitePermissions {
  /** conversation → origins allowed for the rest of the session. */
  private sessionGrants = new Map<string, Set<string>>();
  private sessionAllowAll = new Map<string, boolean>();
  private routineVersions = new Map<string, string>();
  routine(conversationId: string) {
    return this.deps.routine?.(conversationId);
  }

  constructor(private deps: SitePermissionsDeps) {}

  /** New sessions keep their mode. */
  begin(conversationId: string) {
    if (!this.sessionAllowAll.has(conversationId))
      this.sessionAllowAll.set(
        conversationId,
        this.deps.allowAllBrowserActions?.() === true,
      );
  }

  /** May Claude use the page at `url` in this conversation now? */
  decide(conversationId: string, url: string): SiteDecision {
    this.begin(conversationId);
    const routine = this.routine(conversationId);
    if (routine) {
      if (!routine.active)
        return {
          access: "deny",
          origin: "",
          message: "This scheduled Browser run is no longer active.",
        };
      const version = JSON.stringify([routine.taskId, routine.revision]);
      if (this.routineVersions.get(conversationId) !== version) {
        this.sessionGrants.delete(conversationId);
        this.routineVersions.set(conversationId, version);
      }
    }
    const key = siteKey(url);
    if (key.kind === "blank")
      return { access: "allow", origin: "", reason: "blank" };
    if (key.kind === "other")
      return {
        access: "deny",
        origin: key.scheme ? `${key.scheme}:` : "",
        message: siteMessages.scheme,
      };
    const policy = this.deps.policy();
    if (key.kind === "web") {
      if (previewOriginUnsafe(key.origin))
        return {
          access: "deny",
          origin: key.origin,
          message: siteMessages.safety,
        };
      if (hostBlocked(key.host, policy.blockedDomains ?? []))
        return {
          access: "deny",
          origin: key.origin,
          message: siteMessages.blocked,
        };
      if (key.local)
        return { access: "allow", origin: key.origin, reason: "local" };
      if (policy.externalSites === false)
        return {
          access: "deny",
          origin: key.origin,
          message: siteMessages.localOnly,
        };
      if (routine?.grant?.mode === "all-websites")
        return { access: "allow", origin: key.origin, reason: "all-sites" };
      if (
        routine?.grant?.mode === "domains" &&
        routine.grant.domains.includes(key.origin)
      )
        return { access: "allow", origin: key.origin, reason: "allowed-site" };
      if (!routine && this.sessionAllowAll.get(conversationId))
        return { access: "allow", origin: key.origin, reason: "all-sites" };
      if (
        !routine &&
        this.deps
          .allowedSites()
          .some((entry) => allowedSiteMatches(entry, key.origin))
      )
        return { access: "allow", origin: key.origin, reason: "allowed-site" };
    } else if (policy.externalSites === false) {
      // A file page the person opened is not a local development address.
      return {
        access: "deny",
        origin: key.origin,
        message: siteMessages.localOnly,
      };
    }
    if (this.sessionGrants.get(conversationId)?.has(key.origin))
      return { access: "allow", origin: key.origin, reason: "session" };
    return {
      access: "ask",
      origin: key.origin,
      canAlwaysAllow: key.kind === "web",
    };
  }

  /** Allow once: the origin for the rest of this conversation. */
  grant(conversationId: string, origin: string) {
    if (!origin) return;
    let grants = this.sessionGrants.get(conversationId);
    if (!grants) {
      grants = new Set();
      this.sessionGrants.set(conversationId, grants);
    }
    grants.add(origin);
  }

  /** Always allow during a routine belongs only to that routine. */
  remember(conversationId: string, origin: string): boolean {
    const routine = this.routine(conversationId);
    if (!routine) return this.alwaysAllow(origin);
    if (
      !routine.active ||
      siteKey(origin).kind !== "web" ||
      previewOriginUnsafe(origin)
    )
      return false;
    const decision = this.decide(conversationId, origin);
    if (decision.access === "deny") return false;
    routine.allow(origin);
    // Align the generation before storing any accompanying session approval.
    this.decide(conversationId, origin);
    return true;
  }
  /**
   * Always allow this site: adds a web origin to Allowed sites. False when
   * it can't be added (not a web origin, or the list is full).
   */
  alwaysAllow(origin: string): boolean {
    const entry = normalizeAllowedSite(origin);
    if (!entry || entry.endsWith(":*")) return false;
    if (previewOriginUnsafe(entry)) return false;
    const current = [...this.deps.allowedSites()];
    if (current.some((site) => allowedSiteMatches(site, entry))) return true;
    if (current.length >= browserAllowedSitesLimit) return false;
    this.deps.setAllowedSites([...current, entry]);
    return true;
  }

  /** A conversation ended or was deleted: its approvals go. */
  forget(conversationId: string) {
    this.sessionGrants.delete(conversationId);
    this.sessionAllowAll.delete(conversationId);
    this.routineVersions.delete(conversationId);
  }

  forgetAll() {
    this.sessionGrants.clear();
    this.sessionAllowAll.clear();
    this.routineVersions.clear();
  }
}
