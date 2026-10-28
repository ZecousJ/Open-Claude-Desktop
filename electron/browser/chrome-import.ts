import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  readChromeStorage,
  type ImportedStorage,
} from "./chrome-import-storage";
import type {
  ChromeImportProfile,
  ChromeImportResult,
  ChromeImportSite,
  ImportedChromeLogin,
} from "../../shared/chrome-import";
import {
  importHostMatches,
  importSiteRoot,
  importableHost,
  type ImportProfile,
  type ImportCookie,
  type ImportJar,
  chromeProfiles,
  publicProfile,
  decryptChromeCookie,
  importedCookie,
  readChromeCookies,
  chromeKey,
  sensitiveSite,
} from "./chrome-cookies";
import { chromeEpoch } from "./chrome-cookies";

export interface ChromeImportDeps {
  profiles(): Promise<ImportProfile[]>;
  read(
    profile: ImportProfile,
  ): Promise<{ rows: ImportCookie[]; version: number }>;
  key(profile: ImportProfile): Promise<Buffer>;
  readStorage?(
    profile: ImportProfile,
    allowed: (host: string) => boolean,
  ): Promise<ImportedStorage>;
  seedStorage?(
    jar: ImportJar,
    storage: ImportedStorage,
    allowed: (host: string) => boolean,
  ): Promise<string[]>;
  clearStorage?(jar: ImportJar, origins: string[]): Promise<void>;
  readJarStorage?(
    jar: ImportJar,
    origins: string[],
    allowed: (host: string) => boolean,
  ): Promise<ImportedStorage>;
  shared?(): { partition: string; jar: ImportJar };
  /** The person confirms; "timeout" after 2 minutes without an answer. */
  authorize?(profile: ChromeImportProfile): Promise<boolean | "timeout">;
  /** The confirmation is Touch ID. */
  touchId?(): boolean;
  target(
    conversationId: string,
    keep: boolean,
  ): Promise<{ partition: string; jar: ImportJar; persistent: boolean }>;
  blocked(host: string): boolean;
  reload(conversationId: string): void;
  indexFile: string;
  now?(): number;
}

export class ChromeImport {
  private tickets = new Map<
    string,
    {
      conversationId: string;
      profile: ImportProfile;
      sites: Set<string>;
      expires: number;
    }
  >();
  private records: Record<
    string,
    (ImportedChromeLogin & { storageOrigins?: string[] })[]
  > = {};
  private disposed = false;
  private writes: Promise<unknown> = Promise.resolve();
  private mutations: Promise<unknown> = Promise.resolve();
  private loading: Promise<void>;
  constructor(private deps: ChromeImportDeps) {
    this.loading = fs
      .readFile(deps.indexFile, "utf8")
      .then((text) => {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          return;
        for (const [partition, entries] of Object.entries(parsed))
          if (Array.isArray(entries))
            this.records[partition] = entries
              .filter(
                (entry) =>
                  typeof entry?.root === "string" &&
                  entry.root.length <= 253 &&
                  Number.isFinite(entry.importedAt),
              )
              .map((entry) => ({
                root: entry.root,
                importedAt: entry.importedAt,
                storageOrigins: Array.isArray(entry.storageOrigins)
                  ? entry.storageOrigins.filter((origin: unknown) => {
                      if (typeof origin !== "string") return false;
                      try {
                        const url = new URL(origin);
                        return (
                          /^https?:$/.test(url.protocol) &&
                          url.origin === origin &&
                          importHostMatches(url.hostname, entry.root)
                        );
                      } catch {
                        return false;
                      }
                    })
                  : [],
              }));
      })
      .catch(() => {});
  }
  static defaults = {
    profiles: chromeProfiles,
    read: readChromeCookies,
    key: chromeKey,
    readStorage: (
      profile: ImportProfile,
      allowed: (host: string) => boolean,
    ) =>
      profile.browser === "firefox"
        ? Promise.resolve(new Map())
        : readChromeStorage(profile.file, allowed),
  };
  touchId() {
    return this.deps.touchId?.() ?? false;
  }
  async profiles() {
    if (this.disposed) return [];
    const profiles = await this.deps.profiles();
    return this.disposed ? [] : profiles.map(publicProfile);
  }
  async sites(
    conversationId: string,
    profileId: string,
  ): Promise<
    ChromeImportResult<{
      ticket: string;
      profile: ChromeImportProfile;
      sites: ChromeImportSite[];
      maxSites: number;
    }>
  > {
    const profile = (await this.deps.profiles()).find(
      (entry) => entry.id === profileId,
    );
    if (!profile || this.disposed) return { ok: false, error: "no_chrome" };
    try {
      const consent = this.deps.authorize
        ? await this.deps.authorize(publicProfile(profile))
        : true;
      if (consent === "timeout")
        return { ok: false, error: "presence_timed_out" };
      if (!consent) return { ok: false, error: "keychain_denied" };
      if (this.disposed) return { ok: false, error: "expired" };
      const { rows } = await this.deps.read(profile);
      const sites = new Map<string, ChromeImportSite>();
      const domains = rows
        .map((row) => row.host_key)
        .filter((host) => host.startsWith("."));
      const hosts = new Map<string, Set<string>>();
      const now = this.now();
      for (const row of rows) {
        const host = row.host_key.replace(/^\./, "").toLowerCase();
        const root = importSiteRoot(host, domains);
        if (
          !importableHost(host) ||
          this.deps.blocked(host) ||
          this.deps.blocked(root) ||
          (row.has_expires &&
            Number(row.expires_utc) / 1e6 - chromeEpoch <= now / 1000)
        )
          continue;
        const site = sites.get(root) ?? {
          root,
          cookieCount: 0,
          hostCount: 1,
          lastAccess: 0,
        };
        const siteHosts = hosts.get(root) ?? new Set<string>();
        siteHosts.add(host);
        hosts.set(root, siteHosts);
        site.hostCount = siteHosts.size;
        site.cookieCount++;
        site.lastAccess = Math.max(
          site.lastAccess,
          Number(row.last_access_utc) / 1000 - chromeEpoch * 1000,
        );
        sites.set(root, site);
      }
      for (const [ticket, entry] of this.tickets)
        if (entry.expires <= now || entry.conversationId === conversationId)
          this.tickets.delete(ticket);
      const ticket = randomUUID();
      if (this.disposed) return { ok: false, error: "expired" };
      this.tickets.set(ticket, {
        conversationId,
        profile,
        sites: new Set(sites.keys()),
        expires: now + 120_000,
      });
      return {
        ok: true,
        ticket,
        profile: publicProfile(profile),
        sites: [...sites.values()]
          .map((site) => {
            const kind = sensitiveSite(site.root, hosts.get(site.root));
            return kind ? { ...site, sensitive: kind } : site;
          })
          .sort(
            (first, second) =>
              second.lastAccess - first.lastAccess ||
              first.root.localeCompare(second.root),
          ),
        maxSites: sites.size,
      };
    } catch {
      return { ok: false, error: "read_failed" };
    }
  }
  import(
    conversationId: string,
    ticket: string,
    roots: string[],
    keep: boolean,
  ) {
    return this.exclusive(() =>
      this.runImport(conversationId, ticket, roots, keep),
    );
  }
  private async runImport(
    conversationId: string,
    ticket: string,
    roots: string[],
    keep: boolean,
  ): Promise<
    ChromeImportResult<{
      results: { root: string; imported: number; failed: number }[];
      persistent: boolean;
    }>
  > {
    const entry = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (
      !entry ||
      this.disposed ||
      entry.conversationId !== conversationId ||
      entry.expires <= this.now()
    )
      return { ok: false, error: "expired" };
    if (
      !roots.length ||
      roots.length > 1000 ||
      new Set(roots).size !== roots.length ||
      roots.some((root) => !entry.sites.has(root) || this.deps.blocked(root))
    )
      return { ok: false, error: "invalid_sites" };
    let key: Buffer;
    try {
      key = await this.deps.key(entry.profile);
    } catch {
      return { ok: false, error: "keychain_denied" };
    }
    try {
      const { rows, version } = await this.deps.read(entry.profile);
      if (this.disposed || entry.expires <= this.now())
        return { ok: false, error: "expired" };
      const target = await this.deps.target(conversationId, keep);
      const results = roots.map((root) => ({ root, imported: 0, failed: 0 }));
      for (const row of rows) {
        const result = results.find((result) =>
          importHostMatches(
            row.host_key.replace(/^\./, "").toLowerCase(),
            result.root,
          ),
        );
        if (
          !result ||
          this.deps.blocked(result.root) ||
          this.deps.blocked(row.host_key.replace(/^\./, "").toLowerCase()) ||
          this.disposed
        )
          continue;
        const value = decryptChromeCookie(row, key, version);
        const cookie =
          value === undefined
            ? undefined
            : importedCookie(row, value, this.now() / 1000);
        if (!cookie) {
          result.failed++;
          continue;
        }
        try {
          await target.jar.cookies.set(cookie);
          result.imported++;
        } catch {
          result.failed++;
        }
      }
      const allowedStorage = (host: string) =>
        !this.disposed &&
        !this.deps.blocked(host) &&
        results.some(
          ({ root, imported }) =>
            imported > 0 &&
            importHostMatches(host, root) &&
            !this.deps.blocked(root),
        );
      let storageOrigins: string[] = [];
      if (this.deps.readStorage && this.deps.seedStorage) {
        try {
          const storage = await this.deps.readStorage(
            entry.profile,
            allowedStorage,
          );
          storageOrigins = await this.deps.seedStorage(
            target.jar,
            storage,
            allowedStorage,
          );
        } catch {}
      }
      await this.loading;
      const records = this.records[target.partition] ?? [];
      for (const result of results.filter((result) => result.imported > 0)) {
        const previous = records.findIndex(
          (record) => record.root === result.root,
        );
        if (previous >= 0) records.splice(previous, 1);
        records.push({
          root: result.root,
          importedAt: this.now(),
          storageOrigins: storageOrigins.filter((origin) =>
            importHostMatches(new URL(origin).hostname, result.root),
          ),
        });
      }
      this.records[target.partition] = records;
      await this.save();
      this.deps.reload(conversationId);
      return { ok: true, results, persistent: target.persistent };
    } catch {
      return { ok: false, error: "read_failed" };
    } finally {
      key.fill(0);
    }
  }
  async list(conversationId: string) {
    await this.loading;
    const { partition, jar } = await this.deps.target(conversationId, false);
    const cookies = await jar.cookies.get({});
    return (this.records[partition] ?? [])
      .filter((record) =>
        cookies.some(
          (cookie) =>
            cookie.domain &&
            importHostMatches(cookie.domain.replace(/^\./, ""), record.root),
        ),
      )
      .map(({ root, importedAt }) => ({ root, importedAt }));
  }
  async sharedOffer(conversationId: string) {
    await this.loading;
    const shared = this.deps.shared?.();
    const target = await this.deps.target(conversationId, false);
    if (!shared || target.partition === shared.partition || this.disposed)
      return { offer: false, roots: [] };
    const cookies = await shared.jar.cookies.get({});
    const current = new Set(
      (this.records[target.partition] ?? []).map(({ root }) => root),
    );
    const roots = (this.records[shared.partition] ?? [])
      .map(({ root }) => root)
      .filter(
        (root) =>
          !current.has(root) &&
          !this.deps.blocked(root) &&
          cookies.some(
            (cookie) =>
              cookie.domain &&
              importHostMatches(cookie.domain.replace(/^\./, ""), root),
          ),
      );
    return { offer: roots.length > 0, roots };
  }
  acceptShared(conversationId: string, keep: boolean) {
    return this.exclusive(async () => {
      const offer = await this.sharedOffer(conversationId);
      const shared = this.deps.shared?.();
      if (!offer.offer || !shared || this.disposed) return false;
      const target = await this.deps.target(conversationId, keep);
      if (target.partition === shared.partition) {
        this.deps.reload(conversationId);
        return true;
      }
      const allowed = (host: string) =>
        !this.disposed &&
        !this.deps.blocked(host) &&
        offer.roots.some(
          (root) => importHostMatches(host, root) && !this.deps.blocked(root),
        );
      const copied = new Set<string>();
      for (const cookie of await shared.jar.cookies.get({})) {
        const host = cookie.domain?.replace(/^\./, "");
        if (!host || !allowed(host) || cookie.value === undefined) continue;
        try {
          await target.jar.cookies.set({
            url: `${cookie.secure ? "https" : "http"}://${host}${cookie.path ?? "/"}`,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain?.startsWith(".") ? cookie.domain : undefined,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            sameSite: cookie.sameSite,
            expirationDate: cookie.expirationDate,
          });
          const root = offer.roots.find((root) =>
            importHostMatches(host, root),
          );
          if (root) copied.add(root);
        } catch {}
      }
      if (!copied.size) return false;
      const sharedRecords = this.records[shared.partition] ?? [];
      const origins = sharedRecords
        .filter(({ root }) => copied.has(root))
        .flatMap((record) => record.storageOrigins ?? []);
      let seeded: string[] = [];
      if (origins.length && this.deps.readJarStorage && this.deps.seedStorage) {
        try {
          const storage = await this.deps.readJarStorage(
            shared.jar,
            origins,
            allowed,
          );
          seeded = await this.deps.seedStorage(target.jar, storage, allowed);
        } catch {}
      }
      this.records[target.partition] = [
        ...(this.records[target.partition] ?? []),
        ...[...copied].map((root) => ({
          root,
          importedAt: this.now(),
          storageOrigins: seeded.filter((origin) =>
            importHostMatches(new URL(origin).hostname, root),
          ),
        })),
      ];
      await this.save();
      this.deps.reload(conversationId);
      return true;
    });
  }
  remove(conversationId: string, root: string) {
    return this.exclusive(() => this.runRemove(conversationId, root));
  }
  private async runRemove(conversationId: string, root: string) {
    await this.loading;
    const { partition, jar } = await this.deps.target(conversationId, false);
    if (!this.records[partition]?.some((record) => record.root === root))
      return false;
    const origins =
      this.records[partition].find((record) => record.root === root)
        ?.storageOrigins ?? [];
    if (origins.length) await this.deps.clearStorage?.(jar, origins);
    for (const cookie of await jar.cookies.get({}))
      if (
        cookie.domain &&
        importHostMatches(cookie.domain.replace(/^\./, ""), root)
      )
        await jar.cookies.remove(
          `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path ?? "/"}`,
          cookie.name,
        );
    this.records[partition] = this.records[partition].filter(
      (record) => record.root !== root,
    );
    await this.save();
    this.deps.reload(conversationId);
    return true;
  }
  dispose() {
    this.disposed = true;
    this.tickets.clear();
  }
  clear() {
    this.tickets.clear();
    return this.exclusive(async () => {
      await this.loading;
      this.records = {};
      await this.save();
    });
  }
  clearPartition(partition: string) {
    this.tickets.clear();
    return this.exclusive(async () => {
      await this.loading;
      delete this.records[partition];
      await this.save();
    });
  }
  private exclusive<Result>(action: () => Promise<Result>): Promise<Result> {
    const result = this.mutations.catch(() => {}).then(action);
    this.mutations = result;
    return result;
  }
  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private async save() {
    const text = JSON.stringify(this.records);
    const write = this.writes
      .catch(() => {})
      .then(async () => {
        await fs.mkdir(path.dirname(this.deps.indexFile), { recursive: true });
        await fs.writeFile(`${this.deps.indexFile}.tmp`, text, { mode: 0o600 });
        await fs.rename(`${this.deps.indexFile}.tmp`, this.deps.indexFile);
      });
    this.writes = write;
    await write;
  }
}
