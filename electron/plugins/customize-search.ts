import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import Fuse from "fuse.js";
import type {
  CustomizeSkill,
  PluginCatalog,
} from "../../shared/collections-api";
import type { ApprovedDirectoryEntry } from "../../shared/directory-submissions";
import {
  validCustomizeSearchResult,
  type CustomizeSearchHit,
  type CustomizeSearchPage,
  type CustomizeSearchRequest,
  type CustomizeSearchResult,
} from "../../shared/customize-search";

export interface CustomizeIndexedConnector {
  id: string;
  name: string;
  description?: string;
  /** Supplied by the authenticated host's actual connector inventory. */
  connected: boolean;
}
export function customizeSkillSearchHits(
  skills: readonly CustomizeSkill[],
): CustomizeSearchHit[] {
  return skills.map((skill) => ({
    key: `skill:${skill.path}`,
    kind: "skill",
    name: skill.name,
    description: skill.description,
    yours: skill.own,
    target: { type: "skill", path: skill.path },
  }));
}
export function customizePluginSearchHits(
  catalog: PluginCatalog,
): CustomizeSearchHit[] {
  if (catalog.loadErrors.length)
    throw new CustomizeSearchError(
      "catalogue_unavailable",
      catalog.loadErrors.join("\n"),
    );
  return catalog.plugins.map((plugin) => ({
    key: `plugin:${plugin.id}`,
    kind: "plugin",
    name: plugin.title,
    ...(plugin.description === undefined
      ? {}
      : { description: plugin.description }),
    yours: plugin.installed,
    target: { type: "plugin", id: plugin.id },
  }));
}
export function customizeConnectorSearchHits(
  connectors: readonly CustomizeIndexedConnector[],
): CustomizeSearchHit[] {
  return connectors.map((connector) => ({
    key: `connector:${connector.id}`,
    kind: "connector",
    name: connector.name,
    ...(connector.description === undefined
      ? {}
      : { description: connector.description }),
    yours: connector.connected,
    target: { type: "connector", id: connector.id },
  }));
}
export function customizeDirectorySearchHits(
  entries: readonly ApprovedDirectoryEntry[],
): CustomizeSearchHit[] {
  return entries.map((entry) => ({
    key: `directory:${entry.kind}:${entry.id}`,
    kind: entry.kind === "plugin" ? "plugin" : "connector",
    name: entry.name,
    description: entry.description,
    yours: false,
    target: { type: "external", url: entry.url },
  }));
}

export class CustomizeSearchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CustomizeSearchError";
    this.code = `CLAUDEX_CUSTOMIZE_SEARCH_${code.toUpperCase()}`;
  }
}
export interface CustomizeSearchDependencies {
  /** Stable for the current store AND engine lease; replace on either change. */
  owner(): object;
  /** Read actual indexed records. Reader failures must reject, never become []. */
  readHits():
    readonly CustomizeSearchHit[] | Promise<readonly CustomizeSearchHit[]>;
  now?: () => number;
}
export interface CustomizeSearchOptions {
  ttlMs?: number;
  maxSnapshots?: number;
  maxSnapshotBytes?: number;
  maxCatalogueHits?: number;
  maxCatalogueBytes?: number;
}
const defaults = {
  ttlMs: 120000,
  maxSnapshots: 32,
  maxSnapshotBytes: 16 * 1024 * 1024,
  maxCatalogueHits: 20000,
  maxCatalogueBytes: 8 * 1024 * 1024,
};
const pageKind = {
  skills: "skill",
  plugins: "plugin",
  connectors: "connector",
} as const;

/**
 * O16+: two Unicode letters/digits, then 200 code points. Trimming and
 * eligibility precede the server query cutoff.
 */
export function customizeSearchQuery(query: string): string {
  const trimmed = query.trim();
  let meaningful = 0,
    normalized = "",
    count = 0;
  for (const character of trimmed) {
    if (count++ < 200) normalized += character;
    if (meaningful < 2 && /[\p{L}\p{N}]/u.test(character)) meaningful++;
    if (count >= 200 && meaningful >= 2) break;
  }
  return meaningful >= 2 ? normalized : "";
}

/**
 * O16: name-only Fuse, threshold .25, ignore location, intersect whitespace
 * words, preserve source order.
 */
function matchingHits(
  hits: CustomizeSearchHit[],
  query: string,
): CustomizeSearchHit[] {
  const fields = hits.map((hit) => ({ name: hit.name, hit }));
  const fuse = new Fuse(fields, {
    keys: [{ name: "name", weight: 0.7 }],
    isCaseSensitive: false,
    ignoreLocation: true,
    threshold: 0.25,
    includeMatches: true,
    includeScore: true,
  });
  let selected: Set<CustomizeSearchHit> | undefined;
  for (const word of query.trim().split(/\s+/)) {
    const next = new Set(fuse.search(word).map((result) => result.item.hit));
    selected =
      selected === undefined
        ? next
        : new Set([...selected].filter((hit) => next.has(hit)));
    if (!selected.size) break;
  }
  return hits.filter((hit) => selected?.has(hit));
}
interface Snapshot {
  owner: object;
  query: string;
  page: CustomizeSearchPage;
  section: CustomizeSearchRequest["section"];
  createdAt: number;
  expiresAt: number;
  items: CustomizeSearchHit[];
  bytes: number;
}
interface Cursor {
  id: string;
  offset: number;
  expiresAt: number;
}

/** Read-only search; no model, installer, marketplace sync or network client.
 * Continuations use the captured catalogue snapshot rather than rereading or
 * revealing another slice of a renderer-owned list. */
export class CustomizeSearchService {
  private readonly secret = randomBytes(32);
  private readonly snapshots = new Map<string, Snapshot>();
  private owner?: object;
  private epoch = 0;
  private bytes = 0;
  private pending?: {
    owner: object;
    epoch: number;
    promise: Promise<CustomizeSearchHit[]>;
  };
  private readonly settings: typeof defaults;
  private readonly now: () => number;
  constructor(
    private readonly deps: CustomizeSearchDependencies,
    options: CustomizeSearchOptions = {},
  ) {
    this.settings = { ...defaults, ...options };
    for (const [key, value] of Object.entries(this.settings))
      if (
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > defaults[key as keyof typeof defaults]
      )
        throw new Error("Invalid Customize search limits.");
    this.now = deps.now ?? Date.now;
  }
  async search(
    request: CustomizeSearchRequest,
  ): Promise<CustomizeSearchResult> {
    const owner = this.captureOwner(),
      epoch = this.epoch;
    if (
      !request ||
      typeof request !== "object" ||
      typeof request.query !== "string" ||
      !Object.hasOwn(pageKind, request.page) ||
      !["yours", "inPage", "more"].includes(request.section) ||
      (request.limit !== undefined &&
        (!Number.isSafeInteger(request.limit) ||
          request.limit < 1 ||
          request.limit > 100))
    )
      throw new CustomizeSearchError(
        "invalid_request",
        "Invalid Customize search request.",
      );
    const query = customizeSearchQuery(request.query),
      limit = request.limit ?? 5;
    this.prune();
    if (request.cursor !== undefined) {
      const cursor = this.readCursor(request.cursor);
      if (this.now() >= cursor.expiresAt)
        throw new CustomizeSearchError(
          "cursor_expired",
          "This search expired. Search again.",
        );
      const snapshot = this.snapshots.get(cursor.id);
      if (
        !snapshot ||
        snapshot.owner !== owner ||
        snapshot.query !== query ||
        snapshot.page !== request.page ||
        snapshot.section !== request.section ||
        snapshot.expiresAt !== cursor.expiresAt ||
        cursor.offset < 1 ||
        cursor.offset >= snapshot.items.length
      )
        throw new CustomizeSearchError(
          "invalid_cursor",
          "This search continuation does not belong to this request.",
        );
      this.assertOwner(owner, epoch);
      return this.page(cursor.id, snapshot, cursor.offset, limit);
    }
    if (!query) return { items: [], total: 0 };
    const hits = await this.read(owner, epoch);
    this.assertOwner(owner, epoch);
    const kind = pageKind[request.page];
    const candidates = hits.filter((hit) =>
      request.section === "more"
        ? hit.kind !== kind
        : hit.kind === kind &&
          (request.section === "yours" ? hit.yours : !hit.yours),
    );
    const items = matchingHits(candidates, query);
    const createdAt = this.now(),
      bytes = Buffer.byteLength(JSON.stringify(items));
    if (bytes > this.settings.maxSnapshotBytes)
      throw new CustomizeSearchError(
        "catalogue_limit",
        "Customize search results are too large.",
      );
    const snapshot: Snapshot = {
      owner,
      query,
      page: request.page,
      section: request.section,
      createdAt,
      expiresAt: createdAt + this.settings.ttlMs,
      items,
      bytes,
    };
    this.prune();
    while (
      this.snapshots.size >= this.settings.maxSnapshots ||
      this.bytes + bytes > this.settings.maxSnapshotBytes
    )
      this.evict(this.snapshots.keys().next().value!);
    const id = randomBytes(16).toString("base64url");
    this.snapshots.set(id, snapshot);
    this.bytes += bytes;
    return this.page(id, snapshot, 0, limit);
  }
  /** API-shaped alias for the owning Collection IPC handler. */
  customizeSearch(
    request: CustomizeSearchRequest,
  ): Promise<CustomizeSearchResult> {
    return this.search(request);
  }
  private captureOwner(): object {
    const owner = this.deps.owner();
    if (!owner || typeof owner !== "object")
      throw new CustomizeSearchError(
        "owner_changed",
        "The Customize search account is unavailable.",
      );
    if (owner !== this.owner) {
      this.owner = owner;
      this.epoch++;
      this.snapshots.clear();
      this.bytes = 0;
      this.pending = undefined;
    }
    return owner;
  }
  private assertOwner(owner: object, epoch: number): void {
    if (
      this.deps.owner() !== owner ||
      this.owner !== owner ||
      this.epoch !== epoch
    )
      throw new CustomizeSearchError(
        "owner_changed",
        "The Customize search account or runtime changed. Search again.",
      );
  }
  private async read(
    owner: object,
    epoch: number,
  ): Promise<CustomizeSearchHit[]> {
    if (this.pending?.owner === owner && this.pending.epoch === epoch)
      return this.pending.promise;
    const promise = Promise.resolve()
      .then(() => {
        this.assertOwner(owner, epoch);
        return this.deps.readHits();
      })
      .then((hits) => this.checkedHits(hits));
    const pending = { owner, epoch, promise };
    this.pending = pending;
    try {
      return await promise;
    } finally {
      if (this.pending === pending) this.pending = undefined;
    }
  }
  private checkedHits(
    raw: readonly CustomizeSearchHit[],
  ): CustomizeSearchHit[] {
    if (!Array.isArray(raw) || raw.length > this.settings.maxCatalogueHits)
      throw new CustomizeSearchError(
        "catalogue_limit",
        "Customize search catalogue is too large or invalid.",
      );
    const hits: CustomizeSearchHit[] = [],
      seen = new Set<string>();
    let bytes = 0;
    for (const hit of raw) {
      if (!validCustomizeSearchResult({ items: [hit], total: 1 }))
        throw new CustomizeSearchError(
          "invalid_catalogue",
          "Customize search returned an invalid catalogue item.",
        );
      const target = hit.target;
      if (target.type !== "external" && target.type !== hit.kind)
        throw new CustomizeSearchError(
          "invalid_catalogue",
          "Customize search returned an invalid navigation target.",
        );
      if (target.type === "external") {
        const url = new URL(target.url);
        if (url.username || url.password)
          throw new CustomizeSearchError(
            "invalid_catalogue",
            "Customize search returned an unsafe external link.",
          );
      }
      if (seen.has(hit.key)) continue;
      seen.add(hit.key);
      const clean: CustomizeSearchHit = {
        key: hit.key,
        kind: hit.kind,
        name: hit.name,
        ...(hit.description === undefined
          ? {}
          : { description: hit.description }),
        yours: hit.yours,
        target:
          target.type === "skill"
            ? { type: "skill", path: target.path }
            : target.type === "external"
              ? { type: "external", url: target.url }
              : { type: target.type, id: target.id },
      };
      bytes += Buffer.byteLength(JSON.stringify(clean));
      if (bytes > this.settings.maxCatalogueBytes)
        throw new CustomizeSearchError(
          "catalogue_limit",
          "Customize search catalogue is too large.",
        );
      hits.push(clean);
    }
    return hits;
  }
  private page(
    id: string,
    snapshot: Snapshot,
    offset: number,
    limit: number,
  ): CustomizeSearchResult {
    const end = Math.min(offset + limit, snapshot.items.length);
    return {
      items: structuredClone(snapshot.items.slice(offset, end)),
      total: snapshot.items.length,
      ...(end < snapshot.items.length
        ? {
            nextCursor: this.writeCursor({
              id,
              offset: end,
              expiresAt: snapshot.expiresAt,
            }),
          }
        : {}),
    };
  }
  private writeCursor(value: Cursor): string {
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.secret, nonce);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString(
      "base64url",
    );
  }
  private readCursor(value: string): Cursor {
    try {
      if (
        typeof value !== "string" ||
        !value ||
        value.length > 4096 ||
        !/^[A-Za-z0-9_-]+$/.test(value)
      )
        throw Error();
      const bytes = Buffer.from(value, "base64url");
      if (bytes.length < 29 || bytes.toString("base64url") !== value)
        throw Error();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.secret,
        bytes.subarray(0, 12),
      );
      decipher.setAuthTag(bytes.subarray(12, 28));
      const payload = JSON.parse(
        Buffer.concat([
          decipher.update(bytes.subarray(28)),
          decipher.final(),
        ]).toString("utf8"),
      );
      if (
        typeof payload?.id !== "string" ||
        !payload.id ||
        !Number.isSafeInteger(payload.offset) ||
        !Number.isSafeInteger(payload.expiresAt)
      )
        throw Error();
      return payload;
    } catch {
      throw new CustomizeSearchError(
        "invalid_cursor",
        "This Customize search continuation is invalid.",
      );
    }
  }
  private prune(): void {
    const now = this.now();
    for (const [id, snapshot] of this.snapshots)
      if (now >= snapshot.expiresAt || now < snapshot.createdAt) this.evict(id);
  }
  private evict(id: string): void {
    const snapshot = this.snapshots.get(id);
    if (snapshot) {
      this.bytes -= snapshot.bytes;
      this.snapshots.delete(id);
    }
  }
}
