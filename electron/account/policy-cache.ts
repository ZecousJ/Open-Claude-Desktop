/**
 * The last policy the Claudex service sent for this account, kept in the
 * account's profile (`claudex-policy-cache.json`, mode 0600) so an offline
 * start still follows the administrator (design 4.2 item 3). The policy is
 * kept as the service sent it and read back through the same contract
 * parser, so a damaged or edited file that does not parse is not used.
 */
import fs from "node:fs";
import path from "node:path";
import { parsePolicy, type ClaudexPolicy } from "../../shared/claudex-contract";

export const policyCacheFileName = "claudex-policy-cache.json";

export interface PolicyCacheRecord {
  version: 1;
  /** When the service sent it, epoch ms. */
  fetchedAt: number;
  /** The `GET /claudex/policy` ETag; null when it came with the bootstrap. */
  etag: string | null;
  revision: number;
  /** The service's `policy` data, snake_case, as sent. */
  policy: unknown;
}

export class PolicyCache {
  readonly file: string;
  constructor(profileRoot: string) {
    this.file = path.join(profileRoot, policyCacheFileName);
  }
  /** The cached policy, or undefined when there is none or it does not parse. */
  read(): { record: PolicyCacheRecord; policy: ClaudexPolicy } | undefined {
    try {
      const record = JSON.parse(
        fs.readFileSync(this.file, "utf8"),
      ) as PolicyCacheRecord;
      if (
        !record ||
        record.version !== 1 ||
        !Number.isFinite(record.fetchedAt) ||
        !(record.etag === null || typeof record.etag === "string")
      )
        return undefined;
      return { record, policy: parsePolicy(record.policy) };
    } catch {
      return undefined;
    }
  }
  /** Replaces the cache atomically; a failure only costs the offline copy. */
  write(record: Omit<PolicyCacheRecord, "version">) {
    const temporary = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        temporary,
        JSON.stringify({ version: 1, ...record } satisfies PolicyCacheRecord),
        { mode: 0o600 },
      );
      fs.renameSync(temporary, this.file);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      console.error(
        "Policy cache not saved:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  clear() {
    fs.rmSync(this.file, { force: true });
  }
}
