/**
 * The Browser panel's cookie jars (R8), after Settings → Claude Code →
 * Browser → Keep cookies:
 *
 * - "until-quit" (default): one in-memory browser for all of the account's
 *   sessions, gone when Claudex quits;
 * - "always": one saved browser for all of the account's sessions;
 * - "per-session": a saved browser for each Code session, cleared when the
 *   session is deleted.
 *
 * Names carry a hash of the account id, so accounts on this computer never
 * see each other's logins. Every partition refuses permission prompts,
 * device choosers and downloads, blocks the administrator's blocked domains
 * and reports a Chrome user agent without Electron's tokens.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BrowserKeepCookies } from "../../shared/browser";
import { requestBlocked } from "./navigation-guard";

const prefix = "claudex-browser";

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** The partition a conversation's tabs use for a Keep cookies choice. */
export function partitionName(
  mode: BrowserKeepCookies,
  accountId: string,
  conversationId: string,
) {
  const account = hash(`account\0${accountId}`);
  if (mode === "until-quit") return `${prefix}-${account}`;
  if (mode === "always") return `persist:${prefix}-${account}`;
  return `persist:${prefix}-${account}-${hash(`conversation\0${accountId}\0${conversationId}`)}`;
}

/** The part of the saved per-session partitions' folder names that names the account. */
export function perSessionPrefix(accountId: string) {
  return `${prefix}-${hash(`account\0${accountId}`)}-`;
}

// Shared spans workspaces and servers; session spans one conversation;
// ephemeral spans one workspace.
export function previewPartitionName(
  mode: BrowserKeepCookies,
  accountId: string,
  workspace: string,
  _server: string,
  conversationId: string,
) {
  if (mode !== "until-quit")
    return partitionName(mode, accountId, conversationId);
  return `${previewPartitionPrefix(accountId)}${hash(workspace)}`;
}

export function previewPartitionPrefix(accountId: string) {
  return `${prefix}-preview-${hash(`account\0${accountId}`)}-`;
}

/** What BrowserPartitions uses of an Electron session. */
export interface PartitionSession {
  setPermissionRequestHandler(
    handler: (
      contents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void,
  ): void;
  setPermissionCheckHandler(handler: () => boolean): void;
  setDevicePermissionHandler(handler: () => boolean): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  webRequest: {
    onBeforeRequest(
      filter: { urls: string[] },
      listener: (
        details: { url: string },
        callback: (response: { cancel?: boolean }) => void,
      ) => void,
    ): void;
  };
  getUserAgent(): string;
  setUserAgent(userAgent: string): void;
  clearStorageData(): Promise<void>;
  clearCache(): Promise<void>;
  clearAuthCache(): Promise<void>;
}

export interface PartitionDeps<S extends PartitionSession> {
  /** Electron's `session.fromPartition`. */
  fromPartition(name: string): S;
  /** Where Electron keeps saved partitions (`<userData>/Partitions`). */
  partitionsDir?: string;
  /** The administrator's blocked domains now. */
  blockedDomains(): readonly string[];
  /** A page tried to download a file (the download was refused). */
  downloadRefused(contents: unknown, filename: string): void;
}

/** A Chrome user agent: Electron's own adds "Electron/…" and the app's name, which some sites refuse. */
export function chromeUserAgent(userAgent: string) {
  return userAgent
    .replace(/\s+Electron\/\S+/g, "")
    .replace(/\s+claudex\/\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export class BrowserPartitions<S extends PartitionSession = PartitionSession> {
  private configured = new Map<string, S>();
  constructor(private deps: PartitionDeps<S>) {}

  /** The configured session for a partition name. */
  session(name: string): S {
    const known = this.configured.get(name);
    if (known) return known;
    const session = this.deps.fromPartition(name);
    this.configure(session);
    this.configured.set(name, session);
    return session;
  }

  private configure(session: S) {
    session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    session.setPermissionCheckHandler(() => false);
    session.setDevicePermissionHandler(() => false);
    for (const chooser of [
      "select-hid-device",
      "select-serial-port",
      "select-usb-device",
    ])
      session.on(chooser, (event: { preventDefault(): void }, ...rest) => {
        event.preventDefault();
        const callback = rest.find((value) => typeof value === "function");
        callback?.();
      });
    session.on(
      "will-download",
      (
        event: { preventDefault(): void },
        item: { getFilename(): string },
        contents: unknown,
      ) => {
        event.preventDefault();
        this.deps.downloadRefused(contents, item.getFilename());
      },
    );
    session.webRequest.onBeforeRequest(
      { urls: ["<all_urls>"] },
      (details, callback) =>
        callback({
          cancel: requestBlocked(details.url, this.deps.blockedDomains()),
        }),
    );
    session.setUserAgent(chromeUserAgent(session.getUserAgent()));
  }

  /** Removes cookies, site data, cache and HTTP logins from one partition. */
  async clear(name: string) {
    const session = this.session(name);
    await session.clearStorageData();
    await session.clearCache();
    await session.clearAuthCache();
  }

  /**
   * Clear browsing data: the partition the Keep cookies choice uses; for
   * "per-session", every per-session partition of the account (those used
   * this run and those saved on disk).
   */
  async clearFor(
    mode: BrowserKeepCookies,
    accountId: string,
    conversationIds: readonly string[],
  ) {
    if (mode !== "per-session") {
      await this.clear(partitionName(mode, accountId, ""));
      return;
    }
    const names = new Set(
      conversationIds.map((id) => partitionName(mode, accountId, id)),
    );
    for (const name of this.configured.keys())
      if (name.startsWith(`persist:${perSessionPrefix(accountId)}`))
        names.add(name);
    for (const folder of this.savedFolders())
      if (folder.startsWith(perSessionPrefix(accountId)))
        names.add(`persist:${folder}`);
    for (const name of names) await this.clear(name);
  }

  /** A deleted session's own saved browser (Per session). */
  async forgetConversation(accountId: string, conversationId: string) {
    const previewPrefix = `${previewPartitionPrefix(accountId)}session-${hash(conversationId)}-`;
    for (const name of new Set([
      ...[...this.configured.keys()].filter((name) =>
        name.startsWith(`persist:${previewPrefix}`),
      ),
      ...this.savedFolders()
        .filter((folder) => folder.startsWith(previewPrefix))
        .map((folder) => `persist:${folder}`),
    ]))
      await this.clear(name);
    const name = partitionName("per-session", accountId, conversationId);
    const folder = name.slice("persist:".length);
    if (!this.configured.has(name) && !this.savedFolders().includes(folder))
      return;
    await this.clear(name);
  }

  async forgetMissingPreviewConversations(
    accountId: string,
    conversationIds: readonly string[],
  ) {
    const prefix = `${previewPartitionPrefix(accountId)}session-`;
    const kept = conversationIds.map((id) => `${prefix}${hash(id)}-`);
    const sessionPrefix = perSessionPrefix(accountId);
    const sessions = new Set(
      conversationIds.map((id) =>
        partitionName("per-session", accountId, id).slice("persist:".length),
      ),
    );
    for (const folder of this.savedFolders())
      if (
        (folder.startsWith(prefix) &&
          !kept.some((prefix) => folder.startsWith(prefix))) ||
        (folder.startsWith(sessionPrefix) && !sessions.has(folder))
      )
        await this.clear(`persist:${folder}`);
  }

  async clearPreviews(accountId: string, persistentOnly = false) {
    const prefix = previewPartitionPrefix(accountId);
    const sessionPrefix = perSessionPrefix(accountId);
    const shared = partitionName("always", accountId, "");
    const names = new Set(
      [...this.configured.keys()].filter(
        (name) =>
          name.startsWith(`persist:${prefix}`) ||
          name === shared ||
          name.startsWith(`persist:${sessionPrefix}`) ||
          (!persistentOnly && name.startsWith(prefix)),
      ),
    );
    for (const folder of this.savedFolders())
      if (
        folder.startsWith(prefix) ||
        folder.startsWith(sessionPrefix) ||
        `persist:${folder}` === shared
      )
        names.add(`persist:${folder}`);
    for (const name of names) await this.clear(name);
  }

  private savedFolders(): string[] {
    const dir = this.deps.partitionsDir;
    if (!dir) return [];
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  /** `<userData>/Partitions`, where Electron keeps `persist:` partitions. */
  static folder(userData: string) {
    return path.join(userData, "Partitions");
  }
}
