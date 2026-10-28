import fs from "node:fs";
import path from "node:path";
import {
  offlinePolicy,
  openPolicy,
  pendingPolicy,
  type Announcement,
  type ClientPolicy,
  type ClientUpdate,
} from "../../shared/client-policy";
import { parsePolicy, type ClaudexPolicy } from "../../shared/claudex-contract";
import type {
  PolicyWithReleaseNotes,
  ServiceReleaseNotes,
} from "../../shared/client-release";
import type { Settings } from "../../shared/types";
import type { PolicyCache } from "./policy-cache";
import type { JsonResult } from "../sub2api/http";
import {
  currentClientPolicy,
  fileAnnouncements,
  isPolicyUrl,
  loadOperatorPolicy,
  policyFileName,
  type PolicyContext,
} from "../../server/operator-policy";
import type { PublicSettings, RemoteAnnouncement } from "../sub2api/client";

type ServiceSettings = Pick<
  PublicSettings,
  "docUrl" | "purchaseUrl" | "menuItems"
>;

/** Custom menu labels that fill the account menu's entries. */
const menuEntries = {
  help: "get help",
  plans: "view all plans",
  apps: "get apps and extensions",
} as const;

/**
 * The account menu links Sub2API carries itself: custom menu items named
 * after the entries, the documentation page for Get help and the purchase
 * page for View all plans. Other https items become Learn more links.
 */
export function serviceLinks(settings: ServiceSettings): ClientPolicy["links"] {
  const items = settings.menuItems.filter((item) => isPolicyUrl(item.url));
  const named = (label: string) =>
    items.find((item) => item.label.toLowerCase() === label)?.url;
  const reserved = new Set<string>(Object.values(menuEntries));
  return {
    help:
      named(menuEntries.help) ??
      (isPolicyUrl(settings.docUrl) ? settings.docUrl : undefined),
    plans:
      named(menuEntries.plans) ??
      (isPolicyUrl(settings.purchaseUrl) ? settings.purchaseUrl : undefined),
    apps: named(menuEntries.apps),
    learnMore: items
      .filter((item) => !reserved.has(item.label.toLowerCase()))
      .slice(0, 10),
  };
}

/** Sub2API notices as the renderer shows them; popup mode stays until read. */
export function fromRemoteAnnouncements(
  items: RemoteAnnouncement[],
  now: number,
): Announcement[] {
  return items
    .filter(
      (item) =>
        (item.startsAt === null || item.startsAt <= now) &&
        (item.endsAt === null || item.endsAt > now),
    )
    .map((item) => ({
      id: String(item.id),
      title: item.title,
      content: item.content,
      popup: item.notifyMode === "popup",
      createdAt: item.createdAt,
      read: item.readAt !== null,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Which of the policy file's notices a local account has read, kept in its profile. */
export class LocalAnnouncementReads {
  private file: string;
  constructor(profileRoot: string) {
    this.file = path.join(profileRoot, "announcements-read.json");
  }
  read(): Set<string> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return new Set(
        Array.isArray(parsed?.ids)
          ? parsed.ids.filter((id: unknown) => typeof id === "string")
          : [],
      );
    } catch {
      return new Set();
    }
  }
  mark(id: string) {
    const ids = this.read();
    ids.add(id);
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(
      temporary,
      JSON.stringify({ version: 1, ids: [...ids].slice(-500) }),
      { mode: 0o600 },
    );
    fs.renameSync(temporary, this.file);
  }
}

/** The policy file's notices for a local account, newest first by file order. */
export function localAnnouncements(
  root: string,
  reads: LocalAnnouncementReads,
  now: number,
): Announcement[] {
  let file;
  try {
    file = loadOperatorPolicy(root);
  } catch {
    return [];
  }
  const read = reads.read();
  const items = fileAnnouncements(file, now);
  return items.map((item, index) => ({
    id: item.id,
    title: item.title,
    content: item.content,
    popup: item.popup === true,
    createdAt: item.startsAt ? Date.parse(item.startsAt) : items.length - index,
    read: read.has(item.id),
  }));
}

/** Where the signed-in account's policy comes from. */
export interface PolicySource {
  /** The policy now; never waits for the network or the disk twice. */
  current(): ClientPolicy;
  /** Reads the policy again in the background; never rejects. */
  refresh(): Promise<void>;
  /** How often the host asks again while the account is open. */
  readonly refreshIntervalMs?: number;
}

function fileStamp(file: string) {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "unreadable";
  }
}

/**
 * A local account's policy from `backend/policy.json` (development and
 * offline use on the operator's own computer). The file is parsed again only
 * after it changed.
 */
export class LocalPolicySource implements PolicySource {
  private cached?: { stamp: string; policy: ClientPolicy };
  constructor(
    private root: string,
    private context: PolicyContext,
    private onChange: (policy: ClientPolicy) => void = () => {},
  ) {}
  current(): ClientPolicy {
    const stamp = fileStamp(policyFileName(this.root));
    if (this.cached?.stamp !== stamp)
      this.cached = {
        stamp,
        policy: currentClientPolicy(this.root, this.context),
      };
    return this.cached.policy;
  }
  async refresh() {
    const before = this.cached?.policy;
    const after = this.current();
    if (before && JSON.stringify(before) !== JSON.stringify(after))
      this.onChange(after);
  }
}

/** What Sub2API's public settings give a Sub2API account today: links only. */
export function remotePolicy(settings: ServiceSettings): ClientPolicy {
  return { ...openPolicy, links: serviceLinks(settings) };
}

/**
 * An older Sub2API without the Claudex module (its `GET /claudex/release`
 * answers 404): it has no policy, so this reads only what it carries, the
 * public settings' documentation, purchase and custom menu links; every
 * switch is open once the service has answered. Until the first answer
 * (first start, or offline) the pending policy holds back high-risk changes.
 * A Claudex service's policy comes from `ServerPolicySource`.
 */
export class RemotePolicySource implements PolicySource {
  serviceUrls: string[] = [];
  private policy: ClientPolicy = pendingPolicy;
  private loading?: Promise<void>;
  private loadedAt = 0;
  constructor(
    private load: () => Promise<ServiceSettings>,
    private onChange: (policy: ClientPolicy) => void = () => {},
    private maxAgeMs = 60_000,
  ) {}
  current() {
    return this.policy;
  }
  refresh() {
    if (this.loadedAt && Date.now() - this.loadedAt < this.maxAgeMs)
      return Promise.resolve();
    this.loading ??= this.load()
      .then(
        (settings) => {
          this.loadedAt = Date.now();
          this.serviceUrls = [settings.docUrl, settings.purchaseUrl].filter(
            isPolicyUrl,
          );
          const next = remotePolicy(settings);
          if (JSON.stringify(next) === JSON.stringify(this.policy)) return;
          this.policy = next;
          this.onChange(next);
        },
        () => {
          // Unreachable: the last answer (or the pending policy) stays.
        },
      )
      .finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }
}

export interface ServerPolicyOptions {
  /** `GET /claudex/policy` with `If-None-Match`. */
  load(etag?: string): Promise<JsonResult>;
  cache: PolicyCache;
  /** The account's settings: the offline policy keeps the MCP servers configured now. */
  settings(): Pick<Settings, "mcpServers">;
  /**
   * What the service's release information adds to the policy the window
   * gets: the update this build needs and the newest release notes.
   */
  release?(): {
    update?: ClientUpdate;
    releaseNotes?: ServiceReleaseNotes;
  };
  onChange?(policy: ClientPolicy): void;
  /** Least time between two reads that are not forced; default 30 s. */
  minIntervalMs?: number;
  now?(): number;
}

/** The service's policy in the client's terms (its plan group is not the window's business). */
function clientPolicyOf(policy: ClaudexPolicy): ClientPolicy {
  const { groupId: _groupId, ...rest } = policy;
  return rest;
}

/**
 * A policy kept from an earlier run, until the service answers in this one:
 * computer use waits (the administrator may have turned it off since, and it
 * acts on this computer's apps); everything else applies as kept.
 */
export function cachedPolicyInForce(policy: ClientPolicy): ClientPolicy {
  return policy.computerUse?.enabled
    ? { ...policy, computerUse: { ...policy.computerUse, enabled: false } }
    : policy;
}

/**
 * A Claudex service's policy for the signed-in account (design 4.2 item 3):
 * the bootstrap's `policy` first, then `GET /claudex/policy` with its ETag
 * every five minutes, on window focus and after gateway refusals. Each
 * answer is also kept on disk. Without an answer in this run the cached
 * policy applies (computer use waiting, see cachedPolicyInForce), and
 * without one the offline policy, which only holds back
 * changing MCP servers (Bypass permissions stays the user's choice
 * everywhere, owner decision 3). A failed read keeps what is in force.
 */
export class ServerPolicySource implements PolicySource {
  readonly refreshIntervalMs = 5 * 60_000;
  private live?: { policy: ClientPolicy; etag?: string };
  private cached?: ClientPolicy;
  private offline?: ClientPolicy;
  private loading?: Promise<void>;
  private checkedAt = 0;
  private published?: string;
  constructor(private options: ServerPolicyOptions) {
    const cached = options.cache.read();
    if (cached)
      this.cached = cachedPolicyInForce(clientPolicyOf(cached.policy));
    this.published = JSON.stringify(this.current());
  }
  private get now() {
    return this.options.now?.() ?? Date.now();
  }
  /** The service answered in this run. */
  get answered() {
    return !!this.live;
  }
  current(): PolicyWithReleaseNotes {
    const policy =
      this.live?.policy ??
      this.cached ??
      (this.offline ??= offlinePolicy(this.options.settings()));
    const { update, releaseNotes } = this.options.release?.() ?? {};
    return update || releaseNotes
      ? {
          ...policy,
          ...(update ? { update } : {}),
          ...(releaseNotes ? { releaseNotes } : {}),
        }
      : policy;
  }
  /** A policy the service sent in the bootstrap (`data.policy` as sent). */
  accept(raw: unknown) {
    let policy: ClaudexPolicy;
    try {
      policy = parsePolicy(raw);
    } catch (error) {
      console.error(
        "The service's policy was not used:",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    this.checkedAt = this.now;
    this.set(policy, raw, undefined);
  }
  /**
   * Asks the service; `force` skips the 30-second spacing (the five-minute
   * timer and window focus use it; calls from the window do not).
   */
  refresh(force = false): Promise<void> {
    if (
      !force &&
      this.checkedAt &&
      this.now - this.checkedAt < (this.options.minIntervalMs ?? 30_000)
    )
      return this.loading ?? Promise.resolve();
    this.loading ??= (async () => {
      try {
        const result = await this.options.load(this.live?.etag);
        this.checkedAt = this.now;
        if (result.notModified) return;
        this.set(parsePolicy(result.data), result.data, result.etag);
      } catch {
        // Unreachable, refused or malformed: what is in force stays.
      }
    })().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }
  private set(policy: ClaudexPolicy, raw: unknown, etag: string | undefined) {
    this.live = { policy: clientPolicyOf(policy), etag };
    this.options.cache.write({
      fetchedAt: this.now,
      etag: etag ?? null,
      revision: policy.revision,
      policy: raw,
    });
    this.changed();
  }
  /** Tells the host when what `current()` returns changed (a new policy or update). */
  changed() {
    const text = JSON.stringify(this.current());
    if (text === this.published) return;
    this.published = text;
    this.options.onChange?.(this.current());
  }
}
