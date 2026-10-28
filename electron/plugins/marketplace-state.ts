import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PluginMarketplace } from "../../shared/collections-api";

const execute = promisify(execFile);
export interface MarketplaceSyncState {
  source?: string;
  lastUpdated?: number;
  syncedCommit?: string;
  autoSync?: boolean;
  syncError?: string;
}

// Local refresh metadata mirrors lastUpdated in known marketplaces.
export class MarketplaceState {
  constructor(private root: () => string) {}

  private read(): Record<string, MarketplaceSyncState> {
    try {
      const value = JSON.parse(
        fs.readFileSync(
          path.join(this.root(), "marketplace-sync.json"),
          "utf8",
        ),
      );
      const states: Record<string, MarketplaceSyncState> = Object.create(null);
      if (!value || typeof value !== "object" || Array.isArray(value))
        return states;
      for (const [name, state] of Object.entries(value)) {
        if (!state || typeof state !== "object" || Array.isArray(state))
          continue;
        const saved = state as MarketplaceSyncState;
        let source: string | undefined;
        try {
          const url = new URL(saved.source ?? "");
          if (url.protocol === "https:" && !url.username && !url.password) {
            url.search = "";
            url.hash = "";
            source = url.href;
          }
        } catch {}
        states[name] = {
          source,
          ...(typeof saved.lastUpdated === "number" &&
          Number.isFinite(saved.lastUpdated)
            ? { lastUpdated: saved.lastUpdated }
            : {}),
          ...(typeof saved.syncedCommit === "string"
            ? { syncedCommit: saved.syncedCommit }
            : {}),
          ...(typeof saved.autoSync === "boolean"
            ? { autoSync: saved.autoSync }
            : {}),
          ...(typeof saved.syncError === "string"
            ? { syncError: saved.syncError }
            : {}),
        };
      }
      return states;
    } catch {
      return Object.create(null) as Record<string, MarketplaceSyncState>;
    }
  }

  update(name: string, patch?: MarketplaceSyncState) {
    const states = this.read();
    if (patch) states[name] = { ...states[name], ...patch };
    else delete states[name];
    const file = path.join(this.root(), "marketplace-sync.json");
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(states), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }

  hasAutoSync() {
    return Object.values(this.read()).some((state) => state.autoSync);
  }

  async changed(marketplace: PluginMarketplace) {
    if (!marketplace.source) return false;
    const result = await execute(
      "git",
      ["ls-remote", "--", marketplace.source, "HEAD"],
      {
        timeout: 15_000,
        maxBuffer: 4096,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    );
    const commit = result.stdout.trim().split(/\s/)[0];
    return !!commit && commit !== marketplace.syncedCommit;
  }

  async describe(marketplace: PluginMarketplace): Promise<PluginMarketplace> {
    const state = this.read()[marketplace.name];
    let source: string | undefined;
    let syncedCommit: string | undefined;
    let lastUpdated: number | undefined;
    let syncError: string | undefined;
    try {
      const cwd = fs.statSync(marketplace.path).isDirectory()
        ? marketplace.path
        : path.dirname(marketplace.path);
      const options = {
        cwd,
        timeout: 5000,
        maxBuffer: 4096,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      };
      source = (
        await execute("git", ["remote", "get-url", "origin"], options)
      ).stdout.trim();
      syncedCommit = (
        await execute("git", ["rev-parse", "HEAD"], options)
      ).stdout.trim();
      const fetched = (
        await execute("git", ["rev-parse", "--git-path", "FETCH_HEAD"], options)
      ).stdout.trim();
      if (fs.existsSync(path.resolve(cwd, fetched)))
        lastUpdated = fs.statSync(path.resolve(cwd, fetched)).mtimeMs;
      source = source.replace(/^git@github\.com:/, "https://github.com/");
      const url = new URL(source);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      source = url.protocol === "https:" ? url.href : undefined;
    } catch (error) {
      if (/spawn git ENOENT/.test(String(error))) syncError = "Git is required";
      source = undefined;
    }
    return {
      ...marketplace,
      ...(lastUpdated ? { lastUpdated } : {}),
      ...state,
      ...(source ? { source } : {}),
      ...(syncedCommit ? { syncedCommit } : {}),
      ...(syncError ? { syncError } : {}),
    };
  }
}
